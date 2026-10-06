import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { connectEntry, connectNodes, createFlow, disconnectLink, hasContentNode, parseFlow, validateFlow, type CanvasNodeType, type FlowCanvasNote, type FlowInputPort, type FlowPort, type FlowPosition, type FlowSelection, type ProgressFlow } from './progress/model'
import { addNextCheckpoint, createCanvasNote, updateCanvasNote, removeCanvasItems, createCheckpoint, createEndNode, createGoalNode, createPredicateNode, createTransitionNode, createConditionalNode, createDiffNode, createMergeNode, createSwapNode, groupCanvasNodes, moveCanvasNodes, renameCanvasGroup, ungroupCanvasNodes, withCanvasPositions } from './progress/canvas'
import { smartArrangeCanvas } from './progress/arrange'
import { ProgressGraph } from './progress/ProgressGraph'
import { FlowEditorDialog } from './progress/FlowEditorDialog'
import { FlowDocumentProperties } from './progress/FlowDocumentProperties'
import { FlowExplorer } from './progress/FlowExplorer'
import { ensurePackageSections, isKitDocument, isScriptDocument, packageDocumentExt, requireAvailableName, renameFlowEntry, resourceName, uniqueDocumentName } from './progress/library'
import { createFlowDocument, downloadFlowFile, importFlowDocument, loadFlowWorkspace, saveFlowWorkspace, stampDocument, type FlowDocument, type FlowPackageId } from './progress/storage'
import { createKit, readKitSource, stringifyKit, parseKit } from './progress/kit'
import { KitEditor } from './progress/KitEditor'
import Editor from '@monaco-editor/react'
import { HANSHU_THEME_ID, registerHanshuLanguage } from '../monaco/hanshuLanguage'
import './ProgressFlowWorkspace.css'

export type ProgressWorkspaceHandle = { handleMenuAction: (item: string) => void }
type History = { past: string[]; future: string[]; lastEdit: number }

export function ProgressFlowWorkspace({ active, workspaceRef }: { active: boolean; workspaceRef?: Ref<ProgressWorkspaceHandle> }) {
  const [initial] = useState(loadFlowWorkspace)
  const [state, setState] = useState(() => ensurePackageSections(initial.state))
  const [storageError, setStorageError] = useState(initial.error)
  const [notice, setNotice] = useState('')
  const [selection, setSelection] = useState<FlowSelection>({ kind: 'flow' })
  const [editor, setEditor] = useState<{ key: string; flow: ProgressFlow; selection: FlowSelection; origin: HTMLElement | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [showIssues, setShowIssues] = useState(false)
  const [cycleAlert, setCycleAlert] = useState<string | null>(null)
  const [propertiesKey, setPropertiesKey] = useState<string | null>(null)
  const [history, setHistory] = useState(() => new Map<string, History>())
  const fileInput = useRef<HTMLInputElement>(null)
  const importFolder = useRef<{ folderId: string | null; package: FlowPackageId }>({ folderId: null, package: 'story' })
  const seenCycle = useRef<string | null>(null)
  const cycleDialog = useRef<HTMLDialogElement>(null)
  const doc = state.documents.find((item) => item.key === state.activeKey)
  const scriptDoc = doc ? isScriptDocument(doc) : false
  const kitDoc = doc ? isKitDocument(doc) : false
  const kitParsed = useMemo(() => kitDoc && doc ? readKitSource(doc.source) : null, [doc, kitDoc])
  const parsed = useMemo(() => {
    if (!doc || scriptDoc || kitDoc) return { flow: null, error: '' }
    try { return { flow: parseFlow(doc.source), error: '' } }
    catch (error) { return { flow: null, error: error instanceof Error ? error.message : String(error) } }
  }, [doc, scriptDoc, kitDoc])
  const kitOpenDocs = useMemo(() => {
    const keys = state.openKeys ?? []
    return keys
      .map((key) => state.documents.find((item) => item.key === key && item.package === 'gift'))
      .filter((item): item is FlowDocument => !!item)
  }, [state.documents, state.openKeys])
  const issues = useMemo(() => parsed.flow ? validateFlow(parsed.flow) : [], [parsed.flow])
  const errorCount = issues.filter((issue) => issue.severity === 'error').length + (parsed.error ? 1 : 0)
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length
  const cycleWarning = issues.find(issue => issue.path === 'graph' && issue.message.includes('环'))
  const locked = editor !== null || propertiesKey !== null
  const propertiesDoc = propertiesKey ? state.documents.find((item) => item.key === propertiesKey) ?? null : null

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
    catch (error) { setStorageError(`本地保存失败，请从资源管理器导出保留修改。${String(error)}`) }
  }, [state, initial.error])
  useEffect(() => {
    if (!storageError) return
    const preventLoss = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', preventLoss)
    return () => window.removeEventListener('beforeunload', preventLoss)
  }, [storageError])

  function changeSource(source: string, group = false, key = doc?.key) {
    if (!key) return
    const current = state.documents.find((item) => item.key === key)
    if (!current || source === current.source) return
    const previous = history.get(key)
    const entry: History = previous ? { ...previous, past: [...previous.past], future: [] } : { past: [], future: [], lastEdit: 0 }
    if (!group || Date.now() - entry.lastEdit > 600) entry.past = [...entry.past.slice(-49), current.source]
    entry.lastEdit = group ? Date.now() : 0
    setHistory((items) => new Map(items).set(key, entry))
    setState((previous) => ({
      ...previous,
      documents: previous.documents.map((item) => item.key === key ? stampDocument({ ...item, source }) : item),
    }))
  }
  const changeFlow = (flow: ProgressFlow) => changeSource(JSON.stringify(flow, null, 2))
  function openEditor(nextSelection: FlowSelection) {
    if (!doc || !parsed.flow || locked || busy) return
    if (nextSelection.kind !== 'entry' && nextSelection.kind !== 'entry-link' && nextSelection.kind !== 'node') return
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
    const result = operator === 'end' ? createEndNode(parsed.flow, position) : operator === 'transition' ? createTransitionNode(parsed.flow, position) : operator === 'conditional' ? createConditionalNode(parsed.flow, position) : operator === 'diff' ? createDiffNode(parsed.flow, position) : operator === 'merge' ? createMergeNode(parsed.flow, position) : operator === 'swap' ? createSwapNode(parsed.flow, position) : operator === 'note' ? createCanvasNote(parsed.flow, position) : operator === 'goal' ? createGoalNode(parsed.flow, position) : operator === 'predicate' ? createPredicateNode(parsed.flow, position) : createCheckpoint(parsed.flow, position)
    changeFlow(result.flow); setSelection({ kind: operator === 'end' ? 'end' : operator === 'transition' ? 'transition' : operator === 'conditional' ? 'conditional' : operator === 'diff' ? 'diff' : operator === 'merge' ? 'merge' : operator === 'swap' ? 'swap' : operator === 'note' ? 'note' : operator === 'goal' ? 'goal' : operator === 'predicate' ? 'predicate' : 'node', id: result.id })
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
  function withKitOpen(previous: typeof state, key: string) {
    const openKeys = previous.openKeys ?? []
    return openKeys.includes(key) ? openKeys : [...openKeys, key]
  }
  function selectDocument(key: string) {
    if (locked) return
    setState((previous) => {
      const target = previous.documents.find((item) => item.key === key)
      return {
        ...previous,
        activeKey: key,
        openKeys: target?.package === 'gift' ? withKitOpen(previous, key) : previous.openKeys,
      }
    })
    setSelection({ kind: 'flow' }); setNotice('')
  }
  function closeKitTab(key: string) {
    if (locked) return
    setState((previous) => {
      const openKeys = (previous.openKeys ?? []).filter((item) => item !== key)
      const activeKey = previous.activeKey === key
        ? openKeys.at(-1) ?? previous.documents.find((item) => item.package !== 'gift')?.key ?? null
        : previous.activeKey
      return { ...previous, openKeys, activeKey }
    })
    setSelection({ kind: 'flow' })
  }
  function newFlow(value = '新建流程', folderId: string | null = null, packageId: FlowPackageId = 'story') {
    if (locked || busy) throw new Error('请先完成当前修改。')
    const ext = packageDocumentExt(packageId)
    if (!ext) throw new Error('此分类不支持文件。')
    const name = resourceName(value, ext)
    requireAvailableName(state, name, packageId, folderId)
    const title = name.slice(0, -ext.length)
    const next = ext === '.py'
      ? stampDocument({
        key: crypto.randomUUID(),
        name,
        source: '# 目标定义脚本\n\n',
        package: packageId,
        folderId,
      })
      : ext === '.kit'
        ? stampDocument({
          key: crypto.randomUUID(),
          name,
          source: stringifyKit(createKit(title)),
          package: packageId,
          folderId,
        })
        : { ...createFlowDocument(createFlow(undefined, title), packageId), name, folderId, package: packageId }
    setState((previous) => ({
      ...previous,
      documents: [...previous.documents, next],
      activeKey: next.key,
      openKeys: next.package === 'gift' ? withKitOpen(previous, next.key) : previous.openKeys,
    }))
    setSelection({ kind: 'flow' }); setNotice('')
    return next.key
  }
  function requestImport(folderId: string | null, packageId: FlowPackageId) {
    importFolder.current = { folderId, package: packageId }
    const input = fileInput.current
    if (!input) return
    input.accept = packageId === 'script' ? '.py,text/x-python' : packageId === 'gift' ? '.kit,application/json' : '.hflow,.json,application/json'
    input.click()
  }
  async function importFiles(files: File[]) {
    if (!files.length || locked) return
    setBusy(true)
    try {
      const documents: FlowDocument[] = []
      const pkg = importFolder.current.package
      const folderId = importFolder.current.folderId
      for (const file of files) {
        if (file.size > 4 * 1024 * 1024) throw new Error(`${file.name}：文件超过 4 MB`)
        if (pkg === 'script') {
          if (!/\.py$/i.test(file.name)) throw new Error(`${file.name}：请选择 .py 脚本`)
          const name = uniqueDocumentName({ ...state, documents: [...state.documents, ...documents] }, file.name, pkg, folderId)
          documents.push(stampDocument({
            key: crypto.randomUUID(),
            name,
            source: await file.text(),
            package: pkg,
            folderId,
          }))
          continue
        }
        if (pkg === 'gift') {
          if (!/\.kit$/i.test(file.name)) throw new Error(`${file.name}：请选择 .kit 礼包`)
          const source = await file.text()
          parseKit(source)
          const name = uniqueDocumentName({ ...state, documents: [...state.documents, ...documents] }, file.name, pkg, folderId)
          documents.push(stampDocument({
            key: crypto.randomUUID(),
            name,
            source,
            package: pkg,
            folderId,
          }))
          continue
        }
        if (!/\.(hflow|json)$/i.test(file.name)) throw new Error(`${file.name}：请选择 .hflow 或 JSON 树图文档`)
        const imported = importFlowDocument(file.name, await file.text(), pkg)
        imported.folderId = folderId
        imported.name = uniqueDocumentName({ ...state, documents: [...state.documents, ...documents] }, imported.name, pkg, folderId)
        documents.push(imported)
      }
      setState((previous) => ({
        ...previous,
        documents: [...previous.documents, ...documents],
        activeKey: documents[0].key,
        openKeys: pkg === 'gift'
          ? documents.reduce((keys, item) => keys.includes(item.key) ? keys : [...keys, item.key], previous.openKeys ?? [])
          : previous.openKeys,
      }))
      setSelection({ kind: 'flow' })
      setNotice(pkg === 'script' ? `已导入 ${documents.length} 个脚本。` : pkg === 'gift' ? `已导入 ${documents.length} 个礼包。` : `已导入 ${documents.length} 份树图文档。`)
    } catch (error) { setNotice(`导入失败：${String(error)}`) }
    finally { setBusy(false) }
  }
  function exportFlow(key: string) {
    if (locked || busy) return
    const item = state.documents.find((d) => d.key === key)
    if (!item) return
    if (isScriptDocument(item) || isKitDocument(item)) {
      downloadFlowFile(item.name, item.source)
      setNotice(isKitDocument(item) ? '已下载礼包。' : '已下载脚本。')
      return
    }
    try {
      const flow = parseFlow(item.source)
      if (validateFlow(flow).some((issue) => issue.severity === 'error')) throw new Error('请先修复流程的结构错误。')
      downloadFlowFile(item.name, JSON.stringify(flow, null, 2) + '\n')
      setNotice('已导出 HanShu 树图文档。')
    } catch (error) { setNotice(`导出失败：${String(error)}`) }
  }
  function downloadDraft(key: string) {
    if (locked || busy) return
    const item = state.documents.find((d) => d.key === key)
    if (!item) return
    downloadFlowFile(item.name, item.source)
    setNotice('已下载当前草稿。')
  }
  function saveProperties(key: string, next: { name: string; source: string }) {
    const current = state.documents.find((item) => item.key === key)
    if (!current) return
    if (next.source !== current.source) {
      const previous = history.get(key)
      const entry: History = previous ? { ...previous, past: [...previous.past], future: [] } : { past: [], future: [], lastEdit: 0 }
      entry.past = [...entry.past.slice(-49), current.source]
      entry.lastEdit = 0
      setHistory((items) => new Map(items).set(key, entry))
    }
    setState((previous) => {
      let nextState = {
        ...previous,
        documents: previous.documents.map((item) => item.key === key ? stampDocument({ ...item, source: next.source }) : item),
      }
      if (next.name !== current.name) nextState = renameFlowEntry(nextState, { kind: 'document', key }, next.name)
      return nextState
    })
    setPropertiesKey(null)
    setNotice('已更新流程属性。')
  }
  function removeResources({ documents: documentKeys, folders: folderKeys }: { documents: string[]; folders: string[] }) {
    if (locked || busy || (!documentKeys.length && !folderKeys.length)) return
    const parts = [
      documentKeys.length ? `${documentKeys.length} 个流程` : '',
      folderKeys.length ? `${folderKeys.length} 个文件夹` : '',
    ].filter(Boolean)
    if (!window.confirm(`从本机资源中移除 ${parts.join('、')}？`)) return
    const documentSet = new Set(documentKeys)
    const folderSet = new Set(folderKeys)
    setHistory((previous) => {
      const next = new Map(previous)
      for (const key of documentKeys) next.delete(key)
      return next
    })
    setState((previous) => {
      const documents = previous.documents.filter((item) => !documentSet.has(item.key))
      const folders = previous.folders.filter((folder) => {
        if (folder.key.startsWith('section:')) return true
        if (!folderSet.has(folder.key)) return true
        const hasDoc = documents.some((item) => item.folderId === folder.key)
        const hasChild = previous.folders.some((child) => child.parentId === folder.key && !folderSet.has(child.key))
        return hasDoc || hasChild
      })
      const activeKey = previous.activeKey && documentSet.has(previous.activeKey) ? documents[0]?.key ?? null : previous.activeKey
      const openKeys = (previous.openKeys ?? []).filter((key) => documents.some((item) => item.key === key && item.package === 'gift'))
      return { ...previous, documents, folders, activeKey, openKeys }
    })
    if (doc && documentSet.has(doc.key)) setSelection({ kind: 'flow' })
  }
  function saveDraft() {
    if (locked) return
    if (initial.error) { setNotice('原有存储读取失败。请先导出或下载草稿保留当前文档。'); return }
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

  return <section className="flow-workspace" aria-label="故事流程工作区">
    <input ref={fileInput} type="file" multiple hidden onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void importFiles(files) }} />
    {(notice || storageError) && <div className={`flow-notice${storageError ? ' flow-error' : ''}`} role="status">
      {storageError || notice}
      {!storageError && <button type="button" aria-label="关闭提示" onClick={() => setNotice('')}>×</button>}
    </div>}
    <div className="flow-layout">
      <FlowExplorer state={state} active={active} disabled={locked || busy} onChange={setState} onSelect={selectDocument} onNew={newFlow} onImport={requestImport} onExport={exportFlow} onDownload={downloadDraft} onRemove={removeResources} onProperties={setPropertiesKey} onNotice={setNotice} />
      <main className="flow-main">
        {doc ? kitDoc && kitParsed ? (
          <div className="flow-kit-pane">
            {kitOpenDocs.length > 0 && <div className="flow-kit-tabs" role="tablist" aria-label="已打开的礼包">
              {kitOpenDocs.map((item) => (
                <div key={item.key} className={`flow-kit-tab${item.key === doc.key ? ' is-active' : ''}`} role="tab" aria-selected={item.key === doc.key}>
                  <button type="button" className="flow-kit-tab-name" disabled={locked || busy} title={item.name} onClick={() => selectDocument(item.key)}>{item.name}</button>
                  <button type="button" className="flow-kit-tab-close" disabled={locked || busy} aria-label={`关闭 ${item.name}`} onClick={() => closeKitTab(item.key)}>×</button>
                </div>
              ))}
            </div>}
            <KitEditor key={doc.key} kit={kitParsed.kit} error={kitParsed.error} editorPath={`progress-kit-script://${doc.key}.py`} disabled={locked || busy} onChange={(source) => { if (!locked && !busy) changeSource(source, true) }} />
          </div>
        ) : scriptDoc ? (
          <div className="flow-source-pane flow-script-pane">
            <div className="flow-source-heading"><strong>{doc.name}</strong><span className="flow-hint">Python 脚本 · 保存在本机草稿库</span></div>
            <div className="flow-script-editor">
              <Editor
                height="100%"
                language="python"
                theme={HANSHU_THEME_ID}
                value={doc.source}
                path={`progress-script://${doc.key}/${doc.name}`}
                beforeMount={registerHanshuLanguage}
                onChange={(value) => { if (!locked && !busy) changeSource(value ?? '', true) }}
                options={{ fontSize: 13, minimap: { enabled: false }, wordWrap: 'on', automaticLayout: true, scrollBeyondLastLine: false, readOnly: locked || busy }}
              />
            </div>
          </div>
        ) : <>
          {parsed.flow ? (
            <ProgressGraph key={doc.key} flow={parsed.flow} selection={selection} onSelect={setSelection} onEdit={openEditor} onAddNext={addNextNode} onCreate={createNode} onMove={moveCanvasSelection} onGroup={groupCanvasSelection} onUngroup={ungroupCanvasSelection} onRenameGroup={renameGroup} onDelete={deleteNode} onDeleteMany={deleteNodes} onArrange={arrangeSelection} onUpdateNote={updateNote} onConnectEntry={setEntryTarget} onConnect={connectCanvasNodes} onDisconnect={disconnectCanvasLink} onCut={disconnectCanvasLinks} active={active} disabled={locked || busy} />
          ) : (
            <div className="flow-source-pane">
              <div className="flow-source-heading"><strong>草稿无法显示为画布</strong><span className="flow-hint">{parsed.error}</span></div>
              <textarea className="flow-source flow-code" aria-label="修复草稿源码" value={doc.source} onChange={(event) => changeSource(event.target.value, true)} spellCheck={false} />
            </div>
          )}
          <div className={`flow-validation${cycleWarning ? ' has-cycle' : ''}`}>
            <button type="button" className="flow-validation-toggle" aria-expanded={showIssues} onClick={() => setShowIssues(!showIssues)}><span className={errorCount ? 'flow-error' : cycleWarning ? 'flow-warning' : 'flow-valid'}>{errorCount ? `${errorCount} 个结构错误` : cycleWarning ? '画布连线存在环' : '草稿结构校验通过'}</span><span>{cycleWarning ? '环路警告 · ' : ''}{warningCount ? `${warningCount} 条设计提示` : '结构检查'} {showIssues ? '▾' : '▴'}</span></button>
            {showIssues && <div className="flow-issues">{parsed.error && <p className="flow-error">{parsed.error}</p>}{issues.map((issue, index) => <p key={index} className={issue.severity === 'error' ? 'flow-error' : 'flow-warning'}><code>{issue.path}</code> {issue.message}</p>)}<p className="flow-hint">保留独立起点，checkpoint 可自由创建和删除；检查连接引用、条件声明，以及画布连线是否成环（仅警告）。任务归属及执行规则留待后续设计。</p></div>}
          </div>
        </> : <div className="flow-empty"><span className="flow-empty-icon">◇</span><h2>设计一个故事流程</h2><p>在左侧「故事流程」分类中新建或导入 .hflow；「脚本」可新建 .py；「礼包」可新建 .kit。</p></div>}
      </main>
    </div>
    <footer className="flow-statusbar"><span>{storageError ? '本地保存异常' : '草稿自动保存'}{locked ? ' · 正在编辑' : ''}</span><span>{kitDoc ? '礼包 · .kit' : scriptDoc ? '脚本 · Python' : '故事流程 · 原型草稿'}</span></footer>
    {editor && active && <FlowEditorDialog key={editor.key} flow={editor.flow} initialSelection={editor.selection} origin={editor.origin} onComplete={(flow, nextSelection) => { changeFlow(flow); setSelection(nextSelection); setEditor(null) }} onCancel={() => setEditor(null)} />}
    {propertiesDoc && active && <FlowDocumentProperties key={propertiesDoc.key} doc={propertiesDoc} onSave={(next) => saveProperties(propertiesDoc.key, next)} onCancel={() => setPropertiesKey(null)} />}
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
