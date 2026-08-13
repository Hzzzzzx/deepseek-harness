/**
 * Durable OAuth credential store for pi-ai OAuth-backed catalog providers.
 *
 * pi-ai ships catalog providers whose only native authentication is OAuth
 * (`openai-codex`, Anthropic subscription, GitHub Copilot, ...). This adapter
 * authenticates requests by handing pi-ai an `apiKey` option per call, and an
 * OAuth access token is exactly the bearer those providers' APIs expect — so
 * a stored OAuth credential becomes a credential source on the same seam as
 * the api-key plane, instead of a parallel authentication system.
 *
 * The store is a single JSON document at `$DSH_HOME/auth.json` (override with
 * `DSH_OAUTH_STORE` for tests), one type-tagged credential per provider id,
 * mode `0600`. Writes follow the house protocol: readers lock-free, writers
 * serialized cross-process by `withFileLock`, committed atomically through
 * `writeFileAtomic` (both from `@deepseek-ai/dsh-atomic-write`).
 *
 * Token refresh is lazy and request-time, mirroring the reference
 * implementation in pi/prime-agent's `AuthStorage`: a request that finds the
 * access token expired refreshes it under the writer lock and persists the
 * rotated credential, so a long-running server never needs a separate
 * refresher daemon and a CLI login in another process cannot double-refresh
 * a rotated refresh token.
 */

import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { OAuthAuth, OAuthCredential } from '@earendil-works/pi-ai'

/** Store filename under the resolved DSH home directory. */
const STORE_FILENAME = 'auth.json'

/** Refresh this far ahead of expiry so a token never dies mid-request. */
const EXPIRY_SKEW_MS = 60_000

/**
 * Contention on the writer lock resolves within one refresh round-trip in the
 * common case; a contender whose wait times out re-reads the store — the
 * winner's commit usually landed meanwhile — and only retries the lock when
 * the credential is still expired. This bounds spurious request failures
 * without guessing whether an existing lock still has an owner.
 */
const LOCK_TIMEOUT_RETRIES = 3

/** The on-disk document: one OAuth credential per provider id. */
type OAuthStoreData = Record<string, OAuthCredential>

/** Non-secret view over one stored credential, for status surfaces. */
export interface OAuthCredentialInfo {
  providerId: string
  /** Absolute expiry timestamp of the stored access token, milliseconds. */
  expires: number
  /** Whether the stored access token is still usable without a refresh. */
  fresh: boolean
}

/**
 * The store file location: `$DSH_OAUTH_STORE` when set (tests), otherwise
 * `auth.json` under the resolved DSH home directory.
 * @param env - environment to consult; injectable for tests.
 * @returns the absolute store path.
 */
export function oauthStorePath(env: Record<string, string | undefined> = process.env): string {
  return env.DSH_OAUTH_STORE ?? join(resolveDshHome(undefined, env), STORE_FILENAME)
}

/**
 * Read the whole store document. A missing file is an empty store; malformed
 * content fails loud, naming the file, so a corrupted credential plane is an
 * operator action rather than silent data loss.
 * @param filename - store path, from {@link oauthStorePath}.
 * @returns the parsed document.
 */
async function readStore(filename: string): Promise<OAuthStoreData> {
  let text: string
  try {
    text = await readFile(filename, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return {}
    throw error
  }
  try {
    return JSON.parse(text) as OAuthStoreData
  } catch (error) {
    throw new Error(`oauth-store: ${filename} is not valid JSON; fix or remove it and log in again`, { cause: error })
  }
}

/**
 * Commit one store mutation: render the next document from the current one
 * and replace the file atomically with owner-only permissions. Caller holds
 * the writer lock.
 * @param filename - store path.
 * @param render - maps the current document to the next.
 */
async function commitStore(filename: string, render: (data: OAuthStoreData) => OAuthStoreData): Promise<void> {
  const data = render(await readStore(filename))
  await writeFileAtomic(filename, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, dirMode: 0o700 })
}

/** Whether a stored access token outlives the safety skew. */
function isFresh(credential: OAuthCredential): boolean {
  return Date.now() < credential.expires - EXPIRY_SKEW_MS
}

/** Coerce a flow-produced credential to the canonical type-tagged shape. */
function toStoredCredential(credential: OAuthCredential): OAuthCredential {
  return { ...credential, type: 'oauth' }
}

/** Whether an error is `withFileLock`'s contention timeout. */
function isLockTimeout(error: unknown): boolean {
  return error instanceof Error && error.message.includes('timed out waiting for the writer lock')
}

/**
 * Read one provider's stored credential without refreshing it. Display and
 * status use; request resolution goes through {@link resolveOAuthApiKey}.
 * @param providerId - catalog provider id (e.g. `openai-codex`).
 * @returns the stored credential, possibly expired, or `undefined`.
 */
export async function readOAuthCredential(providerId: string): Promise<OAuthCredential | undefined> {
  return (await readStore(oauthStorePath()))[providerId]
}

/**
 * Persist one provider's credential (login, or an explicit re-store). The
 * merge runs under the writer lock so a concurrent lazy refresh cannot
 * resurrect the credential it just rotated.
 * @param providerId - catalog provider id.
 * @param credential - the flow-produced credential to store.
 */
export async function writeOAuthCredential(providerId: string, credential: OAuthCredential): Promise<void> {
  const filename = oauthStorePath()
  await withFileLock(filename, async () => {
    await commitStore(filename, data => ({ ...data, [providerId]: toStoredCredential(credential) }))
  })
}

/**
 * Remove one provider's credential (logout). Removing a missing entry is a
 * no-op, so logout is idempotent.
 * @param providerId - catalog provider id.
 */
export async function removeOAuthCredential(providerId: string): Promise<void> {
  const filename = oauthStorePath()
  await withFileLock(filename, async () => {
    await commitStore(filename, (data) => {
      const { [providerId]: _removed, ...rest } = data
      return rest
    })
  })
}

/**
 * List stored credentials without exposing secrets or refreshing tokens.
 * @returns one info entry per stored provider, in document order.
 */
export async function listOAuthCredentials(): Promise<OAuthCredentialInfo[]> {
  const data = await readStore(oauthStorePath())
  return Object.entries(data).map(([providerId, credential]) => ({
    providerId,
    expires: credential.expires,
    fresh: isFresh(credential),
  }))
}

/**
 * Resolve a request-ready access token for one OAuth-backed provider.
 *
 * A fresh stored token returns immediately. An expired one is refreshed under
 * the writer lock — the re-read inside the lock absorbs a token rotated by
 * the login CLI or a concurrent request between this read and the lock — and
 * the rotated credential is persisted before the token leaves the lock, so
 * pi-ai's single-use refresh tokens never get replayed by two consumers.
 *
 * @param providerId - catalog provider id.
 * @param oauth - the catalog provider's OAuth auth (`provider.auth.oauth`),
 *   which owns the wire refresh.
 * @returns the access token, or `undefined` when no credential is stored —
 *   the caller then falls through to its ordinary credential resolution.
 */
export async function resolveOAuthApiKey(providerId: string, oauth: OAuthAuth): Promise<string | undefined> {
  const filename = oauthStorePath()
  let lastError: unknown
  for (let attempt = 0; attempt <= LOCK_TIMEOUT_RETRIES; attempt++) {
    const current = (await readStore(filename))[providerId]
    if (current === undefined) return undefined
    if (isFresh(current)) return current.access
    try {
      return await withFileLock(filename, async () => {
        const again = (await readStore(filename))[providerId]
        if (again === undefined) return undefined
        if (isFresh(again)) return again.access
        const refreshed = toStoredCredential(await oauth.refresh(again))
        await commitStore(filename, data => ({
          ...data,
          [providerId]: { ...again, ...refreshed, type: 'oauth' },
        }))
        return refreshed.access
      })
    } catch (error) {
      if (!isLockTimeout(error)) throw error
      lastError = error
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`oauth-store: could not refresh the ${providerId} credential after ${LOCK_TIMEOUT_RETRIES} retries`)
}
