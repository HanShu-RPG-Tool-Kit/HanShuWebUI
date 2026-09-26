/**
 * MC 皮肤管理工作区(新版):
 *   顶部:标题 + 搜索 + 导入 + 布局切换
 *   左侧:范围导航 + 文件夹树 + 管理标签入口
 *   中间:面包屑 + 返回上级 + 筛选 + 子文件夹卡片 + 皮肤网格/列表 + 批量工具条
 *   右侧:详情面板(active/ID/协议/作者/出处/备注)
 *
 * 支持:
 *   - v4 数据模型(active/license/provenance/note)
 *   - 正反筛选、排序、三种布局(大图标/小图标/列表)
 *   - 右键菜单(空白/文件夹/单皮肤/多选)
 *   - 返回上级导航
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getSkinApi } from './api/index.ts'
import type { SkinApi } from './api/SkinApi.ts'
import { FolderTree } from './components/FolderTree.tsx'
import { ImportQueuePanel } from './components/ImportQueuePanel.tsx'
import { SkinThumb } from './components/SkinThumb.tsx'
import { ContextMenu, type ContextMenuItem } from './components/ContextMenu.tsx'
import { LibraryFilters } from './components/LibraryFilters.tsx'
import { LibraryTable } from './components/LibraryTable.tsx'
import { EntryDetails } from './components/EntryDetails.tsx'
import { EntryEditor } from './components/EntryEditor.tsx'
import { TagPicker } from './components/TagPicker.tsx'
import { TextureViewerDialog } from './components/TextureViewerDialog.tsx'
import type {
  EntrySortBy,
  FolderWithStats,
  LibraryEntry,
  SkinEvent,
  SkinModel,
  SortDirection,
  TagMatch,
  TagWithStats,
} from './contracts/types.ts'
import styles from './styles/workspace.module.css'

type Scope = 'all' | 'favorites' | 'recent' | 'unfiled' | 'folder'
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
  const [initError, setInitError] = useState<string | null>(null)

  const [tags, setTags] = useState<TagWithStats[]>([])
  const [folders, setFolders] = useState<FolderWithStats[]>([])

  const [entries, setEntries] = useState<LibraryEntry[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const pageSize = 48
  const [search, setSearch] = useState('')
  const [searchWholeLibrary, setSearchWholeLibrary] = useState(false)
  const [scope, setScope] = useState<Scope>('all')
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null)
  const [includeSubfolders, setIncludeSubfolders] = useState(false)

  // Filters
  const [includeTagIds, setIncludeTagIds] = useState<string[]>([])
  const [excludeTagIds, setExcludeTagIds] = useState<string[]>([])
  const [tagMatch, setTagMatch] = useState<TagMatch>('all')
  const [activeFilter, setActiveFilter] = useState<'all' | 'active' | 'inactive'>('all')
  const [modelFilter, setModelFilter] = useState<SkinModel | 'all'>('all')
  const [licenseFilter, setLicenseFilter] = useState('')
  const [authorFilter, setAuthorFilter] = useState('')
  const [sortBy, setSortBy] = useState<EntrySortBy>('createdAt')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')

  const [pinned, setPinned] = useState<LibraryEntry | null>(null)
  const [hovered, setHovered] = useState<LibraryEntry | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())

  const [showImport, setShowImport] = useState(false)
  const [showTagManager, setShowTagManager] = useState(false)
  const [showOuter, setShowOuter] = useState(true)
  const [walking, setWalking] = useState(true)
  const [autoRotate, setAutoRotate] = useState(true)
  const [notice, setNotice] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('large')
  const [thumbType, setThumbType] = useState<ThumbType>('full')
  const [moveDialog, setMoveDialog] = useState<{ entryIds: string[] } | null>(null)
  const [editDialog, setEditDialog] = useState<LibraryEntry | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [textureViewerFor, setTextureViewerFor] = useState<LibraryEntry | null>(null)
  const [newFolderUnder, setNewFolderUnder] = useState<string | null | 'root' | undefined>(undefined)
  const [newFolderName, setNewFolderName] = useState('')
  const [moveFolderTarget, setMoveFolderTarget] = useState<FolderWithStats | null>(null)

  const hoverLeaveTimer = useRef<number | null>(null)
  const hoverEnterTimer = useRef<number | null>(null)
  const lastRevisionRef = useRef<number>(0)
  const searchDebounceRef = useRef<number | null>(null)
  const requestSeqRef = useRef(0)

  const folderById = useMemo(() => new Map(folders.map((f) => [f.folderId, f])), [folders])

  /* ---------- init: resolve the API once ---------- */
  useEffect(() => {
    let cancelled = false
    void getSkinApi()
      .then((a) => {
        if (!cancelled) setApi(a)
      })
      .catch((e) => {
        if (!cancelled) setInitError((e as Error).message)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const refreshTags = useCallback(async () => {
    if (!api) return
    const tree = await api.listTags()
    setTags(tree.tags)
    lastRevisionRef.current = tree.revision
  }, [api])

  const refreshFolders = useCallback(async () => {
    if (!api) return
    const tree = await api.listFolders()
    setFolders(tree.folders)
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
    let includeSub: boolean | undefined
    let scopeParam: 'all' | 'unfiled' | 'folder' | undefined
    if (scope === 'folder') {
      scopeParam = 'folder'
      folderId = currentFolderId
      includeSub = includeSubfolders
    } else if (scope === 'unfiled') {
      scopeParam = 'unfiled'
      folderId = undefined
      includeSub = false
    } else {
      scopeParam = 'all'
    }
    if (debouncedSearch && searchWholeLibrary) {
      folderId = undefined
      includeSub = undefined
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
        tagIds: includeTagIds.length ? includeTagIds : undefined,
        excludeTagIds: excludeTagIds.length ? excludeTagIds : undefined,
        tagMatch: includeTagIds.length > 1 ? tagMatch : undefined,
        active: activeParam,
        models: modelsParam,
        author: authorFilter.trim() || undefined,
        includeLicenseNames,
        licenseUnspecified,
        favorite: scope === 'favorites' ? true : undefined,
        scope: scopeParam,
        folderId,
        includeSubfolders: includeSub,
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
  }, [api, debouncedSearch, searchWholeLibrary, scope, currentFolderId, includeSubfolders, includeTagIds, excludeTagIds, tagMatch, activeFilter, modelFilter, licenseFilter, authorFilter, sortBy, sortDirection, page])

  // After the API resolves, run the first query. If it fails (the backend is
  // still coming up), retry once after a short delay before showing the error.
  useEffect(() => {
    if (!api) return
    let cancelled = false
    const retryTimer = window.setTimeout(async () => {
      // only meaningful if the first attempt left an error
      if (!cancelled && listError) {
        await refresh()
      }
    }, 1500)
    void Promise.all([refresh(), refreshTags(), refreshFolders()])
    return () => {
      cancelled = true
      window.clearTimeout(retryTimer)
    }
  }, [refresh, refreshTags, refreshFolders, api])

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
    setChecked(new Set())
  }, [debouncedSearch, scope, currentFolderId, includeSubfolders, includeTagIds, excludeTagIds, activeFilter, modelFilter, licenseFilter, authorFilter])

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
  }, [scope, currentFolderId, includeSubfolders, search, page])

  const directChildFolders: FolderWithStats[] = useMemo(() => {
    if (scope !== 'folder' || includeSubfolders) return []
    return folders
      .filter((f) => f.parentId === currentFolderId)
      .sort((a, b) => a.sortOrder - b.sortOrder)
  }, [folders, scope, currentFolderId, includeSubfolders])

  /* ---------- preview URL helper (object URL cache) ---------- */
  const previewUrlRef = useRef(new Map<string, Promise<string>>())
  const getPreviewUrl = useCallback(
    (skinId: string): Promise<string> => {
      let p = previewUrlRef.current.get(skinId)
      if (!p) {
        p = api?.getPreviewUrl(skinId)
        if (!p) return Promise.reject(new Error('皮肤 API 尚未就绪'))
        previewUrlRef.current.set(skinId, p)
      }
      return p
    },
    [api],
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
    })
    return () => {
      cancelled = true
    }
  }, [textureViewerFor, getPreviewUrl])

  /* ---------- render guards (after hooks) ---------- */

  if (initError) {
    return (
      <div className={styles.workspace}>
        <main className={styles.centered}>
          <h1>无法使用皮肤管理</h1>
          <p>{initError}</p>
        </main>
      </div>
    )
  }
  if (!api) {
    return (
      <div className={styles.workspace}>
        <main className={styles.centered}>
          <p>正在初始化皮肤库…</p>
        </main>
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

  /* ---- tag callbacks ---- */
  const createTag = async (name: string, parentId: string | null): Promise<string | null> => {
    try {
      await api.createTag({ name, parentId })
      await refreshTags()
      return null
    } catch (e) {
      return asError(e)
    }
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
  const renameFolder = async (folderId: string, name: string): Promise<string | null> => {
    try {
      await api.patchFolder(folderId, { name })
      await refreshFolders()
      return null
    } catch (e) {
      return asError(e)
    }
  }
  const moveFolder = async (folderId: string, parentId: string | null): Promise<string | null> => {
    try {
      await api.patchFolder(folderId, { parentId })
      await refreshFolders()
      return null
    } catch (e) {
      return asError(e)
    }
  }
  const sortFolderSiblings = async (folderId: string): Promise<string | null> => {
    try {
      await api.patchFolder(folderId, { sortSiblingsByName: true })
      await refreshFolders()
      return null
    } catch (e) {
      return asError(e)
    }
  }
  const deleteFolder = async (folderId: string): Promise<string | null> => {
    try {
      await api.deleteFolder(folderId)
      if (currentFolderId === folderId) {
        setScope('all')
        setCurrentFolderId(null)
      }
      await refreshFolders()
      await refresh()
      return null
    } catch (e) {
      return asError(e)
    }
  }

  /* ---- 面包屑 ---- */
  const breadcrumb = (): { label: string; onClick?: () => void }[] => {
    if (scope === 'folder') {
      if (currentFolderId === null) return [{ label: '未归档' }]
      const f = folderById.get(currentFolderId)
      if (!f) return [{ label: '文件夹' }]
      const segments = f.path
      const trail: { label: string; onClick?: () => void }[] = []
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
      case 'unfiled':
        return [{ label: '未归档' }]
      default:
        return [{ label: '全部皮肤' }]
    }
  }

  const toggleChecked = (entryId: string) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(entryId)) next.delete(entryId)
      else next.add(entryId)
      return next
    })
  }

  const showEntryPath = scope !== 'folder' || includeSubfolders
  const entryPathLabel = (e: LibraryEntry): string => {
    if (e.folderId === null) return '未归档'
    return folderById.get(e.folderId)?.path.join(' / ') ?? ''
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  /* ---------- 移动条目 ---------- */
  const doMoveEntries = async (targetFolderId: string | null) => {
    if (!moveDialog) return
    try {
      await api.batchPatchEntries({
        entryIds: moveDialog.entryIds,
        folderId: targetFolderId,
      })
      const targetLabel =
        targetFolderId === null
          ? '未归档'
          : (folderById.get(targetFolderId)?.path.join(' / ') ?? '')
      showNotice(`已移动 ${moveDialog.entryIds.length} 个条目到 ${targetLabel}`)
      setMoveDialog(null)
      setChecked(new Set())
      await refresh()
      await refreshFolders()
    } catch (e) {
      showNotice(`移动失败:${asError(e)}`)
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
      setScope('all')
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
      const next = new Set(prev)
      for (const e of entries) {
        if (next.has(e.entryId)) next.delete(e.entryId)
        else next.add(e.entryId)
      }
      return next
    })
  }

  /* ---------- 批量启用/禁用 ---------- */
  const batchSetActive = async (active: boolean) => {
    if (checked.size === 0) return
    try {
      const entryIds = [...checked]
      const expectedRevisions = entryIds.map((id) => {
        const e = entries.find((x) => x.entryId === id)
        return e?.revision ?? 0
      })
      await api.batchPatchEntries({ entryIds, active, expectedRevisions })
      setChecked(new Set())
      await refresh()
      showNotice(active ? '已启用选中条目' : '已禁用选中条目')
    } catch (e) {
      showNotice(`操作失败:${asError(e)}`)
    }
  }

  /* ---------- 从导入面板定位已存在条目 ---------- */
  const locateEntry = async (entryId: string, folderId: string | null) => {
    // Clear every filter so the target entry is guaranteed to be visible,
    // navigate to its folder, then fetch and pin it directly.
    setSearch('')
    setIncludeTagIds([])
    setExcludeTagIds([])
    setActiveFilter('all')
    setModelFilter('all')
    setLicenseFilter('')
    setAuthorFilter('')
    setSearchWholeLibrary(false)
    setPage(1)
    if (folderId) {
      setScope('folder')
      setCurrentFolderId(folderId)
    } else {
      setScope('unfiled')
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
  const blankContextMenuItems: ContextMenuItem[] = [
    { label: '导入到这里', onClick: () => setShowImport(true) },
    {
      label: '新建文件夹',
      onClick: () => {
        // 聚合视图默认根目录;文件夹内建在当前位置。弹窗显示目标位置。
        setNewFolderUnder(scope === 'folder' && currentFolderId ? currentFolderId : 'root')
        setNewFolderName('')
      },
    },
    { separator: true, label: '', onClick: () => {} },
    { label: `布局: ${layoutIcons[layoutMode]}`, onClick: () => {} },
    { label: '大图标', onClick: () => setLayoutMode('large') },
    { label: '小图标', onClick: () => setLayoutMode('small') },
    { label: '列表', onClick: () => setLayoutMode('list') },
    { separator: true, label: '', onClick: () => {} },
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
      onClick: () => {
        const name = prompt('重命名文件夹:', f.name)
        if (name && name.trim()) void renameFolder(f.folderId, name.trim())
      },
    },
    {
      label: '移动到…',
      onClick: () => {
        setMoveFolderTarget(f)
      },
    },
    { label: '同级按名称排序', onClick: () => void sortFolderSiblings(f.folderId) },
    { separator: true, label: '', onClick: () => {} },
    { label: '删除空文件夹', onClick: () => void deleteFolder(f.folderId), danger: true },
  ]

  const entryContextMenuItems = (e: LibraryEntry): ContextMenuItem[] => {
    const isMulti = checked.size > 1 && checked.has(e.entryId)
    if (isMulti) {
      return [
        { label: `批量启用 (${checked.size})`, onClick: () => void batchSetActive(true) },
        { label: `批量禁用 (${checked.size})`, onClick: () => void batchSetActive(false) },
        { label: '移动到文件夹…', onClick: () => setMoveDialog({ entryIds: [...checked] }) },
        { separator: true, label: '', onClick: () => {} },
        { label: '取消选择', onClick: () => setChecked(new Set()) },
      ]
    }
    return [
      { label: e.active ? '禁用' : '启用', onClick: () => void toggleEntryActive(e) },
      { label: '编辑资料…', onClick: () => { setPinned(e); setEditDialog(e) } },
      { label: e.favorite ? '取消收藏' : '收藏', onClick: () => void toggleEntryFavorite(e) },
      { separator: true, label: '', onClick: () => {} },
      { label: '复制内容 ID', onClick: () => void copyContentId(e.skinId) },
      { label: '复制皮肤码', onClick: () => void copySkinCode(e.skinId) },
      { separator: true, label: '', onClick: () => {} },
      { label: '导出 PNG', onClick: () => void api.saveExportFile(e.skinId, 'png') },
      { label: '导出 .hskin', onClick: () => void api.saveExportFile(e.skinId, 'hskin') },
      { label: '导出 .skin.json', onClick: () => void exportPortable(e) },
      { label: '查看展开图', onClick: () => { setPinned(e); setTextureViewerFor(e) } },
      { separator: true, label: '', onClick: () => {} },
      { label: '删除', onClick: () => void deleteEntry(e), danger: true },
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
      await api.deleteEntry(e.entryId)
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

  /* ---------- 渲染 ---------- */
  return (
    <div className={styles.workspace}>
      <main className={styles.layout}>
        <header className={styles.topbar}>
          <h1 className={styles.topbarTitle}>皮肤库</h1>
          <input
            type="search"
            className={styles.topbarSearch}
            placeholder={
              scope === 'folder' && !searchWholeLibrary
                ? `在「${currentFolderId ? (folderById.get(currentFolderId)?.name ?? '') : '未归档'}」中搜索…`
                : '搜索整个皮肤库…'
            }
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="搜索皮肤"
          />
          <label className={styles.searchScope}>
            <input
              type="checkbox"
              checked={searchWholeLibrary}
              onChange={(e) => setSearchWholeLibrary(e.target.checked)}
            />
            搜索整个皮肤库
          </label>
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
          <button
            className={styles.primaryBtn}
            onClick={() => {
              setNewFolderUnder(scope === 'folder' && currentFolderId ? currentFolderId : 'root')
              setNewFolderName('')
            }}
          >
            新建文件夹
          </button>
          <button className={styles.primaryBtn} onClick={() => setShowImport(true)}>
            导入皮肤
          </button>
        </header>

        <aside className={styles.left}>
          <nav className={styles.scopeNav} aria-label="浏览范围">
            <button
              className={scope === 'all' ? styles.active : ''}
              onClick={() => {
                setScope('all')
                setCurrentFolderId(null)
              }}
            >
              全部皮肤
            </button>
            <button
              className={scope === 'favorites' ? styles.active : ''}
              onClick={() => {
                setScope('favorites')
                setCurrentFolderId(null)
              }}
            >
              收藏
            </button>
            <button
              className={scope === 'recent' ? styles.active : ''}
              onClick={() => {
                setScope('recent')
                setCurrentFolderId(null)
              }}
            >
              最近导入
            </button>
            <button
              className={scope === 'unfiled' ? styles.active : ''}
              onClick={() => {
                setScope('unfiled')
                setCurrentFolderId(null)
              }}
            >
              未归档
            </button>
          </nav>
          <FolderTree
            folders={folders}
            selectedFolderId={scope === 'folder' ? currentFolderId : null}
            onSelect={(fid) => {
              setScope('folder')
              setCurrentFolderId(fid)
            }}
            onCreate={createFolder}
            onRename={renameFolder}
            onMove={moveFolder}
            onSortByName={sortFolderSiblings}
            onDelete={deleteFolder}
          />
          <div className={styles.leftFooter}>
            <button className={styles.linkBtn} onClick={() => setShowTagManager(true)}>
              管理标签
            </button>
          </div>
        </aside>

        <section
          className={styles.grid}
          aria-label="皮肤列表"
          onContextMenu={(e) => {
            // Blank-area menu only when the event did not hit a card/row.
            if ((e.target as HTMLElement).closest(`.${styles.cardWrap}, .${styles.tableWrap}, .${styles.folderCards}`)) return
            openContextMenu(e, blankContextMenuItems)
          }}
        >
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

          <LibraryFilters
            tags={tags}
            includeTagIds={includeTagIds}
            excludeTagIds={excludeTagIds}
            onIncludeTagIdsChange={setIncludeTagIds}
            onExcludeTagIdsChange={setExcludeTagIds}
            tagMatch={tagMatch}
            onTagMatchChange={setTagMatch}
            activeFilter={activeFilter}
            onActiveFilterChange={setActiveFilter}
            modelFilter={modelFilter}
            onModelFilterChange={setModelFilter}
            licenseFilter={licenseFilter}
            onLicenseFilterChange={setLicenseFilter}
            authorFilter={authorFilter}
            onAuthorFilterChange={setAuthorFilter}
            sortBy={sortBy}
            onSortByChange={setSortBy}
            sortDirection={sortDirection}
            onSortDirectionChange={setSortDirection}
            createTag={createTag}
            onClearAll={() => {
              setIncludeTagIds([])
              setExcludeTagIds([])
              setActiveFilter('all')
              setModelFilter('all')
              setLicenseFilter('')
              setAuthorFilter('')
            }}
          />

          {scope === 'folder' && (
            <div className={styles.filterBar} aria-label="文件夹浏览选项">
              <label>
                <input
                  type="checkbox"
                  checked={includeSubfolders}
                  onChange={(e) => setIncludeSubfolders(e.target.checked)}
                />
                包含子文件夹
              </label>
            </div>
          )}

          {checked.size > 0 && (
            <div className={styles.batchBar} role="toolbar" aria-label="批量操作">
              <span>已勾选 {checked.size} 项</span>
              <button onClick={() => setMoveDialog({ entryIds: [...checked] })}>
                移动到文件夹…
              </button>
              <button onClick={() => void batchSetActive(true)}>批量启用</button>
              <button onClick={() => void batchSetActive(false)}>批量禁用</button>
              <button onClick={invertSelection}>反转选择</button>
              <BatchTagBar
                api={api}
                tags={tags}
                entryIds={[...checked]}
                onDone={() => {
                  setChecked(new Set())
                  void refresh()
                  void refreshTags()
                }}
                createTag={createTag}
              />
              <button onClick={() => setChecked(new Set())}>取消选择</button>
              <button onClick={() => void exportUsableManifest()}>导出已启用清单</button>
            </div>
          )}

          {directChildFolders.length > 0 && (
            <div className={styles.folderCards}>
              {directChildFolders.map((f) => (
                <button
                  key={f.folderId}
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
              {total === 0 && (search || includeTagIds.length > 0 || excludeTagIds.length > 0)
                ? '没有匹配的皮肤。'
                : scope === 'folder'
                  ? '此文件夹为空。'
                  : '还没有皮肤,导入文件开始整理。'}
              {(search || includeTagIds.length > 0 || excludeTagIds.length > 0) && (
                <>
                  {' '}
                  <button
                    className={styles.linkBtn}
                    onClick={() => {
                      setSearch('')
                      setIncludeTagIds([])
                      setExcludeTagIds([])
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
              tags={tags}
              folders={folders}
              checked={checked}
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
        </section>

        <aside className={styles.right} onMouseEnter={onRightEnter} onMouseLeave={onRightLeave}>
          {displayed ? (
            <EntryDetails
              entry={displayed}
              tags={tags}
              folders={folders}
              showOuter={showOuter}
              walking={walking}
              autoRotate={autoRotate}
              active={active}
              onToggleOuter={setShowOuter}
              onToggleWalking={setWalking}
              onToggleAutoRotate={setAutoRotate}
              onEdit={() => {
                setPinned(displayed)
                setEditDialog(displayed)
              }}
              onToggleActive={() => void toggleEntryActive(displayed)}
              onToggleFavorite={() => void toggleEntryFavorite(displayed)}
              onCopyId={() => void copyContentId(displayed.skinId)}
              onCopyCode={() => void copySkinCode(displayed.skinId)}
              onExportPng={() => void api.saveExportFile(displayed.skinId, 'png')}
              onExportHskin={() => void api.saveExportFile(displayed.skinId, 'hskin')}
              onExportPortable={() => void exportPortable(displayed)}
              onViewTexture={() => setTextureViewerFor(displayed)}
              onDelete={() => void deleteEntry(displayed)}
              getPreviewUrl={getPreviewUrl}
            />
          ) : (
            <p className={styles.empty}>悬浮查看皮肤,点击后可保留选中。</p>
          )}
          {notice && <p className={styles.notice}>{notice}</p>}
        </aside>

        {showImport && (
          <ImportQueuePanel
            api={api}
            folders={folders}
            tags={tags}
            defaultFolderId={scope === 'folder' ? currentFolderId : null}
            createTag={createTag}
            onLocateEntry={(entryId, folderId) => void locateEntry(entryId, folderId)}
            onSaved={() => {
              void refresh()
              void refreshTags()
              void refreshFolders()
            }}
            onClose={() => setShowImport(false)}
          />
        )}

        {showTagManager && (
          <TagManagerDialog
            tags={tags}
            createTag={createTag}
            onRename={async (tagId, name) => {
              try {
                await api.patchTag(tagId, { name })
                await refreshTags()
                return null
              } catch (e) {
                return asError(e)
              }
            }}
            onDelete={async (tagId) => {
              try {
                await api.deleteTag(tagId, 'single')
                setIncludeTagIds((prev) => prev.filter((id) => id !== tagId))
                await refreshTags()
                await refresh()
                return null
              } catch (e) {
                return asError(e)
              }
            }}
            onClose={() => setShowTagManager(false)}
          />
        )}

        {moveDialog && (
          <MoveToFolderDialog
            folders={folders}
            count={moveDialog.entryIds.length}
            onPick={(fid) => void doMoveEntries(fid)}
            onClose={() => setMoveDialog(null)}
          />
        )}

        {editDialog && (
          <EntryEditor
            entry={editDialog}
            folders={folders}
            tags={tags}
            createTag={createTag}
            onSaved={(updated) => {
              if (pinned?.entryId === updated.entryId) setPinned(updated)
              if (hovered?.entryId === updated.entryId) setHovered(updated)
              setEditDialog(null)
              void refresh()
              void refreshTags()
              void refreshFolders()
            }}
            onClose={() => setEditDialog(null)}
            onPatch={async (entryId, body) => api.patchEntry(entryId, body)}
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

        {newFolderUnder !== undefined && (
          <NewFolderDialog
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
              if (!name) return
              const err = await createFolder(
                name,
                newFolderUnder === 'root' ? null : newFolderUnder,
              )
              if (err) showNotice(`新建失败:${err}`)
              else showNotice('文件夹已创建')
              setNewFolderUnder(undefined)
              setNewFolderName('')
            }}
            onCancel={() => setNewFolderUnder(undefined)}
          />
        )}

        {moveFolderTarget && (
          <MoveToFolderDialog
            folders={folders}
            count={0}
            excludeFolderId={moveFolderTarget.folderId}
            title={`移动文件夹「${moveFolderTarget.name}」到:`}
            onPick={(fid) => {
              void moveFolder(moveFolderTarget.folderId, fid).then((err) => {
                if (err) showNotice(`移动失败:${err}`)
                else showNotice('文件夹已移动')
              })
              setMoveFolderTarget(null)
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
    })
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
  api,
  tags,
  entryIds,
  onDone,
  createTag,
}: {
  api: SkinApi
  tags: TagWithStats[]
  entryIds: string[]
  onDone: () => void
  createTag: (name: string, parentId: string | null) => Promise<string | null>
}) {
  const [mode, setMode] = useState<'add' | 'remove' | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    if (picked.length === 0) return
    try {
      await api.batchPatchEntries({
        entryIds,
        addTagIds: mode === 'add' ? picked : undefined,
        removeTagIds: mode === 'remove' ? picked : undefined,
      })
      onDone()
    } catch (e) {
      setError((e as Error).message)
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
      <TagPicker tags={tags} selected={picked} onChange={setPicked} onCreate={createTag} />
      <button disabled={picked.length === 0} onClick={() => void run()}>
        应用
      </button>
      <button onClick={() => setMode(null)}>返回</button>
      {error && <p className={styles.error}>{error}</p>}
    </div>
  )
}

/* ========================================================================== */
/* 移动到文件夹对话框                                                          */
/* ========================================================================== */

function MoveToFolderDialog({
  folders,
  count,
  title,
  excludeFolderId,
  onPick,
  onClose,
}: {
  folders: FolderWithStats[]
  count: number
  title?: string
  /** When moving a folder: itself and its descendants are invalid targets. */
  excludeFolderId?: string
  onPick: (folderId: string | null) => void
  onClose: () => void
}) {
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
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="移动到文件夹"
      >
        <header className={styles.modalHead}>
          <h3>{title ?? `移动 ${count} 个条目到:`}</h3>
          <button className={styles.iconBtn} onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>
        <div className={styles.modalBody}>
          <button className={styles.folderOption} onClick={() => onPick(null)}>
            未归档{excludeFolderId ? '(根级)' : ''}
          </button>
          {folders.map((f) => (
            <button
              key={f.folderId}
              className={styles.folderOption}
              style={{ paddingLeft: 12 + (f.path.length - 1) * 16 }}
              disabled={excluded.has(f.folderId)}
              onClick={() => onPick(f.folderId)}
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
/* 新建文件夹对话框                                                            */
/* ========================================================================== */

function NewFolderDialog({
  title,
  parentLabel,
  initialName,
  onNameChange,
  onConfirm,
  onCancel,
}: {
  title: string
  parentLabel: string
  initialName: string
  onNameChange: (name: string) => void
  onConfirm: () => Promise<void> | void
  onCancel: () => void
}) {
  const [busy, setBusy] = useState(false)
  return (
    <div className={styles.modalBackdrop} onClick={onCancel}>
      <div
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <header className={styles.modalHead}>
          <h3>{title}</h3>
          <button className={styles.iconBtn} onClick={onCancel} aria-label="关闭">
            ✕
          </button>
        </header>
        <div className={styles.modalBody}>
          <p className={styles.hint}>目标位置:{parentLabel}</p>
          <input
            autoFocus
            type="text"
            value={initialName}
            placeholder="文件夹名称"
            onChange={(e) => onNameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && initialName.trim() && !busy) {
                setBusy(true)
                void Promise.resolve(onConfirm()).finally(() => setBusy(false))
              }
              if (e.key === 'Escape') onCancel()
            }}
          />
        </div>
        <footer className={styles.modalFoot}>
          <button onClick={onCancel}>取消</button>
          <button
            className={styles.primary}
            disabled={!initialName.trim() || busy}
            onClick={() => {
              setBusy(true)
              void Promise.resolve(onConfirm()).finally(() => setBusy(false))
            }}
          >
            创建
          </button>
        </footer>
      </div>
    </div>
  )
}

/* ========================================================================== */
/* 标签管理对话框                                                              */
/* ========================================================================== */

function TagManagerDialog({
  tags,
  createTag,
  onRename,
  onDelete,
  onClose,
}: {
  tags: TagWithStats[]
  createTag: (name: string, parentId: string | null) => Promise<string | null>
  onRename: (tagId: string, name: string) => Promise<string | null>
  onDelete: (tagId: string) => Promise<string | null>
  onClose: () => void
}) {
  const [newName, setNewName] = useState('')
  const [editing, setEditing] = useState<{ tagId: string; value: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const sorted = useMemo(
    () => tags.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')),
    [tags],
  )

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="管理标签"
      >
        <header className={styles.modalHead}>
          <h3>管理标签</h3>
          <button className={styles.iconBtn} onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>
        <div className={styles.modalBody}>
          <div className={styles.formRow}>
            <input
              value={newName}
              placeholder="新建标签名称"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newName.trim()) {
                  void createTag(newName.trim(), null).then((err) => {
                    if (err) setError(err)
                    else setNewName('')
                  })
                }
              }}
            />
            <button
              disabled={!newName.trim()}
              onClick={() =>
                void createTag(newName.trim(), null).then((err) => {
                  if (err) setError(err)
                  else setNewName('')
                })
              }
            >
              新建
            </button>
          </div>
          <ul className={styles.tagManagerList}>
            {sorted.map((t) => (
              <li key={t.tagId}>
                {editing?.tagId === t.tagId ? (
                  <input
                    autoFocus
                    value={editing.value}
                    onChange={(e) => setEditing({ tagId: t.tagId, value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        void onRename(t.tagId, editing.value.trim()).then((err) => {
                          if (err) setError(err)
                          else setEditing(null)
                        })
                      }
                      if (e.key === 'Escape') setEditing(null)
                    }}
                    onBlur={() => {
                      void onRename(t.tagId, editing.value.trim()).then((err) => {
                        if (err) setError(err)
                        else setEditing(null)
                      })
                    }}
                  />
                ) : (
                  <>
                    <span className={styles.tagName}>{t.name}</span>
                    <span className={styles.tagCountHint}>({t.directCount})</span>
                    <button onClick={() => setEditing({ tagId: t.tagId, value: t.name })}>
                      改名
                    </button>
                    <button
                      className={styles.danger}
                      onClick={() => {
                        if (
                          !confirm(`删除标签「${t.name}」?将移除 ${t.directCount} 个条目上的标注。`)
                        )
                          return
                        void onDelete(t.tagId).then((err) => {
                          if (err) setError(err)
                        })
                      }}
                    >
                      删除
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
          {error && <p className={styles.error}>{error}</p>}
        </div>
        <footer className={styles.modalFoot}>
          <button onClick={onClose}>关闭</button>
        </footer>
      </div>
    </div>
  )
}
