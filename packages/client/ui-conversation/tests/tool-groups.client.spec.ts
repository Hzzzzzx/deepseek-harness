// @vitest-environment jsdom
/** Behavior specs for the settled-tool-run collapsing derivation. */
import { describe, expect, it } from 'vitest'
import type { ChatNodeStore, RunningToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import { countGroup, GROUP_MIN, partitionToolGroups, type FlowItem } from '../src/client/chat/tool-groups.ts'

/** Flow node stub: only kind + tool root participate in the derivation. */
function stubNode(kind: string, root?: unknown): { kind: string; data: unknown } {
  return { kind, data: root === undefined ? {} : { root } }
}

function storeOf(entries: Record<string, { kind: string; data: unknown }>): ChatNodeStore {
  return {
    get: key => entries[key] as never,
    values: () => Object.values(entries) as never,
  }
}

const settled = (name: string, isError = false): ToolResultNode => ({
  kind: 'tool-result', seq: 1, time: 1, callId: 'c',
  call: { name, argsRaw: '{}' }, callTime: 0,
  content: [], isError, callView: null, resultView: null, subCalls: [],
})

const running = (name: string): RunningToolCall => ({
  callId: 'r', name, argsRaw: '{}', turn: 1, step: 1, time: 1, callView: null, subCalls: [],
})

describe('partitionToolGroups', () => {
  it('collapses a run of settled tool rows at the group minimum', () => {
    const store = storeOf({
      a: stubNode('tool-call', settled('bash')),
      b: stubNode('tool-call', settled('read')),
    })
    const items = partitionToolGroups(['u', 'a', 'b', 'v'], store)
    expect(items).toEqual([
      { kind: 'node', key: 'u' },
      { kind: 'group', keys: ['a', 'b'] },
      { kind: 'node', key: 'v' },
    ] satisfies FlowItem[])
  })

  it(`keeps runs shorter than ${GROUP_MIN} as ordinary rows`, () => {
    const store = storeOf({ a: stubNode('tool-call', settled('bash')) })
    const items = partitionToolGroups(['a', 'v'], store)
    expect(items).toEqual([{ kind: 'node', key: 'a' }, { kind: 'node', key: 'v' }] satisfies FlowItem[])
  })

  it('breaks the run at a running tool call and keeps it visible', () => {
    const store = storeOf({
      a: stubNode('tool-call', settled('bash')),
      r: stubNode('tool-call', running('read')),
      b: stubNode('tool-call', settled('edit')),
    })
    const items = partitionToolGroups(['a', 'r', 'b'], store)
    expect(items).toEqual([
      { kind: 'node', key: 'a' },
      { kind: 'node', key: 'r' },
      { kind: 'node', key: 'b' },
    ] satisfies FlowItem[])
  })

  it('breaks the run at any non-tool node', () => {
    const store = storeOf({
      a: stubNode('tool-call', settled('bash')),
      m: stubNode('assistant-step'),
      b: stubNode('tool-call', settled('read')),
    })
    const items = partitionToolGroups(['a', 'm', 'b'], store)
    expect(items).toEqual([
      { kind: 'node', key: 'a' },
      { kind: 'node', key: 'm' },
      { kind: 'node', key: 'b' },
    ] satisfies FlowItem[])
  })
})

describe('countGroup', () => {
  it('counts per verb and totals errors', () => {
    const group = { kind: 'group', keys: ['a', 'b', 'c', 'd'] } as const
    const store = storeOf({
      a: stubNode('tool-call', settled('bash')),
      b: stubNode('tool-call', settled('read', true)),
      c: stubNode('tool-call', settled('grep')),
      d: stubNode('tool-call', settled('mystery')),
    })
    expect(countGroup(group, store)).toEqual({
      read: 1, search: 1, bash: 1, write: 0, edit: 0, code: 0, others: 1, errors: 1,
    })
  })
})
