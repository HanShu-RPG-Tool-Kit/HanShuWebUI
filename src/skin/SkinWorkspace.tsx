/**
 * MC 皮肤管理工作区(原 skin-manager App 迁移):
 *   顶部:标题 + 搜索 + 导入
 *   左侧:范围导航 + 文件夹树 + 管理标签入口
 *   中间:面包屑 + 标签筛选 + 子文件夹卡片 + 皮肤网格 + 批量工具条
 *   右侧:悬浮优先 / 选中兜底 的详情面板
 *
 * 迁移要点:
 *   - fetch/EventSource 全部收敛到 SkinApi 适配层
 *   - 事件先注册监听再查询快照,revision 去重
 *   - active=false 时卸载 3D canvas(相机选项保存在上层状态)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getSkinApi } from './api/index.ts'
import type { SkinApi } from './api/SkinApi.ts'
import { FolderTree } from './components/FolderTree.tsx'
import { ImportQueuePanel } from './components/ImportQueuePanel.tsx'
import { SkinPreview3D } from './components/SkinPreview3D.tsx'
import { SkinThumb } from './components/SkinThumb.tsx'
import { TagPicker } from './components/TagPicker.tsx'
import type {
  FolderWithStats,
  LibraryEntry,
  SkinEvent,
  TagMatch,
  TagWithStats,
} from './contracts/types.ts'
import styles from './styles/workspace.module.css'

type Scope = 'all' | 'favorites' | 'recent' | 'unfiled' | 'folder'

const HOVER_LEAVE_DELAY = 200

export interface SkinWorkspaceProps {
  /** Workspace visibility: hidden → 3D canvas unmounted, animations paused. */
  active: boolean
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
  const [filterTagIds, setFilterTagIds] = useState<string[]>([])
  const [tagMatch, setTagMatch] = useState<TagMatch>('all')

  const [pinned, setPinned] = useState<LibraryEntry | null>(null)
  const [hovered, setHovered] = useState<LibraryEntry | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())

  const [showImport, setShowImport] = useState(false)
  const [showTagManager, setShowTagManager] = useState(false)
  const [showOuter, setShowOuter] = useState(true)
  const [walking, setWalking] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [thumbMode, setThumbMode] = useState<'model' | 'flat'>('model')
  const [moveDialog, setMoveDialog] = useState<{ entryIds: string[] } | null>(null)
  const [editDialog, setEditDialog] = useState<LibraryEntry | null>(null)

  const hoverLeaveTimer = useRef<number | null>(null)
  const lastRevisionRef = useRef<number>(0)

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

  const refresh = useCallback(async () => {
    if (!api) return
    let folderId: string | null | undefined
    let includeSub: boolean | undefined
    if (scope === 'folder') {
      folderId = currentFolderId
      includeSub = includeSubfolders
    } else if (scope === 'unfiled') {
      folderId = null
      includeSub = false
    }
    if (search && searchWholeLibrary) {
      folderId = undefined
      includeSub = undefined
    }
    const result = await api.listEntries({
      search: search || undefined,
      tagIds: filterTagIds.length ? filterTagIds : undefined,
      tagMatch: filterTagIds.length > 1 ? tagMatch : undefined,
      favorite: scope === 'favorites' ? true : undefined,
      folderId,
      includeSubfolders: includeSub,
      page,
      pageSize,
    })
    let list = result.entries
    if (scope === 'recent') {
      list = list.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    }
    setEntries(list)
    setTotal(result.total)
  }, [api, search, searchWholeLibrary, scope, currentFolderId, includeSubfolders, filterTagIds, tagMatch, page])

  useEffect(() => {
    if (api) {
      void refresh()
      void refreshTags()
      void refreshFolders()
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

  // pinned 可能在外部被修改;同步刷新
  useEffect(() => {
    if (!pinned) return
    const fresh = entries.find((e) => e.entryId === pinned.entryId)
    if (fresh && fresh.revision !== pinned.revision) setPinned(fresh)
  }, [entries, pinned])

  useEffect(() => {
    setPage(1)
    setChecked(new Set())
  }, [search, scope, currentFolderId, includeSubfolders, filterTagIds, tagMatch])

  /* ---------- hover / pinned ---------- */

  const displayed: LibraryEntry | null = hovered ?? pinned
  const displayStatus: 'hover' | 'pinned' | null = hovered
    ? hovered.entryId === pinned?.entryId
      ? 'pinned'
      : 'hover'
    : pinned
      ? 'pinned'
      : null

  const cancelHoverLeave = () => {
    if (hoverLeaveTimer.current !== null) {
      window.clearTimeout(hoverLeaveTimer.current)
      hoverLeaveTimer.current = null
    }
  }

  const onCardEnter = (e: LibraryEntry) => {
    cancelHoverLeave()
    setHovered(e)
  }

  const onCardLeave = () => {
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

        <section className={styles.grid} aria-label="皮肤列表">
          <div className={styles.gridToolbar}>
            <nav className={styles.breadcrumb} aria-label="当前位置">
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
            <div className={styles.thumbToggle} role="tablist" aria-label="小图样式">
              <button
                role="tab"
                aria-selected={thumbMode === 'model'}
                className={thumbMode === 'model' ? styles.active : ''}
                onClick={() => setThumbMode('model')}
              >
                模型
              </button>
              <button
                role="tab"
                aria-selected={thumbMode === 'flat'}
                className={thumbMode === 'flat' ? styles.active : ''}
                onClick={() => setThumbMode('flat')}
              >
                展开图
              </button>
            </div>
          </div>

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

          <div className={styles.filterBar} aria-label="标签筛选条件">
            <TagFilterBar
              tags={tags}
              selected={filterTagIds}
              onChange={setFilterTagIds}
              createTag={createTag}
            />
            {filterTagIds.length > 1 && (
              <label>
                匹配:
                <select value={tagMatch} onChange={(e) => setTagMatch(e.target.value as TagMatch)}>
                  <option value="all">全部满足</option>
                  <option value="any">任一满足</option>
                </select>
              </label>
            )}
            {filterTagIds.length > 0 && (
              <button onClick={() => setFilterTagIds([])}>清空筛选</button>
            )}
          </div>

          {checked.size > 0 && (
            <div className={styles.batchBar} role="toolbar" aria-label="批量操作">
              <span>已勾选 {checked.size} 项</span>
              <button onClick={() => setMoveDialog({ entryIds: [...checked] })}>
                移动到文件夹…
              </button>
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

          {entries.length === 0 && directChildFolders.length === 0 && (
            <p className={styles.empty}>
              {total === 0 && (search || filterTagIds.length > 0)
                ? '没有匹配的皮肤。'
                : scope === 'folder'
                  ? '此文件夹为空。'
                  : '还没有皮肤,导入文件开始整理。'}
              {(search || filterTagIds.length > 0) && (
                <>
                  {' '}
                  <button
                    className={styles.linkBtn}
                    onClick={() => {
                      setSearch('')
                      setFilterTagIds([])
                    }}
                  >
                    清空筛选
                  </button>
                </>
              )}
            </p>
          )}
          <div className={styles.cards}>
            {entries.map((e) => {
              const isPinned = pinned?.entryId === e.entryId
              const isHovered = hovered?.entryId === e.entryId
              const isChecked = checked.has(e.entryId)
              return (
                <div
                  key={e.entryId}
                  className={styles.cardWrap}
                  onMouseEnter={() => onCardEnter(e)}
                  onMouseLeave={onCardLeave}
                >
                  <button
                    className={[
                      styles.card,
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
                      threeD={thumbMode === 'model'}
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
            })}
          </div>

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
            <RightPanel
              api={api}
              entry={displayed}
              status={displayStatus}
              folderLabel={
                displayed.folderId === null
                  ? '未归档'
                  : (folderById.get(displayed.folderId)?.path.join(' / ') ?? '')
              }
              tags={tags}
              showOuter={showOuter}
              walking={walking}
              active={active}
              getPreviewUrl={getPreviewUrl}
              onToggleOuter={setShowOuter}
              onToggleWalking={setWalking}
              onCopyCode={() => void copySkinCode(displayed.skinId)}
              onPin={() => setPinned(displayed)}
              onEdit={() => {
                setPinned(displayed)
                setEditDialog(displayed)
              }}
              onToggleFavorite={() => {
                void api
                  .patchEntry(displayed.entryId, {
                    revision: displayed.revision,
                    favorite: !displayed.favorite,
                  })
                  .then((updated) => {
                    if (pinned?.entryId === updated.entryId) setPinned(updated)
                    if (hovered?.entryId === updated.entryId) setHovered(updated)
                    void refresh()
                  })
              }}
              onDelete={() => {
                if (!confirm(`删除「${displayed.name}」?对象文件保留供其他条目使用。`)) return
                void api.deleteEntry(displayed.entryId).then(() => {
                  if (pinned?.entryId === displayed.entryId) setPinned(null)
                  if (hovered?.entryId === displayed.entryId) setHovered(null)
                  void refresh()
                  void refreshTags()
                  void refreshFolders()
                })
              }}
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
            existingEntries={entries}
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
                setFilterTagIds((prev) => prev.filter((id) => id !== tagId))
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
          <EditEntryDialog
            api={api}
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
  threeD,
}: {
  skinId: string
  model: 'classic' | 'slim'
  getPreviewUrl: (skinId: string) => Promise<string>
  alt: string
  threeD?: boolean
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
  if (threeD && url) {
    return <SkinThumb skinId={skinId} model={model} previewUrl={url} alt={alt} />
  }
  return url ? (
    <img src={url} alt={alt} loading="lazy" className={`${styles.thumb} ${styles.thumb2d}`} />
  ) : (
    <div className={styles.thumb} aria-label={alt} />
  )
}

/* ========================================================================== */
/* 右侧面板                                                                    */
/* ========================================================================== */

function RightPanel({
  api,
  entry,
  status,
  folderLabel,
  tags,
  showOuter,
  walking,
  active,
  getPreviewUrl,
  onToggleOuter,
  onToggleWalking,
  onCopyCode,
  onPin,
  onEdit,
  onToggleFavorite,
  onDelete,
}: {
  api: SkinApi
  entry: LibraryEntry
  status: 'hover' | 'pinned' | null
  folderLabel: string
  tags: TagWithStats[]
  showOuter: boolean
  walking: boolean
  active: boolean
  getPreviewUrl: (skinId: string) => Promise<string>
  onToggleOuter: (v: boolean) => void
  onToggleWalking: (v: boolean) => void
  onCopyCode: () => void
  onPin: () => void
  onEdit: () => void
  onToggleFavorite: () => void
  onDelete: () => void
}) {
  const tagById = new Map(tags.map((t) => [t.tagId, t]))
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void getPreviewUrl(entry.skinId).then((u) => {
      if (!cancelled) setPreviewUrl(u)
    })
    return () => {
      cancelled = true
    }
  }, [entry.skinId, getPreviewUrl])

  return (
    <>
      <header className={styles.rightHead}>
        <h2>{entry.name}</h2>
        <span
          className={`${styles.statusPill} ${
            status === 'hover' ? styles.statusHover : styles.statusPinned
          }`}
        >
          {status === 'hover' ? '悬浮预览' : status === 'pinned' ? '已选中' : ''}
        </span>
      </header>
      {/* 隐藏工作区时卸载 3D canvas,停止 WebGL 渲染循环 */}
      {active && previewUrl && (
        <SkinPreview3D
          previewUrl={previewUrl}
          model={entry.model}
          showOuterLayers={showOuter}
          walking={walking}
        />
      )}
      <dl className={styles.meta}>
        <dt>位置</dt>
        <dd>{folderLabel}</dd>
        <dt>模型</dt>
        <dd>{entry.model}</dd>
        <dt>导入时间</dt>
        <dd>{new Date(entry.createdAt).toLocaleString()}</dd>
      </dl>
      <div className={styles.previewControls}>
        <label>
          <input
            type="checkbox"
            checked={showOuter}
            onChange={(e) => onToggleOuter(e.target.checked)}
          />
          外层
        </label>
        <label>
          <input
            type="checkbox"
            checked={walking}
            onChange={(e) => onToggleWalking(e.target.checked)}
          />
          行走
        </label>
      </div>

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
        {status === 'hover' && <button onClick={onPin}>固定选中</button>}
        <button onClick={onEdit}>编辑资料…</button>
        <button onClick={onCopyCode}>复制字符串</button>
        <button onClick={() => void api.saveExportFile(entry.skinId, 'png')}>导出 PNG</button>
        <button onClick={() => void api.saveExportFile(entry.skinId, 'hskin')}>
          导出 .hskin
        </button>
        <button
          onClick={() => {
            void api
              .exportEntry(entry.entryId)
              .then((portable) => {
                const blob = new Blob([JSON.stringify(portable, null, 2)], {
                  type: 'application/json',
                })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = `${entry.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 64) || 'skin'}.skin.json`
                a.click()
                URL.revokeObjectURL(url)
              })
              .catch((e) => alert(`导出失败:${(e as Error).message}`))
          }}
        >
          导出 .skin.json
        </button>
        <button onClick={onToggleFavorite}>{entry.favorite ? '取消收藏' : '收藏'}</button>
        <button className={styles.danger} onClick={onDelete}>
          删除
        </button>
      </div>
    </>
  )
}

/* ========================================================================== */
/* 标签筛选条                                                                  */
/* ========================================================================== */

function TagFilterBar({
  tags,
  selected,
  onChange,
  createTag,
}: {
  tags: TagWithStats[]
  selected: string[]
  onChange: (ids: string[]) => void
  createTag: (name: string, parentId: string | null) => Promise<string | null>
}) {
  const [open, setOpen] = useState(false)
  const tagById = new Map(tags.map((t) => [t.tagId, t]))
  return (
    <div className={styles.tagFilter}>
      {selected.map((id) => (
        <span key={id} className={styles.tagChip}>
          {tagById.get(id)?.name ?? id}
          <button
            type="button"
            aria-label="移除筛选"
            onClick={() => onChange(selected.filter((x) => x !== id))}
          >
            ×
          </button>
        </span>
      ))}
      <button type="button" className={styles.linkBtn} onClick={() => setOpen((v) => !v)}>
        {open ? '收起标签筛选 ▴' : '按标签筛选…'}
      </button>
      {open && (
        <div className={styles.tagFilterPop}>
          <TagPicker tags={tags} selected={selected} onChange={onChange} onCreate={createTag} />
        </div>
      )}
    </div>
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
  onPick,
  onClose,
}: {
  folders: FolderWithStats[]
  count: number
  onPick: (folderId: string | null) => void
  onClose: () => void
}) {
  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="移动到文件夹"
      >
        <header className={styles.modalHead}>
          <h3>移动 {count} 个条目到:</h3>
          <button className={styles.iconBtn} onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>
        <div className={styles.modalBody}>
          <button className={styles.folderOption} onClick={() => onPick(null)}>
            未归档
          </button>
          {folders.map((f) => (
            <button
              key={f.folderId}
              className={styles.folderOption}
              style={{ paddingLeft: 12 + (f.path.length - 1) * 16 }}
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
/* 编辑资料对话框                                                              */
/* ========================================================================== */

function EditEntryDialog({
  api,
  entry,
  folders,
  tags,
  createTag,
  onSaved,
  onClose,
}: {
  api: SkinApi
  entry: LibraryEntry
  folders: FolderWithStats[]
  tags: TagWithStats[]
  createTag: (name: string, parentId: string | null) => Promise<string | null>
  onSaved: (updated: LibraryEntry) => void
  onClose: () => void
}) {
  const [name, setName] = useState(entry.name)
  const [folderId, setFolderId] = useState<string | null>(entry.folderId)
  const [tagIds, setTagIds] = useState<string[]>(entry.tagIds)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const updated = await api.patchEntry(entry.entryId, {
        revision: entry.revision,
        name: name.trim() || entry.name,
        folderId,
        tagIds,
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
