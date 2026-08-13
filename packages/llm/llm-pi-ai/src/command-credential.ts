/**
 * Command credentials: a stored credential value starting with `!` names a
 * command whose stdout is the credential, resolved fresh per request.
 *
 * This mirrors the `!command` convention of pi/prime-agent's auth storage
 * (`resolveConfigValue`), and exists for credentials that are themselves
 * managed by another tool — the motivating case is a subscription token
 * broker (a helper reading an OAuth store it owns, refreshing through the
 * issuer when needed), where copying the token into this plane would either
 * go stale or duplicate the refresh logic. Executing per request keeps the
 * broker the single owner of refresh and rotation.
 *
 * Trust boundary: the command string comes from the same owner-only
 * credential plane that already holds raw secrets (`$DSH_HOME/
 * .credentials.yaml`, mode 0600), so executing it grants no authority the
 * file's owner did not already have. Stdout is never logged; failures report
 * the command and exit status, plus a bounded stderr snippet — command
 * contracts in this deployment keep secrets off stderr.
 */

import { execFile } from 'node:child_process'

/** Marker prefix distinguishing a command credential from a raw key. */
const COMMAND_PREFIX = '!'

/** Default ceiling for one command resolution, matching the reference implementation. */
const COMMAND_TIMEOUT_MS = 10_000

/** Bound on captured output; a credential is never large. */
const MAX_BUFFER_BYTES = 64 * 1024

/** Stderr carried into a failure is bounded so diagnostics stay compact. */
const STDERR_SNIPPET_MAX = 300

/** The outcome of one command credential resolution. */
export type CommandCredentialResult =
  | { ok: true; value: string }
  | { ok: false; reason: string }

/** Whether a stored credential value names a command rather than a raw key. */
export function isCommandCredential(value: string): boolean {
  return value.startsWith(COMMAND_PREFIX)
}

/**
 * Run one command credential and capture its stdout.
 *
 * The command runs through the system shell so broker invocations may carry
 * arguments and environment expansion exactly as the operator wrote them.
 * Stdin is closed and the process is killed at the timeout. An empty stdout,
 * a non-zero exit, and a timeout all resolve to `ok: false` with an operator-
 * facing reason; stdout content never appears in a failure reason.
 *
 * @param reference - the stored value, including the leading `!`.
 * @param options.timeoutMs - resolution ceiling; injectable for tests.
 * @returns the trimmed stdout as the credential, or why none was produced.
 */
export async function resolveCommandCredential(
  reference: string,
  options?: { timeoutMs?: number },
): Promise<CommandCredentialResult> {
  const command = reference.slice(COMMAND_PREFIX.length)
  const timeoutMs = options?.timeoutMs ?? COMMAND_TIMEOUT_MS
  return new Promise((resolvePromise) => {
    execFile(
      '/bin/sh',
      ['-c', command],
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const killed = error.killed === true || error.signal != null
          const status = (error as NodeJS.ErrnoException & { code?: unknown }).code
          const snippet = typeof stderr === 'string' && stderr.trim().length > 0
            ? `; stderr: ${stderr.trim().slice(0, STDERR_SNIPPET_MAX)}`
            : ''
          resolvePromise({
            ok: false,
            reason: killed
              ? `command timed out after ${timeoutMs}ms`
              : `command failed (${String(status)})${snippet}`,
          })
          return
        }
        const value = stdout.trim()
        if (value.length === 0) {
          resolvePromise({ ok: false, reason: 'command produced empty stdout' })
          return
        }
        resolvePromise({ ok: true, value })
      },
    )
  })
}
