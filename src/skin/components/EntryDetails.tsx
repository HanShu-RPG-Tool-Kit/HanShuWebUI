/**
 * 右侧详情栏：预览 + 就地编辑元数据（名称/位置/模型/标签/协议/作者等）。
 * 字段变更即保存，不再另开「编辑资料」对话框。
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type {
  CollectedTag,
  FolderWithStats,
  LibraryEntry,
  PatchEntryRequest,
} from '../contracts/types.ts'
import { getProjectClient, type ProjectClient } from '../../project/serviceClient'
import { useFileEditing } from '../../project/useFileEditing'
import { entryDraftDirty, entryDraftSession, type EntryDraft as Draft } from '../local/entryDraft'
import { discardEntrySubmission, entrySubmissionState } from '../local/entrySubmission'
import { SkinPreview3D } from './SkinPreview3D.tsx'
import { TagPicker } from './TagPicker.tsx'
import styles from '../styles/workspace.module.css'

export interface EntryDetailsProps {
  client: ProjectClient
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
  onDirtyChange?: (entryId: string, dirty: boolean) => void
  onInteract?: () => void
}

export function EntryDetails({
  client,
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
  onDirtyChange,
  onInteract,
}: EntryDetailsProps) {
  useFileEditing(client)
  const readOnly = client.snapshot.role === 'viewer'
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'model' | 'flat'>('model')
  const [editingName, setEditingName] = useState(false)
  const scope = JSON.stringify([client.connection.url, client.snapshot.projectId, client.snapshot.session.subjectId])
  const session = entryDraftSession(scope, entry)
  session.bind(body => {
    if (getProjectClient() !== client) return Promise.reject(new Error('工程连接已切换，修改保留在原工程的本窗口草稿中。'))
    if (client.snapshot.role === 'viewer') return Promise.reject(new Error('当前主体为只读访问，已有草稿保留在本窗口。'))
    return onPatch(entry.entryId, body)
  })
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  const transactions = useSyncExternalStore(client.transactions.subscribe, client.transactions.getSnapshot, client.transactions.getSnapshot)
  const { draft, error, saving } = state
  const setDraft = (update: Draft | ((draft: Draft) => Draft)) => session.edit(update)
  const submission = entrySubmissionState(client, entry.entryId)
  const transaction = submission.transaction
  const uncertain = transaction?.phase === 'uncertain'
  const busy = saving || transaction?.phase === 'preparing' || transaction?.phase === 'submitting'
  const unresolved = transaction && ['failed', 'conflict', 'uncertain'].includes(transaction.phase)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const dirty = entryDraftDirty(state)

  useEffect(() => { onDirtyChange?.(entry.entryId, dirty) }, [entry.entryId, dirty, onDirtyChange])

  useEffect(() => {
    let cancelled = false
    void getPreviewUrl(entry.skinId).then((u) => {
      if (!cancelled) { setPreviewUrl(u); setPreviewError(null) }
    }).catch(error => {
      if (!cancelled) { setPreviewUrl(null); setPreviewError(error instanceof Error ? error.message : String(error)) }
    })
    return () => {
      cancelled = true
    }
  }, [entry.skinId, getPreviewUrl])

  useEffect(() => { session.observe(entry) }, [session, entry])
  useEffect(() => {
    const latest = entrySubmissionState(client, entry.entryId)
    if (latest.result && latest.command) session.confirm(latest.command.expectedRevision, latest.command.changes, latest.result)
  }, [client, session, entry.entryId, transactions])
  useEffect(() => { if (state.saved && state.saved.revision > entry.revision) onUpdated(state.saved) }, [state.saved, entry.revision, onUpdated])

  useEffect(() => {
    if (!editingName) return
    const el = nameInputRef.current
    if (!el) return
    el.focus()
    el.select()
  }, [editingName])

  const commitName = () => {
    const name = session.getSnapshot().draft.name.trim() || state.base.name
    setEditingName(false)
    setDraft((d) => ({ ...d, name }))
    void applyPatch({ name })
  }

  const applyPatch = (body: Omit<PatchEntryRequest, 'revision' | 'resolvePending'>) => session.request(body)
  const adoptRemote = async () => {
    try { await discardEntrySubmission(client, entry.entryId); session.adoptRemote(); setEditingName(false) }
    catch (e) { session.setError(e) }
  }
  const retryOriginal = async () => {
    if (!transaction) return
    try {
      if (uncertain) await client.transactions.confirm(transaction.id)
      else await client.transactions.retry(transaction.id)
    } catch (e) { session.setError(e) }
  }
  const resubmit = async () => {
    if (uncertain || busy) return
    try {
      // A user who reverted every field still needs to resolve the old failed record.
      if (!entryDraftDirty(session.getSnapshot())) {
        await discardEntrySubmission(client, entry.entryId)
        session.adoptRemote()
      } else session.resubmit()
    } catch (e) { session.setError(e) }
  }
  const exportDraft = () => {
    const current = session.getSnapshot()
    const url = URL.createObjectURL(new Blob([JSON.stringify({ entryId: entry.entryId, base: current.base, draft: current.draft }, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url; link.download = `${current.draft.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 64) || 'skin'}.draft.json`
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const patchLicense = (next: Partial<Draft>) => {
    const d = { ...session.getSnapshot().draft, ...next }
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
    const d = { ...session.getSnapshot().draft, ...next }
    setDraft(d)
    void applyPatch({
      provenance: {
        author: d.author.trim() || null,
        sourceName: d.sourceName.trim() || null,
        sourceUrl: d.sourceUrl.trim() || null,
        sourceNote: d.sourceNote.trim() || null,
        originalCreatedAt: state.base.provenance.originalCreatedAt,
      },
    })
  }

  return (
    <div className={styles.detailsPanel} onFocusCapture={onInteract} onPointerDownCapture={onInteract}>
      <div className={styles.detailsTop}>
        <header className={styles.detailsHead}>
          {editingName ? (
            <input
              disabled={readOnly}
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
                  setDraft((d) => ({ ...d, name: state.base.name }))
                  setEditingName(false)
                }
              }}
            />
          ) : (
            <button
              type="button"
              className={styles.detailsNameBtn}
              disabled={readOnly}
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
              disabled={readOnly}
              onClick={onToggleActive}
              title={entry.active ? '已启用，点击禁用' : '已禁用，点击启用'}
              aria-pressed={entry.active}
            >
              {entry.active ? '已启用' : '已禁用'}
            </button>
            <button
              type="button"
              className={`${styles.favoriteBtn}${entry.favorite ? ` ${styles.favoriteOn}` : ''}`}
              disabled={readOnly}
              onClick={onToggleFavorite}
              title={entry.favorite ? '取消收藏' : '收藏'}
              aria-pressed={entry.favorite}
              aria-label={entry.favorite ? '已收藏' : '未收藏'}
            >
              {entry.favorite ? '★' : '☆'}
            </button>
          </div>
        </header>
        {previewError && <p className={styles.notice}>预览暂时不可用：{previewError}</p>}

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
        {(state.remote || state.pending || entryDraftDirty(state) || state.storageError) && (
          <div className={styles.draftStatus} role="status">
            <p>{uncertain ? '提交结果尚未确认，本地输入已保留。请先查询原提交结果。'
              : state.remote ? '远端已有更新，本地输入已保留。'
                : saving ? '保存中，后续输入会继续保留。' : '本窗口有尚未保存的修改。'}</p>
            {state.remote && <p className={styles.draftHint}>采用远端会放弃本地修改；重新提交只覆盖你编辑过的字段。</p>}
            {state.storageError && <p className={styles.error}>{state.storageError}</p>}
            <div className={styles.draftActions} onMouseDown={e => e.preventDefault()}>
              {unresolved && <button type="button" disabled={busy || (!uncertain && readOnly)} onClick={() => void retryOriginal()}>{uncertain ? '查询提交结果' : '重试原提交'}</button>}
              {!uncertain && <button type="button" disabled={busy} onClick={() => void adoptRemote()}>采用远端</button>}
              {!uncertain && <button type="button" disabled={busy || readOnly} onClick={() => void resubmit()}>保留修改并重新提交</button>}
              <button type="button" onClick={exportDraft}>导出草稿</button>
            </div>
          </div>
        )}
        <div className={styles.detailsFields}>
          <label className={styles.detailsField}>
            <span>自定义 ID</span>
            <input
              disabled={readOnly}
              value={draft.customId}
              placeholder="可选，库内唯一"
              spellCheck={false}
              onChange={(e) => setDraft((d) => ({ ...d, customId: e.target.value }))}
              onBlur={() => {
                const customId = draft.customId.trim() || null
                void applyPatch({ customId })
              }}
            />
          </label>

          <label className={styles.detailsField}>
            <span>位置</span>
            <select
              disabled={readOnly}
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
                disabled={readOnly}
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
                disabled={readOnly}
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
            <span>分辨率</span>
            <span className={styles.readonlyValue}>
              {entry.textureWidth}×{entry.textureHeight}
              {entry.textureWidth === 64 && entry.textureHeight === 32
                ? '（旧版）'
                : entry.textureWidth > 64
                  ? '（高清）'
                  : ''}
            </span>
          </div>

          <div className={styles.detailsField}>
            <span>标签</span>
            <TagPicker
              disabled={readOnly}
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
              disabled={readOnly}
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
                  disabled={readOnly}
                  value={draft.licenseName}
                  placeholder="如 MIT、CC BY 4.0"
                  onChange={(e) => setDraft((d) => ({ ...d, licenseName: e.target.value }))}
                  onBlur={() => patchLicense({})}
                />
              </label>
              <label className={styles.detailsField}>
                <span>协议链接</span>
                <input
                  disabled={readOnly}
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
              disabled={readOnly}
              value={draft.author}
              onChange={(e) => setDraft((d) => ({ ...d, author: e.target.value }))}
              onBlur={() => patchProvenance({})}
            />
          </label>

          <label className={styles.detailsField}>
            <span>备注</span>
            <textarea
              disabled={readOnly}
              rows={3}
              value={draft.note}
              onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
              onBlur={() => {
                const note = draft.note.trim()
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
              disabled={readOnly}
              value={draft.sourceName}
              placeholder="原作品页面/站点名称"
              onChange={(e) => setDraft((d) => ({ ...d, sourceName: e.target.value }))}
              onBlur={() => patchProvenance({})}
            />
          </label>
          <label className={styles.detailsField}>
            <span>出处链接</span>
            <input
              disabled={readOnly}
              value={draft.sourceUrl}
              placeholder="https://…"
              onChange={(e) => setDraft((d) => ({ ...d, sourceUrl: e.target.value }))}
              onBlur={() => patchProvenance({})}
            />
          </label>
          <label className={styles.detailsField}>
            <span>出处说明</span>
            <textarea
              disabled={readOnly}
              rows={2}
              value={draft.sourceNote}
              onChange={(e) => setDraft((d) => ({ ...d, sourceNote: e.target.value }))}
              onBlur={() => patchProvenance({})}
            />
          </label>
          <label className={styles.detailsField}>
            <span>协议说明</span>
            <textarea
              disabled={readOnly}
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
            导出 .skin
          </button>
          <button type="button" onClick={onExportPortable}>
            导出 .skin.json
          </button>
          <button type="button" className={styles.danger} disabled={readOnly} onClick={onDelete}>
            删除
          </button>
        </div>
      </div>
    </div>
  )
}
