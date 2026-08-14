/**
 * State-aware row titles: one verbified phrase per (variant, state) instead of
 * the static figma literal, so a running row reads 正在读取 src/index.ts and
 * the settled row reads 已读取 src/index.ts. Pure derivation over the shared
 * ToolRowModel inputs; the dictionary lives in the conversation locale so
 * group summaries (built from the same verbs) and single rows share one
 * vocabulary.
 */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { toolSpecificTitle, type ToolRowModel, type ToolRowState, type ToolRowVariant } from './tool-call-model.ts'

/** Locale seat: the conversation namespace translate the owner hands down. */
export type RowLocale = TranslateNS<'conversation'>

/** Dictionary keys naming one variant's verb, per locale entry row.verb.<variant>. */
const VERB_KEY = {
  search: 'row.verb.search',
  read: 'row.verb.read',
  bash: 'row.verb.bash',
  write: 'row.verb.write',
  edit: 'row.verb.edit',
  code: 'row.verb.code',
  others: 'row.verb.others',
} as const satisfies Record<ToolRowVariant, string>

/** Dictionary keys wrapping the verb in one state's phrasing. */
const STATE_KEY = {
  running: 'row.state.running',
  ok: 'row.state.ok',
  error: 'row.state.error',
  stopped: 'row.state.stopped',
} as const satisfies Record<ToolRowState, string>

/**
 * Derive the state-aware title for one tool row: a localized verb phrase per
 * (variant, state), for example 正在读取 / 已读取 / 读取失败. A tool that owns
 * a specific title (Inspect, Run Cordis Plugin, …) keeps it in every state —
 * its vocabulary names its own act, and the row's summary already carries the
 * live target.
 * @param toolName - wire tool name (specific-title lookup).
 * @param model - the row model (variant + state).
 * @param t - conversation locale seat.
 * @returns the row title.
 */
export function rowStateTitle(
  toolName: string,
  model: Pick<ToolRowModel, 'variant' | 'state'>,
  t: RowLocale,
): string {
  const specific = toolSpecificTitle(toolName)
  if (specific !== undefined) return specific
  const verb = t(VERB_KEY[model.variant])
  return t(STATE_KEY[model.state], { verb })
}
