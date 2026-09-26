/**
 * 批量导入弹窗(方案 §4.2/§13.2):
 *   - 文件选择走平台层(桌面原生对话框 / 浏览器 input+拖放),URL/玩家名/皮肤码进同一队列
 *   - 顶部统一设置:目标文件夹、统一标签、默认模型、默认启用
 *   - 行内确认:名称、模型、启用、协议、作者、出处、备注 —— 便携文件的
 *     suggested 元数据全部进入表单,保存时贯穿到 SaveEntryRequest,不中途丢失
 *   - 重复检测按 skinId 全库查询(不是当前页);同内容默认跳过,可另存
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { SkinApi } from '../api/SkinApi.ts'
import type {
  FolderWithStats,
  ImportJob,
  LicenseInfo,
  Provenance,
  SkinModel,
  CollectedTag,
} from '../contracts/types.ts'
import { getPlatformFiles, pickedKind, type PickedFile } from '../platform/files.ts'
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
  /** Desktop: native path; browser: File handle. */
  picked?: PickedFile
  text?: string
  kind: 'png-file' | 'png-url' | 'player-name' | 'skin-code' | 'skin-file'
  overrideName?: string
  overrideFolderId?: string | null
  overrideModel?: SkinModel
  /** Per-row metadata confirmation (defaults from job suggestions). */
  active?: boolean
  license?: LicenseInfo
  provenance?: Provenance
  note?: string
  job?: ImportJob
  state: RowState
  errorMessage?: string
  duplicateOf?: { entryId: string; name: string; folderId: string | null; folderPath: string }
  savedEntryId?: string
  checked: boolean
  suggestedTagPaths?: string[][]
}

interface Props {
  api: SkinApi
  folders: FolderWithStats[]
  tags: CollectedTag[]
  defaultFolderId: string | null
  /** Locate an existing entry in the main view (clears filters, pins it). */
  onLocateEntry: (entryId: string, folderId: string | null) => void
  onSaved: () => void
  onClose: () => void
}

const ROW_ID = () => `r_${Math.random().toString(36).slice(2, 10)}`

const EMPTY_LICENSE: LicenseInfo = { status: 'unspecified', name: null, url: null, note: null }
const EMPTY_PROVENANCE: Provenance = {
  author: null,
  sourceName: null,
  sourceUrl: null,
  sourceNote: null,
  originalCreatedAt: null,
}

export function ImportQueuePanel({
  api,
  folders,
  tags,
  defaultFolderId,
  onLocateEntry,
  onSaved,
  onClose,
}: Props) {
  const [rows, setRows] = useState<QueueRow[]>([])
  const [targetFolderId, setTargetFolderId] = useState<string | null>(defaultFolderId)
  const [commonTags, setCommonTags] = useState<string[]>([])
  const [defaultModel, setDefaultModel] = useState<SkinModel>('classic')
  const [defaultActive, setDefaultActive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [activeTab, setActiveTab] = useState<'file' | 'url' | 'player' | 'code'>('file')
  const [textInput, setTextInput] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [expandedRow, setExpandedRow] = useState<string | null>(null)
  const checkingRef = useRef(false)
  const platform = useMemo(() => getPlatformFiles(), [])

  const folderById = useMemo(() => new Map(folders.map((f) => [f.folderId, f])), [folders])

  const folderPathLabel = (folderId: string | null): string => {
    if (folderId === null) return '皮肤库'
    return folderById.get(folderId)?.path.join(' / ') ?? folderId
  }

  /* ---------------- queue manipulation ---------------- */

  const addPicked = (picked: PickedFile[]) => {
    if (picked.length === 0) return
    setRows((prev) => {
      const next = [...prev]
      for (const p of picked) {
        const kind = pickedKind(p)
        if (!kind) {
          next.push({
            rowId: ROW_ID(),
            sourceLabel: p.name,
            picked: p,
            kind: 'png-file',
            state: 'invalid',
            errorMessage: '仅支持 PNG 或 .skin.json 文件',
            checked: false,
          })
          continue
        }
        next.push({
          rowId: ROW_ID(),
          sourceLabel: p.name,
          picked: p,
          kind,
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
      if ((row.kind === 'png-file' || row.kind === 'skin-file') && row.picked) {
        if (row.picked.path) {
          jobId = (
            await api.importFile(
              row.picked.path,
              row.kind === 'png-file' ? (row.overrideModel ?? defaultModel) : undefined,
            )
          ).jobId
        } else if (row.picked.file) {
          jobId = (
            await api.importFileBlob(
              row.picked.file,
              row.kind === 'png-file' ? (row.overrideModel ?? defaultModel) : undefined,
            )
          ).jobId
        } else {
          throw new Error('缺少文件内容')
        }
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
      // Whole-library duplicate check by skinId — not just the current page.
      const existingPage = await api.listEntries({ search: job.result.skinId, pageSize: 50 })
      const existing = existingPage.entries.find((e) => e.skinId === job.result!.skinId)
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
            active: job!.result!.suggestedActive ?? defaultActive,
            license: job!.result!.suggestedLicense ?? EMPTY_LICENSE,
            provenance: job!.result!.suggestedProvenance ?? EMPTY_PROVENANCE,
            note: job!.result!.suggestedNote ?? '',
          }
          if (existing) {
            next.state = 'duplicate'
            next.duplicateOf = {
              entryId: existing.entryId,
              name: existing.name,
              folderId: existing.folderId,
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
        tags: commonTags.length > 0 ? commonTags : undefined,
        tagPaths:
          row.suggestedTagPaths && row.suggestedTagPaths.length > 0
            ? row.suggestedTagPaths
            : undefined,
        folderId,
        active: row.active ?? defaultActive,
        license: row.license ?? EMPTY_LICENSE,
        provenance: row.provenance ?? EMPTY_PROVENANCE,
        note: row.note ?? '',
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
    const picked = await platform.pickSkinFiles()
    addPicked(picked)
  }

  const renderRowMeta = (r: QueueRow) => {
    const isOpen = expandedRow === r.rowId
    const license = r.license ?? EMPTY_LICENSE
    const provenance = r.provenance ?? EMPTY_PROVENANCE
    return (
      <>
        <button
          type="button"
          className={styles.linkBtn}
          onClick={() => setExpandedRow(isOpen ? null : r.rowId)}
        >
          {isOpen ? '收起资料 ▴' : '资料… ▾'}
        </button>
        {isOpen && (
          <div className={styles.rowMetaForm}>
            <label>
              启用
              <input
                type="checkbox"
                checked={r.active ?? defaultActive}
                onChange={(e) => patchRow(r.rowId, { active: e.target.checked })}
              />
            </label>
            <label>
              协议
              <select
                value={license.status}
                onChange={(e) =>
                  patchRow(r.rowId, {
                    license: {
                      status: e.target.value as 'unspecified' | 'declared',
                      name: license.name,
                      url: license.url,
                      note: license.note,
                    },
                  })
                }
              >
                <option value="unspecified">未声明</option>
                <option value="declared">已声明</option>
              </select>
              {license.status === 'declared' && (
                <input
                  type="text"
                  placeholder="协议名称,如 MIT"
                  value={license.name ?? ''}
                  onChange={(e) =>
                    patchRow(r.rowId, {
                      license: { ...license, name: e.target.value || null },
                    })
                  }
                />
              )}
            </label>
            <label>
              作者
              <input
                type="text"
                value={provenance.author ?? ''}
                onChange={(e) =>
                  patchRow(r.rowId, {
                    provenance: { ...provenance, author: e.target.value || null },
                  })
                }
              />
            </label>
            <label>
              出处名称
              <input
                type="text"
                value={provenance.sourceName ?? ''}
                onChange={(e) =>
                  patchRow(r.rowId, {
                    provenance: { ...provenance, sourceName: e.target.value || null },
                  })
                }
              />
            </label>
            <label>
              出处链接
              <input
                type="text"
                placeholder="https://…"
                value={provenance.sourceUrl ?? ''}
                onChange={(e) =>
                  patchRow(r.rowId, {
                    provenance: { ...provenance, sourceUrl: e.target.value || null },
                  })
                }
              />
            </label>
            <label>
              备注
              <input
                type="text"
                value={r.note ?? ''}
                onChange={(e) => patchRow(r.rowId, { note: e.target.value })}
              />
            </label>
          </div>
        )}
      </>
    )
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
                <span className={styles.hint}>
                  {platform.mode === 'browser'
                    ? '可一次选择多个 PNG / .skin.json,也可直接拖入'
                    : '可一次选择多个 PNG / .skin.json'}
                </span>
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
                <option value="">皮肤库</option>
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
            <label>
              <input
                type="checkbox"
                checked={defaultActive}
                onChange={(e) => setDefaultActive(e.target.checked)}
              />
              新导入默认启用
            </label>
          </div>

          <details className={styles.importCommonTags}>
            <summary>统一添加标签({commonTags.length})</summary>
            <TagPicker tags={tags} selected={commonTags} onChange={setCommonTags} />
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
            addPicked(platform.fromDataTransfer(e.dataTransfer))
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
                  <th>资料</th>
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
                        <span title={`内容与已有条目相同:${r.duplicateOf?.name ?? ''}`}>
                          重复
                          {r.duplicateOf && (
                            <button
                              type="button"
                              className={styles.locateLink}
                              title={`跳转到「${r.duplicateOf.name}」所在位置(${r.duplicateOf.folderPath})`}
                              onClick={() => {
                                onLocateEntry(r.duplicateOf!.entryId, r.duplicateOf!.folderId)
                                onClose()
                              }}
                            >
                              已在:{r.duplicateOf.folderPath} · 定位
                            </button>
                          )}
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
                    <td>
                      {(r.state === 'ready' || r.state === 'duplicate') && renderRowMeta(r)}
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
