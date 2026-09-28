/**
 * 文件夹树(归档位置)。
 * 点击语义:箭头仅展开/折叠;名称进入该文件夹。
 * 计数采用「含子文件夹」的全库口径。键盘:↑↓ 移动、→ 展开、← 折叠/回父级、Enter 进入。
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import type { FolderWithStats } from '../contracts/types.ts'
import styles from '../styles/workspace.module.css'

export interface FolderTreeProps {
  folders: FolderWithStats[]
  selectedFolderId: string | null
  onSelect: (folderId: string) => void
  /** Optional: right-click folder row for manage actions. */
  onFolderContextMenu?: (folder: FolderWithStats, e: MouseEvent) => void
  /** Optional: right-click blank area (e.g. create root folder). */
  onBlankContextMenu?: (e: MouseEvent) => void
}

interface Row {
  folder: FolderWithStats
  depth: number
  hasChildren: boolean
}

export function FolderTree({
  folders,
  selectedFolderId,
  onSelect,
  onFolderContextMenu,
  onBlankContextMenu,
}: FolderTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('skin.foldertree.collapsed')
      return new Set(raw ? (JSON.parse(raw) as string[]) : [])
    } catch {
      return new Set()
    }
  })
  const [focusIdx, setFocusIdx] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try {
      localStorage.setItem('skin.foldertree.collapsed', JSON.stringify([...collapsed]))
    } catch {
      /* private mode */
    }
  }, [collapsed])

  const childrenOf = useMemo(() => {
    const m = new Map<string | null, FolderWithStats[]>()
    for (const f of folders) {
      const parent = f.parentId ?? null
      const list = m.get(parent) ?? []
      list.push(f)
      m.set(parent, list)
    }
    for (const list of m.values()) list.sort((a, b) => a.sortOrder - b.sortOrder)
    return m
  }, [folders])

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    const walk = (parentId: string | null, depth: number) => {
      for (const f of childrenOf.get(parentId) ?? []) {
        const kids = childrenOf.get(f.folderId) ?? []
        out.push({ folder: f, depth, hasChildren: kids.length > 0 })
        if (!collapsed.has(f.folderId)) walk(f.folderId, depth + 1)
      }
    }
    walk(null, 0)
    return out
  }, [childrenOf, collapsed])

  const toggle = (folderId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (rows.length === 0) return
    const row = rows[focusIdx]
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setFocusIdx((i) => Math.min(rows.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setFocusIdx((i) => Math.max(0, i - 1))
    } else if (e.key === 'ArrowRight' && row?.hasChildren) {
      e.preventDefault()
      if (collapsed.has(row.folder.folderId)) toggle(row.folder.folderId)
    } else if (e.key === 'ArrowLeft' && row) {
      e.preventDefault()
      if (row.hasChildren && !collapsed.has(row.folder.folderId)) {
        toggle(row.folder.folderId)
      } else if (row.folder.parentId) {
        const pi = rows.findIndex((r) => r.folder.folderId === row.folder.parentId)
        if (pi >= 0) setFocusIdx(pi)
      }
    } else if (e.key === 'Enter' && row) {
      e.preventDefault()
      onSelect(row.folder.folderId)
    }
  }

  return (
    <div
      className={styles.folderTree}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        if (!onBlankContextMenu) return
        const el = e.target as HTMLElement
        if (el.closest(`.${styles.folderRow}`)) return
        e.preventDefault()
        onBlankContextMenu(e)
      }}
    >
      <div className={styles.folderTreeHead}>
        <span>文件夹</span>
      </div>
      <div role="tree" aria-label="文件夹树" ref={listRef} className={styles.folderTreeList}>
        {folders.length === 0 && (
          <p className={styles.empty}>还没有文件夹。空白处右键可新建。</p>
        )}
        {rows.map((row, i) => {
          const f = row.folder
          const isCollapsed = collapsed.has(f.folderId)
          const isSelected = selectedFolderId === f.folderId
          return (
            <div
              key={f.folderId}
              role="treeitem"
              aria-expanded={row.hasChildren ? !isCollapsed : undefined}
              aria-selected={isSelected}
              aria-level={row.depth + 1}
              tabIndex={i === focusIdx ? 0 : -1}
              className={`${styles.folderRow}${isSelected ? ` ${styles.active}` : ''}${
                i === focusIdx ? ` ${styles.focused}` : ''
              }`}
              style={{ paddingLeft: 8 + row.depth * 16 }}
              onFocus={() => setFocusIdx(i)}
              onContextMenu={
                onFolderContextMenu
                  ? (e) => {
                      e.preventDefault()
                      onFolderContextMenu(f, e)
                    }
                  : undefined
              }
            >
              <button
                type="button"
                className={styles.chevron}
                aria-label={isCollapsed ? '展开' : '折叠'}
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation()
                  if (row.hasChildren) toggle(f.folderId)
                }}
              >
                {row.hasChildren ? (isCollapsed ? '▸' : '▾') : ''}
              </button>
              <span className={styles.folderIcon} aria-hidden>
                {isCollapsed ? '📁' : '📂'}
              </span>
              <button
                type="button"
                className={styles.folderName}
                title={f.path.join(' / ')}
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation()
                  onSelect(f.folderId)
                }}
              >
                {f.name}
              </button>
              <span className={styles.folderCount} title="含子文件夹">
                {f.subtreeCount}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
