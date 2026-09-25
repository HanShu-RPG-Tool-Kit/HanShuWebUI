/**
 * 批量导入弹窗:
 *   - 多文件进入同一队列;URL / 玩家名 / 皮肤码 / .skin.json 也进同一列表
 *   - 顶部统一设置:目标文件夹、统一添加标签
 *   - 行内编辑:单项名称、模型;行状态:待检查/可导入/重复/无效/导入中/已导入/失败
 *   - 同内容重复默认跳过,可另存;队列内重复提示;部分失败仅重试失败项
 * 文件选择走原生对话框(tauri-plugin-dialog),路径交给 skin_import_file。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { SkinApi } from '../api/SkinApi.ts'
import type {
  FolderWithStats,
  ImportJob,
  LibraryEntry,
  SkinModel,
  TagWithStats,
} from '../contracts/types.ts'
import { TagPicker } from './TagPicker.tsx'
import styles from '../styles/workspace.module.css'

type RowState =
  | 'pending'
  | 'checking'
  | 'ready'
  | 'duplicate'
  | 'queue-duplicate'
  | 'invalid'
  | 'importing'
  | 'done'
  | 'failed'

export interface QueueRow {
  rowId: string
  sourceLabel: string
  /** Native file path (png-file / skin-file via dialog). */
  filePath?: string
  text?: string
  kind: 'png-file' | 'png-url' | 'player-name' | 'skin-code' | 'skin-file'
  overrideName?: string
  overrideFolderId?: string | null
  overrideModel?: SkinModel
  job?: ImportJob
  state: RowState
  errorMessage?: string
  duplicateOf?: { entryId: string; name: string; folderPath: string }
  savedEntryId?: string
  checked: boolean
  suggestedTagPaths?: string[][]
}

interface Props {
  api: SkinApi
  folders: FolderWithStats[]
  tags: TagWithStats[]
  defaultFolderId: string | null
  createTag: (name: string, parentId: string | null) => Promise<string | null>
  existingEntries: LibraryEntry[]
  onSaved: () => void
  onClose: () => void
}

const ROW_ID = () => `r_${Math.random().toString(36).slice(2, 10)}`

export function ImportQueuePanel({
  api,
  folders,
  tags,
  defaultFolderId,
  createTag,
  existingEntries,
  onSaved,
  onClose,
}: Props) {
  const [rows, setRows] = useState<QueueRow[]>([])
  const [targetFolderId, setTargetFolderId] = useState<string | null>(defaultFolderId)
  const [commonTagIds, setCommonTagIds] = useState<string[]>([])
  const [defaultModel, setDefaultModel] = useState<SkinModel>('classic')
  const [busy, setBusy] = useState(false)
  const [activeTab, setActiveTab] = useState<'file' | 'url' | 'player' | 'code'>('file')
  const [textInput, setTextInput] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const checkingRef = useRef(false)

  const folderById = useMemo(() => new Map(folders.map((f) => [f.folderId, f])), [folders])
  const skinIdToEntry = useMemo(
    () => new Map(existingEntries.map((e) => [e.skinId, e])),
    [existingEntries],
  )

  const folderPathLabel = (folderId: string | null): string => {
    if (folderId === null) return '未归档'
    return folderById.get(folderId)?.path.join(' / ') ?? folderId
  }

  /* ---------------- queue manipulation ---------------- */

  const addPaths = (paths: string[]) => {
    if (paths.length === 0) return
    setRows((prev) => {
      const next = [...prev]
      for (const p of paths) {
        const name = p.split(/[\\/]/).pop() ?? 'file'
        const isPortable = /\.skin\.json$/i.test(name)
        const isPng = /\.png$/i.test(name)
        if (!isPortable && !isPng) {
          next.push({
            rowId: ROW_ID(),
            sourceLabel: name,
            filePath: p,
            kind: 'png-file',
            state: 'invalid',
            errorMessage: '仅支持 PNG 或 .skin.json 文件',
            checked: false,
          })
          continue
        }
        next.push({
          rowId: ROW_ID(),
          sourceLabel: name,
          filePath: p,
          kind: isPortable ? 'skin-file' : 'png-file',
          state: 'pending',
          checked: true,
        })
      }
      return next
    })
  }

  const addText = () => {
    const text = textInput.trim()
    if (!text) return
    let kind: QueueRow['kind']
    let label: string
    if (activeTab === 'url') {
      kind = 'png-url'
      label = text
    } else if (activeTab === 'player') {
      kind = 'player-name'
      label = text
    } else {
      kind = 'skin-code'
      label = text.slice(0, 40) + (text.length > 40 ? '…' : '')
    }
    setRows((prev) => [
      ...prev,
      {
        rowId: ROW_ID(),
        sourceLabel: label,
        text,
        kind,
        state: 'pending',
        checked: true,
      },
    ])
    setTextInput('')
  }

  const removeRow = (rowId: string) => {
    setRows((prev) => prev.filter((r) => r.rowId !== rowId))
  }

  const removeFailed = () => {
    setRows((prev) => prev.filter((r) => r.state !== 'invalid' && r.state !== 'failed'))
  }

  const toggleRow = (rowId: string, checked: boolean) => {
    setRows((prev) => prev.map((r) => (r.rowId === rowId ? { ...r, checked } : r)))
  }

  const patchRow = (rowId: string, patch: Partial<QueueRow>) => {
    setRows((prev) => prev.map((r) => (r.rowId === rowId ? { ...r, ...patch } : r)))
  }

  /* ---------------- check each row via import job ---------------- */

  const checkRow = async (row: QueueRow) => {
    patchRow(row.rowId, { state: 'checking' })
    try {
      let jobId: string
      if ((row.kind === 'png-file' || row.kind === 'skin-file') && row.filePath) {
        jobId = (
          await api.importFile(
            row.filePath,
            row.kind === 'png-file' ? (row.overrideModel ?? defaultModel) : undefined,
          )
        ).jobId
      } else if (row.kind === 'png-url' || row.kind === 'player-name' || row.kind === 'skin-code') {
        jobId = (
          await api.startImport(
            row.kind,
            row.text!,
            row.kind === 'skin-code' ? undefined : (row.overrideModel ?? defaultModel),
          )
        ).jobId
      } else if (row.kind === 'skin-file' && row.text) {
        jobId = (await api.startImport('skin-file', row.text!)).jobId
      } else {
        throw new Error('不支持的来源')
      }
      // Poll
      let job: ImportJob | null = null
      for (let i = 0; i < 500; i++) {
        job = await api.getImport(jobId)
        if (job.state === 'ready' || job.state === 'failed' || job.state === 'cancelled') break
        await new Promise((r) => setTimeout(r, 100))
      }
      if (!job || job.state !== 'ready' || !job.result) {
        patchRow(row.rowId, {
          state: 'invalid',
          errorMessage: job?.error?.message ?? '校验失败',
          job: job ?? undefined,
        })
        return
      }
      const existing = skinIdToEntry.get(job.result.skinId)
      setRows((prev) => {
        const queueDup = prev.find(
          (r) =>
            r.rowId !== row.rowId &&
            r.job?.result?.skinId === job!.result!.skinId &&
            (r.state === 'ready' || r.state === 'done'),
        )
        return prev.map((r) => {
          if (r.rowId !== row.rowId) return r
          const next: QueueRow = {
            ...r,
            job: job!,
            suggestedTagPaths: job!.result!.suggestedTagPaths,
          }
          if (existing) {
            next.state = 'duplicate'
            next.duplicateOf = {
              entryId: existing.entryId,
              name: existing.name,
              folderPath: folderPathLabel(existing.folderId),
            }
            next.checked = false
          } else if (queueDup) {
            next.state = 'queue-duplicate'
            next.errorMessage = `与「${queueDup.sourceLabel}」内容相同`
            next.checked = false
          } else {
            next.state = 'ready'
          }
          return next
        })
      })
    } catch (e) {
      patchRow(row.rowId, {
        state: 'invalid',
        errorMessage: (e as Error).message,
      })
    }
  }

  // 逐条启动 pending 行的检查(串行)
  useEffect(() => {
    const first = rows.find((r) => r.state === 'pending')
    if (!first || checkingRef.current) return
    checkingRef.current = true
    void checkRow(first).finally(() => {
      checkingRef.current = false
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows])

  /* ---------------- save ---------------- */

  const saveRow = async (row: QueueRow): Promise<boolean> => {
    if (!row.job?.result) return false
    const name = (row.overrideName ?? row.job.result.suggestedName).trim()
    if (!name) {
      patchRow(row.rowId, { state: 'failed', errorMessage: '名称不能为空' })
      return false
    }
    patchRow(row.rowId, { state: 'importing' })
    try {
      const folderId = row.overrideFolderId !== undefined ? row.overrideFolderId : targetFolderId
      const saved = await api.saveEntry({
        jobId: row.job.jobId,
        name,
        tagIds: commonTagIds,
        tagPaths:
          row.suggestedTagPaths && row.suggestedTagPaths.length > 0
            ? row.suggestedTagPaths
            : undefined,
        folderId,
      })
      patchRow(row.rowId, { state: 'done', savedEntryId: saved.entryId })
      return true
    } catch (e) {
      patchRow(row.rowId, {
        state: 'failed',
        errorMessage: (e as Error).message,
      })
      return false
    }
  }

  const importSelected = async () => {
    setBusy(true)
    const toImport = rows.filter((r) => r.checked && r.state === 'ready')
    for (const r of toImport) {
      await saveRow(r)
    }
    setBusy(false)
    onSaved()
  }

  const retryFailed = async () => {
    setBusy(true)
    const toRetry = rows.filter((r) => r.state === 'failed')
    for (const r of toRetry) {
      await saveRow(r)
    }
    setBusy(false)
    onSaved()
  }

  const saveDuplicateAnyway = async (row: QueueRow) => {
    patchRow(row.rowId, { state: 'ready', checked: true, duplicateOf: undefined })
  }

  /* ---------------- stats & render ---------------- */

  const totalCount = rows.length
  const readyCount = rows.filter((r) => r.state === 'ready').length
  const dupCount = rows.filter(
    (r) => r.state === 'duplicate' || r.state === 'queue-duplicate',
  ).length
  const failCount = rows.filter((r) => r.state === 'invalid' || r.state === 'failed').length
  const doneCount = rows.filter((r) => r.state === 'done').length
  const importingCount = rows.filter((r) => r.state === 'importing').length
  const selectedReady = rows.filter((r) => r.checked && r.state === 'ready').length

  const pickFiles = async () => {
    // Native multi-select dialog via tauri-plugin-dialog.
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({
      multiple: true,
      title: '选择 PNG 或 .skin.json 文件',
      filters: [{ name: '皮肤文件', extensions: ['png', 'json'] }],
    })
    if (!selected) return
    const paths = Array.isArray(selected) ? selected : [selected]
    addPaths(paths)
  }

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div
        className={styles.importModal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="导入皮肤"
      >
        <header className={styles.modalHead}>
          <h3>导入皮肤</h3>
          <button className={styles.iconBtn} onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>

        <div className={styles.importToolbar}>
          <div className={styles.importAddRow}>
            <div className={styles.importTabs} role="tablist">
              {(
                [
                  ['file', '文件'],
                  ['url', 'PNG URL'],
                  ['player', '玩家名'],
                  ['code', '皮肤码'],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  role="tab"
                  aria-selected={activeTab === k}
                  className={activeTab === k ? `${styles.tab} active` : styles.tab}
                  onClick={() => setActiveTab(k)}
                >
                  {label}
                </button>
              ))}
            </div>
            {activeTab === 'file' ? (
              <>
                <button onClick={() => void pickFiles()}>添加文件…</button>
                <span className={styles.hint}>可一次选择多个 PNG / .skin.json</span>
              </>
            ) : (
              <>
                <input
                  type="text"
                  value={textInput}
                  placeholder={
                    activeTab === 'url'
                      ? 'https://example.com/skin.png'
                      : activeTab === 'player'
                        ? 'Notch'
                        : 'hskin1:...'
                  }
                  onChange={(e) => setTextInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addText()
                  }}
                />
                <button onClick={addText} disabled={!textInput.trim()}>
                  加入队列
                </button>
              </>
            )}
          </div>

          <div className={styles.importDefaults}>
            <label>
              目标文件夹:
              <select
                value={targetFolderId ?? ''}
                onChange={(e) => setTargetFolderId(e.target.value || null)}
              >
                <option value="">未归档</option>
                {folders.map((f) => (
                  <option key={f.folderId} value={f.folderId}>
                    {f.path.join(' / ')}
                  </option>
                ))}
              </select>
            </label>
            <label>
              默认模型:
              <select
                value={defaultModel}
                onChange={(e) => setDefaultModel(e.target.value as SkinModel)}
              >
                <option value="classic">classic</option>
                <option value="slim">slim</option>
              </select>
            </label>
          </div>

          <details className={styles.importCommonTags}>
            <summary>统一添加标签({commonTagIds.length})</summary>
            <TagPicker
              tags={tags}
              selected={commonTagIds}
              onChange={setCommonTagIds}
              onCreate={createTag}
            />
          </details>
        </div>

        <div
          className={`${styles.importQueue}${dragOver ? ` ${styles.dragover}` : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            // Path-based file drops arrive via the Tauri window drag-drop
            // event; text drops (skin codes) go through the text tab.
          }}
        >
          {rows.length === 0 ? (
            <p className={styles.empty}>还没有待导入项。添加文件、URL、玩家名或皮肤码。</p>
          ) : (
            <table className={styles.importTable}>
              <thead>
                <tr>
                  <th></th>
                  <th>来源</th>
                  <th>名称</th>
                  <th>模型</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.rowId}
                    className={
                      r.state === 'done'
                        ? styles.stateDone
                        : r.state === 'invalid' || r.state === 'failed'
                          ? styles.stateInvalid
                          : r.state === 'duplicate' || r.state === 'queue-duplicate'
                            ? styles.stateDuplicate
                            : undefined
                    }
                  >
                    <td>
                      <input
                        type="checkbox"
                        checked={r.checked}
                        disabled={
                          r.state === 'importing' ||
                          r.state === 'done' ||
                          r.state === 'invalid' ||
                          r.state === 'checking' ||
                          r.state === 'pending'
                        }
                        onChange={(e) => toggleRow(r.rowId, e.target.checked)}
                        aria-label="选择本行"
                      />
                    </td>
                    <td className={styles.colSource} title={r.sourceLabel}>
                      {r.sourceLabel}
                    </td>
                    <td>
                      {r.state === 'ready' || r.state === 'duplicate' ? (
                        <input
                          type="text"
                          className={styles.rowName}
                          value={r.overrideName ?? r.job?.result?.suggestedName ?? ''}
                          onChange={(e) => patchRow(r.rowId, { overrideName: e.target.value })}
                        />
                      ) : (
                        (r.overrideName ?? r.job?.result?.suggestedName ?? '—')
                      )}
                    </td>
                    <td>
                      {r.kind === 'png-file' || r.kind === 'png-url' ? (
                        <select
                          value={r.overrideModel ?? defaultModel}
                          onChange={(e) =>
                            patchRow(r.rowId, { overrideModel: e.target.value as SkinModel })
                          }
                          disabled={r.state !== 'ready'}
                        >
                          <option value="classic">classic</option>
                          <option value="slim">slim</option>
                        </select>
                      ) : (
                        (r.job?.result?.model ?? '—')
                      )}
                    </td>
                    <td className={styles.colState}>
                      {r.state === 'pending' && '待检查'}
                      {r.state === 'checking' && '检查中…'}
                      {r.state === 'ready' && '可导入'}
                      {r.state === 'duplicate' && (
                        <span title={r.duplicateOf?.folderPath}>
                          重复(已在:{r.duplicateOf?.folderPath ?? '?'})
                        </span>
                      )}
                      {r.state === 'queue-duplicate' && (
                        <span title={r.errorMessage}>队列内重复</span>
                      )}
                      {r.state === 'invalid' && (
                        <span className={styles.errorText} title={r.errorMessage}>
                          无效
                        </span>
                      )}
                      {r.state === 'importing' && '导入中…'}
                      {r.state === 'done' && <span className={styles.okText}>已导入</span>}
                      {r.state === 'failed' && (
                        <span className={styles.errorText} title={r.errorMessage}>
                          保存失败
                        </span>
                      )}
                    </td>
                    <td className={styles.colOps}>
                      {r.state === 'duplicate' && (
                        <button onClick={() => void saveDuplicateAnyway(r)}>另存为条目</button>
                      )}
                      {(r.state === 'pending' ||
                        r.state === 'ready' ||
                        r.state === 'duplicate' ||
                        r.state === 'queue-duplicate' ||
                        r.state === 'invalid' ||
                        r.state === 'failed') && (
                        <button onClick={() => removeRow(r.rowId)}>移除</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <footer className={styles.modalFoot}>
          <span>
            总计 {totalCount} 项 · 可导入 {readyCount} · 重复 {dupCount} · 失败/无效 {failCount}
            {doneCount > 0 && ` · 已导入 ${doneCount}`}
            {importingCount > 0 && ` · 进行中 ${importingCount}`}
          </span>
          <span className={styles.spacer} />
          {failCount > 0 && <button onClick={removeFailed}>移除失败项</button>}
          {rows.some((r) => r.state === 'failed') && (
            <button disabled={busy} onClick={() => void retryFailed()}>
              重试失败项
            </button>
          )}
          <button onClick={onClose}>关闭</button>
          <button
            className={styles.primary}
            disabled={busy || selectedReady === 0}
            onClick={() => void importSelected()}
          >
            导入选中的 {selectedReady} 项
          </button>
        </footer>
      </div>
    </div>
  )
}
