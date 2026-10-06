import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react'
import { Icon } from './FlowExplorer'
import { isKitDocument, isNavigationDocument, isProgressDocument, isScriptDocument } from './library'
import { NodeContextMenu, type NodeMenuItem } from './NodeContextMenu'
import type { FlowDocument } from './storage'

export const PAGE_DRAG_TYPE = 'application/x-hanshu-page'

function pageIcon(doc: FlowDocument): 'kit' | 'python' | 'progress' | 'navigator' | 'document' {
  if (isKitDocument(doc)) return 'kit'
  if (isScriptDocument(doc)) return 'python'
  if (isProgressDocument(doc)) return 'progress'
  if (isNavigationDocument(doc)) return 'navigator'
  return 'document'
}

function PinMark() {
  return <svg className="flow-page-pin" viewBox="0 0 16 16" aria-hidden="true">
    <path fill="currentColor" d="M8.5 1.5a.75.75 0 00-1.5 0V6H5.2a.75.75 0 00-.53 1.28l2.12 2.12-.7 4.35a.75.75 0 001.47.24l.69-4.25 2.12 2.12A.75.75 0 0011.8 11V7.5h-.05V6H9.5V1.5z" />
  </svg>
}

/** 一个编辑组的页条。拖拽中的页由工作区统一记录，因此可以跨组拖放。 */
export function PageList({
  docs,
  activeKey,
  pinnedKeys,
  focused,
  splitOn,
  disabled,
  dragKey,
  onSelect,
  onClose,
  onCloseOthers,
  onCloseRight,
  onCloseAll,
  onTogglePin,
  onDragStart,
  onDragEnd,
  onDropTab,
  onSplit,
  onMoveToOther,
  onJoin,
}: {
  docs: FlowDocument[]
  activeKey: string | null
  pinnedKeys: string[]
  /** 该组是否为焦点组；非焦点组的当前页不画强调线 */
  focused: boolean
  splitOn: boolean
  disabled: boolean
  /** 任意组里正在拖动的页 */
  dragKey: string | null
  onSelect: (key: string) => void
  onClose: (key: string) => void
  onCloseOthers: (key: string) => void
  onCloseRight: (key: string) => void
  onCloseAll: () => void
  onTogglePin: (key: string) => void
  onDragStart: (key: string) => void
  onDragEnd: () => void
  /** 放到某页之前；null 为末尾 */
  onDropTab: (beforeKey: string | null) => void
  onSplit: (key: string, zone: 'right' | 'bottom') => void
  onMoveToOther: (key: string) => void
  onJoin: () => void
}) {
  const pinned = useMemo(() => new Set(pinnedKeys), [pinnedKeys])
  const scrollRef = useRef<HTMLDivElement>(null)
  const hoverRef = useRef(false)
  const dragBarRef = useRef(false)
  const hideTimer = useRef(0)
  const [menu, setMenu] = useState<{ key: string; x: number; y: number } | null>(null)
  const [dropKey, setDropKey] = useState<string | null>(null)
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
    // 竖直滚轮也用来横滑页条（和 VS Code 一样），需非 passive 才能 preventDefault
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
  }, [docs.length])

  useEffect(() => {
    if (!activeKey || !scrollRef.current) return
    const tab = scrollRef.current.querySelector<HTMLElement>(`[data-page-key="${CSS.escape(activeKey)}"]`)
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    syncThumb()
  }, [activeKey, docs.length])

  const menuDoc = menu ? docs.find((item) => item.key === menu.key) : null
  const menuKey = menu?.key
  const menuPinned = menuKey ? pinned.has(menuKey) : false
  const menuIndex = menuKey ? docs.findIndex((item) => item.key === menuKey) : -1
  const hasRightCloseable = menuIndex >= 0 && docs.slice(menuIndex + 1).some((item) => !pinned.has(item.key))
  const hasOtherCloseable = menuKey ? docs.some((item) => item.key !== menuKey && !pinned.has(item.key)) : false
  const hasCloseable = docs.some((item) => !pinned.has(item.key))

  const menuItems: NodeMenuItem[] = menuDoc && menuKey ? [
    { label: '关闭', disabled: menuPinned, hint: menuPinned ? '请先取消固定' : undefined, action: () => onClose(menuKey) },
    { label: '关闭其他页', disabled: !hasOtherCloseable, action: () => onCloseOthers(menuKey) },
    { label: '关闭右侧页', disabled: !hasRightCloseable, action: () => onCloseRight(menuKey) },
    { label: '关闭所有页', disabled: !hasCloseable, action: () => onCloseAll() },
    { label: menuPinned ? '取消固定' : '固定', action: () => onTogglePin(menuKey) },
    ...(splitOn ? [
      { label: '移到另一侧', action: () => onMoveToOther(menuKey) },
      { label: '合并拆分', action: () => onJoin() },
    ] : [
      { label: '向右拆分', action: () => onSplit(menuKey, 'right') },
      { label: '向下拆分', action: () => onSplit(menuKey, 'bottom') },
    ]),
  ] : []

  function openMenu(event: MouseEvent, key: string) {
    event.preventDefault()
    event.stopPropagation()
    if (disabled) return
    setMenu({ key, x: event.clientX, y: event.clientY })
  }

  function over(event: DragEvent, target: string | null) {
    if (!dragKey || disabled) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    setDropKey(target ?? '')
  }

  function drop(event: DragEvent, target: string | null) {
    if (!dragKey || disabled) return
    event.preventDefault()
    event.stopPropagation()
    setDropKey(null)
    onDropTab(target)
  }

  return <>
    <div
      className={`flow-page-list${focused ? ' is-focused' : ''}`}
      onMouseEnter={() => { hoverRef.current = true; showBar(true) }}
      onMouseLeave={() => { hoverRef.current = false; showBar(false) }}
    >
      <div
        ref={scrollRef}
        className="flow-page-list-scroll"
        role="tablist"
        aria-label="已打开的文档"
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropKey(null) }}
      >
        {docs.map((item) => {
          const isPinned = pinned.has(item.key)
          const isActive = item.key === activeKey
          return <div
            key={item.key}
            data-page-key={item.key}
            className={[
              'flow-page-tab',
              isActive ? 'is-active' : '',
              isPinned ? 'is-pinned' : '',
              dragKey === item.key ? 'is-dragging' : '',
              dropKey === item.key && dragKey !== item.key ? 'is-drop' : '',
            ].filter(Boolean).join(' ')}
            role="tab"
            aria-selected={isActive}
            draggable={!disabled}
            onPointerDown={(event) => {
              // 按下即选中，避免拖拽手势吞掉 click
              if (disabled || event.button !== 0) return
              if ((event.target as HTMLElement).closest('.flow-page-tab-close')) return
              onSelect(item.key)
            }}
            onDragStart={(event) => {
              if (disabled) { event.preventDefault(); return }
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData(PAGE_DRAG_TYPE, item.key)
              onDragStart(item.key)
            }}
            onDragEnd={() => { setDropKey(null); onDragEnd() }}
            onDragOver={(event) => over(event, item.key)}
            onDrop={(event) => drop(event, item.key)}
            onAuxClick={(event) => {
              if (event.button === 1 && !disabled && !isPinned) {
                event.preventDefault()
                onClose(item.key)
              }
            }}
            onContextMenu={(event) => openMenu(event, item.key)}
          >
            <button type="button" className="flow-page-tab-name" disabled={disabled} title={item.name} onClick={() => onSelect(item.key)}>
              <Icon kind={pageIcon(item)} />
              {isPinned && <PinMark />}
              <span>{item.name}</span>
            </button>
            {!isPinned && (
              <button type="button" className="flow-page-tab-close" disabled={disabled} aria-label={`关闭 ${item.name}`} onClick={() => onClose(item.key)}>×</button>
            )}
          </div>
        })}
        <div
          className={`flow-page-list-rest${dropKey === '' ? ' is-drop' : ''}`}
          onDragOver={(event) => over(event, null)}
          onDrop={(event) => drop(event, null)}
        />
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
    {menu && menuDoc && !disabled && (
      <NodeContextMenu
        x={menu.x}
        y={menu.y}
        title={menuDoc.name}
        label="页操作"
        items={menuItems}
        onClose={() => setMenu(null)}
      />
    )}
  </>
}
