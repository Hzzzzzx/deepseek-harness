// @vitest-environment jsdom
/** Behavior specs for the settled-tool-run collapsing derivation. */
import { describe, expect, it } from 'vitest'
import type { ChatNodeStore, RunningToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import { countGroup, GROUP_MIN, partitionToolGroups, type FlowItem } from '../src/client/chat/tool-groups.ts'

/** Flow node stub: only kind + tool root participate in the derivation. */
function stubNode(kind: string, root?: unknown): { kind: string; data: unknown; location?: unknown } {
  return { kind, data: root === undefined ? {} : { root } }
}

/** Location stub placing a node inside one closed turn. */
function inTurn(turn: number): { kind: 'step'; turn: { turn: number; status: 'closed' } } {
  return { kind: 'step', turn: { turn, status: 'closed' } }
}

function storeOf(entries: Record<string, { kind: string; data: unknown; location?: unknown }>): ChatNodeStore {
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

describe('partitionToolGroups (turn-aware)', () => {
  it('folds the closed turn process into one group ahead of the final reply', () => {
    const store = storeOf({
      u: { kind: 'user', data: {}, location: inTurn(1) },
      think: { kind: 'assistant-step', data: { blocks: [{ kind: 'reasoning', text: 'hmm' }] }, location: inTurn(1) },
      t1: { kind: 'tool-call', data: { root: settled('bash') }, location: inTurn(1) },
      t2: { kind: 'tool-call', data: { root: settled('read') }, location: inTurn(1) },
      reply: { kind: 'assistant-step', data: { blocks: [{ kind: 'text', text: 'done' }] }, location: inTurn(1) },
    })
    const items = partitionToolGroups(['u', 'think', 't1', 't2', 'reply'], store)
    expect(items).toEqual([
      { kind: 'node', key: 'u' },
      { kind: 'group', keys: ['think', 't1', 't2'] },
      { kind: 'node', key: 'reply' },
    ] satisfies FlowItem[])
  })

  it('folds intermediate narration too; only the last prose step stays', () => {
    const store = storeOf({
      u: { kind: 'user', data: {}, location: inTurn(1) },
      mid: { kind: 'assistant-step', data: { blocks: [{ kind: 'text', text: 'narration' }] }, location: inTurn(1) },
      t1: { kind: 'tool-call', data: { root: settled('bash') }, location: inTurn(1) },
      reply: { kind: 'assistant-step', data: { blocks: [{ kind: 'text', text: 'final' }] }, location: inTurn(1) },
    })
    const items = partitionToolGroups(['u', 'mid', 't1', 'reply'], store)
    expect(items).toEqual([
      { kind: 'node', key: 'u' },
      { kind: 'group', keys: ['mid', 't1'] },
      { kind: 'node', key: 'reply' },
    ] satisfies FlowItem[])
  })

  it('keeps the LAST prose step when a turn replies twice', () => {
    const store = storeOf({
      u: { kind: 'user', data: {}, location: inTurn(1) },
      early: { kind: 'assistant-step', data: { blocks: [{ kind: 'text', text: 'early reply' }] }, location: inTurn(1) },
      t1: { kind: 'tool-call', data: { root: settled('edit') }, location: inTurn(1) },
      late: { kind: 'assistant-step', data: { blocks: [{ kind: 'text', text: 'late reply' }] }, location: inTurn(1) },
    })
    const items = partitionToolGroups(['u', 'early', 't1', 'late'], store)
    expect(items).toEqual([
      { kind: 'node', key: 'u' },
      { kind: 'group', keys: ['early', 't1'] },
      { kind: 'node', key: 'late' },
    ] satisfies FlowItem[])
  })

  it('leaves an open turn fully visible', () => {
    const open = { kind: 'step' as const, turn: { turn: 2, status: 'open' as const } }
    const store = storeOf({
      t1: { kind: 'tool-call', data: { root: settled('bash') }, location: open },
      r: { kind: 'tool-call', data: { root: running('read') }, location: open },
    })
    const items = partitionToolGroups(['t1', 'r'], store)
    expect(items).toEqual([
      { kind: 'node', key: 't1' },
      { kind: 'node', key: 'r' },
    ] satisfies FlowItem[])
  })
})
