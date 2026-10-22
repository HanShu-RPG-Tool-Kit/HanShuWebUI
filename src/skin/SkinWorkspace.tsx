/**
 * MC 皮肤管理工作区(新版):
 *   顶部:标题 + 搜索 + 导入 + 布局切换
 *   左侧:范围导航 + 文件夹树 + 筛选排序
 *   中间:面包屑 + 返回上级 + 子文件夹卡片 + 皮肤网格/列表 + 批量工具条
 *   右侧:详情面板（就地编辑）
 *
 * 支持:
 *   - v5 数据模型(自由字符串 tags，随皮肤存在并自动收集)
 *   - 正反筛选、排序、三种布局(大图标/小图标/列表)
 *   - 右键菜单(空白/文件夹/单皮肤/多选)
 *   - 返回上级导航
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getBoundProject,
  subscribeProjectBinding,
  type BoundProject,
} from '../project'
import { getSkinApi, resetSkinApiCache } from './api/index.ts'
import type { GcOrphansProgress, SkinApi } from './api/SkinApi.ts'
import { PROJECT_SKIN_ROOT_LABEL } from './api/projectAdapter.ts'
import { FolderTree } from './components/FolderTree.tsx'
import { ImportQueuePanel } from './components/ImportQueuePanel.tsx'
import { SkinThumb } from './components/SkinThumb.tsx'
import { ContextMenu, type ContextMenuItem } from './components/ContextMenu.tsx'
import { LibraryFilters } from './components/LibraryFilters.tsx'
import { LibraryTable } from './components/LibraryTable.tsx'
import { EntryDetails } from './components/EntryDetails.tsx'
import { recoverableEntryDrafts } from './local/entryDraft'
import { captureFolderScope, folderSnapshot } from './local/operationSnapshot'
import { FilePresenceBar } from '../project/FilePresenceBar'
import { useFileEditing } from '../project/useFileEditing'
import { ResourceSaveStatus } from '../project/ResourceSaveStatus'
import type { ProjectClient } from '../project/serviceClient'
import { SKIN_INDEX_PATH } from './local/entrySubmission'
import { useOperationRecovery } from './components/useOperationRecovery'
import { TagPicker } from './components/TagPicker.tsx'
import { TextureViewerDialog } from './components/TextureViewerDialog.tsx'
import type {
  EntrySortBy,
  FolderWithStats,
  FolderScopeSnapshot,
  LibraryEntry,
  SkinEvent,
  SkinModel,
  SortDirection,
  CollectedTag,
  CollectedTextureSize,
} from './contracts/types.ts'
import './styles/workspace-shell.css'
import styles from './styles/workspace.module.css'

type Scope = 'all' | 'favorites' | 'recent' | 'folder'
type LayoutMode = 'large' | 'small' | 'list'
type ThumbType = 'avatar' | 'bust' | 'full' | 'flat'

const HOVER_ENTER_DELAY = 200
const HOVER_LEAVE_DELAY = 200

export interface SkinWorkspaceProps {
  /** Workspace visibility: hidden → 3D canvas unmounted, animations paused. */
  active: boolean
}

interface ContextMenuState {
  x: number
  y: number
  items: ContextMenuItem[]
}

export function SkinWorkspace({ active }: SkinWorkspaceProps) {
  const [api, setApi] = useState<SkinApi | null>(null)
  const [apiOwner, setApiOwner] = useState<BoundProject['handle']['client'] | null>(null)
  const [initError, setInitError] = useState<string | null>(null)
  const [project, setProject] = useState<BoundProject | null>(() =>
    getBoundProject(),
  )
  useFileEditing(project?.handle.client)
  const readOnly = project?.handle.client.snapshot.role === 'viewer'

  const [tags, setTags] = useState<CollectedTag[]>([])
  const [textureSizes, setTextureSizes] = useState<CollectedTextureSize[]>([])
  const [folders, setFolders] = useState<FolderWithStats[]>([])

  const [entries, setEntries] = useState<LibraryEntry[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const pageSize = 48
  const [search, setSearch] = useState('')
  const [scope, setScope] = useState<Scope>('folder')
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null)

  // Filters
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [activeFilter, setActiveFilter] = useState<'all' | 'active' | 'inactive'>('all')
  const [modelFilter, setModelFilter] = useState<SkinModel | 'all'>('all')
  const [textureWidthFilter, setTextureWidthFilter] = useState<number[]>([])
  const [licenseFilter, setLicenseFilter] = useState('')
  const [authorFilter, setAuthorFilter] = useState('')
  const [sortBy, setSortBy] = useState<EntrySortBy>('createdAt')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')

  const [pinned, setPinned] = useState<LibraryEntry | null>(null)
  const [detailDirty, setDetailDirty] = useState<Record<string, boolean>>({})
  const reportDetailDirty = useCallback((entryId: string, dirty: boolean) => {
    setDetailDirty(previous => previous[entryId] === dirty ? previous : { ...previous, [entryId]: dirty })
  }, [])
  const skinClient = project?.handle.client
  useEffect(() => {
    if (!skinClient || apiOwner !== skinClient) return
    skinClient.transactions.setEditorDirty('skin:details', Object.values(detailDirty).some(Boolean) ? [SKIN_INDEX_PATH] : [])
    return () => skinClient.transactions.setEditorDirty('skin:details', [])
  }, [skinClient, apiOwner, detailDirty])
  const [hovered, setHovered] = useState<LibraryEntry | null>(null)
  // Selection carries the revisions that were visible when selected, including
  // off-page entries; a remote refresh cannot silently approve newer contents.
  const [checked, setChecked] = useState<Map<string, number>>(new Map())

  const [showImport, setShowImport] = useState(false)
  const [showOuter, setShowOuter] = useState(true)
  const [walking, setWalking] = useState(true)
  const [autoRotate, setAutoRotate] = useState(true)
  const [notice, setNotice] = useState<string | null>(null)
  const [recoveryDrafts, setRecoveryDrafts] = useState<ReturnType<typeof recoverableEntryDrafts>>([])
  const [listError, setListError] = useState<string | null>(null)
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('large')
  const [thumbType, setThumbType] = useState<ThumbType>('full')
  const [moveDialog, setMoveDialog] = useState<{ entryIds: string[]; expectedRevisions: number[] } | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [textureViewerFor, setTextureViewerFor] = useState<LibraryEntry | null>(null)
  const [newFolderUnder, setNewFolderUnder] = useState<string | null | 'root' | undefined>(undefined)
  const [newFolderName, setNewFolderName] = useState('')
  const [renameFolderDialog, setRenameFolderDialog] = useState<{ folder: FolderWithStats; name: string } | null>(null)
  const [moveFolderTarget, setMoveFolderTarget] = useState<FolderWithStats | null>(null)
  /** 删除文件夹内全部皮肤：三次确认 */
  const [wipeFolderDialog, setWipeFolderDialog] = useState<
    | null
    | { folder: FolderWithStats; scope: FolderScopeSnapshot; step: 1 | 2 | 3; busy?: boolean; error?: string }
  >(null)
  /** 清理黑户：确认 → 运行中锁定 → 结果 */
  const [gcDialog, setGcDialog] = useState<
    | null
    | { stage: 'confirm' }
    | { stage: 'running'; progress: GcOrphansProgress }
    | {
        stage: 'done'
        removedObjects: number
        removedPreviews: number
        protectedCount: number
      }
    | { stage: 'error'; message: string }
  >(null)

  const hoverLeaveTimer = useRef<number | null>(null)
  const hoverEnterTimer = useRef<number | null>(null)
  const lastRevisionRef = useRef<number>(0)
  const searchDebounceRef = useRef<number | null>(null)
  const requestSeqRef = useRef(0)
  const apiClientRef = useRef(project?.handle.client)

  const folderById = useMemo(() => new Map(folders.map((f) => [f.folderId, f])), [folders])

  useEffect(() => subscribeProjectBinding(setProject), [])

  /* ---------- init: resolve the API when project binding changes ---------- */
  useEffect(() => {
    let cancelled = false
    resetSkinApiCache()
    // A remote library refresh keeps the same editor mounted, including its focus.
    // Only changing the actual project connection resets the workspace selection.
    if (apiClientRef.current !== project?.handle.client) {
      apiClientRef.current = project?.handle.client
      setApi(null)
      setPinned(null)
      setDetailDirty({})
      setHovered(null)
      setRecoveryDrafts([])
    }
    setInitError(null)
    if (!project) {
      setEntries([])
      setTags([])
      setFolders([])
      setTotal(0)
      return () => {
        cancelled = true
      }
    }
    void getSkinApi()
      .then((a) => {
        if (!cancelled) { setApi(a); setApiOwner(project.handle.client) }
      })
      .catch((e) => {
        if (!cancelled) setInitError((e as Error).message)
      })
    return () => {
      cancelled = true
    }
  }, [project])

  const refreshTags = useCallback(async () => {
    if (!api) return
    try {
      const tree = await api.listTags()
      setTags(tree.tags)
      setTextureSizes(tree.textureSizes ?? [])
      lastRevisionRef.current = tree.revision
    } catch (e) { setListError((e as Error)?.message ?? '加载皮肤标签失败') }
  }, [api])

  const refreshFolders = useCallback(async () => {
    if (!api) return
    try {
      const tree = await api.listFolders()
      setFolders(tree.folders)
    } catch (e) { setListError((e as Error)?.message ?? '加载皮肤文件夹失败') }
  }, [api])

  // Search input is debounced (~250ms); the debounced value drives the query
  // so keystrokes do not fire a request each. Other filter changes refresh
  // immediately via the effect below.
  const [debouncedSearch, setDebouncedSearch] = useState('')
  useEffect(() => {
    if (searchDebounceRef.current !== null) {
      window.clearTimeout(searchDebounceRef.current)
    }
    searchDebounceRef.current = window.setTimeout(() => {
      searchDebounceRef.current = null
      setDebouncedSearch(search)
    }, 250)
    return () => {
      if (searchDebounceRef.current !== null) {
        window.clearTimeout(searchDebounceRef.current)
        searchDebounceRef.current = null
      }
    }
  }, [search])

  const refresh = useCallback(async () => {
    if (!api) return
    const seq = ++requestSeqRef.current

    let folderId: string | null | undefined
    let scopeParam: 'all' | 'unfiled' | 'folder' | undefined
    if (scope === 'folder') {
      scopeParam = 'folder'
      folderId = currentFolderId
    } else {
      scopeParam = 'all'
    }

    const activeParam = activeFilter === 'all' ? undefined : activeFilter === 'active'
    const modelsParam = modelFilter === 'all' ? undefined : [modelFilter]
    // License filter: empty = no filter; "未声明" = unspecified-only; text = name contains.
    const licenseTrim = licenseFilter.trim()
    const licenseUnspecified = licenseTrim === '未声明' ? true : undefined
    const includeLicenseNames = licenseTrim && licenseTrim !== '未声明' ? [licenseTrim] : undefined

    let result: Awaited<ReturnType<SkinApi['listEntries']>>
    try {
      result = await api.listEntries({
        search: debouncedSearch || undefined,
        tags: selectedTags.length ? selectedTags : undefined,
        tagMatch: selectedTags.length > 1 ? 'any' : undefined,
        active: activeParam,
        models: modelsParam,
        textureWidths: textureWidthFilter.length ? textureWidthFilter : undefined,
        author: authorFilter.trim() || undefined,
        includeLicenseNames,
        licenseUnspecified,
        favorite: scope === 'favorites' ? true : undefined,
        scope: scopeParam,
        folderId,
        // "最近导入" is a whole-library server-side sort, not a re-sort of the
        // current page — pagination must reflect the full-library order.
        sortBy: scope === 'recent' ? 'createdAt' : sortBy,
        sortDirection: scope === 'recent' ? 'desc' : sortDirection,
        page,
        pageSize,
      })
    } catch (e) {
      // A failed query must not leave the pane silently empty: surface the
      // error and allow retry. (This was the cause of "list shows nothing
      // while the library actually has entries" after a transient failure.)
      if (seq === requestSeqRef.current) {
        setListError((e as Error)?.message ?? '查询皮肤库失败')
      }
      return
    }
    if (seq !== requestSeqRef.current) return

    setListError(null)
    setEntries(result.entries)
    setTotal(result.total)
  }, [api, debouncedSearch, scope, currentFolderId, selectedTags, activeFilter, modelFilter, textureWidthFilter, licenseFilter, authorFilter, sortBy, sortDirection, page])

  // Boot folders/tags once per API; entry list tracks `refresh` identity (filters).
  useEffect(() => {
    if (!api) return
    let cancelled = false
    const loadMeta = async () => {
      try {
        await Promise.all([refreshFolders(), refreshTags()])
      } catch (e) {
        if (!cancelled) {
          setListError((e as Error)?.message ?? '加载皮肤库失败')
        }
      }
    }
    void loadMeta()
    return () => {
      cancelled = true
    }
  }, [api, refreshFolders, refreshTags])

  useEffect(() => {
    if (!api) return
    void refresh()
  }, [api, refresh])

  /* ---------- events: subscribe first, then query snapshots ---------- */
  useEffect(() => {
    if (!api) return
    let disposed = false
    let unsub: (() => void) | null = null
    void api
      .subscribe((event: SkinEvent) => {
        if (disposed) return
        if (event.type === 'job-updated') {
          void refresh()
        } else if (event.type === 'library-updated') {
          if (event.revision <= lastRevisionRef.current && event.revision !== 0) return
          lastRevisionRef.current = event.revision
          if (event.domain === 'tags') {
            void refreshTags()
            void refresh()
          } else if (event.domain === 'folders') {
            void refreshFolders()
            void refresh()
          } else {
            void refresh()
            void refreshTags()
            void refreshFolders()
          }
        }
      })
      .then((off) => {
        if (disposed) {
          off()
        } else {
          unsub = off
        }
      })
      .catch(e => { if (!disposed) setListError((e as Error)?.message ?? '订阅皮肤库更新失败') })
    return () => {
      disposed = true
      unsub?.()
    }
  }, [api, refresh, refreshTags, refreshFolders])

  // pinned 可能在外部被修改;详情与列表查询分离——直接按 entryId 拉取,
  // 即使条目暂时不在当前页也不展示旧值。
  useEffect(() => {
    if (!api || !pinned) return
    let cancelled = false
    const t = window.setTimeout(() => {
      void api
        .getEntry(pinned.entryId)
        .then((fresh) => {
          if (!cancelled && fresh.revision !== pinned.revision) setPinned(fresh)
        })
        .catch(() => {
          /* entry deleted elsewhere; the next list refresh clears it */
        })
    }, 150)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [api, pinned, entries])

  useEffect(() => {
    setPage(1)
    setChecked(new Map())
  }, [debouncedSearch, scope, currentFolderId, selectedTags, activeFilter, modelFilter, textureWidthFilter, licenseFilter, authorFilter])

  /* ---------- hover / pinned ---------- */

  const displayed: LibraryEntry | null = hovered ?? pinned

  const cancelHoverLeave = () => {
    if (hoverLeaveTimer.current !== null) {
      window.clearTimeout(hoverLeaveTimer.current)
      hoverLeaveTimer.current = null
    }
  }

  const cancelHoverEnter = () => {
    if (hoverEnterTimer.current !== null) {
      window.clearTimeout(hoverEnterTimer.current)
      hoverEnterTimer.current = null
    }
  }

  // 进入约 200ms 后才悬浮预览:鼠标扫过多张卡片时只处理最终候选。
  const onCardEnter = (e: LibraryEntry) => {
    cancelHoverLeave()
    cancelHoverEnter()
    hoverEnterTimer.current = window.setTimeout(() => {
      hoverEnterTimer.current = null
      setHovered(e)
    }, HOVER_ENTER_DELAY)
  }

  const onCardLeave = () => {
    cancelHoverEnter()
    cancelHoverLeave()
    hoverLeaveTimer.current = window.setTimeout(() => {
      setHovered(null)
      hoverLeaveTimer.current = null
    }, HOVER_LEAVE_DELAY)
  }

  const onRightEnter = () => {
    cancelHoverLeave()
  }

  const onRightLeave = () => {
    if (hovered) {
      cancelHoverLeave()
      hoverLeaveTimer.current = window.setTimeout(() => {
        setHovered(null)
        hoverLeaveTimer.current = null
      }, HOVER_LEAVE_DELAY)
    }
  }

  useEffect(() => {
    setHovered(null)
    setPinned(null)
  }, [scope, currentFolderId, search, page])

  const directChildFolders: FolderWithStats[] = useMemo(() => {
    if (scope !== 'folder') return []
    const parent = currentFolderId
    return folders
      .filter((f) => (f.parentId ?? null) === parent)
      .sort((a, b) => a.sortOrder - b.sortOrder)
  }, [folders, scope, currentFolderId])

  /* ---------- preview URL helper (object URL cache) ---------- */
  const previewUrls = useMemo(() => new Map<string, Promise<string>>(), [api])
  const getPreviewUrl = useCallback(
    (skinId: string): Promise<string> => {
      let p = previewUrls.get(skinId)
      if (!p) {
        p = api?.getPreviewUrl(skinId)
        if (!p) return Promise.reject(new Error('皮肤 API 尚未就绪'))
        const request = p
        p = request.catch(error => { previewUrls.delete(skinId); throw error })
        previewUrls.set(skinId, p)
      }
      return p
    },
    [api, previewUrls],
  )

  // TextureViewer needs a resolved URL for its locked entry.
  const [texturePreviewUrl, setTexturePreviewUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!textureViewerFor) {
      setTexturePreviewUrl(null)
      return
    }
    let cancelled = false
    void getPreviewUrl(textureViewerFor.skinId).then((u) => {
      if (!cancelled) setTexturePreviewUrl(u)
    }).catch(e => { if (!cancelled) { setTexturePreviewUrl(null); setNotice((e as Error)?.message ?? '加载皮肤预览失败') } })
    return () => {
      cancelled = true
    }
  }, [textureViewerFor, getPreviewUrl])

  /* ---------- render guards (after hooks) ---------- */

  if (!project) {
    return (
      <div className={`skinWorkspace ${styles.workspace}`} data-active={active ? '1' : '0'}>
        <div className={styles.empty} style={{ padding: 48, maxWidth: 480 }}>
          <h2 style={{ marginTop: 0 }}>需要先打开剧本工程</h2>
          <p>
            皮肤库现在保存在工程目录的{' '}
            <code>{PROJECT_SKIN_ROOT_LABEL}</code>，与剧本共用同一文件夹。
          </p>
          <p>请切换到「剧本」工作区：文件 → 打开工程… / 新建工程…</p>
        </div>
      </div>
    )
  }

  if (initError) {
    return (
      <div className={`skinWorkspace ${styles.workspace}`} data-active={active ? '1' : '0'}>
        <p className={styles.error} style={{ padding: 24 }}>
          皮肤库初始化失败：{initError}
        </p>
      </div>
    )
  }

  if (!api || apiOwner !== project.handle.client) {
    return (
      <div className={`skinWorkspace ${styles.workspace}`} data-active={active ? '1' : '0'}>
        <p className={styles.empty} style={{ padding: 24 }}>
          正在打开皮肤库（{project.folderName}/{PROJECT_SKIN_ROOT_LABEL}）…
        </p>
      </div>
    )
  }

  const showNotice = (msg: string) => {
    setNotice(msg)
    setTimeout(() => setNotice(null), 2500)
  }

  const asError = (e: unknown): string => (e as Error)?.message ?? String(e)

  const copySkinCode = async (skinId: string) => {
    const text = (await api.getSkinCode(skinId)).trim()
    await navigator.clipboard.writeText(text)
    showNotice('皮肤字符串已复制')
  }

  /** 内容 ID(skinId)完整值 — 显示用短前缀,复制永远是完整 64 位。 */
  const copyContentId = async (skinId: string) => {
    await navigator.clipboard.writeText(skinId)
    showNotice('内容 ID(完整)已复制')
  }

  /* ---- folder callbacks ---- */
  const createFolder = async (name: string, parentId: string | null): Promise<string | null> => {
    try {
      await api.createFolder({ name, parentId })
      await refreshFolders()
      return null
    } catch (e) {
      return asError(e)
    }
  }
  const renameFolder = async (folder: FolderWithStats, name: string): Promise<string | null> => {
    try {
      await api.patchFolder(folder.folderId, { name, expectedFolder: folderSnapshot(folder) })
      await refreshFolders()
      return null
    } catch (e) {
      return asError(e)
    }
  }
  const moveFolder = async (folder: FolderWithStats, parentId: string | null): Promise<string | null> => {
    try {
      await api.patchFolder(folder.folderId, { parentId, expectedFolder: folderSnapshot(folder) })
      await refreshFolders()
      return null
    } catch (e) {
      return asError(e)
    }
  }
  const sortFolderSiblings = async (folder: FolderWithStats): Promise<void> => {
    try {
      await api.patchFolder(folder.folderId, {
        sortSiblingsByName: true,
        expectedFolder: folderSnapshot(folder),
        expectedSiblings: folders.filter(sibling => sibling.parentId === folder.parentId).map(folderSnapshot),
      })
      await refreshFolders()
    } catch (e) {
      showNotice(`排序失败：${asError(e)}`)
    }
  }
  const deleteFolder = async (folder: FolderWithStats): Promise<void> => {
    try {
      await api.deleteFolder(folder.folderId, folderSnapshot(folder))
      if (currentFolderId === folder.folderId) {
        setScope('folder')
        setCurrentFolderId(null)
      }
      await refreshFolders()
      await refresh()
    } catch (e) {
      showNotice(`删除文件夹失败：${asError(e)}`)
    }
  }
  const beginWipeFolder = async (folder: FolderWithStats) => {
    try {
      const snapshot = await captureFolderScope(api, folder.folderId, folder)
      const current = snapshot.folders.find(item => item.folderId === folder.folderId)!
      setWipeFolderDialog({ folder: { ...folder, ...current, subtreeCount: snapshot.entries.length }, scope: snapshot, step: 1 })
    } catch (e) { showNotice(asError(e)) }
  }

  /* ---- 面包屑 ---- */
  const breadcrumb = (): { label: string; onClick?: () => void }[] => {
    const goRoot = () => {
      setScope('folder')
      setCurrentFolderId(null)
    }
    if (scope === 'folder') {
      if (currentFolderId === null) return [{ label: '皮肤库' }]
      const f = folderById.get(currentFolderId)
      if (!f) return [{ label: '皮肤库', onClick: goRoot }, { label: '文件夹' }]
      const segments = f.path
      const trail: { label: string; onClick?: () => void }[] = [
        { label: '皮肤库', onClick: goRoot },
      ]
      let cur: FolderWithStats | undefined = folders.find(
        (x) => x.name === segments[0] && x.parentId === null,
      )
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i]
        if (!cur || cur.name !== seg) {
          trail.push({ label: seg })
          cur = undefined
          continue
        }
        const id = cur.folderId
        const isLast = i === segments.length - 1
        trail.push({
          label: seg,
          onClick: isLast
            ? undefined
            : () => {
                setScope('folder')
                setCurrentFolderId(id)
              },
        })
        cur = folders.find((x) => x.parentId === cur!.folderId && x.name === segments[i + 1])
      }
      return trail
    }
    switch (scope) {
      case 'favorites':
        return [{ label: '收藏' }]
      case 'recent':
        return [{ label: '最近导入' }]
      default:
        return [{ label: '全部皮肤' }]
    }
  }

  const toggleChecked = (entryId: string) => {
    const revision = entries.find(entry => entry.entryId === entryId)?.revision
    setChecked((prev) => {
      const next = new Map(prev)
      if (next.has(entryId)) next.delete(entryId)
      else if (revision !== undefined) next.set(entryId, revision)
      return next
    })
  }

  const showEntryPath = scope !== 'folder'
  const entryPathLabel = (e: LibraryEntry): string => {
    if (e.folderId === null) return '皮肤库'
    return folderById.get(e.folderId)?.path.join(' / ') ?? ''
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  /* ---------- 移动条目 ---------- */
  const doMoveEntries = async (targetFolderId: string | null): Promise<string | null> => {
    if (!moveDialog) return null
    try {
      await api.batchPatchEntries({
        entryIds: moveDialog.entryIds,
        expectedRevisions: moveDialog.expectedRevisions,
        folderId: targetFolderId,
      })
      const targetLabel =
        targetFolderId === null
          ? '皮肤库'
          : (folderById.get(targetFolderId)?.path.join(' / ') ?? '')
      showNotice(`已移动 ${moveDialog.entryIds.length} 个条目到 ${targetLabel}`)
      setMoveDialog(null)
      setChecked(new Map())
      await refresh()
      await refreshFolders()
      return null
    } catch (e) {
      return `移动失败：${asError(e)}`
    }
  }

  /* ---------- 右键菜单 ---------- */
  const openContextMenu = (e: React.MouseEvent, items: ContextMenuItem[]) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, items })
  }

  const closeContextMenu = () => setContextMenu(null)

  /* ---------- 返回上级 ---------- */
  const goUp = () => {
    if (scope !== 'folder' || currentFolderId === null) return
    const current = folderById.get(currentFolderId)
    if (!current) return
    if (current.parentId) {
      setCurrentFolderId(current.parentId)
    } else {
      setScope('folder')
      setCurrentFolderId(null)
    }
  }

  /* ---------- 布局切换 ---------- */
  const layoutIcons: Record<LayoutMode, string> = {
    large: '大图标',
    small: '小图标',
    list: '列表',
  }

  /* ---------- 反转当前页选择 ---------- */
  const invertSelection = () => {
    setChecked((prev) => {
      const next = new Map(prev)
      for (const e of entries) {
        if (next.has(e.entryId)) next.delete(e.entryId)
        else next.set(e.entryId, e.revision)
      }
      return next
    })
  }

  /* ---------- 批量启用/禁用 ---------- */
  const batchSetActive = async (active: boolean) => {
    if (checked.size === 0) return
    try {
      const entryIds = [...checked.keys()]
      const expectedRevisions = [...checked.values()]
      await api.batchPatchEntries({ entryIds, active, expectedRevisions })
      setChecked(new Map())
      await refresh()
      showNotice(active ? '已启用选中条目' : '已禁用选中条目')
    } catch (e) {
      showNotice(`操作失败:${asError(e)}`)
    }
  }

  /** 启用/禁用某文件夹及其子文件夹内的全部皮肤条目。 */
  const batchSetFolderActive = async (
    folder: FolderWithStats,
    active: boolean,
  ) => {
    if (!api) return
    try {
      const snapshot = await captureFolderScope(api, folder.folderId, folder)
      if (snapshot.entries.length === 0) {
        showNotice(`「${folder.name}」内没有皮肤`)
        return
      }
      const result = await api.batchPatchEntries({
        entryIds: snapshot.entries.map(entry => entry.entryId),
        expectedRevisions: snapshot.entries.map(entry => entry.revision),
        active,
      })
      const updated = result.updated
      await refresh()
      await refreshFolders()
      showNotice(
        active
          ? `已启用「${folder.name}」及子夹内 ${updated} 个皮肤`
          : `已禁用「${folder.name}」及子夹内 ${updated} 个皮肤`,
      )
    } catch (e) {
      showNotice(`操作失败:${asError(e)}`)
    }
  }

  /* ---------- 从导入面板定位已存在条目 ---------- */
  const locateEntry = async (entryId: string, folderId: string | null) => {
    // Clear every filter so the target entry is guaranteed to be visible,
    // navigate to its folder, then fetch and pin it directly.
    setSearch('')
    setSelectedTags([])
    setActiveFilter('all')
    setModelFilter('all')
    setTextureWidthFilter([])
    setLicenseFilter('')
    setAuthorFilter('')
    setPage(1)
    if (folderId) {
      setScope('folder')
      setCurrentFolderId(folderId)
    } else {
      setScope('folder')
      setCurrentFolderId(null)
    }
    try {
      const fresh = await api.getEntry(entryId)
      setPinned(fresh)
    } catch {
      /* the list refresh will surface it */
    }
  }

  /* ---------- 导出已启用清单 ---------- */
  const exportUsableManifest = async () => {
    try {
      // Real server-side query over the whole library — not the current page.
      const manifest = await api.exportUsableManifest()
      const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'usable-manifest.json'
      a.click()
      URL.revokeObjectURL(url)
      showNotice(`已导出 ${manifest.count} 条已启用素材清单`)
    } catch (e) {
      showNotice(`导出失败:${asError(e)}`)
    }
  }

  /* ---------- 渲染卡片 ---------- */
  const renderCard = (e: LibraryEntry) => {
    const isPinned = pinned?.entryId === e.entryId
    const isHovered = hovered?.entryId === e.entryId
    const isChecked = checked.has(e.entryId)
    return (
      <div
        key={e.entryId}
        className={styles.cardWrap}
        onMouseEnter={() => onCardEnter(e)}
        onMouseLeave={onCardLeave}
        onContextMenu={(ev) => {
          if (!checked.has(e.entryId)) {
            setPinned(e)
          }
          openContextMenu(ev, entryContextMenuItems(e))
        }}
      >
        <button
          className={[
            styles.card,
            layoutMode === 'small' ? styles.cardSmall : '',
            isPinned ? styles.selected : '',
            isHovered && !isPinned ? styles.hovered : '',
            isChecked ? styles.checked : '',
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={() => setPinned(e)}
        >
          <span
            className={`${styles.cardStatus} ${e.active ? styles.cardStatusOn : styles.cardStatusOff}`}
            title={e.active ? '已启用' : '已禁用'}
            aria-label={e.active ? '已启用' : '已禁用'}
          />
          <PreviewImage
            skinId={e.skinId}
            model={e.model}
            getPreviewUrl={getPreviewUrl}
            alt={e.name}
            thumbType={thumbType}
          />
          <span className={styles.cardName}>
            {e.favorite ? '★ ' : ''}
            {e.name}
          </span>
          {showEntryPath && <span className={styles.cardPath}>{entryPathLabel(e)}</span>}
          {!showEntryPath && <span className={styles.cardModel}>{e.model}</span>}
        </button>
        <label className={styles.cardCheck} title="批量勾选">
          <input
            type="checkbox"
            checked={isChecked}
            onChange={() => toggleChecked(e.entryId)}
            aria-label={`选择 ${e.name}`}
          />
        </label>
      </div>
    )
  }

  /* ---------- 右键菜单项 ---------- */
  const startGcOrphans = () => {
    if (!api) return
    setGcDialog({ stage: 'confirm' })
  }

  const runGcOrphans = async () => {
    if (!api) return
    setGcDialog({
      stage: 'running',
      progress: {
        phase: 'scanning',
        current: 0,
        total: 0,
        label: '正在扫描引用与对象…',
      },
    })
    try {
      const r = await api.gcOrphans((p) => {
        setGcDialog({
          stage: 'running',
          progress: {
            ...p,
            label: gcProgressLabel(p),
          },
        })
      })
      setGcDialog({
        stage: 'done',
        removedObjects: r.removedObjects,
        removedPreviews: r.removedPreviews,
        protectedCount: r.protectedCount,
      })
      void refresh()
    } catch (e) {
      setGcDialog({ stage: 'error', message: asError(e) })
    }
  }

  const blankContextMenuItems: ContextMenuItem[] = [
    { label: '导入到这里', disabled: readOnly, onClick: () => setShowImport(true) },
    {
      label: '新建文件夹',
      disabled: readOnly,
      onClick: () => {
        // 聚合视图默认根目录;文件夹内建在当前位置。弹窗显示目标位置。
        setNewFolderUnder(
          scope === 'folder' ? (currentFolderId ?? 'root') : 'root',
        )
        setNewFolderName('')
      },
    },
    { separator: true, label: '', onClick: () => {} },
    { label: `布局: ${layoutIcons[layoutMode]}`, onClick: () => {} },
    { label: '大图标', onClick: () => setLayoutMode('large') },
    { label: '小图标', onClick: () => setLayoutMode('small') },
    { label: '列表', onClick: () => setLayoutMode('list') },
    { separator: true, label: '', onClick: () => {} },
    { label: '清理黑户对象/缓存…', disabled: readOnly, onClick: () => startGcOrphans() },
    { label: '刷新', onClick: () => void refresh() },
  ]

  const folderContextMenuItems = (f: FolderWithStats): ContextMenuItem[] => [
    { label: '打开', onClick: () => { setScope('folder'); setCurrentFolderId(f.folderId) } },
    {
      label: '新建子文件夹',
      onClick: () => {
        setNewFolderUnder(f.folderId)
        setNewFolderName('')
      },
    },
    {
      label: '重命名…',
      onClick: () => setRenameFolderDialog({ folder: f, name: f.name }),
    },
    {
      label: '移动到…',
      onClick: () => {
        setMoveFolderTarget(f)
      },
    },
    { label: '同级按名称排序', onClick: () => void sortFolderSiblings(f) },
    { separator: true, label: '', onClick: () => {} },
    {
      label: '全部启用',
      onClick: () => void batchSetFolderActive(f, true),
    },
    {
      label: '全部禁用',
      onClick: () => void batchSetFolderActive(f, false),
    },
    { separator: true, label: '', onClick: () => {} },
    {
      label: '清空皮肤…',
      onClick: () => void beginWipeFolder(f),
      danger: true,
    },
    { label: '删除空文件夹', onClick: () => void deleteFolder(f), danger: true },
  ].map(item => readOnly && !item.separator && item.label !== '打开' ? { ...item, disabled: true } : item)

  const entryContextMenuItems = (e: LibraryEntry): ContextMenuItem[] => {
    const isMulti = checked.size > 1 && checked.has(e.entryId)
    if (isMulti) {
      return [
        { label: `批量启用 (${checked.size})`, disabled: readOnly, onClick: () => void batchSetActive(true) },
        { label: `批量禁用 (${checked.size})`, disabled: readOnly, onClick: () => void batchSetActive(false) },
        { label: '移动到文件夹…', disabled: readOnly, onClick: () => setMoveDialog({ entryIds: [...checked.keys()], expectedRevisions: [...checked.values()] }) },
        { separator: true, label: '', onClick: () => {} },
        { label: '取消选择', onClick: () => setChecked(new Map()) },
      ]
    }
    return [
      { label: e.active ? '禁用' : '启用', disabled: readOnly, onClick: () => void toggleEntryActive(e) },
      { label: readOnly ? '在右侧查看' : '在右侧编辑', onClick: () => setPinned(e) },
      { label: e.favorite ? '取消收藏' : '收藏', disabled: readOnly, onClick: () => void toggleEntryFavorite(e) },
      { separator: true, label: '', onClick: () => {} },
      { label: '复制内容 ID', onClick: () => void copyContentId(e.skinId) },
      { label: '复制皮肤码', onClick: () => void copySkinCode(e.skinId) },
      { separator: true, label: '', onClick: () => {} },
      { label: '导出 PNG', onClick: () => void api.saveExportFile(e.skinId, 'png') },
      { label: '导出 .skin', onClick: () => void api.saveExportFile(e.skinId, 'skin') },
      { label: '导出 .skin.json', onClick: () => void exportPortable(e) },
      { label: '查看展开图', onClick: () => { setPinned(e); setTextureViewerFor(e) } },
      { separator: true, label: '', onClick: () => {} },
      { label: '删除', disabled: readOnly, onClick: () => void deleteEntry(e), danger: true },
    ]
  }

  const toggleEntryActive = async (e: LibraryEntry) => {
    try {
      const updated = await api.patchEntry(e.entryId, {
        revision: e.revision,
        active: !e.active,
      })
      if (pinned?.entryId === updated.entryId) setPinned(updated)
      if (hovered?.entryId === updated.entryId) setHovered(updated)
      void refresh()
    } catch (err) {
      showNotice(`操作失败:${asError(err)}`)
    }
  }

  const toggleEntryFavorite = async (e: LibraryEntry) => {
    try {
      const updated = await api.patchEntry(e.entryId, {
        revision: e.revision,
        favorite: !e.favorite,
      })
      if (pinned?.entryId === updated.entryId) setPinned(updated)
      if (hovered?.entryId === updated.entryId) setHovered(updated)
      void refresh()
    } catch (err) {
      showNotice(`操作失败:${asError(err)}`)
    }
  }

  const deleteEntry = async (e: LibraryEntry) => {
    if (!confirm(`删除「${e.name}」?对象文件保留供其他条目使用。`)) return
    try {
      await api.deleteEntry(e.entryId, e.revision)
      if (pinned?.entryId === e.entryId) setPinned(null)
      if (hovered?.entryId === e.entryId) setHovered(null)
      void refresh()
      void refreshTags()
      void refreshFolders()
    } catch (err) {
      showNotice(`删除失败:${asError(err)}`)
    }
  }

  const exportPortable = async (e: LibraryEntry) => {
    try {
      const portable = await api.exportEntry(e.entryId)
      const blob = new Blob([JSON.stringify(portable, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${e.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 64) || 'skin'}.skin.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      showNotice(`导出失败:${asError(err)}`)
    }
  }

  /* ---------- 主界面 ---------- */
  return (
    <div className={`skinWorkspace ${styles.workspace}`}>
      {active && <FilePresenceBar client={project.handle.client} path={SKIN_INDEX_PATH} mode="optimistic" entryId={pinned?.entryId} dirty={pinned ? detailDirty[pinned.entryId] ?? false : false} label={pinned?.name ?? '皮肤库'} />}
      <main className={`skinWorkspaceLayout ${styles.layout}`}>
        <aside className={`skinWorkspaceLeft ${styles.left}`}>
          <div className={styles.leftTop}>
            <input
              type="search"
              className={styles.sideSearch}
              placeholder={
                scope === 'folder'
                  ? `搜索「${currentFolderId ? (folderById.get(currentFolderId)?.name ?? '') : '皮肤库'}」…`
                  : scope === 'favorites'
                    ? '搜索收藏…'
                    : scope === 'recent'
                      ? '搜索最近导入…'
                      : '搜索全部皮肤…'
              }
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="搜索皮肤"
            />
            <details className={styles.recoveryDrafts} onToggle={e => {
              if (e.currentTarget.open) setRecoveryDrafts(recoverableEntryDrafts(JSON.stringify([
                project.handle.client.connection.url, project.handle.client.snapshot.projectId, project.handle.client.snapshot.session.subjectId,
              ])))
            }}>
              <summary>本窗口草稿</summary>
              {recoveryDrafts.length ? recoveryDrafts.map(recovered => (
                <button type="button" key={recovered.entry.entryId} onClick={() => {
                  setHovered(null); setPinned(recovered.entry)
                }}>{recovered.name || '未命名皮肤'}</button>
              )) : <p>暂无未保存的皮肤详情。</p>}
            </details>
            <nav className={styles.quickNav} aria-label="快速访问">
              <div className={styles.quickNavHead}>
                <span>快速访问</span>
              </div>
              {(
                [
                  {
                    id: 'library',
                    label: '皮肤库',
                    icon: '📁',
                    active: scope === 'folder' && currentFolderId === null,
                    onClick: () => {
                      setScope('folder')
                      setCurrentFolderId(null)
                    },
                  },
                  {
                    id: 'all',
                    label: '全部皮肤',
                    icon: '▦',
                    active: scope === 'all',
                    onClick: () => {
                      setScope('all')
                      setCurrentFolderId(null)
                    },
                  },
                  {
                    id: 'favorites',
                    label: '收藏',
                    icon: '★',
                    active: scope === 'favorites',
                    onClick: () => {
                      setScope('favorites')
                      setCurrentFolderId(null)
                    },
                  },
                  {
                    id: 'recent',
                    label: '最近导入',
                    icon: '◷',
                    active: scope === 'recent',
                    onClick: () => {
                      setScope('recent')
                      setCurrentFolderId(null)
                    },
                  },
                ] as const
              ).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`${styles.navRow}${item.active ? ` ${styles.active}` : ''}`}
                  aria-current={item.active ? 'page' : undefined}
                  onClick={item.onClick}
                >
                  <span className={styles.navIcon} aria-hidden>
                    {item.icon}
                  </span>
                  <span className={styles.navLabel}>{item.label}</span>
                </button>
              ))}
            </nav>
            <FolderTree
              folders={folders}
              selectedFolderId={scope === 'folder' ? currentFolderId : null}
              onSelect={(fid) => {
                setScope('folder')
                setCurrentFolderId(fid)
              }}
              onFolderContextMenu={(f, e) => openContextMenu(e, folderContextMenuItems(f))}
              onBlankContextMenu={(e) =>
                openContextMenu(e, [
                  {
                    label: '新建文件夹',
                    onClick: () => {
                      setNewFolderUnder('root')
                      setNewFolderName('')
                    },
                  },
                ])
              }
            />
          </div>
          <div className={styles.leftBottom}>
            <div className={styles.leftBottomHead}>
              <span>筛选与排序</span>
            </div>
            <div className={styles.leftBottomScroll}>
              <LibraryFilters
                layout="sidebar"
                tags={tags}
                textureSizes={textureSizes}
                selectedTags={selectedTags}
                onSelectedTagsChange={setSelectedTags}
                activeFilter={activeFilter}
                onActiveFilterChange={setActiveFilter}
                modelFilter={modelFilter}
                onModelFilterChange={setModelFilter}
                textureWidthFilter={textureWidthFilter}
                onTextureWidthFilterChange={setTextureWidthFilter}
                licenseFilter={licenseFilter}
                onLicenseFilterChange={setLicenseFilter}
                authorFilter={authorFilter}
                onAuthorFilterChange={setAuthorFilter}
                sortBy={sortBy}
                onSortByChange={setSortBy}
                sortDirection={sortDirection}
                onSortDirectionChange={setSortDirection}
                onClearAll={() => {
                  setSelectedTags([])
                  setActiveFilter('all')
                  setModelFilter('all')
                  setTextureWidthFilter([])
                  setLicenseFilter('')
                  setAuthorFilter('')
                }}
              />
            </div>
          </div>
        </aside>

        <section className={`skinWorkspaceCenter ${styles.grid}`} aria-label="皮肤列表">
          <div className={styles.gridToolbar}>
            <nav className={styles.breadcrumb} aria-label="当前位置">
              {scope === 'folder' && currentFolderId !== null && (
                <>
                  <button className={styles.crumbLink} onClick={goUp}>
                    ↰ 返回上级
                  </button>
                  <span className={styles.crumbSep}>›</span>
                </>
              )}
              {breadcrumb().map((b, i, arr) => (
                <span key={i}>
                  {i > 0 && <span className={styles.crumbSep}>›</span>}
                  {b.onClick ? (
                    <button className={styles.crumbLink} onClick={b.onClick}>
                      {b.label}
                    </button>
                  ) : (
                    <span className={styles.crumbCurrent}>{b.label}</span>
                  )}
                  {i === arr.length - 1 && (
                    <span className={styles.gridCount}>
                      {directChildFolders.length > 0 && `${directChildFolders.length} 个文件夹 · `}
                      {total} 个皮肤条目
                    </span>
                  )}
                </span>
              ))}
            </nav>
            <div className={styles.viewToggles}>
              <div className={styles.layoutToggle} role="tablist" aria-label="布局模式">
                {(['large', 'small', 'list'] as const).map((m) => (
                  <button
                    key={m}
                    role="tab"
                    aria-selected={layoutMode === m}
                    className={layoutMode === m ? styles.active : ''}
                    onClick={() => setLayoutMode(m)}
                  >
                    {layoutIcons[m]}
                  </button>
                ))}
              </div>
              <div className={styles.thumbToggle} role="tablist" aria-label="缩略图类型">
                {(['avatar', 'bust', 'full', 'flat'] as const).map((t) => (
                  <button
                    key={t}
                    role="tab"
                    aria-selected={thumbType === t}
                    className={thumbType === t ? styles.active : ''}
                    onClick={() => setThumbType(t)}
                    disabled={layoutMode === 'list'}
                  >
                    {t === 'avatar' ? '头像' : t === 'bust' ? '半身' : t === 'full' ? '全身' : '展开图'}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {checked.size > 0 && (
            <div className={styles.batchBar} role="toolbar" aria-label="批量操作">
              <span>已勾选 {checked.size} 项</span>
              <button disabled={readOnly} onClick={() => setMoveDialog({ entryIds: [...checked.keys()], expectedRevisions: [...checked.values()] })}>
                移动到文件夹…
              </button>
              <button disabled={readOnly} onClick={() => void batchSetActive(true)}>批量启用</button>
              <button disabled={readOnly} onClick={() => void batchSetActive(false)}>批量禁用</button>
              <button onClick={invertSelection}>反转选择</button>
              {!readOnly && <BatchTagBar
                client={project.handle.client}
                api={api}
                tags={tags}
                entryIds={[...checked.keys()]}
                expectedRevisions={[...checked.values()]}
                onDone={() => {
                  setChecked(new Map())
                  void refresh()
                  void refreshTags()
                }}
              />}
              <button onClick={() => setChecked(new Map())}>取消选择</button>
              <button onClick={() => void exportUsableManifest()}>导出已启用清单</button>
            </div>
          )}

          <div
            className={styles.browsePane}
            onContextMenu={(e) => {
              // Skip only concrete folder/entry cards; gaps and empty space use blank menu.
              const el = e.target as HTMLElement
              if (
                el.closest(
                  `.${styles.folderCard}, .${styles.cardWrap}, .${styles.tableWrap} tbody tr`,
                )
              ) {
                return
              }
              openContextMenu(e, blankContextMenuItems)
            }}
          >
          {directChildFolders.length > 0 && (
            <div className={styles.folderCards} role="list" aria-label="子文件夹">
              {directChildFolders.map((f) => (
                <button
                  key={f.folderId}
                  type="button"
                  role="listitem"
                  className={styles.folderCard}
                  onClick={() => {
                    setScope('folder')
                    setCurrentFolderId(f.folderId)
                  }}
                  onContextMenu={(e) => openContextMenu(e, folderContextMenuItems(f))}
                >
                  <span className={styles.folderCardIcon} aria-hidden>
                    📁
                  </span>
                  <span className={styles.folderCardName}>{f.name}</span>
                  <span className={styles.folderCardCount}>{f.subtreeCount} 项</span>
                </button>
              ))}
            </div>
          )}

          {listError && (
            <p className={styles.listError} role="alert">
              皮肤库查询失败:{listError}{' '}
              <button
                className={styles.linkBtn}
                onClick={() => {
                  setListError(null)
                  void refresh()
                }}
              >
                重试
              </button>
            </p>
          )}
          {entries.length === 0 && directChildFolders.length === 0 && !listError && (
            <p className={styles.empty}>
              {total === 0 &&
              (search || selectedTags.length > 0 || textureWidthFilter.length > 0)
                ? '没有匹配的皮肤。'
                : scope === 'folder'
                  ? currentFolderId === null
                    ? '皮肤库为空。右键空白处可新建文件夹或导入皮肤。'
                    : '此文件夹为空。右键空白处可新建子文件夹或导入皮肤。'
                  : '还没有皮肤,导入文件开始整理。'}
              {(search || selectedTags.length > 0 || textureWidthFilter.length > 0) && (
                <>
                  {' '}
                  <button
                    className={styles.linkBtn}
                    onClick={() => {
                      setSearch('')
                      setSelectedTags([])
                      setTextureWidthFilter([])
                    }}
                  >
                    清空筛选
                  </button>
                </>
              )}
            </p>
          )}

          {layoutMode === 'list' ? (
            <LibraryTable
              entries={entries}
              folders={folders}
              checked={new Set(checked.keys())}
              onToggleChecked={toggleChecked}
              onSelect={(e) => setPinned(e)}
              onContextMenu={(ev, e) => openContextMenu(ev, entryContextMenuItems(e))}
              showPath={showEntryPath}
            />
          ) : (
            <div className={`${styles.cards} ${layoutMode === 'small' ? styles.cardsSmall : ''}`}>
              {entries.map(renderCard)}
            </div>
          )}

          {totalPages > 1 && (
            <div className={styles.pager}>
              <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                上一页
              </button>
              <span>
                {page} / {totalPages}
              </span>
              <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                下一页
              </button>
            </div>
          )}
          </div>
        </section>

        <aside className={`skinWorkspaceRight ${styles.right}`} onMouseEnter={onRightEnter} onMouseLeave={onRightLeave}>
          {displayed ? (
            <EntryDetails
              key={`${project!.handle.client.connection.url}:${project!.handle.client.snapshot.projectId}:${project!.handle.client.snapshot.session.subjectId}:${displayed.entryId}`}
              client={project!.handle.client}
              entry={displayed}
              folders={folders}
              tags={tags}
              showOuter={showOuter}
              walking={walking}
              autoRotate={autoRotate}
              active={active}
              onToggleOuter={setShowOuter}
              onToggleWalking={setWalking}
              onToggleAutoRotate={setAutoRotate}
              onToggleActive={() => void toggleEntryActive(displayed)}
              onToggleFavorite={() => void toggleEntryFavorite(displayed)}
              onCopyId={() => void copyContentId(displayed.skinId)}
              onCopyCode={() => void copySkinCode(displayed.skinId)}
              onExportPng={() => void api.saveExportFile(displayed.skinId, 'png')}
              onExportHskin={() => void api.saveExportFile(displayed.skinId, 'skin')}
              onExportPortable={() => void exportPortable(displayed)}
              onViewTexture={() => setTextureViewerFor(displayed)}
              onDelete={() => void deleteEntry(displayed)}
              getPreviewUrl={getPreviewUrl}
              onPatch={(entryId, body) => api.patchEntry(entryId, body)}
              onDirtyChange={reportDetailDirty}
              onInteract={() => {
                // A hover only previews. Actual interaction selects the entry for presence.
                if (pinned?.entryId !== displayed.entryId) setPinned(displayed)
                if (hovered) setHovered(null)
              }}
              onUpdated={(updated) => {
                if (pinned?.entryId === updated.entryId) setPinned(updated)
                if (hovered?.entryId === updated.entryId) setHovered(updated)
                setEntries((prev) =>
                  prev.map((e) => (e.entryId === updated.entryId ? updated : e)),
                )
                void refreshTags()
                void refreshFolders()
              }}
            />
          ) : (
            <p className={styles.empty}>悬浮查看皮肤,点击后可保留选中。</p>
          )}
          {notice && <p className={styles.notice}>{notice}</p>}
        </aside>

        {showImport && (
          <ImportQueuePanel
            client={project.handle.client}
            api={api}
            folders={folders}
            tags={tags}
            defaultFolderId={scope === 'folder' ? currentFolderId : null}
            onLocateEntry={(entryId, folderId) => void locateEntry(entryId, folderId)}
            onSaved={() => {
              void refresh()
              void refreshTags()
              void refreshFolders()
            }}
            onClose={() => setShowImport(false)}
          />
        )}

        {moveDialog && (
          <MoveToFolderDialog
            client={project.handle.client}
            folders={folders}
            count={moveDialog.entryIds.length}
            onPick={doMoveEntries}
            onClose={() => setMoveDialog(null)}
          />
        )}

        {textureViewerFor && (
          <TextureViewerDialog
            entry={textureViewerFor}
            previewUrl={
              // The dialog locks the entry it opened with; hover cannot switch it.
              texturePreviewUrl ?? ''
            }
            onClose={() => setTextureViewerFor(null)}
          />
        )}

        {gcDialog && (
          <GcOrphansDialog
            state={gcDialog}
            onConfirm={() => void runGcOrphans()}
            onClose={() => {
              if (gcDialog.stage === 'running') return
              if (gcDialog.stage === 'done') {
                showNotice(
                  `已清理黑户：对象 ${gcDialog.removedObjects} · 预览 ${gcDialog.removedPreviews}（保留引用 ${gcDialog.protectedCount}）`,
                )
              }
              setGcDialog(null)
            }}
          />
        )}

        {wipeFolderDialog && (
          <WipeFolderEntriesDialog
            state={wipeFolderDialog}
            onCancel={() => {
              if (wipeFolderDialog.busy) return
              setWipeFolderDialog(null)
            }}
            onAdvance={() => {
              if (!wipeFolderDialog || wipeFolderDialog.busy) return
              if (wipeFolderDialog.step < 3) {
                setWipeFolderDialog({
                  ...wipeFolderDialog,
                  step: (wipeFolderDialog.step + 1) as 1 | 2 | 3,
                })
                return
              }
              void (async () => {
                if (!api) return
                setWipeFolderDialog({ ...wipeFolderDialog, busy: true, error: undefined })
                try {
                  const r = await api.deleteEntriesInFolder(
                    wipeFolderDialog.folder.folderId,
                    wipeFolderDialog.scope,
                  )
                  showNotice(
                    `已删除「${wipeFolderDialog.folder.name}」及子夹内 ${r.deleted} 个皮肤条目`,
                  )
                  setWipeFolderDialog(null)
                  const rootId = wipeFolderDialog.folder.folderId
                  const wiped = new Set<string>([rootId])
                  let grew = true
                  while (grew) {
                    grew = false
                    for (const f of folders) {
                      if (
                        f.parentId &&
                        wiped.has(f.parentId) &&
                        !wiped.has(f.folderId)
                      ) {
                        wiped.add(f.folderId)
                        grew = true
                      }
                    }
                  }
                  if (pinned?.folderId && wiped.has(pinned.folderId)) {
                    setPinned(null)
                  }
                  if (hovered?.folderId && wiped.has(hovered.folderId)) {
                    setHovered(null)
                  }
                  void refresh()
                  void refreshFolders()
                  void refreshTags()
                } catch (e) {
                  setWipeFolderDialog({
                    ...wipeFolderDialog,
                    busy: false,
                    error: asError(e),
                  })
                }
              })()
            }}
          />
        )}

        {newFolderUnder !== undefined && (
          <NewFolderDialog
            client={project.handle.client}
            command="create-folder"
            title={newFolderUnder === 'root' ? '在根目录新建文件夹' : '新建子文件夹'}
            parentLabel={
              newFolderUnder === 'root' || newFolderUnder === null
                ? '根目录'
                : (folderById.get(newFolderUnder)?.path.join(' / ') ?? '')
            }
            initialName={newFolderName}
            onNameChange={setNewFolderName}
            onConfirm={async () => {
              const name = newFolderName.trim()
              if (!name) return '名称不能为空'
              const err = await createFolder(
                name,
                newFolderUnder === 'root' ? null : newFolderUnder,
              )
              if (err) return `新建失败：${err}`
              showNotice('文件夹已创建')
              setNewFolderUnder(undefined)
              setNewFolderName('')
              return null
            }}
            onCancel={() => setNewFolderUnder(undefined)}
          />
        )}

        {renameFolderDialog && (
          <NewFolderDialog
            client={project.handle.client}
            command="patch-folder"
            title="重命名文件夹"
            parentLabel={renameFolderDialog.folder.path.join(' / ')}
            initialName={renameFolderDialog.name}
            confirmLabel="保存名称"
            onNameChange={name => setRenameFolderDialog({ ...renameFolderDialog, name })}
            onConfirm={async () => {
              const error = await renameFolder(renameFolderDialog.folder, renameFolderDialog.name.trim())
              if (error) return `重命名失败：${error}`
              setRenameFolderDialog(null)
              showNotice('文件夹已重命名')
              return null
            }}
            onCancel={() => setRenameFolderDialog(null)}
          />
        )}

        {moveFolderTarget && (
          <MoveToFolderDialog
            client={project.handle.client}
            folders={folders}
            count={0}
            excludeFolderId={moveFolderTarget.folderId}
            title={`移动文件夹「${moveFolderTarget.name}」到:`}
            onPick={async (fid) => {
              const error = await moveFolder(moveFolderTarget, fid)
              if (error) return `移动失败：${error}`
              showNotice('文件夹已移动')
              setMoveFolderTarget(null)
              return null
            }}
            onClose={() => setMoveFolderTarget(null)}
          />
        )}

        {contextMenu && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            items={contextMenu.items}
            onClose={closeContextMenu}
          />
        )}
      </main>
    </div>
  )
}

/* ========================================================================== */
/* 预览图(2D / 3D 缩略图)                                                    */
/* ========================================================================== */

function PreviewImage({
  skinId,
  model,
  getPreviewUrl,
  alt,
  thumbType,
}: {
  skinId: string
  model: 'classic' | 'slim'
  getPreviewUrl: (skinId: string) => Promise<string>
  alt: string
  thumbType: ThumbType
}) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void getPreviewUrl(skinId).then((u) => {
      if (!cancelled) setUrl(u)
    }).catch(() => { if (!cancelled) setUrl(null) })
    return () => {
      cancelled = true
    }
  }, [skinId, getPreviewUrl])
  if (thumbType !== 'flat' && url) {
    return (
      <SkinThumb
        skinId={skinId}
        model={model}
        previewUrl={url}
        alt={alt}
        thumbType={thumbType}
      />
    )
  }
  return url ? (
    <img src={url} alt={alt} loading="lazy" className={`${styles.thumb} ${styles.thumb2d}`} />
  ) : (
    <div className={styles.thumb} aria-label={alt} />
  )
}

/* ========================================================================== */
/* 批量打标工具条                                                              */
/* ========================================================================== */

function BatchTagBar({
  client,
  api,
  tags,
  entryIds,
  expectedRevisions,
  onDone,
}: {
  client: ProjectClient
  api: SkinApi
  tags: CollectedTag[]
  entryIds: string[]
  expectedRevisions: number[]
  onDone: () => void
}) {
  const recovery = useOperationRecovery(client)
  const [mode, setMode] = useState<'add' | 'remove' | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [sending, setBusy] = useState(false)
  const busy = sending || recovery.blocked
  useEffect(() => { if (recovery.recovered) onDone() }, [recovery.recovered, onDone])

  const run = async () => {
    if (picked.length === 0 || busy) return
    setBusy(true); setError(null)
    try {
      await recovery.run('batch-patch', () => api.batchPatchEntries({
        entryIds,
        expectedRevisions,
        addTags: mode === 'add' ? picked : undefined,
        removeTags: mode === 'remove' ? picked : undefined,
      }))
      onDone()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (mode === null) {
    return (
      <>
        <button
          onClick={() => {
            setMode('add')
            setPicked([])
          }}
        >
          添加标签
        </button>
        <button
          onClick={() => {
            setMode('remove')
            setPicked([])
          }}
        >
          移除标签
        </button>
      </>
    )
  }
  return (
    <div className={styles.batchPicker}>
      <strong>{mode === 'add' ? '为选中条目添加:' : '从选中条目移除:'}</strong>
      <TagPicker tags={tags} selected={picked} onChange={setPicked} />
      <button disabled={picked.length === 0 || busy} onClick={() => void run()}>
        应用
      </button>
      <button disabled={busy} onClick={() => setMode(null)}>返回</button>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {recovery.transactionId !== undefined && <ResourceSaveStatus client={client} path={SKIN_INDEX_PATH} transactionId={recovery.transactionId} compact />}
    </div>
  )
}

/* ========================================================================== */
/* 移动到文件夹对话框                                                          */
/* ========================================================================== */

function MoveToFolderDialog({
  client,
  folders,
  count,
  title,
  excludeFolderId,
  onPick,
  onClose,
}: {
  client: ProjectClient
  folders: FolderWithStats[]
  count: number
  title?: string
  /** When moving a folder: itself and its descendants are invalid targets. */
  excludeFolderId?: string
  onPick: (folderId: string | null) => Promise<string | null>
  onClose: () => void
}) {
  const recovery = useOperationRecovery(client)
  const [sending, setBusy] = useState(false)
  const busy = sending || recovery.blocked
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { if (recovery.recovered) onClose() }, [recovery.recovered, onClose])
  async function pick(folderId: string | null) {
    if (busy) return
    setBusy(true); setError(null)
    try { setError(await recovery.run(excludeFolderId ? 'patch-folder' : 'batch-patch', () => onPick(folderId))) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  // A folder cannot move into itself or any of its descendants.
  const excluded = useMemo(() => {
    if (!excludeFolderId) return new Set<string>()
    const out = new Set<string>([excludeFolderId])
    let grew = true
    while (grew) {
      grew = false
      for (const f of folders) {
        if (f.parentId && out.has(f.parentId) && !out.has(f.folderId)) {
          out.add(f.folderId)
          grew = true
        }
      }
    }
    return out
  }, [folders, excludeFolderId])

  return (
    <div className={styles.modalBackdrop} onClick={sending ? undefined : onClose}>
      <div
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="移动到文件夹"
      >
        <header className={styles.modalHead}>
          <h3>{title ?? `移动 ${count} 个条目到:`}</h3>
          <button className={styles.iconBtn} disabled={sending} onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>
        <div className={styles.modalBody}>
          {error && <p role="alert" className={styles.errorText}>{error}</p>}
          {recovery.transactionId !== undefined && <ResourceSaveStatus client={client} path={SKIN_INDEX_PATH} transactionId={recovery.transactionId} compact />}
          {sending && <p role="status">正在移动…</p>}
          <button className={styles.folderOption} disabled={busy} onClick={() => void pick(null)}>
            皮肤库{excludeFolderId ? '（根目录）' : ''}
          </button>
          {folders.map((f) => (
            <button
              key={f.folderId}
              className={styles.folderOption}
              style={{ paddingLeft: 12 + (f.path.length - 1) * 16 }}
              disabled={busy || excluded.has(f.folderId)}
              onClick={() => void pick(f.folderId)}
            >
              {f.path.join(' / ')}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ========================================================================== */
/* 删除文件夹内全部皮肤（三次确认）                                             */
/* ========================================================================== */

function WipeFolderEntriesDialog({
  state,
  onCancel,
  onAdvance,
}: {
  state: {
    folder: FolderWithStats
    step: 1 | 2 | 3
    busy?: boolean
    error?: string
  }
  onCancel: () => void
  onAdvance: () => void
}) {
  const count = state.folder.subtreeCount
  const path = state.folder.path.join(' / ')
  const titles = ['确认删除', '再次确认', '最后确认'] as const
  const bodies = [
    `将删除文件夹「${path}」及其所有子文件夹内的全部皮肤条目（当前约 ${count} 个）。文件夹结构本身不会删除。`,
    `再次确认：即将删除「${path}」整棵子树内的全部皮肤条目。对象文件会保留（可供其他条目共用），但条目本身不可恢复。`,
    `最后确认：确定删除「${path}」及子文件夹内全部皮肤？此操作不可撤销。`,
  ] as const
  const btnLabels = ['继续', '仍要删除', '确认删除全部'] as const

  return (
    <div
      className={styles.blockingBackdrop}
      style={state.busy ? { cursor: 'wait' } : undefined}
      role="presentation"
    >
      <div
        className={`${styles.modal} ${styles.gcModal}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={titles[state.step - 1]}
      >
        <header className={styles.modalHead}>
          <h3>
            {titles[state.step - 1]}（{state.step}/3）
          </h3>
          {!state.busy && (
            <button className={styles.iconBtn} onClick={onCancel} aria-label="关闭">
              ✕
            </button>
          )}
        </header>
        <div className={styles.modalBody}>
          <p>{bodies[state.step - 1]}</p>
          {state.error && <p className={styles.errorText}>{state.error}</p>}
        </div>
        <footer className={styles.modalFoot}>
          <button type="button" disabled={state.busy} onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className={styles.primary}
            disabled={state.busy || (state.step === 1 && count === 0)}
            onClick={onAdvance}
          >
            {state.busy ? '删除中…' : btnLabels[state.step - 1]}
          </button>
        </footer>
      </div>
    </div>
  )
}

/* ========================================================================== */
/* 清理黑户（确认 + 锁定进度）                                                 */
/* ========================================================================== */

function gcProgressLabel(p: GcOrphansProgress): string {
  switch (p.phase) {
    case 'scanning':
      return '正在扫描引用与对象…'
    case 'objects':
      return p.total > 0
        ? `正在清理对象 ${p.current} / ${p.total}…`
        : '无黑户对象'
    case 'previews':
      return p.total > 0
        ? `正在清理预览 ${p.current} / ${p.total}…`
        : '无孤立预览'
    case 'done':
      return '清理完成'
    default:
      return p.label || '处理中…'
  }
}

function GcOrphansDialog({
  state,
  onConfirm,
  onClose,
}: {
  state:
    | { stage: 'confirm' }
    | { stage: 'running'; progress: GcOrphansProgress }
    | {
        stage: 'done'
        removedObjects: number
        removedPreviews: number
        protectedCount: number
      }
    | { stage: 'error'; message: string }
  onConfirm: () => void
  onClose: () => void
}) {
  const locked = state.stage === 'running'
  const pct =
    state.stage === 'running' && state.progress.total > 0
      ? Math.min(
          100,
          Math.round((state.progress.current / state.progress.total) * 100),
        )
      : state.stage === 'running'
        ? null
        : state.stage === 'done'
          ? 100
          : null

  return (
    <div
      className={styles.blockingBackdrop}
      style={locked ? { cursor: 'wait' } : undefined}
      onClick={locked ? undefined : onClose}
      role="presentation"
    >
      <div
        className={`${styles.modal} ${styles.gcModal}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-busy={locked || undefined}
        aria-label="清理黑户"
      >
        <header className={styles.modalHead}>
          <h3>清理黑户对象 / 缓存</h3>
          {!locked && (
            <button className={styles.iconBtn} onClick={onClose} aria-label="关闭">
              ✕
            </button>
          )}
        </header>
        <div className={styles.modalBody}>
          {state.stage === 'confirm' && (
            <>
              <p>
                将删除<strong>无条目引用</strong>的皮肤对象与孤立预览缓存。
              </p>
              <p className={styles.hint}>
                未保存的导入校验结果会保留。清理期间界面将锁定，请勿关闭页面。
              </p>
            </>
          )}
          {state.stage === 'running' && (
            <>
              <p className={styles.gcStatus}>{gcProgressLabel(state.progress)}</p>
              <div
                className={styles.gcProgressTrack}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct ?? undefined}
                aria-valuetext={gcProgressLabel(state.progress)}
              >
                <div
                  className={
                    pct == null
                      ? `${styles.gcProgressFill} ${styles.gcProgressIndeterminate}`
                      : styles.gcProgressFill
                  }
                  style={pct == null ? undefined : { width: `${pct}%` }}
                />
              </div>
              <p className={styles.hint}>清理进行中，请稍候…</p>
            </>
          )}
          {state.stage === 'done' && (
            <p>
              已清理：对象 {state.removedObjects} · 预览 {state.removedPreviews}
              （保留引用 {state.protectedCount}）
            </p>
          )}
          {state.stage === 'error' && (
            <p className={styles.errorText}>清理失败：{state.message}</p>
          )}
        </div>
        <footer className={styles.modalFoot}>
          {state.stage === 'confirm' && (
            <>
              <button type="button" onClick={onClose}>
                取消
              </button>
              <button type="button" className={styles.primary} onClick={onConfirm}>
                开始清理
              </button>
            </>
          )}
          {(state.stage === 'done' || state.stage === 'error') && (
            <button type="button" className={styles.primary} onClick={onClose}>
              完成
            </button>
          )}
          {state.stage === 'running' && (
            <button type="button" disabled>
              清理中…
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

/* ========================================================================== */
/* 新建文件夹对话框                                                            */
/* ========================================================================== */

function NewFolderDialog({
  client,
  command,
  title,
  parentLabel,
  initialName,
  confirmLabel = '创建',
  onNameChange,
  onConfirm,
  onCancel,
}: {
  client: ProjectClient
  command: 'create-folder' | 'patch-folder'
  title: string
  parentLabel: string
  initialName: string
  confirmLabel?: string
  onNameChange: (name: string) => void
  onConfirm: () => Promise<string | null>
  onCancel: () => void
}) {
  const recovery = useOperationRecovery(client)
  const [sending, setBusy] = useState(false)
  const busy = sending || recovery.blocked
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { if (recovery.recovered) onCancel() }, [recovery.recovered, onCancel])
  async function confirm() {
    if (busy || !initialName.trim()) return
    setBusy(true); setError(null)
    try { setError(await recovery.run(command, onConfirm)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  return (
    <div className={styles.modalBackdrop} onClick={sending ? undefined : onCancel}>
      <div
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <header className={styles.modalHead}>
          <h3>{title}</h3>
          <button className={styles.iconBtn} disabled={sending} onClick={onCancel} aria-label="关闭">
            ✕
          </button>
        </header>
        <div className={styles.modalBody}>
          <p className={styles.hint}>目标位置:{parentLabel}</p>
          <input
            autoFocus
            type="text"
            value={initialName}
            disabled={busy}
            placeholder="文件夹名称"
            onChange={(e) => onNameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && initialName.trim() && !busy) {
                void confirm()
              }
              if (e.key === 'Escape' && !sending) onCancel()
            }}
          />
          {error && <p role="alert" className={styles.errorText}>{error}</p>}
          {recovery.transactionId !== undefined && <ResourceSaveStatus client={client} path={SKIN_INDEX_PATH} transactionId={recovery.transactionId} compact />}
        </div>
        <footer className={styles.modalFoot}>
          <button disabled={sending} onClick={onCancel}>取消</button>
          <button
            className={styles.primary}
            disabled={!initialName.trim() || busy}
            onClick={() => void confirm()}
          >
            {sending ? '正在提交…' : recovery.phase === 'uncertain' ? '结果待确认' : recovery.blocked ? '请先处理原操作' : confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  )
}
