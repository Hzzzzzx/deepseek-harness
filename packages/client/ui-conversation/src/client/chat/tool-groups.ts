/**
 * Settled tool-call collapsing: runs of consecutive completed tool rows fold
 * into one disclosure block so a long turn's historical activity stops
 * pushing prose off screen, while running rows stay fully visible (the
 * reader follows live work, not history). Pure derivation over the ordered
 * chat node list; rendering happens in ToolGroupBlock through the same
 * ChatNodeSeat rows the ungrouped flow uses.
 */

import type { ChatNodeStore, ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import { isRunningTool } from '../contract/chat-nodes.ts'

/** Minimum run length that collapses; a lone tool row stays as-is. */
export const GROUP_MIN = 2

/** One collapsed run of settled tool-call nodes. */
export interface ToolGroup {
  readonly kind: 'group'
  /** Chat node keys of the member rows, in flow order. */
  readonly keys: readonly string[]
}

/** A flow item: either one ordinary node key or one collapsed group. */
export type FlowItem = { readonly kind: 'node'; readonly key: string } | ToolGroup

/**
 * Read one flow node's tool root when it is a tool-call row.
 * @param nodes - the chat node store.
 * @param key - the flow node key.
 * @returns the tool lifecycle block, or undefined for every other kind.
 */
function toolRootOf(nodes: ChatNodeStore, key: string): ToolCallBlock | undefined {
  const node = nodes.get(key)
  if (node === undefined || node.kind !== 'tool-call') return undefined
  // The store's wide view carries `data: unknown` before the ChatNodeDataMap
  // merge narrows it; the kind test above is the runtime discriminant.
  return (node.data as { root: ToolCallBlock }).root
}

/**
 * Partition the ordered node keys into flow items, collapsing consecutive
 * runs of SETTLED tool-call nodes (length >= GROUP_MIN) into groups.
 * Running tool calls, and any node of another kind, break a run and render
 * as ordinary items.
 * @param order - the chat snapshot's ordered node keys.
 * @param nodes - the chat node store (kind + tool lifecycle lookup).
 * @returns flow items in order.
 */
export function partitionToolGroups(order: readonly string[], nodes: ChatNodeStore): readonly FlowItem[] {
  const items: FlowItem[] = []
  let run: string[] = []
  const flush = (): void => {
    if (run.length >= GROUP_MIN) items.push({ kind: 'group', keys: run })
    else for (const key of run) items.push({ kind: 'node', key })
    run = []
  }
  for (const key of order) {
    const root = toolRootOf(nodes, key)
    if (root !== undefined && !isRunningTool(root)) {
      run.push(key)
      continue
    }
    flush()
    items.push({ kind: 'node', key })
  }
  flush()
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
