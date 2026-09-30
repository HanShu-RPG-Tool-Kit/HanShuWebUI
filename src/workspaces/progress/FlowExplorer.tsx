import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { NodeContextMenu, type NodeMenuItem } from './NodeContextMenu'
import { addFlowFolder, canMoveFlowEntry, entryFolder, entryId, folderPath, isFolderEmpty, moveFlowEntry, renameFlowEntry, type FlowEntry } from './library'
import type { FlowWorkspaceState } from './storage'

type Row = { entry: FlowEntry; name: string; depth: number; parent: string | null }
type Edit = { mode: 'flow' | 'folder' | 'rename' | 'move'; entry: FlowEntry; parent: string | null; value: string; error: string }
function Icon({ kind }: { kind: 'folder' | 'document' | 'new' | 'import' | 'collapse' }) {
  const paths = { folder: 'M2 5h6l2 2h12v12H2z', document: 'M5 2h9l5 5v15H5z M14 2v6h5 M8 12h8 M8 16h8', new: 'M5 2h9l5 5v5 M5 2v20h7 M14 2v6h5 M18 14v8 M14 18h8', import: 'M12 2v13 M7 10l5 5 5-5 M3 16v5h18v-5', collapse: 'M4 3h16v14 M2 7h14v14H2z M5 14h8' }
  return <svg className={`flow-resource-icon is-${kind}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={paths[kind]} /></svg>
}
const root: FlowEntry = { kind: 'root' }
const entryName = (state: FlowWorkspaceState, entry: FlowEntry) => entry.kind === 'root' ? '进度流程' : entry.kind === 'folder' ? state.folders.find((f) => f.key === entry.key)?.name ?? '' : state.documents.find((d) => d.key === entry.key)?.name ?? ''

export function FlowExplorer({ state, active, disabled, onChange, onSelect, onNew, onImport, onExport, onRemove, onNotice }: {
  state: FlowWorkspaceState; active: boolean; disabled: boolean
  onChange: (state: FlowWorkspaceState) => void; onSelect: (key: string) => void
  onNew: (name: string, folder: string | null) => string; onImport: (folder: string | null) => void
  onExport: (key: string) => void; onRemove: (key: string) => void; onNotice: (message: string) => void
}) {
  const [selected, setSelected] = useState<FlowEntry>(state.activeKey ? { kind: 'document', key: state.activeKey } : root)
  const [expanded, setExpanded] = useState(() => new Set(['root']))
  const [search, setSearch] = useState('')
  const [edit, setEdit] = useState<Edit | null>(null)
  const [menu, setMenu] = useState<{ entry: FlowEntry; x: number; y: number; state: FlowWorkspaceState } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const elements = useRef(new Map<string, HTMLDivElement>())
  const dragging = useRef<FlowEntry | null>(null)
  const editInput = useRef<HTMLInputElement>(null)
  const currentFolder = entryFolder(state, selected)

  useEffect(() => {
    // Follow documents opened by import or the workspace, including their ancestors.
    // eslint-disable-next-line react/set-state-in-effect
    setSelected(state.activeKey ? { kind: 'document', key: state.activeKey } : root)
    setExpanded((previous) => {
      const next = new Set(previous).add('root')
      let parent = state.documents.find((d) => d.key === state.activeKey)?.folderId ?? null
      while (parent !== null) { next.add(`folder:${parent}`); parent = state.folders.find((f) => f.key === parent)?.parentId ?? null }
      return next
    })
    // Only a newly opened document changes the explorer selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activeKey])
  useEffect(() => { editInput.current?.focus(); editInput.current?.select() }, [edit?.mode, edit?.entry, edit?.parent])
  useEffect(() => {
    // A hidden or locked workspace must dismiss its portal menu.
    // eslint-disable-next-line react/set-state-in-effect
    if (!active || disabled) setMenu(null)
  }, [active, disabled])

  const rows = useMemo(() => {
    const query = search.trim().toLocaleLowerCase(), visible = new Set<string>()
    const includeParents = (parent: string | null) => {
      while (parent !== null) { visible.add(`folder:${parent}`); parent = state.folders.find((f) => f.key === parent)?.parentId ?? null }
    }
    if (query) {
      state.folders.forEach((f) => { if (folderPath(state, f.key).toLocaleLowerCase().includes(query)) { visible.add(`folder:${f.key}`); includeParents(f.parentId) } })
      state.documents.forEach((d) => { if (`${folderPath(state, d.folderId ?? null)} / ${d.name}`.toLocaleLowerCase().includes(query)) { visible.add(`document:${d.key}`); includeParents(d.folderId ?? null) } })
    }
    const result: Row[] = [{ entry: root, name: '进度流程', depth: 0, parent: null }]
    const visit = (parent: string | null, depth: number) => {
      for (const folder of state.folders.filter((f) => f.parentId === parent).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))) {
        const entry: FlowEntry = { kind: 'folder', key: folder.key }, id = entryId(entry)
        if (query && !visible.has(id)) continue
        result.push({ entry, name: folder.name, depth, parent })
        if (query || expanded.has(id)) visit(folder.key, depth + 1)
      }
      for (const doc of state.documents.filter((d) => (d.folderId ?? null) === parent).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))) {
        const entry: FlowEntry = { kind: 'document', key: doc.key }
        if (!query || visible.has(entryId(entry))) result.push({ entry, name: doc.name, depth, parent })
      }
    }
    if (query || expanded.has('root')) visit(null, 1)
    return result
  }, [state, expanded, search])

  function focusEntry(entry: FlowEntry) { setSelected(entry); elements.current.get(entryId(entry))?.focus() }
  function revealFolder(parent: string | null) {
    setExpanded((previous) => {
      const next = new Set(previous).add('root')
      while (parent !== null) { next.add(`folder:${parent}`); parent = state.folders.find((f) => f.key === parent)?.parentId ?? null }
      return next
    })
  }
  function cancelEdit() { if (edit) { const entry = edit.entry; setEdit(null); requestAnimationFrame(() => focusEntry(entry)) } }
  function toggle(entry: FlowEntry) { setExpanded((previous) => { const next = new Set(previous), id = entryId(entry); if (next.has(id)) next.delete(id); else next.add(id); return next }) }
  function startEdit(mode: Edit['mode'], entry = selected) {
    if (disabled) return
    const parent = entryFolder(state, entry)
    setSearch('')
    revealFolder(parent)
    setEdit({ mode, entry: mode === 'flow' || mode === 'folder' ? parent === null ? root : { kind: 'folder', key: parent } : entry, parent, value: mode === 'rename' ? entryName(state, entry) : mode === 'folder' ? '新建文件夹' : '新建流程', error: '' })
  }
  function submitEdit() {
    if (!edit || disabled) return
    try {
      let nextEntry = edit.entry
      if (edit.mode === 'flow') { const key = onNew(edit.value, edit.parent); nextEntry = { kind: 'document', key } }
      if (edit.mode === 'folder') { const result = addFlowFolder(state, edit.value, edit.parent); onChange(result.state); nextEntry = { kind: 'folder', key: result.folder.key }; setExpanded((previous) => new Set(previous).add(`folder:${result.folder.key}`)) }
      if (edit.mode === 'rename') onChange(renameFlowEntry(state, edit.entry, edit.value))
      if (edit.mode === 'move') { onChange(moveFlowEntry(state, edit.entry, edit.parent)); revealFolder(edit.parent) }
      setEdit(null); setSelected(nextEntry); requestAnimationFrame(() => elements.current.get(entryId(nextEntry))?.focus())
    } catch (error) { setEdit({ ...edit, error: error instanceof Error ? error.message : String(error) }) }
  }
  function showMenu(event: MouseEvent, entry: FlowEntry) {
    event.preventDefault(); event.stopPropagation()
    if (disabled || edit) return
    setSelected(entry); setMenu({ entry, x: event.clientX, y: event.clientY, state })
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>, row: Row, index: number) {
    if (event.target !== event.currentTarget || disabled) return
    if (edit) { if (event.key === 'Escape') { event.preventDefault(); cancelEdit() } return }
    const entry = row.entry, folder = entry.kind !== 'document', open = !!search || expanded.has(entryId(entry))
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', 'F2'].includes(event.key)) event.preventDefault()
    if (event.key === 'ArrowDown') focusEntry(rows[Math.min(index + 1, rows.length - 1)].entry)
    if (event.key === 'ArrowUp') focusEntry(rows[Math.max(index - 1, 0)].entry)
    if (event.key === 'Home') focusEntry(root)
    if (event.key === 'End') focusEntry(rows[rows.length - 1].entry)
    if (event.key === 'ArrowRight' && folder) { if (!open) toggle(entry); else if (rows[index + 1]?.depth > row.depth) focusEntry(rows[index + 1].entry) }
    if (event.key === 'ArrowLeft') { if (folder && open && !search) toggle(entry); else focusEntry(row.parent === null ? root : { kind: 'folder', key: row.parent }) }
    if (event.key === 'Enter') { if (entry.kind === 'document') onSelect(entry.key); else toggle(entry) }
    if (event.key === 'F2' && entry.kind !== 'root') startEdit('rename', entry)
    if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
      event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); setMenu({ entry, x: rect.left + 25, y: rect.bottom, state })
    }
  }
  const menuItems: NodeMenuItem[] = menu ? (() => {
    const entry = menu.entry, folder = entryFolder(state, entry)
    if (entry.kind === 'document') return [
      { label: '打开流程', action: () => onSelect(entry.key) },
      { label: '重命名', action: () => startEdit('rename', entry) },
      { label: '移动到…', action: () => startEdit('move', entry) },
      { label: '导出树图', action: () => onExport(entry.key) },
      { label: '移除流程…', action: () => onRemove(entry.key) },
    ]
    return [
      { label: '新建流程', action: () => startEdit('flow', entry) },
      { label: '新建文件夹', action: () => startEdit('folder', entry) },
      { label: '导入树图…', action: () => onImport(folder) },
      ...(entry.kind === 'folder' ? [
        { label: '重命名', action: () => startEdit('rename', entry) },
        { label: '移动到…', action: () => startEdit('move', entry) },
        { label: '删除空文件夹', disabled: !isFolderEmpty(state, entry.key), hint: '请先移走文件夹中的资源。', action: () => { onChange({ ...state, folders: state.folders.filter((f) => f.key !== entry.key) }); setSelected(root) } },
      ] : []),
    ]
  })() : []

  return <aside className="flow-library" aria-label="进度流程资源管理器">
    <div className="flow-explorer-heading"><strong>资源管理器</strong><div className="flow-explorer-actions">
      <button type="button" title="新建流程" aria-label="新建流程" disabled={disabled || !!edit} onClick={() => startEdit('flow')}><Icon kind="new" /></button>
      <button type="button" title="新建文件夹" aria-label="新建文件夹" disabled={disabled || !!edit} onClick={() => startEdit('folder')}><Icon kind="folder" /></button>
      <button type="button" title="导入树图" aria-label="导入树图" disabled={disabled || !!edit} onClick={() => onImport(currentFolder)}><Icon kind="import" /></button>
      <button type="button" title="折叠文件夹" aria-label="折叠文件夹" disabled={!!edit} onClick={() => { setExpanded(new Set(['root'])); setSelected(root); setSearch('') }}><Icon kind="collapse" /></button>
    </div></div>
    <input className="flow-search" placeholder="筛选资源…" aria-label="筛选资源" value={search} disabled={!!edit} onChange={(event) => setSearch(event.target.value)} />
    <div className="flow-resource-tree" role="tree" aria-label="进度流程文件树" onContextMenu={(event) => showMenu(event, root)}>
      {rows.map((row, index) => {
        const id = entryId(row.entry), folder = row.entry.kind !== 'document', isSelected = id === entryId(selected), isEditing = edit && entryId(edit.entry) === id
        return <div key={id} role="none">
          <div ref={(element) => { if (element) elements.current.set(id, element); else elements.current.delete(id) }} className={`flow-resource-row${isSelected ? ' selected' : ''}${row.entry.kind === 'document' && row.entry.key === state.activeKey ? ' is-open' : ''}${dropTarget === id ? ' drop-target' : ''}`} role="treeitem" aria-level={row.depth + 1} aria-selected={isSelected} aria-expanded={folder ? !!search || expanded.has(id) : undefined} aria-disabled={disabled} tabIndex={isSelected || (!rows.some((r) => entryId(r.entry) === entryId(selected)) && index === 0) ? 0 : -1} style={{ paddingLeft: 8 + row.depth * 16 }} title={row.name}
            onClick={() => { if (disabled || edit) return; setSelected(row.entry); if (row.entry.kind === 'document') onSelect(row.entry.key); else toggle(row.entry) }}
            onFocus={(event) => { if (event.target === event.currentTarget) setSelected(row.entry) }} onKeyDown={(event) => keyDown(event, row, index)} onContextMenu={(event) => showMenu(event, row.entry)} draggable={!disabled && !edit && row.entry.kind !== 'root'}
            onDragStart={(event) => { dragging.current = row.entry; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-hanshu-progress-entry', id) }}
            onDragEnd={() => { dragging.current = null; setDropTarget(null) }}
            onDragOver={(event) => { if (!disabled && !edit && folder && dragging.current && canMoveFlowEntry(state, dragging.current, row.entry.kind === 'folder' ? row.entry.key : null)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget(id) } }}
            onDragLeave={() => setDropTarget(null)} onDrop={(event) => { event.preventDefault(); setDropTarget(null); if (disabled || edit || !folder || !dragging.current) return; try { onChange(moveFlowEntry(state, dragging.current, row.entry.kind === 'folder' ? row.entry.key : null)); setExpanded((previous) => new Set(previous).add(id)) } catch (error) { onNotice(String(error)) } dragging.current = null }}>
            <span className="flow-resource-twist" aria-hidden>{folder ? !!search || expanded.has(id) ? '▾' : '▸' : ''}</span><Icon kind={folder ? 'folder' : 'document'} />
            {isEditing && edit.mode === 'rename' ? <form className="flow-resource-edit" onSubmit={(event) => { event.preventDefault(); submitEdit() }} onClick={(event) => event.stopPropagation()}><input ref={editInput} aria-label="资源名称" value={edit.value} onChange={(event) => setEdit({ ...edit, value: event.target.value, error: '' })} onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape') cancelEdit() }} /></form> : <span className="flow-resource-name">{row.name}</span>}
          </div>
          {isEditing && (edit.mode === 'flow' || edit.mode === 'folder') && <form className="flow-resource-new" style={{ paddingLeft: 8 + (row.depth + 1) * 16 }} onSubmit={(event) => { event.preventDefault(); submitEdit() }}><span className="flow-resource-twist" /><Icon kind={edit.mode === 'folder' ? 'folder' : 'document'} /><input ref={editInput} aria-label={edit.mode === 'folder' ? '新文件夹名称' : '新流程名称'} value={edit.value} onChange={(event) => setEdit({ ...edit, value: event.target.value, error: '' })} onKeyDown={(event) => { if (event.key === 'Escape') cancelEdit() }} /></form>}
        </div>
      })}
      {search && rows.length === 1 && <p className="flow-explorer-empty">没有匹配的资源</p>}
      {!search && !state.documents.length && !state.folders.length && !edit && <p className="flow-explorer-empty">右键此处新建流程或文件夹</p>}
    </div>
    {edit && <div className="flow-explorer-edit-panel" onKeyDown={(event) => { if (event.key === 'Escape') cancelEdit() }}>
      {edit.mode === 'move' ? <><label>移动到<select aria-label="目标文件夹" value={edit.parent ?? ''} onChange={(event) => setEdit({ ...edit, parent: event.target.value || null, error: '' })}><option value="">进度流程</option>{state.folders.filter((f) => canMoveFlowEntry(state, edit.entry, f.key)).map((f) => <option key={f.key} value={f.key}>{folderPath(state, f.key)}</option>)}</select></label></> : <p>Enter 确认 · Esc 取消</p>}
      {edit.error && <p className="flow-error" role="alert">{edit.error}</p>}
      <div><button type="button" onClick={submitEdit}>确认</button><button type="button" onClick={cancelEdit}>取消</button></div>
    </div>}
    <div className="flow-library-footer">{state.documents.length} 个流程 · 本机资源</div>
    {menu && menu.state === state && active && !disabled && <NodeContextMenu x={menu.x} y={menu.y} title={entryName(state, menu.entry)} label="资源操作" items={menuItems} onClose={(restore = true) => { setMenu(null); if (restore) elements.current.get(entryId(menu.entry))?.focus() }} />}
  </aside>
}
