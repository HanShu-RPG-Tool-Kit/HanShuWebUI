import {SCRIPT_TEMPLATES} from '../../scriptResources'
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { NodeContextMenu, type NodeMenuItem } from '../../nodeEditor/ContextMenu'
import { droppedFiles, shouldAcceptDrop } from '../../drag/dragPayload'
import {
  FLOW_PACKAGE_NAMES,
  FLOW_PACKAGE_ORDER,
  addFlowFolder,
  canMoveFlowEntry,
  entryFolder,
  entryId,
  entryPackage,
  folderPath,
  isBuiltinScriptDocumentKey,
  isBuiltinScriptFolder,
  isFolderEmpty,
  isLibraryTableKey,
  isMultiQuestDocument,
  isQuestDocument,
  isReadonlyExplorerKey,
  isSectionFolder,
  isSimpleQuestDocument,
  moveFlowEntry,
  packageAllowsDocuments,
  packageAllowsItems,
  packageAllowsEntities,
  packageAllowsKits,
  packageAllowsNavigation,
  packageAllowsQuest,
  packageAllowsScripts,
  packageEntry,
  parseSectionFolderKey,
  renameFlowEntry,
  sectionDefs,
  sectionFolderKey,
  scriptTypeInFolder,
  uniqueDocumentName,
  type FlowEntry,
} from './library'
import {
  isQuestViewKey,
  QUEST_EXT,
  QUEST_VIEW_MULTI,
  QUEST_VIEW_NAMES,
  QUEST_VIEW_SIMPLE,
  questAuthorKindOf,
  questViewKey,
  questViewKind,
} from './questKind'
import {
  encodeItemLinkPayload,
  encodeKitLinkPayload,
  ITEM_LINK_MIME,
  KIT_LINK_MIME,
  itemRefFromFileName,
  kitRefFromFileName,
} from './kit'
import type { FlowPackageId, FlowWorkspaceState } from './storage'

type Row = { entry: FlowEntry; name: string; depth: number; parent: string | null; pkg: FlowPackageId }
type Edit = { mode: 'flow' | 'script' | 'kit' | 'progress' | 'navigation' | 'entity' | 'item' | 'folder' | 'rename' | 'move'; entry: FlowEntry; parent: string | null; pkg: FlowPackageId; value: string; error: string; templateName?:string }

export function Icon({ kind }: { kind: 'folder' | 'document' | 'python' | 'kit' | 'item' | 'item-table' | 'new' | 'import' | 'collapse' | 'script' | 'progress' | 'quest' | 'story' | 'actor' | 'reputation' | 'region' | 'navigator' | 'shop' | 'entities' | 'items' | 'gift' | 'goal-def' | 'enchantment' }) {
  const paths: Record<typeof kind, string> = {
    enchantment: 'M12 2l2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5z M19 2v4 M17 4h4',
    folder: 'M2 5h6l2 2h12v12H2z',
    document: 'M5 2h9l5 5v15H5z M14 2v6h5 M8 12h8 M8 16h8',
    python: 'M5 2h9l5 5v15H5z M14 2v6h5 M9 13c0 1.1.9 2 2 2h1 M14 13v2a2 2 0 01-2 2 M9 11v-1a2 2 0 012-2h1 M14 11c0-1.1-.9-2-2-2',
    kit: 'M4 11h16v10H4z M2 7h20v4H2z M12 7v14 M8 15h8',
    item: 'M4 7l8-4 8 4v10l-8 4-8-4z M4 7l8 4 8-4 M12 11v10',
    'item-table': 'M4 4h16v16H4z M4 9h16 M4 14h16 M9 4v16 M14 4v16',
    new: 'M5 2h9l5 5v5 M5 2v20h7 M14 2v6h5 M18 14v8 M14 18h8',
    import: 'M12 2v13 M7 10l5 5 5-5 M3 16v5h18v-5',
    collapse: 'M4 3h16v14 M2 7h14v14H2z M5 14h8',
    script: 'M8 5l-5 7 5 7 M16 5l5 7-5 7',
    progress: 'M5 21V4 M5 4h10l-2 3 2 3H5',
    quest: 'M4 5h7a3 3 0 013 3v12a3 3 0 00-3-3H4z M20 5h-7a3 3 0 00-3 3v12a3 3 0 013-3h7z',
    story: 'M4 5h7a3 3 0 013 3v12a3 3 0 00-3-3H4z M20 5h-7a3 3 0 00-3 3v12a3 3 0 013-3h7z',
    actor: 'M12 12a4 4 0 100-8 4 4 0 000 8z M4 21a8 8 0 0116 0',
    reputation: 'M12 3l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 15.9 7.2 18l.9-5.4L4.2 8.7l5.4-.8z',
    region: 'M12 21s7-5.2 7-11a7 7 0 10-14 0c0 5.8 7 11 7 11z M12 11.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z',
    navigator: 'M12 21a9 9 0 100-18 9 9 0 000 18z M14.5 9.5l-2 5-5 2 2-5 5-2z',
    shop: 'M3 9l1.5-5h15L21 9 M3 9v11h18V9 M3 9h18 M9 20v-6h6v6',
    entities: 'M8 3h8v6H8z M5 21v-6a7 7 0 0114 0v6 M8 15v6 M16 15v6',
    items: 'M4 7l8-4 8 4v10l-8 4-8-4z M4 7l8 4 8-4 M12 11v10',
    gift: 'M4 11h16v10H4z M2 7h20v4H2z M12 7v14 M12 7c0-2.5-2-4-4-4S5 5.5 5 7h7 M12 7c0-2.5 2-4 4-4s3 1.5 3 4h-7',
    'goal-def': 'M8 4h11a2 2 0 012 2v14a2 2 0 01-2 2H8a2 2 0 01-2-2V6a2 2 0 012-2z M5 8H3 M5 12H3 M5 16H3 M11 10l2 2 4-4',
  }
  return <svg className={`flow-resource-icon is-${kind}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={paths[kind]} /></svg>
}

const TREE_INDENT = 10
const defaultFocus = packageEntry('quest')
const QUEST_VIEW_KEYS = [QUEST_VIEW_SIMPLE, QUEST_VIEW_MULTI] as const
const isProtectedFolderKey = (key: string) => isSectionFolder(key) || isQuestViewKey(key)
const sectionIconKind = (key: string): Parameters<typeof Icon>[0]['kind'] => {
  const parsed = parseSectionFolderKey(key)
  return ({common:'script','goal-def':'goal-def',kit:'kit',item:'item',entity:'entities',enchantment:'enchantment',player:'actor'} as const)[parsed?.sectionId as 'common'] ?? 'folder'
}
const allSectionEntryIds = () => FLOW_PACKAGE_ORDER.flatMap((pkg) => sectionDefs(pkg).map((section) => `folder:${sectionFolderKey(pkg, section.id)}`))
const allQuestViewEntryIds = () => QUEST_VIEW_KEYS.map((key) => `folder:${key}`)
const compareFolders = (pkg: FlowPackageId, a: { key: string; name: string }, b: { key: string; name: string }) => {
  const order = sectionDefs(pkg).map((section) => sectionFolderKey(pkg, section.id))
  const ai = order.indexOf(a.key), bi = order.indexOf(b.key)
  if (ai >= 0 || bi >= 0) {
    if (ai < 0) return 1
    if (bi < 0) return -1
    return ai - bi
  }
  return a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
}
const resolveCreateFolder = (folder: string | null): string | null =>
  folder && isQuestViewKey(folder) ? null : folder
const createModeForQuestFocus = (folder: string | null): 'progress' | 'flow' | null => {
  const kind = folder ? questViewKind(folder) : null
  if (kind === 'simple') return 'progress'
  if (kind === 'multi') return 'flow'
  return null
}

const entryName = (state: FlowWorkspaceState, entry: FlowEntry) =>
  entry.kind === 'package' ? FLOW_PACKAGE_NAMES[entry.package]
    : entry.kind === 'folder' ? (QUEST_VIEW_NAMES[entry.key] ?? state.folders.find((f) => f.key === entry.key)?.name ?? '')
      : state.documents.find((d) => d.key === entry.key)?.name ?? ''

const parseSelection = (ids: Set<string>) => {
  const documents: string[] = [], folders: string[] = []
  for (const id of ids) {
    if (id.startsWith('document:')) documents.push(id.slice('document:'.length))
    if (id.startsWith('folder:')) folders.push(id.slice('folder:'.length))
  }
  return { documents, folders }
}

const isPackageId = (value: string): value is FlowPackageId => (FLOW_PACKAGE_ORDER as string[]).includes(value)

export function FlowExplorer({ state, active, disabled, readOnly = false, onChange, onSelect, onNew, onImport, onImportFiles, onExport, onDownload, onRemove, onProperties, onViewSource, onOpenItemInGame, onOpenEntityInGame, onOverrideBuiltinScript, onNotice }: {
  state: FlowWorkspaceState; active: boolean; disabled: boolean; readOnly?: boolean
  onChange: (state: FlowWorkspaceState) => void; onSelect: (key: string) => void
  onNew: (name: string, folder: string | null, pkg: FlowPackageId, templateName?:string) => string
  onImport: (folder: string | null, pkg: FlowPackageId) => void
  onImportFiles: (files: File[], folder: string | null, pkg: FlowPackageId) => void
  onExport: (key: string) => void; onDownload: (key: string) => void
  onRemove: (selection: { documents: string[]; folders: string[] }) => void
  onProperties: (key: string) => void
  /** 查看 .quest / .item 等文档只读源码 */
  onViewSource?: (key: string) => void
  /** 经 Control 呼出客户端 IBE 编辑当前 .item */
  onOpenItemInGame?: (key: string) => void
  onOpenEntityInGame?: (key: string) => void
  onOverrideBuiltinScript?: (key:string)=>void
  onNotice: (message: string) => void
}) {
  const [focus, setFocus] = useState<FlowEntry>(state.activeKey ? { kind: 'document', key: state.activeKey } : defaultFocus)
  const [selectedIds, setSelectedIds] = useState(() => new Set(state.activeKey ? [`document:${state.activeKey}`] : [entryId(defaultFocus)]))
  const [expanded, setExpanded] = useState(() => new Set([...FLOW_PACKAGE_ORDER.map((pkg) => entryId(packageEntry(pkg))), ...allSectionEntryIds(), ...allQuestViewEntryIds()]))
  const [search, setSearch] = useState('')
  const [edit, setEdit] = useState<Edit | null>(null)
  const [menu, setMenu] = useState<{ entry: FlowEntry; x: number; y: number; state: FlowWorkspaceState; multi: boolean } | null>(null)
  const [newMenu, setNewMenu] = useState<{ x: number; y: number } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const elements = useRef(new Map<string, HTMLDivElement>())
  const dragging = useRef<FlowEntry | null>(null)
  const editInput = useRef<HTMLInputElement>(null)
  const anchorId = useRef(state.activeKey ? `document:${state.activeKey}` : entryId(defaultFocus))
  const currentPkg = entryPackage(state, focus)
  const rawFolder = entryFolder(state, focus)
  /** 内置只读夹不可作为创建/导入落点，回落到「目标定义」；任务视图只作分类，落点 folderId 为 null */
  const currentFolder = rawFolder && isBuiltinScriptFolder(rawFolder)
    ? sectionFolderKey('script', 'goal-def')
    : resolveCreateFolder(rawFolder)
  const focusReadonly = (focus.kind === 'folder' || focus.kind === 'document') && isReadonlyExplorerKey(focus.key)
  const selection = parseSelection(selectedIds)
  const multiCount = selection.documents.length + selection.folders.length
  const allowsQuest = packageAllowsQuest(currentPkg)
  const allowsScripts = packageAllowsScripts(currentPkg)
  const allowsKits = packageAllowsKits(currentPkg)
  const allowsNavigation = packageAllowsNavigation(currentPkg)
  const allowsItems = packageAllowsItems(currentPkg)
  const allowsDocuments = allowsQuest || allowsScripts || allowsKits || allowsNavigation || allowsItems || packageAllowsEntities(currentPkg)
  const questCreateMode = allowsQuest ? createModeForQuestFocus(rawFolder) : null
  const newDocumentMode: 'flow' | 'script' | 'kit' | 'progress' | 'navigation' | 'entity' | 'item' | null =
    allowsQuest ? questCreateMode
      : allowsScripts ? 'script'
        : allowsKits ? 'kit'
          : allowsNavigation ? 'navigation'
            : packageAllowsEntities(currentPkg) ? 'entity'
              : allowsItems ? 'item'
                : null
  const newLabel = allowsQuest ? (questCreateMode === 'progress' ? '新建单进度任务' : questCreateMode === 'flow' ? '新建多进度任务' : '新建任务')
    : packageAllowsEntities(currentPkg) ? '新建实体'
      : allowsItems ? '新建物品'
        : allowsNavigation ? '新建导航点'
          : allowsKits ? '新建礼包'
            : allowsScripts ? '新建脚本'
              : '新建流程'
  const importLabel = allowsQuest ? '导入任务'
    : packageAllowsEntities(currentPkg) ? '导入实体'
      : allowsItems ? '导入物品'
        : allowsNavigation ? '导入导航点'
          : allowsKits ? '导入礼包'
            : allowsScripts ? '导入脚本'
              : '导入树图'

  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect
    if (state.activeKey) {
      const entry: FlowEntry = { kind: 'document', key: state.activeKey }
      const id = entryId(entry)
      setFocus(entry)
      setSelectedIds(new Set([id]))
      anchorId.current = id
    } else {
      setFocus(defaultFocus)
      setSelectedIds(new Set([entryId(defaultFocus)]))
      anchorId.current = entryId(defaultFocus)
    }
    setExpanded((previous) => {
      const next = new Set(previous)
      for (const pkg of FLOW_PACKAGE_ORDER) next.add(entryId(packageEntry(pkg)))
      for (const id of allQuestViewEntryIds()) next.add(id)
      const doc = state.documents.find((d) => d.key === state.activeKey)
      if (doc) {
        next.add(entryId(packageEntry(doc.package)))
        if (isQuestDocument(doc)) next.add(`folder:${questViewKey(questAuthorKindOf(doc))}`)
        let parent = doc.folderId ?? null
        while (parent !== null) { next.add(`folder:${parent}`); parent = state.folders.find((f) => f.key === parent)?.parentId ?? null }
      }
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activeKey])
  useEffect(() => { editInput.current?.focus(); editInput.current?.select() }, [edit?.mode, edit?.entry, edit?.parent, edit?.pkg])
  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect
    if (!active || disabled) { setMenu(null); setNewMenu(null) }
  }, [active, disabled])
  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect
    setSelectedIds((previous) => {
      const next = new Set([...previous].filter((id) => {
        if (id.startsWith('package:')) return isPackageId(id.slice('package:'.length))
        if (id.startsWith('document:')) return state.documents.some((document) => document.key === id.slice('document:'.length))
        if (id.startsWith('folder:')) {
          const key = id.slice('folder:'.length)
          return isQuestViewKey(key) || state.folders.some((folder) => folder.key === key)
        }
        return false
      }))
      if (!next.size) next.add(state.activeKey ? `document:${state.activeKey}` : entryId(defaultFocus))
      return next.size === previous.size && [...next].every((id) => previous.has(id)) ? previous : next
    })
  }, [state.documents, state.folders, state.activeKey])

  const rows = useMemo(() => {
    const query = search.trim().toLocaleLowerCase(), visible = new Set<string>()
    const includeParents = (pkg: FlowPackageId, parent: string | null) => {
      visible.add(entryId(packageEntry(pkg)))
      while (parent !== null) { visible.add(`folder:${parent}`); parent = state.folders.find((f) => f.key === parent)?.parentId ?? null }
    }
    if (query) {
      for (const pkg of FLOW_PACKAGE_ORDER) {
        state.folders.filter((f) => f.package === pkg).forEach((f) => {
          if (folderPath(state, pkg, f.key).toLocaleLowerCase().includes(query)) { visible.add(`folder:${f.key}`); includeParents(pkg, f.parentId) }
        })
        state.documents.filter((d) => d.package === pkg).forEach((d) => {
          if (`${folderPath(state, pkg, d.folderId ?? null)} / ${d.name}`.toLocaleLowerCase().includes(query)) {
            visible.add(`document:${d.key}`)
            includeParents(pkg, d.folderId ?? null)
            if (pkg === 'quest' && isQuestDocument(d)) visible.add(`folder:${questViewKey(questAuthorKindOf(d))}`)
          }
        })
      }
    }
    const result: Row[] = []
    const pushDocs = (docs: typeof state.documents, depth: number, parent: string | null, pkg: FlowPackageId) => {
      for (const doc of docs) {
        const entry: FlowEntry = { kind: 'document', key: doc.key }
        if (!query || visible.has(entryId(entry))) result.push({ entry, name: doc.name, depth, parent, pkg })
      }
    }
    const visit = (pkg: FlowPackageId, parent: string | null, depth: number) => {
      if (pkg === 'quest' && parent === null) {
        for (const viewKey of QUEST_VIEW_KEYS) {
          const entry: FlowEntry = { kind: 'folder', key: viewKey }, id = entryId(entry)
          const kind = questViewKind(viewKey)!
          const matching = state.documents
            .filter((d) => d.package === 'quest' && questAuthorKindOf(d) === kind)
            .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
          if (query && !visible.has(id) && !matching.some((d) => visible.has(`document:${d.key}`))) continue
          result.push({ entry, name: QUEST_VIEW_NAMES[viewKey] ?? viewKey, depth, parent: null, pkg })
          if (query || expanded.has(id)) pushDocs(matching, depth + 1, viewKey, pkg)
        }
      }
      const docsHere = state.documents
        .filter((d) => {
          if (d.package !== pkg || (d.folderId ?? null) !== parent) return false
          // 任务根下 folderId 为 null 的文档只出现在对应视图里，不在分类根再列一遍
          if (pkg === 'quest' && parent === null) return false
          return true
        })
        .sort((a, b) => {
          const aTable = isLibraryTableKey(a.key), bTable = isLibraryTableKey(b.key)
          if (aTable !== bTable) return aTable ? -1 : 1
          return a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
        })
      // 物品库表视图固定在同级文件夹之前（此前只在文档组内置顶，仍会被文件夹压到后面）
      pushDocs(docsHere.filter((d) => isLibraryTableKey(d.key)), depth, parent, pkg)
      for (const folder of state.folders.filter((f) => f.package === pkg && f.parentId === parent).sort((a, b) => compareFolders(pkg, a, b))) {
        const entry: FlowEntry = { kind: 'folder', key: folder.key }, id = entryId(entry)
        if (query && !visible.has(id)) continue
        result.push({ entry, name: folder.name, depth, parent, pkg })
        if (query || expanded.has(id)) visit(pkg, folder.key, depth + 1)
      }
      pushDocs(docsHere.filter((d) => !isLibraryTableKey(d.key)), depth, parent, pkg)
    }
    for (const pkg of FLOW_PACKAGE_ORDER) {
      const entry = packageEntry(pkg), id = entryId(entry)
      result.push({ entry, name: FLOW_PACKAGE_NAMES[pkg], depth: 0, parent: null, pkg })
      if (query || expanded.has(id)) visit(pkg, null, 1)
    }
    return result
  }, [state, expanded, search])

  function focusEntry(entry: FlowEntry) {
    setFocus(entry)
    elements.current.get(entryId(entry))?.focus()
  }
  function selectOnly(entry: FlowEntry, openDocument = false) {
    const id = entryId(entry)
    setFocus(entry)
    setSelectedIds(new Set([id]))
    anchorId.current = id
    if (openDocument && entry.kind === 'document') onSelect(entry.key)
  }
  function toggleSelect(entry: FlowEntry) {
    if (entry.kind === 'package' || (entry.kind === 'folder' && isProtectedFolderKey(entry.key))) { selectOnly(entry); return }
    const id = entryId(entry)
    setFocus(entry)
    setSelectedIds((previous) => {
      const next = new Set(previous)
      for (const pkg of FLOW_PACKAGE_ORDER) next.delete(entryId(packageEntry(pkg)))
      if (next.has(id)) next.delete(id)
      else next.add(id)
      if (!next.size) next.add(id)
      return next
    })
    anchorId.current = id
  }
  function rangeSelect(entry: FlowEntry) {
    if (entry.kind === 'package' || (entry.kind === 'folder' && isProtectedFolderKey(entry.key))) { selectOnly(entry); return }
    const target = entryId(entry)
    const start = rows.findIndex((row) => entryId(row.entry) === anchorId.current)
    const end = rows.findIndex((row) => entryId(row.entry) === target)
    if (start < 0 || end < 0) { selectOnly(entry); return }
    const [lo, hi] = start < end ? [start, end] : [end, start]
    const next = new Set<string>()
    for (let index = lo; index <= hi; index++) {
      const item = rows[index].entry
      if (item.kind !== 'package' && !(item.kind === 'folder' && isProtectedFolderKey(item.key))) next.add(entryId(item))
    }
    if (!next.size) next.add(target)
    setFocus(entry)
    setSelectedIds(next)
  }
  function revealEntry(entry: FlowEntry) {
    const pkg = entryPackage(state, entry)
    setExpanded((previous) => {
      const next = new Set(previous).add(entryId(packageEntry(pkg)))
      if (entry.kind === 'folder' && isQuestViewKey(entry.key)) next.add(entryId(entry))
      if (entry.kind === 'document') {
        const doc = state.documents.find((d) => d.key === entry.key)
        if (doc && isQuestDocument(doc)) next.add(`folder:${questViewKey(questAuthorKindOf(doc))}`)
      }
      let parent = entry.kind === 'folder' && !isQuestViewKey(entry.key)
        ? state.folders.find((f) => f.key === entry.key)?.parentId ?? null
        : entry.kind === 'document' ? state.documents.find((d) => d.key === entry.key)?.folderId ?? null : null
      while (parent !== null) { next.add(`folder:${parent}`); parent = state.folders.find((f) => f.key === parent)?.parentId ?? null }
      return next
    })
  }
  function cancelEdit() { if (edit) { const entry = edit.entry; setEdit(null); requestAnimationFrame(() => focusEntry(entry)) } }
  function toggle(entry: FlowEntry) { setExpanded((previous) => { const next = new Set(previous), id = entryId(entry); if (next.has(id)) next.delete(id); else next.add(id); return next }) }
  function containerFor(entry: FlowEntry): FlowEntry {
    if (entry.kind === 'package') return entry
    const parent = entryFolder(state, entry)
    return parent === null ? packageEntry(entryPackage(state, entry)) : { kind: 'folder', key: parent }
  }
  function entryParentId(entry: FlowEntry): string | null {
    if (entry.kind === 'package') return null
    if (entry.kind === 'folder') return state.folders.find((f) => f.key === entry.key)?.parentId ?? null
    return state.documents.find((d) => d.key === entry.key)?.folderId ?? null
  }
  function startEdit(mode: Edit['mode'], entry = focus) {
    if (disabled || readOnly) return
    const pkg = entryPackage(state, entry)
    if ((mode === 'flow' || mode === 'progress') && !packageAllowsQuest(pkg)) {
      onNotice('任务只能建在「任务」分类中。')
      return
    }
    if (mode === 'script' && !packageAllowsScripts(pkg)) {
      onNotice('脚本只能建在「脚本」分类中。')
      return
    }
    if (mode === 'kit' && !packageAllowsKits(pkg)) {
      onNotice('礼包只能建在「礼包」分类中。')
      return
    }
    if (mode === 'navigation' && !packageAllowsNavigation(pkg)) {
      onNotice('导航点只能建在「导航器」分类中。')
      return
    }
    if(mode==='entity'&&!packageAllowsEntities(pkg)){onNotice('实体只能建在实体库中。');return}
    if (mode === 'item' && !packageAllowsItems(pkg)) {
      onNotice('物品只能建在「物品库」分类中。')
      return
    }
    const rawParent = mode === 'move' ? entryParentId(entry) : entry.kind === 'package' ? null : entryFolder(state, entry)
    // 在任务视图下新建：folderId 仍为 null，作者态由 mode（progress/flow）记住
    const parent = mode === 'move' ? rawParent : resolveCreateFolder(rawParent)
    const editEntry = mode === 'flow' || mode === 'script' || mode === 'kit' || mode === 'progress' || mode === 'navigation' || mode === 'entity' || mode === 'item' || mode === 'folder'
      ? (entry.kind === 'folder' && isQuestViewKey(entry.key) ? entry : containerFor(entry))
      : entry
    setSearch('')
    revealEntry(entry)
    selectOnly(entry)
    setNewMenu(null)
    setEdit({
      mode,
      entry: editEntry,
      parent: mode === 'flow' || mode === 'progress'
        ? (entry.kind === 'folder' && isQuestViewKey(entry.key) ? null : parent)
        : parent,
      pkg,
      value: mode === 'rename' ? entryName(state, entry)
        : mode === 'folder' ? '新建文件夹'
          : mode === 'script' ? uniqueDocumentName(state,'新建脚本.py',pkg,parent)
            : mode === 'kit' ? '新建礼包.kit'
              : mode === 'progress' ? `新建单进度任务${QUEST_EXT}`
                : mode === 'navigation' ? '新建导航点.nav'
                  : mode === 'entity' ? '新建实体.entity'
                  : mode === 'item' ? '新建物品.item'
                    : mode === 'flow' ? `新建多进度任务${QUEST_EXT}`
                      : '新建流程',
      error: '',
      templateName: mode === 'progress' || mode === 'flow' ? mode : undefined,
    })
  }
  function submitEdit() {
    if (!edit || disabled || readOnly) return
    try {
      let nextEntry = edit.entry
      if (edit.mode === 'flow' || edit.mode === 'script' || edit.mode === 'kit' || edit.mode === 'progress' || edit.mode === 'navigation' || edit.mode === 'item' || edit.mode === 'entity') {
        const key = onNew(edit.value, edit.parent, edit.pkg, edit.templateName ?? (edit.mode === 'progress' || edit.mode === 'flow' ? edit.mode : undefined))
        nextEntry = { kind: 'document', key }
        if (edit.mode === 'progress' || edit.mode === 'flow') {
          setExpanded((previous) => new Set(previous).add(`folder:${questViewKey(edit.mode === 'progress' ? 'simple' : 'multi')}`))
        }
      }
      if (edit.mode === 'folder') { const result = addFlowFolder(state, edit.value, edit.pkg, edit.parent); onChange(result.state); nextEntry = { kind: 'folder', key: result.folder.key }; setExpanded((previous) => new Set(previous).add(`folder:${result.folder.key}`)) }
      if (edit.mode === 'rename') onChange(renameFlowEntry(state, edit.entry, edit.value))
      if (edit.mode === 'move') { onChange(moveFlowEntry(state, edit.entry, edit.pkg, edit.parent)); revealEntry(edit.entry) }
      setEdit(null); selectOnly(nextEntry); requestAnimationFrame(() => elements.current.get(entryId(nextEntry))?.focus())
    } catch (error) { setEdit({ ...edit, error: error instanceof Error ? error.message : String(error) }) }
  }
  function removeCurrentSelection() {
    if (disabled || edit) return
    const { documents, folders } = parseSelection(selectedIds)
    if (!documents.length && !folders.length) return
    if (!documents.length && folders.length > 0 && folders.every((key) => isSectionFolder(key) || isBuiltinScriptFolder(key))) {
      onNotice('内置分类与内置文件夹不可删除。')
      return
    }
    const removableFolders = folders.filter((key) => {
      if (isSectionFolder(key) || isBuiltinScriptFolder(key)) return false
      const remainingDocs = state.documents.some((document) => document.folderId === key && !documents.includes(document.key))
      const remainingFolders = state.folders.some((folder) => folder.parentId === key && !folders.includes(folder.key))
      return !remainingDocs && !remainingFolders
    })
      const removableDocs = documents.filter((key) => !isBuiltinScriptDocumentKey(key) && !isLibraryTableKey(key))
      if (!removableDocs.length && !removableFolders.length) {
        onNotice(documents.some((key) => isBuiltinScriptDocumentKey(key) || isLibraryTableKey(key)) ? '虚拟项为只读，不可删除。' : '请先移走文件夹中的资源，或一并选中其中的流程后再删除。')
        return
      }
    onRemove({ documents: removableDocs, folders: removableFolders })
  }
  function showMenu(event: MouseEvent, entry: FlowEntry) {
    event.preventDefault(); event.stopPropagation()
    if (disabled || edit) return
    const id = entryId(entry)
    const multi = selectedIds.has(id) && multiCount > 1
    if (!multi) selectOnly(entry)
    else setFocus(entry)
    setMenu({ entry, x: event.clientX, y: event.clientY, state, multi })
  }
  function clickRow(event: MouseEvent, entry: FlowEntry) {
    if (disabled || edit) return
    if (event.shiftKey) { rangeSelect(entry); return }
    if (event.ctrlKey || event.metaKey) { toggleSelect(entry); return }
    if (entry.kind === 'document') selectOnly(entry, true)
    else { selectOnly(entry); if (entry.kind === 'folder' || entry.kind === 'package') toggle(entry) }
  }
  function dropTargetParent(entry: FlowEntry, pkg: FlowPackageId): { pkg: FlowPackageId; parent: string | null } {
    if (entry.kind === 'package') return { pkg: entry.package, parent: null }
    if (entry.kind === 'folder') {
      if (isQuestViewKey(entry.key)) return { pkg: 'quest', parent: null }
      return { pkg, parent: entry.key }
    }
    const document = state.documents.find((item) => item.key === entry.key)
    return { pkg: document?.package ?? pkg, parent: document?.folderId ?? null }
  }
  /** 外部文件导入落点：与内部移动一致（文档行落到其所在文件夹） */
  function importDropTarget(entry: FlowEntry, pkg: FlowPackageId): { pkg: FlowPackageId; parent: string | null } {
    return dropTargetParent(entry, pkg)
  }
  function canImportInto(entry: FlowEntry, pkg: FlowPackageId) {
    const target = importDropTarget(entry, pkg)
    if (target.parent && isBuiltinScriptFolder(target.parent)) return false
    return packageAllowsDocuments(target.pkg)
  }
  function importExternalFiles(files: File[], entry: FlowEntry, pkg: FlowPackageId) {
    if (!files.length) return
    const target = importDropTarget(entry, pkg)
    if (!packageAllowsDocuments(target.pkg)) {
      onNotice('该分类暂不支持导入文件。')
      return
    }
    onImportFiles(files, target.parent, target.pkg)
    const expandId = target.parent ? `folder:${target.parent}` : entryId(packageEntry(target.pkg))
    setExpanded((previous) => new Set(previous).add(expandId).add(entryId(packageEntry(target.pkg))))
  }
  function onRowDragOver(event: DragEvent<HTMLDivElement>, row: Row) {
    if (disabled || edit) return
    const id = entryId(row.entry)
    if (dragging.current && row.entry.kind !== 'document') {
      const target = dropTargetParent(row.entry, row.pkg)
      if (canMoveFlowEntry(state, dragging.current, target.pkg, target.parent)) {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setDropTarget(id)
      }
      return
    }
    if (!dragging.current && shouldAcceptDrop(event.dataTransfer)) {
      // 必须 preventDefault，否则 WebView2/浏览器不允许投放，drop 不会触发
      event.preventDefault()
      if (canImportInto(row.entry, row.pkg)) {
        event.dataTransfer.dropEffect = 'copy'
        setDropTarget(id)
      } else {
        event.dataTransfer.dropEffect = 'none'
      }
    }
  }
  function onRowDrop(event: DragEvent<HTMLDivElement>, row: Row) {
    event.preventDefault()
    setDropTarget(null)
    if (disabled || edit) return
    if (dragging.current) {
      if (row.entry.kind === 'document') return
      const target = dropTargetParent(row.entry, row.pkg)
      try {
        onChange(moveFlowEntry(state, dragging.current, target.pkg, target.parent))
        setExpanded((previous) => new Set(previous).add(entryId(row.entry)))
      } catch (error) { onNotice(String(error)) }
      dragging.current = null
      return
    }
    const files = droppedFiles(event.dataTransfer)
    if (!files.length) return
    if (!canImportInto(row.entry, row.pkg)) {
      onNotice('该分类暂不支持导入文件。')
      return
    }
    importExternalFiles(files, row.entry, row.pkg)
  }
  function onTreePaste(event: ClipboardEvent<HTMLDivElement>) {
    if (disabled || edit) return
    const files = Array.from(event.clipboardData?.files ?? [])
    if (!files.length) return
    event.preventDefault()
    importExternalFiles(files, focus, entryPackage(state, focus))
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>, row: Row, index: number) {
    if (event.target !== event.currentTarget || disabled) return
    if (edit) { if (event.key === 'Escape') { event.preventDefault(); cancelEdit() } return }
    const entry = row.entry, folder = entry.kind !== 'document', open = !!search || expanded.has(entryId(entry))
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      const next = new Set(rows.filter((item) => item.entry.kind !== 'package' && !(item.entry.kind === 'folder' && isProtectedFolderKey(item.entry.key))).map((item) => entryId(item.entry)))
      if (next.size) { setSelectedIds(next); if (!selectedIds.has(entryId(focus)) || focus.kind === 'package' || (focus.kind === 'folder' && isProtectedFolderKey(focus.key))) setFocus(rows.find((item) => item.entry.kind !== 'package' && !(item.entry.kind === 'folder' && isProtectedFolderKey(item.entry.key)))?.entry ?? defaultFocus) }
      return
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (multiCount > 0) { event.preventDefault(); removeCurrentSelection() }
      return
    }
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', 'F2'].includes(event.key)) event.preventDefault()
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const next = rows[event.key === 'ArrowDown' ? Math.min(index + 1, rows.length - 1) : Math.max(index - 1, 0)].entry
      if (event.shiftKey) rangeSelect(next)
      else if (event.ctrlKey || event.metaKey) focusEntry(next)
      else selectOnly(next)
      requestAnimationFrame(() => elements.current.get(entryId(next))?.focus())
      return
    }
    if (event.key === 'Home') { selectOnly(packageEntry(FLOW_PACKAGE_ORDER[0])); requestAnimationFrame(() => elements.current.get(entryId(packageEntry(FLOW_PACKAGE_ORDER[0])))?.focus()) }
    if (event.key === 'End') { const next = rows[rows.length - 1].entry; selectOnly(next); requestAnimationFrame(() => elements.current.get(entryId(next))?.focus()) }
    if (event.key === 'ArrowRight' && folder) { if (!open) toggle(entry); else if (rows[index + 1]?.depth > row.depth) selectOnly(rows[index + 1].entry) }
    if (event.key === 'ArrowLeft') {
      if (folder && open && !search) toggle(entry)
      else if (row.parent === null && entry.kind !== 'package') selectOnly(packageEntry(row.pkg))
      else if (row.parent !== null && isQuestViewKey(row.parent)) selectOnly({ kind: 'folder', key: row.parent })
      else selectOnly(row.parent === null ? packageEntry(row.pkg) : { kind: 'folder', key: row.parent })
    }
    if (event.key === 'Enter') { if (entry.kind === 'document') onSelect(entry.key); else toggle(entry) }
    if (event.key === 'F2' && entry.kind !== 'package' && !isReadonlyExplorerKey(entry.key) && multiCount <= 1) startEdit('rename', entry)
    if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
      event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect()
      const multi = selectedIds.has(entryId(entry)) && multiCount > 1
      setMenu({ entry, x: rect.left + 25, y: rect.bottom, state, multi })
    }
  }
  const moveOptions = useMemo(() => {
    if (!edit || edit.mode !== 'move') return []
    const roots = FLOW_PACKAGE_ORDER.filter((pkg) => canMoveFlowEntry(state, edit.entry, pkg, null)).map((pkg) => ({ key: `${pkg}:`, label: FLOW_PACKAGE_NAMES[pkg], pkg, parent: null as string | null }))
    const folders = state.folders.filter((f) => canMoveFlowEntry(state, edit.entry, f.package, f.key)).map((f) => ({ key: `${f.package}:${f.key}`, label: folderPath(state, f.package, f.key), pkg: f.package, parent: f.key }))
    return [...roots, ...folders]
  }, [edit, state])
  const moveSelectValue = edit?.mode === 'move' ? `${edit.pkg}:${edit.parent ?? ''}` : ''

  const menuItems: NodeMenuItem[] = menu ? (() => {
    if (menu.multi) {
      const removableFolders = selection.folders.filter((key) => {
        if (isSectionFolder(key) || isBuiltinScriptFolder(key)) return false
        const remainingDocs = state.documents.some((document) => document.folderId === key && !selection.documents.includes(document.key))
        const remainingFolders = state.folders.some((folder) => folder.parentId === key && !selection.folders.includes(folder.key))
        return !remainingDocs && !remainingFolders
      })
      const removableDocs = selection.documents.filter((key) => !isBuiltinScriptDocumentKey(key) && !isLibraryTableKey(key))
      const canRemove = removableDocs.length > 0 || removableFolders.length > 0
      return [
        { label: `移除所选（${removableDocs.length + removableFolders.length} 项）…`, disabled: !canRemove, hint: canRemove ? '删除选中的流程，以及可安全删除的空文件夹' : '内置项不可删除，或所选文件夹仍有未选中的内容', action: () => onRemove({ documents: removableDocs, folders: removableFolders }) },
      ]
    }
    const entry = menu.entry, pkg = entryPackage(state, entry), folder = resolveCreateFolder(entryFolder(state, entry))
    if (entry.kind === 'document') {
      const document = state.documents.find((d) => d.key === entry.key)
      const builtin = isBuiltinScriptDocumentKey(entry.key)
      const itemTable = isLibraryTableKey(entry.key)
      const script = document?.package === 'script'
      const kit = document?.package === 'gift'
      const quest = document ? isQuestDocument(document) : false
      const simpleQuest = document ? isSimpleQuestDocument(document) : false
      const multiQuest = document ? isMultiQuestDocument(document) : false
      const navigation = document?.package === 'navigator'
      const item = document?.package === 'items' && !itemTable
      const entity = document?.package === 'entities' && !itemTable
      const openLabel = itemTable ? '打开表视图' : entity ? '打开实体' : item ? '打开物品' : kit ? '打开礼包' : navigation ? '打开导航点' : quest ? (simpleQuest ? '打开单进度任务' : multiQuest ? '打开多进度任务' : '打开任务') : script ? '打开脚本' : '打开流程'
      const downloadLabel = entity ? '下载实体' : item ? '下载物品' : kit ? '下载礼包' : navigation ? '下载导航点' : quest ? '下载任务' : script ? '下载脚本' : '下载草稿'
      if (itemTable) {
        return [
          { label: openLabel, action: () => onSelect(entry.key) },
          { label: '虚拟表视图', disabled: true, hint: '只读总览，不可重命名、移动或删除', action: () => {} },
        ]
      }
      if (builtin) {
        return [
          { label: openLabel, action: () => onSelect(entry.key) },
          ...(onOverrideBuiltinScript?[{label:'在工程中覆盖',disabled:readOnly,action:()=>onOverrideBuiltinScript(entry.key)}]:[]),
          { label: downloadLabel, action: () => onDownload(entry.key) },
          { label: '只读内置脚本', disabled: true, hint: '不可重命名、移动或删除', action: () => {} },
        ]
      }
      const removeLabel = entity ? '移除实体…' : item ? '移除物品…' : kit ? '移除礼包…' : navigation ? '移除导航点…' : quest ? '移除任务…' : script ? '移除脚本…' : '移除流程…'
      return [
        { label: openLabel, action: () => onSelect(entry.key) },
        ...((item && onOpenItemInGame || entity && onOpenEntityInGame)
          ? [{
              label: '发送到游戏内编辑',
              disabled: readOnly,
              hint: readOnly ? '只读工程不可写回' : '经游戏开发服务器打开客户端 IBE',
              action: () => entity ? onOpenEntityInGame?.(entry.key) : onOpenItemInGame?.(entry.key),
            }]
          : []),
        ...((simpleQuest || item) && onViewSource ? [{ label: '查看源码', action: () => onViewSource(entry.key) }] : []),
        { label: '属性…', action: () => onProperties(entry.key) },
        { label: '重命名', disabled: readOnly, hint: readOnly ? '只读工程不可改名' : '只改文件名；食物/自然 等是视图文件夹，磁盘仍在 src/items/', action: () => startEdit('rename', entry) },
        { label: '移动到…', disabled: readOnly, hint: readOnly ? '只读工程不可移动' : '改视图归属文件夹，不改磁盘路径', action: () => startEdit('move', entry) },
        ...(script || kit || quest || navigation || item || entity ? [] : [{ label: '导出树图', action: () => onExport(entry.key) }]),
        ...(multiQuest ? [{ label: '导出树图', action: () => onExport(entry.key) }] : []),
        { label: downloadLabel, action: () => onDownload(entry.key) },
        { label: removeLabel, action: () => onRemove({ documents: [entry.key], folders: [] }) },
      ]
    }
    if (entry.kind === 'folder' && isBuiltinScriptFolder(entry.key)) {
      return [{ label: '只读内置文件夹', disabled: true, hint: '内置目标定义脚本，不可改动', action: () => {} }]
    }
    const items: NodeMenuItem[] = [{ label: '新建文件夹', action: () => startEdit('folder', entry) }]
    if (packageAllowsQuest(pkg)) {
      const viewKind = entry.kind === 'folder' && isQuestViewKey(entry.key) ? questViewKind(entry.key) : null
      if (viewKind === 'simple') items.unshift({ label: '新建单进度任务', action: () => startEdit('progress', entry) })
      else if (viewKind === 'multi') items.unshift({ label: '新建多进度任务', action: () => startEdit('flow', entry) })
      else {
        items.unshift({ label: '新建多进度任务', action: () => startEdit('flow', entry) })
        items.unshift({ label: '新建单进度任务', action: () => startEdit('progress', entry) })
      }
      items.push({ label: '导入任务…', action: () => onImport(folder, pkg) })
    }
    if (packageAllowsScripts(pkg)) {
      items.unshift({ label: '新建脚本', action: () => startEdit('script', entry) })
      items.push({ label: '导入脚本…', action: () => onImport(folder, pkg) })
    }
    if (packageAllowsKits(pkg)) {
      items.unshift({ label: '新建礼包', action: () => startEdit('kit', entry) })
      items.push({ label: '导入礼包…', action: () => onImport(folder, pkg) })
    }
    if (packageAllowsNavigation(pkg)) {
      items.unshift({ label: '新建导航点', action: () => startEdit('navigation', entry) })
      items.push({ label: '导入导航点…', action: () => onImport(folder, pkg) })
    }
    if (packageAllowsEntities(pkg)) {
      items.unshift({label:'新建实体',action:()=>startEdit('entity',entry)})
      items.push({label:'导入实体…',action:()=>onImport(folder,pkg)})
    }
    if (packageAllowsItems(pkg)) {
      items.unshift({ label: '新建物品', action: () => startEdit('item', entry) })
      items.push({ label: '导入物品…', action: () => onImport(folder, pkg) })
    }
    if (entry.kind === 'folder') {
      if (isProtectedFolderKey(entry.key)) return items
      items.push(
        { label: '重命名', action: () => startEdit('rename', entry) },
        { label: '移动到…', action: () => startEdit('move', entry) },
        { label: '删除空文件夹', disabled: !isFolderEmpty(state, entry.key), hint: '请先移走文件夹中的资源。', action: () => onRemove({ documents: [], folders: [entry.key] }) },
      )
    }
    return items
  })() : []

  const questDocCount = state.documents.filter((d) => d.package === 'quest').length
  const simpleQuestCount = state.documents.filter((d) => d.package === 'quest' && questAuthorKindOf(d) === 'simple').length
  const multiQuestCount = state.documents.filter((d) => d.package === 'quest' && questAuthorKindOf(d) === 'multi').length
  const scriptDocCount = state.documents.filter((d) => d.package === 'script').length
  const kitDocCount = state.documents.filter((d) => d.package === 'gift').length
  const navigationDocCount = state.documents.filter((d) => d.package === 'navigator').length
  const itemDocCount = state.documents.filter((d) => d.package === 'items').length
  const hasAnyResource = state.documents.length > 0 || state.folders.some((folder) => !isSectionFolder(folder.key))
  const newButtonDisabled = disabled || readOnly || !!edit || !allowsDocuments || focusReadonly || (!allowsQuest && !newDocumentMode)

  return <aside className="flow-library" aria-label="故事流程资源管理器">
    <div className="flow-explorer-heading"><strong>资源管理器</strong><div className="flow-explorer-actions">
      <button type="button" title={newLabel} aria-label={newLabel} disabled={newButtonDisabled} onClick={(event) => {
        if (allowsQuest && !questCreateMode) {
          const rect = event.currentTarget.getBoundingClientRect()
          setNewMenu({ x: rect.left, y: rect.bottom + 4 })
          return
        }
        if (newDocumentMode) startEdit(newDocumentMode)
      }}><Icon kind="new" /></button>
      <button type="button" title="新建文件夹" aria-label="新建文件夹" disabled={disabled || readOnly || !!edit || focusReadonly} onClick={() => startEdit('folder')}><Icon kind="folder" /></button>
      <button type="button" title={importLabel} aria-label={importLabel} disabled={disabled || readOnly || !!edit || !allowsDocuments || (rawFolder != null && isBuiltinScriptFolder(rawFolder))} onClick={() => onImport(currentFolder, currentPkg)}><Icon kind="import" /></button>
      <button type="button" title="折叠文件夹" aria-label="折叠文件夹" disabled={!!edit} onClick={() => { setExpanded(new Set([...FLOW_PACKAGE_ORDER.map((pkg) => entryId(packageEntry(pkg))), ...allSectionEntryIds(), ...allQuestViewEntryIds()])); selectOnly(defaultFocus); setSearch('') }}><Icon kind="collapse" /></button>
    </div></div>
    <input className="flow-search" placeholder="筛选资源…" aria-label="筛选资源" value={search} disabled={!!edit} onChange={(event) => setSearch(event.target.value)} />
    <div className="flow-resource-tree" role="tree" aria-label="故事流程文件树" aria-multiselectable="true" onContextMenu={(event) => showMenu(event, defaultFocus)} onPaste={onTreePaste}>
      {rows.map((row, index) => {
        const id = entryId(row.entry), folder = row.entry.kind !== 'document', isSelected = selectedIds.has(id), isFocused = id === entryId(focus), isEditing = edit && entryId(edit.entry) === id
        const section = row.entry.kind === 'folder' && isSectionFolder(row.entry.key)
        const questView = row.entry.kind === 'folder' && isQuestViewKey(row.entry.key)
        const builtinFolder = row.entry.kind === 'folder' && isBuiltinScriptFolder(row.entry.key)
        const builtinDoc = row.entry.kind === 'document' && isBuiltinScriptDocumentKey(row.entry.key)
        const docKey = row.entry.kind === 'document' ? row.entry.key : undefined
        const document = docKey ? state.documents.find((d) => d.key === docKey) : undefined
        const pythonDoc = !!document && (document.package === 'script' || row.name.toLowerCase().endsWith('.py'))
        const kitDoc = !!document && (document.package === 'gift' || row.name.toLowerCase().endsWith('.kit'))
        const simpleQuestDoc = !!document && isSimpleQuestDocument(document)
        const multiQuestDoc = !!document && isMultiQuestDocument(document)
        const navigationDoc = !!document && (document.package === 'navigator' || row.name.toLowerCase().endsWith('.nav'))
        const itemTableDoc = row.entry.kind === 'document' && isLibraryTableKey(row.entry.key)
        const entityDoc = !!document && document.package === 'entities'
        const itemDoc = !!document && !itemTableDoc && (document.package === 'items' || row.name.toLowerCase().endsWith('.item'))
        const questViewIcon = questView ? (questViewKind(row.entry.key) === 'simple' ? 'progress' : 'quest') : null
        const iconKind = row.entry.kind === 'package' ? row.entry.package : section ? sectionIconKind(row.entry.key) : questViewIcon ? questViewIcon : itemTableDoc ? 'item-table' : entityDoc ? 'entities' : itemDoc ? 'item' : kitDoc ? 'kit' : navigationDoc ? 'navigator' : simpleQuestDoc ? 'progress' : multiQuestDoc ? 'quest' : pythonDoc ? 'python' : folder ? 'folder' : 'document'
        return <div key={id} role="none">
          <div ref={(element) => { if (element) elements.current.set(id, element); else elements.current.delete(id) }} className={`flow-resource-row${isSelected ? ' selected' : ''}${row.entry.kind === 'document' && row.entry.key === state.activeKey ? ' is-open' : ''}${dropTarget === id ? ' drop-target' : ''}${builtinFolder || builtinDoc || itemTableDoc || questView ? ' is-builtin' : ''}`} role="treeitem" aria-level={row.depth + 1} aria-selected={isSelected} aria-expanded={folder ? !!search || expanded.has(id) : undefined} aria-disabled={disabled} tabIndex={isFocused || (!rows.some((r) => entryId(r.entry) === entryId(focus)) && index === 0) ? 0 : -1} style={{ paddingLeft: 6 + row.depth * TREE_INDENT }} title={builtinDoc || builtinFolder || itemTableDoc || questView ? `${row.name}（只读）` : row.name}
            onClick={(event) => clickRow(event, row.entry)}
            onFocus={(event) => { if (event.target === event.currentTarget) setFocus(row.entry) }} onKeyDown={(event) => keyDown(event, row, index)} onContextMenu={(event) => showMenu(event, row.entry)} draggable={!disabled && !readOnly && !edit && row.entry.kind !== 'package' && !section && !questView && !builtinFolder && !builtinDoc && !itemTableDoc && multiCount <= 1}
            onDragStart={(event) => {
              dragging.current = row.entry
              event.dataTransfer.effectAllowed = itemDoc || kitDoc ? 'copyMove' : 'move'
              event.dataTransfer.setData('application/x-hanshu-progress-entry', id)
              if (itemDoc) {
                const ref = itemRefFromFileName(row.name)
                if (ref) event.dataTransfer.setData(ITEM_LINK_MIME, encodeItemLinkPayload(ref))
              }
              if (kitDoc) {
                const ref = kitRefFromFileName(row.name)
                if (ref) event.dataTransfer.setData(KIT_LINK_MIME, encodeKitLinkPayload(ref))
              }
            }}
            onDragEnd={() => { dragging.current = null; setDropTarget(null) }}
            onDragOver={(event) => onRowDragOver(event, row)}
            onDragLeave={() => setDropTarget(null)} onDrop={(event) => onRowDrop(event, row)}>
            <span className="flow-resource-twist" aria-hidden>{folder ? !!search || expanded.has(id) ? '▾' : '▸' : ''}</span><Icon kind={iconKind} />
            {isEditing && edit.mode === 'rename' ? <form className="flow-resource-edit" onSubmit={(event) => { event.preventDefault(); submitEdit() }} onClick={(event) => event.stopPropagation()}><input ref={editInput} aria-label="资源名称" value={edit.value} onChange={(event) => setEdit({ ...edit, value: event.target.value, error: '' })} onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape') cancelEdit() }} /></form> : <span className="flow-resource-name">{row.name}</span>}
          </div>
          {isEditing && (edit.mode === 'flow' || edit.mode === 'script' || edit.mode === 'kit' || edit.mode === 'progress' || edit.mode === 'navigation' || edit.mode === 'entity' || edit.mode === 'item' || edit.mode === 'folder') && <form className="flow-resource-new" style={{ paddingLeft: 6 + (row.depth + 1) * TREE_INDENT }} onSubmit={(event) => { event.preventDefault(); submitEdit() }}><span className="flow-resource-twist" /><Icon kind={edit.mode === 'folder' ? 'folder' : edit.mode === 'script' ? 'python' : edit.mode === 'kit' ? 'kit' : edit.mode === 'progress' ? 'progress' : edit.mode === 'flow' ? 'quest' : edit.mode === 'navigation' ? 'navigator' : edit.mode === 'entity' ? 'entities' : edit.mode === 'item' ? 'item' : 'document'} /><input ref={editInput} aria-label={edit.mode === 'folder' ? '新文件夹名称' : edit.mode === 'script' ? '新脚本名称' : edit.mode === 'kit' ? '新礼包名称' : edit.mode === 'progress' ? '新单进度任务名称' : edit.mode === 'flow' ? '新多进度任务名称' : edit.mode === 'navigation' ? '新导航点名称' : edit.mode === 'entity' ? '新实体名称' : edit.mode === 'item' ? '新物品名称' : '新流程名称'} value={edit.value} onChange={(event) => setEdit({ ...edit, value: event.target.value, error: '' })} onKeyDown={(event) => { if (event.key === 'Escape') cancelEdit() }} /></form>}
        </div>
      })}
      {search && rows.length === FLOW_PACKAGE_ORDER.length && <p className="flow-explorer-empty">没有匹配的资源</p>}
      {!search && !hasAnyResource && !edit && <p className="flow-explorer-empty">在「任务」下新建或拖入 .quest（单进度 / 多进度）；「脚本」下新建或拖入 .py；「导航器」下新建或拖入 .nav；「物品库」下新建 .item 或拖入 .item / .itemstack；「礼包」下新建或拖入 .kit；其他分类可先建文件夹占位。</p>}
    </div>
    {edit && <div className="flow-explorer-edit-panel" onKeyDown={(event) => { if (event.key === 'Escape') cancelEdit() }}>
      {edit.mode==='script'&&<label>脚本模板<select aria-label="脚本模板" value={edit.templateName??'default.py'} onChange={e=>setEdit({...edit,templateName:e.target.value})}>{SCRIPT_TEMPLATES.filter(t=>t.type===scriptTypeInFolder(state,edit.parent)).map(t=><option key={t.name} value={t.name}>{t.name.replace(/\.py$/i,'')}</option>)}</select></label>}
      {edit.mode === 'move' ? <><label>移动到<select aria-label="目标文件夹" value={moveSelectValue} onChange={(event) => {
        const option=moveOptions.find(option=>option.key===event.target.value)
        if(!option)return
        setEdit({...edit,pkg:option.pkg,parent:option.parent,error:''})
      }}>{moveOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label></> : <p>Enter 确认 · Esc 取消</p>}
      {edit.error && <p className="flow-error" role="alert">{edit.error}</p>}
      <div><button type="button" onClick={submitEdit}>确认</button><button type="button" onClick={cancelEdit}>取消</button></div>
    </div>}
    <div className="flow-library-footer">{multiCount > 1 ? `已选 ${multiCount} 项 · ` : ''}{FLOW_PACKAGE_ORDER.length} 个分类 · {questDocCount} 个任务（{simpleQuestCount} 单进度 · {multiQuestCount} 多进度） · {scriptDocCount} 个脚本 · {navigationDocCount} 个导航点 · {itemDocCount} 个物品 · {kitDocCount} 个礼包 · 拖入/粘贴导入 · Ctrl 多选 · Delete 删除</div>
    {menu && menu.state === state && active && !disabled && <NodeContextMenu x={menu.x} y={menu.y} title={menu.multi ? `已选择 ${multiCount} 项` : entryName(state, menu.entry)} label="资源操作" items={menuItems} onClose={(restore = true) => { setMenu(null); if (restore) elements.current.get(entryId(menu.entry))?.focus() }} />}
    {newMenu && active && !disabled && <NodeContextMenu x={newMenu.x} y={newMenu.y} title="新建任务" label="新建任务" items={[
      { label: '新建单进度任务', action: () => startEdit('progress') },
      { label: '新建多进度任务', action: () => startEdit('flow') },
    ]} onClose={() => setNewMenu(null)} />}
  </aside>
}
