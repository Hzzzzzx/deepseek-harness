import { describe, expect, it } from 'vitest'
import { isCommandCredential, resolveCommandCredential } from '../src/command-credential.ts'

describe('isCommandCredential', () => {
  it('marks only bang-prefixed values', () => {
    expect(isCommandCredential('!/bin/echo hi')).toBe(true)
    expect(isCommandCredential('sk-123')).toBe(false)
    expect(isCommandCredential('')).toBe(false)
  })
})

describe('resolveCommandCredential', () => {
  it('resolves trimmed stdout as the credential', async () => {
    await expect(resolveCommandCredential('!/bin/echo wire-token')).resolves.toEqual({
      ok: true,
      value: 'wire-token',
    })
  })

  it('supports arguments and shell expansion as written by the operator', async () => {
    await expect(resolveCommandCredential('!printf "%s-%s" part1 part2')).resolves.toEqual({
      ok: true,
      value: 'part1-part2',
    })
  })

  it('fails empty stdout without exposing any output', async () => {
    const result = await resolveCommandCredential('!true')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('empty stdout')
  })

  it('fails a non-zero exit with status and a bounded stderr snippet', async () => {
    const result = await resolveCommandCredential("!/bin/sh -c 'echo diagnostic-line >&2; exit 3'")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('command failed')
      expect(result.reason).toContain('diagnostic-line')
    }
  })

  it('fails a missing executable with a failure reason', async () => {
    const result = await resolveCommandCredential('!/nonexistent/broker-binary-xyz')
    expect(result.ok).toBe(false)
  })

  it('fails an over-long command at the injected timeout', async () => {
    const result = await resolveCommandCredential('!sleep 5', { timeoutMs: 100 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('timed out')
  }, 10_000)
})
