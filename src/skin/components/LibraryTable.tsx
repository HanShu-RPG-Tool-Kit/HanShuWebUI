/**
 * 纯文本列表模式：不加载缩略图，只显示文字列。
 */

import { useMemo } from 'react'
import type { FolderWithStats, LibraryEntry } from '../contracts/types.ts'
import styles from '../styles/workspace.module.css'

export interface LibraryTableProps {
  entries: LibraryEntry[]
  folders: FolderWithStats[]
  checked: Set<string>
  onToggleChecked: (entryId: string) => void
  onSelect: (entry: LibraryEntry) => void
  onContextMenu: (e: React.MouseEvent, entry: LibraryEntry) => void
  showPath: boolean
}

export function LibraryTable({
  entries,
  folders,
  checked,
  onToggleChecked,
  onSelect,
  onContextMenu,
  showPath,
}: LibraryTableProps) {
  const folderById = useMemo(() => new Map(folders.map((f) => [f.folderId, f])), [folders])

  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString()
    } catch {
      return iso
    }
  }

  const entryPath = (e: LibraryEntry): string => {
    if (e.folderId === null) return '皮肤库'
    return folderById.get(e.folderId)?.path.join(' / ') ?? ''
  }

  const licenseLabel = (e: LibraryEntry): string => {
    if (e.license.status === 'declared' && e.license.name) return e.license.name
    return '未声明'
  }

  const authorLabel = (e: LibraryEntry): string => {
    return e.provenance.author ?? '未填写'
  }

  const sourceLabel = (e: LibraryEntry): string => {
    switch (e.source.kind) {
      case 'png-file':
        return 'PNG 文件'
      case 'png-url':
        return 'URL'
      case 'player-name':
        return '玩家'
      case 'skin-code':
        return '皮肤码'
      case 'skin-file':
        return '便携文件'
      default:
        return ''
    }
  }

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th className={styles.tableCheck}>
              <input
                type="checkbox"
                checked={entries.length > 0 && entries.every((e) => checked.has(e.entryId))}
                onChange={() => {
                  const all = entries.every((e) => checked.has(e.entryId))
                  entries.forEach((e) => {
                    if (all && checked.has(e.entryId)) onToggleChecked(e.entryId)
                    else if (!all && !checked.has(e.entryId)) onToggleChecked(e.entryId)
                  })
                }}
                aria-label="全选"
              />
            </th>
            <th>名称</th>
            <th>状态</th>
            <th>标签</th>
            <th>协议</th>
            <th>作者</th>
            <th>来源</th>
            <th>模型</th>
            {showPath && <th>位置</th>}
            <th>导入时间</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => {
            const isChecked = checked.has(e.entryId)
            const displayTags = e.tags.filter(Boolean)
            const tagText = displayTags.length > 2
              ? `${displayTags.slice(0, 2).join(', ')} +${displayTags.length - 2}`
              : displayTags.join(', ')
            return (
              <tr
                key={e.entryId}
                className={[isChecked ? styles.checked : '', !e.active ? styles.rowInactive : '']
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => onSelect(e)}
                onContextMenu={(ev) => onContextMenu(ev, e)}
              >
                <td className={styles.tableCheck} onClick={(ev) => ev.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => onToggleChecked(e.entryId)}
                    aria-label={`选择 ${e.name}`}
                  />
                </td>
                <td>
                  {e.favorite ? '★ ' : ''}
                  {e.name}
                </td>
                <td>
                  <span
                    className={`${styles.statusPill} ${e.active ? styles.statusActive : styles.statusInactive}`}
                  >
                    {e.active ? '已启用' : '已禁用'}
                  </span>
                </td>
                <td title={displayTags.join(', ')}>{tagText}</td>
                <td>{licenseLabel(e)}</td>
                <td>{authorLabel(e)}</td>
                <td>{sourceLabel(e)}</td>
                <td>{e.model}</td>
                {showPath && <td>{entryPath(e)}</td>}
                <td>{formatDate(e.createdAt)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
