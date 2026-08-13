import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OAuthAuth, OAuthCredential } from '@earendil-works/pi-ai'
import {
  listOAuthCredentials,
  oauthStorePath,
  readOAuthCredential,
  removeOAuthCredential,
  resolveOAuthApiKey,
  writeOAuthCredential,
} from '../src/oauth-store.ts'

const PROVIDER = 'openai-codex'

let dir: string
let store: string

const credential = (overrides: Partial<OAuthCredential> = {}): OAuthCredential => ({
  type: 'oauth',
  access: 'access-token',
  refresh: 'refresh-token',
  expires: Date.now() + 3_600_000,
  ...overrides,
})

const refreshedCredential = (overrides: Partial<OAuthCredential> = {}): OAuthCredential =>
  credential({ access: 'refreshed-access', refresh: 'rotated-refresh', ...overrides })

const oauthFlow = (refresh: OAuthAuth['refresh']): OAuthAuth => ({
  name: 'Test OAuth',
  login: () => Promise.reject(new Error('login is not exercised by the store')),
  refresh,
  toAuth: c => Promise.resolve({ apiKey: c.access }),
})

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-oauth-store-'))
  store = join(dir, 'auth.json')
  vi.stubEnv('DSH_OAUTH_STORE', store)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

describe('oauthStorePath', () => {
  it('prefers DSH_OAUTH_STORE over the DSH home', () => {
    expect(oauthStorePath({ DSH_OAUTH_STORE: '/tmp/custom.json' })).toBe('/tmp/custom.json')
  })
})

describe('readOAuthCredential', () => {
  it('resolves undefined for a missing store file', async () => {
    await expect(readOAuthCredential(PROVIDER)).resolves.toBeUndefined()
  })

  it('fails loud on malformed JSON, naming the file', async () => {
    await writeFile(store, 'not json', { mode: 0o600 })
    await expect(readOAuthCredential(PROVIDER)).rejects.toThrow(store)
  })
})

describe('writeOAuthCredential / removeOAuthCredential', () => {
  it('round-trips one credential with owner-only permissions', async () => {
    await writeOAuthCredential(PROVIDER, credential())
    await expect(readOAuthCredential(PROVIDER)).resolves.toMatchObject({ access: 'access-token' })
    expect((await stat(store)).mode & 0o777).toBe(0o600)
  })

  it('stores several providers side by side and removes one', async () => {
    await writeOAuthCredential('openai-codex', credential({ access: 'a' }))
    await writeOAuthCredential('anthropic', credential({ access: 'b' }))
    await removeOAuthCredential('openai-codex')
    await expect(readOAuthCredential('openai-codex')).resolves.toBeUndefined()
    await expect(readOAuthCredential('anthropic')).resolves.toMatchObject({ access: 'b' })
  })

  it('treats removing a missing credential as a no-op', async () => {
    await removeOAuthCredential(PROVIDER)
    await expect(readOAuthCredential(PROVIDER)).resolves.toBeUndefined()
  })
})

describe('listOAuthCredentials', () => {
  it('reports freshness without exposing tokens', async () => {
    await writeOAuthCredential(PROVIDER, credential({ expires: Date.now() - 1_000 }))
    const list = await listOAuthCredentials()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ providerId: PROVIDER, fresh: false })
    expect(JSON.stringify(list)).not.toContain('refresh-token')
  })
})

describe('resolveOAuthApiKey', () => {
  it('resolves undefined when nothing is stored, so the caller falls through', async () => {
    const refresh = vi.fn()
    await expect(resolveOAuthApiKey(PROVIDER, oauthFlow(refresh))).resolves.toBeUndefined()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('returns the stored access token while it is fresh, without refreshing', async () => {
    await writeOAuthCredential(PROVIDER, credential())
    const refresh = vi.fn()
    await expect(resolveOAuthApiKey(PROVIDER, oauthFlow(refresh))).resolves.toBe('access-token')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('refreshes an expired token once and persists the rotated credential', async () => {
    await writeOAuthCredential(PROVIDER, credential({ expires: Date.now() - 1_000 }))
    const refresh = vi.fn(() => Promise.resolve(refreshedCredential()))
    await expect(resolveOAuthApiKey(PROVIDER, oauthFlow(refresh))).resolves.toBe('refreshed-access')
    expect(refresh).toHaveBeenCalledTimes(1)
    await expect(readOAuthCredential(PROVIDER)).resolves.toMatchObject({
      access: 'refreshed-access',
      refresh: 'rotated-refresh',
      type: 'oauth',
    })
    // The rotated refresh token must be what a second call sees: single-use
    // refresh tokens are never replayed.
    await expect(resolveOAuthApiKey(PROVIDER, oauthFlow(refresh))).resolves.toBe('refreshed-access')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('preserves provider-specific fields across a refresh', async () => {
    await writeOAuthCredential(PROVIDER, credential({ expires: Date.now() - 1_000, accountId: 'acct-1' }))
    const refresh = vi.fn(() => Promise.resolve(refreshedCredential()))
    await resolveOAuthApiKey(PROVIDER, oauthFlow(refresh))
    await expect(readOAuthCredential(PROVIDER)).resolves.toMatchObject({
      accountId: 'acct-1',
      access: 'refreshed-access',
    })
  })

  it('normalizes a flow credential missing the type tag before persisting', async () => {
    await writeOAuthCredential(PROVIDER, credential({ expires: Date.now() - 1_000 }))
    const untyped = { access: 'untyped-access', refresh: 'r2', expires: Date.now() + 3_600_000 } as OAuthCredential
    const refresh = vi.fn(() => Promise.resolve(untyped))
    await expect(resolveOAuthApiKey(PROVIDER, oauthFlow(refresh))).resolves.toBe('untyped-access')
    const raw = JSON.parse(await readFile(store, 'utf8')) as Record<string, OAuthCredential>
    expect(raw[PROVIDER]?.type).toBe('oauth')
  })
})
