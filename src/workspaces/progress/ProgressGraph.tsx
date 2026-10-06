import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { canConnectNodes, displayText, getCanvasNote, getEndNode, NOTE_COLORS, getGoalNode, getPredicateNode, getTransitionNode, getConditionalNode, getDiffNode, getMergeNode, getSwapNode, GOAL_NAMES, PREDICATE_NAMES, inputPorts, isOutputPort, linkSourcePort, outputPorts, parseSwapInIndex, parseSwapOutIndex, portKind, type CanvasNodeType, type FlowCanvasNote, type FlowInputPort, type FlowOutputPort, type FlowPort, type FlowPortKind, type FlowPosition, type ProgressFlow, type FlowSelection } from './model'
import { layoutCanvas, nodeMetrics, socketOffset, ENTRY_HEIGHT, NODE_HEIGHT, NODE_WIDTH, SWAP_ENTRY_ROW, SWAP_HEADER } from './canvas'
import { MAX_CANVAS_ZOOM, MIN_CANVAS_ZOOM, worldPoint, zoomCamera, type CanvasCamera } from './camera'
import { CKPT_STATES, GOAL_STATES, PREDICATE_STATES, SIGNAL_LABELS, ckptState, createSimState, fireGoalComplete, fireGoalNo, fireGoalYes, firePredicateComplete, fireStart, goalState, predicateState, resetSimState, syncSimState, transitionSim, type FlowSimState } from './signals'
import { NodeContextMenu } from './NodeContextMenu'
import { CanvasNote, type NoteDraft } from './CanvasNote'
import knifeIcon from './knife.svg'
import './ProgressGraph.css'

type MenuContext = { flow: ProgressFlow; id: string | null; groupId?: string; link?: GraphLink; x: number; y: number; position: FlowPosition; origin: HTMLElement | SVGElement }
type Drag = { flow: ProgressFlow; id: string; groupId?: string; pointer: number; client: FlowPosition; starts: Record<string, FlowPosition>; positions: Record<string, FlowPosition>; moved: boolean }
type Box = { flow: ProgressFlow; pointer: number; start: FlowPosition; point: FlowPosition; client: FlowPosition; moved: boolean; base: string[]; baseLinks: FlowSelection[] }
type Knife = { flow: ProgressFlow; pointer: number; points: FlowPosition[]; cuts: number[]; paths: { index: number; points: FlowPosition[] }[] }
type Pan = { flowId: string; pointer: number; client: FlowPosition; camera: CanvasCamera; origin: Element; moved: boolean }
type GraphLink = { from: string; to: string; port: FlowInputPort; fromPort?: FlowOutputPort; selection: FlowSelection; entry: boolean }
type SocketEndpoint = { id: string; port: FlowPort }
type Wire = { flow: ProgressFlow; id: string; port: FlowPort; pointer: number | null; origin: HTMLButtonElement; point: FlowPosition; hover: SocketEndpoint | null }
type MultiState = { flowId: string; ids: string[]; links: FlowSelection[] }

function wireControls(from: FlowPosition, to: FlowPosition, loop = false) {
  const sx = from.x, sy = from.y, tx = to.x, ty = to.y
  if (loop) return { sx, sy, c1x: sx + 95, c1y: sy + 140, c2x: tx - 95, c2y: ty + 140, tx, ty }
  const bend = Math.min(160, Math.abs(tx - sx) * .45)
  return { sx, sy, c1x: sx + bend, c1y: sy, c2x: tx - bend, c2y: ty, tx, ty }
}
function wirePath(from: FlowPosition, to: FlowPosition, loop = false) {
  const c = wireControls(from, to, loop)
  return `M ${c.sx} ${c.sy} C ${c.c1x} ${c.c1y}, ${c.c2x} ${c.c2y}, ${c.tx} ${c.ty}`
}
function sampleWire(from: FlowPosition, to: FlowPosition, loop = false, steps = 16) {
  const c = wireControls(from, to, loop), points: FlowPosition[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, u = 1 - t
    points.push({
      x: u * u * u * c.sx + 3 * u * u * t * c.c1x + 3 * u * t * t * c.c2x + t * t * t * c.tx,
      y: u * u * u * c.sy + 3 * u * u * t * c.c1y + 3 * u * t * t * c.c2y + t * t * t * c.ty,
    })
  }
  return points
}
function pointInRect(p: FlowPosition, left: number, right: number, top: number, bottom: number) {
  return p.x >= left && p.x <= right && p.y >= top && p.y <= bottom
}
function sameLink(a: FlowSelection, b: FlowSelection) {
  if (a.kind !== b.kind) return false
  if (a.kind === 'entry-link') return true
  if (a.kind === 'logic-link' && b.kind === 'logic-link') return a.id === b.id
  return false
}
function isLinkSelection(selection: FlowSelection): selection is Extract<FlowSelection, { kind: 'entry-link' | 'logic-link' }> {
  return selection.kind === 'entry-link' || selection.kind === 'logic-link'
}
function dedupeLinks(links: FlowSelection[]) {
  const result: FlowSelection[] = []
  for (const link of links) if (isLinkSelection(link) && !result.some(item => sameLink(item, link))) result.push(link)
  return result
}

function segmentsCross(a: FlowPosition, b: FlowPosition, c: FlowPosition, d: FlowPosition) {
  if (Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.max(c.x, d.x) < Math.min(a.x, b.x) || Math.max(a.y, b.y) < Math.min(c.y, d.y) || Math.max(c.y, d.y) < Math.min(a.y, b.y)) return false
  const side = (p: FlowPosition, q: FlowPosition, r: FlowPosition) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  return side(a, b, c) * side(a, b, d) <= 0 && side(c, d, a) * side(c, d, b) <= 0
}

export function ProgressGraph({ flow, selection, onSelect, onEdit, onAddNext, onCreate, onMove, onGroup, onUngroup, onRenameGroup, onDelete, onDeleteMany, onArrange, onUpdateNote, onConnectEntry, onConnect, onDisconnect, onCut, active, disabled = false, resolveText }: {
  flow: ProgressFlow; selection: FlowSelection; onSelect: (selection: FlowSelection) => void; onEdit: (selection: FlowSelection) => void
  onAddNext: (parent: string) => void; onCreate: (position: FlowPosition, operator?: CanvasNodeType) => void; onMove: (positions: Record<string, FlowPosition>) => void
  onGroup: (ids: string[]) => string | null; onUngroup: (id: string) => void; onRenameGroup: (id: string, name: string) => void
  onUpdateNote: (id: string, patch: Partial<FlowCanvasNote>) => void
  onDeleteMany: (ids: string[], disconnect?: FlowSelection[]) => void; onArrange: (ids: string[]) => void
  onDelete: (id: string) => void; onConnectEntry: (id: string | null) => void
  onConnect: (from: string, to: string, port: FlowInputPort, fromPort?: FlowPort) => void; onDisconnect: (selection: FlowSelection) => void; onCut: (selections: FlowSelection[]) => void
  active: boolean; disabled?: boolean
  resolveText?: (key: string) => string | null
}) {
  const baseLayout = useMemo(() => layoutCanvas(flow), [flow])
  const links = useMemo(() => {
    const result: GraphLink[] = []
    for (const link of flow.logic?.links ?? []) result.push({ from: link.from, to: link.to, port: link.port, fromPort: link.fromPort, selection: { kind: 'logic-link', id: link.id }, entry: false })
    if (flow.entry.target !== null) result.unshift({ from: flow.entry.id, to: flow.entry.target, port: flow.entry.port ?? 'input', selection: { kind: 'entry-link' }, entry: true })
    return result
  }, [flow])
  const [camera, setCamera] = useState<CanvasCamera>({ x: 0, y: 0, zoom: 1 }), cameraRef = useRef(camera)
  const zoom = camera.zoom
  const [context, setContext] = useState<MenuContext | null>(null)
  const [panning, setPanning] = useState(false), pan = useRef<Pan | null>(null), suppressContextUntil = useRef(0)
  const [groupRename, setGroupRename] = useState<{ flowId: string; id: string; value: string } | null>(null)
  const [noteDraft, setNoteDraft] = useState<{ flowId: string; id: string; value: NoteDraft } | null>(null), noteEditDone = useRef(false)
  const [noteSize, setNoteSize] = useState<{ flow: ProgressFlow; id: string; width: number; height: number } | null>(null)
  const groupNameInput = useRef<HTMLInputElement>(null), groupRenameDone = useRef(false)
  const [preview, setPreview] = useState<{ flow: ProgressFlow; positions: Record<string, FlowPosition> } | null>(null)
  const [multi, setMulti] = useState<MultiState>({ flowId: flow.id, ids: [], links: [] })
  const [boxPreview, setBoxPreview] = useState<Box | null>(null), box = useRef<Box | null>(null)
  const [knifePreview, setKnifePreview] = useState<Knife | null>(null), knife = useRef<Knife | null>(null)
  const blankClick = useRef<{ at: number; x: number; y: number } | null>(null)
  const [wirePreview, setWirePreview] = useState<Wire | null>(null), wire = useRef<Wire | null>(null)
  const drag = useRef<Drag | null>(null), suppressedClick = useRef<string | null>(null)
  const viewport = useRef<HTMLDivElement>(null), canvas = useRef<HTMLDivElement>(null)
  const nodeElements = useRef(new Map<string, HTMLButtonElement>())
  const lastSelection = useRef(''), displayedFlow = useRef<string | null>(null)
  const [sim, setSim] = useState<FlowSimState>(() => createSimState(flow))
  const lastAccepted = sim.log.length ? [...sim.log].reverse().find(item => item.accepted) : undefined
  const layout = useMemo(() => {
    if (!preview || preview.flow.id !== flow.id) return baseLayout
    const positions = new Map(baseLayout.positions), moved = Object.entries(preview.positions)
    for (const [id, position] of moved) positions.set(id, position)
    return { ...baseLayout, positions, width: Math.max(baseLayout.width, ...moved.map(([, p]) => p.x + NODE_WIDTH + 160)), height: Math.max(baseLayout.height, ...moved.map(([, p]) => p.y + NODE_HEIGHT + 160)) }
  }, [baseLayout, flow, preview])
  const sameFlow = (other: ProgressFlow | null | undefined) => Boolean(other && other.id === flow.id)
  const missingEdges = links.filter(link => !layout.positions.has(link.from) || !layout.positions.has(link.to))
  const menuContext = active && !disabled && sameFlow(context?.flow) ? context : null
  const menuId = menuContext?.id ?? null, menuNode = menuId !== null ? flow.nodes[menuId] : undefined
  const menuNote = menuId !== null ? getCanvasNote(flow, menuId) : undefined
  const menuTransition = menuId !== null ? getTransitionNode(flow, menuId) : undefined
  const menuConditional = menuId !== null ? getConditionalNode(flow, menuId) : undefined
  const menuDiff = menuId !== null ? getDiffNode(flow, menuId) : undefined
  const menuMerge = menuId !== null ? getMergeNode(flow, menuId) : undefined
  const menuSwap = menuId !== null ? getSwapNode(flow, menuId) : undefined
  const menuGoal = menuId !== null ? getGoalNode(flow, menuId) : undefined
  const menuPredicate = menuId !== null ? getPredicateNode(flow, menuId) : undefined
  const menuEnd = menuId !== null ? getEndNode(flow, menuId) : undefined
  const menuGroup = menuContext?.groupId
  const menuEntry = menuId === flow.entry.id
  const connecting = active && !disabled && sameFlow(wirePreview?.flow) ? wirePreview : null
  const menuLink = menuContext?.link
  const selectedIds = selection.kind === 'flow' ? (multi.flowId === flow.id ? multi.ids.filter(id => layout.positions.has(id)) : []) : selection.kind === 'entry' ? [flow.entry.id] : selection.kind === 'node' || selection.kind === 'goal' || selection.kind === 'predicate' || selection.kind === 'note' || selection.kind === 'transition' || selection.kind === 'conditional' || selection.kind === 'diff' || selection.kind === 'merge' || selection.kind === 'swap' || selection.kind === 'end' ? [selection.id] : []
  const selectedLinks = selection.kind === 'flow' ? (multi.flowId === flow.id ? multi.links.filter(link => links.some(item => sameLink(item.selection, link))) : []) : isLinkSelection(selection) ? [selection] : []
  const selectionCount = selectedIds.length + selectedLinks.length
  const menuMulti = !!menuContext && ((selectedIds.length > 1 && !menuLink) || (selectedLinks.length > 1 && (!menuLink || selectedLinks.some(link => menuLink && sameLink(link, menuLink.selection)))) || (selectedIds.length > 0 && selectedLinks.length > 0 && !menuId && !menuGroup))
  const removableIds = selectedIds.filter(id => id !== flow.entry.id)
  const groups = Object.entries(flow.layout?.groups ?? {}).map(([id, group], index) => ({ id, name: group.name?.trim() || `Group ${index + 1}`, nodes: group.nodes.filter(node => layout.positions.has(node)) })).filter(group => group.nodes.length >= 2)
  const editingGroup = active && !disabled && groupRename?.flowId === flow.id && groups.some(group => group.id === groupRename.id) ? groupRename : null
  const selectedGroup = groups.find(group => group.nodes.length === selectedIds.length && selectedIds.length > 0 && group.nodes.every(id => selectedIds.includes(id)) && !selectedLinks.length)
  const selectedNode = (id: string) => selectedIds.includes(id)
  const nodeSelection = (id: string): FlowSelection => id === flow.entry.id ? { kind: 'entry' } : getEndNode(flow, id) ? { kind: 'end', id } : { kind: getCanvasNote(flow, id) ? 'note' : getTransitionNode(flow, id) ? 'transition' : getConditionalNode(flow, id) ? 'conditional' : getDiffNode(flow, id) ? 'diff' : getMergeNode(flow, id) ? 'merge' : getSwapNode(flow, id) ? 'swap' : getGoalNode(flow, id) ? 'goal' : getPredicateNode(flow, id) ? 'predicate' : 'node', id }
  const goalLinksDiff = (id: string) => (flow.logic?.links ?? []).some(link => link.from === id && !!getDiffNode(flow, link.to))

  const editingNote = active && !disabled && noteDraft?.flowId === flow.id && getCanvasNote(flow, noteDraft.id) ? noteDraft : null
  const metricsFor = (id: string) => noteSize && sameFlow(noteSize.flow) && noteSize.id === id ? { ...nodeMetrics(flow, id), width: noteSize.width, height: noteSize.height } : nodeMetrics(flow, id)
  const linkSelected = (link: GraphLink) => selectedLinks.some(item => sameLink(item, link.selection))
  const socketPosition = (id: string, port: FlowPort): FlowPosition => { const p = layout.positions.get(id)!, offset = socketOffset(flow, id, port); return { x: p.x + offset.x, y: p.y + offset.y } }
  const wireFixed = connecting ? socketPosition(connecting.id, connecting.port) : null
  const wireFree = connecting ? (connecting.hover ? socketPosition(connecting.hover.id, connecting.hover.port) : connecting.point) : null
  const previewPath = connecting && wireFixed && wireFree ? wirePath(isOutputPort(connecting.port) ? wireFixed : wireFree, isOutputPort(connecting.port) ? wireFree : wireFixed, connecting.hover?.id === connecting.id) : ''
  const selectingBox = active && !disabled && sameFlow(boxPreview?.flow) ? boxPreview : null
  const cutting = active && !disabled && sameFlow(knifePreview?.flow) ? knifePreview : null
  const boxRect = selectingBox ? { x: Math.min(selectingBox.start.x, selectingBox.point.x), y: Math.min(selectingBox.start.y, selectingBox.point.y), width: Math.abs(selectingBox.start.x - selectingBox.point.x), height: Math.abs(selectingBox.start.y - selectingBox.point.y) } : null

  useEffect(() => {
    const cancel = () => { wire.current = null; setWirePreview(null); knife.current = null; setKnifePreview(null); blankClick.current = null; pan.current = null; setPanning(false) }
    window.addEventListener('blur', cancel)
    return () => window.removeEventListener('blur', cancel)
  }, [])

  useLayoutEffect(() => {
    if (editingGroup?.id) { groupNameInput.current?.focus({ preventScroll: true }); groupNameInput.current?.select() }
  }, [editingGroup?.id])

  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      if (!active || disabled || pan.current || drag.current || box.current || knife.current || wire.current) return
      const rect = element.getBoundingClientRect(), unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1
      const delta = Math.max(-160, Math.min(160, (event.deltaY || event.deltaX) * unit))
      const next = zoomCamera(cameraRef.current, cameraRef.current.zoom * Math.exp(-delta * .002), { x: event.clientX - rect.left, y: event.clientY - rect.top })
      cameraRef.current = next; setCamera(next); blankClick.current = null; setContext(null)
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [active, disabled])

  useLayoutEffect(() => {
    if (displayedFlow.current !== flow.id) {
      displayedFlow.current = flow.id
      const entry = layout.positions.get(flow.entry.id)!
      const next = { x: 64 - entry.x, y: 64 - entry.y, zoom: 1 }
      cameraRef.current = next; setCamera(next)
      setSim(createSimState(flow))
    } else {
      setSim(previous => syncSimState(previous, flow))
    }
  }, [flow, layout])
  useLayoutEffect(() => {
    if (!active || disabled || menuContext) return
    const key = selection.kind === 'entry' ? flow.entry.id : selection.kind === 'node' || selection.kind === 'goal' || selection.kind === 'predicate' || selection.kind === 'note' || selection.kind === 'transition' || selection.kind === 'conditional' || selection.kind === 'diff' || selection.kind === 'merge' || selection.kind === 'swap' || selection.kind === 'end' ? selection.id : ''
    if (key === lastSelection.current) return
    lastSelection.current = key
    const element = nodeElements.current.get(key)
    if (element) {
      element.focus({ preventScroll: true })
      const current = cameraRef.current, p = layout.positions.get(key)!, metrics = nodeMetrics(flow, key), view = viewport.current!
      const left = p.x * current.zoom + current.x, top = p.y * current.zoom + current.y, right = left + metrics.width * current.zoom, bottom = top + metrics.height * current.zoom
      const dx = left < 24 ? 24 - left : right > view.clientWidth - 24 ? view.clientWidth - 24 - right : 0
      const dy = top < 24 ? 24 - top : bottom > view.clientHeight - 24 ? view.clientHeight - 24 - bottom : 0
      if (dx || dy) { const next = { ...current, x: current.x + dx, y: current.y + dy }; cameraRef.current = next; setCamera(next) }
    }
  }, [active, disabled, flow, selection, menuContext, layout])

  function canvasPoint(x: number, y: number): FlowPosition {
    const rect = viewport.current!.getBoundingClientRect()
    return worldPoint(cameraRef.current, { x: x - rect.left, y: y - rect.top })
  }
  function centerPoint(): FlowPosition {
    const rect = viewport.current!.getBoundingClientRect(), p = canvasPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return { x: p.x - NODE_WIDTH / 2, y: p.y - NODE_HEIGHT / 2 }
  }
  function zoomView(nextZoom: number) {
    const element = viewport.current!, next = zoomCamera(cameraRef.current, nextZoom, { x: element.clientWidth / 2, y: element.clientHeight / 2 })
    cameraRef.current = next; setCamera(next); blankClick.current = null
  }
  function panDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 2 || disabled || !active || drag.current || box.current || knife.current || (event.target as Element).closest?.('input, textarea')) return
    const target = event.target instanceof Element ? event.target : (event.target as Node).parentElement
    if (!target || !viewport.current?.contains(target)) return
    event.preventDefault(); event.stopPropagation(); cancelWire(); closeMenu(false); blankClick.current = null
    pan.current = { flowId: flow.id, pointer: event.pointerId, client: { x: event.clientX, y: event.clientY }, camera: { ...cameraRef.current }, origin: target, moved: false }
    suppressContextUntil.current = event.timeStamp + 700
    event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId)
  }
  function panMove(event: ReactPointerEvent<HTMLDivElement>) {
    const current = pan.current
    if (!current || current.pointer !== event.pointerId || current.flowId !== flow.id || disabled || !active) return
    event.preventDefault(); event.stopPropagation()
    const dx = event.clientX - current.client.x, dy = event.clientY - current.client.y
    if (!current.moved && Math.hypot(dx, dy) < 4) return
    current.moved = true; setPanning(true)
    const next = { ...current.camera, x: current.camera.x + dx, y: current.camera.y + dy }
    cameraRef.current = next; setCamera(next)
  }
  function panUp(event: ReactPointerEvent<HTMLDivElement>, cancel = false) {
    const current = pan.current
    if (!current || current.pointer !== event.pointerId) return
    if (!cancel) panMove(event)
    event.preventDefault(); event.stopPropagation(); pan.current = null; setPanning(false)
    suppressContextUntil.current = event.timeStamp + 700
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (cancel || current.moved || current.flowId !== flow.id || disabled || !active) return
    const origin = current.origin instanceof Element ? current.origin : null
    const node = origin?.closest<HTMLElement>('[data-canvas-node]'), group = origin?.closest<HTMLButtonElement>('[data-canvas-group]'), link = origin?.closest<SVGPathElement>('.flow-graph-link-hit')
    if (node) {
      const id = node.dataset.canvasNode!, body = nodeElements.current.get(id) ?? node.querySelector<HTMLButtonElement>('button.flow-graph-node-body')
      if (body) openNodeMenu(id, body, event.clientX, event.clientY)
    } else if (group) {
      const item = groups.find(item => item.id === group.dataset.canvasGroup)
      if (!item) return
      selectMany(item.nodes); setContext({ flow, id: null, groupId: item.id, x: event.clientX, y: event.clientY, position: canvasPoint(event.clientX, event.clientY), origin: group })
    } else if (link) openLinkMenu(links[Number(link.dataset.linkIndex)], link, event.clientX, event.clientY)
    else setContext({ flow, id: null, x: event.clientX, y: event.clientY, position: canvasPoint(event.clientX, event.clientY), origin: event.currentTarget })
  }
  function openNodeMenu(id: string, origin: HTMLButtonElement, x: number, y: number) {
    if (disabled || !active) return
    if (!selectedIds.includes(id)) selectNode(id)
    setContext({ flow, id, origin, x, y, position: layout.positions.get(id)! })
  }
  function selectMany(ids: string[], nextLinks: FlowSelection[] = []) {
    lastSelection.current = ''
    setMulti({ flowId: flow.id, ids: [...new Set(ids)], links: dedupeLinks(nextLinks) }); onSelect({ kind: 'flow' })
  }
  function selectNode(id: string, additive = false) {
    const group = groups.find(group => group.nodes.includes(id)), ids = group?.nodes ?? [id]
    if (additive) {
      selectMany(ids.every(node => selectedIds.includes(node)) ? selectedIds.filter(node => !ids.includes(node)) : [...selectedIds, ...ids], selectedLinks)
    } else if (group) selectMany(ids)
    else { setMulti({ flowId: flow.id, ids: [], links: [] }); lastSelection.current = id; onSelect(nodeSelection(id)) }
  }
  function selectLink(link: GraphLink, additive = false) {
    if (additive) {
      const next = selectedLinks.some(item => sameLink(item, link.selection)) ? selectedLinks.filter(item => !sameLink(item, link.selection)) : [...selectedLinks, link.selection]
      selectMany(selectedIds, next)
    } else { setMulti({ flowId: flow.id, ids: [], links: [] }); onSelect(link.selection) }
  }
  function groupSelection() {
    if (disabled || !active || selectedIds.length < 2 || selectedGroup) return
    onGroup(selectedIds); selectMany(selectedIds); viewport.current?.focus({ preventScroll: true }); closeMenu(false)
  }
  function deleteSelection() {
    if (disabled || !active || (!removableIds.length && !selectedLinks.length)) return
    cancelWire(); closeMenu(false); blankClick.current = null
    if (removableIds.length) onDeleteMany(removableIds, selectedLinks)
    else onCut(selectedLinks)
    selectMany(selectedIds.filter(id => id === flow.entry.id))
    viewport.current?.focus({ preventScroll: true })
  }
  function disconnectSelectedLinks() {
    if (disabled || !active || !selectedLinks.length) return
    cancelWire(); closeMenu(false); blankClick.current = null
    onCut(selectedLinks); selectMany(selectedIds)
    viewport.current?.focus({ preventScroll: true })
  }
  function arrangeSelection() {
    if (disabled || !active || selectedIds.length < 2) return
    onArrange(selectedIds); closeMenu(false); blankClick.current = null
    viewport.current?.focus({ preventScroll: true })
  }
  function ungroupSelection(id: string) {
    onUngroup(id); viewport.current?.focus({ preventScroll: true }); closeMenu(false)
  }
  function beginGroupRename(id: string) {
    const group = groups.find(group => group.id === id)
    if (!group || disabled || !active) return
    cancelWire(); closeMenu(false); blankClick.current = null; selectMany(group.nodes)
    groupRenameDone.current = false; setGroupRename({ flowId: flow.id, id, value: group.name })
  }
  function finishGroupRename(save: boolean, restoreFocus = true) {
    if (!editingGroup || groupRenameDone.current) return
    groupRenameDone.current = true; setGroupRename(null)
    if (save && editingGroup.value.trim()) onRenameGroup(editingGroup.id, editingGroup.value)
    if (restoreFocus) viewport.current?.focus({ preventScroll: true })
  }
  function beginNoteEdit(id: string) {
    const note = getCanvasNote(flow, id)
    if (!note || disabled || !active) return
    cancelWire(); closeMenu(false); blankClick.current = null; selectNode(id)
    noteEditDone.current = false; setNoteDraft({ flowId: flow.id, id, value: { title: note.title, text: note.text } })
  }
  function finishNoteEdit(save: boolean, restoreFocus = true) {
    if (!editingNote || noteEditDone.current) return
    noteEditDone.current = true; setNoteDraft(null)
    if (save) onUpdateNote(editingNote.id, { ...editingNote.value, title: editingNote.value.title.trim() || '注释' })
    if (restoreFocus) viewport.current?.focus({ preventScroll: true })
  }
  function groupBounds(ids: string[]) {
    const nodes = ids.map(id => ({ ...layout.positions.get(id)!, ...metricsFor(id) }))
    const x = Math.min(...nodes.map(node => node.x)) - 16, y = Math.min(...nodes.map(node => node.y)) - 38
    return { x, y, width: Math.max(...nodes.map(node => node.x + node.width)) + 16 - x, height: Math.max(...nodes.map(node => node.y + node.height)) + 16 - y }
  }
  function closeMenu(restoreFocus = true) {
    if (restoreFocus && context?.origin?.isConnected) context.origin.focus({ preventScroll: true })
    setContext(null)
  }
  function validSocket(id: string, port: FlowPort, current: Wire) {
    if (isOutputPort(port) === isOutputPort(current.port)) return false
    const from = isOutputPort(port) ? id : current.id, to = !isOutputPort(port) ? id : current.id
    const fromPort = isOutputPort(port) ? port : current.port, toPort = !isOutputPort(port) ? port : current.port
    return canConnectNodes(flow, from, to, toPort as FlowInputPort, fromPort)
  }
  function hoveredSocket(x: number, y: number, current: Wire) {
    const element = document.elementFromPoint(x, y)?.closest<HTMLButtonElement>('button[data-flow-socket]')
    if (!element || !canvas.current?.contains(element)) return null
    const id = element.dataset.nodeId!, port = element.dataset.flowSocket as FlowPort
    return validSocket(id, port, current) ? { id, port } : null
  }
  function cancelWire() {
    const current = wire.current
    wire.current = null; setWirePreview(null)
    if (current?.pointer !== null && current?.pointer !== undefined && current.origin.hasPointerCapture(current.pointer)) current.origin.releasePointerCapture(current.pointer)
  }
  function finishWire(current: Wire, endpoint: SocketEndpoint) {
    if (!sameFlow(current.flow) || disabled || !active) return
    const fromOut = isOutputPort(current.port)
    onConnect(fromOut ? current.id : endpoint.id, fromOut ? endpoint.id : current.id, (fromOut ? endpoint.port : current.port) as FlowInputPort, fromOut ? current.port : endpoint.port)
    viewport.current?.focus({ preventScroll: true })
  }
  function socketDown(event: ReactPointerEvent<HTMLButtonElement>, id: string, port: FlowPort) {
    if (disabled || !active || event.button !== 0) return
    blankClick.current = null
    event.preventDefault(); event.stopPropagation(); cancelWire(); closeMenu(false)
    event.currentTarget.focus({ preventScroll: true })
    const current: Wire = { flow, id, port, pointer: event.pointerId, origin: event.currentTarget, point: socketPosition(id, port), hover: null }
    wire.current = current; setWirePreview(current)
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  function socketMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const current = wire.current
    if (!current || current.pointer !== event.pointerId || !sameFlow(current.flow) || disabled || !active) return
    event.stopPropagation()
    const next = { ...current, point: canvasPoint(event.clientX, event.clientY), hover: hoveredSocket(event.clientX, event.clientY, current) }
    wire.current = next; setWirePreview(next)
  }
  function socketUp(event: ReactPointerEvent<HTMLButtonElement>) {
    const current = wire.current
    if (!current || current.pointer !== event.pointerId) return
    event.preventDefault(); event.stopPropagation()
    const id = hoveredSocket(event.clientX, event.clientY, current)
    cancelWire()
    if (id !== null) finishWire(current, id)
  }
  function keyboardSocket(element: HTMLButtonElement, id: string, port: FlowPort) {
    if (disabled || !active) return
    const current = wire.current
    if (current?.flow && sameFlow(current.flow) && validSocket(id, port, current)) { cancelWire(); finishWire(current, { id, port }); return }
    cancelWire()
    const next: Wire = { flow, id, port, pointer: null, origin: element, point: socketPosition(id, port), hover: null }
    wire.current = next; setWirePreview(next)
  }
  function openLinkMenu(link: GraphLink, origin: HTMLElement | SVGElement, x: number, y: number) {
    if (disabled || !active) return
    cancelWire()
    if (selectedLinks.length > 1 && selectedLinks.some(item => sameLink(item, link.selection))) { /* keep multi */ }
    else selectLink(link)
    setContext({ flow, id: null, link, origin, x, y, position: layout.positions.get(link.from)! })
  }
  function socket(id: string, port: FlowPort, title: string, connected: boolean) {
    const compatible = connecting && validSocket(id, port, connecting), hovered = compatible && connecting.hover?.id === id && connecting.hover.port === port
    const kind = portKind(flow, id, port)
    const label = port === 'output2' ? '失败' : parseSwapOutIndex(port) !== null ? `S${parseSwapOutIndex(port)! + 1}` : port === 'output' ? (getDiffNode(flow, id) ? '成功' : getTransitionNode(flow, id) || getConditionalNode(flow, id) || getMergeNode(flow, id) ? 'Next' : getGoalNode(flow, id) ? 'G 出' : getPredicateNode(flow, id) ? 'P 出' : '输出') : parseSwapInIndex(port) !== null ? `A${parseSwapInIndex(port)! + 1}` : getTransitionNode(flow, id) || getDiffNode(flow, id) ? port === 'input2' ? 'Parent' : 'Goal' : getConditionalNode(flow, id) ? port === 'input2' ? 'Parent' : 'Predicate' : getMergeNode(flow, id) ? '汇入 A' : '输入'
    return <button type="button" className={`flow-graph-socket is-${isOutputPort(port) ? 'output' : 'input'} is-kind-${kind}${connected ? ' is-connected' : ''}${compatible ? ' is-compatible' : ''}${hovered ? ' is-target' : ''}`} style={{ top: socketOffset(flow, id, port).y - 11 }} data-flow-socket={port} data-node-id={id} disabled={disabled || !active} aria-label={`${title}，${label}端口`} title="拖动到另一节点的端口连线；也可依次聚焦两个端口按 Enter" onPointerDown={event => socketDown(event, id, port)} onPointerMove={socketMove} onPointerUp={socketUp} onPointerCancel={cancelWire} onLostPointerCapture={event => { if (wire.current?.pointer === event.pointerId) cancelWire() }} onClick={event => { event.stopPropagation(); if (event.detail === 0) keyboardSocket(event.currentTarget, id, port) }} onDoubleClick={event => event.stopPropagation()} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); cancelWire(); const origin = nodeElements.current.get(id); if (origin) openNodeMenu(id, origin, event.clientX, event.clientY) }} onFocus={() => {
      const current = wire.current
      if (current?.pointer !== null || !current || !sameFlow(current.flow)) return
      const next = { ...current, hover: validSocket(id, port, current) ? { id, port } : null }
      wire.current = next; setWirePreview(next)
    }}><span aria-hidden="true" /></button>
  }
  function linkKind(link: GraphLink): FlowPortKind {
    return portKind(flow, link.from, linkSourcePort(flow, link.from, link.to, link.port, link.fromPort))
  }
  function triggerStartSignal() {
    if (disabled || !active) return
    setSim(previous => fireStart(flow, syncSimState(previous, flow)))
  }
  function triggerGoalSignal(id: string, kind: 'goal-complete' | 'goal-yes' | 'goal-no' = 'goal-complete') {
    if (disabled || !active) return
    setSim(previous => {
      const synced = syncSimState(previous, flow)
      if (kind === 'goal-yes') return fireGoalYes(flow, synced, id)
      if (kind === 'goal-no') return fireGoalNo(flow, synced, id)
      return fireGoalComplete(flow, synced, id)
    })
  }
  function triggerPredicateSignal(id: string) {
    if (disabled || !active) return
    setSim(previous => firePredicateComplete(flow, syncSimState(previous, flow), id))
  }
  function resetSimulation() {
    if (disabled || !active) return
    setSim(resetSimState(flow))
  }
  function pointerDown(event: ReactPointerEvent<HTMLButtonElement>, id: string, forcedIds?: string[]) {
    if (disabled || !active || event.button !== 0) return
    blankClick.current = null
    event.stopPropagation()
    // Ctrl/Cmd+click on a signal source fires its signal in the shared editor/simulator view.
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && id === flow.entry.id) {
      triggerStartSignal(); suppressedClick.current = id; selectNode(id); return
    }
    if ((event.ctrlKey || event.metaKey) && getGoalNode(flow, id) && goalState(sim, id) === 'subscribed') {
      const kind = goalLinksDiff(id) ? (event.shiftKey ? 'goal-no' as const : 'goal-yes' as const) : 'goal-complete' as const
      if (kind === 'goal-complete' && event.shiftKey) { selectNode(id, true); suppressedClick.current = id; return }
      triggerGoalSignal(id, kind); suppressedClick.current = id; selectNode(id); return
    }
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && getPredicateNode(flow, id) && predicateState(sim, id) === 'subscribed') {
      triggerPredicateSignal(id); suppressedClick.current = id; selectNode(id); return
    }
    if (event.shiftKey || event.ctrlKey || event.metaKey) { selectNode(id, true); suppressedClick.current = id; return }
    suppressedClick.current = null
    const group = groups.find(group => group.nodes.includes(id))
    const ids = forcedIds ?? (selectedIds.includes(id) && selectedIds.length > 1 ? selectedIds : group?.nodes ?? [id])
    if (ids.length > 1) selectMany(ids); else selectNode(id)
    const starts = Object.fromEntries(ids.map(node => [node, layout.positions.get(node)!]))
    drag.current = { flow, id, groupId: group?.id, pointer: event.pointerId, client: { x: event.clientX, y: event.clientY }, starts, positions: starts, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  function pointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const current = drag.current
    if (!current || !sameFlow(current.flow) || current.pointer !== event.pointerId || disabled || !active) return
    const dx = event.clientX - current.client.x, dy = event.clientY - current.client.y
    if (!current.moved && Math.hypot(dx, dy) < 4) return
    current.moved = true
    const scale = cameraRef.current.zoom
    const deltaX = dx / scale, deltaY = dy / scale
    current.positions = Object.fromEntries(Object.entries(current.starts).map(([id, p]) => [id, { x: p.x + deltaX, y: p.y + deltaY }]))
    setPreview({ flow, positions: current.positions })
  }
  function pointerUp(event: ReactPointerEvent<HTMLButtonElement>, cancel = false) {
    const current = drag.current
    if (!current || current.pointer !== event.pointerId) return
    drag.current = null; setPreview(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (current.moved) {
      suppressedClick.current = current.id
      if (!cancel && sameFlow(current.flow) && active && !disabled && Object.keys(current.starts).some(id => current.positions[id].x !== current.starts[id].x || current.positions[id].y !== current.starts[id].y)) onMove(current.positions)
    }
  }
  function boxDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (disabled || !active || event.button !== 0 || (event.target as Element).closest('button, input, textarea, .flow-graph-node, .flow-graph-note, .flow-graph-link-hit')) { blankClick.current = null; return }
    event.preventDefault(); cancelWire(); closeMenu(false)
    const previous = blankClick.current
    blankClick.current = null
    if (!event.shiftKey && !event.ctrlKey && !event.metaKey && previous && event.timeStamp - previous.at <= 500 && Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= 6) {
      const paths = Array.from(canvas.current!.querySelectorAll<SVGPathElement>('.flow-graph-link-hit')).map(path => {
        const length = path.getTotalLength(), steps = Math.max(1, Math.ceil(length * zoom / 3))
        return { index: Number(path.dataset.linkIndex), points: Array.from({ length: steps + 1 }, (_, index) => { const p = path.getPointAtLength(length * index / steps); return { x: p.x, y: p.y } }) }
      })
      const next: Knife = { flow, pointer: event.pointerId, points: [canvasPoint(event.clientX, event.clientY)], cuts: [], paths }
      knife.current = next; setKnifePreview(next)
      event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId)
      return
    }
    const start = canvasPoint(event.clientX, event.clientY), base = event.shiftKey || event.ctrlKey || event.metaKey ? selectedIds : [], baseLinks = event.shiftKey || event.ctrlKey || event.metaKey ? selectedLinks : []
    const next: Box = { flow, pointer: event.pointerId, start, point: start, client: { x: event.clientX, y: event.clientY }, moved: false, base, baseLinks }
    box.current = next; setBoxPreview(next); selectMany(base, baseLinks)
    event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId)
  }
  function boxMove(event: ReactPointerEvent<HTMLDivElement>) {
    const current = box.current
    if (!current || current.pointer !== event.pointerId || !sameFlow(current.flow)) return
    const point = canvasPoint(event.clientX, event.clientY), next = { ...current, point, moved: current.moved || Math.hypot(event.clientX - current.client.x, event.clientY - current.client.y) >= 3 }
    box.current = next; setBoxPreview(next)
    const left = Math.min(current.start.x, point.x), right = Math.max(current.start.x, point.x), top = Math.min(current.start.y, point.y), bottom = Math.max(current.start.y, point.y)
    if (right - left < 3 && bottom - top < 3) return
    const hit = layout.ids.filter(id => { const p = layout.positions.get(id)!, metrics = metricsFor(id); return p.x <= right && p.x + metrics.width >= left && p.y <= bottom && p.y + metrics.height >= top })
    for (const group of groups) if (group.nodes.some(id => hit.includes(id))) hit.push(...group.nodes)
    const hitLinks = links.filter(link => {
      const from = layout.positions.get(link.from), to = layout.positions.get(link.to)
      if (!from || !to) return false
      const start = socketPosition(link.from, linkSourcePort(flow, link.from, link.to, link.port, link.fromPort)), end = socketPosition(link.to, link.port)
      if (pointInRect(start, left, right, top, bottom) || pointInRect(end, left, right, top, bottom)) return true
      return sampleWire(start, end, link.from === link.to).some(sample => pointInRect(sample, left, right, top, bottom))
    }).map(link => link.selection)
    selectMany([...current.base, ...hit], [...current.baseLinks, ...hitLinks])
  }
  function boxUp(event: ReactPointerEvent<HTMLDivElement>, cancel = false) {
    const current = box.current
    if (!current || current.pointer !== event.pointerId) return
    box.current = null; setBoxPreview(null)
    if (cancel) selectMany(current.base, current.baseLinks)
    blankClick.current = !cancel && !current.moved && !event.shiftKey && !event.ctrlKey && !event.metaKey ? { at: event.timeStamp, x: event.clientX, y: event.clientY } : null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  function knifeMove(event: ReactPointerEvent<HTMLDivElement>) {
    const current = knife.current
    if (!current || current.pointer !== event.pointerId || !sameFlow(current.flow) || disabled || !active) return
    const events = event.nativeEvent.getCoalescedEvents?.() ?? [], points = [...current.points], cuts = new Set(current.cuts)
    for (const sample of events.length ? events : [event]) {
      const point = canvasPoint(sample.clientX, sample.clientY), last = points[points.length - 1]
      if (Math.hypot(point.x - last.x, point.y - last.y) * zoom < 1) continue
      for (const path of current.paths) {
        if (cuts.has(path.index)) continue
        if (path.points.some((p, index) => index > 0 && segmentsCross(last, point, path.points[index - 1], p))) cuts.add(path.index)
      }
      points.push(point)
    }
    const next = { ...current, points, cuts: [...cuts] }
    knife.current = next; setKnifePreview(next)
  }
  function knifeUp(event: ReactPointerEvent<HTMLDivElement>, cancel = false) {
    if (!knife.current || knife.current.pointer !== event.pointerId) return
    if (!cancel) knifeMove(event)
    const current = knife.current!
    knife.current = null; setKnifePreview(null); blankClick.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (!cancel && sameFlow(current.flow) && active && !disabled && current.cuts.length) onCut(current.cuts.map(index => links[index].selection))
  }
  function locateEntry() {
    const element = viewport.current!, entry = layout.positions.get(flow.entry.id)!, metrics = nodeMetrics(flow, flow.entry.id)
    const next = { x: element.clientWidth / 2 - entry.x - metrics.width / 2, y: element.clientHeight / 2 - entry.y - ENTRY_HEIGHT / 2, zoom: 1 }
    cameraRef.current = next; setCamera(next); blankClick.current = null
  }
  function frameAll() {
    const element = viewport.current!
    const values = [...layout.positions].map(([id, p]) => ({ ...p, ...metricsFor(id) }))
    const minX = Math.min(...values.map(p => p.x)), minY = Math.min(...values.map(p => p.y))
    const maxX = Math.max(...values.map(p => p.x + p.width)), maxY = Math.max(...values.map(p => p.y + p.height))
    const nextZoom = Math.max(MIN_CANVAS_ZOOM, Math.min(1, element.clientWidth / (maxX - minX + 128), element.clientHeight / (maxY - minY + 128)))
    const next = { x: element.clientWidth / 2 - (minX + maxX) / 2 * nextZoom, y: element.clientHeight / 2 - (minY + maxY) / 2 * nextZoom, zoom: nextZoom }
    cameraRef.current = next; setCamera(next); blankClick.current = null
  }

  return <div className={`flow-graph${connecting ? ' is-connecting' : ''}${cutting ? ' is-cutting' : ''}${active && !disabled && panning ? ' is-panning' : ''}`}>
    <div className="flow-graph-toolbar">
      <span className="flow-graph-editor-icon" aria-hidden="true">◇</span><span className="flow-graph-editor-name">进度节点</span>
      <button type="button" className="flow-graph-add" disabled={disabled || !active} aria-haspopup="menu" aria-expanded={!!menuContext?.origin?.classList.contains('flow-graph-add')} onClick={event => {
        cancelWire()
        const rect = event.currentTarget.getBoundingClientRect()
        setContext({ flow, id: null, x: rect.left, y: rect.bottom + 4, position: centerPoint(), origin: event.currentTarget })
      }}>＋ 节点</button>
      {selectedIds.length > 1 && <button type="button" disabled={disabled || !!selectedGroup} onClick={groupSelection} title="Ctrl+G">Group · {selectedIds.length}</button>}
      {selectedGroup && <button type="button" disabled={disabled} onClick={() => ungroupSelection(selectedGroup.id)} title="Ctrl+Shift+G">解除 Group</button>}
      <span className="flow-graph-count">{layout.ids.length - Object.keys(flow.layout?.notes ?? {}).length} 节点{Object.keys(flow.layout?.notes ?? {}).length > 0 && ` · ${Object.keys(flow.layout!.notes!).length} 注释`} · {links.length} 连接</span>
      <div className="flow-graph-sim" aria-label="信号模拟">
        <button type="button" disabled={disabled || !active} title="系统事件：开始节点发出 S(未激活 → 已激活)" onClick={triggerStartSignal}>触发开始</button>
        <button type="button" disabled={disabled || !active} title="将所有 checkpoint 重置为未激活" onClick={resetSimulation}>重置模拟</button>
        <span className="flow-graph-sim-log" role="status">{sim.pulse === 0 ? '模拟待命 · Ctrl+点击信号源发信号' : lastAccepted ? `脉冲 #${sim.pulse} · ${lastAccepted.to} ← ${SIGNAL_LABELS[lastAccepted.signal.kind]}${lastAccepted.signal.kind === 'ckpt-transition' ? `(${CKPT_STATES[lastAccepted.signal.from]}→${CKPT_STATES[lastAccepted.signal.to]})` : ''}` : `脉冲 #${sim.pulse} · ${sim.log.at(-1)?.reason ?? '无接受'}`}</span>
      </div>
      <div className="flow-graph-zoom" aria-label="节点画布缩放">
        <button type="button" aria-label="缩小画布" disabled={zoom <= MIN_CANVAS_ZOOM || disabled} onClick={() => zoomView(zoom - .1)}>−</button>
        <output aria-label="当前缩放">{Math.round(zoom * 100)}%</output>
        <button type="button" aria-label="放大画布" disabled={zoom >= MAX_CANVAS_ZOOM || disabled} onClick={() => zoomView(zoom + .1)}>+</button>
        <button type="button" disabled={disabled} onClick={frameAll}>显示全部</button>
        <button type="button" disabled={disabled} onClick={locateEntry}>定位开始</button>
      </div>
    </div>
    <div className="flow-graph-viewport" ref={viewport} tabIndex={0} aria-label="节点画布，可拖拽框选或右键创建节点" style={{ backgroundPosition: `${camera.x}px ${camera.y}px`, backgroundSize: `${20 * zoom}px ${20 * zoom}px` }} onPointerDownCapture={panDown} onPointerMoveCapture={event => { if (pan.current) panMove(event) }} onPointerUpCapture={event => { if (pan.current) panUp(event) }} onContextMenuCapture={event => {
      if (pan.current || event.timeStamp <= suppressContextUntil.current) { event.preventDefault(); event.stopPropagation() }
    }} onPointerDown={boxDown} onPointerMove={event => knife.current ? knifeMove(event) : boxMove(event)} onPointerUp={event => knife.current ? knifeUp(event) : boxUp(event)} onPointerCancel={event => pan.current ? panUp(event, true) : knife.current ? knifeUp(event, true) : boxUp(event, true)} onLostPointerCapture={event => pan.current ? panUp(event, true) : knife.current ? knifeUp(event, true) : boxUp(event, true)} onKeyDownCapture={event => {
      if ((event.target as Element).closest('input, textarea, [contenteditable="true"]')) return
      if (event.key === 'Escape' && pan.current) { event.preventDefault(); event.stopPropagation(); const current = pan.current; pan.current = null; setPanning(false); cameraRef.current = current.camera; setCamera(current.camera); suppressContextUntil.current = event.timeStamp + 700; if (event.currentTarget.hasPointerCapture(current.pointer)) event.currentTarget.releasePointerCapture(current.pointer); return }
      if (event.key === 'Escape' && knife.current) { event.preventDefault(); event.stopPropagation(); const pointer = knife.current.pointer; knife.current = null; setKnifePreview(null); blankClick.current = null; if (event.currentTarget.hasPointerCapture(pointer)) event.currentTarget.releasePointerCapture(pointer); return }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'g') { event.preventDefault(); event.stopPropagation(); if (!disabled && active) { if (event.shiftKey && selectedGroup) ungroupSelection(selectedGroup.id); else if (!event.shiftKey) groupSelection() } return }
      if (event.key === 'Escape' && box.current) { event.preventDefault(); event.stopPropagation(); selectMany(box.current.base, box.current.baseLinks); box.current = null; setBoxPreview(null); return }
      if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); drag.current = null; setPreview(null); return }
      if (event.key === 'Escape' && connecting) { event.preventDefault(); event.stopPropagation(); cancelWire(); return }
      if (disabled || !active || !['Delete', 'Backspace'].includes(event.key)) return
      if ((selectedIds.length || selectedLinks.length) && !(event.target as Element).closest('.flow-graph-link-hit')) { event.preventDefault(); event.stopPropagation(); deleteSelection(); return }
      if ((event.target as Element).closest('.flow-graph-node, .flow-graph-note')) return
      if (selectedLinks.length > 1) { event.preventDefault(); event.stopPropagation(); disconnectSelectedLinks(); return }
      const edge = (event.target as Element).closest<SVGPathElement>('.flow-graph-link-hit')
      const link = edge ? links[Number(edge.dataset.linkIndex)] : links.find(linkSelected)
      if (link) { event.preventDefault(); event.stopPropagation(); onDisconnect(link.selection); viewport.current?.focus({ preventScroll: true }) }
    }} onContextMenu={event => {
      if (disabled || !active || (event.target as Element).closest('button, input, textarea, svg')) return
      event.preventDefault()
      setContext({ flow, id: null, x: event.clientX, y: event.clientY, position: canvasPoint(event.clientX, event.clientY), origin: event.currentTarget })
    }} onKeyDown={event => {
      if (event.target !== event.currentTarget || disabled || !active) return
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault()
        const rect = event.currentTarget.getBoundingClientRect()
        setContext({ flow, id: null, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, position: centerPoint(), origin: event.currentTarget })
      }
    }}>
      <div className="flow-graph-size">
        <div ref={canvas} className="flow-graph-canvas" style={{ width: layout.width, height: layout.height, transform: `translate(${camera.x}px, ${camera.y}px) scale(${zoom})` }}>
          {groups.map(group => {
            const bounds = groupBounds(group.nodes), moving = Boolean(preview && sameFlow(preview.flow) && group.nodes.some(id => Object.hasOwn(preview.positions, id)))
            return <div key={group.id} className={`flow-graph-group${selectedGroup?.id === group.id ? ' is-selected' : ''}${moving ? ' is-moving' : ''}`} style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height }}>
              {editingGroup?.id === group.id ? <input ref={groupNameInput} className="flow-graph-group-name-input" style={{ width: Math.min(280, bounds.width - 24) }} aria-label="Group 名称" value={editingGroup.value} onChange={event => setGroupRename({ ...editingGroup, value: event.target.value })} onBlur={() => finishGroupRename(true, false)} onPointerDown={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()} onKeyDown={event => {
                event.stopPropagation()
                if (event.nativeEvent.isComposing) return
                if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); finishGroupRename(event.key === 'Enter') }
              }} /> : <button type="button" className="flow-graph-group-heading" style={{ maxWidth: bounds.width - 20 }} data-canvas-group={group.id} disabled={disabled || !active} aria-label={`${group.name}，${group.nodes.length} 个节点`} aria-pressed={selectedGroup?.id === group.id} title={`${group.name}\n拖动整个 Group · 双击或 F2 重命名`} onPointerDown={event => { selectMany(group.nodes); pointerDown(event, group.nodes[0], group.nodes) }} onPointerMove={pointerMove} onPointerUp={event => pointerUp(event)} onPointerCancel={event => pointerUp(event, true)} onLostPointerCapture={event => pointerUp(event, true)} onClick={event => { if (event.detail === 0) selectMany(group.nodes) }} onDoubleClick={() => beginGroupRename(group.id)} onKeyDown={event => {
                if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); event.stopPropagation(); beginGroupRename(group.id) }
                if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                  event.preventDefault(); event.stopPropagation(); selectMany(group.nodes)
                  const rect = event.currentTarget.getBoundingClientRect()
                  setContext({ flow, id: null, groupId: group.id, x: rect.left, y: rect.bottom, position: { x: bounds.x, y: bounds.y }, origin: event.currentTarget })
                }
              }} onContextMenu={event => {
                event.preventDefault(); event.stopPropagation(); selectMany(group.nodes)
                setContext({ flow, id: null, groupId: group.id, x: event.clientX, y: event.clientY, position: { x: bounds.x, y: bounds.y }, origin: event.currentTarget })
              }}><span className="flow-graph-group-name-label">{group.name}</span><span>{group.nodes.length} 节点</span></button>}
            </div>
          })}
          <svg className="flow-graph-lines" width={layout.width} height={layout.height}>
            {links.map((link, index) => {
              const from = layout.positions.get(link.from), to = layout.positions.get(link.to)
              if (!from || !to) return null
              const source = linkSourcePort(flow, link.from, link.to, link.port, link.fromPort)
              const path = wirePath(socketPosition(link.from, source), socketPosition(link.to, link.port), link.from === link.to)
              return <g key={index} className={`flow-graph-link is-kind-${linkKind(link)}${linkSelected(link) ? ' is-selected' : ''}${cutting?.cuts.includes(index) ? ' is-cut-target' : ''}`}>
                <path className="flow-graph-link-shadow" d={path} aria-hidden="true" /><path d={path} aria-hidden="true" />
                <path className="flow-graph-link-hit" data-link-index={index} d={path} role="button" tabIndex={disabled || !active ? -1 : 0} aria-disabled={disabled || !active} aria-pressed={linkSelected(link)} aria-label={link.entry ? '起点连接' : `连接 ${link.selection.kind === 'logic-link' ? link.selection.id : ''}，${link.from} 到 ${link.to}`} onClick={disabled || !active ? undefined : event => { selectLink(link, event.shiftKey || event.ctrlKey || event.metaKey); event.currentTarget.focus({ preventScroll: true }) }} onDoubleClick={disabled || !active || !link.entry ? undefined : () => onEdit(link.selection)} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); openLinkMenu(link, event.currentTarget, event.clientX, event.clientY) }} onKeyDown={event => {
                  if (disabled || !active) return
                  if (event.key === ' ' || event.key === 'Spacebar') { event.preventDefault(); selectLink(link, event.shiftKey || event.ctrlKey || event.metaKey) }
                  if ((event.key === 'Enter' || event.key === 'F2') && link.entry) { event.preventDefault(); onEdit(link.selection) }
                  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); openLinkMenu(link, event.currentTarget, rect.left + rect.width / 2, rect.top + rect.height / 2) }
                }} />
              </g>
            })}
          </svg>
          {layout.ids.map(id => {
            const note = getCanvasNote(flow, id)
            if (note) return <CanvasNote key={id} id={id} note={note} position={layout.positions.get(id)!} zoom={zoom} selected={selectedNode(id)} dragging={Boolean(preview && sameFlow(preview.flow) && Object.hasOwn(preview.positions, id))} disabled={disabled || !active}
              draft={editingNote?.id === id ? editingNote.value : null} bodyRef={element => { if (element) nodeElements.current.set(id, element); else nodeElements.current.delete(id) }}
              onEdit={() => beginNoteEdit(id)} onDraft={value => setNoteDraft({ flowId: flow.id, id, value })} onFinish={finishNoteEdit} onSelect={() => selectNode(id)} onDelete={() => onDelete(id)} onUpdate={patch => onUpdateNote(id, patch)} onSizePreview={size => setNoteSize(size ? { flow, id, ...size } : null)}
              onPointerDown={event => { cancelWire(); pointerDown(event, id) }} onPointerMove={pointerMove} onPointerUp={pointerUp} onContextMenu={(origin, x, y) => openNodeMenu(id, origin, x, y)} />
            const end = getEndNode(flow, id)
            if (end) {
              const position = layout.positions.get(id)!, metrics = nodeMetrics(flow, id), selected = selectedNode(id)
              const incomingCount = links.filter(link => link.to === id).length
              return <div key={id} data-canvas-node={id} className={`flow-graph-node is-end${selected ? ' is-selected' : ''}${Boolean(preview && sameFlow(preview.flow) && Object.hasOwn(preview.positions, id)) ? ' is-dragging' : ''}`} style={{ left: position.x, top: position.y, width: metrics.width, height: metrics.height }}>
                <button type="button" ref={element => { if (element) nodeElements.current.set(id, element); else nodeElements.current.delete(id) }} className="flow-graph-node-body" disabled={disabled} aria-pressed={selected} aria-haspopup="menu" aria-expanded={!menuLink && menuId === id} aria-label={`结束节点 ${id}`} title={`${id}\n流程终点 · 仅输入\n拖动调整位置 · Delete 删除`} onPointerDown={event => { cancelWire(); pointerDown(event, id) }} onPointerMove={pointerMove} onPointerUp={event => pointerUp(event)} onPointerCancel={event => pointerUp(event, true)} onLostPointerCapture={event => pointerUp(event, true)} onClick={event => {
                  if (suppressedClick.current === id) { suppressedClick.current = null; return }
                  if (event.detail === 0) selectNode(id)
                }} onContextMenu={event => {
                  event.preventDefault(); event.stopPropagation()
                  const rect = event.currentTarget.getBoundingClientRect()
                  openNodeMenu(id, event.currentTarget, event.clientX || rect.left + 20, event.clientY || rect.top + 20)
                }} onKeyDown={event => {
                  if (event.key === 'Escape' && drag.current) { event.preventDefault(); drag.current = null; setPreview(null); return }
                  if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); onDelete(id); return }
                  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
                  event.preventDefault(); event.stopPropagation()
                  const rect = event.currentTarget.getBoundingClientRect()
                  openNodeMenu(id, event.currentTarget, rect.left + 20, rect.top + 20)
                }}>
                  <span className="flow-graph-node-header"><span className="flow-graph-node-symbol" aria-hidden="true">■</span><span>结束</span></span>
                  <span className="flow-graph-node-title">流程终点</span>
                  <span className="flow-graph-ports"><span className="flow-graph-port-input">{incomingCount > 1 ? `S 入 × ${incomingCount}` : 'S 入'}</span></span>
                </button>
                {inputPorts(flow, id).map(port => <span key={port}>{socket(id, port, '结束', links.some(link => link.to === id && link.port === port))}</span>)}
              </div>
            }
            const isEntry = id === flow.entry.id, node = isEntry ? undefined : flow.nodes[id], goal = getGoalNode(flow, id), predicate = getPredicateNode(flow, id), transition = getTransitionNode(flow, id), conditional = getConditionalNode(flow, id), diff = getDiffNode(flow, id), merge = getMergeNode(flow, id), swap = getSwapNode(flow, id), position = layout.positions.get(id)!, metrics = nodeMetrics(flow, id)
            const selected = selectedNode(id)
            const canFormEdit = isEntry || !!node
            const runtime = node ? ckptState(sim, id) : null
            const goalRuntime = goal ? goalState(sim, id) : null
            const predicateRuntime = predicate ? predicateState(sim, id) : null
            const mergeAwait = merge ? (sim.merges[id]?.awaiting.length ?? 0) : 0
            const mergeReported = merge ? (sim.merges[id]?.reported.length ?? 0) : 0
            const transitionQuery = transition ? transitionSim(sim, id) : null
            const transitionAwait = transitionQuery?.awaiting.length ?? 0
            const transitionReported = transitionQuery?.reported.length ?? 0
            const goalIncoming = transition ? links.filter(link => link.to === id && link.port === 'input').length : 0
            const title = isEntry ? '开始' : displayText((swap ?? merge ?? diff ?? conditional ?? transition ?? predicate ?? goal ?? node)!.title, resolveText) || (swap ? '交换变迁' : merge ? '合并变迁' : diff ? '差分变迁' : conditional ? '条件变迁' : transition ? '线性变迁' : predicate ? '未命名谓词' : goal ? '未命名目标' : '未命名阶段')
            const outgoingCount = links.filter(link => link.from === id && linkSourcePort(flow, link.from, link.to, link.port, link.fromPort) === 'output').length
            const incomingCount = links.filter(link => link.to === id).length
            const bridgeOut = links.some(link => link.from === id && linkSourcePort(flow, link.from, link.to, link.port, link.fromPort) === 'output2')
            const description = node ? displayText(node.description, resolveText) : goal ? goal.kind === 'counter' ? `${GOAL_NAMES[goal.kind]} · ${goal.params.target ?? 1}` : GOAL_NAMES[goal.kind] : predicate ? predicate.kind === 'counter' ? `${PREDICATE_NAMES[predicate.kind]} · ${predicate.params.target ?? 1}` : PREDICATE_NAMES[predicate.kind] : ''
            const pulsed = lastAccepted && (lastAccepted.to === id || lastAccepted.from === id) && sim.pulse > 0
            const isSignalSource = isEntry || (goal && goalRuntime === 'subscribed') || (predicate && predicateRuntime === 'subscribed')
            const goalDiff = goal ? goalLinksDiff(id) : false
            const kindLabel = swap ? '交换变迁' : merge ? '合并变迁' : diff ? '差分变迁' : conditional ? '条件变迁' : transition ? '线性变迁' : predicate ? `Predicate · ${PREDICATE_STATES[predicateRuntime!]}${predicateRuntime === 'subscribed' ? '；Ctrl+点击发出 P' : ''}` : goal ? `Goal · ${GOAL_STATES[goalRuntime!]}${goalRuntime === 'subscribed' ? (goalDiff ? '；Ctrl+G-Y · Ctrl+Shift+G-N' : '；Ctrl+点击发出 G') : ''}` : `checkpoint · ${CKPT_STATES[runtime!]}`
            return <div key={id} data-canvas-node={id} data-ckpt-state={runtime ?? undefined} data-goal-state={goalRuntime ?? undefined} data-predicate-state={predicateRuntime ?? undefined} className={`flow-graph-node${isEntry ? ' is-entry' : ''}${isSignalSource ? ' is-signal-source' : ''}${goal ? ` is-goal is-goal-${goalRuntime}` : ''}${predicate ? ` is-predicate is-predicate-${predicateRuntime}` : ''}${transition ? ' is-transition' : ''}${conditional ? ' is-conditional' : ''}${diff ? ' is-diff' : ''}${merge ? ' is-merge' : ''}${swap ? ' is-swap' : ''}${node ? ` is-ckpt is-ckpt-${runtime}` : ''}${selected ? ' is-selected' : ''}${pulsed ? ' is-sim-pulse' : ''}${Boolean(preview && sameFlow(preview.flow) && Object.hasOwn(preview.positions, id)) ? ' is-dragging' : ''}`} style={{ left: position.x, top: position.y, width: metrics.width, height: metrics.height }}>
              <button type="button" ref={element => { if (element) nodeElements.current.set(id, element); else nodeElements.current.delete(id) }} className="flow-graph-node-body" disabled={disabled} aria-pressed={selected} aria-haspopup="menu" aria-expanded={!menuLink && menuId === id} aria-label={isEntry ? '开始节点（信号源），不可删除；Ctrl+点击发出 S(未激活 → 已激活)' : `${title}，${kindLabel} ${id}`} title={isEntry ? '开始节点 · 信号源\nCtrl+点击发出 S(未激活 → 已激活)\n可自由移动，不可删除' : goal ? `${id}\n状态：${GOAL_STATES[goalRuntime!]}\n${goalRuntime === 'subscribed' ? (goalDiff ? 'Ctrl+点击发出 G-Y\nCtrl+Shift+点击发出 G-N\n' : 'Ctrl+点击发出 G\n') : ''}拖动调整位置 · Delete 删除` : predicate ? `${id}\n状态：${PREDICATE_STATES[predicateRuntime!]}\n${predicateRuntime === 'subscribed' ? 'Ctrl+点击发出 P\n' : ''}拖动调整位置 · Delete 删除` : node ? `${id}\n${runtime ? `状态：${CKPT_STATES[runtime]}\n` : ''}拖动调整位置 · 双击编辑 · Delete 删除` : `${id}\n${merge ? `查询回报 ${mergeReported}/${mergeAwait || incomingCount}\n` : ''}${swap ? `条目 ${swap.entries}（末槽空闲自动扩容）\n` : ''}拖动调整位置 · Delete 删除`} onPointerDown={event => { cancelWire(); pointerDown(event, id) }} onPointerMove={pointerMove} onPointerUp={event => pointerUp(event)} onPointerCancel={event => pointerUp(event, true)} onLostPointerCapture={event => pointerUp(event, true)} onClick={event => {
              if (suppressedClick.current === id) { suppressedClick.current = null; return }
              if (event.detail === 0) selectNode(id)
            }} onDoubleClick={canFormEdit ? () => onEdit(nodeSelection(id)) : undefined} onContextMenu={event => {
              event.preventDefault(); event.stopPropagation()
              const rect = event.currentTarget.getBoundingClientRect()
              openNodeMenu(id, event.currentTarget, event.clientX || rect.left + 20, event.clientY || rect.top + 20)
            }} onKeyDown={event => {
              if (event.key === 'Escape' && drag.current) { event.preventDefault(); drag.current = null; setPreview(null); return }
              if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); if (!isEntry) onDelete(id); return }
              if (canFormEdit && (event.key === 'Enter' || event.key === 'F2')) { event.preventDefault(); event.stopPropagation(); onEdit(nodeSelection(id)); return }
              if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
              event.preventDefault(); event.stopPropagation()
              const rect = event.currentTarget.getBoundingClientRect()
              openNodeMenu(id, event.currentTarget, rect.left + 20, rect.top + 20)
            }}>
              <span className="flow-graph-node-header"><span className="flow-graph-node-symbol" aria-hidden="true">{isEntry ? '▸' : swap ? '⇄' : merge ? '⇉' : diff ? '⇅' : conditional ? '?' : transition ? '→' : predicate ? '⊢' : goal ? '◎' : '◇'}</span><span>{isEntry ? '开始' : swap ? '交换变迁' : merge ? '合并变迁' : diff ? '差分变迁' : conditional ? '条件变迁' : transition ? '线性变迁' : predicate ? 'Predicate' : goal ? 'Goal' : 'Checkpoint'}</span>{isEntry ? <svg className="flow-graph-lock" viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="7" width="8" height="7" rx="1.5" /><path d="M5 7V5a3 3 0 016 0v2" /></svg> : runtime ? <span className="flow-graph-header-tag">{CKPT_STATES[runtime]}</span> : goalRuntime ? <span className="flow-graph-header-tag">{GOAL_STATES[goalRuntime]}</span> : predicateRuntime ? <span className="flow-graph-header-tag">{PREDICATE_STATES[predicateRuntime]}</span> : swap ? <span className="flow-graph-header-tag">{swap.entries} 槽</span> : merge ? <span className="flow-graph-header-tag">{mergeAwait ? `C-R ${mergeReported}/${mergeAwait}` : '多→1'}</span> : diff ? <span className="flow-graph-header-tag">Y/N</span> : conditional ? <span className="flow-graph-header-tag">P·P→N</span> : transition ? <span className="flow-graph-header-tag">{transitionAwait ? `C-R ${transitionReported}/${transitionAwait}` : goalIncoming > 1 ? `G∧${goalIncoming}` : 'G·P→N'}</span> : null}</span>
              <span className="flow-graph-node-title">{isEntry ? '信号源 · S(未激活→已激活)' : goal && goalRuntime === 'subscribed' ? `${title} · ${goalDiff ? '可发 G-Y / G-N' : '可发 G'}` : predicate && predicateRuntime === 'subscribed' ? `${title} · 可发 P` : title}</span>
              <span className="flow-graph-ports">
                {swap ? Array.from({ length: swap.entries }, (_, i) => <span key={`swap-in-${i}`} className="flow-swap-entry-in" style={{ top: SWAP_HEADER + i * SWAP_ENTRY_ROW + 6 }}>A{i + 1}</span>) : transition || conditional || diff ? <><span className="flow-transition-input-one">{conditional ? 'Predicate' : transition && goalIncoming > 1 ? `Goal∧${goalIncoming}` : 'Goal'}</span><span className="flow-transition-input-two">Parent</span></> : !isEntry && !goal && !predicate && <span className="flow-graph-port-input">{merge ? (incomingCount > 1 ? `A 入 × ${incomingCount}` : 'A 入') : 'S 入'}</span>}
                {swap ? Array.from({ length: swap.entries }, (_, i) => <span key={`swap-out-${i}`} className="flow-swap-entry-out" style={{ top: SWAP_HEADER + i * SWAP_ENTRY_ROW + 6 }}>S{i + 1}</span>) : diff ? <><span className="flow-diff-output-one">成功 · S</span><span className="flow-diff-output-two">失败 · S</span></> : outputPorts(flow, id).length ? <span className="flow-graph-port-output">{isEntry ? 'S 出' : goal ? 'G 出' : predicate ? 'P 出' : merge || transition || conditional ? 'Next · S' : outgoingCount > 1 ? `激活 × ${outgoingCount}` : '激活出'}</span> : null}
              </span>
              {node && <span className={`flow-graph-node-description${description ? '' : ' is-empty'}`}>{description || '双击编辑'}</span>}
              {(goal || predicate) && description && <span className="flow-graph-node-description">{description}</span>}
              </button>
              {inputPorts(flow, id).map(port => <span key={port}>{socket(id, port, title, links.some(link => link.to === id && link.port === port))}</span>)}
              {outputPorts(flow, id).map(port => <span key={port}>{socket(id, port, title, port === 'output2' ? bridgeOut : links.some(link => link.from === id && linkSourcePort(flow, link.from, link.to, link.port, link.fromPort) === port))}</span>)}
            </div>
          })}
          {connecting && <svg className="flow-graph-lines flow-graph-wire-preview" width={layout.width} height={layout.height} aria-hidden="true"><path className={`is-kind-${portKind(flow, connecting.id, connecting.port)}${connecting.hover ? ' is-snapped' : ''}`} d={previewPath} /></svg>}
          {boxRect && <div className="flow-graph-selection-box" aria-hidden="true" style={{ left: boxRect.x, top: boxRect.y, width: boxRect.width, height: boxRect.height }} />}
          {cutting && <svg className="flow-graph-knife-preview" width={layout.width} height={layout.height} aria-hidden="true"><polyline points={cutting.points.map(p => `${p.x},${p.y}`).join(' ')} /><g transform={`translate(${cutting.points[cutting.points.length - 1].x} ${cutting.points[cutting.points.length - 1].y}) scale(${1 / zoom})`}><image href={knifeIcon} x="-2" y="-22" width="24" height="24" /></g></svg>}
        </div>
      </div>
    </div>
    {missingEdges.length > 0 && <div className="flow-graph-extra" aria-label="需要检查的连接"><span>端点不存在的连接</span>{missingEdges.map((link, index) => <button key={index} type="button" disabled={disabled} onClick={() => onEdit(link.selection)}>{link.from} → {link.to}</button>)}</div>}
    <div className="flow-graph-legend"><span><i className="is-entry" />开始 · 信号源</span><span><i className="is-checkpoint" />Checkpoint</span><span><i className="is-end" />结束</span><span><i className="is-goal" />Goal</span><span><i className="is-predicate" />Predicate</span><span><i className="is-transition" />线性变迁</span><span><i className="is-conditional" />条件变迁</span><span><i className="is-diff" />差分变迁</span><span><i className="is-merge" />合并变迁</span><span><i className="is-swap" />交换变迁</span><span role="status">{panning ? '右键拖动画布 · 松开结束' : cutting ? `小刀 · ${cutting.cuts.length} 条连线待切割 · 松开确认 · Esc 取消` : connecting ? connecting.pointer === null ? '聚焦另一高亮端口，按 Enter 完成 · Esc 取消' : '松开到高亮端口完成连线 · Esc 取消' : selectionCount > 1 ? `${selectedIds.length ? `${selectedIds.length} 节点` : ''}${selectedIds.length && selectedLinks.length ? ' · ' : ''}${selectedLinks.length ? `${selectedLinks.length} 连线` : ''}已选 · Delete 删除/断开` : 'Ctrl+点击信号源发信号 · 右键拖动平移 · 滚轮缩放'}</span></div>
    {menuContext && <NodeContextMenu className="is-graph-menu" x={menuContext.x} y={menuContext.y} title={menuMulti ? `已选择 ${selectionCount} 项` : menuGroup ? groups.find(group => group.id === menuGroup)?.name || 'Group' : menuLink ? `${menuLink.from} → ${menuLink.to}` : menuEntry ? '开始' : menuEnd ? '结束' : menuNode ? displayText(menuNode.title, resolveText) || menuId! : menuSwap ? displayText(menuSwap.title, resolveText) || '交换变迁' : menuMerge ? displayText(menuMerge.title, resolveText) || '合并变迁' : menuDiff ? displayText(menuDiff.title, resolveText) || '差分变迁' : menuConditional ? displayText(menuConditional.title, resolveText) || '条件变迁' : menuTransition ? displayText(menuTransition.title, resolveText) || '线性变迁' : menuPredicate ? displayText(menuPredicate.title, resolveText) || 'Predicate' : menuGoal ? displayText(menuGoal.title, resolveText) || 'Goal' : menuNote ? menuNote.title || '注释' : '节点画布'} label={menuMulti ? '多选操作' : menuLink ? '连接操作' : menuGroup ? 'Group 操作' : menuId === null ? '画布操作' : '节点操作'} onClose={closeMenu} items={menuMulti ? [
      ...(selectedIds.length > 1 ? [{ label: '智能排版', hint: '微调现有行列对齐和接近等距的间距，保留整体布局', action: arrangeSelection }] : []),
      ...(selectedIds.length > 1 ? (selectedGroup ? [{ label: '重命名 Group…', action: () => beginGroupRename(selectedGroup.id) }, { label: '解除 Group', action: () => ungroupSelection(selectedGroup.id) }] : [{ label: `Group · ${selectedIds.length} 项`, action: groupSelection, disabled: selectedIds.length < 2 }]) : []),
      ...(selectedLinks.length ? [{ label: `断开所选连接（${selectedLinks.length}）`, hint: '仅移除这些连接，节点原地保留', action: disconnectSelectedLinks }] : []),
      ...(removableIds.length ? [{ label: `删除所选（${removableIds.length} 项）`, hint: selectedIds.includes(flow.entry.id) ? '开始节点保留，其余所选项一起删除；可以一步撤销' : '一起删除所选项及相关连线；可以一步撤销', action: deleteSelection }] : []),
    ] : (menuLink ? [
      ...(selectedLinks.length > 1 ? [{ label: `断开所选连接（${selectedLinks.length}）`, hint: '仅移除这些连接，节点原地保留', action: disconnectSelectedLinks }] : [
        ...(menuLink.entry ? [{ label: '编辑开始节点…', action: () => onEdit({ kind: 'entry' }) }] : []),
        { label: '断开连接', hint: '仅移除这条连接，节点原地保留', action: () => onDisconnect(menuLink.selection) },
      ]),
    ] : menuGroup ? [{ label: '重命名 Group…', action: () => beginGroupRename(menuGroup) }, { label: '解除 Group', hint: '节点位置和连接保留', action: () => ungroupSelection(menuGroup) }] : menuEntry ? [
      { label: '触发开始信号', hint: '发出 S(未激活 → 已激活)；也可 Ctrl+点击', action: triggerStartSignal },
      { label: '新建并连接 checkpoint', disabled: flow.entry.target !== null, hint: '开始节点出口只出一条线，接到 checkpoint', action: () => onAddNext(flow.entry.id) },
      { label: '设置起始节点…', action: () => onEdit({ kind: 'entry' }) },
      { label: '断开出口连接', disabled: flow.entry.target === null, action: () => onConnectEntry(null) },
      { label: '删除开始节点（不可用）', disabled: true, hint: '开始节点始终保留，可自由移动', action: () => {} },

    ] : menuNote && menuId !== null ? [
      { label: '编辑注释…', action: () => beginNoteEdit(menuId) },
      ...Object.entries(NOTE_COLORS).map(([color, label]) => ({ label: `${menuNote.color === color ? '✓ ' : ''}${label}`, action: () => onUpdateNote(menuId, { color: color as FlowCanvasNote['color'] }) })),
      { label: '删除注释', action: () => onDelete(menuId) },
    ] : menuGoal && menuId !== null ? [
      ...(goalLinksDiff(menuId) ? [
        { label: '发出 G-Y 成功', disabled: goalState(sim, menuId) !== 'subscribed', hint: '也可 Ctrl+点击', action: () => triggerGoalSignal(menuId, 'goal-yes') },
        { label: '发出 G-N 失败', disabled: goalState(sim, menuId) !== 'subscribed', hint: '也可 Ctrl+Shift+点击', action: () => triggerGoalSignal(menuId, 'goal-no') },
      ] : [
        { label: '发出 G 信号', disabled: goalState(sim, menuId) !== 'subscribed', hint: '仅订阅中可发；也可 Ctrl+点击', action: () => triggerGoalSignal(menuId) },
      ]),
      { label: '删除节点', hint: '仅删除当前节点和相关连接，其他节点保留', action: () => onDelete(menuId) },
    ] : menuPredicate && menuId !== null ? [
      { label: '发出 P 信号', disabled: predicateState(sim, menuId) !== 'subscribed', hint: '仅订阅中可发；也可 Ctrl+点击', action: () => triggerPredicateSignal(menuId) },
      { label: '删除节点', hint: '仅删除当前节点和相关连接，其他节点保留', action: () => onDelete(menuId) },
    ] : (menuTransition || menuConditional || menuDiff || menuMerge || menuSwap) && menuId !== null ? [
      { label: '删除节点', hint: '仅删除当前节点和相关连接，其他节点保留', action: () => onDelete(menuId) },
    ] : menuEnd && menuId !== null ? [
      { label: '删除结束节点', hint: '仅删除当前结束节点和相关连接', action: () => onDelete(menuId) },
    ] : menuNode && menuId !== null ? [
      { label: '新建下一节点', hint: '经线性变迁连接，不可直连 checkpoint', action: () => onAddNext(menuId) },
      { label: '编辑阶段…', action: () => onEdit({ kind: 'node', id: menuId }) },
      { label: '连接到开始', disabled: flow.entry.target === menuId, action: () => onConnectEntry(menuId) },
      { label: '删除 checkpoint', hint: '仅删除当前 checkpoint 和相关连接，其他节点保留', action: () => onDelete(menuId) },
    ] : [
      { label: '添加注释', action: () => onCreate(menuContext.position, 'note') },
      { label: '新建 checkpoint', action: () => onCreate(menuContext.position) },
      { label: '新建线性变迁 · Goal 合取 / Parent → Next', action: () => onCreate(menuContext.position, 'transition') },
      { label: '新建条件变迁 · Predicate / Parent → Next', action: () => onCreate(menuContext.position, 'conditional') },
      { label: '新建差分变迁 · Goal G-Y/G-N · 成功/失败', action: () => onCreate(menuContext.position, 'diff') },
      { label: '新建合并变迁 · 多 A → 查询 C / Next S', action: () => onCreate(menuContext.position, 'merge') },
      { label: '新建交换变迁 · 条目 A→S，其余入点 S-C', action: () => onCreate(menuContext.position, 'swap') },
      { label: '新建 Goal · 目标（信号源）', action: () => onCreate(menuContext.position, 'goal') },
      { label: '新建 Predicate · 谓词（信号源）', action: () => onCreate(menuContext.position, 'predicate') },
      { label: '新建结束节点', action: () => onCreate(menuContext.position, 'end') },
    ])} />}
  </div>
}
