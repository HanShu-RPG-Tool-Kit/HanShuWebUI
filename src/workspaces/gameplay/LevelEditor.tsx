import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { stringifyLevelDocument, type LevelArea, type LevelDocument } from './levelDoc'
import {
  deleteArea, deleteLandmark, deleteRegion, levelHistory, levelHistoryCommit, levelHistoryRedo,
  levelHistoryUndo, levelIssues, replaceArea, setAreaY, setLandmarkCustom, setLandmarkParam,
  setRegionCustom, type LevelHistory,
} from './levelEdit'
import { LevelVolumeView } from './levelVolumeView'
import type { LevelSelection, LevelTool } from './levelVolumeEdit'
import { StreamViewport } from './streamViewport'
import { controlLevelTransport } from './levelOnlineControl'
import { createLevelOnlineSession, type LevelDocumentIdentity, type LevelOnlineMeta } from './levelOnline'
import { LevelObjectTree } from './levelObjectTree'
import { LevelInspector } from './levelInspector'
import { coerceSelection, evaluateLevelDrafts, mergeShownArea, planRename, type LevelDraftRecord, type LevelSaveGuard, type LevelViewCommand } from './levelLayoutModel'
import { getProjectSession } from '../../project/projectSession'
import { projectEffectSources } from './effectResourceProject'
import { referencedEffects, type EffectResource } from './effectResources'
import './LevelEditor.css'
import { withRegionEffects, type EffectChannel, type RegionEffectSections } from './regionEffects'

const TOOLS: { id: LevelTool; label: string }[] = [
  { id: 'select', label: '选择' }, { id: 'rect', label: '矩形' }, { id: 'circle', label: '圆' },
  { id: 'polygon', label: '多边形' }, { id: 'landmark', label: '地标' },
]
const TOOL_KEYS = ['V', 'B', 'C', 'P', 'L']
export type { LevelDocumentIdentity }

export function LevelEditor({ doc, disabled, onChange, identity, onHistoryReady, onSaveGuardReady, onPendingChange, onFocusModeChange, historyActions, onSaveRequested }: {
  doc: LevelDocument
  disabled?: boolean
  onChange: (source: string) => void
  identity?: LevelDocumentIdentity | null
  onHistoryReady?: (undo: ((redo: boolean) => void) | null) => void
  onSaveGuardReady?: (guard: LevelSaveGuard | null) => void
  onPendingChange?: (pending: boolean) => void
  onFocusModeChange?: (focus: boolean) => void
  historyActions?: { undo: (redo: boolean) => void; canUndo: boolean; canRedo: boolean }
  onSaveRequested?: () => void | Promise<void>
}) {
  const [history, setHistory] = useState<LevelHistory>(() => levelHistory(doc))
  const historyRef = useRef(history)
  historyRef.current = history
  const [tool, setTool] = useState<LevelTool>('select')
  const [selection, setSelection] = useState<LevelSelection>(null)
  const [draftPoints, setDraftPoints] = useState<[number, number][]>([])
  const [hover, setHover] = useState<[number, number, number] | null>(null)
  const [preview, setPreview] = useState<LevelDocument | null>(null)
  const [mode, setMode] = useState<'volumes' | 'stream'>('volumes')
  const [nativePending, setNativePending] = useState(false)
  const nativePendingRef = useRef(false)
  const saveRequestedRef = useRef(onSaveRequested)
  saveRequestedRef.current = onSaveRequested
  const [wandActive, setWandActive] = useState(false)
  const [wandBusy, setWandBusy] = useState(false)
  const [wandError, setWandError] = useState('')
  const wandRequest = useRef(0)
  const [gestureEpoch, setGestureEpoch] = useState(0)
  const [onlineMeta, setOnlineMeta] = useState<LevelOnlineMeta | null>(null)
  const [effectAudition, setEffectAudition] = useState<{ regionId: string; effects: RegionEffectSections } | null>(null)
  const [inspectorTab, setInspectorTab] = useState<'geometry' | 'effects'>('geometry')
  const [resourceEpoch, setResourceEpoch] = useState(0)
  const [effectChannel, setEffectChannel] = useState<EffectChannel>('fog')
  const effectPreviewId = useRef(crypto.randomUUID())
  const [treeOpen, setTreeOpen] = useState(true)
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [focusMode, setFocusMode] = useState(true)
  const [maximized, setMaximized] = useState(false)
  const [openRegions, setOpenRegions] = useState(() => new Set(doc.regions.map(r => r.id)))
  const [snapStep, setSnapStep] = useState<1 | 0.1>(1)
  const [viewCommand, setViewCommand] = useState<LevelViewCommand>({ sequence: 0, kind: 'perspective' })
  const [viewportHint, setViewportHint] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const [formEpoch, setFormEpoch] = useState(0)
  const fieldDrafts = useRef(new Map<string, LevelDraftRecord>())
  const committed = useRef(stringifyLevelDocument(doc))
  const commitRef = useRef<(next: LevelDocument, origin?: 'local' | 'remote') => void>(() => {})
  const onlineRef = useRef<ReturnType<typeof createLevelOnlineSession> | null>(null)
  const base = history.current
  const shown = preview ?? base
  const auditionRef = useRef({ mode, selection }); auditionRef.current = { mode, selection }
  const auditionEffects = useCallback(async (effects: RegionEffectSections | null, audio: boolean, sources: EffectResource[] = []) => {
    const active = auditionRef.current
    const id = active.selection?.kind === 'region' ? active.selection.id : ''
    setEffectAudition(effects ? { regionId: id, effects } : null)
    if (active.mode === 'stream' || effects === null) {
      const client = getProjectSession().binding?.handle.client
      const bundle = effects && client ? await projectEffectSources(client, referencedEffects(effects), sources) : sources
      if (client !== getProjectSession().binding?.handle.client) throw Error('工程已切换')
      await onlineRef.current?.previewEffects(effectPreviewId.current, id, effects, audio, bundle)
    }
  }, [])
  const issues = levelIssues(shown)
  const live = useRef({ disabled, shown, selection })
  live.current = { disabled, shown, selection }
  const callbacks = useRef({ onHistoryReady, onSaveGuardReady, onPendingChange, onFocusModeChange })
  callbacks.current = { onHistoryReady, onSaveGuardReady, onPendingChange, onFocusModeChange }

  const recordDraft = useCallback((id: string, record: LevelDraftRecord | null) => {
    if (record) fieldDrafts.current.set(id, record)
    else fieldDrafts.current.delete(id)
    const next = [...fieldDrafts.current.values()].some(d => d.pending || !!d.message)
    setPending(previous => previous === next ? previous : next)
  }, [])

  function discardFields() {
    fieldDrafts.current.clear()
    setPending(false)
    setMessage('')
    setFormEpoch(n => n + 1)
  }

  function commit(next: LevelDocument, origin: 'local' | 'remote' = 'local') {
    if (live.current.disabled) return
    if (origin === 'local' && nativePendingRef.current) return
    if (origin === 'local') onlineRef.current?.cancelGesture('commit')
    const text = stringifyLevelDocument(next)
    setPreview(null)
    if (text === committed.current) return
    committed.current = text
    const nextHistory = historyActions ? levelHistory(next) : levelHistoryCommit(historyRef.current, next)
    historyRef.current = nextHistory
    setHistory(nextHistory)
    onChange(text)
  }
  commitRef.current = commit

  function flushFields(): { ok: boolean; message?: string } {
    if (nativePendingRef.current) return { ok: false, message: '游戏内属性尚未应用，请在原生编辑器中应用或重载属性。' }
    const current = historyRef.current.current
    const result = evaluateLevelDrafts(current, live.current.shown, fieldDrafts.current.values(), { readOnly: !!live.current.disabled })
    if (!result.ok) { setMessage(result.message); return result }
    const invalid = levelIssues(result.doc)[0]
    if (invalid) { setMessage(invalid); return { ok: false, message: invalid } }
    if (fieldDrafts.current.size) {
      const selected = live.current.selection
      // A valid rename changes only an id at the same array index. Keep that object selected after the guard flush.
      if (selected?.kind === 'region' && !result.doc.regions.some(r => r.id === selected.id)) {
        const index = current.regions.findIndex(r => r.id === selected.id)
        const renamed = result.doc.regions[index]
        if (renamed) setSelection({ ...selected, id: renamed.id })
      } else if (selected?.kind === 'landmark' && !result.doc.landmarks.some(p => p.id === selected.id)) {
        const index = current.landmarks.findIndex(p => p.id === selected.id)
        const renamed = result.doc.landmarks[index]
        if (renamed) setSelection({ ...selected, id: renamed.id })
      }
      commitRef.current(result.doc)
      discardFields()
    }
    return { ok: true }
  }
  const guardRef = useRef(flushFields)
  guardRef.current = flushFields

  function selectObject(next: LevelSelection, remote = false) {
    if (JSON.stringify(next) === JSON.stringify(live.current.selection)) return
    if (!remote && !guardRef.current().ok) { setInspectorOpen(true); setMaximized(false); return }
    setSelection(next)
    if (next?.kind === 'region') setOpenRegions(previous => new Set(previous).add(next.id))
    setMessage('')
  }
  const selectRef = useRef(selectObject)
  selectRef.current = selectObject

  function undo(redo: boolean) {
    if (live.current.disabled) return
    if (!flushFields().ok) return
    const cancelledPreview = onlineRef.current?.cancelGesture('history') || preview !== null || draftPoints.length > 0
    setPreview(null); setDraftPoints([]); setGestureEpoch(n => n + 1)
    if (cancelledPreview) return
    if (historyActions) { historyActions.undo(redo); return }
    const previous = historyRef.current
    const next = redo ? levelHistoryRedo(previous) : levelHistoryUndo(previous)
    if (next === previous) return
    committed.current = stringifyLevelDocument(next.current)
    historyRef.current = next; setHistory(next)
    setSelection(previousSelection => coerceSelection(next.current, previousSelection))
    discardFields()
    onChange(committed.current)
  }
  const undoRef = useRef(undo)
  undoRef.current = undo
  useEffect(() => {
    callbacks.current.onHistoryReady?.(redo => undoRef.current(redo))
    callbacks.current.onSaveGuardReady?.(() => guardRef.current())
    return () => {
      callbacks.current.onHistoryReady?.(null)
      callbacks.current.onSaveGuardReady?.(null)
      callbacks.current.onPendingChange?.(false)
      callbacks.current.onFocusModeChange?.(false)
    }
  }, [])
  useEffect(() => {
    callbacks.current.onPendingChange?.(pending || nativePending)
    if (!pending) setMessage('')
  }, [pending, nativePending])
  useEffect(() => { callbacks.current.onFocusModeChange?.(focusMode) }, [focusMode])

  useEffect(() => {
    const text = stringifyLevelDocument(doc)
    if (text === committed.current) return
    onlineRef.current?.cancelGesture('external')
    committed.current = text
    const nextHistory = levelHistory(doc)
    historyRef.current = nextHistory; setHistory(nextHistory)
    setPreview(null); setDraftPoints([]); setGestureEpoch(n => n + 1)
    discardFields()
    setSelection(previous => coerceSelection(doc, previous))
  }, [doc])

  useEffect(() => {
    const session = createLevelOnlineSession({ transport: controlLevelTransport(), effects: {
      preview: setPreview, cancelPreview: () => setPreview(null),
      commit: next => commitRef.current(next, 'remote'),
      select: next => selectRef.current(next, true), meta: setOnlineMeta,
      nativePending: value => { nativePendingRef.current = value; setNativePending(value) },
      action: action => { if (action === 'effect_new') { setInspectorOpen(true); setInspectorTab('effects'); setResourceEpoch(n => n + 1) } else if (action === 'save') void saveRequestedRef.current?.(); else undoRef.current(action === 'redo') },
    } })
    onlineRef.current = session
    session.configure({ identity: identity ?? null, doc: history.current, selection, tool, writable: !disabled })
    return () => { wandRequest.current += 1; session.dispose(); if (onlineRef.current === session) onlineRef.current = null }
    // One controller per mounted document; later effects synchronize the current snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    onlineRef.current?.configure({ identity: identity ?? null, doc: history.current, selection, tool, writable: !disabled && !pending })
  }, [history, selection, tool, disabled, pending, identity?.projectId, identity?.clientId, identity?.resourceId])

  const region = selection?.kind === 'region' ? shown.regions.find(r => r.id === selection.id) : undefined
  const area = region && selection?.kind === 'region' ? region.areas[selection.area] : undefined
  const landmark = selection?.kind === 'landmark' ? shown.landmarks.find(p => p.id === selection.id) : undefined

  function remove(kind: 'volume' | 'region' | 'landmark') {
    if (disabled || !flushFields().ok) return
    const current = historyRef.current.current
    const next = selection?.kind === 'landmark' ? deleteLandmark(current, selection.id)
      : selection?.kind === 'region' ? kind === 'region' ? deleteRegion(current, selection.id) : deleteArea(current, selection.id, selection.area) : current
    commit(next); setSelection(coerceSelection(next, selection)); discardFields()
  }
  function rename(kind: 'region' | 'landmark', raw: string): string | null {
    if (disabled || !selection || selection.kind !== kind) return '当前对象不可编辑'
    const plan = planRename(historyRef.current.current, kind, selection.id, raw)
    if (!plan.ok) return plan.message
    if (!plan.unchanged) {
      commit(plan.doc)
      setSelection({ ...selection, id: plan.id })
    }
    return null
  }
  function commitArea(next: LevelArea) {
    if (!region || !area || selection?.kind !== 'region') return
    const current = historyRef.current.current
    const committedArea = current.regions.find(r => r.id === region.id)?.areas[selection.area]
    if (!committedArea) return
    const merged = mergeShownArea(committedArea, area, next)
    commit(replaceArea(current, region.id, selection.area, { ...merged, y: JSON.stringify(next.y) === JSON.stringify(area.y) ? committedArea.y : next.y }))
  }
  function commitLandmarkParam(param: { x: number; y: number; z: number }) {
    if (!landmark) return
    const current = historyRef.current.current
    const original = current.landmarks.find(p => p.id === landmark.id)
    if (!original) return
    const next = { ...original.param }
    for (const axis of ['x', 'y', 'z'] as const) if (param[axis] !== landmark.param[axis]) next[axis] = param[axis]
    commit(setLandmarkParam(current, landmark.id, next))
  }
  function showStream(next: boolean) {
    if (wandBusy) return
    if (!flushFields().ok) return
    onlineRef.current?.cancelGesture('mode'); setPreview(null); setDraftPoints([])
    if (wandActive && !next) void onlineRef.current?.release()
    setWandActive(false); setWandError('')
    setGestureEpoch(n => n + 1); setMode(next ? 'stream' : 'volumes'); setViewportHint(null)
  }
  async function toggleWand() {
    if (wandBusy || !flushFields().ok) return
    const session = onlineRef.current
    if (!session) return
    const request = ++wandRequest.current
    setWandBusy(true); setWandError('')
    if (wandActive) {
      setWandActive(false)
      try { await session.release() } finally { if (request === wandRequest.current) setWandBusy(false) }
      return
    }
    session.configure({ identity: identity ?? null, doc: historyRef.current.current, selection, tool, writable: !disabled })
    session.cancelGesture('wand')
    setPreview(null); setDraftPoints([]); setGestureEpoch(n => n + 1)
    try {
      await session.acquire()
      if (request === wandRequest.current) setWandActive(true)
    } catch (error) {
      await session.release()
      if (request === wandRequest.current) {
        const reason = error instanceof Error ? error.message : String(error)
        setWandError(reason === 'edit_busy' ? '另一窗口正在编辑这张地图，请先在该窗口结束编辑。' : '无法绑定游戏客户端。请检查“游戏开发服务器”连接，进入世界后重试。')
      }
    } finally { if (request === wandRequest.current) setWandBusy(false) }
  }
  function setView(kind: LevelViewCommand['kind']) { setViewCommand(previous => ({ sequence: previous.sequence + 1, kind })) }
  function onKeyDown(event: ReactKeyboardEvent) {
    const target = event.target as HTMLElement
    if (target.closest('input, textarea, select, [contenteditable="true"], .level-stream')) return
    const key = event.key.toLowerCase()
    if ((event.ctrlKey || event.metaKey) && (key === 'z' || key === 'y')) {
      event.preventDefault(); event.stopPropagation(); undo(key === 'y' || event.shiftKey)
    } else if (event.key === 'Escape') { setDraftPoints([]); setTool('select') }
    else if (key === 'f' && mode === 'volumes') { event.preventDefault(); setView('focus') }
    else if (mode === 'volumes' && !disabled && !pending && !event.ctrlKey && !event.metaKey && !event.altKey && TOOL_KEYS.includes(key.toUpperCase())) {
      event.preventDefault(); setTool(TOOLS[TOOL_KEYS.indexOf(key.toUpperCase())].id); setDraftPoints([])
    }
    else if (!disabled && (event.key === 'Delete' || event.key === 'Backspace') && selection) { event.preventDefault(); remove('volume') }
  }
  const selectionText = region && selection?.kind === 'region' ? `${region.id} / 体积 ${selection.area + 1} · 共 ${region.areas.length} 个`
    : landmark ? `地标 ${landmark.id}` : '未选中对象'
  const hint = pending ? '有未完成编辑 · 应用或放弃后继续'
    : disabled ? '只读 · 可浏览与检查'
    : mode === 'stream' ? (onlineMeta?.window ? 'G 自由观察 · Esc释放鼠标 · 应用到测试世界后进入游戏试玩' : '等待游戏连接…')
    : viewportHint || (tool === 'rect' || tool === 'circle' ? '点击起点、再点终点；也可左键拖出范围 · Esc 取消'
      : tool === 'polygon' ? '左键逐点添加，Enter 完成 · Esc 取消'
        : `G 自由观察 · Esc释放鼠标 · 左键选中 · 拖控制点调整${hover ? ` · X ${hover[0]} Y ${hover[1]} Z ${hover[2]}` : ''}`)

  return <div className="level-editor" data-focus={focusMode} data-tree={treeOpen} data-inspector={inspectorOpen} data-maximized={maximized} tabIndex={0} onKeyDown={onKeyDown}>
    <div className="level-toolbar" role="toolbar" aria-label="地图工具">
      <div className="level-mode-switch">
        <button type="button" className={mode === 'volumes' ? 'is-active' : ''} aria-pressed={mode === 'volumes'} onClick={() => showStream(false)}>离线 3D</button>
        <button type="button" className={mode === 'stream' ? 'is-active' : ''} aria-pressed={mode === 'stream'} onClick={() => showStream(true)}>游戏内</button>
        <button type="button" className={wandActive ? 'is-active' : ''} aria-pressed={wandActive} disabled={mode === 'stream' || wandBusy || (!wandActive && (disabled || pending))} onClick={() => { void toggleWand() }}>{wandBusy ? '绑定中…' : '魔杖圈选'}</button>
      </div>
      <div className="level-toolbar-group">
        {mode !== 'stream' && TOOLS.map((item, index) => <button key={item.id} type="button" title={`${item.label} · ${TOOL_KEYS[index]}`} aria-keyshortcuts={TOOL_KEYS[index]} aria-pressed={tool === item.id} className={tool === item.id ? 'is-active' : ''} disabled={disabled || pending} onClick={() => { setTool(item.id); setDraftPoints([]) }}>{item.label}</button>)}
      </div>
      <div className="level-toolbar-group">
        <button type="button" aria-label="撤销地图编辑" onMouseDown={event => event.preventDefault()} disabled={disabled || !(historyActions ? historyActions.canUndo : history.undo.length)} onClick={() => undo(false)}>撤销</button>
        <button type="button" aria-label="重做地图编辑" onMouseDown={event => event.preventDefault()} disabled={disabled || !(historyActions ? historyActions.canRedo : history.redo.length)} onClick={() => undo(true)}>重做</button>
      </div>
      <div className="level-view-actions">
        <details className="level-navigation-help" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() } }}>
          <summary>操作指南</summary>
          <div role="note" aria-label="视口操作指南">
            <strong>选取与调整</strong>
            <p>左键选中区域。拖金色中心移动，拖边角改大小，拖绿色控制点调整高度。</p>
            <strong>观察与移动</strong>
            <dl><dt>G 自由观察</dt><dd>鼠标直接转向，WASD移动，空格/Shift升降</dd><dt>Esc</dt><dd>释放鼠标，回到面板与控制点编辑</dd><dt>中键 / Shift＋中键</dt><dd>环绕 / 平移画面</dd><dt>滚轮 / F</dt><dd>缩放 / 对准选中</dd></dl>
            <p>自由观察时 Ctrl 加速，滚轮调速。Q/E 不用于镜头升降。</p>
            <small>观察镜头不移动玩家。应用到测试世界后，进入游戏试玩，使用原版键位走入区域检查效果；保存工程和预览不会自动应用。</small>
          </div>
        </details>
        <button type="button" aria-pressed={treeOpen && !maximized} onClick={() => { setTreeOpen(!treeOpen || maximized); setMaximized(false) }}>对象</button>
        <button type="button" aria-pressed={inspectorOpen && !maximized} onClick={() => { if (flushFields().ok) { setInspectorOpen(!inspectorOpen || maximized); setMaximized(false) } }}>属性</button>
        <button type="button" aria-pressed={maximized} onClick={() => { if (flushFields().ok) setMaximized(!maximized) }}>{maximized ? '还原视口' : '最大化视口'}</button>
        <button type="button" onClick={() => setFocusMode(!focusMode)}>{focusMode ? '显示资源' : '专注区域'}</button>
      </div>
    </div>
    {(pending || message) && <div className="level-pending-banner" role="status"><span>{message || '有未完成编辑，请应用或放弃。'}</span><button type="button" onClick={discardFields}>放弃未完成编辑</button></div>}
    {treeOpen && !maximized && <aside className="level-list" aria-label="对象列表">
      <header className="level-panel-head"><h2>对象 <small>{shown.regions.length} 区域</small></h2><button type="button" aria-label="收起对象列表" onClick={() => setTreeOpen(false)}>×</button></header>
      <LevelObjectTree doc={shown} selection={selection} openRegions={openRegions}
        onToggleRegion={id => setOpenRegions(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next })}
        onSelectRegion={id => selectObject({ kind: 'region', id, area: 0 })}
        onSelectVolume={(id, index) => selectObject({ kind: 'region', id, area: index })}
        onSelectLandmark={id => selectObject({ kind: 'landmark', id })} />
    </aside>}
    <div className="level-stage">
      {nativePending && <div className="level-wand-card" role="status">游戏内属性尚未应用。请先在游戏编辑器里应用或重载属性。</div>}
      {(wandActive || wandError) && <div className="level-wand-card" role="status">
        {wandError ? <span>{wandError}</span> : <>
          <strong>{onlineMeta ? '游戏魔杖已绑定当前地图' : '游戏连接中断 · 等待恢复'}</strong>
          <span>游戏内输入 <code>/rpgtoolkit region wand</code> 获取魔杖。右键打开选区工作台；左键 / Shift＋左键也可选取两个角点。</span>
          <span>{disabled || pending ? '当前不可提交：请先处理权限或未完成编辑。' : '确认后同步到此处的区域与属性，可撤销；Ctrl＋S 保存。'}</span>
        </>}
        {wandError && <button type="button" onClick={() => setWandError('')}>关闭提示</button>}
      </div>}
      {mode === 'volumes' && <div className="level-tools" role="toolbar" aria-label="三维视图工具">
        <button type="button" onClick={() => setView('focus')}>对准选中 F</button>
        <select aria-label="视图方向" value={viewCommand.kind === 'focus' ? '' : viewCommand.kind} onChange={event => setView(event.target.value as LevelViewCommand['kind'])}>
          <option value="" disabled>对准选中</option><option value="perspective">透视</option><option value="top">顶视</option><option value="front">前视</option><option value="side">侧视</option>
        </select>
        <label>步长 <select aria-label="吸附步长" value={snapStep} onChange={event => setSnapStep(Number(event.target.value) as 1 | 0.1)}><option value={1}>1 方块</option><option value={0.1}>0.1 方块</option></select></label>
        <span>Alt 临时精细</span>
      </div>}
      {mode === 'stream' ? <StreamViewport key="interactive" meta={onlineMeta} editor={{
        acquire: async () => { const session = onlineRef.current; if (!session) throw new Error('edit_unavailable'); await session.acquire(); await session.openEditor() },
        release: () => onlineRef.current?.release() ?? Promise.resolve(),
        beforeSave: () => { onlineRef.current?.cancelGesture('save'); setPreview(null); setDraftPoints([]); setGestureEpoch(n => n + 1) },
        history: redo => undoRef.current(redo), cancel: () => onlineRef.current?.cancelGesture('input'),
        shortcut: action => onlineRef.current?.shortcut(action) ?? Promise.reject(new Error('edit_unavailable')),
      }} /> : <LevelVolumeView base={base} shown={shown} tool={tool} selection={selection} draftPoints={draftPoints}
        effectAudition={effectAudition}
        disabled={disabled || pending} resetToken={String(gestureEpoch)} snapStep={snapStep} viewCommand={viewCommand} onViewportHint={setViewportHint}
        onHover={setHover} onPreview={setPreview} onCommit={commit} onSelection={selectObject} onCreated={() => setTool('select')} onDraftPoints={setDraftPoints} />}
      {issues.length > 0 && <ul className="level-issues">{issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
    </div>
    {inspectorOpen && !maximized && <aside className="level-inspector" aria-label="对象属性">
      <header className="level-panel-head"><h2>属性</h2><button type="button" aria-label="收起属性面板" onClick={() => { if (flushFields().ok) setInspectorOpen(false) }}>×</button></header>
      <LevelInspector key={formEpoch} shown={shown} selection={selection} disabled={disabled || nativePending} pending={pending} onDraft={recordDraft} onDiscard={discardFields}
        view={{ tab: inspectorTab, setTab: setInspectorTab, channel: effectChannel, setChannel: setEffectChannel }}
        onRegionEffects={effects => { if (region) commit({ ...historyRef.current.current, regions: historyRef.current.current.regions.map(r => r.id === region.id ? withRegionEffects(r, effects) : r) }) }}
        resourceEpoch={resourceEpoch} onEffectAudition={auditionEffects} effectsOnline={mode === 'stream' && !!onlineMeta}
        onArea={commitArea} onY={y => { if (region && selection?.kind === 'region') commit(setAreaY(historyRef.current.current, region.id, selection.area, y)) }}
        onLandmarkParam={commitLandmarkParam}
        onRegionCustom={custom => { if (region) commit(setRegionCustom(historyRef.current.current, region.id, custom)) }}
        onLandmarkCustom={custom => { if (landmark) commit(setLandmarkCustom(historyRef.current.current, landmark.id, custom)) }}
        onRenameRegion={raw => rename('region', raw)} onRenameLandmark={raw => rename('landmark', raw)}
        onDeleteVolume={() => remove('volume')} onDeleteRegion={() => remove('region')} onDeleteLandmark={() => remove('landmark')} />
    </aside>}
    <footer className="level-editor-status"><span className="level-status-selection" title={selectionText}>{selectionText}</span><span className="level-status-hint">{hint}</span></footer>
  </div>
}
