/**
 * One collapsed run of a closed turn's process: a single disclosure line
 * carrying the counted summary (read 3 files · ran 2 commands · 1 error).
 * The expanded body re-renders the turn's process the way the reference
 * clients do: narration as ordinary prose (same font as the final reply),
 * and consecutive tool rows regrouped into nested sub-disclosures so runs
 * of activity stay scannable inside the opened block.
 */

import { memo, useMemo, useState } from 'react'
import { DisclosureRow, IconChecklistOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AssistantBlock, ChatNodeStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { FlowItem, ToolGroup } from './tool-groups.ts'
import { countGroup, groupHasNarration, groupSpanMs, partitionToolGroups } from './tool-groups.ts'
import { ChatNodeSeat } from './ChatNodeSeat.tsx'
import { AssistantMarkdown } from './AssistantMarkdown.tsx'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { formatRunDuration } from './message-chrome.ts'
import css from './ToolGroupBlock.module.css'

/** ChatView props forwarded to every member ChatNodeSeat. */
type SeatProps = Omit<Parameters<typeof ChatNodeSeat>[0], 'nodeKey'>

/** Counting buckets in summary order with their label keys. */
const VERB_KEYS = [
  ['read', 'group.verbs.read'],
  ['search', 'group.verbs.search'],
  ['bash', 'group.verbs.bash'],
  ['write', 'group.verbs.write'],
  ['edit', 'group.verbs.edit'],
  ['code', 'group.verbs.code'],
  ['others', 'group.verbs.others'],
] as const

/** Build one group's counted summary line, with wall-clock span, through the locale seat. */
function groupSummary(group: ToolGroup, resolveNodes: () => ChatNodeStore, t: ChatViewSlotProps['t']): string {
  const counts = countGroup(group, resolveNodes())
  const verbs = VERB_KEYS
    .filter(([bucket]) => counts[bucket] > 0)
    .map(([bucket, key]) => t(key, { count: counts[bucket] }))
    .join(' · ')
  const errors = counts.errors > 0 ? t('group.errors', { count: counts.errors }) : ''
  const span = groupSpanMs(group, resolveNodes())
  const duration = span === null ? '' : ` · ${formatRunDuration(span, t)}`
  return `${t('group.summary', { verbs })}${errors}${duration}`
}

/**
 * The nested sub-disclosure for consecutive tool rows inside the expanded
 * process block — one more counted line one level down.
 */
const ToolSubGroup = memo(function ToolSubGroup({
  group,
  resolveNodes,
  seatProps,
}: {
  group: ToolGroup
  resolveNodes: () => ChatNodeStore
  seatProps: SeatProps
}) {
  const [expanded, setExpanded] = useState(false)
  const summary = useMemo(
    () => groupSummary(group, resolveNodes, seatProps.t as ChatViewSlotProps['t']),
    [group, resolveNodes, seatProps.t],
  )
  return (
    <div className={css.subGroup}>
      <DisclosureRow
        rowClassName={css.subRow}
        titleClassName={css.subTitle}
        chevronClassName={css.subChevron}
        icon={<IconChecklistOutline14 size={12} />}
        title={summary}
        open={expanded}
        expandable
        expandOnRowClick
        onToggle={() => { setExpanded(value => !value) }}
      />
      {expanded && (
        <div className={css.subMembers}>
          {group.keys.map(nodeKey => (
            <ChatNodeSeat key={nodeKey} nodeKey={nodeKey} {...seatProps} />
          ))}
        </div>
      )}
    </div>
  )
})

/**
 * One narration step inside the expanded process: ordinary prose through the
 * same markdown the final reply uses — same font, same rendering — because
 * the reference clients render intermediate narration as normal text.
 */
const NarrationStep = memo(function NarrationStep({
  nodeKey,
  resolveNodes,
  seatProps,
}: {
  nodeKey: string
  resolveNodes: () => ChatNodeStore
  seatProps: SeatProps
}) {
  const node = resolveNodes().get(nodeKey)
  const blocks = node !== undefined && node.kind === 'assistant-step'
    ? (node.data as { blocks?: readonly AssistantBlock[] }).blocks
    : undefined
  return (
    <AssistantMarkdown
      blocks={blocks ?? []}
      streaming={false}
      t={seatProps.t as ChatViewSlotProps['t']}
    />
  )
})

/**
 * The collapsed turn-process disclosure.
 * @param props - the group, a node-store thunk, and the ChatView props.
 */
export const ToolGroupBlock = memo(function ToolGroupBlock({
  group,
  resolveNodes,
  seatProps,
}: {
  group: ToolGroup
  /** Thunk resolving the live chat node store (kept out of memo deps). */
  resolveNodes: () => ChatNodeStore
  seatProps: SeatProps
}) {
  const [expanded, setExpanded] = useState(false)
  const summary = useMemo(
    () => groupSummary(group, resolveNodes, seatProps.t as ChatViewSlotProps['t']),
    [group, resolveNodes, seatProps.t],
  )
  // Inside the expanded body: a run of tools WITHOUT narration renders
  // flat (nesting an identical counted line adds nothing); with narration,
  // the prose renders normally and each tool run between prose folds once.
  const hasNarration = useMemo(() => groupHasNarration(group, resolveNodes()), [group, resolveNodes])
  const inner = useMemo(
    () => hasNarration ? partitionToolGroups(group.keys, resolveNodes()) : null,
    [hasNarration, group, resolveNodes],
  )
  return (
    <div className={css.root} data-tool-group={group.keys[0]}>
      <DisclosureRow
        rowClassName={css.row}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={<IconChecklistOutline14 size={14} />}
        title={summary}
        open={expanded}
        expandable
        expandOnRowClick
        onToggle={() => { setExpanded(value => !value) }}
      />
      {expanded && (
        <div className={css.members}>
          {inner === null
            ? group.keys.map(nodeKey => (
              <ChatNodeSeat key={nodeKey} nodeKey={nodeKey} {...seatProps} />
            ))
            : inner.map((item: FlowItem) => {
              if (item.kind === 'group') {
                return <ToolSubGroup key={`sub:${item.keys[0]}`} group={item} resolveNodes={resolveNodes} seatProps={seatProps} />
              }
              const node = resolveNodes().get(item.key)
              if (node !== undefined && node.kind === 'assistant-step') {
                return <NarrationStep key={item.key} nodeKey={item.key} resolveNodes={resolveNodes} seatProps={seatProps} />
              }
              return <ChatNodeSeat key={item.key} nodeKey={item.key} {...seatProps} />
            })}
        </div>
      )}
    </div>
  )
})
