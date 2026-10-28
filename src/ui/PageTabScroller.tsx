import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'

/**
 * 游戏性页签的横向拉条。
 * 页签本身不压缩；放不下时底部出现可拖动的细条，滚轮也能横滑。
 * 剧本编辑器共用这一份，避免再做一套会把标签挤扁的页签条。
 */
export function PageTabScroller({
  focused = true,
  activeKey,
  itemCount,
  label,
  children,
  scrollProps,
}: {
  focused?: boolean
  activeKey?: string | null
  itemCount: number
  label: string
  children: ReactNode
  scrollProps?: HTMLAttributes<HTMLDivElement>
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const hoverRef = useRef(false)
  const dragBarRef = useRef(false)
  const hideTimer = useRef(0)
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null)
  const [barVisible, setBarVisible] = useState(false)

  function syncThumb() {
    const el = scrollRef.current
    if (!el) return
    const { scrollLeft, scrollWidth, clientWidth } = el
    if (scrollWidth <= clientWidth + 1) {
      setThumb(null)
      return
    }
    const width = Math.max(24, (clientWidth / scrollWidth) * clientWidth)
    const max = Math.max(0, clientWidth - width)
    const left = max === 0 ? 0 : (scrollLeft / (scrollWidth - clientWidth)) * max
    setThumb({ left, width })
  }

  function showBar(sticky = false) {
    syncThumb()
    setBarVisible(true)
    window.clearTimeout(hideTimer.current)
    if (!sticky && !hoverRef.current && !dragBarRef.current) {
      hideTimer.current = window.setTimeout(() => setBarVisible(false), 900)
    }
  }

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    syncThumb()
    const onScroll = () => showBar()
    const onWheel = (event: WheelEvent) => {
      const max = el.scrollWidth - el.clientWidth
      if (max <= 0) return
      const dominant = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
      if (dominant === 0) return
      const next = Math.min(max, Math.max(0, el.scrollLeft + dominant))
      if (next === el.scrollLeft) return
      event.preventDefault()
      el.scrollLeft = next
      showBar()
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: false })
    const observer = new ResizeObserver(() => syncThumb())
    observer.observe(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
      observer.disconnect()
      window.clearTimeout(hideTimer.current)
    }
  }, [itemCount])

  useEffect(() => {
    if (!activeKey || !scrollRef.current) return
    const tab = scrollRef.current.querySelector<HTMLElement>(`[data-page-key="${CSS.escape(activeKey)}"]`)
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    syncThumb()
  }, [activeKey, itemCount])

  return (
    <div
      className={`flow-page-list${focused ? ' is-focused' : ''}`}
      onMouseEnter={() => { hoverRef.current = true; showBar(true) }}
      onMouseLeave={() => { hoverRef.current = false; showBar(false) }}
    >
      <div
        {...scrollProps}
        ref={scrollRef}
        className="flow-page-list-scroll"
        role="tablist"
        aria-label={label}
      >
        {children}
      </div>
      {thumb && (
        <div className={`flow-page-scroll${barVisible ? ' is-visible' : ''}`} aria-hidden="true">
          <div
            className="flow-page-scroll-thumb"
            style={{ left: thumb.left, width: thumb.width }}
            onPointerDown={(event) => {
              if (event.button !== 0 || !scrollRef.current) return
              event.preventDefault()
              event.stopPropagation()
              const el = scrollRef.current
              const startX = event.clientX
              const startScroll = el.scrollLeft
              const range = el.scrollWidth - el.clientWidth
              const track = el.clientWidth - thumb.width
              const target = event.currentTarget
              target.setPointerCapture(event.pointerId)
              dragBarRef.current = true
              hoverRef.current = true
              showBar(true)
              function onMove(move: PointerEvent) {
                if (track <= 0) return
                el.scrollLeft = startScroll + ((move.clientX - startX) / track) * range
              }
              function onUp(up: PointerEvent) {
                dragBarRef.current = false
                target.releasePointerCapture(up.pointerId)
                target.removeEventListener('pointermove', onMove)
                target.removeEventListener('pointerup', onUp)
                target.removeEventListener('pointercancel', onUp)
                if (!hoverRef.current) showBar(false)
              }
              target.addEventListener('pointermove', onMove)
              target.addEventListener('pointerup', onUp)
              target.addEventListener('pointercancel', onUp)
            }}
          />
        </div>
      )}
    </div>
  )
}