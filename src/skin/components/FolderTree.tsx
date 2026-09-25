/**
 * 文件夹树(归档位置)。
 * 点击语义:箭头仅展开/折叠;名称进入该文件夹;"…"菜单提供操作。
 * 计数采用「含子文件夹」的全库口径。键盘:↑↓ 移动、→ 展开、← 折叠/回父级、Enter 进入。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { FolderWithStats } from '../contracts/types.ts'
import styles from '../styles/workspace.module.css'

export interface FolderTreeProps {
  folders: FolderWithStats[]
  selectedFolderId: string | null
  onSelect: (folderId: string) => void
  onCreate: (name: string, parentId: string | null) => Promise<string | null>
  onRename: (folderId: string, name: string) => Promise<string | null>
  onMove: (folderId: string, parentId: string | null) => Promise<string | null>
  onSortByName: (folderId: string) => Promise<string | null>
  onDelete: (folderId: string) => Promise<string | null>
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
  onCreate,
  onRename,
  onMove,
  onSortByName,
  onDelete,
}: FolderTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('skin.foldertree.collapsed')
      return new Set(raw ? (JSON.parse(raw) as string[]) : [])
    } catch {
      return new Set()
    }
  })
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ folderId: string; value: string } | null>(null)
  const [creatingUnder, setCreatingUnder] = useState<string | null | 'root'>(null)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [focusIdx, setFocusIdx] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try {
      localStorage.setItem('skin.foldertree.collapsed', JSON.stringify([...collapsed]))
    } catch {
      /* private mode */
    }
  }, [collapsed])

  useEffect(() => {
    if (!error) return
    const t = setTimeout(() => setError(null), 4000)
    return () => clearTimeout(t)
  }, [error])

  const childrenOf = useMemo(() => {
    const m = new Map<string | null, FolderWithStats[]>()
    for (const f of folders) {
      const list = m.get(f.parentId) ?? []
      list.push(f)
      m.set(f.parentId, list)
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

  const closeMenu = () => setMenuFor(null)

  const runAction = async (fn: () => Promise<string | null>) => {
    const err = await fn()
    if (err) setError(err)
    closeMenu()
  }

  const submitCreate = async () => {
    const name = newName.trim()
    if (!name) return
    const parentId = creatingUnder === 'root' ? null : creatingUnder
    const err = await onCreate(name, parentId)
    if (err) {
      setError(err)
      return
    }
    if (parentId) {
      setCollapsed((prev) => {
        const next = new Set(prev)
        next.delete(parentId)
        return next
      })
    }
    setCreatingUnder(null)
    setNewName('')
  }

  const submitRename = async () => {
    if (!editing) return
    const name = editing.value.trim()
    if (name) {
      const err = await onRename(editing.folderId, name)
      if (err) {
        setError(err)
        return
      }
    }
    setEditing(null)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing || creatingUnder !== null) return
    const row = rows[focusIdx]
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setFocusIdx(Math.min(rows.length - 1, focusIdx + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setFocusIdx(Math.max(0, focusIdx - 1))
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
    <div className={styles.folderTree} onKeyDown={onKeyDown}>
      <div className={styles.folderTreeHead}>
        <span>文件夹</span>
        <button
          type="button"
          className={styles.iconBtn}
          title="新建根文件夹"
          onClick={() => {
            setCreatingUnder('root')
            setNewName('')
          }}
        >
          ＋
        </button>
      </div>
      {creatingUnder === 'root' && (
        <div className={styles.inlineForm}>
          <input
            autoFocus
            value={newName}
            placeholder="新文件夹名称"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitCreate()
              if (e.key === 'Escape') setCreatingUnder(null)
            }}
          />
          <button onClick={() => void submitCreate()}>创建</button>
          <button onClick={() => setCreatingUnder(null)}>取消</button>
        </div>
      )}
      <div role="tree" aria-label="文件夹树" ref={listRef} onClick={closeMenu}>
        {folders.length === 0 && <p className={styles.empty}>还没有文件夹,点击 ＋ 新建。</p>}
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
              {editing?.folderId === f.folderId ? (
                <input
                  autoFocus
                  className={styles.folderRename}
                  value={editing.value}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setEditing({ folderId: f.folderId, value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submitRename()
                    if (e.key === 'Escape') setEditing(null)
                  }}
                  onBlur={() => void submitRename()}
                />
              ) : (
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
              )}
              <span className={styles.folderCount} title="含子文件夹">
                {f.subtreeCount}
              </span>
              <button
                type="button"
                className={`${styles.iconBtn} ${styles.folderMenuBtn}`}
                aria-label="文件夹操作"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuFor(menuFor === f.folderId ? null : f.folderId)
                }}
              >
                ⋯
              </button>
              {menuFor === f.folderId && (
                <div className={styles.folderMenu} onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => {
                      setCreatingUnder(f.folderId)
                      setNewName('')
                      closeMenu()
                    }}
                  >
                    新建子文件夹
                  </button>
                  <button
                    onClick={() => {
                      setEditing({ folderId: f.folderId, value: f.name })
                      closeMenu()
                    }}
                  >
                    重命名
                  </button>
                  <button
                    onClick={() =>
                      void runAction(async () => {
                        const target = prompt(
                          `移动「${f.path.join(' / ')}」到哪个文件夹下?输入目标文件夹完整路径(留空移为根级):`,
                        )
                        if (target === null) return null
                        const trimmed = target.trim()
                        if (!trimmed) return onMove(f.folderId, null)
                        const dest = folders.find(
                          (x) => x.path.join('/').toLowerCase() === trimmed.toLowerCase(),
                        )
                        if (!dest) return `找不到路径「${trimmed}」`
                        return onMove(f.folderId, dest.folderId)
                      })
                    }
                  >
                    移动到…
                  </button>
                  <button onClick={() => void runAction(() => onSortByName(f.folderId))}>
                    同级按名称排序
                  </button>
                  <button
                    className={styles.danger}
                    onClick={() =>
                      void runAction(async () => {
                        if (row.hasChildren) {
                          return '请先移出子文件夹'
                        }
                        if (f.directCount > 0) {
                          return `文件夹内还有 ${f.directCount} 个皮肤,先移出再删除`
                        }
                        const ok = confirm(`删除空文件夹「${f.name}」?`)
                        if (!ok) return null
                        return onDelete(f.folderId)
                      })
                    }
                  >
                    删除
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
      {creatingUnder !== null && creatingUnder !== 'root' && (
        <div className={styles.inlineForm}>
          <span className={styles.inlineParent}>
            在「{folders.find((f) => f.folderId === creatingUnder)?.path.join(' / ')}」下:
          </span>
          <input
            autoFocus
            value={newName}
            placeholder="子文件夹名称"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitCreate()
              if (e.key === 'Escape') setCreatingUnder(null)
            }}
          />
          <button onClick={() => void submitCreate()}>创建</button>
          <button onClick={() => setCreatingUnder(null)}>取消</button>
        </div>
      )}
      {error && <p className={styles.error}>{error}</p>}
    </div>
  )
}
