/**
 * Three-column shell frame, registered into the built-in 'root' slot (the web
 * shell renders only 'root'). Owns the grid tracks (sidebar | center |
 * details), the drag handles (pointer capture + rAF throttle), the concession
 * chain (columns.ts), and the child-slot render decisions: the sidebar slot
 * renders HERE with live parameters from the concession solve, and the
 * session-aware occupants render in fixed column positions; strict entries
 * gate themselves on current-session availability while session-maybe
 * entries retain identity. Pure component: everything arrives
 * through the three framework shares — zero cordis or framework imports,
 * zero self-made hooks.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { computeColumns, SIDEBAR_AUTO_COLLAPSE, SIDEBAR_DEFAULT, SIDEBAR_DRAWER } from './columns.ts'
import type { createLayoutStore } from './stores.ts'
import css from './AppFrame.module.css'

/** Full composed props: runtime share + child-slot render share + store share. */
export type AppFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'sidebar' | 'conversation' | 'details' | 'shell.overlay'>
  & PropsStore<ReturnType<typeof createLayoutStore>>

/** Clamp a drawer drag offset into the closed→open range [0, SIDEBAR_DRAWER]. */
const clampReveal = (px: number): number => Math.max(0, Math.min(SIDEBAR_DRAWER, px))

/** Center column grid item (session-body building block). */
function CenterColumn(props: { children?: ReactNode }) {
  return <div className={css.centerCol}>{props.children}</div>
}

/** Details column grid item; width 0 keeps the subtree mounted (never unmount on close). */
function DetailsColumn(props: { children?: ReactNode }) {
  return <div className={css.detailsCol}>{props.children}</div>
}

/**
 * One drag handle: pointer capture, rAF-throttled dx reports against the drag-start origin.
 * `side` keys the hover-reveal CSS to the owning column.
 */
function DragHandle(props: { side: 'sidebar' | 'details'; left: number; onStart: () => void; onDrag: (dx: number) => void; onEnd: () => void }) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const callbacks = useRef({ onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd })
  callbacks.current = { onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd }

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    origin.current = e.clientX
    latest.current = e.clientX
    callbacks.current.onStart()
    setDragging(true)
  }, [])
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    latest.current = e.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(latest.current - origin.current)
    })
  }, [])
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
    callbacks.current.onDrag(latest.current - origin.current)
    setDragging(false)
    callbacks.current.onEnd()
  }, [])

  return (
    <div
      className={css.handle}
      style={{ left: props.left }}
      data-side={props.side}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  )
}

/** The three-column frame (see module doc). */
export function AppFrame({
  useStore,
  useSessions,
  actions,
  renderSlot,
}: AppFrameProps) {
  const panels = useStore(s => s)
  const detailsSession = useSessions((s) => {
    const current = s.current
    return current !== undefined && s.byId[current]?.blank === false ? current : undefined
  })
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState(() => window.innerWidth)

  const lastSession = useRef(detailsSession)
  useLayoutEffect(() => {
    if (detailsSession === undefined) return
    if (lastSession.current !== undefined && lastSession.current !== detailsSession) {
      actions.closeDetails()
    }
    lastSession.current = detailsSession
  }, [actions, detailsSession])

  // Track the frame's own box (not the window): rAF-throttled ResizeObserver.
  useEffect(() => {
    const el = frameRef.current
    /* v8 ignore next -- the ref is always attached by effect time: the frame div renders unconditionally. */
    if (el === null) return
    let raf: number | null = null
    const observer = new ResizeObserver(() => {
      raf ??= requestAnimationFrame(() => {
        raf = null
        const width = el.getBoundingClientRect().width
        if (width > 0) setViewport(width)
      })
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [])

  // Narrow viewports auto-collapse the sidebar; the store mirror keeps
  // toggleSidebar's semantics right (narrow toggles flip the manual
  // re-expand override, stores.ts). Below the breakpoint the sidebar leaves
  // the grid and surfaces as an overlay drawer (data-narrow): collapsed stays
  // false so SidebarRoot renders wide content inside the drawer, and the
  // grid's sidebar track is zero (the drawer is absolute, not a column) while
  // the conversation keeps the full viewport.
  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE
  useEffect(() => { actions.setNarrow(narrow) }, [actions, narrow])
  const drawerOpen = narrow && panels.narrowExpanded
  const sidebarCollapsed = narrow ? false : panels.sidebar === 0
  const sidebarPreference = sidebarCollapsed
    ? 0
    : panels.sidebar === 0 ? SIDEBAR_DEFAULT : panels.sidebar
  const cols = computeColumns(viewport, narrow ? 0 : sidebarPreference, detailsSession === undefined ? 0 : panels.details)
  const colsRef = useRef(cols)
  colsRef.current = cols

  // Selecting a session (row open, New Session, fork) collapses an open
  // drawer so the user lands back on the conversation. `current` is the
  // widest signal — it moves on every selection path, including undefined →
  // first session from the hero, which the details effect above does not
  // cover (it gates on a non-blank session).
  const currentSession = useSessions(s => s.current)
  const lastCurrent = useRef(currentSession)
  useEffect(() => {
    if (lastCurrent.current !== currentSession) {
      if (drawerOpen) actions.closeSidebar()
      lastCurrent.current = currentSession
    }
  }, [actions, currentSession, drawerOpen])

  // Escape closes an open drawer (modal parity).
  useEffect(() => {
    if (!drawerOpen) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') actions.closeSidebar()
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [actions, drawerOpen])

  // Drawer drag-following: `drawerRevealed` is the visible px offset from
  // fully closed (0) to fully open (SIDEBAR_DRAWER); null leaves the position
  // to the data-drawer-open CSS transition. The left edge reveals (open);
  // the mask drags left or taps (close). Both use pointer capture + rAF like
  // DragHandle, and Pointer Events cover touch and mouse alike.
  const [drawerRevealed, setDrawerRevealed] = useState<number | null>(null)
  const edgeOrigin = useRef(0)
  const edgeLatest = useRef(0)
  const edgeFrame = useRef<number | null>(null)
  const onEdgePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    edgeOrigin.current = event.clientX
    edgeLatest.current = event.clientX
  }, [])
  const onEdgePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    edgeLatest.current = event.clientX
    edgeFrame.current ??= requestAnimationFrame(() => {
      edgeFrame.current = null
      setDrawerRevealed(clampReveal(edgeLatest.current - edgeOrigin.current))
    })
  }, [])
  const onEdgePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    if (edgeFrame.current !== null) { cancelAnimationFrame(edgeFrame.current); edgeFrame.current = null }
    const dx = edgeLatest.current - edgeOrigin.current
    setDrawerRevealed(null)
    if (dx > SIDEBAR_DRAWER * 0.4) actions.openSidebar()
  }, [actions])

  const maskOrigin = useRef(0)
  const maskLatest = useRef(0)
  const maskFrame = useRef<number | null>(null)
  const maskMoved = useRef(false)
  const onMaskPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    maskOrigin.current = event.clientX
    maskLatest.current = event.clientX
    maskMoved.current = false
  }, [])
  const onMaskPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    maskLatest.current = event.clientX
    if (Math.abs(maskLatest.current - maskOrigin.current) > 8) maskMoved.current = true
    maskFrame.current ??= requestAnimationFrame(() => {
      maskFrame.current = null
      setDrawerRevealed(clampReveal(SIDEBAR_DRAWER + (maskLatest.current - maskOrigin.current)))
    })
  }, [])
  const onMaskPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    if (maskFrame.current !== null) { cancelAnimationFrame(maskFrame.current); maskFrame.current = null }
    const dx = maskLatest.current - maskOrigin.current
    setDrawerRevealed(null)
    // A tap (no move) or a left-swipe past the threshold both close.
    if (!maskMoved.current || dx < -SIDEBAR_DRAWER * 0.4) actions.closeSidebar()
  }, [actions])

  const drawerTransform = drawerRevealed === null
    ? undefined
    : `translateX(calc(-100% + ${drawerRevealed}px))`
  const maskOpacity = drawerRevealed === null ? undefined : drawerRevealed / SIDEBAR_DRAWER

  // The drag base is the rendered width captured at drag start (grabbing a
  // concession-clamped panel must not jump back to the stored preference);
  // it stays frozen for the whole gesture so dx deltas do not compound.
  const sidebarBase = useRef(0)
  const detailsBase = useRef(0)
  // Track-level transitions pause for the whole gesture: eased tracks would
  // detach the column edge from the pointer (AppFrame.module.css).
  const [dragging, setDragging] = useState(false)
  const onDragEnd = useCallback(() => { setDragging(false) }, [])
  const onSidebarStart = useCallback(() => { sidebarBase.current = colsRef.current.sidebar; setDragging(true) }, [])
  const onDetailsStart = useCallback(() => { detailsBase.current = colsRef.current.details; setDragging(true) }, [])
  const onSidebarDrag = useCallback((dx: number) => {
    actions.setSidebar(sidebarBase.current + dx)
  }, [actions])
  const onDetailsDrag = useCallback((dx: number) => {
    actions.setDetails(detailsBase.current - dx)
  }, [actions])

  return (
    <div
      ref={frameRef}
      className={css.frame}
      style={{ gridTemplateColumns: narrow
        // 窄屏下侧边栏是 absolute 抽屉、不占 grid 轨道；三轨模板会让
        // 在流的 center/details 错位一轨（center 落到 0 轨、details 落满 1fr）。
        ? `minmax(0, 1fr) ${cols.details}px`
        : `${cols.sidebar}px minmax(0, 1fr) ${cols.details}px` }}
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      data-details-collapsed={cols.details === 0 || undefined}
      data-dragging={dragging || undefined}
      data-narrow={narrow || undefined}
      data-drawer-open={drawerOpen || undefined}
      data-drawer-dragging={drawerRevealed !== null || undefined}
    >
      <div
        className={css.sidebarCol}
        style={narrow
          ? ({ '--drawer-w': `${SIDEBAR_DRAWER}px`, transform: drawerTransform } as CSSProperties)
          : undefined}
      >
        {/* Render-site slot call with live concession output: a closed
            sidebar keeps the mounted slot at the compact-rail width, and the
            component sees its rendered state as owner params decided here
            (collapsed follows the resolved rail, so a derived auto-collapse
            renders the rail UI too). Narrow viewports force wide content
            inside the drawer (collapsed stays false, width is the drawer). */}
        {renderSlot('sidebar', {
          collapsed: sidebarCollapsed,
          width: narrow ? SIDEBAR_DRAWER : cols.sidebar,
        })}
      </div>
      <>
        {/* Both column occupants stay at fixed tree positions from first
            paint — no loading gate: a bare status line reads worse than
            the shell's own pending rendering. The conversation
            is session-maybe; the strict details entry naturally renders
            empty while no session is current. */}
        <CenterColumn>{renderSlot('conversation', {})}</CenterColumn>
        <DetailsColumn>{renderSlot('details', {})}</DetailsColumn>
      </>
      {/* Narrow-viewport drawer: a mask over the conversation plus a left-edge
          reveal strip. The mask closes on tap or left-swipe; the edge pulls the
          drawer open. Both are absolute frame children above the columns. */}
      {narrow && (
        <>
          <div
            className={css.drawerMask}
            aria-hidden="true"
            style={maskOpacity === undefined ? undefined : { opacity: maskOpacity }}
            onPointerDown={onMaskPointerDown}
            onPointerMove={onMaskPointerMove}
            onPointerUp={onMaskPointerUp}
          />
          {!drawerOpen && (
            <div
              className={css.drawerEdge}
              onPointerDown={onEdgePointerDown}
              onPointerMove={onEdgePointerMove}
              onPointerUp={onEdgePointerUp}
            />
          )}
        </>
      )}
      <div className={css.overlayLayer} data-shell-overlay>
        {renderSlot('shell.overlay', {})}
      </div>
      {/* The collapsed rail is fixed-width: no resize handle while closed.
          Narrow viewports use the drawer, not a resizable column. */}
      {!sidebarCollapsed && !narrow && <DragHandle side="sidebar" left={cols.sidebar} onStart={onSidebarStart} onDrag={onSidebarDrag} onEnd={onDragEnd} />}
      {cols.details > 0 && <DragHandle side="details" left={viewport - cols.details} onStart={onDetailsStart} onDrag={onDetailsDrag} onEnd={onDragEnd} />}
    </div>
  )
}
