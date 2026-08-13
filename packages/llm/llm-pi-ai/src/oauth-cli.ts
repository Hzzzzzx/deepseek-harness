/**
 * Interactive OAuth CLI for pi-ai OAuth-backed catalog providers.
 *
 * This is the operator surface of the OAuth credential store: `login` runs
 * the catalog provider's own OAuth flow (`provider.auth.oauth.login`) against
 * a terminal interaction — browser authorization with a manual-code fallback,
 * or headless device-code, whichever the flow offers — and persists the
 * resulting credential to the durable store; `logout` removes it; `status`
 * lists stored credentials without exposing secrets.
 *
 * The built entry point is the thin wrapper `bin/dsh-oauth.mjs`:
 *
 * ```bash
 * node packages/llm/llm-pi-ai/bin/dsh-oauth.mjs login openai-codex
 * node packages/llm/llm-pi-ai/bin/dsh-oauth.mjs status
 * node packages/llm/llm-pi-ai/bin/dsh-oauth.mjs logout openai-codex
 * ```
 *
 * Requests resolve the stored credential lazily (see `oauth-store.ts`), so a
 * login here takes effect on the harness's next LLM request with no restart.
 */

import { spawn } from 'node:child_process'
import { platform } from 'node:os'
import { stderr, stdin, stdout } from 'node:process'
import { createInterface, type Interface } from 'node:readline/promises'
import type { AuthEvent, AuthInteraction, AuthPrompt, OAuthCredential } from '@earendil-works/pi-ai'
import { catalogProvider, catalogProviderIds } from './catalog.ts'
import {
  listOAuthCredentials,
  oauthStorePath,
  readOAuthCredential,
  removeOAuthCredential,
  writeOAuthCredential,
} from './oauth-store.ts'

/** Print usage and the catalog's OAuth-capable provider ids. */
function usage(): void {
  const oauthProviders = catalogProviderIds().filter(id => catalogProvider(id)?.auth.oauth !== undefined)
  stdout.write(
    'Usage:\n'
      + '  dsh-oauth login <provider>    Run the OAuth login flow and store the credential\n'
      + '  dsh-oauth logout <provider>   Remove the stored credential\n'
      + '  dsh-oauth status              List stored credentials (no secrets)\n'
      + `\nOAuth-capable providers: ${oauthProviders.join(', ') || '(none in the installed catalog)'}\n`
      + `Store: ${oauthStorePath()}\n`,
  )
}

/** Best-effort browser open for the authorization URL; never fails the flow. */
function openBrowser(url: string): void {
  const opener = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open'
  try {
    spawn(opener, [url], { detached: true, stdio: 'ignore', shell: platform() === 'win32' }).unref()
  } catch {
    // The URL is already on the terminal; opening is a courtesy.
  }
}

/**
 * Build the terminal `AuthInteraction` the pi-ai flows drive: events print,
 * prompts read one line, and a prompt carrying its own abort signal (the
 * manual-code race against the browser callback) rejects through readline's
 * signal support so the winner proceeds.
 * @param signal - flow-wide abort (Ctrl+C).
 * @returns the interaction plus the closer for its readline.
 */
function createCliInteraction(signal: AbortSignal): { interaction: AuthInteraction; close: () => void } {
  const rl: Interface = createInterface({ input: stdin, output: stdout })
  const ask = async (prompt: AuthPrompt & { type: 'text' | 'secret' | 'manual_code' }): Promise<string> => {
    const suffix = prompt.placeholder ? ` [${prompt.placeholder}]` : ''
    return (await rl.question(`${prompt.message}${suffix}\n> `, { signal: prompt.signal })).trim()
  }
  const interaction: AuthInteraction = {
    signal,
    notify(event: AuthEvent): void {
      switch (event.type) {
        case 'auth_url':
          stdout.write(`\nOpen this URL to sign in:\n  ${event.url}\n`)
          if (event.instructions) stdout.write(`${event.instructions}\n`)
          openBrowser(event.url)
          return
        case 'device_code':
          stdout.write(
            '\n────────────────────────────────────────\n'
              + `  Visit:  ${event.verificationUri}\n`
              + `  Code:   ${event.userCode}\n`
              + '────────────────────────────────────────\n'
              + 'Waiting for authorization…\n',
          )
          return
        case 'progress':
        case 'info':
          stdout.write(`${event.message}\n`)
          for (const link of event.type === 'info' ? (event.links ?? []) : []) {
            stdout.write(`  ${link.label ?? link.url}: ${link.url}\n`)
          }
          return
      }
    },
    async prompt(prompt: AuthPrompt): Promise<string> {
      if (prompt.type === 'select') {
        stdout.write(`${prompt.message}\n`)
        prompt.options.forEach((option, index) => {
          const description = option.description ? ` — ${option.description}` : ''
          stdout.write(`  [${index + 1}] ${option.label}${description}\n`)
        })
        for (;;) {
          const answer = (await rl.question('Choice [1]: ', { signal: prompt.signal })).trim()
          const index = answer === '' ? 0 : Number.parseInt(answer, 10) - 1
          const option = prompt.options[index]
          if (option !== undefined) return option.id
          stdout.write('Invalid choice.\n')
        }
      }
      return ask(prompt)
    },
  }
  return {
    interaction,
    close: () => {
      rl.close()
    },
  }
}

/** `login <provider>`: run the provider's OAuth flow and store the credential. */
async function login(providerId: string): Promise<number> {
  const oauth = catalogProvider(providerId)?.auth.oauth
  if (oauth === undefined) {
    stderr.write(`dsh-oauth: provider "${providerId}" has no OAuth login in the installed catalog\n`)
    usage()
    return 2
  }
  stdout.write(`Logging in to ${oauth.name}…\n`)
  const abort = new AbortController()
  const onSigint = (): void => {
    abort.abort(new Error('login cancelled'))
  }
  process.once('SIGINT', onSigint)
  const { interaction, close } = createCliInteraction(abort.signal)
  try {
    const credential: OAuthCredential = await oauth.login(interaction)
    await writeOAuthCredential(providerId, credential)
    stdout.write(
      `\n✓ ${oauth.name} credential stored for "${providerId}" (access token valid until ${new Date(credential.expires).toLocaleString()}).\n`
        + 'The harness refreshes it lazily on the next request; no restart is needed.\n',
    )
    return 0
  } finally {
    close()
    process.removeListener('SIGINT', onSigint)
  }
}

/** `logout <provider>`: remove the stored credential, idempotently. */
async function logout(providerId: string | undefined): Promise<number> {
  if (providerId === undefined || providerId.length === 0) {
    usage()
    return 2
  }
  const existing = await readOAuthCredential(providerId)
  await removeOAuthCredential(providerId)
  stdout.write(
    existing === undefined
      ? `dsh-oauth: no stored credential for "${providerId}"\n`
      : `✓ Removed the stored credential for "${providerId}"\n`,
  )
  return 0
}

/** `status`: list stored credentials, secrets withheld. */
async function status(): Promise<number> {
  const credentials = await listOAuthCredentials()
  if (credentials.length === 0) {
    stdout.write(`No OAuth credentials stored (${oauthStorePath()}).\n`)
    return 0
  }
  for (const credential of credentials) {
    const state = credential.fresh ? 'fresh' : 'expired (refreshes on next request)'
    stdout.write(`${credential.providerId}: ${state}, expires ${new Date(credential.expires).toLocaleString()}\n`)
  }
  return 0
}

/**
 * The CLI entry point.
 * @param argv - arguments after the script name (`login openai-codex`, …).
 * @returns the process exit code.
 */
export async function runOAuthCli(argv: string[]): Promise<number> {
  const [command, providerId] = argv
  switch (command) {
    case 'login':
      if (providerId === undefined || providerId.length === 0) {
        usage()
        return 2
      }
      return login(providerId)
    case 'logout':
      return logout(providerId)
    case 'status':
      return status()
    default:
      usage()
      return command === undefined ? 0 : 2
  }
}
