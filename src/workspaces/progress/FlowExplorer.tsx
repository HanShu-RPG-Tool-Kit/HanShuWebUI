import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { NodeContextMenu, type NodeMenuItem } from './NodeContextMenu'
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
  isFolderEmpty,
  isSectionFolder,
  moveFlowEntry,
  packageAllowsDocuments,
  packageAllowsFlows,
  packageAllowsKits,
  packageAllowsNavigation,
  packageAllowsProgress,
  packageAllowsScripts,
  packageEntry,
  parseSectionFolderKey,
  renameFlowEntry,
  sectionDefs,
  sectionFolderKey,
  type FlowEntry,
} from './library'
import type { FlowPackageId, FlowWorkspaceState } from './storage'

type Row = { entry: FlowEntry; name: string; depth: number; parent: string | null; pkg: FlowPackageId }
type Edit = { mode: 'flow' | 'script' | 'kit' | 'progress' | 'navigation' | 'folder' | 'rename' | 'move'; entry: FlowEntry; parent: string | null; pkg: FlowPackageId; value: string; error: string }

export function Icon({ kind }: { kind: 'folder' | 'document' | 'python' | 'kit' | 'new' | 'import' | 'collapse' | 'script' | 'progress' | 'story' | 'actor' | 'reputation' | 'region' | 'navigator' | 'shop' | 'gift' | 'goal-def' }) {
  const paths: Record<typeof kind, string> = {
    folder: 'M2 5h6l2 2h12v12H2z',
    document: 'M5 2h9l5 5v15H5z M14 2v6h5 M8 12h8 M8 16h8',
    python: 'M5 2h9l5 5v15H5z M14 2v6h5 M9 13c0 1.1.9 2 2 2h1 M14 13v2a2 2 0 01-2 2 M9 11v-1a2 2 0 012-2h1 M14 11c0-1.1-.9-2-2-2',
    kit: 'M4 11h16v10H4z M2 7h20v4H2z M12 7v14 M8 15h8',
    new: 'M5 2h9l5 5v5 M5 2v20h7 M14 2v6h5 M18 14v8 M14 18h8',
    import: 'M12 2v13 M7 10l5 5 5-5 M3 16v5h18v-5',
    collapse: 'M4 3h16v14 M2 7h14v14H2z M5 14h8',
    script: 'M8 5l-5 7 5 7 M16 5l5 7-5 7',
    progress: 'M5 21V4 M5 4h10l-2 3 2 3H5',
    story: 'M4 5h7a3 3 0 013 3v12a3 3 0 00-3-3H4z M20 5h-7a3 3 0 00-3 3v12a3 3 0 013-3h7z',
    actor: 'M12 12a4 4 0 100-8 4 4 0 000 8z M4 21a8 8 0 0116 0',
    reputation: 'M12 3l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 15.9 7.2 18l.9-5.4L4.2 8.7l5.4-.8z',
    region: 'M12 21s7-5.2 7-11a7 7 0 10-14 0c0 5.8 7 11 7 11z M12 11.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z',
    navigator: 'M12 21a9 9 0 100-18 9 9 0 000 18z M14.5 9.5l-2 5-5 2 2-5 5-2z',
    shop: 'M3 9l1.5-5h15L21 9 M3 9v11h18V9 M3 9h18 M9 20v-6h6v6',
    gift: 'M4 11h16v10H4z M2 7h20v4H2z M12 7v14 M12 7c0-2.5-2-4-4-4S5 5.5 5 7h7 M12 7c0-2.5 2-4 4-4s3 1.5 3 4h-7',
    'goal-def': 'M8 4h11a2 2 0 012 2v14a2 2 0 01-2 2H8a2 2 0 01-2-2V6a2 2 0 012-2z M5 8H3 M5 12H3 M5 16H3 M11 10l2 2 4-4',
  }
  return <svg className={`flow-resource-icon is-${kind}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={paths[kind]} /></svg>
}

const TREE_INDENT = 10
const defaultFocus = packageEntry('story')
const sectionIconKind = (key: string): 'folder' | 'goal-def' => {
  const parsed = parseSectionFolderKey(key)
  return parsed?.sectionId === 'goal-def' ? 'goal-def' : 'folder'
}
const allSectionEntryIds = () => FLOW_PACKAGE_ORDER.flatMap((pkg) => sectionDefs(pkg).map((section) => `folder:${sectionFolderKey(pkg, section.id)}`))
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

const entryName = (state: FlowWorkspaceState, entry: FlowEntry) =>
  entry.kind === 'package' ? FLOW_PACKAGE_NAMES[entry.package] : entry.kind === 'folder' ? state.folders.find((f) => f.key === entry.key)?.name ?? '' : state.documents.find((d) => d.key === entry.key)?.name ?? ''

const parseSelection = (ids: Set<string>) => {
  const documents: string[] = [], folders: string[] = []
  for (const id of ids) {
    if (id.startsWith('document:')) documents.push(id.slice('document:'.length))
    if (id.startsWith('folder:')) folders.push(id.slice('folder:'.length))
  }
  return { documents, folders }
}

const isPackageId = (value: string): value is FlowPackageId => (FLOW_PACKAGE_ORDER as string[]).includes(value)

export function FlowExplorer({ state, active, disabled, onChange, onSelect, onNew, onImport, onImportFiles, onExport, onDownload, onRemove, onProperties, onNotice }: {
  state: FlowWorkspaceState; active: boolean; disabled: boolean
  onChange: (state: FlowWorkspaceState) => void; onSelect: (key: string) => void
  onNew: (name: string, folder: string | null, pkg: FlowPackageId) => string
  onImport: (folder: string | null, pkg: FlowPackageId) => void
  onImportFiles: (files: File[], folder: string | null, pkg: FlowPackageId) => void
  onExport: (key: string) => void; onDownload: (key: string) => void
  onRemove: (selection: { documents: string[]; folders: string[] }) => void
  onProperties: (key: string) => void; onNotice: (message: string) => void
}) {
  const [focus, setFocus] = useState<FlowEntry>(state.activeKey ? { kind: 'document', key: state.activeKey } : defaultFocus)
  const [selectedIds, setSelectedIds] = useState(() => new Set(state.activeKey ? [`document:${state.activeKey}`] : [entryId(defaultFocus)]))
  const [expanded, setExpanded] = useState(() => new Set([...FLOW_PACKAGE_ORDER.map((pkg) => entryId(packageEntry(pkg))), ...allSectionEntryIds()]))
  const [search, setSearch] = useState('')
  const [edit, setEdit] = useState<Edit | null>(null)
  const [menu, setMenu] = useState<{ entry: FlowEntry; x: number; y: number; state: FlowWorkspaceState; multi: boolean } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const elements = useRef(new Map<string, HTMLDivElement>())
  const dragging = useRef<FlowEntry | null>(null)
  const editInput = useRef<HTMLInputElement>(null)
  const anchorId = useRef(state.activeKey ? `document:${state.activeKey}` : entryId(defaultFocus))
  const currentPkg = entryPackage(state, focus)
  const currentFolder = entryFolder(state, focus)
  const selection = parseSelection(selectedIds)
  const multiCount = selection.documents.length + selection.folders.length
  const allowsFlows = packageAllowsFlows(currentPkg)
  const allowsScripts = packageAllowsScripts(currentPkg)
  const allowsKits = packageAllowsKits(currentPkg)
  const allowsProgress = packageAllowsProgress(currentPkg)
  const allowsNavigation = packageAllowsNavigation(currentPkg)
  const allowsDocuments = allowsFlows || allowsScripts || allowsKits || allowsProgress || allowsNavigation
  const newDocumentMode: 'flow' | 'script' | 'kit' | 'progress' | 'navigation' | null = allowsFlows ? 'flow' : allowsScripts ? 'script' : allowsKits ? 'kit' : allowsProgress ? 'progress' : allowsNavigation ? 'navigation' : null
  const newLabel = allowsNavigation ? '新建导航点' : allowsProgress ? '新建进度' : allowsKits ? '新建礼包' : allowsScripts ? '新建脚本' : '新建流程'
  const importLabel = allowsNavigation ? '导入导航点' : allowsProgress ? '导入进度' : allowsKits ? '导入礼包' : allowsScripts ? '导入脚本' : '导入树图'

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
      const doc = state.documents.find((d) => d.key === state.activeKey)
      if (doc) {
        next.add(entryId(packageEntry(doc.package)))
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
    if (!active || disabled) setMenu(null)
  }, [active, disabled])
  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect
    setSelectedIds((previous) => {
      const next = new Set([...previous].filter((id) => {
        if (id.startsWith('package:')) return isPackageId(id.slice('package:'.length))
        if (id.startsWith('document:')) return state.documents.some((document) => document.key === id.slice('document:'.length))
        if (id.startsWith('folder:')) return state.folders.some((folder) => folder.key === id.slice('folder:'.length))
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
          if (`${folderPath(state, pkg, d.folderId ?? null)} / ${d.name}`.toLocaleLowerCase().includes(query)) { visible.add(`document:${d.key}`); includeParents(pkg, d.folderId ?? null) }
        })
      }
    }
    const result: Row[] = []
    const visit = (pkg: FlowPackageId, parent: string | null, depth: number) => {
      for (const folder of state.folders.filter((f) => f.package === pkg && f.parentId === parent).sort((a, b) => compareFolders(pkg, a, b))) {
        const entry: FlowEntry = { kind: 'folder', key: folder.key }, id = entryId(entry)
        if (query && !visible.has(id)) continue
        result.push({ entry, name: folder.name, depth, parent, pkg })
        if (query || expanded.has(id)) visit(pkg, folder.key, depth + 1)
      }
      for (const doc of state.documents.filter((d) => d.package === pkg && (d.folderId ?? null) === parent).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))) {
        const entry: FlowEntry = { kind: 'document', key: doc.key }
        if (!query || visible.has(entryId(entry))) result.push({ entry, name: doc.name, depth, parent, pkg })
      }
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
    if (entry.kind === 'package' || (entry.kind === 'folder' && isSectionFolder(entry.key))) { selectOnly(entry); return }
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
    if (entry.kind === 'package' || (entry.kind === 'folder' && isSectionFolder(entry.key))) { selectOnly(entry); return }
    const target = entryId(entry)
    const start = rows.findIndex((row) => entryId(row.entry) === anchorId.current)
    const end = rows.findIndex((row) => entryId(row.entry) === target)
    if (start < 0 || end < 0) { selectOnly(entry); return }
    const [lo, hi] = start < end ? [start, end] : [end, start]
    const next = new Set<string>()
    for (let index = lo; index <= hi; index++) {
      const item = rows[index].entry
      if (item.kind !== 'package' && !(item.kind === 'folder' && isSectionFolder(item.key))) next.add(entryId(item))
    }
    if (!next.size) next.add(target)
    setFocus(entry)
    setSelectedIds(next)
  }
  function revealEntry(entry: FlowEntry) {
    const pkg = entryPackage(state, entry)
    setExpanded((previous) => {
      const next = new Set(previous).add(entryId(packageEntry(pkg)))
      let parent = entry.kind === 'folder' ? state.folders.find((f) => f.key === entry.key)?.parentId ?? null : entry.kind === 'document' ? state.documents.find((d) => d.key === entry.key)?.folderId ?? null : null
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
    if (disabled) return
    const pkg = entryPackage(state, entry)
    if (mode === 'flow' && !packageAllowsFlows(pkg)) {
      onNotice('流程只能建在「故事流程」分类中。')
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
    if (mode === 'progress' && !packageAllowsProgress(pkg)) {
      onNotice('进度只能建在「进度」分类中。')
      return
    }
    if (mode === 'navigation' && !packageAllowsNavigation(pkg)) {
      onNotice('导航点只能建在「导航器」分类中。')
      return
    }
    const parent = mode === 'move' ? entryParentId(entry) : entry.kind === 'package' ? null : entryFolder(state, entry)
    setSearch('')
    revealEntry(entry)
    selectOnly(entry)
    setEdit({
      mode,
      entry: mode === 'flow' || mode === 'script' || mode === 'kit' || mode === 'progress' || mode === 'navigation' || mode === 'folder' ? containerFor(entry) : entry,
      parent,
      pkg,
      value: mode === 'rename' ? entryName(state, entry)
        : mode === 'folder' ? '新建文件夹'
          : mode === 'script' ? '新建脚本.py'
            : mode === 'kit' ? '新建礼包.kit'
              : mode === 'progress' ? '新建委托.progress'
                : mode === 'navigation' ? '新建导航点.nav'
                  : '新建流程',
      error: '',
    })
  }
  function submitEdit() {
    if (!edit || disabled) return
    try {
      let nextEntry = edit.entry
      if (edit.mode === 'flow' || edit.mode === 'script' || edit.mode === 'kit' || edit.mode === 'progress' || edit.mode === 'navigation') { const key = onNew(edit.value, edit.parent, edit.pkg); nextEntry = { kind: 'document', key } }
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
    if (!documents.length && folders.length > 0 && folders.every(isSectionFolder)) {
      onNotice('内置二级分类不可删除。')
      return
    }
    const removableFolders = folders.filter((key) => {
      if (isSectionFolder(key)) return false
      const remainingDocs = state.documents.some((document) => document.folderId === key && !documents.includes(document.key))
      const remainingFolders = state.folders.some((folder) => folder.parentId === key && !folders.includes(folder.key))
      return !remainingDocs && !remainingFolders
    })
    if (!documents.length && !removableFolders.length) {
      onNotice('请先移走文件夹中的资源，或一并选中其中的流程后再删除。')
      return
    }
    onRemove({ documents, folders: removableFolders })
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
    if (entry.kind === 'folder') return { pkg, parent: entry.key }
    return { pkg, parent: null }
  }
  /** 外部文件导入落点：文档行落到其所在文件夹 */
  function importDropTarget(entry: FlowEntry, pkg: FlowPackageId): { pkg: FlowPackageId; parent: string | null } {
    if (entry.kind === 'document') {
      const document = state.documents.find((item) => item.key === entry.key)
      return { pkg: document?.package ?? pkg, parent: document?.folderId ?? null }
    }
    return dropTargetParent(entry, pkg)
  }
  function canImportInto(entry: FlowEntry, pkg: FlowPackageId) {
    return packageAllowsDocuments(importDropTarget(entry, pkg).pkg)
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
      const next = new Set(rows.filter((item) => item.entry.kind !== 'package' && !(item.entry.kind === 'folder' && isSectionFolder(item.entry.key))).map((item) => entryId(item.entry)))
      if (next.size) { setSelectedIds(next); if (!selectedIds.has(entryId(focus)) || focus.kind === 'package' || (focus.kind === 'folder' && isSectionFolder(focus.key))) setFocus(rows.find((item) => item.entry.kind !== 'package' && !(item.entry.kind === 'folder' && isSectionFolder(item.entry.key)))?.entry ?? defaultFocus) }
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
      else selectOnly(row.parent === null ? packageEntry(row.pkg) : { kind: 'folder', key: row.parent })
    }
    if (event.key === 'Enter') { if (entry.kind === 'document') onSelect(entry.key); else toggle(entry) }
    if (event.key === 'F2' && entry.kind !== 'package' && !(entry.kind === 'folder' && isSectionFolder(entry.key)) && multiCount <= 1) startEdit('rename', entry)
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
        if (isSectionFolder(key)) return false
        const remainingDocs = state.documents.some((document) => document.folderId === key && !selection.documents.includes(document.key))
        const remainingFolders = state.folders.some((folder) => folder.parentId === key && !selection.folders.includes(folder.key))
        return !remainingDocs && !remainingFolders
      })
      const canRemove = selection.documents.length + removableFolders.length > 0
      return [
        { label: `移除所选（${selection.documents.length + removableFolders.length} 项）…`, disabled: !canRemove, hint: canRemove ? '删除选中的流程，以及可安全删除的空文件夹' : '所选文件夹仍有未选中的内容', action: removeCurrentSelection },
      ]
    }
    const entry = menu.entry, pkg = entryPackage(state, entry), folder = entryFolder(state, entry)
    if (entry.kind === 'document') {
      const document = state.documents.find((d) => d.key === entry.key)
      const script = document?.package === 'script'
      const kit = document?.package === 'gift'
      const progress = document?.package === 'progress'
      const navigation = document?.package === 'navigator'
      const openLabel = kit ? '打开礼包' : navigation ? '打开导航点' : progress ? '打开进度' : script ? '打开脚本' : '打开流程'
      const downloadLabel = kit ? '下载礼包' : navigation ? '下载导航点' : progress ? '下载进度' : script ? '下载脚本' : '下载草稿'
      const removeLabel = kit ? '移除礼包…' : navigation ? '移除导航点…' : progress ? '移除进度…' : script ? '移除脚本…' : '移除流程…'
      return [
        { label: openLabel, action: () => onSelect(entry.key) },
        { label: '属性…', action: () => onProperties(entry.key) },
        { label: '重命名', action: () => startEdit('rename', entry) },
        { label: '移动到…', action: () => startEdit('move', entry) },
        ...(script || kit || progress || navigation ? [] : [{ label: '导出树图', action: () => onExport(entry.key) }]),
        { label: downloadLabel, action: () => onDownload(entry.key) },
        { label: removeLabel, action: () => onRemove({ documents: [entry.key], folders: [] }) },
      ]
    }
    const items: NodeMenuItem[] = [{ label: '新建文件夹', action: () => startEdit('folder', entry) }]
    if (packageAllowsFlows(pkg)) {
      items.unshift({ label: '新建流程', action: () => startEdit('flow', entry) })
      items.push({ label: '导入树图…', action: () => onImport(folder, pkg) })
    }
    if (packageAllowsScripts(pkg)) {
      items.unshift({ label: '新建脚本', action: () => startEdit('script', entry) })
      items.push({ label: '导入脚本…', action: () => onImport(folder, pkg) })
    }
    if (packageAllowsKits(pkg)) {
      items.unshift({ label: '新建礼包', action: () => startEdit('kit', entry) })
      items.push({ label: '导入礼包…', action: () => onImport(folder, pkg) })
    }
    if (packageAllowsProgress(pkg)) {
      items.unshift({ label: '新建进度', action: () => startEdit('progress', entry) })
      items.push({ label: '导入进度…', action: () => onImport(folder, pkg) })
    }
    if (packageAllowsNavigation(pkg)) {
      items.unshift({ label: '新建导航点', action: () => startEdit('navigation', entry) })
      items.push({ label: '导入导航点…', action: () => onImport(folder, pkg) })
    }
    if (entry.kind === 'folder') {
      if (isSectionFolder(entry.key)) return items
      items.push(
        { label: '重命名', action: () => startEdit('rename', entry) },
        { label: '移动到…', action: () => startEdit('move', entry) },
        { label: '删除空文件夹', disabled: !isFolderEmpty(state, entry.key), hint: '请先移走文件夹中的资源。', action: () => onRemove({ documents: [], folders: [entry.key] }) },
      )
    }
    return items
  })() : []

  const storyDocCount = state.documents.filter((d) => d.package === 'story').length
  const scriptDocCount = state.documents.filter((d) => d.package === 'script').length
  const kitDocCount = state.documents.filter((d) => d.package === 'gift').length
  const progressDocCount = state.documents.filter((d) => d.package === 'progress').length
  const navigationDocCount = state.documents.filter((d) => d.package === 'navigator').length
  const hasAnyResource = state.documents.length > 0 || state.folders.some((folder) => !isSectionFolder(folder.key))

  return <aside className="flow-library" aria-label="故事流程资源管理器">
    <div className="flow-explorer-heading"><strong>资源管理器</strong><div className="flow-explorer-actions">
      <button type="button" title={newLabel} aria-label={newLabel} disabled={disabled || !!edit || !allowsDocuments || !newDocumentMode} onClick={() => newDocumentMode && startEdit(newDocumentMode)}><Icon kind="new" /></button>
      <button type="button" title="新建文件夹" aria-label="新建文件夹" disabled={disabled || !!edit} onClick={() => startEdit('folder')}><Icon kind="folder" /></button>
      <button type="button" title={importLabel} aria-label={importLabel} disabled={disabled || !!edit || !allowsDocuments} onClick={() => onImport(currentFolder, currentPkg)}><Icon kind="import" /></button>
      <button type="button" title="折叠文件夹" aria-label="折叠文件夹" disabled={!!edit} onClick={() => { setExpanded(new Set([...FLOW_PACKAGE_ORDER.map((pkg) => entryId(packageEntry(pkg))), ...allSectionEntryIds()])); selectOnly(defaultFocus); setSearch('') }}><Icon kind="collapse" /></button>
    </div></div>
    <input className="flow-search" placeholder="筛选资源…" aria-label="筛选资源" value={search} disabled={!!edit} onChange={(event) => setSearch(event.target.value)} />
    <div className="flow-resource-tree" role="tree" aria-label="故事流程文件树" aria-multiselectable="true" onContextMenu={(event) => showMenu(event, defaultFocus)} onPaste={onTreePaste}>
      {rows.map((row, index) => {
        const id = entryId(row.entry), folder = row.entry.kind !== 'document', isSelected = selectedIds.has(id), isFocused = id === entryId(focus), isEditing = edit && entryId(edit.entry) === id
        const section = row.entry.kind === 'folder' && isSectionFolder(row.entry.key)
        const docKey = row.entry.kind === 'document' ? row.entry.key : undefined
        const document = docKey ? state.documents.find((d) => d.key === docKey) : undefined
        const pythonDoc = !!document && (document.package === 'script' || row.name.toLowerCase().endsWith('.py'))
        const kitDoc = !!document && (document.package === 'gift' || row.name.toLowerCase().endsWith('.kit'))
        const progressDoc = !!document && (document.package === 'progress' || row.name.toLowerCase().endsWith('.progress'))
        const navigationDoc = !!document && (document.package === 'navigator' || row.name.toLowerCase().endsWith('.nav'))
        const iconKind = row.entry.kind === 'package' ? row.entry.package : section ? sectionIconKind(row.entry.key) : kitDoc ? 'kit' : navigationDoc ? 'navigator' : progressDoc ? 'progress' : pythonDoc ? 'python' : folder ? 'folder' : 'document'
        return <div key={id} role="none">
          <div ref={(element) => { if (element) elements.current.set(id, element); else elements.current.delete(id) }} className={`flow-resource-row${isSelected ? ' selected' : ''}${row.entry.kind === 'document' && row.entry.key === state.activeKey ? ' is-open' : ''}${dropTarget === id ? ' drop-target' : ''}`} role="treeitem" aria-level={row.depth + 1} aria-selected={isSelected} aria-expanded={folder ? !!search || expanded.has(id) : undefined} aria-disabled={disabled} tabIndex={isFocused || (!rows.some((r) => entryId(r.entry) === entryId(focus)) && index === 0) ? 0 : -1} style={{ paddingLeft: 6 + row.depth * TREE_INDENT }} title={row.name}
            onClick={(event) => clickRow(event, row.entry)}
            onFocus={(event) => { if (event.target === event.currentTarget) setFocus(row.entry) }} onKeyDown={(event) => keyDown(event, row, index)} onContextMenu={(event) => showMenu(event, row.entry)} draggable={!disabled && !edit && row.entry.kind !== 'package' && !section && multiCount <= 1}
            onDragStart={(event) => { dragging.current = row.entry; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-hanshu-progress-entry', id) }}
            onDragEnd={() => { dragging.current = null; setDropTarget(null) }}
            onDragOver={(event) => onRowDragOver(event, row)}
            onDragLeave={() => setDropTarget(null)} onDrop={(event) => onRowDrop(event, row)}>
            <span className="flow-resource-twist" aria-hidden>{folder ? !!search || expanded.has(id) ? '▾' : '▸' : ''}</span><Icon kind={iconKind} />
            {isEditing && edit.mode === 'rename' ? <form className="flow-resource-edit" onSubmit={(event) => { event.preventDefault(); submitEdit() }} onClick={(event) => event.stopPropagation()}><input ref={editInput} aria-label="资源名称" value={edit.value} onChange={(event) => setEdit({ ...edit, value: event.target.value, error: '' })} onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape') cancelEdit() }} /></form> : <span className="flow-resource-name">{row.name}</span>}
          </div>
          {isEditing && (edit.mode === 'flow' || edit.mode === 'script' || edit.mode === 'kit' || edit.mode === 'progress' || edit.mode === 'navigation' || edit.mode === 'folder') && <form className="flow-resource-new" style={{ paddingLeft: 6 + (row.depth + 1) * TREE_INDENT }} onSubmit={(event) => { event.preventDefault(); submitEdit() }}><span className="flow-resource-twist" /><Icon kind={edit.mode === 'folder' ? 'folder' : edit.mode === 'script' ? 'python' : edit.mode === 'kit' ? 'kit' : edit.mode === 'progress' ? 'progress' : edit.mode === 'navigation' ? 'navigator' : 'document'} /><input ref={editInput} aria-label={edit.mode === 'folder' ? '新文件夹名称' : edit.mode === 'script' ? '新脚本名称' : edit.mode === 'kit' ? '新礼包名称' : edit.mode === 'progress' ? '新进度名称' : edit.mode === 'navigation' ? '新导航点名称' : '新流程名称'} value={edit.value} onChange={(event) => setEdit({ ...edit, value: event.target.value, error: '' })} onKeyDown={(event) => { if (event.key === 'Escape') cancelEdit() }} /></form>}
        </div>
      })}
      {search && rows.length === FLOW_PACKAGE_ORDER.length && <p className="flow-explorer-empty">没有匹配的资源</p>}
      {!search && !hasAnyResource && !edit && <p className="flow-explorer-empty">在「故事流程」下新建或拖入 .hflow；「脚本」下新建或拖入 .py；「进度」下新建或拖入 .progress；「导航器」下新建或拖入 .nav；「礼包」下新建或拖入 .kit；其他分类可先建文件夹占位。</p>}
    </div>
    {edit && <div className="flow-explorer-edit-panel" onKeyDown={(event) => { if (event.key === 'Escape') cancelEdit() }}>
      {edit.mode === 'move' ? <><label>移动到<select aria-label="目标文件夹" value={moveSelectValue} onChange={(event) => {
        const [pkg, parent] = event.target.value.split(':') as [FlowPackageId, string]
        if (!isPackageId(pkg)) return
        setEdit({ ...edit, pkg, parent: parent || null, error: '' })
      }}>{moveOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label></> : <p>Enter 确认 · Esc 取消</p>}
      {edit.error && <p className="flow-error" role="alert">{edit.error}</p>}
      <div><button type="button" onClick={submitEdit}>确认</button><button type="button" onClick={cancelEdit}>取消</button></div>
    </div>}
    <div className="flow-library-footer">{multiCount > 1 ? `已选 ${multiCount} 项 · ` : ''}{FLOW_PACKAGE_ORDER.length} 个分类 · {storyDocCount} 个故事流程 · {scriptDocCount} 个脚本 · {progressDocCount} 个进度 · {navigationDocCount} 个导航点 · {kitDocCount} 个礼包 · 拖入/粘贴导入 · Ctrl 多选 · Delete 删除</div>
    {menu && menu.state === state && active && !disabled && <NodeContextMenu x={menu.x} y={menu.y} title={menu.multi ? `已选择 ${multiCount} 项` : entryName(state, menu.entry)} label="资源操作" items={menuItems} onClose={(restore = true) => { setMenu(null); if (restore) elements.current.get(entryId(menu.entry))?.focus() }} />}
  </aside>
}
