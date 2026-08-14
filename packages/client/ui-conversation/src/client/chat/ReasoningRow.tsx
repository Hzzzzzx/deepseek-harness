/** Assistant reasoning disclosure, independent of Tool-call presentation. */
import { useEffect, useRef, useState } from 'react'
import { DisclosureRow, IconThinkOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { useThrottledVisualUpdate } from './use-throttled-visual-update.ts'
import a11yCss from './accessibility.module.css'
import css from './ReasoningRow.module.css'

function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

function latestLine(text: string): string {
  const visible = text.trimEnd()
  const newline = visible.lastIndexOf('\n')
  return newline === -1 ? visible : visible.slice(newline + 1)
}

/**
 * Render one assistant reasoning block as the Think disclosure row. The row
 * follows the thinking lifecycle by default: a streaming block opens and
 * auto-scrolls its body, and the settled block closes into the one-line
 * summary — the reader sees the thought live, then gets the space back. A
 * manual toggle overrides the default for the rest of the block's life.
 * @param props.text - complete or streaming reasoning text.
 * @param props.running - whether this block is the streaming tail.
 * @param props.t - conversation locale seat for the running status.
 * @returns the reasoning disclosure.
 */
export function ReasoningRow({ text, running, t }: { text: string; running: boolean; t: ChatViewSlotProps['t'] }) {
  // null = follow the lifecycle (running opens, settled closes); any manual
  // toggle wins for this block's remaining life.
  const [userChoice, setUserChoice] = useState<boolean | null>(null)
  const expanded = userChoice ?? running
  const summaryRef = useRef<HTMLSpanElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const summary = running ? latestLine(text) : firstLine(text)
  const scheduleSummaryScroll = useThrottledVisualUpdate(() => {
    const element = summaryRef.current
    if (element === null) return
    element.scrollLeft = running ? element.scrollWidth - element.clientWidth : 0
  })
  const scheduleBodyScroll = useThrottledVisualUpdate(() => {
    const element = bodyRef.current
    if (element === null) return
    element.scrollTop = element.scrollHeight
  })
  useEffect(() => {
    scheduleSummaryScroll()
  }, [running, scheduleSummaryScroll, summary])
  useEffect(() => {
    if (running && expanded) scheduleBodyScroll()
  }, [running, expanded, text, scheduleBodyScroll])

  return (
    <div className={css.root} data-variant="think" data-state={running ? 'running' : 'ok'}>
      {running && <span className={a11yCss.visuallyHidden}>{t('row.running')}</span>}
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={<IconThinkOutline14 size={14} />}
        title={running ? t('think.running') : t('think.settled')}
        open={expanded}
        expandable
        expandOnRowClick
        onToggle={() => { setUserChoice(!expanded) }}
        collapsedContent={(
          <>
            <span className={css.separator} aria-hidden />
            <span ref={summaryRef} className={css.summary} data-follow-end={running || undefined}>{summary}</span>
          </>
        )}
      >
        <div ref={bodyRef} className={css.thinkBody}>{text}</div>
      </DisclosureRow>
    </div>
  )
}
