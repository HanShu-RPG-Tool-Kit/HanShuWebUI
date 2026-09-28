/**
 * 左侧筛选：可枚举标签/分辨率做成按钮云；状态、模型、协议、作者、排序。
 */

import type {
  CollectedTag,
  CollectedTextureSize,
  EntrySortBy,
  SkinModel,
  SortDirection,
} from '../contracts/types.ts'
import styles from '../styles/workspace.module.css'

export interface LibraryFiltersProps {
  tags: CollectedTag[]
  textureSizes: CollectedTextureSize[]
  /** Selected freeform tag names (multi, OR). */
  selectedTags: string[]
  onSelectedTagsChange: (names: string[]) => void
  activeFilter: 'all' | 'active' | 'inactive'
  onActiveFilterChange: (v: 'all' | 'active' | 'inactive') => void
  modelFilter: SkinModel | 'all'
  onModelFilterChange: (m: SkinModel | 'all') => void
  textureWidthFilter: number[]
  onTextureWidthFilterChange: (widths: number[]) => void
  licenseFilter: string
  onLicenseFilterChange: (v: string) => void
  authorFilter: string
  onAuthorFilterChange: (v: string) => void
  sortBy: EntrySortBy
  onSortByChange: (s: EntrySortBy) => void
  sortDirection: SortDirection
  onSortDirectionChange: (d: SortDirection) => void
  onClearAll: () => void
  layout?: 'bar' | 'sidebar'
}

function toggleInList<T>(list: T[], value: T, eq: (a: T, b: T) => boolean = (a, b) => a === b): T[] {
  const i = list.findIndex((x) => eq(x, value))
  if (i >= 0) return list.filter((_, idx) => idx !== i)
  return [...list, value]
}

export function LibraryFilters({
  tags,
  textureSizes,
  selectedTags,
  onSelectedTagsChange,
  activeFilter,
  onActiveFilterChange,
  modelFilter,
  onModelFilterChange,
  textureWidthFilter,
  onTextureWidthFilterChange,
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

  const hasFacetSelection =
    selectedTags.length > 0 || textureWidthFilter.length > 0
  const hasFilters =
    hasFacetSelection ||
    activeFilter !== 'all' ||
    modelFilter !== 'all' ||
    licenseFilter.trim() !== '' ||
    authorFilter.trim() !== ''

  const emptyFacets = tags.length === 0 && textureSizes.length === 0

  return (
    <div
      className={`${styles.filterPanel}${sidebar ? ` ${styles.filterPanelSidebar}` : ''}`}
    >
      <section className={styles.filterFacetSection} aria-label="标签与分辨率">
        <div className={styles.filterFacetHead}>
          <span className={styles.filterSectionTitle}>标签</span>
          {hasFacetSelection && (
            <button
              type="button"
              className={styles.linkBtn}
              onClick={() => {
                onSelectedTagsChange([])
                onTextureWidthFilterChange([])
              }}
            >
              清除选中
            </button>
          )}
        </div>
        <div className={styles.filterChipScroll}>
          {emptyFacets ? (
            <p className={styles.filterChipEmpty}>导入皮肤后，标签与分辨率会出现在这里</p>
          ) : (
            <>
              {textureSizes.length > 0 && (
                <div className={styles.filterChipGroup}>
                  <div className={styles.filterChipGroupLabel}>分辨率</div>
                  <div className={styles.filterChipCloud} role="group" aria-label="分辨率">
                    {textureSizes.map((s) => {
                      const on = textureWidthFilter.includes(s.width)
                      return (
                        <button
                          key={`res-${s.width}`}
                          type="button"
                          className={`${styles.filterChip}${on ? ` ${styles.active}` : ''} ${styles.filterChipRes}`}
                          aria-pressed={on}
                          title={`${s.count} 个`}
                          onClick={() =>
                            onTextureWidthFilterChange(
                              toggleInList(textureWidthFilter, s.width).sort(
                                (a, b) => a - b,
                              ),
                            )
                          }
                        >
                          <span>
                            {s.width}×{s.height}
                          </span>
                          <span className={styles.filterChipCount}>{s.count}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
              {tags.length > 0 && (
                <div className={styles.filterChipGroup}>
                  {textureSizes.length > 0 && (
                    <div className={styles.filterChipGroupLabel}>自由标签</div>
                  )}
                  <div className={styles.filterChipCloud} role="group" aria-label="标签">
                    {tags.map((t) => {
                      const on = selectedTags.some(
                        (x) => x.toLowerCase() === t.name.toLowerCase(),
                      )
                      return (
                        <button
                          key={t.name}
                          type="button"
                          className={`${styles.filterChip}${on ? ` ${styles.active}` : ''}`}
                          aria-pressed={on}
                          title={`${t.count} 个`}
                          onClick={() => {
                            const next = on
                              ? selectedTags.filter(
                                  (x) => x.toLowerCase() !== t.name.toLowerCase(),
                                )
                              : [...selectedTags, t.name]
                            onSelectedTagsChange(next)
                          }}
                        >
                          <span>{t.name}</span>
                          <span className={styles.filterChipCount}>{t.count}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </section>

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
