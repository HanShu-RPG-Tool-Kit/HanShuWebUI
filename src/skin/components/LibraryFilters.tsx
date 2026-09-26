/**
 * 筛选面板：支持正反标签、状态、模型、协议、作者、时间范围。
 */

import { useMemo, useState } from 'react'
import type { EntrySortBy, SkinModel, SortDirection, TagWithStats } from '../contracts/types.ts'
import { TagPicker } from './TagPicker.tsx'
import styles from '../styles/workspace.module.css'

export interface LibraryFiltersProps {
  tags: TagWithStats[]
  includeTagIds: string[]
  excludeTagIds: string[]
  onIncludeTagIdsChange: (ids: string[]) => void
  onExcludeTagIdsChange: (ids: string[]) => void
  tagMatch: 'any' | 'all'
  onTagMatchChange: (m: 'any' | 'all') => void
  activeFilter: 'all' | 'active' | 'inactive'
  onActiveFilterChange: (v: 'all' | 'active' | 'inactive') => void
  modelFilter: SkinModel | 'all'
  onModelFilterChange: (m: SkinModel | 'all') => void
  licenseFilter: string
  onLicenseFilterChange: (v: string) => void
  authorFilter: string
  onAuthorFilterChange: (v: string) => void
  sortBy: EntrySortBy
  onSortByChange: (s: EntrySortBy) => void
  sortDirection: SortDirection
  onSortDirectionChange: (d: SortDirection) => void
  createTag: (name: string, parentId: string | null) => Promise<string | null>
  onClearAll: () => void
}

export function LibraryFilters({
  tags,
  includeTagIds,
  excludeTagIds,
  onIncludeTagIdsChange,
  onExcludeTagIdsChange,
  tagMatch,
  onTagMatchChange,
  activeFilter,
  onActiveFilterChange,
  modelFilter,
  onModelFilterChange,
  licenseFilter,
  onLicenseFilterChange,
  authorFilter,
  onAuthorFilterChange,
  sortBy,
  onSortByChange,
  sortDirection,
  onSortDirectionChange,
  createTag,
  onClearAll,
}: LibraryFiltersProps) {
  const [showInclude, setShowInclude] = useState(false)
  const [showExclude, setShowExclude] = useState(false)
  const tagById = useMemo(() => new Map(tags.map((t) => [t.tagId, t])), [tags])

  const hasFilters =
    includeTagIds.length > 0 ||
    excludeTagIds.length > 0 ||
    activeFilter !== 'all' ||
    modelFilter !== 'all' ||
    licenseFilter.trim() !== '' ||
    authorFilter.trim() !== ''

  return (
    <div className={styles.filterPanel}>
      <div className={styles.filterRow}>
        <span className={styles.filterLabel}>包含标签:</span>
        {includeTagIds.map((id) => (
          <span key={id} className={styles.tagChip}>
            {tagById.get(id)?.name ?? id}
            <button
              type="button"
              aria-label="移除"
              onClick={() => onIncludeTagIdsChange(includeTagIds.filter((x) => x !== id))}
            >
              ×
            </button>
          </span>
        ))}
        <button type="button" className={styles.linkBtn} onClick={() => setShowInclude((v) => !v)}>
          {showInclude ? '收起 ▴' : '选择…'}
        </button>
        {includeTagIds.length > 1 && (
          <select value={tagMatch} onChange={(e) => onTagMatchChange(e.target.value as 'any' | 'all')}>
            <option value="all">全部满足</option>
            <option value="any">任一满足</option>
          </select>
        )}
      </div>
      {showInclude && (
        <div className={styles.filterPop}>
          <TagPicker
            tags={tags}
            selected={includeTagIds}
            onChange={onIncludeTagIdsChange}
            onCreate={createTag}
          />
        </div>
      )}

      <div className={styles.filterRow}>
        <span className={styles.filterLabel}>排除标签:</span>
        {excludeTagIds.map((id) => (
          <span key={id} className={styles.tagChip}>
            {tagById.get(id)?.name ?? id}
            <button
              type="button"
              aria-label="移除"
              onClick={() => onExcludeTagIdsChange(excludeTagIds.filter((x) => x !== id))}
            >
              ×
            </button>
          </span>
        ))}
        <button type="button" className={styles.linkBtn} onClick={() => setShowExclude((v) => !v)}>
          {showExclude ? '收起 ▴' : '选择…'}
        </button>
      </div>
      {showExclude && (
        <div className={styles.filterPop}>
          <TagPicker
            tags={tags}
            selected={excludeTagIds}
            onChange={onExcludeTagIdsChange}
            onCreate={createTag}
          />
        </div>
      )}

      <div className={styles.filterRow}>
        <span className={styles.filterLabel}>状态:</span>
        <select value={activeFilter} onChange={(e) => onActiveFilterChange(e.target.value as 'all' | 'active' | 'inactive')}>
          <option value="all">全部</option>
          <option value="active">已启用</option>
          <option value="inactive">已禁用</option>
        </select>

        <span className={styles.filterLabel}>模型:</span>
        <select value={modelFilter} onChange={(e) => onModelFilterChange(e.target.value as SkinModel | 'all')}>
          <option value="all">全部</option>
          <option value="classic">classic</option>
          <option value="slim">slim</option>
        </select>

        <span className={styles.filterLabel}>协议:</span>
        <input
          type="text"
          placeholder="协议名称"
          value={licenseFilter}
          onChange={(e) => onLicenseFilterChange(e.target.value)}
        />

        <span className={styles.filterLabel}>作者:</span>
        <input
          type="text"
          placeholder="作者"
          value={authorFilter}
          onChange={(e) => onAuthorFilterChange(e.target.value)}
        />
      </div>

      <div className={styles.filterRow}>
        <span className={styles.filterLabel}>排序:</span>
        <select value={sortBy} onChange={(e) => onSortByChange(e.target.value as EntrySortBy)}>
          <option value="createdAt">导入时间</option>
          <option value="updatedAt">更新时间</option>
          <option value="name">名称</option>
          <option value="author">作者</option>
        </select>
        <select value={sortDirection} onChange={(e) => onSortDirectionChange(e.target.value as SortDirection)}>
          <option value="desc">降序</option>
          <option value="asc">升序</option>
        </select>

        {hasFilters && (
          <button type="button" className={styles.linkBtn} onClick={onClearAll}>
            清空全部筛选
          </button>
        )}
      </div>
    </div>
  )
}
