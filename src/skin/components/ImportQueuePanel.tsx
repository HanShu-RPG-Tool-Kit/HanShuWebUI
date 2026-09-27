/**
 * 批量导入弹窗(方案 §4.2/§13.2):
 *   - 文件选择走平台层(桌面原生对话框 / 浏览器 input+拖放),URL/玩家名/皮肤码进同一队列
 *   - 顶部统一设置:目标文件夹、统一标签、默认模型、默认启用
 *   - 行内确认:名称、模型、启用、协议、作者、出处、备注 —— 便携文件的
 *     suggested 元数据全部进入表单,保存时贯穿到 SaveEntryRequest,不中途丢失
 *   - 重复检测按 skinId 全库查询(不是当前页);同内容默认跳过,可另存
 */

import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import type { SkinApi } from '../api/SkinApi.ts'
import type {
  FolderWithStats,
  ImportJob,
  LicenseInfo,
  Provenance,
  SkinModel,
  CollectedTag,
} from '../contracts/types.ts'
import {
  getPlatformFiles,
  pickedFromSnapshot,
  pickedKind,
  relativeFolderSegments,
  snapshotDataTransfer,
  type PickedFile,
} from '../platform/files.ts'
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

const ADD_CHUNK = 120
/** 并行校验并发数（PNG decode + 写盘） */
const CHECK_CONCURRENCY = 12
/** 并行入库并发数 */
const SAVE_CONCURRENCY = 8
/** 虚拟列表行高估算（px）；展开资料时该行会偏高，可接受 */
const VIRT_ROW_H = 44
const VIRT_OVERSCAN = 8

const EMPTY_LICENSE: LicenseInfo = { status: 'unspecified', name: null, url: null, note: null }
const EMPTY_PROVENANCE: Provenance = {
  author: null,
  sourceName: null,
  sourceUrl: null,
  sourceNote: null,
  originalCreatedAt: null,
}

type ScanStatus =
  | { phase: 'scanning'; found: number }
  | { phase: 'adding'; found: number; added: number }
  | null

type RowFilter = 'all' | 'failed' | 'ready' | 'dup' | 'pending'

function rowPriority(state: RowState): number {
  if (state === 'invalid' || state === 'failed') return 0
  if (state === 'duplicate' || state === 'queue-duplicate') return 1
  if (state === 'ready') return 2
  if (state === 'checking' || state === 'pending') return 3
  if (state === 'importing') return 4
  return 5
}

function pickedToRow(p: PickedFile): QueueRow {
  const kind = pickedKind(p)
  const label = p.relativePath || p.name
  if (!kind) {
    return {
      rowId: ROW_ID(),
      sourceLabel: label,
      picked: p,
      kind: 'png-file',
      state: 'invalid',
      errorMessage: '仅支持 PNG / .skin / .skin.json',
      checked: false,
    }
  }
  return {
    rowId: ROW_ID(),
    sourceLabel: label,
    picked: p,
    kind,
    state: 'pending',
    checked: true,
  }
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
  const [defaultModel, setDefaultModel] = useState<'auto' | SkinModel>('auto')
  const [defaultActive, setDefaultActive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [activeTab, setActiveTab] = useState<'file' | 'url' | 'player' | 'code'>('file')
  const [textInput, setTextInput] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [scanStatus, setScanStatus] = useState<ScanStatus>(null)
  const [rowFilter, setRowFilter] = useState<RowFilter>('all')
  const [expandedRow, setExpandedRow] = useState<string | null>(null)
  const [listScrollTop, setListScrollTop] = useState(0)
  const [listViewportH, setListViewportH] = useState(480)
  const queueScrollRef = useRef<HTMLDivElement>(null)
  const checkingRef = useRef(false)
  const activeChecksRef = useRef(0)
  const ingestingRef = useRef(false)
  /** skinId → 库内已有条目（批量校验时只拉一次） */
  const existingBySkinIdRef = useRef<Map<
    string,
    { entryId: string; name: string; folderId: string | null }
  > | null>(null)
  /** 本会话新创建的文件夹：key = `${parentId ?? ''}::${nfcName}` → folderId */
  const folderEnsureCache = useRef<Map<string, string>>(new Map())
  const localFolders = useRef<
    { folderId: string; name: string; parentId: string | null }[]
  >([])
  const platform = useMemo(() => getPlatformFiles(), [])

  const folderById = useMemo(() => new Map(folders.map((f) => [f.folderId, f])), [folders])

  const folderPathLabel = (folderId: string | null): string => {
    if (folderId === null) return '皮肤库'
    return folderById.get(folderId)?.path.join(' / ') ?? folderId
  }

  // 弹窗打开期间拦住整页默认拖放，防止大文件夹把 SPA 导航走
  useEffect(() => {
    const block = (e: Event) => {
      e.preventDefault()
    }
    window.addEventListener('dragover', block)
    window.addEventListener('drop', block)
    return () => {
      window.removeEventListener('dragover', block)
      window.removeEventListener('drop', block)
    }
  }, [])

  /* ---------------- queue manipulation ---------------- */

  const addPicked = (picked: PickedFile[]) => {
    if (picked.length === 0) return
    void ingestPicked(picked)
  }

  const ingestPicked = async (picked: PickedFile[]) => {
    if (picked.length === 0) return
    ingestingRef.current = true
    setScanStatus({ phase: 'adding', found: picked.length, added: 0 })
    try {
      for (let i = 0; i < picked.length; i += ADD_CHUNK) {
        const chunk = picked.slice(i, i + ADD_CHUNK).map(pickedToRow)
        setRows((prev) => prev.concat(chunk))
        setScanStatus({
          phase: 'adding',
          found: picked.length,
          added: Math.min(i + ADD_CHUNK, picked.length),
        })
        await new Promise<void>((r) => setTimeout(r, 0))
      }
    } finally {
      ingestingRef.current = false
      setScanStatus(null)
    }
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

  const ensureExistingSkinIndex = async () => {
    if (existingBySkinIdRef.current) return existingBySkinIdRef.current
    const map = new Map<
      string,
      { entryId: string; name: string; folderId: string | null }
    >()
    let page = 1
    for (;;) {
      const res = await api.listEntries({ page, pageSize: 200 })
      for (const e of res.entries) {
        if (!map.has(e.skinId)) {
          map.set(e.skinId, {
            entryId: e.entryId,
            name: e.name,
            folderId: e.folderId,
          })
        }
      }
      if (res.entries.length < 200 || page * 200 >= (res.total ?? 0)) break
      page += 1
      if (page > 100) break
    }
    existingBySkinIdRef.current = map
    return map
  }

  const checkRow = async (row: QueueRow) => {
    patchRow(row.rowId, { state: 'checking' })
    const modelHint: SkinModel | undefined =
      row.overrideModel ?? (defaultModel === 'auto' ? undefined : defaultModel)
    try {
      let jobId: string
      if ((row.kind === 'png-file' || row.kind === 'skin-file') && row.picked) {
        if (row.picked.path) {
          jobId = (
            await api.importFile(
              row.picked.path,
              row.kind === 'png-file' ? modelHint : undefined,
            )
          ).jobId
        } else if (row.picked.file) {
          jobId = (
            await api.importFileBlob(
              row.picked.file,
              row.kind === 'png-file' ? modelHint : undefined,
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
            row.kind === 'skin-code' || row.kind === 'player-name' ? undefined : modelHint,
          )
        ).jobId
      } else if (row.kind === 'skin-file' && row.text) {
        jobId = (await api.startImport('skin-file', row.text!)).jobId
      } else {
        throw new Error('不支持的来源')
      }
      // importFileBlob / startImport 在 FSA 路径上已等校验完成，通常无需轮询
      let job = await api.getImport(jobId)
      if (job.state !== 'ready' && job.state !== 'failed' && job.state !== 'cancelled') {
        for (let i = 0; i < 100; i++) {
          await new Promise((r) => setTimeout(r, 20))
          job = await api.getImport(jobId)
          if (
            job.state === 'ready' ||
            job.state === 'failed' ||
            job.state === 'cancelled'
          ) {
            break
          }
        }
      }
      if (job.state !== 'ready' || !job.result) {
        patchRow(row.rowId, {
          state: 'invalid',
          errorMessage: job.error?.message ?? '校验失败',
          job,
        })
        return
      }
      const index = await ensureExistingSkinIndex()
      const existing = index.get(job.result.skinId)
      setRows((prev) => {
        const queueDup = prev.find(
          (r) =>
            r.rowId !== row.rowId &&
            r.job?.result?.skinId === job.result!.skinId &&
            (r.state === 'ready' || r.state === 'done' || r.state === 'checking'),
        )
        return prev.map((r) => {
          if (r.rowId !== row.rowId) return r
          const next: QueueRow = {
            ...r,
            job,
            overrideModel: r.overrideModel ?? job.result!.model,
            suggestedTagPaths: job.result!.suggestedTagPaths,
            // Prefer portable/job hint only when explicitly present; else batch default.
            active:
              typeof job.result!.suggestedActive === 'boolean'
                ? job.result!.suggestedActive
                : defaultActive,
            license: job.result!.suggestedLicense ?? EMPTY_LICENSE,
            provenance: job.result!.suggestedProvenance ?? EMPTY_PROVENANCE,
            note: job.result!.suggestedNote ?? '',
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

  // 并行校验池；扫描/分批入库期间先不跑
  useEffect(() => {
    if (ingestingRef.current || scanStatus) return
    if (checkingRef.current) return
    const pending = rows.filter((r) => r.state === 'pending')
    if (pending.length === 0) return
    const slots = CHECK_CONCURRENCY - activeChecksRef.current
    if (slots <= 0) return
    checkingRef.current = true
    const batch = pending.slice(0, slots)
    activeChecksRef.current += batch.length
    void Promise.all(
      batch.map((row) =>
        checkRow(row).finally(() => {
          activeChecksRef.current -= 1
        }),
      ),
    ).finally(() => {
      checkingRef.current = false
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, scanStatus])

  /* ---------------- folders from relative paths ---------------- */

  const findSiblingFolderId = (
    parentId: string | null,
    name: string,
    extra: { folderId: string; name: string; parentId: string | null }[] = [],
  ): string | undefined => {
    const norm = name.trim().normalize('NFC')
    const cacheKey = `${parentId ?? ''}::${norm}`
    const cached = folderEnsureCache.current.get(cacheKey)
    if (cached) return cached
    const match = (f: { folderId: string; name: string; parentId?: string | null }) =>
      (f.parentId ?? null) === parentId &&
      f.name.trim().normalize('NFC') === norm
    const local = localFolders.current.find(match)
    if (local) return local.folderId
    const fromExtra = extra.find(match)
    if (fromExtra) return fromExtra.folderId
    const hit = folders.find(match)
    return hit?.folderId
  }

  /** 在目标文件夹下按相对路径段创建/复用库内文件夹。 */
  const ensureFolderPath = async (
    segments: string[],
  ): Promise<string | null> => {
    let parentId: string | null = targetFolderId
    for (const raw of segments) {
      const name = raw.trim().normalize('NFC')
      if (!name) continue
      const cacheKey = `${parentId ?? ''}::${name}`
      let id = findSiblingFolderId(parentId, name)
      if (!id) {
        try {
          const created = await api.createFolder({ name, parentId })
          id = created.folderId
          localFolders.current.push({
            folderId: id,
            name: created.name ?? name,
            parentId,
          })
        } catch (e) {
          id = findSiblingFolderId(parentId, name)
          if (!id) {
            try {
              const listed = await api.listFolders()
              id = findSiblingFolderId(parentId, name, listed.folders)
            } catch {
              /* keep original error */
            }
          }
          if (!id) throw e
        }
      }
      folderEnsureCache.current.set(cacheKey, id)
      parentId = id
    }
    return parentId
  }

  const resolveRowFolderId = async (row: QueueRow): Promise<string | null> => {
    if (row.overrideFolderId !== undefined) return row.overrideFolderId
    const segments = relativeFolderSegments(row.picked?.relativePath)
    if (segments.length === 0) return targetFolderId
    return ensureFolderPath(segments)
  }

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
      const folderId = await resolveRowFolderId(row)
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
        model: row.overrideModel ?? row.job.result.model,
        license: row.license ?? EMPTY_LICENSE,
        provenance: row.provenance ?? EMPTY_PROVENANCE,
        note: row.note ?? '',
      })
      patchRow(row.rowId, {
        state: 'done',
        savedEntryId: saved.entryId,
        overrideFolderId: folderId,
      })
      return true
    } catch (e) {
      patchRow(row.rowId, {
        state: 'failed',
        errorMessage: (e as Error).message,
      })
      return false
    }
  }

  const runSavePool = async (targets: QueueRow[]) => {
    let cursor = 0
    const workers = Array.from(
      { length: Math.min(SAVE_CONCURRENCY, Math.max(1, targets.length)) },
      async () => {
        while (cursor < targets.length) {
          const i = cursor++
          const row = targets[i]
          if (row) await saveRow(row)
        }
      },
    )
    await Promise.all(workers)
  }

  const importSelected = async () => {
    setBusy(true)
    try {
      const toImport = rows.filter((r) => r.checked && r.state === 'ready')
      await runSavePool(toImport)
    } finally {
      setBusy(false)
      onSaved()
    }
  }

  const retryFailed = async () => {
    setBusy(true)
    try {
      const toRetry = rows.filter((r) => r.state === 'failed')
      await runSavePool(toRetry)
    } finally {
      setBusy(false)
      onSaved()
    }
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
  const pendingCount = rows.filter((r) => r.state === 'pending' || r.state === 'checking').length

  const filteredRows = useMemo(() => {
    if (rowFilter === 'failed') {
      return rows.filter((r) => r.state === 'invalid' || r.state === 'failed')
    }
    if (rowFilter === 'ready') {
      return rows.filter((r) => r.state === 'ready')
    }
    if (rowFilter === 'dup') {
      return rows.filter(
        (r) => r.state === 'duplicate' || r.state === 'queue-duplicate',
      )
    }
    if (rowFilter === 'pending') {
      return rows.filter((r) => r.state === 'pending' || r.state === 'checking')
    }
    // 全部：失败置顶，其余保持原顺序
    const bad: QueueRow[] = []
    const rest: QueueRow[] = []
    for (const r of rows) {
      if (rowPriority(r.state) === 0) bad.push(r)
      else rest.push(r)
    }
    return bad.concat(rest)
  }, [rows, rowFilter])

  // 虚拟窗口：逻辑上是完整列表（可滚到任意行），只挂载视口附近的 DOM
  const useVirtual = filteredRows.length > 120
  const virt = useMemo(() => {
    const total = filteredRows.length
    if (!useVirtual) {
      return {
        start: 0,
        end: total,
        topPad: 0,
        bottomPad: 0,
        slice: filteredRows,
      }
    }
    const start = Math.max(
      0,
      Math.floor(listScrollTop / VIRT_ROW_H) - VIRT_OVERSCAN,
    )
    const visibleCount =
      Math.ceil(listViewportH / VIRT_ROW_H) + VIRT_OVERSCAN * 2
    const end = Math.min(total, start + visibleCount)
    return {
      start,
      end,
      topPad: start * VIRT_ROW_H,
      bottomPad: Math.max(0, (total - end) * VIRT_ROW_H),
      slice: filteredRows.slice(start, end),
    }
  }, [filteredRows, listScrollTop, listViewportH, useVirtual])

  useEffect(() => {
    const el = queueScrollRef.current
    if (!el) return
    const measure = () => setListViewportH(el.clientHeight || 480)
    measure()
    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(measure)
        : null
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [filteredRows.length, scanStatus])

  const pickFiles = async () => {
    const picked = await platform.pickSkinFiles()
    addPicked(picked)
  }

  const pickFolder = async () => {
    if (ingestingRef.current) return
    ingestingRef.current = true
    setScanStatus({ phase: 'scanning', found: 0 })
    try {
      // directory input 同步给出 FileList；大目录也走分批入库
      const picked = await platform.pickSkinFolder()
      ingestingRef.current = false
      if (picked.length === 0) {
        setScanStatus(null)
        return
      }
      setScanStatus({ phase: 'scanning', found: picked.length })
      await ingestPicked(picked)
    } catch (err) {
      ingestingRef.current = false
      setScanStatus(null)
      const message = err instanceof Error ? err.message : String(err)
      setRows((prev) => [
        ...prev,
        {
          rowId: ROW_ID(),
          sourceLabel: '(文件夹)',
          kind: 'png-file',
          state: 'invalid',
          errorMessage: `读取失败: ${message}`,
          checked: false,
        },
      ])
    }
  }

  /** 拦截拖放，避免浏览器把文件夹当导航打开导致整个导入 UI「消失」。 */
  const handleDragOver = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(true)
  }

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // 只在离开当前节点时清状态，避免子元素冒泡误关
    if (e.currentTarget === e.target) setDragOver(false)
  }

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    if (ingestingRef.current) return
    const snap = snapshotDataTransfer(e.dataTransfer)
    ingestingRef.current = true
    setScanStatus({ phase: 'scanning', found: 0 })
    void pickedFromSnapshot(snap, (found) => {
      setScanStatus({ phase: 'scanning', found })
    })
      .then(async (picked) => {
        if (picked.length === 0) {
          ingestingRef.current = false
          setScanStatus(null)
          setRows((prev) => [
            ...prev,
            {
              rowId: ROW_ID(),
              sourceLabel: '(拖入的内容)',
              kind: 'png-file',
              state: 'invalid',
              errorMessage: '未找到 PNG / .skin / .skin.json',
              checked: false,
            },
          ])
          return
        }
        // ingestPicked 会继续占着 ingestingRef
        ingestingRef.current = false
        await ingestPicked(picked)
      })
      .catch((err: unknown) => {
        ingestingRef.current = false
        setScanStatus(null)
        const message = err instanceof Error ? err.message : String(err)
        setRows((prev) => [
          ...prev,
          {
            rowId: ROW_ID(),
            sourceLabel: '(拖入文件夹)',
            kind: 'png-file',
            state: 'invalid',
            errorMessage: `读取失败: ${message}`,
            checked: false,
          },
        ])
      })
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
    <div
      className={styles.modalBackdrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        className={styles.importModal}
        onClick={(e) => e.stopPropagation()}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
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
                <button onClick={() => void pickFolder()}>添加文件夹…</button>
                <span className={styles.hint}>
                  支持 PNG / .skin / .skin.json；选文件夹或拖入目录会按相对路径在目标下建夹
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
                        : 'hanshu-skin:1:classic:...'
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
                onChange={(e) =>
                  setDefaultModel(e.target.value as 'auto' | SkinModel)
                }
              >
                <option value="auto">自动检测</option>
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

        <div className={styles.importScanStatus} aria-live="polite">
          {scanStatus
            ? scanStatus.phase === 'scanning'
              ? `正在扫描文件夹… 已发现 ${scanStatus.found} 个皮肤文件（上千个时请稍候，勿关闭）`
              : `正在加入队列… ${scanStatus.added} / ${scanStatus.found}`
            : null}
        </div>

        <div
          ref={queueScrollRef}
          className={`${styles.importQueue}${dragOver ? ` ${styles.dragover}` : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onScroll={(e) => {
            if (useVirtual) setListScrollTop(e.currentTarget.scrollTop)
          }}
        >
          {rows.length === 0 && !scanStatus ? (
            <p className={styles.empty}>
              还没有待导入项。可添加文件/文件夹、拖入目录、URL、玩家名或皮肤码。
              <br />
              大文件夹（如上千个）请用「添加文件夹…」或拖入后等待扫描进度，勿反复拖放。
            </p>
          ) : rows.length === 0 && scanStatus ? (
            <p className={styles.empty}>扫描中，请稍候…</p>
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
                {virt.topPad > 0 && (
                  <tr aria-hidden className={styles.importVirtPad}>
                    <td colSpan={7} style={{ height: virt.topPad, padding: 0 }} />
                  </tr>
                )}
                {virt.slice.map((r) => (
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
                      {relativeFolderSegments(r.picked?.relativePath).length >
                        0 && (
                        <div className={styles.mutedHint}>
                          →{' '}
                          {folderPathLabel(targetFolderId)}
                          {' / '}
                          {relativeFolderSegments(r.picked?.relativePath).join(
                            ' / ',
                          )}
                        </div>
                      )}
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
                          value={r.overrideModel ?? r.job?.result?.model ?? 'classic'}
                          onChange={(e) =>
                            patchRow(r.rowId, { overrideModel: e.target.value as SkinModel })
                          }
                          disabled={r.state !== 'ready' && r.state !== 'duplicate'}
                        >
                          <option value="classic">classic</option>
                          <option value="slim">slim</option>
                        </select>
                      ) : (
                        (r.job?.result?.model ?? '—')
                      )}
                      {r.job?.result?.textureWidth ? (
                        <div className={styles.mutedHint} title="原始贴图分辨率">
                          {r.job.result.textureWidth}×{r.job.result.textureHeight}
                        </div>
                      ) : null}
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
                          无效{r.errorMessage ? `：${r.errorMessage}` : ''}
                        </span>
                      )}
                      {r.state === 'importing' && '导入中…'}
                      {r.state === 'done' && <span className={styles.okText}>已导入</span>}
                      {r.state === 'failed' && (
                        <span className={styles.errorText} title={r.errorMessage}>
                          保存失败{r.errorMessage ? `：${r.errorMessage}` : ''}
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
                {virt.bottomPad > 0 && (
                  <tr aria-hidden className={styles.importVirtPad}>
                    <td
                      colSpan={7}
                      style={{ height: virt.bottomPad, padding: 0 }}
                    />
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
        {failCount > 0 && rowFilter !== 'failed' && (
          <div className={styles.importQueueHint}>
            有 <strong>{failCount}</strong> 项失败/无效（已优先排到列表前）。
            <button
              type="button"
              className={styles.linkBtn}
              onClick={() => setRowFilter('failed')}
            >
              只看失败
            </button>
          </div>
        )}

        <div className={styles.importFilterBar} role="tablist" aria-label="队列筛选">
          {(
            [
              ['all', `全部 ${totalCount}`],
              ['failed', `失败 ${failCount}`],
              ['ready', `可导入 ${readyCount}`],
              ['dup', `重复 ${dupCount}`],
              ['pending', `待校验 ${pendingCount}`],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={rowFilter === id}
              className={rowFilter === id ? `${styles.tab} active` : styles.tab}
              onClick={() => {
                setRowFilter(id)
                setListScrollTop(0)
                if (queueScrollRef.current) queueScrollRef.current.scrollTop = 0
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <footer className={styles.modalFoot}>
          <span>
            总计 {totalCount} 项 · 可导入 {readyCount} · 待校验 {pendingCount} · 重复{' '}
            {dupCount} · 失败/无效 {failCount}
            {doneCount > 0 && ` · 已导入 ${doneCount}`}
            {importingCount > 0 && ` · 进行中 ${importingCount}`}
          </span>
          <span className={styles.spacer} />
          {failCount > 0 && <button onClick={removeFailed}>移除失败项</button>}
          {rows.some((r) => r.state === 'failed') && (
            <button disabled={busy || !!scanStatus} onClick={() => void retryFailed()}>
              重试失败项
            </button>
          )}
          <button onClick={onClose} disabled={!!scanStatus}>
            关闭
          </button>
          <button
            className={styles.primary}
            disabled={busy || !!scanStatus || selectedReady === 0}
            onClick={() => void importSelected()}
          >
            导入选中的 {selectedReady} 项
          </button>
        </footer>
      </div>
    </div>
  )
}
