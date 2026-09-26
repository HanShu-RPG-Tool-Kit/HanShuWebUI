/**
 * 编辑条目资料对话框：名称、位置、标签、active、协议、作者、出处、备注。
 */

import { useState } from 'react'
import type { FolderWithStats, LibraryEntry, TagWithStats } from '../contracts/types.ts'
import { TagPicker } from './TagPicker.tsx'
import styles from '../styles/workspace.module.css'

export interface EntryEditorProps {
  entry: LibraryEntry
  folders: FolderWithStats[]
  tags: TagWithStats[]
  createTag: (name: string, parentId: string | null) => Promise<string | null>
  onSaved: (updated: LibraryEntry) => void
  onClose: () => void
  onPatch: (entryId: string, body: {
    revision: number
    name?: string
    folderId?: string | null
    tagIds?: string[]
    active?: boolean
    license?: { status: 'unspecified' | 'declared'; name: string | null; url: string | null; note: string | null }
    provenance?: { author: string | null; sourceName: string | null; sourceUrl: string | null; sourceNote: string | null; originalCreatedAt: string | null }
    note?: string
  }) => Promise<LibraryEntry>
}

export function EntryEditor({
  entry,
  folders,
  tags,
  createTag,
  onSaved,
  onClose,
  onPatch,
}: EntryEditorProps) {
  const [name, setName] = useState(entry.name)
  const [folderId, setFolderId] = useState<string | null>(entry.folderId)
  const [tagIds, setTagIds] = useState<string[]>(entry.tagIds)
  const [active, setActive] = useState(entry.active)
  const [licenseStatus, setLicenseStatus] = useState<'unspecified' | 'declared'>(entry.license.status)
  const [licenseName, setLicenseName] = useState(entry.license.name ?? '')
  const [licenseUrl, setLicenseUrl] = useState(entry.license.url ?? '')
  const [licenseNote, setLicenseNote] = useState(entry.license.note ?? '')
  const [author, setAuthor] = useState(entry.provenance.author ?? '')
  const [sourceName, setSourceName] = useState(entry.provenance.sourceName ?? '')
  const [sourceUrl, setSourceUrl] = useState(entry.provenance.sourceUrl ?? '')
  const [sourceNote, setSourceNote] = useState(entry.provenance.sourceNote ?? '')
  const [note, setNote] = useState(entry.note)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const updated = await onPatch(entry.entryId, {
        revision: entry.revision,
        name: name.trim() || entry.name,
        folderId,
        tagIds,
        active,
        license: {
          status: licenseStatus,
          name: licenseStatus === 'declared' ? licenseName.trim() || null : null,
          url: licenseStatus === 'declared' ? licenseUrl.trim() || null : null,
          note: licenseNote.trim() || null,
        },
        provenance: {
          author: author.trim() || null,
          sourceName: sourceName.trim() || null,
          sourceUrl: sourceUrl.trim() || null,
          sourceNote: sourceNote.trim() || null,
          originalCreatedAt: entry.provenance.originalCreatedAt,
        },
        note: note.trim(),
      })
      onSaved(updated)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="编辑资料"
      >
        <header className={styles.modalHead}>
          <h3>编辑:{entry.name}</h3>
          <button className={styles.iconBtn} onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>
        <div className={styles.modalBody}>
          <label className={styles.formRow}>
            <span>名称</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className={styles.formRow}>
            <span>位置</span>
            <select value={folderId ?? ''} onChange={(e) => setFolderId(e.target.value || null)}>
              <option value="">未归档</option>
              {folders.map((f) => (
                <option key={f.folderId} value={f.folderId}>
                  {f.path.join(' / ')}
                </option>
              ))}
            </select>
          </label>
          <div className={styles.formRow}>
            <span>标签</span>
            <TagPicker tags={tags} selected={tagIds} onChange={setTagIds} onCreate={createTag} />
          </div>
          <label className={styles.formRow}>
            <span>状态</span>
            <select value={active ? 'active' : 'inactive'} onChange={(e) => setActive(e.target.value === 'active')}>
              <option value="active">已启用</option>
              <option value="inactive">已禁用</option>
            </select>
          </label>
          <label className={styles.formRow}>
            <span>协议</span>
            <select value={licenseStatus} onChange={(e) => setLicenseStatus(e.target.value as 'unspecified' | 'declared')}>
              <option value="unspecified">未声明</option>
              <option value="declared">已声明</option>
            </select>
          </label>
          {licenseStatus === 'declared' && (
            <>
              <label className={styles.formRow}>
                <span>协议名称</span>
                <input value={licenseName} onChange={(e) => setLicenseName(e.target.value)} placeholder="如 MIT、CC BY 4.0" />
              </label>
              <label className={styles.formRow}>
                <span>协议链接</span>
                <input value={licenseUrl} onChange={(e) => setLicenseUrl(e.target.value)} placeholder="https://…" />
              </label>
            </>
          )}
          <label className={styles.formRow}>
            <span>协议说明</span>
            <textarea value={licenseNote} onChange={(e) => setLicenseNote(e.target.value)} rows={2} />
          </label>
          <label className={styles.formRow}>
            <span>作者</span>
            <input value={author} onChange={(e) => setAuthor(e.target.value)} />
          </label>
          <label className={styles.formRow}>
            <span>出处名称</span>
            <input value={sourceName} onChange={(e) => setSourceName(e.target.value)} placeholder="原作品页面/站点名称" />
          </label>
          <label className={styles.formRow}>
            <span>出处链接</span>
            <input value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://…" />
          </label>
          <label className={styles.formRow}>
            <span>出处说明</span>
            <textarea value={sourceNote} onChange={(e) => setSourceNote(e.target.value)} rows={2} />
          </label>
          <label className={styles.formRow}>
            <span>备注</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
          </label>
          {error && <p className={styles.error}>{error}</p>}
        </div>
        <footer className={styles.modalFoot}>
          <button onClick={onClose}>取消</button>
          <button className={styles.primary} disabled={busy} onClick={() => void save()}>
            保存
          </button>
        </footer>
      </div>
    </div>
  )
}
