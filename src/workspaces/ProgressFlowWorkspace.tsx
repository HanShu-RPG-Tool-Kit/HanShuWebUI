import { useEffect, useImperativeHandle, useMemo, useRef, useState, type DragEvent, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { connectEntry, connectNodes, createFlow, disconnectLink, hasContentNode, parseFlow, validateFlow, type CanvasNodeType, type FlowCanvasNote, type FlowInputPort, type FlowPort, type FlowPosition, type FlowSelection, type ProgressFlow } from './progress/model'
import { addNextCheckpoint, createCanvasNote, updateCanvasNote, removeCanvasItems, createCheckpoint, createEndNode, createGoalNode, createPredicateNode, createTransitionNode, createConditionalNode, createDiffNode, createMergeNode, createSwapNode, groupCanvasNodes, moveCanvasNodes, renameCanvasGroup, ungroupCanvasNodes, withCanvasPositions } from './progress/canvas'
import { smartArrangeCanvas } from './progress/arrange'
import { ProgressGraph } from './progress/ProgressGraph'
import { FlowEditorDialog } from './progress/FlowEditorDialog'
import { FlowDocumentProperties } from './progress/FlowDocumentProperties'
import { FlowExplorer } from './progress/FlowExplorer'
import { PageList } from './progress/PageList'
import { EditorSplit } from './progress/EditorSplit'
import { closeAllInGroup, closeInGroup, closeOthersInGroup, closeRightInGroup, focusedGroupId, focusGroup, joinGroups, moveTab, normalizeGroups, openInGroup, readGroup, setSplitRatio, splitTab, togglePinInGroup, type GroupId, type SplitZone } from './progress/editorGroups'
import { ensurePackageSections, isKitDocument, isProgressDocument, isScriptDocument, packageAcceptsImportFile, packageAllowsDocuments, packageDocumentExt, requireAvailableName, renameFlowEntry, resourceName, uniqueDocumentName } from './progress/library'
import { createFlowDocument, downloadFlowFile, importFlowDocument, loadFlowWorkspace, saveFlowWorkspace, stampDocument, type FlowDocument, type FlowPackageId, type FlowWorkspaceState } from './progress/storage'
import { createKit, kitRefFromFileName, readKitSource, stringifyKit, parseKit } from './progress/kit'
import { createProgress, readProgressSource, stringifyProgress, parseProgress } from './progress/progressDoc'
import { buildGoalDefinitionCatalog } from './progress/goalDefinitions'
import { KitEditor } from './progress/KitEditor'
import { ProgressEditor } from './progress/ProgressEditor'
import { useEditorFontSize } from './progress/editorFont'
import Editor from '@monaco-editor/react'
import { HANSHU_THEME_ID, registerHanshuLanguage } from '../monaco/hanshuLanguage'
import './ProgressFlowWorkspace.css'

export type ProgressWorkspaceHandle = { handleMenuAction: (item: string) => void }

type History = { past: string[]; future: string[]; lastEdit: number }
type DropZone = SplitZone | 'center'

/** 指针离哪条边足够近就拆向哪边，否则落入该组（VS Code 的五区规则）。 */
function dropZoneAt(event: DragEvent, splitOn: boolean): DropZone {
  if (splitOn) return 'center'
  const rect = event.currentTarget.getBoundingClientRect()
  const x = (event.clientX - rect.left) / Math.max(1, rect.width)
  const y = (event.clientY - rect.top) / Math.max(1, rect.height)
  const edges: [SplitZone, number][] = [['left', x], ['right', 1 - x], ['top', y], ['bottom', 1 - y]]
  const [zone, distance] = edges.reduce((best, item) => item[1] < best[1] ? item : best)
  return distance < 0.3 ? zone : 'center'
}

export function ProgressFlowWorkspace({ active, workspaceRef }: { active: boolean; workspaceRef?: Ref<ProgressWorkspaceHandle> }) {
  const [initial] = useState(loadFlowWorkspace)
  const editorFontSize = useEditorFontSize()
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
  const [pageDrag, setPageDrag] = useState<{ key: string; group: GroupId } | null>(null)
  const [dropTarget, setDropTarget] = useState<{ group: GroupId; zone: DropZone } | null>(null)
  const splitOn = Boolean(state.split)
  const focusedGroup = focusedGroupId(state)
  const focusedKey = readGroup(state, focusedGroup).activeKey
  const doc = state.documents.find((item) => item.key === focusedKey)
  const scriptDoc = doc ? isScriptDocument(doc) : false
  const kitDoc = doc ? isKitDocument(doc) : false
  const progressDoc = doc ? isProgressDocument(doc) : false
  const goalCatalog = useMemo(() => buildGoalDefinitionCatalog(state), [state.documents, state.folders])
  const kitCatalog = useMemo(() => {
    const map = new Map<string, ReturnType<typeof readKitSource>['kit']>()
    const options: { ref: string; label: string }[] = []
    for (const item of state.documents) {
      if (!isKitDocument(item)) continue
      const ref = kitRefFromFileName(item.name)
      if (!ref || map.has(ref)) continue
      const parsedKit = readKitSource(item.source)
      if (parsedKit.error) continue
      map.set(ref, parsedKit.kit)
      const title = parsedKit.kit.name.trim()
      options.push({ ref, label: title && title !== ref ? `${ref}（${title}）` : ref })
    }
    options.sort((a, b) => a.ref.localeCompare(b.ref, 'zh-CN'))
    return { map, options }
  }, [state.documents])
  const parsed = useMemo(() => {
    if (!doc || scriptDoc || kitDoc || progressDoc) return { flow: null, error: '' }
    try { return { flow: parseFlow(doc.source), error: '' } }
    catch (error) { return { flow: null, error: error instanceof Error ? error.message : String(error) } }
  }, [doc, scriptDoc, kitDoc, progressDoc])
  const docByKey = useMemo(() => new Map(state.documents.map((item) => [item.key, item])), [state.documents])
  const explorerState = useMemo(() => ({ ...state, activeKey: focusedKey }), [state, focusedKey])
  const issues = useMemo(() => parsed.flow ? validateFlow(parsed.flow) : [], [parsed.flow])
  const cycleWarning = issues.find(issue => issue.path === 'graph' && issue.message.includes('环'))
  const locked = editor !== null || propertiesKey !== null
  const propertiesDoc = propertiesKey ? state.documents.find((item) => item.key === propertiesKey) ?? null : null

  useEffect(() => {
    if (!pageDrag) return
    // 被拖的页可能已移到另一组而卸载，收不到自身的 dragend
    const clear = () => { setPageDrag(null); setDropTarget(null) }
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [pageDrag])

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
  const changeFlow = (flow: ProgressFlow, key = focusedKey ?? undefined) => changeSource(JSON.stringify(flow, null, 2), false, key)
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
  /** 编辑组操作；焦点页一旦变化就清空画布选区，避免选区落到别的文档上。 */
  function updateGroups(change: (previous: FlowWorkspaceState) => FlowWorkspaceState) {
    if (locked || busy) return
    const predicted = change(state)
    if (predicted === state) return
    setState(change)
    if (readGroup(predicted, focusedGroupId(predicted)).activeKey !== focusedKey) setSelection({ kind: 'flow' })
  }
  function focusEditorGroup(id: GroupId) {
    if (!splitOn || id === focusedGroup) return
    updateGroups((previous) => focusGroup(previous, id))
  }
  function selectDocument(key: string, group: GroupId = focusedGroup) {
    updateGroups((previous) => openInGroup(previous, group, key))
    setNotice('')
  }
  function dropPage(group: GroupId, zone: DropZone, beforeKey: string | null = null) {
    const drag = pageDrag
    setPageDrag(null); setDropTarget(null)
    if (!drag) return
    if (zone !== 'center') updateGroups((previous) => splitTab(previous, drag.key, zone, 'move'))
    else if (drag.group !== group) updateGroups((previous) => moveTab(previous, drag.group, group, drag.key, beforeKey))
    else if (beforeKey !== drag.key) updateGroups((previous) => moveTab(previous, group, group, drag.key, beforeKey))
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
        : ext === '.progress'
          ? stampDocument({
            key: crypto.randomUUID(),
            name,
            source: stringifyProgress(createProgress(title, goalCatalog.definitions)),
            package: packageId,
            folderId,
          })
        : { ...createFlowDocument(createFlow(undefined, title), packageId), name, folderId, package: packageId }
    setState((previous) => openInGroup({ ...previous, documents: [...previous.documents, next] }, focusedGroupId(previous), next.key))
    setSelection({ kind: 'flow' }); setNotice('')
    return next.key
  }
  function requestImport(folderId: string | null, packageId: FlowPackageId) {
    importFolder.current = { folderId, package: packageId }
    const input = fileInput.current
    if (!input) return
    input.accept = packageId === 'script' ? '.py,text/x-python'
      : packageId === 'gift' ? '.kit,application/json'
        : packageId === 'progress' ? '.progress,application/json'
          : '.hflow,.json,application/json'
    input.click()
  }
  async function importFiles(files: File[], target = importFolder.current) {
    if (!files.length || locked) return
    const pkg = target.package
    const folderId = target.folderId
    if (!packageAllowsDocuments(pkg)) {
      setNotice('该分类暂不支持导入文件。')
      return
    }
    const accepted = files.filter((file) => packageAcceptsImportFile(pkg, file.name))
    const skipped = files.length - accepted.length
    if (!accepted.length) {
      setNotice(pkg === 'script' ? '请放入 .py 脚本。' : pkg === 'gift' ? '请放入 .kit 礼包。' : pkg === 'progress' ? '请放入 .progress 进度。' : '请放入 .hflow 或 JSON 树图文档。')
      return
    }
    setBusy(true)
    try {
      const documents: FlowDocument[] = []
      for (const file of accepted) {
        if (file.size > 4 * 1024 * 1024) throw new Error(`${file.name}：文件超过 4 MB`)
        if (pkg === 'script') {
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
        if (pkg === 'progress') {
          const source = await file.text()
          parseProgress(source)
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
        const imported = importFlowDocument(file.name, await file.text(), pkg)
        imported.folderId = folderId
        imported.name = uniqueDocumentName({ ...state, documents: [...state.documents, ...documents] }, imported.name, pkg, folderId)
        documents.push(imported)
      }
      setState((previous) => openInGroup(
        { ...previous, documents: [...previous.documents, ...documents] },
        focusedGroupId(previous),
        documents.map((item) => item.key),
      ))
      setSelection({ kind: 'flow' })
      const kind = pkg === 'script' ? '个脚本' : pkg === 'gift' ? '个礼包' : pkg === 'progress' ? '个进度' : '份树图文档'
      setNotice(skipped > 0 ? `已导入 ${documents.length} ${kind}，跳过 ${skipped} 个不匹配的文件。` : `已导入 ${documents.length} ${kind}。`)
    } catch (error) { setNotice(`导入失败：${String(error)}`) }
    finally { setBusy(false) }
  }
  function exportFlow(key: string) {
    if (locked || busy) return
    const item = state.documents.find((d) => d.key === key)
    if (!item) return
    if (isScriptDocument(item) || isKitDocument(item) || isProgressDocument(item)) {
      downloadFlowFile(item.name, item.source)
      setNotice(isKitDocument(item) ? '已下载礼包。' : isProgressDocument(item) ? '已下载进度。' : '已下载脚本。')
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
      return normalizeGroups({ ...previous, documents, folders })
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

  function renderDocumentPane(paneDoc: FlowDocument | null, group: GroupId) {
    if (!paneDoc) {
      return <div className="flow-empty is-pane"><span className="flow-empty-icon">◇</span><p>此组未打开文档</p></div>
    }
    const paneScript = isScriptDocument(paneDoc)
    const paneKit = isKitDocument(paneDoc)
    const paneProgress = isProgressDocument(paneDoc)
    const paneKitParsed = paneKit ? readKitSource(paneDoc.source) : null
    const paneProgressParsed = paneProgress ? readProgressSource(paneDoc.source, goalCatalog.definitions) : null
    const paneCatalogOptions = kitCatalog.options.filter((option) => option.ref !== kitRefFromFileName(paneDoc.name))
    const paneCatalog = new Map(kitCatalog.map)
    const selfRef = kitRefFromFileName(paneDoc.name)
    if (selfRef) paneCatalog.delete(selfRef)
    let paneFlow: ProgressFlow | null = null
    let paneError = ''
    if (!paneScript && !paneKit && !paneProgress) {
      try { paneFlow = parseFlow(paneDoc.source) }
      catch (error) { paneError = error instanceof Error ? error.message : String(error) }
    }
    const paneIssues = paneFlow ? validateFlow(paneFlow) : []
    const paneErrors = paneIssues.filter((issue) => issue.severity === 'error').length + (paneError ? 1 : 0)
    const paneWarnings = paneIssues.filter((issue) => issue.severity === 'warning').length
    const paneCycle = paneIssues.find((issue) => issue.path === 'graph' && issue.message.includes('环'))
    // 同一文档可同时开在两组，画布交互只交给焦点组
    const graphLive = group === focusedGroup
    const disabledPane = locked || busy

    if (paneProgress && paneProgressParsed) {
      if (!paneProgressParsed.doc) return <ProgressSourceRepair key={paneDoc.key} source={paneDoc.source} error={paneProgressParsed.error} disabled={disabledPane}
        onApply={source => { if (!disabledPane) changeSource(source, false, paneDoc.key) }} />
      return <div className="flow-kit-pane">
        <ProgressEditor
          key={paneDoc.key}
          doc={paneProgressParsed.doc}
          goalCatalog={goalCatalog}
          kitOptions={kitCatalog.options}
          disabled={disabledPane}
          onChange={(source, discrete) => { if (!disabledPane) changeSource(source, !discrete, paneDoc.key) }}
        />
      </div>
    }
    if (paneKit && paneKitParsed) {
      return <div className="flow-kit-pane">
        <KitEditor
          key={paneDoc.key}
          kit={paneKitParsed.kit}
          error={paneKitParsed.error}
          editorPath={`progress-kit-script://g${group}/${paneDoc.key}.py`}
          selfRef={selfRef}
          catalog={paneCatalog}
          catalogOptions={paneCatalogOptions}
          disabled={disabledPane}
          onChange={(source) => { if (!disabledPane) changeSource(source, true, paneDoc.key) }}
        />
      </div>
    }
    if (paneScript) {
      return <div className="flow-source-pane flow-script-pane">
        <div className="flow-script-editor">
          <Editor
            height="100%"
            language="python"
            theme={HANSHU_THEME_ID}
            value={paneDoc.source}
            path={`progress-script://g${group}/${paneDoc.key}/${paneDoc.name}`}
            beforeMount={registerHanshuLanguage}
            onChange={(value) => { if (!disabledPane) changeSource(value ?? '', true, paneDoc.key) }}
            options={{ fontSize: editorFontSize, mouseWheelZoom: true, minimap: { enabled: false }, wordWrap: 'on', automaticLayout: true, scrollBeyondLastLine: false, padding: { top: 8 }, readOnly: disabledPane }}
          />
        </div>
      </div>
    }
    return <>
      {paneFlow ? (
        <ProgressGraph
          key={paneDoc.key}
          flow={paneFlow}
          selection={graphLive ? selection : { kind: 'flow' }}
          onSelect={(next) => { if (graphLive) setSelection(next) }}
          onEdit={graphLive ? openEditor : () => undefined}
          onAddNext={graphLive ? addNextNode : () => undefined}
          onCreate={graphLive ? createNode : () => undefined}
          onMove={graphLive ? moveCanvasSelection : () => undefined}
          onGroup={graphLive ? groupCanvasSelection : () => null}
          onUngroup={graphLive ? ungroupCanvasSelection : () => undefined}
          onRenameGroup={graphLive ? renameGroup : () => undefined}
          onDelete={graphLive ? deleteNode : () => undefined}
          onDeleteMany={graphLive ? deleteNodes : () => undefined}
          onArrange={graphLive ? arrangeSelection : () => undefined}
          onUpdateNote={graphLive ? updateNote : () => undefined}
          onConnectEntry={graphLive ? setEntryTarget : () => undefined}
          onConnect={graphLive ? connectCanvasNodes : () => undefined}
          onDisconnect={graphLive ? disconnectCanvasLink : () => undefined}
          onCut={graphLive ? disconnectCanvasLinks : () => undefined}
          active={active && graphLive}
          disabled={locked || busy || !graphLive}
        />
      ) : (
        <div className="flow-source-pane">
          <div className="flow-source-heading"><strong>草稿无法显示为画布</strong><span className="flow-hint">{paneError}</span></div>
          <textarea className="flow-source flow-code" aria-label="修复草稿源码" value={paneDoc.source} disabled={locked || busy} onChange={(event) => changeSource(event.target.value, true, paneDoc.key)} spellCheck={false} />
        </div>
      )}
      <div className={`flow-validation${paneCycle ? ' has-cycle' : ''}`}>
        <button type="button" className="flow-validation-toggle" aria-expanded={graphLive && showIssues} onClick={() => { if (graphLive) setShowIssues(!showIssues) }}>
          <span className={paneErrors ? 'flow-error' : paneCycle ? 'flow-warning' : 'flow-valid'}>
            {paneErrors ? `${paneErrors} 个结构错误` : paneCycle ? '画布连线存在环' : '草稿结构校验通过'}
          </span>
          <span>{paneCycle ? '环路警告 · ' : ''}{paneWarnings ? `${paneWarnings} 条设计提示` : '结构检查'} {graphLive && showIssues ? '▾' : '▴'}</span>
        </button>
        {graphLive && showIssues && <div className="flow-issues">
          {paneError && <p className="flow-error">{paneError}</p>}
          {paneIssues.map((issue, index) => <p key={index} className={issue.severity === 'error' ? 'flow-error' : 'flow-warning'}><code>{issue.path}</code> {issue.message}</p>)}
          <p className="flow-hint">保留独立起点，checkpoint 可自由创建和删除；检查连接引用、条件声明，以及画布连线是否成环（仅警告）。任务归属及执行规则留待后续设计。</p>
        </div>}
      </div>
    </>
  }

  function renderGroup(id: GroupId) {
    const group = readGroup(state, id)
    const docs = group.openKeys.map((key) => docByKey.get(key)).filter((item): item is FlowDocument => !!item)
    const paneDoc = group.activeKey ? docByKey.get(group.activeKey) ?? null : null
    const focused = id === focusedGroup
    const hint = dropTarget?.group === id && (dropTarget.zone !== 'center' || pageDrag?.group !== id) ? dropTarget.zone : null
    const other: GroupId = id === 0 ? 1 : 0
    return <div
      className={`flow-group${splitOn && focused ? ' is-focused' : ''}`}
      onPointerDownCapture={() => focusEditorGroup(id)}
      onFocusCapture={() => focusEditorGroup(id)}
    >
      <PageList
        docs={docs}
        activeKey={group.activeKey}
        pinnedKeys={group.pinnedKeys}
        focused={!splitOn || focused}
        splitOn={splitOn}
        disabled={locked || busy}
        dragKey={pageDrag?.key ?? null}
        onSelect={(key) => selectDocument(key, id)}
        onClose={(key) => updateGroups((previous) => closeInGroup(previous, id, [key]))}
        onCloseOthers={(key) => updateGroups((previous) => closeOthersInGroup(previous, id, key))}
        onCloseRight={(key) => updateGroups((previous) => closeRightInGroup(previous, id, key))}
        onCloseAll={() => updateGroups((previous) => closeAllInGroup(previous, id))}
        onTogglePin={(key) => updateGroups((previous) => togglePinInGroup(previous, id, key))}
        onDragStart={(key) => setPageDrag({ key, group: id })}
        onDragEnd={() => { setPageDrag(null); setDropTarget(null) }}
        onDropTab={(beforeKey) => dropPage(id, 'center', beforeKey)}
        onSplit={(key, zone) => updateGroups((previous) => splitTab(previous, key, zone, 'copy'))}
        onMoveToOther={(key) => updateGroups((previous) => moveTab(previous, id, other, key, null))}
        onJoin={() => updateGroups(joinGroups)}
      />
      <div className="flow-group-body">
        {renderDocumentPane(paneDoc, id)}
        {pageDrag && !locked && !busy && (
          <div
            className="flow-drop-target"
            onDragOver={(event) => {
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              const zone = dropZoneAt(event, splitOn)
              if (dropTarget?.group !== id || dropTarget.zone !== zone) setDropTarget({ group: id, zone })
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null)
            }}
            onDrop={(event) => {
              event.preventDefault()
              event.stopPropagation()
              dropPage(id, dropZoneAt(event, splitOn))
            }}
          >
            {hint && <div className={`flow-drop-hint is-${hint}`} />}
          </div>
        )}
      </div>
    </div>
  }

  return <section className="flow-workspace" aria-label="故事流程工作区">
    <input ref={fileInput} type="file" multiple hidden onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void importFiles(files) }} />
    {(notice || storageError) && <div className={`flow-notice${storageError ? ' flow-error' : ''}`} role="status">
      {storageError || notice}
      {!storageError && <button type="button" aria-label="关闭提示" onClick={() => setNotice('')}>×</button>}
    </div>}
    <div className="flow-layout">
      <FlowExplorer state={explorerState} active={active} disabled={locked || busy} onChange={(next) => setState((previous) => normalizeGroups({ ...previous, documents: next.documents, folders: next.folders }))} onSelect={(key) => selectDocument(key)} onNew={newFlow} onImport={requestImport} onImportFiles={(files, folderId, packageId) => { void importFiles(files, { folderId, package: packageId }) }} onExport={exportFlow} onDownload={downloadDraft} onRemove={removeResources} onProperties={setPropertiesKey} onNotice={setNotice} />
      <main className="flow-main">
        {state.split ? (
          <EditorSplit
            direction={state.split.direction}
            ratio={state.split.ratio}
            disabled={locked || busy}
            onRatio={(ratio) => setState((previous) => setSplitRatio(previous, ratio))}
            primary={renderGroup(0)}
            secondary={renderGroup(1)}
          />
        ) : (state.openKeys ?? []).length ? renderGroup(0) : (
          <div className="flow-empty"><span className="flow-empty-icon">◇</span><h2>设计一个故事流程</h2><p>在左侧「故事流程」分类中新建或导入 .hflow；「脚本」可新建 .py；「进度」可新建 .progress 委托表单；「礼包」可新建 .kit。打开的文档会出现在上方页条；把页拖到编辑区的左右上下边缘即可拆分对照。</p></div>
        )}
      </main>
    </div>
    <footer className="flow-statusbar"><span>{storageError ? '本地保存异常' : '草稿自动保存'}{locked ? ' · 正在编辑' : ''}{splitOn ? ' · 二分编辑' : ''}</span><span>{progressDoc ? '进度 · .progress' : kitDoc ? '礼包 · .kit' : scriptDoc ? '脚本 · Python' : '故事流程 · 原型草稿'}</span></footer>
    {editor && active && <FlowEditorDialog key={editor.key} flow={editor.flow} initialSelection={editor.selection} origin={editor.origin} onComplete={(flow, nextSelection) => { changeFlow(flow, editor.key); setSelection(nextSelection); setEditor(null) }} onCancel={() => setEditor(null)} />}
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

function ProgressSourceRepair({ source, error, disabled, onApply }: { source: string; error: string; disabled: boolean; onApply: (source: string) => void }) {
  const [draft, setDraft] = useState(source)
  const [message, setMessage] = useState(error)
  return <div className="progress-source-repair"><h3>进度文件需要修复</h3><p role="alert">{message}</p>
    <span>原始文件已保留。修复并通过校验后才会应用，不会以默认文档覆盖原文。</span>
    <textarea aria-label="进度源码修复" spellCheck={false} value={draft} disabled={disabled} onChange={event => setDraft(event.target.value)} />
    <button type="button" disabled={disabled} onClick={() => { try { parseProgress(draft); onApply(draft) } catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)) } }}>校验并应用修复</button>
  </div>
}

