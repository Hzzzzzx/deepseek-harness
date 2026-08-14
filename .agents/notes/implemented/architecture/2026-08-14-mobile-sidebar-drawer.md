# Agent Note: Mobile sidebar surfaces as a swipe drawer below the auto-collapse breakpoint

Status: implemented

English | [中文](2026-08-14-mobile-sidebar-drawer.zh.md)

## Problem

Below the `SIDEBAR_AUTO_COLLAPSE` breakpoint (`columns.ts`, 1024px) the shipped shell collapsed the sidebar into a 56px fixed rail and a manual toggle re-expanded it by *squeezing* the center column (`narrowExpanded` in `stores.ts`). On a phone that reads poorly: the rail claims vertical-edge space the conversation needs, and re-expanding narrows the transcript instead of overlaying it. The product ask is the mobile pattern — the sidebar stowed as an overlay drawer that slides over the conversation, opened by a swipe or a button, and dismissed the moment a session is chosen so the user lands back on the detail.

The grid-column + squeeze model cannot express that: an in-flow column cannot overlay its sibling, and the only store action was `toggleSidebar`, whose flip semantics cannot "ensure closed" — yet selecting a session, tapping the mask, or pressing Escape must close regardless of prior state.

## Decision

Below the breakpoint the sidebar leaves the grid and surfaces as an absolute overlay drawer (`data-narrow` on the frame, `AppFrame.module.css`). The grid's sidebar track is zero (the conversation keeps the full viewport), and `sidebarCol` becomes `position: absolute` translated off the left edge; `data-drawer-open` slides it in, `data-drawer-dragging` suspends the transition for pointer-paced following. `narrowExpanded` keeps its role as the open/closed bit (`drawerOpen = narrow && panels.narrowExpanded`), but its effect changed from squeezing the center to revealing the drawer — the width preference survives untouched, so widening back past the breakpoint restores the wide layout.

Two explicit actions join the store and `ctx.layout` (`ILayout` / `LayoutController`): `openSidebar` and `closeSidebar`, mirroring the `openDetails` / `closeDetails` pair. `closeSidebar` is the ensure-closed path the drawer mask, Escape, and session-select need; `toggleSidebar` is unchanged for the wide rail toggle and the brand button.

Open affordances are the mobile standard pair: a ☰ button in `ConversationRoot` (a `@media (max-width: 1023px)` top bar, visible in hero and active phases, wired to `ctx.layout.openSidebar()` through `ConversationInjected`), and a left-edge Pointer Events reveal strip that follows the finger and commits past 40% of `SIDEBAR_DRAWER` (320px). Close is symmetric: selecting a session, tapping the mask, pressing Escape, or left-swiping the mask past the threshold. Pointer Events cover touch and mouse with one code path; the drag reuses the existing `DragHandle` shape (pointer capture + rAF), so no gesture library is added. The mask reuses the Modal tokens (`--dsw-alias-bg-mask-1`, `--dsw-mask-blur`).

Session-select collapse subscribes `useSessions(s => s.current)` with a ref-compare effect, the same pattern the frame already uses to close details on a session switch; `current` moves on every selection path including `undefined` → first session from the hero. The pure `computeColumns` solver is untouched — the narrow branch simply feeds sidebar preference 0 and writes the grid template `0 minmax(0, 1fr) …`.

## Alternatives considered

- **Keep the 56px rail as the open entry (rail + overlay)**: rejected — a resident rail still consumes edge space and contradicts the "stowed" requirement; the drawer is meant to be invisible until summoned.
- **Adopt a gesture library** (`framer-motion`, `react-swipeable`): rejected — the project carries zero gesture dependencies, and edge/mask drag-following is a thin reuse of the existing pointer-capture + rAF `DragHandle` pattern; a library would add weight for one transition.
- **Close via `toggleSidebar`**: rejected — flip semantics cannot guarantee a target state; the mask, Escape, and session-select need a deterministic close, so an explicit `closeSidebar` (mirroring `closeDetails`) is the right shape.

## Consequences

- Below 1024px the conversation owns the full viewport; the 56px rail survives only as the wide-viewport collapsed state. `SIDEBAR_DRAWER = 320` (`max-width: 85%`) is the drawer geometry constant.
- The open entry point crosses packages by design: `ui-conversation` injects `openSidebar` (`ctx.layout`), `ui-layout` owns the drawer geometry and gestures. `ConversationSlotProps` gains `openSidebar` via `ConversationInjected`.
- A desktop window dragged below 1024px also gets the drawer (the breakpoint is shared, not forked into a separate mobile-only value), trading the squeeze-expand for an overlay at every narrow width.
- The ☰ bar stacks above the session header on narrow active conversations — accepted as the standard mobile double bar.
