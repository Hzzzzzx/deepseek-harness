/**
 * Turn-aware process collapsing: when a turn closes, only its LAST
 * prose-carrying assistant reply stays visible; everything before it —
 * settled tool calls, thinking steps, and intermediate narration — folds
 * into ONE disclosure block anchored ahead of that reply, so a completed
 * turn reads as its answer with the work behind one line (read 3 files ·
 * ran 2 commands). An open turn keeps every row visible (the reader follows
 * live work). Snapshots without resolved turns fall back to folding
 * consecutive runs of settled tool rows.
 */

import type { ChatNodeStore, ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import { isRunningTool } from '../contract/chat-nodes.ts'

/** Minimum run length for the no-timeline fallback; turn-level folding has no minimum. */
export const GROUP_MIN = 2

/** One collapsed run of process nodes. */
export interface ToolGroup {
  readonly kind: 'group'
  /** Chat node keys of the member rows, in flow order. */
  readonly keys: readonly string[]
}

/** A flow item: either one ordinary node key or one collapsed group. */
export type FlowItem = { readonly kind: 'node'; readonly key: string } | ToolGroup

/** Read one flow node's tool root when it is a tool-call row. */
function toolRootOf(nodes: ChatNodeStore, key: string): ToolCallBlock | undefined {
  const node = nodes.get(key)
  if (node === undefined || node.kind !== 'tool-call') return undefined
  // The store's wide view carries `data: unknown` before the ChatNodeDataMap
  // merge narrows it; the kind test above is the runtime discriminant.
  return (node.data as { root: ToolCallBlock }).root
}

/** The node's turn number when its location resolves inside one. */
function turnOf(nodes: ChatNodeStore, key: string): number | undefined {
  const location = nodes.get(key)?.location
  if (location === undefined || location.kind === 'session' || location.kind === 'unresolved') return undefined
  return location.turn.status === 'closed' ? location.turn.turn : undefined
}

/** Whether the node is an assistant step. */
function isAssistantStep(nodes: ChatNodeStore, key: string): boolean {
  return nodes.get(key)?.kind === 'assistant-step'
}

/**
 * Whether an assistant step carries reading material (text or image blocks).
 * The LAST such step of a closed turn is the reply the flow keeps visible;
 * every earlier step — prose or not — is process and folds.
 */
function assistantStepHasProse(nodes: ChatNodeStore, key: string): boolean {
  const node = nodes.get(key)
  if (node === undefined || node.kind !== 'assistant-step') return false
  const blocks = (node.data as { blocks?: readonly { kind: string }[] }).blocks
  return Array.isArray(blocks) && blocks.some(block => block.kind === 'text' || block.kind === 'image')
}

/**
 * Partition the ordered node keys into flow items.
 *
 * Turn-aware pass: for every closed turn, the last assistant-step is the
 * keeper; every other assistant-step and every settled tool-call of that
 * turn folds into one group placed at the first folded member's position.
 * Nodes of other kinds (errors, tails, retries) keep their positions.
 * Keys outside closed turns render as themselves, except the fallback:
 * consecutive settled tool runs of length >= GROUP_MIN still fold.
 * @param order - the chat snapshot's ordered node keys.
 * @param nodes - the chat node store (kind, tool lifecycle, location).
 * @returns flow items in order.
 */
export function partitionToolGroups(order: readonly string[], nodes: ChatNodeStore): readonly FlowItem[] {
  // Pass 1: per closed turn, the foldable keys and each turn's keeper.
  const keeperOf = new Map<number, string>()
  const foldableOf = new Map<number, string[]>()
  for (const key of order) {
    const turn = turnOf(nodes, key)
    if (turn === undefined) continue
    // The keeper is the LAST prose-carrying step in flow order; later
    // prose steps overwrite earlier ones, so the turn shows one reply.
    if (isAssistantStep(nodes, key) && assistantStepHasProse(nodes, key)) keeperOf.set(turn, key)
  }
  for (const key of order) {
    const turn = turnOf(nodes, key)
    if (turn === undefined) continue
    const node = nodes.get(key)
    const root = toolRootOf(nodes, key)
    const foldable = (node !== undefined && root !== undefined && !isRunningTool(root))
      || (isAssistantStep(nodes, key) && keeperOf.get(turn) !== key)
    if (!foldable) continue
    const list = foldableOf.get(turn)
    if (list === undefined) foldableOf.set(turn, [key])
    else list.push(key)
  }

  // Pass 2: emit. A turn's fold lands once, at its first folded member.
  const items: FlowItem[] = []
  const foldedTurns = new Set<number>()
  let fallbackRun: string[] = []
  const flushFallback = (): void => {
    if (fallbackRun.length >= GROUP_MIN) items.push({ kind: 'group', keys: fallbackRun })
    else for (const key of fallbackRun) items.push({ kind: 'node', key })
    fallbackRun = []
  }
  for (const key of order) {
    const turn = turnOf(nodes, key)
    if (turn !== undefined) {
      const foldList = foldableOf.get(turn)
      if (foldList !== undefined && foldList.includes(key)) {
        flushFallback()
        if (!foldedTurns.has(turn)) {
          foldedTurns.add(turn)
          items.push({ kind: 'group', keys: foldList })
        }
        continue
      }
    }
    const root = toolRootOf(nodes, key)
    if (turn === undefined && root !== undefined && !isRunningTool(root)) {
      fallbackRun.push(key)
      continue
    }
    flushFallback()
    items.push({ kind: 'node', key })
  }
  flushFallback()
  return items
}

/** Verb-keyed counts for one group's summary line. */
export interface GroupCounts {
  readonly read: number
  readonly search: number
  readonly bash: number
  readonly write: number
  readonly edit: number
  readonly code: number
  readonly others: number
  readonly errors: number
}

/** Tool name to counting bucket; mirrors the row variant taxonomy. */
function bucketOf(toolName: string): keyof Omit<GroupCounts, 'errors'> {
  switch (toolName) {
    case 'read': case 'web_fetch': return 'read'
    case 'grep': case 'glob': case 'web_search': return 'search'
    case 'bash': case 'pwsh': return 'bash'
    case 'write': return 'write'
    case 'edit': return 'edit'
    case 'run_code': return 'code'
    default: return 'others'
  }
}

/**
 * Count one group's calls into summary buckets.
 * @param group - the collapsed run.
 * @param nodes - the chat node store (tool name + lifecycle lookup).
 * @returns per-verb counts and the error count.
 */
export function countGroup(group: ToolGroup, nodes: ChatNodeStore): GroupCounts {
  const counts: Record<keyof GroupCounts, number> = {
    read: 0, search: 0, bash: 0, write: 0, edit: 0, code: 0, others: 0, errors: 0,
  }
  for (const key of group.keys) {
    const root = toolRootOf(nodes, key)
    if (root === undefined) continue
    const name = 'kind' in root ? root.call?.name ?? '' : root.name
    counts[bucketOf(name)] += 1
    if ('kind' in root && root.isError) counts.errors += 1
  }
  return counts
}
