/**
 * 筛选面板：支持正反标签、状态、模型、协议、作者、排序。
 * sidebar 布局用于左侧下半区（可滚动）。
 */

import type { CollectedTag, EntrySortBy, SkinModel, SortDirection } from '../contracts/types.ts'
import { TagPicker } from './TagPicker.tsx'
import styles from '../styles/workspace.module.css'

export interface LibraryFiltersProps {
  tags: CollectedTag[]
  includeTags: string[]
  excludeTags: string[]
  onIncludeTagsChange: (names: string[]) => void
  onExcludeTagsChange: (names: string[]) => void
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
  onClearAll: () => void
  /** Vertical stacked layout for the left sidebar. */
  layout?: 'bar' | 'sidebar'
}

export function LibraryFilters({
  tags,
  includeTags,
  excludeTags,
  onIncludeTagsChange,
  onExcludeTagsChange,
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
  onClearAll,
  layout = 'bar',
}: LibraryFiltersProps) {
  const sidebar = layout === 'sidebar'

  const hasFilters =
    includeTags.length > 0 ||
    excludeTags.length > 0 ||
    activeFilter !== 'all' ||
    modelFilter !== 'all' ||
    licenseFilter.trim() !== '' ||
    authorFilter.trim() !== ''

  return (
    <div
      className={`${styles.filterPanel}${sidebar ? ` ${styles.filterPanelSidebar}` : ''}`}
    >
      <div className={styles.filterRow}>
        <div className={styles.filterField}>
          <span className={styles.filterLabel}>正标签</span>
          <div className={styles.filterControlStack}>
            <TagPicker
              tags={tags}
              selected={includeTags}
              onChange={onIncludeTagsChange}
              placeholder="输入后回车"
            />
            {includeTags.length > 1 && (
              <select
                value={tagMatch}
                onChange={(e) => onTagMatchChange(e.target.value as 'any' | 'all')}
              >
                <option value="all">全部满足</option>
                <option value="any">任一满足</option>
              </select>
            )}
          </div>
        </div>
      </div>

      <div className={styles.filterRow}>
        <div className={styles.filterField}>
          <span className={styles.filterLabel}>负标签</span>
          <TagPicker
            tags={tags}
            selected={excludeTags}
            onChange={onExcludeTagsChange}
            placeholder="输入后回车"
          />
        </div>
      </div>

      <div className={styles.filterRow}>
        <div className={styles.filterField}>
          <span className={styles.filterLabel}>状态</span>
          <div className={styles.segPills} role="group" aria-label="状态筛选">
            <button
              type="button"
              className={`${styles.segPill}${activeFilter === 'active' ? ` ${styles.active}` : ''}`}
              aria-pressed={activeFilter === 'active'}
              onClick={() =>
                onActiveFilterChange(activeFilter === 'active' ? 'all' : 'active')
              }
            >
              启用
            </button>
            <button
              type="button"
              className={`${styles.segPill}${activeFilter === 'inactive' ? ` ${styles.active}` : ''}`}
              aria-pressed={activeFilter === 'inactive'}
              onClick={() =>
                onActiveFilterChange(activeFilter === 'inactive' ? 'all' : 'inactive')
              }
            >
              禁用
            </button>
          </div>
        </div>
      </div>

      <div className={styles.filterRow}>
        <div className={styles.filterField}>
          <span className={styles.filterLabel}>模型</span>
          <div className={styles.segPills} role="group" aria-label="模型筛选">
            <button
              type="button"
              className={`${styles.segPill}${modelFilter === 'classic' ? ` ${styles.active}` : ''}`}
              aria-pressed={modelFilter === 'classic'}
              onClick={() =>
                onModelFilterChange(modelFilter === 'classic' ? 'all' : 'classic')
              }
            >
              classic
            </button>
            <button
              type="button"
              className={`${styles.segPill}${modelFilter === 'slim' ? ` ${styles.active}` : ''}`}
              aria-pressed={modelFilter === 'slim'}
              onClick={() =>
                onModelFilterChange(modelFilter === 'slim' ? 'all' : 'slim')
              }
            >
              slim
            </button>
          </div>
        </div>
      </div>

      <div className={styles.filterRow}>
        <label className={styles.filterField}>
          <span className={styles.filterLabel}>协议</span>
          <input
            type="text"
            placeholder="协议名称"
            value={licenseFilter}
            onChange={(e) => onLicenseFilterChange(e.target.value)}
          />
        </label>
      </div>

      <div className={styles.filterRow}>
        <label className={styles.filterField}>
          <span className={styles.filterLabel}>作者</span>
          <input
            type="text"
            placeholder="作者"
            value={authorFilter}
            onChange={(e) => onAuthorFilterChange(e.target.value)}
          />
        </label>
      </div>

      <div className={styles.filterRow}>
        <label className={styles.filterField}>
          <span className={styles.filterLabel}>排序</span>
          <select
            value={sortBy}
            onChange={(e) => onSortByChange(e.target.value as EntrySortBy)}
          >
            <option value="createdAt">导入时间</option>
            <option value="updatedAt">更新时间</option>
            <option value="name">名称</option>
            <option value="author">作者</option>
          </select>
        </label>
        <label className={styles.filterField}>
          <span className={styles.filterLabel}>方向</span>
          <select
            value={sortDirection}
            onChange={(e) => onSortDirectionChange(e.target.value as SortDirection)}
          >
            <option value="desc">降序</option>
            <option value="asc">升序</option>
          </select>
        </label>
        {hasFilters && (
          <button type="button" className={styles.linkBtn} onClick={onClearAll}>
            清空全部筛选
          </button>
        )}
      </div>
    </div>
  )
}
