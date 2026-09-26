/**
 * 条目详情面板(方案 §4.1 右栏):3D 预览 + 完整元数据。
 *   - 内容 ID 默认展示前 12 位,可复制完整值;条目 ID 放入高级资料
 *   - active 状态开关、协议、作者、出处、备注
 *   - "模型 / 展开图"切换;展开图可打开大图查看器
 */

import { useEffect, useMemo, useState } from 'react'
import type { FolderWithStats, LibraryEntry, TagWithStats } from '../contracts/types.ts'
import { SkinPreview3D } from './SkinPreview3D.tsx'
import styles from '../styles/workspace.module.css'

export interface EntryDetailsProps {
  entry: LibraryEntry
  tags: TagWithStats[]
  folders: FolderWithStats[]
  showOuter: boolean
  walking: boolean
  autoRotate: boolean
  active: boolean
  onToggleOuter: (v: boolean) => void
  onToggleWalking: (v: boolean) => void
  onToggleAutoRotate: (v: boolean) => void
  onEdit: () => void
  onToggleActive: () => void
  onToggleFavorite: () => void
  onCopyId: () => void
  onCopyCode: () => void
  onExportPng: () => void
  onExportHskin: () => void
  onExportPortable: () => void
  onDelete: () => void
  onViewTexture: () => void
  getPreviewUrl: (skinId: string) => Promise<string>
}

export function EntryDetails({
  entry,
  tags,
  folders,
  showOuter,
  walking,
  autoRotate,
  active,
  onToggleOuter,
  onToggleWalking,
  onToggleAutoRotate,
  onEdit,
  onToggleActive,
  onToggleFavorite,
  onCopyId,
  onCopyCode,
  onExportPng,
  onExportHskin,
  onExportPortable,
  onDelete,
  onViewTexture,
  getPreviewUrl,
}: EntryDetailsProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'model' | 'flat'>('model')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const tagById = useMemo(() => new Map(tags.map((t) => [t.tagId, t])), [tags])
  const folderById = useMemo(() => new Map(folders.map((f) => [f.folderId, f])), [folders])

  useEffect(() => {
    let cancelled = false
    void getPreviewUrl(entry.skinId).then((u) => {
      if (!cancelled) setPreviewUrl(u)
    })
    return () => {
      cancelled = true
    }
  }, [entry.skinId, getPreviewUrl])

  const folderLabel =
    entry.folderId === null
      ? '未归档'
      : (folderById.get(entry.folderId)?.path.join(' / ') ?? '')

  const licenseLabel =
    entry.license.status === 'declared' && entry.license.name ? entry.license.name : '未声明'

  const authorLabel = entry.provenance.author ?? '未填写'
  const sourceLabel = entry.provenance.sourceName ?? entry.source.kind

  return (
    <div className={styles.detailsPanel}>
      <header className={styles.detailsHead}>
        <h2 title={entry.name}>{entry.name}</h2>
        <span
          className={`${styles.statusPill} ${entry.active ? styles.statusActive : styles.statusInactive}`}
        >
          {entry.active ? '已启用' : '已禁用'}
        </span>
      </header>

      {previewUrl && (
        <>
          <div className={styles.viewModeToggle} role="tablist" aria-label="预览方式">
            <button
              role="tab"
              aria-selected={viewMode === 'model'}
              className={viewMode === 'model' ? styles.active : ''}
              onClick={() => setViewMode('model')}
            >
              模型
            </button>
            <button
              role="tab"
              aria-selected={viewMode === 'flat'}
              className={viewMode === 'flat' ? styles.active : ''}
              onClick={() => setViewMode('flat')}
            >
              展开图
            </button>
          </div>

          {viewMode === 'model' ? (
            active && (
              <SkinPreview3D
                previewUrl={previewUrl}
                model={entry.model}
                showOuterLayers={showOuter}
                walking={walking}
                autoRotate={autoRotate}
                active={active}
              />
            )
          ) : (
            <div className={styles.flatPreview}>
              <img src={previewUrl} alt={`${entry.name} 展开图`} />
              <button type="button" onClick={onViewTexture} title="放大查看">
                🔍 放大查看
              </button>
            </div>
          )}
        </>
      )}

      <div className={styles.previewControls}>
        <label>
          <input type="checkbox" checked={showOuter} onChange={(e) => onToggleOuter(e.target.checked)} />
          外层
        </label>
        <label>
          <input type="checkbox" checked={walking} onChange={(e) => onToggleWalking(e.target.checked)} />
          行走
        </label>
        <label>
          <input
            type="checkbox"
            checked={autoRotate}
            onChange={(e) => onToggleAutoRotate(e.target.checked)}
          />
          转动
        </label>
      </div>

      <dl className={styles.meta}>
        <dt>内容 ID</dt>
        <dd className={styles.monoId} title={entry.skinId}>
          {entry.skinId.slice(0, 12)}…
          <button className={styles.linkBtn} onClick={onCopyId}>
            复制
          </button>
        </dd>
        <dt>位置</dt>
        <dd>{folderLabel}</dd>
        <dt>模型</dt>
        <dd>{entry.model}</dd>
        <dt>协议</dt>
        <dd>{licenseLabel}</dd>
        <dt>作者</dt>
        <dd>{authorLabel}</dd>
        <dt>来源</dt>
        <dd>{sourceLabel}</dd>
        <dt>导入时间</dt>
        <dd>{new Date(entry.createdAt).toLocaleString()}</dd>
        {entry.note && (
          <>
            <dt>备注</dt>
            <dd className={styles.noteText}>{entry.note}</dd>
          </>
        )}
      </dl>

      <button type="button" className={styles.linkBtn} onClick={() => setShowAdvanced((v) => !v)}>
        {showAdvanced ? '收起高级资料 ▴' : '高级资料 ▾'}
      </button>
      {showAdvanced && (
        <dl className={styles.meta}>
          <dt>条目 ID</dt>
          <dd className={styles.monoId} title={entry.entryId}>
            {entry.entryId.slice(0, 12)}…
          </dd>
          <dt>更新时间</dt>
          <dd>{new Date(entry.updatedAt).toLocaleString()}</dd>
          {entry.provenance.sourceUrl && (
            <>
              <dt>出处链接</dt>
              <dd className={styles.noteText}>
                <a
                  href={entry.provenance.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  {entry.provenance.sourceUrl}
                </a>
              </dd>
            </>
          )}
          {entry.provenance.sourceNote && (
            <>
              <dt>出处说明</dt>
              <dd className={styles.noteText}>{entry.provenance.sourceNote}</dd>
            </>
          )}
          {entry.license.note && (
            <>
              <dt>协议说明</dt>
              <dd className={styles.noteText}>{entry.license.note}</dd>
            </>
          )}
          {entry.provenance.originalCreatedAt && (
            <>
              <dt>原作时间</dt>
              <dd>{entry.provenance.originalCreatedAt}</dd>
            </>
          )}
        </dl>
      )}

      <section className={styles.tagSummary} aria-label="标签">
        <h3>标签</h3>
        {entry.tagIds.length === 0 ? (
          <p className={styles.empty}>(无标签)</p>
        ) : (
          <div className={styles.tagChips}>
            {entry.tagIds.map((id) => (
              <span key={id} className={styles.tagChip}>
                {tagById.get(id)?.name ?? id}
              </span>
            ))}
          </div>
        )}
      </section>

      <div className={styles.actions}>
        <button onClick={onToggleActive}>{entry.active ? '禁用' : '启用'}</button>
        <button onClick={onToggleFavorite}>{entry.favorite ? '取消收藏' : '收藏'}</button>
        <button onClick={onEdit}>编辑资料…</button>
        <button onClick={onCopyCode}>复制字符串</button>
        <button onClick={onExportPng}>导出 PNG</button>
        <button onClick={onExportHskin}>导出 .hskin</button>
        <button onClick={onExportPortable}>导出 .skin.json</button>
        <button className={styles.danger} onClick={onDelete}>
          删除
        </button>
      </div>
    </div>
  )
}
