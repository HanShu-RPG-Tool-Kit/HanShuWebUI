import { useEffect, useLayoutEffect, useRef } from 'react'

/**
 * 上级容器（文本 + 配音按钮）的右键菜单。
 *
 * **可扩展**：条目完全由调用方给（`items`），加一条就多一个功能；
 * 默认的 Edit Key / Edit Text / Edit Voice / Delete 在 ScriptWorkspace 里组装。
 *
 * 定位与关闭照仓库既有右键菜单（Explorer 的资源右键）的惯例：
 * `position: fixed` + window 的 click / scroll / Escape 关闭。
 */

export type LangUnitMenuItem = {
  id: string
  label: string
  /** 危险操作：红色 */
  danger?: boolean
  /** 不可用（灰显，点了没反应） */
  disabled?: boolean
  onSelect(): void
}

export type LangUnitMenuProps = {
  /** 视口坐标（右键落点） */
  x: number
  y: number
  items: LangUnitMenuItem[]
  onClose(): void
}

/** 离视口边缘至少留这么宽，免得菜单被切掉 */
const EDGE_GAP = 8

export function LangUnitMenu({ x, y, items, onClose }: LangUnitMenuProps) {
  const ref = useRef<HTMLUListElement | null>(null)

  // 贴边时把菜单收进视口：菜单尺寸挂载后才知道，所以直接改内联样式（不动 state）
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const maxLeft = window.innerWidth - rect.width - EDGE_GAP
    const maxTop = window.innerHeight - rect.height - EDGE_GAP
    el.style.left = `${Math.max(EDGE_GAP, Math.min(x, maxLeft))}px`
    el.style.top = `${Math.max(EDGE_GAP, Math.min(y, maxTop))}px`
  }, [x, y, items.length])

  useEffect(() => {
    const close = () => onClose()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <ul
      ref={ref}
      className="hs-unit-menu"
      style={{ left: x, top: y }}
      role="menu"
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={`hs-unit-menu-item${item.danger ? ' is-danger' : ''}`}
            onClick={() => {
              onClose()
              item.onSelect()
            }}
          >
            {item.label}
          </button>
        </li>
      ))}
    </ul>
  )
}
