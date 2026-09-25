/**
 * 平铺标签选择器:搜索框 + 已选块 + 平铺候选列表。
 * 输入不存在的名称时提供「新建标签:XXX」。
 */

import { useMemo, useState } from 'react'
import type { TagWithStats } from '../contracts/types.ts'
import styles from '../styles/workspace.module.css'

export interface TagPickerProps {
  tags: TagWithStats[]
  selected: string[]
  onChange: (tagIds: string[]) => void
  /** Create a flat tag; resolves to an error string or null. */
  onCreate?: (name: string, parentId: string | null) => Promise<string | null>
  disabled?: boolean
}

export function TagPicker({ tags, selected, onChange, onCreate, disabled }: TagPickerProps) {
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<string | null>(null)

  const byId = useMemo(() => new Map(tags.map((t) => [t.tagId, t])), [tags])

  const candidates = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const list = needle
      ? tags.filter((t) => t.name.toLowerCase().includes(needle))
      : tags.slice()
    list.sort((a, b) => {
      const asel = selected.includes(a.tagId) ? 0 : 1
      const bsel = selected.includes(b.tagId) ? 0 : 1
      if (asel !== bsel) return asel - bsel
      return a.name.localeCompare(b.name, 'zh-Hans-CN')
    })
    return list
  }, [tags, filter, selected])

  const toggleTag = (tagId: string) => {
    if (disabled) return
    if (selected.includes(tagId)) {
      onChange(selected.filter((id) => id !== tagId))
    } else {
      onChange([...selected, tagId])
    }
  }

  const tagName = (tagId: string): string => byId.get(tagId)?.name ?? tagId

  const exactMatch = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return null
    return tags.find((t) => t.name.toLowerCase() === needle) ?? null
  }, [tags, filter])

  const createAndUse = async () => {
    if (!onCreate) return
    const name = filter.trim()
    if (!name) return
    const err = await onCreate(name, null)
    if (err) {
      setError(err)
      return
    }
    setFilter('')
    setError(null)
  }

  return (
    <div className={styles.tagPicker}>
      <input
        type="search"
        placeholder="搜索标签…"
        value={filter}
        disabled={disabled}
        onChange={(e) => setFilter(e.target.value)}
        aria-label="搜索标签"
      />
      {selected.length > 0 && (
        <div className={styles.tagChips} aria-label="已选标签">
          {selected.map((id) => (
            <span key={id} className={styles.tagChip}>
              {tagName(id)}
              <button
                type="button"
                aria-label={`移除 ${tagName(id)}`}
                disabled={disabled}
                onClick={() => toggleTag(id)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className={styles.tagPickerList} aria-label="可选标签">
        {candidates.map((t) => {
          const checked = selected.includes(t.tagId)
          return (
            <div key={t.tagId} className={styles.tagPickerRow}>
              <label className={checked ? styles.checked : ''}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => toggleTag(t.tagId)}
                />
                <span className={styles.tagName}>{t.name}</span>
                {t.directCount > 0 && (
                  <span className={styles.tagCountHint}>({t.directCount})</span>
                )}
              </label>
            </div>
          )
        })}
        {candidates.length === 0 && filter.trim() && (
          <p className={styles.empty}>没有匹配的标签</p>
        )}
        {candidates.length === 0 && !filter.trim() && tags.length === 0 && (
          <p className={styles.empty}>还没有标签</p>
        )}
      </div>
      {filter.trim() && !exactMatch && onCreate && !disabled && (
        <div className={styles.tagPickerCreate}>
          <button type="button" onClick={() => void createAndUse()}>
            新建标签:「{filter.trim()}」
          </button>
        </div>
      )}
      {error && <p className={styles.error}>{error}</p>}
    </div>
  )
}
