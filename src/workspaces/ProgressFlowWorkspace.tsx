import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react'
import { addNode, branches, clone, createFlow, displayText, getNode, parseFlow, validateFlow, type FlowSelection, type ProgressFlow } from './progress/model'
import { ProgressGraph } from './progress/ProgressGraph'
import { ProgressInspector } from './progress/ProgressInspector'
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
  const [search, setSearch] = useState('')
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [showIssues, setShowIssues] = useState(false)
  const [history, setHistory] = useState(() => new Map<string, History>())
  const fileInput = useRef<HTMLInputElement>(null)
  const doc = state.documents.find((item) => item.key === state.activeKey)
  const parsed = useMemo(() => {
    if (!doc) return { flow: null, error: '' }
    try { return { flow: parseFlow(doc.source), error: '' } }
    catch (error) { return { flow: null, error: error instanceof Error ? error.message : String(error) } }
  }, [doc])
  const issues = useMemo(() => parsed.flow ? validateFlow(parsed.flow) : [], [parsed.flow])
  const errorCount = issues.filter((issue) => issue.severity === 'error').length + (parsed.error ? 1 : 0)
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length
  const locked = Object.values(pending).some(Boolean)
  const currentHistory = doc ? history.get(doc.key) : undefined

  useEffect(() => {
    if (initial.error) return
    // Storage is external and may fail (e.g. quota); surface the failure to the author.
    // eslint-disable-next-line react/set-state-in-effect
    try { saveFlowWorkspace(state); setStorageError('') }
    catch (error) { setStorageError(`本地保存失败，请下载草稿保留修改。${String(error)}`) }
  }, [state, initial.error])
  useEffect(() => {
    if (!locked && !storageError) return
    const preventLoss = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', preventLoss)
    return () => window.removeEventListener('beforeunload', preventLoss)
  }, [locked, storageError])

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
  function addNextNode(parent: string) {
    if (!parsed.flow || locked || busy) return
    try {
      const result = addNode(parsed.flow, parent)
      changeFlow(result.flow); setSelection({ kind: 'node', id: result.id })
    } catch (error) { setNotice(String(error)) }
  }
  function setNodeCompletion(id: string, finish: boolean) {
    if (!parsed.flow || locked || busy) return
    const next = clone(parsed.flow), node = getNode(next, id)
    if (!node || (finish && node.children.length)) return
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
  }
  function selectDocument(key: string) {
    if (locked) return
    setState((previous) => ({ ...previous, activeKey: key }))
    setSelection({ kind: 'flow' }); setNotice('')
  }
  function newFlow() {
    if (locked) return
    const next = createFlowDocument(createFlow(undefined, `进度流程 ${state.documents.length + 1}`))
    setState((previous) => ({ documents: [...previous.documents, next], activeKey: next.key }))
    setSelection({ kind: 'flow' }); setView('tree'); setSearch('')
    setNotice('已创建流程。从起点添加阶段，逐步描述推进条件。')
  }
  async function importFiles(files: File[]) {
    if (!files.length || locked) return
    setBusy(true)
    try {
      const documents: FlowDocument[] = []
      for (const file of files) {
        if (!/\.(hflow|json)$/i.test(file.name)) throw new Error(`${file.name}：请选择 .hflow 或 JSON 树图文档`)
        if (file.size > 4 * 1024 * 1024) throw new Error(`${file.name}：文件超过 4 MB`)
        documents.push(importFlowDocument(file.name, await file.text()))
      }
      setState((previous) => ({ documents: [...previous.documents, ...documents], activeKey: documents[0].key }))
      setSelection({ kind: 'flow' }); setView('tree'); setSearch('')
      setNotice(`已导入 ${documents.length} 份树图文档。`)
    } catch (error) { setNotice(`导入失败：${String(error)}`) }
    finally { setBusy(false) }
  }
  function exportFlow() {
    if (!doc || !parsed.flow || errorCount || locked) return
    downloadFlowFile(doc.name, JSON.stringify(parsed.flow, null, 2) + '\n')
    setNotice('已导出 HanShu 树图文档。')
  }
  function saveDraft() {
    if (locked) { setNotice('请先应用或放弃属性面板中尚未应用的修改。'); return }
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
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveDraft() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  return <section className="flow-workspace" aria-label="进度流程工作区">
    <div className="flow-toolbar">
      <div className="flow-brand"><span aria-hidden>◇</span><strong>进度流程</strong><small>阶段 · 分支 · 条件</small></div>
      <div className="flow-toolbar-actions">
        <button type="button" disabled={locked || busy} onClick={newFlow}>＋ 新建流程</button>
        <button type="button" disabled={locked || busy} onClick={() => fileInput.current?.click()}>导入树图</button>
        <button type="button" disabled={!currentHistory?.past.length || locked} onClick={() => undo()}>撤销</button>
        <button type="button" disabled={!currentHistory?.future.length || locked} onClick={() => undo(true)}>重做</button>
        <button type="button" className="flow-primary" disabled={!doc || !parsed.flow || errorCount > 0 || locked || busy} onClick={exportFlow}>导出树图</button>
      </div>
      <input ref={fileInput} type="file" accept=".hflow,.json,application/json" multiple hidden onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void importFiles(files) }} />
    </div>
    {(notice || storageError || locked) && <div className={`flow-notice${storageError ? ' flow-error' : ''}`} role="status">
      {storageError || (locked ? '属性面板有未应用修改：请先应用或放弃，再切换和导出。' : notice)}
      {!locked && !storageError && <button type="button" aria-label="关闭提示" onClick={() => setNotice('')}>×</button>}
    </div>}
    <div className="flow-layout">
      <aside className="flow-library" aria-label="流程列表">
        <div className="flow-panel-heading"><strong>流程库</strong><span>{state.documents.length}</span></div>
        <input className="flow-search" placeholder="搜索流程…" aria-label="搜索流程" value={search} onChange={(event) => setSearch(event.target.value)} />
        <div className="flow-document-list">{state.documents.map((item) => {
          let title = item.name, id = item.name
          try { const flow = parseFlow(item.source); title = displayText(flow.title) || flow.id; id = flow.id } catch { /* unfinished source stays accessible */ }
          if (!`${title} ${id}`.toLowerCase().includes(search.toLowerCase())) return null
          return <button type="button" className={`flow-document${item.key === doc?.key ? ' selected' : ''}`} key={item.key} disabled={locked} onClick={() => selectDocument(item.key)}><span className="flow-document-mark" aria-hidden>◇</span><span><strong>{title}</strong><small>{id}</small></span></button>
        })}</div>
        <div className="flow-library-footer"><p>树图草稿 · 自动保存在本机</p><p>任务、章节和探索共用流程结构。</p>
          {doc && <button type="button" className="flow-danger" disabled={locked || busy} onClick={() => {
            if (!window.confirm('从本机流程库移除此文档？')) return
            const documents = state.documents.filter((item) => item.key !== doc.key)
            setHistory((previous) => { const next = new Map(previous); next.delete(doc.key); return next })
            setState({ documents, activeKey: documents[0]?.key ?? null }); setSelection({ kind: 'flow' })
          }}>移除当前流程</button>}
        </div>
      </aside>
      <main className="flow-main">
        {doc ? <>
          <div className="flow-view-toolbar"><div className="flow-view-tabs" role="tablist" aria-label="流程视图">
            <button type="button" role="tab" aria-selected={view === 'tree'} disabled={locked} onClick={() => setView('tree')}>流程树</button>
            <button type="button" role="tab" aria-selected={view === 'source'} disabled={locked} onClick={() => setView('source')}>文档结构</button>
          </div><button type="button" disabled={locked} onClick={() => { downloadFlowFile(doc.name, doc.source); setNotice('已下载当前草稿。') }}>下载草稿</button></div>
          {view === 'source' ? <div className="flow-source-pane">
            <div className="flow-source-heading"><code>{doc.name}</code><button type="button" disabled={!parsed.flow} onClick={() => parsed.flow && changeFlow(parsed.flow)}>格式化</button></div>
            <textarea className="flow-source flow-code" aria-label="树图文档结构" value={doc.source} onChange={(event) => changeSource(event.target.value, true)} spellCheck={false} />
          </div> : parsed.flow ? <>
            <div className="flow-canvas-heading"><div><strong>{displayText(parsed.flow.title) || '未命名流程'}</strong><small>{Object.keys(parsed.flow.nodes).length} 个阶段 · {branches(parsed.flow).length} 条分支</small></div><button type="button" disabled={locked} onClick={() => setSelection({ kind: 'flow' })}>流程信息</button></div>
            <ProgressGraph key={doc.key} flow={parsed.flow} selection={selection} onSelect={setSelection} onAddNext={addNextNode} onSetCompletion={setNodeCompletion} active={active} disabled={locked || busy} />
          </> : <div className="flow-empty"><h3>草稿暂时无法显示为树图</h3><p>{parsed.error}</p><button type="button" onClick={() => setView('source')}>修复文档结构</button></div>}
          <div className="flow-validation">
            <button type="button" className="flow-validation-toggle" aria-expanded={showIssues} onClick={() => setShowIssues(!showIssues)}><span className={errorCount ? 'flow-error' : 'flow-valid'}>{errorCount ? `${errorCount} 个结构错误` : '树结构校验通过'}</span><span>{warningCount ? `${warningCount} 条设计提示` : '结构检查'} {showIssues ? '▾' : '▴'}</span></button>
            {showIssues && <div className="flow-issues">{parsed.error && <p className="flow-error">{parsed.error}</p>}{issues.map((issue, index) => <p key={index} className={issue.severity === 'error' ? 'flow-error' : 'flow-warning'}><code>{issue.path}</code> {issue.message}</p>)}<p className="flow-hint">当前检查树结构与条件声明。资源引用是否有效、流程如何执行，将由后续引擎定义。</p></div>}
          </div>
        </> : <div className="flow-empty"><span className="flow-empty-icon">◇</span><h2>设计一个进度流程</h2><p>从阶段和分支开始，描述内容如何推进。</p><button type="button" className="flow-primary" onClick={newFlow}>新建流程</button></div>}
      </main>
      {doc && parsed.flow && view === 'tree' && <aside className="flow-inspector" aria-label="流程属性"><div className="flow-panel-heading"><strong>属性</strong><span>{selection.kind === 'flow' ? '流程' : selection.kind === 'node' ? '阶段' : '分支'}</span></div>
        <ProgressInspector key={`${doc.key}:${selection.kind}:${selection.kind === 'node' ? selection.id : selection.kind === 'branch' ? `${selection.parent}:${selection.id}` : ''}`} flow={parsed.flow} selection={selection} onChange={changeFlow} onSelect={setSelection} onPending={(label, value) => setPending((previous) => ({ ...previous, [label]: value }))} onNotice={setNotice} locked={locked} />
      </aside>}
    </div>
    <footer className="flow-statusbar"><span>{storageError ? '本地保存异常' : '草稿自动保存'}{locked ? ' · 修改未应用' : ''}</span><span>HanShu 树图文档 · v1</span></footer>
  </section>
}
