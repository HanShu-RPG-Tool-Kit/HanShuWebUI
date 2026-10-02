import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { branches, clone, connectEntry, connectNodes, createFlow, disconnectLink, displayText, getNode, hasContentNode, parseFlow, validateFlow, type CanvasNodeType, type FlowCanvasNote, type FlowInputPort, type FlowPort, type FlowPosition, type FlowSelection, type ProgressFlow } from './progress/model'
import { addNextCheckpoint, createCanvasNote, updateCanvasNote, removeCanvasItems, createCheckpoint, createGoalNode, createPredicateNode, createTransitionNode, createConditionalNode, createDiffNode, createMergeNode, createSwapNode, groupCanvasNodes, moveCanvasNodes, renameCanvasGroup, ungroupCanvasNodes, withCanvasPositions } from './progress/canvas'
import { smartArrangeCanvas } from './progress/arrange'
import { ProgressGraph } from './progress/ProgressGraph'
import { FlowEditorDialog } from './progress/FlowEditorDialog'
import { FlowExplorer } from './progress/FlowExplorer'
import { folderPath, requireAvailableName, resourceName, uniqueDocumentName } from './progress/library'
import { createFlowDocument, downloadFlowFile, importFlowDocument, loadFlowWorkspace, saveFlowWorkspace, type FlowDocument } from './progress/storage'
import './ProgressFlowWorkspace.css'

export type ProgressWorkspaceHandle = { handleMenuAction: (item: string) => void }
type History = { past: string[]; future: string[]; lastEdit: number }

export function ProgressFlowWorkspace({ active, workspaceRef }: { active: boolean; workspaceRef?: Ref<ProgressWorkspaceHandle> }) {
  const [initial] = useState(loadFlowWorkspace)
  const [state, setState] = useState(initial.state)
  const [storageError, setStorageError] = useState(initial.error)
  const [notice, setNotice] = useState('')
  const [view, setView] = useState<'tree' | 'source'>('tree')
  const [selection, setSelection] = useState<FlowSelection>({ kind: 'flow' })
  const [editor, setEditor] = useState<{ key: string; flow: ProgressFlow; selection: FlowSelection; origin: HTMLElement | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [showIssues, setShowIssues] = useState(false)
  const [cycleAlert, setCycleAlert] = useState<string | null>(null)
  const [history, setHistory] = useState(() => new Map<string, History>())
  const fileInput = useRef<HTMLInputElement>(null)
  const importFolder = useRef<string | null>(null)
  const seenCycle = useRef<string | null>(null)
  const cycleDialog = useRef<HTMLDialogElement>(null)
  const doc = state.documents.find((item) => item.key === state.activeKey)
  const parsed = useMemo(() => {
    if (!doc) return { flow: null, error: '' }
    try { return { flow: parseFlow(doc.source), error: '' } }
    catch (error) { return { flow: null, error: error instanceof Error ? error.message : String(error) } }
  }, [doc])
  const issues = useMemo(() => parsed.flow ? validateFlow(parsed.flow) : [], [parsed.flow])
  const errorCount = issues.filter((issue) => issue.severity === 'error').length + (parsed.error ? 1 : 0)
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length
  const cycleWarning = issues.find(issue => issue.path === 'graph' && issue.message.includes('环'))
  const locked = editor !== null

  useEffect(() => {
    const message = cycleWarning?.message ?? null
    if (!message) {
      seenCycle.current = null
      return
    }
    if (seenCycle.current === message) return
    seenCycle.current = message
    setCycleAlert(message)
    setShowIssues(true)
  }, [cycleWarning?.message])

  useEffect(() => {
    const element = cycleDialog.current
    if (!element) return
    if (cycleAlert) {
      if (!element.open) element.showModal()
    } else if (element.open) {
      element.close()
    }
  }, [cycleAlert])

  useEffect(() => {
    if (initial.error) return
    // Storage is external and may fail (e.g. quota); surface the failure to the author.
    // eslint-disable-next-line react/set-state-in-effect
    try { saveFlowWorkspace(state); setStorageError('') }
    catch (error) { setStorageError(`本地保存失败，请下载草稿保留修改。${String(error)}`) }
  }, [state, initial.error])
  useEffect(() => {
    if (!storageError) return
    const preventLoss = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', preventLoss)
    return () => window.removeEventListener('beforeunload', preventLoss)
  }, [storageError])

  function changeSource(source: string, group = false) {
    if (!doc || source === doc.source) return
    const previous = history.get(doc.key)
    const entry: History = previous ? { ...previous, past: [...previous.past], future: [] } : { past: [], future: [], lastEdit: 0 }
    if (!group || Date.now() - entry.lastEdit > 600) entry.past = [...entry.past.slice(-49), doc.source]
    entry.lastEdit = group ? Date.now() : 0
    setHistory((items) => new Map(items).set(doc.key, entry))
    setState((previous) => ({ ...previous, documents: previous.documents.map((item) => item.key === doc.key ? { ...item, source } : item) }))
  }
  const changeFlow = (flow: ProgressFlow) => changeSource(JSON.stringify(flow, null, 2))
  function openEditor(nextSelection: FlowSelection) {
    if (!doc || !parsed.flow || locked || busy || nextSelection.kind === 'note') return
    setSelection(nextSelection)
    setEditor({ key: doc.key, flow: parsed.flow, selection: nextSelection, origin: document.activeElement instanceof HTMLElement ? document.activeElement : null })
  }
  function addNextNode(parent: string) {
    if (!parsed.flow || locked || busy) return
    try {
      const result = addNextCheckpoint(parsed.flow, parent)
      changeFlow(result.flow); setSelection({ kind: 'node', id: result.id })
    } catch (error) { setNotice(String(error)) }
  }
  function createNode(position: FlowPosition, operator?: CanvasNodeType) {
    if (!parsed.flow || locked || busy) return
    const result = operator === 'transition' ? createTransitionNode(parsed.flow, position) : operator === 'conditional' ? createConditionalNode(parsed.flow, position) : operator === 'diff' ? createDiffNode(parsed.flow, position) : operator === 'merge' ? createMergeNode(parsed.flow, position) : operator === 'swap' ? createSwapNode(parsed.flow, position) : operator === 'note' ? createCanvasNote(parsed.flow, position) : operator === 'goal' ? createGoalNode(parsed.flow, position) : operator === 'predicate' ? createPredicateNode(parsed.flow, position) : createCheckpoint(parsed.flow, position)
    changeFlow(result.flow); setSelection({ kind: operator === 'transition' ? 'transition' : operator === 'conditional' ? 'conditional' : operator === 'diff' ? 'diff' : operator === 'merge' ? 'merge' : operator === 'swap' ? 'swap' : operator === 'note' ? 'note' : operator === 'goal' ? 'goal' : operator === 'predicate' ? 'predicate' : 'node', id: result.id })
  }
  function moveCanvasSelection(positions: Record<string, FlowPosition>) {
    if (!parsed.flow || locked || busy) return
    changeFlow(moveCanvasNodes(parsed.flow, positions))
  }
  function groupCanvasSelection(ids: string[]) {
    if (!parsed.flow || locked || busy) return null
    const result = groupCanvasNodes(parsed.flow, ids)
    changeFlow(result.flow); setSelection({ kind: 'flow' })
    return result.id
  }
  function ungroupCanvasSelection(id: string) {
    if (!parsed.flow || locked || busy) return
    changeFlow(ungroupCanvasNodes(parsed.flow, id)); setSelection({ kind: 'flow' })
  }
  function deleteNodes(ids: string[], disconnect: FlowSelection[] = []) {
    if (!parsed.flow || locked || busy) return
    let next = parsed.flow
    if (disconnect.length) {
      const fixed = withCanvasPositions(next)
      next = disconnect.reduce(disconnectLink, fixed)
    }
    next = removeCanvasItems(next, ids)
    if (next !== parsed.flow) { changeFlow(next); setSelection({ kind: 'flow' }) }
  }
  function deleteNode(id: string) { deleteNodes([id]) }
  function arrangeSelection(ids: string[]) {
    if (!parsed.flow || locked || busy) return
    const next = smartArrangeCanvas(parsed.flow, ids)
    if (next !== parsed.flow) changeFlow(next)
  }
  function updateNote(id: string, patch: Partial<FlowCanvasNote>) {
    if (!parsed.flow || locked || busy) return
    changeFlow(updateCanvasNote(parsed.flow, id, patch))
  }
  function setEntryTarget(id: string | null) {
    if (!parsed.flow || locked || busy || (id !== null && !hasContentNode(parsed.flow, id))) return
    changeFlow(connectEntry(withCanvasPositions(parsed.flow), id))
  }
  function connectCanvasNodes(from: string, to: string, port: FlowInputPort, fromPort?: FlowPort) {
    if (!parsed.flow || locked || busy) return
    try {
      const fixed = withCanvasPositions(parsed.flow), result = connectNodes(fixed, from, to, port, fromPort ?? 'output')
      if (result.flow !== fixed) changeFlow(result.flow)
      setSelection(result.selection)
    } catch (error) { setNotice(String(error)) }
  }
  function disconnectCanvasLink(link: FlowSelection) {
    disconnectCanvasLinks([link])
  }
  function renameGroup(id: string, name: string) {
    if (!parsed.flow || locked || busy) return
    const next = renameCanvasGroup(parsed.flow, id, name)
    if (next !== parsed.flow) changeFlow(next)
  }
  function disconnectCanvasLinks(links: FlowSelection[]) {
    if (!parsed.flow || locked || busy) return
    const fixed = withCanvasPositions(parsed.flow), next = links.reduce(disconnectLink, fixed)
    if (next !== fixed) { changeFlow(next); setSelection({ kind: 'flow' }) }
  }
  function setNodeCompletion(id: string, finish: boolean) {
    if (!parsed.flow || locked || busy) return
    const next = clone(parsed.flow), node = getNode(next, id)
    if (!node || (finish && (node.children.length || next.logic?.links.some(link => link.from === id)))) return
    node.completion = finish ? 'finish' : 'continue'
    changeFlow(next); setSelection({ kind: 'node', id })
  }
  function undo(redo = false) {
    if (!doc || locked) return
    const previous = history.get(doc.key)
    if (!previous) return
    const entry = { ...previous, past: [...previous.past], future: [...previous.future] }
    const source = (redo ? entry.future : entry.past).pop()
    if (source === undefined) return
    ;(redo ? entry.past : entry.future).push(doc.source)
    entry.lastEdit = 0
    setHistory((items) => new Map(items).set(doc.key, entry))
    setState((previous) => ({ ...previous, documents: previous.documents.map((item) => item.key === doc.key ? { ...item, source } : item) }))
    setSelection({ kind: 'flow' })
  }
  function selectDocument(key: string) {
    if (locked) return
    setState((previous) => ({ ...previous, activeKey: key }))
    setSelection({ kind: 'flow' }); setNotice('')
  }
  function newFlow(value = '新建流程', folderId: string | null = null) {
    if (locked || busy) throw new Error('请先完成当前修改。')
    const name = resourceName(value, true)
    requireAvailableName(state, name, folderId)
    const next = { ...createFlowDocument(createFlow(undefined, name.slice(0, -6))), name, folderId }
    setState((previous) => ({ ...previous, documents: [...previous.documents, next], activeKey: next.key }))
    setSelection({ kind: 'flow' }); setView('tree'); setNotice('')
    return next.key
  }
  function requestImport(folderId: string | null) {
    importFolder.current = folderId; fileInput.current?.click()
  }
  async function importFiles(files: File[]) {
    if (!files.length || locked) return
    setBusy(true)
    try {
      const documents: FlowDocument[] = []
      for (const file of files) {
        if (!/\.(hflow|json)$/i.test(file.name)) throw new Error(`${file.name}：请选择 .hflow 或 JSON 树图文档`)
        if (file.size > 4 * 1024 * 1024) throw new Error(`${file.name}：文件超过 4 MB`)
        const imported = importFlowDocument(file.name, await file.text())
        imported.folderId = importFolder.current
        imported.name = uniqueDocumentName({ ...state, documents: [...state.documents, ...documents] }, imported.name, imported.folderId)
        documents.push(imported)
      }
      setState((previous) => ({ ...previous, documents: [...previous.documents, ...documents], activeKey: documents[0].key }))
      setSelection({ kind: 'flow' }); setView('tree')
      setNotice(`已导入 ${documents.length} 份树图文档。`)
    } catch (error) { setNotice(`导入失败：${String(error)}`) }
    finally { setBusy(false) }
  }
  function exportFlow(key: string) {
    if (locked || busy) return
    const item = state.documents.find((d) => d.key === key)
    if (!item) return
    try {
      const flow = parseFlow(item.source)
      if (validateFlow(flow).some((issue) => issue.severity === 'error')) throw new Error('请先修复流程的结构错误，或使用下载草稿保留原始文档。')
      downloadFlowFile(item.name, JSON.stringify(flow, null, 2) + '\n')
      setNotice('已导出 HanShu 树图文档。')
    } catch (error) { setNotice(`导出失败：${String(error)}`) }
  }
  function removeDocument(key: string) {
    if (locked || busy || !window.confirm('从本机资源中移除此流程？')) return
    const documents = state.documents.filter((item) => item.key !== key)
    setHistory((previous) => { const next = new Map(previous); next.delete(key); return next })
    setState((previous) => ({ ...previous, documents, activeKey: previous.activeKey === key ? documents[0]?.key ?? null : previous.activeKey }))
    if (doc?.key === key) setSelection({ kind: 'flow' })
  }
  function saveDraft() {
    if (locked) return
    if (initial.error) { setNotice('原有存储读取失败。请下载草稿保存当前文档。'); return }
    try { saveFlowWorkspace(state); setStorageError(''); setNotice('流程草稿已保存到本机浏览器。') }
    catch (error) { setStorageError(`保存失败：${String(error)}`) }
  }
  useImperativeHandle(workspaceRef, () => ({ handleMenuAction(item) {
    if (item === '保存') saveDraft()
    if (item === '撤销') undo()
    if (item === '重做') undo(true)
  } }))
  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || locked) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveDraft() }
      const target = event.target as HTMLElement
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return
      if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y')) { event.preventDefault(); undo(event.shiftKey || event.key.toLowerCase() === 'y') }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  return <section className="flow-workspace" aria-label="进度流程工作区">
    <input ref={fileInput} type="file" accept=".hflow,.json,application/json" multiple hidden onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void importFiles(files) }} />
    {(notice || storageError) && <div className={`flow-notice${storageError ? ' flow-error' : ''}`} role="status">
      {storageError || notice}
      {!storageError && <button type="button" aria-label="关闭提示" onClick={() => setNotice('')}>×</button>}
    </div>}
    <div className="flow-layout">
      <FlowExplorer state={state} active={active} disabled={locked || busy} onChange={setState} onSelect={selectDocument} onNew={newFlow} onImport={requestImport} onExport={exportFlow} onRemove={removeDocument} onNotice={setNotice} />
      <main className="flow-main">
        {doc ? <>
          <div className="flow-view-toolbar"><div className="flow-view-tabs" role="tablist" aria-label="流程视图">
            <button type="button" role="tab" aria-selected={view === 'tree'} disabled={locked} onClick={() => setView('tree')}>节点画布</button>
            <button type="button" role="tab" aria-selected={view === 'source'} disabled={locked} onClick={() => setView('source')}>文档结构</button>
          </div><span className="flow-document-path" title={`${folderPath(state, doc.folderId ?? null)} / ${doc.name}`}>{doc.name}</span><button type="button" disabled={locked} onClick={() => { downloadFlowFile(doc.name, doc.source); setNotice('已下载当前草稿。') }}>下载草稿</button></div>
          {view === 'source' ? <div className="flow-source-pane">
            <div className="flow-source-heading"><code>{doc.name}</code><button type="button" disabled={!parsed.flow} onClick={() => parsed.flow && changeFlow(parsed.flow)}>格式化</button></div>
            <textarea className="flow-source flow-code" aria-label="树图文档结构" value={doc.source} onChange={(event) => changeSource(event.target.value, true)} spellCheck={false} />
          </div> : parsed.flow ? <>
            <div className="flow-canvas-heading"><div><strong>{displayText(parsed.flow.title) || '未命名流程'}</strong><small>{Object.keys(parsed.flow.nodes).length} 个阶段{Object.keys(parsed.flow.goals ?? {}).length > 0 && ` · ${Object.keys(parsed.flow.goals!).length} 个目标`}{Object.keys(parsed.flow.predicates ?? {}).length > 0 && ` · ${Object.keys(parsed.flow.predicates!).length} 个谓词`}{Object.keys(parsed.flow.transitions ?? {}).length > 0 && ` · ${Object.keys(parsed.flow.transitions!).length} 个转移节点`}{Object.keys(parsed.flow.conditionals ?? {}).length > 0 && ` · ${Object.keys(parsed.flow.conditionals!).length} 个条件变迁`} · {branches(parsed.flow).length} 条分支</small></div><button type="button" disabled={locked} onClick={() => openEditor({ kind: 'flow' })}>流程信息</button></div>
            <ProgressGraph key={doc.key} flow={parsed.flow} selection={selection} onSelect={setSelection} onEdit={openEditor} onAddNext={addNextNode} onCreate={createNode} onMove={moveCanvasSelection} onGroup={groupCanvasSelection} onUngroup={ungroupCanvasSelection} onRenameGroup={renameGroup} onDelete={deleteNode} onDeleteMany={deleteNodes} onArrange={arrangeSelection} onUpdateNote={updateNote} onConnectEntry={setEntryTarget} onConnect={connectCanvasNodes} onDisconnect={disconnectCanvasLink} onCut={disconnectCanvasLinks} onSetCompletion={setNodeCompletion} active={active} disabled={locked || busy} />
          </> : <div className="flow-empty"><h3>草稿暂时无法显示为树图</h3><p>{parsed.error}</p><button type="button" onClick={() => setView('source')}>修复文档结构</button></div>}
          <div className={`flow-validation${cycleWarning ? ' has-cycle' : ''}`}>
            <button type="button" className="flow-validation-toggle" aria-expanded={showIssues} onClick={() => setShowIssues(!showIssues)}><span className={errorCount ? 'flow-error' : cycleWarning ? 'flow-warning' : 'flow-valid'}>{errorCount ? `${errorCount} 个结构错误` : cycleWarning ? '画布连线存在环' : '草稿结构校验通过'}</span><span>{cycleWarning ? '环路警告 · ' : ''}{warningCount ? `${warningCount} 条设计提示` : '结构检查'} {showIssues ? '▾' : '▴'}</span></button>
            {showIssues && <div className="flow-issues">{parsed.error && <p className="flow-error">{parsed.error}</p>}{issues.map((issue, index) => <p key={index} className={issue.severity === 'error' ? 'flow-error' : 'flow-warning'}><code>{issue.path}</code> {issue.message}</p>)}<p className="flow-hint">保留独立起点，checkpoint 可自由创建和删除；检查连接引用、条件声明，以及画布连线是否成环（仅警告）。任务归属及执行规则留待后续设计。</p></div>}
          </div>
        </> : <div className="flow-empty"><span className="flow-empty-icon">◇</span><h2>设计一个进度流程</h2><p>在左侧资源管理器中新建或导入流程。</p></div>}
      </main>
    </div>
    <footer className="flow-statusbar"><span>{storageError ? '本地保存异常' : '草稿自动保存'}{locked ? ' · 正在编辑' : ''}</span><span>进度流程 · 原型草稿</span></footer>
    {editor && active && <FlowEditorDialog key={editor.key} flow={editor.flow} initialSelection={editor.selection} origin={editor.origin} onComplete={(flow, nextSelection) => { changeFlow(flow); setSelection(nextSelection); setEditor(null) }} onCancel={() => setEditor(null)} />}
    {createPortal(<dialog ref={cycleDialog} className="flow-alert-dialog" aria-labelledby="flow-cycle-alert-title" onCancel={(event) => { event.preventDefault(); setCycleAlert(null) }}>
      <header><strong id="flow-cycle-alert-title">画布连线成环</strong></header>
      <div className="flow-alert-body">
        <p className="flow-warning">{cycleAlert}</p>
        <p className="flow-hint">这只是警告，仍可继续编辑与保存。若需要保持 DAG，请断开环上的某条连线。</p>
      </div>
      <footer>
        <button type="button" onClick={() => { setShowIssues(true); setCycleAlert(null) }}>查看问题列表</button>
        <button type="button" className="flow-primary" onClick={() => setCycleAlert(null)}>知道了</button>
      </footer>
    </dialog>, document.body)}
  </section>
}
