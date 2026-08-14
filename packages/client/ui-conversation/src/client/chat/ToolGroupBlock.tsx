/**
 * One collapsed run of settled tool rows: a single disclosure line carrying
 * the counted summary (read 3 files · ran 2 commands · 1 error), expanding to
 * the member rows rendered through the ordinary chat node seat — the same
 * components, the same interaction, merely folded.
 */

import { memo, useMemo, useState } from 'react'
import { DisclosureRow, IconChecklistOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ToolGroup } from './tool-groups.ts'
import { countGroup } from './tool-groups.ts'
import { ChatNodeSeat } from './ChatNodeSeat.tsx'
import css from './ToolGroupBlock.module.css'

/** First-line preview cap for one narration line inside the folded process. */
const NARRATION_PREVIEW = 120

/**
 * One narration step inside the folded process, as a single muted line —
 * the full markdown would break the process list into islands between the
 * tool rows. Expanding reveals the step's whole prose.
 */
function NarrationLine({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const flat = text.replace(/\s+/g, ' ').trim()
  const preview = !expanded && flat.length > NARRATION_PREVIEW ? `${flat.slice(0, NARRATION_PREVIEW)}…` : flat
  return (
    <button
      type="button"
      className={css.narration}
      aria-expanded={expanded}
      title={expanded ? undefined : text}
      onClick={() => { setExpanded(value => !value) }}
    >
      {preview}
    </button>
  )
}

/**
 * One folded member: tool rows keep their compact seat row; narration steps
 * collapse to the muted line.
 */
function GroupMember({
  nodeKey,
  resolveNodes,
  seatProps,
}: {
  nodeKey: string
  resolveNodes: () => ChatNodeStore
  seatProps: Omit<Parameters<typeof ChatNodeSeat>[0], 'nodeKey'>
}) {
  const node = resolveNodes().get(nodeKey)
  if (node !== undefined && node.kind === 'assistant-step') {
    const blocks = (node.data as { blocks?: readonly { kind: string; text?: string }[] }).blocks
    const prose = Array.isArray(blocks)
      ? blocks.filter(block => block.kind === 'text').map(block => block.text ?? '').join(' ')
      : ''
    if (prose !== '') return <NarrationLine text={prose} />
  }
  return <ChatNodeSeat nodeKey={nodeKey} {...seatProps} />
}

/** Counting buckets in summary order with their label keys (literal keys keep the translate call typed). */
const VERB_KEYS = [
  ['read', 'group.verbs.read'],
  ['search', 'group.verbs.search'],
  ['bash', 'group.verbs.bash'],
  ['write', 'group.verbs.write'],
  ['edit', 'group.verbs.edit'],
  ['code', 'group.verbs.code'],
  ['others', 'group.verbs.others'],
] as const

/**
 * The collapsed tool-run disclosure.
 * @param props - the group, a node-store thunk, and the ChatView props
 * forwarded to every member ChatNodeSeat.
 */
export const ToolGroupBlock = memo(function ToolGroupBlock({
  group,
  resolveNodes,
  seatProps,
}: {
  group: ToolGroup
  /** Thunk resolving the live chat node store (kept out of memo deps). */
  resolveNodes: () => ChatNodeStore
  /** The ChatView's props forwarded to every member ChatNodeSeat. */
  seatProps: Omit<Parameters<typeof ChatNodeSeat>[0], 'nodeKey'>
}) {
  const [expanded, setExpanded] = useState(false)
  const summary = useMemo(() => {
    const counts = countGroup(group, resolveNodes())
    const verbs = VERB_KEYS
      .filter(([bucket]) => counts[bucket] > 0)
      .map(([bucket, key]) => seatProps.t(key, { count: counts[bucket] }))
      .join(' · ')
    const errors = counts.errors > 0 ? seatProps.t('group.errors', { count: counts.errors }) : ''
    return `${seatProps.t('group.summary', { verbs })}${errors}`
  }, [group, resolveNodes, seatProps.t])
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
          {group.keys.map(nodeKey => (
            <GroupMember key={nodeKey} nodeKey={nodeKey} resolveNodes={resolveNodes} seatProps={seatProps} />
          ))}
        </div>
      )}
    </div>
  )
})
