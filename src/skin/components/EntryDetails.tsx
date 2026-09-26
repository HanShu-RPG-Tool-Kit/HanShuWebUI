/**
 * 右侧详情栏：预览 + 就地编辑元数据（名称/位置/模型/标签/协议/作者等）。
 * 字段变更即保存，不再另开「编辑资料」对话框。
 */

import { useEffect, useRef, useState } from 'react'
import type {
  CollectedTag,
  FolderWithStats,
  LibraryEntry,
  PatchEntryRequest,
  SkinModel,
} from '../contracts/types.ts'
import { SkinPreview3D } from './SkinPreview3D.tsx'
import { TagPicker } from './TagPicker.tsx'
import styles from '../styles/workspace.module.css'

export interface EntryDetailsProps {
  entry: LibraryEntry
  folders: FolderWithStats[]
  tags: CollectedTag[]
  showOuter: boolean
  walking: boolean
  autoRotate: boolean
  active: boolean
  onToggleOuter: (v: boolean) => void
  onToggleWalking: (v: boolean) => void
  onToggleAutoRotate: (v: boolean) => void
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
  onPatch: (entryId: string, body: PatchEntryRequest) => Promise<LibraryEntry>
  onUpdated: (updated: LibraryEntry) => void
}

type Draft = {
  name: string
  folderId: string | null
  model: SkinModel
  tags: string[]
  licenseStatus: 'unspecified' | 'declared'
  licenseName: string
  licenseUrl: string
  licenseNote: string
  author: string
  sourceName: string
  sourceUrl: string
  sourceNote: string
  note: string
}

function draftFromEntry(entry: LibraryEntry): Draft {
  return {
    name: entry.name,
    folderId: entry.folderId,
    model: entry.model,
    tags: [...entry.tags],
    licenseStatus: entry.license.status,
    licenseName: entry.license.name ?? '',
    licenseUrl: entry.license.url ?? '',
    licenseNote: entry.license.note ?? '',
    author: entry.provenance.author ?? '',
    sourceName: entry.provenance.sourceName ?? '',
    sourceUrl: entry.provenance.sourceUrl ?? '',
    sourceNote: entry.provenance.sourceNote ?? '',
    note: entry.note,
  }
}

export function EntryDetails({
  entry,
  folders,
  tags,
  showOuter,
  walking,
  autoRotate,
  active,
  onToggleOuter,
  onToggleWalking,
  onToggleAutoRotate,
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
  onPatch,
  onUpdated,
}: EntryDetailsProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'model' | 'flat'>('model')
  const [editingName, setEditingName] = useState(false)
  const [draft, setDraft] = useState<Draft>(() => draftFromEntry(entry))
  const [revision, setRevision] = useState(entry.revision)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const entryIdRef = useRef(entry.entryId)
  const revisionRef = useRef(entry.revision)
  const saveSeq = useRef(0)
  const nameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    void getPreviewUrl(entry.skinId).then((u) => {
      if (!cancelled) setPreviewUrl(u)
    })
    return () => {
      cancelled = true
    }
  }, [entry.skinId, getPreviewUrl])

  useEffect(() => {
    if (entry.entryId !== entryIdRef.current || entry.revision !== revisionRef.current) {
      entryIdRef.current = entry.entryId
      revisionRef.current = entry.revision
      setDraft(draftFromEntry(entry))
      setRevision(entry.revision)
      setError(null)
      setEditingName(false)
    }
  }, [entry])

  useEffect(() => {
    if (!editingName) return
    const el = nameInputRef.current
    if (!el) return
    el.focus()
    el.select()
  }, [editingName])

  const commitName = () => {
    const name = draft.name.trim() || entry.name
    setEditingName(false)
    if (name === entry.name) {
      setDraft((d) => ({ ...d, name: entry.name }))
      return
    }
    void applyPatch({ name })
  }

  const applyPatch = async (body: Omit<PatchEntryRequest, 'revision'>) => {
    const targetId = entry.entryId
    const seq = ++saveSeq.current
    setSaving(true)
    setError(null)
    try {
      const updated = await onPatch(targetId, {
        revision: revisionRef.current,
        ...body,
      })
      if (seq !== saveSeq.current || entryIdRef.current !== targetId) return
      revisionRef.current = updated.revision
      setRevision(updated.revision)
      setDraft(draftFromEntry(updated))
      onUpdated(updated)
    } catch (e) {
      if (seq !== saveSeq.current || entryIdRef.current !== targetId) return
      setError((e as Error).message)
    } finally {
      if (seq === saveSeq.current) setSaving(false)
    }
  }

  const patchLicense = (next: Partial<Draft>) => {
    const d = { ...draft, ...next }
    setDraft(d)
    void applyPatch({
      license: {
        status: d.licenseStatus,
        name: d.licenseStatus === 'declared' ? d.licenseName.trim() || null : null,
        url: d.licenseStatus === 'declared' ? d.licenseUrl.trim() || null : null,
        note: d.licenseNote.trim() || null,
      },
    })
  }

  const patchProvenance = (next: Partial<Draft>) => {
    const d = { ...draft, ...next }
    setDraft(d)
    void applyPatch({
      provenance: {
        author: d.author.trim() || null,
        sourceName: d.sourceName.trim() || null,
        sourceUrl: d.sourceUrl.trim() || null,
        sourceNote: d.sourceNote.trim() || null,
        originalCreatedAt: entry.provenance.originalCreatedAt,
      },
    })
  }

  return (
    <div className={styles.detailsPanel}>
      <div className={styles.detailsTop}>
        <header className={styles.detailsHead}>
          {editingName ? (
            <input
              ref={nameInputRef}
              className={styles.detailsNameInput}
              value={draft.name}
              aria-label="名称"
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitName()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setDraft((d) => ({ ...d, name: entry.name }))
                  setEditingName(false)
                }
              }}
            />
          ) : (
            <button
              type="button"
              className={styles.detailsNameBtn}
              title="点击编辑名称"
              onClick={() => setEditingName(true)}
            >
              {draft.name || entry.name}
            </button>
          )}
          <div className={styles.detailsHeadActions}>
            <button
              type="button"
              className={`${styles.statusPill} ${entry.active ? styles.statusActive : styles.statusInactive}`}
              onClick={onToggleActive}
              title={entry.active ? '已启用，点击禁用' : '已禁用，点击启用'}
              aria-pressed={entry.active}
            >
              {entry.active ? '已启用' : '已禁用'}
            </button>
            <button
              type="button"
              className={`${styles.favoriteBtn}${entry.favorite ? ` ${styles.favoriteOn}` : ''}`}
              onClick={onToggleFavorite}
              title={entry.favorite ? '取消收藏' : '收藏'}
              aria-pressed={entry.favorite}
              aria-label={entry.favorite ? '已收藏' : '未收藏'}
            >
              {entry.favorite ? '★' : '☆'}
            </button>
          </div>
        </header>

        {previewUrl && (
          <div className={styles.previewStage}>
            <div
              className={styles.previewLayer}
              hidden={viewMode !== 'model'}
              aria-hidden={viewMode !== 'model'}
            >
              {active && (
                <SkinPreview3D
                  previewUrl={previewUrl}
                  model={draft.model}
                  showOuterLayers={showOuter}
                  walking={walking}
                  autoRotate={autoRotate}
                  active={active && viewMode === 'model'}
                  viewMode={viewMode}
                  onViewModeChange={setViewMode}
                  onToggleOuter={onToggleOuter}
                  onToggleWalking={onToggleWalking}
                  onToggleAutoRotate={onToggleAutoRotate}
                />
              )}
            </div>
            <div
              className={styles.previewLayer}
              hidden={viewMode !== 'flat'}
              aria-hidden={viewMode !== 'flat'}
            >
              <div className={styles.flatPreview}>
                <img src={previewUrl} alt={`${draft.name} 展开图`} />
                <div className={styles.previewHoverBar}>
                  <div className={styles.previewModeSeg} role="tablist" aria-label="预览方式">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={viewMode === 'model'}
                      className={viewMode === 'model' ? styles.active : undefined}
                      onClick={() => setViewMode('model')}
                    >
                      模型
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={viewMode === 'flat'}
                      className={viewMode === 'flat' ? styles.active : undefined}
                      onClick={() => setViewMode('flat')}
                    >
                      展开图
                    </button>
                  </div>
                  <div className={styles.previewHoverRight}>
                    <button
                      type="button"
                      className={styles.previewReset}
                      onClick={onViewTexture}
                      title="放大查看"
                    >
                      放大查看
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className={styles.detailsScroll}>
        <div className={styles.detailsFields}>
          <label className={styles.detailsField}>
            <span>位置</span>
            <select
              value={draft.folderId ?? ''}
              onChange={(e) => {
                const folderId = e.target.value || null
                setDraft((d) => ({ ...d, folderId }))
                void applyPatch({ folderId })
              }}
            >
              <option value="">皮肤库</option>
              {folders.map((f) => (
                <option key={f.folderId} value={f.folderId}>
                  {f.path.join(' / ')}
                </option>
              ))}
            </select>
          </label>

          <div className={styles.detailsField}>
            <span>模型</span>
            <div className={styles.segBinary} role="group" aria-label="模型">
              <button
                type="button"
                className={draft.model === 'classic' ? styles.active : undefined}
                onClick={() => {
                  if (draft.model === 'classic') return
                  setDraft((d) => ({ ...d, model: 'classic' }))
                  void applyPatch({ model: 'classic' })
                }}
              >
                classic
              </button>
              <button
                type="button"
                className={draft.model === 'slim' ? styles.active : undefined}
                onClick={() => {
                  if (draft.model === 'slim') return
                  setDraft((d) => ({ ...d, model: 'slim' }))
                  void applyPatch({ model: 'slim' })
                }}
              >
                slim
              </button>
            </div>
          </div>

          <div className={styles.detailsField}>
            <span>标签</span>
            <TagPicker
              tags={tags}
              selected={draft.tags}
              onChange={(next) => {
                setDraft((d) => ({ ...d, tags: next }))
                void applyPatch({ tags: next })
              }}
            />
          </div>

          <label className={styles.detailsField}>
            <span>协议</span>
            <select
              value={draft.licenseStatus}
              onChange={(e) =>
                patchLicense({
                  licenseStatus: e.target.value as 'unspecified' | 'declared',
                })
              }
            >
              <option value="unspecified">未声明</option>
              <option value="declared">已声明</option>
            </select>
          </label>

          {draft.licenseStatus === 'declared' && (
            <>
              <label className={styles.detailsField}>
                <span>协议名称</span>
                <input
                  value={draft.licenseName}
                  placeholder="如 MIT、CC BY 4.0"
                  onChange={(e) => setDraft((d) => ({ ...d, licenseName: e.target.value }))}
                  onBlur={() => patchLicense({})}
                />
              </label>
              <label className={styles.detailsField}>
                <span>协议链接</span>
                <input
                  value={draft.licenseUrl}
                  placeholder="https://…"
                  onChange={(e) => setDraft((d) => ({ ...d, licenseUrl: e.target.value }))}
                  onBlur={() => patchLicense({})}
                />
              </label>
            </>
          )}

          <label className={styles.detailsField}>
            <span>作者</span>
            <input
              value={draft.author}
              onChange={(e) => setDraft((d) => ({ ...d, author: e.target.value }))}
              onBlur={() => patchProvenance({})}
            />
          </label>

          <label className={styles.detailsField}>
            <span>备注</span>
            <textarea
              rows={3}
              value={draft.note}
              onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
              onBlur={() => {
                const note = draft.note.trim()
                if (note === entry.note) return
                void applyPatch({ note })
              }}
            />
          </label>

          <div className={styles.detailsReadonly}>
            <span>内容 ID</span>
            <span className={styles.monoId} title={entry.skinId}>
              {entry.skinId.slice(0, 12)}…
              <button type="button" className={styles.linkBtn} onClick={onCopyId}>
                复制
              </button>
            </span>
          </div>
          <div className={styles.detailsReadonly}>
            <span>导入时间</span>
            <span>{new Date(entry.createdAt).toLocaleString()}</span>
          </div>

          <label className={styles.detailsField}>
            <span>出处名称</span>
            <input
              value={draft.sourceName}
              placeholder="原作品页面/站点名称"
              onChange={(e) => setDraft((d) => ({ ...d, sourceName: e.target.value }))}
              onBlur={() => patchProvenance({})}
            />
          </label>
          <label className={styles.detailsField}>
            <span>出处链接</span>
            <input
              value={draft.sourceUrl}
              placeholder="https://…"
              onChange={(e) => setDraft((d) => ({ ...d, sourceUrl: e.target.value }))}
              onBlur={() => patchProvenance({})}
            />
          </label>
          <label className={styles.detailsField}>
            <span>出处说明</span>
            <textarea
              rows={2}
              value={draft.sourceNote}
              onChange={(e) => setDraft((d) => ({ ...d, sourceNote: e.target.value }))}
              onBlur={() => patchProvenance({})}
            />
          </label>
          <label className={styles.detailsField}>
            <span>协议说明</span>
            <textarea
              rows={2}
              value={draft.licenseNote}
              onChange={(e) => setDraft((d) => ({ ...d, licenseNote: e.target.value }))}
              onBlur={() => patchLicense({})}
            />
          </label>
          <div className={styles.detailsReadonly}>
            <span>条目 ID</span>
            <span className={styles.monoId} title={entry.entryId}>
              {entry.entryId.slice(0, 12)}…
            </span>
          </div>
          <div className={styles.detailsReadonly}>
            <span>更新时间</span>
            <span>{new Date(entry.updatedAt).toLocaleString()}</span>
          </div>
          {entry.provenance.originalCreatedAt && (
            <div className={styles.detailsReadonly}>
              <span>原作时间</span>
              <span>{entry.provenance.originalCreatedAt}</span>
            </div>
          )}
        </div>

        {error && <p className={styles.error}>{error}</p>}
        {saving && !error && <p className={styles.notice}>保存中…</p>}

        <div className={styles.actions}>
          <button type="button" onClick={onCopyCode}>
            复制字符串
          </button>
          <button type="button" onClick={onExportPng}>
            导出 PNG
          </button>
          <button type="button" onClick={onExportHskin}>
            导出 .hskin
          </button>
          <button type="button" onClick={onExportPortable}>
            导出 .skin.json
          </button>
          <button type="button" className={styles.danger} onClick={onDelete}>
            删除
          </button>
        </div>
      </div>
    </div>
  )
}
