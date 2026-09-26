/**
 * 通用右键菜单组件：支持键盘导航、边界检测、Esc 关闭。
 * 菜单打开时冻结目标对象，避免鼠标移动改变操作目标。
 */

import { useEffect, useRef, useState } from 'react'
import styles from '../styles/workspace.module.css'

export interface ContextMenuItem {
  label: string
  onClick: () => void
  danger?: boolean
  disabled?: boolean
  separator?: boolean
}

export interface ContextMenuProps {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [focusIdx, setFocusIdx] = useState(0)
  const [pos, setPos] = useState({ x, y })

  useEffect(() => {
    // Boundary detection: flip if menu would overflow viewport.
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    let nx = x
    let ny = y
    if (x + rect.width > window.innerWidth) nx = window.innerWidth - rect.width - 8
    if (y + rect.height > window.innerHeight) ny = window.innerHeight - rect.height - 8
    setPos({ x: nx, y: ny })
  }, [x, y])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      const enabled = items.filter((i) => !i.disabled && !i.separator)
      if (enabled.length === 0) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setFocusIdx((i) => (i + 1) % enabled.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setFocusIdx((i) => (i - 1 + enabled.length) % enabled.length)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        enabled[focusIdx]?.onClick()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items, focusIdx, onClose])

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [onClose])

  return (
    <div
      ref={ref}
      className={styles.contextMenu}
      style={{ left: pos.x, top: pos.y }}
      role="menu"
      aria-label="上下文菜单"
    >
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className={styles.contextMenuSeparator} role="separator" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={`${styles.contextMenuItem} ${item.danger ? styles.danger : ''} ${
              i === focusIdx ? styles.focused : ''
            }`}
            disabled={item.disabled}
            onClick={() => {
              item.onClick()
              onClose()
            }}
            onMouseEnter={() => setFocusIdx(i)}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  )
}
