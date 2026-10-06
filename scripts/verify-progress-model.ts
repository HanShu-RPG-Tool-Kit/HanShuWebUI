import assert from 'node:assert/strict'
import { addNode, canConnectNodes, clone, connectEntry, connectNodes, createFlow, disconnectLink, findCanvasCycle, getCanvasNote, hasContentNode, inputPorts, linkSourcePort, makeNode, outgoingCount, outputPorts, parseFlow, portKind, removeNode, renameNode, swapInPort, swapOutPort, text, validateFlow, type ProgressFlow } from '../src/workspaces/progress/model.ts'
import { FLOW_STORAGE_KEY, createFlowDocument, importFlowDocument, loadFlowWorkspace, saveFlowWorkspace } from '../src/workspaces/progress/storage.ts'
import { addFlowFolder, moveFlowEntry, renameFlowEntry, uniqueDocumentName } from '../src/workspaces/progress/library.ts'
import { addNextCheckpoint, createCanvasNote, removeCanvasItems, updateCanvasNote, removeCanvasNote, groupCanvasNodes, moveCanvasNodes, nodeMetrics, createCheckpoint, createEndNode, createGoalNode, createPredicateNode, createTransitionNode, createConditionalNode, createDiffNode, createMergeNode, createSwapNode, layoutCanvas, moveCheckpoint, socketOffset, withCanvasPositions } from '../src/workspaces/progress/canvas.ts'
import { smartArrangeCanvas } from '../src/workspaces/progress/arrange.ts'
import { MAX_CANVAS_ZOOM, MIN_CANVAS_ZOOM, worldPoint, zoomCamera } from '../src/workspaces/progress/camera.ts'
import { CKPT_STATES, GOAL_STATES, PREDICATE_STATES, ckptState, createSimState, fireCkptTransition, fireGoalComplete, fireGoalNo, fireGoalYes, firePredicateComplete, fireStart, goalState, mergeSim, outgoingSignalTargets, predicateState, propagateSignals, resetSimState, syncSimState } from '../src/workspaces/progress/signals.ts'

let passed = 0
function test(name: string, check: () => void) { check(); passed++; console.log(`[OK] ${name}`) }
const errors = (f: ProgressFlow) => validateFlow(f).filter((i) => i.severity === 'error')
function fixture() {
  const flow = createFlow('story-progress', '驿站的约定')
  flow.nodes.start = makeNode('收到委托'); flow.entry.target = 'start'
  flow.nodes.node_1 = makeNode('阶段 1')
  flow.nodes.node_2 = makeNode('阶段 2')
  flow.nodes.node_3 = makeNode('阶段 3')
  return flow
}
function linkViaTransition(flow: ProgressFlow, fromCkpt: string, toCkpt: string) {
  const added = createTransitionNode(flow, { x: 0, y: 0 })
  let next = connectNodes(added.flow, fromCkpt, added.id, 'input2').flow
  next = connectNodes(next, added.id, toCkpt).flow
  return { flow: next, id: added.id }
}
test('A portable flow has lean checkpoints; routing uses transitions', () => {
  const flow = fixture()
  assert.equal(errors(flow).length, 0)
  for (const node of Object.values(flow.nodes)) {
    assert.deepEqual(Object.keys(node).sort(), ['description', 'title'])
  }
  assert.equal(flow.entry.title.text, '驿站的约定')
  const linked = linkViaTransition(flow, 'start', 'node_1')
  assert.equal(linked.flow.logic!.links.length, 2)
  assert.equal(errors(linked.flow).length, 0)
  assert.equal(Object.hasOwn(flow, 'title'), false)
  assert.equal(Object.hasOwn(flow, 'kind'), false)
  assert.equal(Object.hasOwn(flow.entry, 'kind'), false)
  assert.equal(Object.hasOwn(flow, 'edges'), false)
})
test('Native document roundtrip keeps extension data; FlowText has no key field', () => {
  const flow = fixture(); flow.extensions = { designer: { note: 'keep' } }
  assert.deepEqual(parseFlow(JSON.stringify(flow)), flow)
  assert.throws(() => parseFlow(JSON.stringify({ ...flow, entry: { ...flow.entry, title: { text: '原文', key: 'story.title' } } })), /entry.title/)
  assert.throws(() => parseFlow(JSON.stringify({ ...flow, nodes: { start: { ...flow.nodes.start, completion: 'finish' } } })), /旧草稿/)
})
test('Mod quest JSON and unknown document versions are rejected', () => {
  assert.throws(() => parseFlow('{"format_version":1,"id":"demo:task","checkpoints":{},"edges":[]}'), /格式或版本/)
  assert.throws(() => parseFlow(JSON.stringify({ ...fixture(), version: 2 })), /格式或版本/)
})
test('Duplicate JSON keys cannot silently discard author content', () => {
  assert.throws(() => parseFlow('{"format":"hanshu.progress-tree","format":"other"}'), /重复/)
})
test('Canvas wire DAG warning reports one cycle; acyclic graphs stay clean', () => {
  const dag = linkViaTransition(fixture(), 'start', 'node_1')
  assert.equal(findCanvasCycle(dag.flow), null)
  assert.ok(!validateFlow(dag.flow).some(i => i.path === 'graph'))
  // entry → start → t → node_1 → t2 → start
  const back = createTransitionNode(dag.flow, { x: 0, y: 0 })
  let flow = connectNodes(back.flow, 'node_1', back.id, 'input2').flow
  flow = connectNodes(flow, back.id, 'start').flow
  const path = findCanvasCycle(flow)
  assert.ok(path)
  assert.equal(path![0], path![path!.length - 1])
  assert.ok(path!.includes('start') && path!.includes('node_1'))
  assert.ok(validateFlow(flow).some(i => i.severity === 'warning' && i.message.includes(path!.join(' → '))))
})
test('An independent checkpoint is a valid draft without an end node', () => {
  const flow = createFlow('draft')
  assert.equal(errors(flow).length, 0)
  assert.equal(validateFlow(flow).length, 0)
})
test('Renaming the first checkpoint updates the independent entry connection and references', () => {
  const before = fixture()
  before.goals = { wait: { kind: 'nodes', title: text('等待准备'), description: text(), params: {}, nodeRefs: ['start'] } }
  const after = renameNode(before, 'start', 'invitation')
  assert.equal(before.entry.target, 'start')
  assert.equal(after.entry.target, 'invitation')
  assert.equal(after.entry.id, before.entry.id)
  assert.deepEqual(after.goals!.wait.nodeRefs, ['invitation'])
  assert.equal(errors(after).length, 0)
})
test('Renaming a node updates transition endpoints and preserves resources', () => {
  const flow = fixture()
  const linked = linkViaTransition(flow, 'start', 'node_1')
  const next = renameNode(linked.flow, 'node_1', 'prepare')
  assert.equal(next.logic!.links.find(link => link.to === 'prepare')!.to, 'prepare')
  assert.equal(next.nodes.prepare.title.text, flow.nodes.node_1.title.text)
  assert.throws(() => renameNode(next, 'prepare', 'constructor'))
  assert.throws(() => renameNode(next, 'prepare', 'node_2'))
})
test('Canvas connections via transition preserve checkpoint content and reject 直连', () => {
  const before = withCanvasPositions(fixture()), original = clone(before)
  assert.throws(() => connectNodes(before, 'node_1', 'node_2'), /直连/)
  assert.deepEqual(before, original)
  const result = linkViaTransition(before, 'start', 'node_1')
  assert.deepEqual(result.flow.nodes.start, before.nodes.start)
  assert.deepEqual(result.flow.nodes.node_1, before.nodes.node_1)
  assert.equal(result.flow.logic!.links.length, 2)
  assert.equal(errors(result.flow).length, 0)
  assert.deepEqual(parseFlow(JSON.stringify(result.flow)), result.flow)
  const duplicate = connectNodes(result.flow, 'start', result.id, 'input2')
  assert.equal(duplicate.flow, result.flow)
  assert.deepEqual(duplicate.selection, { kind: 'logic-link', id: result.flow.logic!.links.find(link => link.port === 'input2')!.id })
})
test('Replacing and disconnecting the entry retain every checkpoint and position', () => {
  const before = withCanvasPositions(fixture()), result = connectNodes(before, before.entry.id, 'node_2')
  assert.equal(result.flow.entry.target, 'node_2')
  assert.equal(before.entry.target, 'start')
  assert.deepEqual(result.flow.nodes, before.nodes)
  assert.deepEqual(result.flow.layout, before.layout)
  const disconnected = disconnectLink(result.flow, result.selection)
  assert.equal(disconnected.entry.target, null)
  assert.deepEqual(disconnected.nodes, before.nodes)
  assert.deepEqual(disconnected.layout, before.layout)
  assert.equal(disconnectLink(before, { kind: 'entry' }), before)
})
test('Disconnecting a transition link removes only that connection', () => {
  const before = withCanvasPositions(fixture()), linked = linkViaTransition(before, 'start', 'node_1')
  const parentLink = linked.flow.logic!.links.find(link => link.port === 'input2')!
  const result = disconnectLink(linked.flow, { kind: 'logic-link', id: parentLink.id })
  assert.equal(result.logic!.links.filter(link => link.id === parentLink.id).length, 0)
  assert.equal(result.logic!.links.filter(link => link.from === linked.id).length, 1)
  assert.deepEqual(result.nodes, linked.flow.nodes)
  assert.deepEqual(result.entry, linked.flow.entry)
  assert.equal(disconnectLink(result, { kind: 'logic-link', id: parentLink.id }), result)
})
test('Connections reject missing endpoints, entry inputs, end outputs and checkpoint直连', () => {
  const flow = fixture()
  const end = createEndNode(flow, { x: 400, y: 0 })
  assert.throws(() => connectNodes(flow, 'missing', 'start'), /端口/)
  assert.throws(() => connectNodes(flow, 'start', 'missing'), /连接目标/)
  assert.throws(() => connectNodes(flow, 'start', flow.entry.id), /连接目标/)
  assert.throws(() => connectNodes(flow, 'node_2', 'start'), /直连/)
  assert.throws(() => connectNodes(flow, 'node_1', 'node_1'), /直连/)
  assert.deepEqual(outputPorts(end.flow, end.id), [])
  assert.ok(canConnectNodes(end.flow, 'start', end.id, 'input'))
  assert.throws(() => connectNodes(end.flow, end.id, 'node_1'))
  let linked = connectNodes(end.flow, 'start', end.id).flow
  linked = connectNodes(linked, 'node_1', end.id).flow
  assert.equal(linked.logic!.links.filter(link => link.to === end.id).length, 2)
  assert.equal(errors(linked).length, 0)
  const transition = createTransitionNode(linked, { x: 0, y: 0 })
  assert.throws(() => connectNodes(transition.flow, transition.id, end.id))
  const loop = linkViaTransition(flow, 'start', 'start')
  assert.equal(errors(loop.flow).length, 0)
  assert.equal(layoutCanvas(loop.flow).positions.size, Object.keys(loop.flow.nodes).length + Object.keys(loop.flow.transitions!).length + 1)
  assert.deepEqual(nodeMetrics(end.flow, end.id), { width: 156, height: 62, socketY: 44 })
})
test('Deleting one checkpoint clears its references without removing unrelated nodes', () => {
  const flow = fixture()
  flow.goals = { wait: { kind: 'nodes', title: text(), description: text(), params: {}, nodeRefs: ['node_1', 'node_3'] } }
  const linked = linkViaTransition(flow, 'start', 'node_1')
  const next = removeNode(linked.flow, 'node_1')
  assert.deepEqual(Object.keys(next.nodes).sort(), ['node_2', 'node_3', 'start'])
  assert.deepEqual(next.goals!.wait.nodeRefs, ['node_3'])
  assert.deepEqual(next.nodes.node_3, flow.nodes.node_3)
  assert.equal(next.logic!.links.filter(link => link.from === 'node_1' || link.to === 'node_1').length, 0)
  assert.equal(errors(next).length, 0)
  assert.equal(Object.keys(flow.nodes).length, 4)
})
test('A new canvas has one immutable entry and freely created checkpoints', () => {
  const empty = createFlow('empty')
  assert.equal(removeNode(empty, empty.entry.id), empty)
  assert.equal(empty.entry.id, 'entry')
  assert.equal(empty.entry.target, null)
  assert.equal(Object.hasOwn(empty.entry, 'kind'), false)
  assert.equal(empty.entry.title.text, createFlow().entry.title.text)
  assert.equal(empty.entry.description.text, '')
  assert.deepEqual(empty.nodes, {})
  assert.equal(layoutCanvas(empty).positions.size, 1)
  assert.equal(errors(parseFlow(JSON.stringify(empty))).length, 0)
  const added = createCheckpoint(empty, { x: 725, y: 315 })
  assert.equal(added.flow.entry.target, null)
  assert.deepEqual(added.flow.layout!.positions[added.id], { x: 725, y: 315 })
  assert.equal(errors(added.flow).length, 0)
  const connected = connectEntry(added.flow, added.id)
  const removed = removeNode(connected, added.id)
  assert.deepEqual(removed.nodes, {})
  assert.deepEqual(removed.entry, empty.entry)
  assert.equal(layoutCanvas(removed).positions.size, 1)
})
test('The entry moves and roundtrips independently without checkpoint content', () => {
  const flow = withCanvasPositions(fixture()), before = clone(flow)
  const moved = moveCheckpoint(flow, flow.entry.id, { x: 430, y: 520 })
  assert.deepEqual(moved.entry, before.entry)
  assert.deepEqual(moved.nodes, before.nodes)
  for (const id of Object.keys(flow.nodes)) assert.deepEqual(moved.layout!.positions[id], before.layout!.positions[id])
  assert.deepEqual(moved.layout!.positions[flow.entry.id], { x: 430, y: 520 })
  assert.deepEqual(parseFlow(JSON.stringify(moved)), moved)
  assert.equal(removeNode(moved, moved.entry.id), moved)
  assert.throws(() => renameNode(moved, 'start', moved.entry.id), /节点 ID/)
  assert.throws(() => connectEntry(moved, moved.entry.id), /输入端口/)
  assert.throws(() => connectEntry(moved, 'missing'), /输入端口/)
})
test('A disconnected entry can create and connect its first checkpoint', () => {
  const flow = createFlow('first'), added = addNextCheckpoint(flow, flow.entry.id)
  assert.equal(added.flow.entry.target, added.id)
  assert.equal(flow.entry.target, null)
  assert.equal(Object.keys(flow.nodes).length, 0)
  assert.equal(errors(added.flow).length, 0)
  assert.throws(() => addNextCheckpoint(added.flow, flow.entry.id), /起点/)
  const disconnected = connectEntry(added.flow, null)
  assert.deepEqual(disconnected.nodes, added.flow.nodes)
  assert.equal(disconnected.entry.target, null)
})
test('addNode only works from entry; addNextCheckpoint wires transition from checkpoint', () => {
  const flow = fixture()
  assert.throws(() => addNode(flow, 'start'), /直连/)
  const added = addNextCheckpoint(flow, 'start')
  assert.ok(Object.keys(added.flow.transitions!).length >= 1)
  assert.equal(added.flow.logic!.links.filter(link => link.from === 'start' && link.port === 'input2').length, 1)
  assert.equal(added.flow.logic!.links.filter(link => link.to === added.id).length, 1)
  assert.equal(errors(added.flow).length, 0)
})
test('Missing entries and duplicate canvas identities cannot silently erase an entry', () => {
  const flow = createFlow('shape')
  assert.throws(() => parseFlow(JSON.stringify({ ...flow, entry: undefined })), /entry/)
  assert.throws(() => parseFlow(JSON.stringify({ ...flow, nodes: { [flow.entry.id]: makeNode() } })), /entry.id/)
  assert.throws(() => parseFlow(JSON.stringify({ ...flow, root: null })), /旧草稿/)
})
test('Free creation, dragging and deletion preserve other positions and node content', () => {
  const original = fixture(), fixed = withCanvasPositions(original)
  const added = createCheckpoint(fixed, { x: 640, y: 480 })
  assert.deepEqual(added.flow.nodes.start, original.nodes.start)
  assert.deepEqual(added.flow.layout!.positions.start, fixed.layout!.positions.start)
  const moved = moveCheckpoint(added.flow, added.id, { x: 120, y: 220 })
  assert.deepEqual(moved.nodes, added.flow.nodes)
  assert.deepEqual(moved.layout!.positions.start, fixed.layout!.positions.start)
  const deleted = removeNode(moved, 'node_1')
  assert.deepEqual(deleted.layout!.positions.node_3, fixed.layout!.positions.node_3)
  assert.equal(Object.hasOwn(deleted.layout!.positions, 'node_1'), false)
  assert.deepEqual(parseFlow(JSON.stringify(deleted)), deleted)
  assert.equal(original.layout, undefined)
})
test('Renaming preserves canvas coordinates; connected creation avoids occupied slots', () => {
  const flow = withCanvasPositions(fixture())
  const renamed = renameNode(flow, 'node_1', 'prepare')
  assert.deepEqual(renamed.layout!.positions.prepare, flow.layout!.positions.node_1)
  assert.equal(Object.hasOwn(renamed.layout!.positions, 'node_1'), false)
  const added = addNextCheckpoint(flow, 'start')
  assert.deepEqual(Object.fromEntries(layoutCanvas(flow).positions), flow.layout!.positions)
  assert.deepEqual(added.flow.layout!.positions.node_1, flow.layout!.positions.node_1)
  assert.notDeepEqual(added.flow.layout!.positions[added.id], flow.layout!.positions.node_1)
})
test('Invalid positions cannot be saved or applied', () => {
  const flow = createFlow('coords')
  assert.throws(() => createCheckpoint(flow, { x: NaN, y: 0 }))
  assert.throws(() => moveCheckpoint(flow, flow.entry.id, { x: 0, y: Infinity }))
  assert.throws(() => parseFlow(JSON.stringify({ ...flow, layout: { positions: { start: { x: null, y: 0 } } } })), /layout.positions/)
  assert.throws(() => parseFlow(JSON.stringify({ ...flow, layout: { positions: [] } })), /layout.positions/)
})
test('Infinite canvas positions can cross the origin and survive serialization', () => {
  const flow = createFlow('coords'), moved = moveCheckpoint(flow, flow.entry.id, { x: -720, y: -480 })
  const restored = parseFlow(JSON.stringify(moved))
  assert.deepEqual(layoutCanvas(restored).positions.get(flow.entry.id), { x: -720, y: -480 })
  const added = createCheckpoint(restored, { x: -1100, y: -600 })
  assert.deepEqual(parseFlow(JSON.stringify(added.flow)).layout!.positions[added.id], { x: -1100, y: -600 })
})
test('Cursor-centered zoom keeps its world point fixed across scale limits and negative camera positions', () => {
  for (const camera of [{ x: -900, y: 420, zoom: .8 }, { x: 1300, y: -760, zoom: 1.6 }]) {
    for (const zoom of [.01, .5, 1, 1.8, 10]) {
      const cursor = { x: 340, y: 190 }, before = worldPoint(camera, cursor), next = zoomCamera(camera, zoom, cursor), after = worldPoint(next, cursor)
      assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9)
      assert.ok(next.zoom >= MIN_CANVAS_ZOOM && next.zoom <= MAX_CANVAS_ZOOM)
    }
  }
})

test('Rejected legacy draft fields fail parse without migration', () => {
  assert.throws(() => parseFlow(JSON.stringify({
    format: 'hanshu.progress-tree', version: 1, id: 'legacy',
    title: { text: '旧标题' }, description: { text: '旧说明' }, kind: 'chapter',
    entry: { id: 'entry', target: 'a', title: { text: '图' }, description: { text: '' } },
    nodes: { a: { title: { text: 'A' }, description: { text: '' }, completion: 'continue' } },
  })), /旧草稿/)
  assert.throws(() => parseFlow(JSON.stringify({
    format: 'hanshu.progress-tree', version: 1, id: 'legacy',
    entry: { id: 'entry', target: 'a', kind: 'task', title: { text: '图' }, description: { text: '' } },
    nodes: { a: { title: { text: 'A' }, description: { text: '' }, completion: 'continue' } },
  })), /旧草稿/)
  assert.throws(() => parseFlow(JSON.stringify({
    format: 'hanshu.progress-tree', version: 1, id: 'legacy',
    entry: { id: 'entry', target: 'a', title: { text: '图' }, description: { text: '' } },
    nodes: { a: { title: { text: 'A' }, description: { text: '' }, completion: 'continue', children: [] } },
  })), /旧草稿/)
  assert.throws(() => parseFlow(JSON.stringify({
    format: 'hanshu.progress-tree', version: 1, id: 'legacy',
    entry: { id: 'entry', target: 'a', title: { text: '图' }, description: { text: '' } },
    nodes: { a: { title: { text: 'A' }, description: { text: '' }, completion: 'continue' } },
    logic: { nodes: { logic_old: { operator: 'or' } }, links: [] },
  })), /logic/)
})

test('Flat storage supports long transition chains without deeply nested document JSON', () => {
  let flow = createFlow('deep')
  const first = addNode(flow, flow.entry.id)
  flow = first.flow
  let parent = first.id
  for (let n = 0; n < 599; n++) {
    const added = addNextCheckpoint(flow, parent)
    flow = added.flow
    parent = added.id
  }
  assert.equal(Object.keys(parseFlow(JSON.stringify(flow)).nodes).length, 600)
  assert.equal(errors(flow).length, 0)
})

const store = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) }, configurable: true })
test('Storage uses only the native library; old quest storage is not consumed', () => {
  store.set('hanshu.questWorkspace.v1', '{bad old prototype}')
  const loaded = loadFlowWorkspace()
  assert.equal(loaded.error, '')
  assert.equal(loaded.state.documents.length, 1)
  assert.equal(parseFlow(loaded.state.documents[0].source).format, 'hanshu.progress-tree')
})
test('Raw incomplete source and an empty library survive reload', () => {
  const doc = createFlowDocument(); doc.source = '{"format":'
  saveFlowWorkspace({ documents: [doc], folders: [], activeKey: doc.key })
  assert.equal(loadFlowWorkspace().state.documents[0].source, doc.source)
  saveFlowWorkspace({ documents: [], folders: [], activeKey: null })
  assert.deepEqual(loadFlowWorkspace().state, { documents: [], folders: [], activeKey: null })
})
test('Corrupt storage is reported without modifying the stored bytes', () => {
  store.set(FLOW_STORAGE_KEY, '{bad}')
  assert(loadFlowWorkspace().error)
  assert.equal(store.get(FLOW_STORAGE_KEY), '{bad}')
})
test('Native import preserves authored text and accepts UTF-8 BOM', () => {
  const flow = fixture(), doc = importFlowDocument('故事.hflow', '\uFEFF' + JSON.stringify(flow))
  assert.equal(doc.name, '故事.hflow')
  assert.deepEqual(parseFlow(doc.source), flow)
})
test('Nested resource folders persist without changing flow content or active identity', () => {
  const doc = createFlowDocument(fixture()), empty = { documents: [doc], folders: [], activeKey: doc.key }
  const chapter = addFlowFolder(empty, '第一章', 'story', null), story = addFlowFolder(chapter.state, '支线', 'story', chapter.folder.key)
  const entry = { kind: 'document' as const, key: doc.key }
  const moved = moveFlowEntry(story.state, entry, 'story', story.folder.key), renamed = renameFlowEntry(moved, entry, '驿站')
  assert.equal(doc.package, 'story')
  assert.equal(empty.documents[0].folderId, undefined)
  assert.equal(renamed.documents[0].source, doc.source)
  assert.equal(renamed.documents[0].name, '驿站.hflow')
  assert.equal(renamed.activeKey, doc.key)
  saveFlowWorkspace(renamed)
  assert.deepEqual(loadFlowWorkspace().state, renamed)
  assert.throws(() => moveFlowEntry(renamed, { kind: 'folder', key: chapter.folder.key }, 'story', story.folder.key), /子文件夹/)
  assert.equal(moveFlowEntry(renamed, entry, 'story', null).documents[0].folderId, null)
})
test('Resource name collisions are rejected and repeated imports receive distinct names', () => {
  const doc = { ...createFlowDocument(), name: '故事.hflow' }, state = { documents: [doc], folders: [], activeKey: doc.key }
  assert.throws(() => addFlowFolder(state, '故事.hflow', 'story', null), /同名/)
  assert.throws(() => renameFlowEntry(state, { kind: 'document', key: doc.key }, '../故事'), /有效名称/)
  assert.equal(uniqueDocumentName(state, '故事.hflow', 'story', null), '故事 (2).hflow')
  const folder = addFlowFolder(state, '章节', 'story', null)
  assert.equal(uniqueDocumentName(folder.state, '故事.hflow', 'story', folder.folder.key), '故事.hflow')
})
test('Broken folder references and cycles cannot silently hide saved documents', () => {
  const doc = { ...createFlowDocument(), folderId: 'missing' }
  const raw = JSON.stringify({ documents: [doc], folders: [], activeKey: doc.key })
  store.set(FLOW_STORAGE_KEY, raw)
  assert(loadFlowWorkspace().error)
  assert.equal(store.get(FLOW_STORAGE_KEY), raw)
  store.set(FLOW_STORAGE_KEY, JSON.stringify({ documents: [], folders: [{ key: 'a', name: 'A', parentId: 'b' }, { key: 'b', name: 'B', parentId: 'a' }], activeKey: null }))
  assert(loadFlowWorkspace().error)
})
test('Canvas notes roundtrip as layout without becoming connectable content', () => {
  const original = fixture(), created = createCanvasNote(original, { x: -200, y: 90 })
  const flow = updateCanvasNote(created.flow, created.id, { title: '设计说明', text: '第一行\n第二行', color: 'sage', width: 320, height: 180 })
  const restored = parseFlow(JSON.stringify(flow))
  assert.deepEqual(restored.nodes, original.nodes)
  assert.deepEqual(restored.entry, original.entry)
  assert.deepEqual(getCanvasNote(restored, created.id), { title: '设计说明', text: '第一行\n第二行', color: 'sage', width: 320, height: 180 })
  assert.deepEqual(layoutCanvas(restored).positions.get(created.id), { x: -200, y: 90 })
  assert.deepEqual(nodeMetrics(restored, created.id), { width: 320, height: 180, socketY: 0 })
  assert.equal(hasContentNode(restored, created.id), false)
  assert.deepEqual(inputPorts(restored, created.id), [])
  assert.equal(canConnectNodes(restored, created.id, 'start', 'input'), false)
  assert.throws(() => connectEntry(restored, created.id))
  assert.throws(() => connectNodes(restored, 'start', created.id))
  assert.equal(errors(restored).length, 0)
})

test('Notes move with grouped nodes and removing one preserves other members and content', () => {
  const created = createCanvasNote(fixture(), { x: 30, y: 40 }), group = groupCanvasNodes(created.flow, [created.id, 'start', 'node_1'])
  const before = clone(group.flow), members = before.layout!.groups![group.id].nodes
  const positions = Object.fromEntries(members.map(id => [id, { x: before.layout!.positions[id].x + 70, y: before.layout!.positions[id].y - 25 }]))
  const moved = moveCanvasNodes(group.flow, positions)
  assert.deepEqual(moved.layout!.positions[created.id], { x: 100, y: 15 })
  assert.deepEqual(moved.nodes, before.nodes)
  assert.deepEqual(parseFlow(JSON.stringify(moved)), moved)
  assert.equal(errors(moved).length, 0)
  const removed = removeCanvasNote(moved, created.id)
  assert.equal(getCanvasNote(removed, created.id), undefined)
  assert.equal(Object.hasOwn(removed.layout!.positions, created.id), false)
  assert.deepEqual(removed.layout!.groups![group.id], { name: 'Group 1', nodes: ['start', 'node_1'] })
  assert.deepEqual(removed.nodes, before.nodes)
  assert.deepEqual(group.flow, before)
})

test('Malformed notes and ID collisions are rejected before rendering', () => {
  const created = createCanvasNote(fixture(), { x: 0, y: 0 }), flow = created.flow
  for (const patch of [{ width: 0 }, { height: 'large' }, { text: 12 }, { color: 'unknown' }]) {
    const invalid = clone(flow)
    Object.assign(invalid.layout!.notes![created.id], patch)
    assert.throws(() => parseFlow(JSON.stringify(invalid)), /layout.notes/)
  }
  flow.layout!.notes!.start = flow.layout!.notes![created.id]
  assert.throws(() => parseFlow(JSON.stringify(flow)), /layout.notes/)
})

test('Mixed multi-delete protects the entry, cleans references and leaves other items fixed', () => {
  const note = createCanvasNote(fixture(), { x: -200, y: 100 })
  const goal = createGoalNode(note.flow, { x: 500, y: -100 })
  const transition = createTransitionNode(goal.flow, { x: 300, y: 200 })
  const linked = connectNodes(transition.flow, goal.id, transition.id).flow
  const grouped = groupCanvasNodes(linked, ['start', note.id, 'node_1']).flow, before = clone(grouped)
  const after = removeCanvasItems(grouped, [grouped.entry.id, 'start', 'start', note.id, goal.id, 'missing'])
  assert.equal(after.entry.id, before.entry.id)
  assert.equal(after.entry.target, null)
  assert.equal(after.nodes.start, undefined)
  assert.equal(getCanvasNote(after, note.id), undefined)
  assert.equal(after.goals![goal.id], undefined)
  assert.equal(after.logic!.links.filter(link => link.from === goal.id || link.to === goal.id).length, 0)
  assert.deepEqual(after.layout!.groups, {})
  for (const id of ['node_1', 'node_2', 'node_3']) {
    assert.deepEqual(after.nodes[id], before.nodes[id])
    assert.deepEqual(after.layout!.positions[id], before.layout!.positions[id])
  }
  assert.ok(after.transitions?.[transition.id])
  assert.deepEqual(after.transitions![transition.id].title, before.transitions![transition.id].title)
  assert.equal(errors(after).length, 0)
  assert.deepEqual(grouped, before)
  assert.equal(removeCanvasItems(grouped, [grouped.entry.id, 'missing']), grouped)
})

function arrangeFixture(positions: Record<string, { x: number; y: number }>) {
  const flow = createFlow('arrange')
  flow.nodes = Object.fromEntries(Object.keys(positions).map(id => [id, makeNode(id)]))
  flow.layout = { positions: { ...positions, entry: { x: -1000, y: -1000 } } }
  return flow
}

test('Smart arrangement refines an existing matrix with small nudges and stable columns', () => {
  const original = arrangeFixture({ a: { x: -200, y: 40 }, b: { x: 80, y: 45 }, c: { x: 372, y: 37 }, d: { x: -196, y: 210 }, e: { x: 76, y: 215 }, f: { x: 368, y: 207 }, outside: { x: 1000, y: -400 } })
  const before = clone(original), ids = ['a', 'b', 'c', 'd', 'e', 'f']
  const next = smartArrangeCanvas(original, ids), positions = next.layout!.positions
  for (const row of [['a', 'b', 'c'], ['d', 'e', 'f']]) {
    assert.equal(positions[row[0]].y, positions[row[1]].y)
    assert.equal(positions[row[1]].y, positions[row[2]].y)
    assert.equal(positions[row[1]].x - positions[row[0]].x, positions[row[2]].x - positions[row[1]].x)
  }
  for (const [a, b] of [['a', 'd'], ['b', 'e'], ['c', 'f']]) assert.equal(positions[a].x, positions[b].x)
  for (const id of ids) assert(Math.hypot(positions[id].x - before.layout!.positions[id].x, positions[id].y - before.layout!.positions[id].y) <= 32)
  assert.deepEqual(positions.outside, before.layout!.positions.outside)
  assert.deepEqual(next.nodes, before.nodes)
  assert.deepEqual(next.entry, before.entry)
  assert.deepEqual(original, before)
  assert.equal(smartArrangeCanvas(next, [...ids].reverse()), next)
})

test('Smart arrangement preserves sparse designs, large deliberate gaps and ambiguous diagonals', () => {
  const sparse = arrangeFixture({ a: { x: 0, y: 0 }, b: { x: 290, y: 170 }, c: { x: 570, y: 360 } })
  assert.equal(smartArrangeCanvas(sparse, ['a', 'b', 'c']), sparse)
  const wide = arrangeFixture({ a: { x: 0, y: 0 }, b: { x: 280, y: 4 }, c: { x: 1400, y: -4 } })
  const next = smartArrangeCanvas(wide, ['a', 'b', 'c'])
  assert.deepEqual(['a', 'b', 'c'].map(id => next.layout!.positions[id].x), [0, 280, 1400])
  const ambiguous = arrangeFixture({ a: { x: 0, y: 0 }, b: { x: 300, y: 24 }, c: { x: 600, y: 48 } })
  assert.equal(smartArrangeCanvas(ambiguous, ['a', 'b', 'c']), ambiguous)
})

test('Smart arrangement avoids new collisions with unselected items and supports mixed sizes', () => {
  const blocked = arrangeFixture({ a: { x: 0, y: 0 }, b: { x: 280, y: 24 }, obstacle: { x: 0, y: 114 } })
  assert.equal(smartArrangeCanvas(blocked, ['a', 'b']), blocked)
  const original = createMergeNode(createCanvasNote(arrangeFixture({ a: { x: 0, y: 10 } }), { x: 275, y: 0 }).flow, { x: 620, y: 7 })
  const ids = ['a', ...Object.keys(original.flow.layout!.notes!), original.id]
  const next = smartArrangeCanvas(original.flow, ids), p = next.layout!.positions
  assert.equal(p[ids[0]].y, p[ids[1]].y)
  assert.equal(p[ids[1]].y, p[ids[2]].y)
  assert.equal(p[ids[1]].x - p[ids[0]].x - 216, p[ids[2]].x - p[ids[1]].x - 280)
  assert.deepEqual(next.layout!.notes, original.flow.layout!.notes)
})

test('Transition nodes expose two independent inputs and one centered output', () => {
  const added = createTransitionNode(fixture(), { x: -80, y: 240 }), flow = added.flow
  assert.deepEqual(inputPorts(flow, added.id), ['input', 'input2'])
  assert.deepEqual(socketOffset(flow, added.id, 'input'), { x: 0, y: 58 })
  assert.deepEqual(socketOffset(flow, added.id, 'input2'), { x: 0, y: 86 })
  assert.deepEqual(socketOffset(flow, added.id, 'output'), { x: 180, y: 72 })
  assert.deepEqual(parseFlow(JSON.stringify(flow)), flow)
  assert.deepEqual(flow.nodes, fixture().nodes)
  assert.equal(errors(flow).length, 0)
  const group = groupCanvasNodes(flow, [added.id, 'start'])
  const moved = moveCanvasNodes(group.flow, { [added.id]: { x: 400, y: -50 } })
  assert.deepEqual(moved.layout!.positions[added.id], { x: 400, y: -50 })
  assert.deepEqual(moved.transitions, flow.transitions)
  assert.equal(errors(moved).length, 0)
})

test('Transition connections match Goal / Parent / Next types and replace exclusive ports', () => {
  const added = createTransitionNode(fixture(), { x: 400, y: 100 })
  const goal = createGoalNode(added.flow, { x: 100, y: 240 })
  const secondGoal = createGoalNode(goal.flow, { x: 100, y: 360 })
  assert.deepEqual(inputPorts(goal.flow, goal.id), [])
  assert.equal(portKind(goal.flow, goal.id, 'output'), 'goal')
  assert.equal(portKind(goal.flow, added.id, 'input'), 'goal')
  assert.equal(portKind(goal.flow, added.id, 'input2'), 'checkpoint')
  assert.equal(portKind(goal.flow, added.id, 'output'), 'checkpoint')
  assert.equal(portKind(goal.flow, 'start', 'output'), 'checkpoint')
  assert.equal(portKind(goal.flow, goal.flow.entry.id, 'output'), 'checkpoint')
  assert.equal(canConnectNodes(goal.flow, 'start', goal.id, 'input'), false)
  assert.throws(() => connectNodes(goal.flow, 'start', goal.id), /端口/)
  assert.throws(() => connectNodes(goal.flow, 'start', added.id, 'input'), /端口/)
  assert.throws(() => connectNodes(goal.flow, goal.id, added.id, 'input2'), /端口/)
  assert.throws(() => connectNodes(goal.flow, goal.flow.entry.id, added.id, 'input'), /端口/)
  assert.throws(() => connectNodes(goal.flow, goal.flow.entry.id, added.id, 'input2'), /端口/)
  let flow = connectNodes(secondGoal.flow, goal.id, added.id, 'input').flow
  // Goal 口允许多线合取
  flow = connectNodes(flow, secondGoal.id, added.id, 'input').flow
  assert.equal(flow.logic!.links.filter(link => link.to === added.id && link.port === 'input').length, 2)
  assert.deepEqual(flow.logic!.links.filter(link => link.to === added.id && link.port === 'input').map(link => link.from).sort(), [goal.id, secondGoal.id].sort())
  flow = connectNodes(flow, 'start', added.id, 'input2').flow
  const replacedParent = connectNodes(flow, 'node_1', added.id, 'input2').flow
  assert.equal(replacedParent.logic!.links.filter(link => link.to === added.id && link.port === 'input2').length, 1)
  assert.equal(replacedParent.logic!.links.find(link => link.to === added.id && link.port === 'input2')!.from, 'node_1')
  flow = connectNodes(replacedParent, replacedParent.entry.id, 'node_2').flow
  assert.equal(flow.entry.target, 'node_2')
  assert.equal(flow.logic!.links.find(link => link.to === added.id && link.port === 'input2')!.from, 'node_1')
  flow = connectNodes(flow, added.id, 'node_2').flow
  const replacedNext = connectNodes(flow, added.id, 'start').flow
  assert.equal(replacedNext.logic!.links.filter(link => link.from === added.id).length, 1)
  assert.equal(replacedNext.logic!.links.find(link => link.from === added.id)!.to, 'start')
  assert.equal(connectNodes(flow, secondGoal.id, added.id, 'input').flow, flow)
  assert.deepEqual(flow.logic!.links.map(link => link.port).sort(), ['input', 'input', 'input', 'input2'])
  assert.deepEqual(flow.nodes, added.flow.nodes)
  assert.equal(errors(flow).length, 0)
  assert.deepEqual(parseFlow(JSON.stringify(flow)), flow)
  assert.throws(() => connectNodes(flow, added.id, secondGoal.id), /端口/)
  assert.throws(() => connectNodes(flow, added.id, 'node_1', 'input2'), /端口/)
  const cut = disconnectLink(flow, { kind: 'logic-link', id: flow.logic!.links.find(link => link.port === 'input2')!.id })
  assert.equal(cut.logic!.links.filter(link => link.port === 'input2').length, 0)
  assert.equal(cut.logic!.links.filter(link => link.to === added.id && link.port === 'input').length, 2)
  assert.equal(cut.logic!.links.filter(link => link.from === added.id).length, 1)
  const removed = removeCanvasItems(flow, [added.id])
  assert.equal(removed.transitions![added.id], undefined)
  assert.equal(removed.logic!.links.length, 0)
  assert.deepEqual(removed.nodes, added.flow.nodes)
})

test('Entry out ≡ Transition Next: entry only connects to checkpoints; Parent only from checkpoint', () => {
  const added = createTransitionNode(fixture(), { x: 400, y: 100 })
  assert.throws(() => connectNodes(added.flow, added.flow.entry.id, added.id, 'input'), /端口/)
  assert.throws(() => connectNodes(added.flow, added.flow.entry.id, added.id, 'input2'), /端口/)
  assert.equal(canConnectNodes(added.flow, added.flow.entry.id, 'start', 'input'), true)
  const toStart = connectNodes(added.flow, added.flow.entry.id, 'start').flow
  assert.equal(toStart.entry.target, 'start')
  assert.equal(outgoingCount(toStart, toStart.entry.id), 1)
  assert.deepEqual(parseFlow(JSON.stringify(toStart)), toStart)
  assert.equal(errors(toStart).length, 0)
  assert.throws(() => connectEntry(toStart, added.id, 'input2'), /输入端口/)
  let flow = connectNodes(toStart, 'start', added.id, 'input2').flow
  flow = connectNodes(flow, added.id, 'node_1').flow
  assert.equal(errors(flow).length, 0)
  assert.equal(disconnectLink(flow, { kind: 'entry-link' }).entry.target, null)
  assert.equal(removeNode(flow, added.id).entry.target, 'start')
})

test('Checkpoints keep multi in/out while entry and transition Parent/Next stay single', () => {
  const first = createTransitionNode(fixture(), { x: 400, y: 100 })
  const second = createTransitionNode(first.flow, { x: 400, y: 280 })
  let flow = connectNodes(second.flow, 'start', first.id, 'input2').flow
  flow = connectNodes(flow, 'start', second.id, 'input2').flow
  assert.equal(flow.logic!.links.filter(link => link.from === 'start' && link.port === 'input2').length, 2)
  assert.ok(outgoingCount(flow, 'start') >= 2)
  flow = connectNodes(flow, first.id, 'node_1').flow
  flow = connectNodes(flow, second.id, 'node_1').flow
  assert.equal(flow.logic!.links.filter(link => link.to === 'node_1').length, 2)
  assert.equal(errors(flow).length, 0)
  const replaced = connectNodes(flow, flow.entry.id, 'node_2').flow
  assert.equal(replaced.entry.target, 'node_2')
  assert.equal(outgoingCount(replaced, replaced.entry.id), 1)
  const nextSwap = connectNodes(flow, first.id, 'node_2').flow
  assert.equal(nextSwap.logic!.links.filter(link => link.from === first.id).length, 1)
  assert.equal(nextSwap.logic!.links.find(link => link.from === first.id)!.to, 'node_2')
})

test('Malformed transition content and colliding canvas identities are rejected', () => {
  const added = createTransitionNode(fixture(), { x: 0, y: 0 })
  const collision = clone(added.flow)
  collision.transitions!.start = collision.transitions![added.id]
  assert.throws(() => parseFlow(JSON.stringify(collision)), /transitions/)
  const malformed = clone(added.flow)
  Reflect.set(malformed.transitions![added.id], 'title', null)
  assert.throws(() => parseFlow(JSON.stringify(malformed)), /transitions/)
  const invalidEntry = clone(added.flow)
  Reflect.set(invalidEntry.entry, 'port', 'unknown')
  assert.throws(() => parseFlow(JSON.stringify(invalidEntry)), /entry/)
})


test('Start node emits S(未激活→已激活); matching ckpt transitions and fires activation', () => {
  const flow = createFlow('sim-start')
  flow.nodes.a = makeNode('A')
  flow.entry.target = 'a'
  assert.deepEqual(outgoingSignalTargets(flow, flow.entry.id), [{ to: 'a', port: 'input' }])
  let sim = createSimState(flow)
  assert.equal(ckptState(sim, 'a'), 'inactive')
  sim = fireStart(flow, sim)
  assert.equal(ckptState(sim, 'a'), 'activated')
  assert.equal(CKPT_STATES[ckptState(sim, 'a')], '已激活')
  assert.ok(sim.log.some(item => item.accepted && item.to === 'a' && item.signal.kind === 'ckpt-transition'))
  const again = fireStart(flow, sim)
  assert.equal(ckptState(again, 'a'), 'activated')
  assert.ok(again.log.at(-1)?.accepted === false)
})

test('Ckpt only transitions when believed original state matches; activation ignores on ckpt input', () => {
  const flow = createFlow('sim-match')
  flow.nodes.a = makeNode('A')
  flow.nodes.b = makeNode('B')
  flow.entry.target = 'a'
  // Authoring still forbids ckpt→ckpt; inject a wire only to assert activation delivery is rejected at ckpt input.
  flow.logic = { links: [{ id: 'link_1', from: 'a', to: 'b', port: 'input' }] }
  let sim = createSimState(flow)
  sim = fireStart(flow, sim)
  assert.equal(ckptState(sim, 'a'), 'activated')
  assert.equal(ckptState(sim, 'b'), 'inactive')
  assert.ok(sim.log.some(item => item.to === 'b' && item.signal.kind === 'activation' && item.accepted === false))
  sim = fireCkptTransition(flow, sim, 'b', 'inactive', 'active')
  assert.equal(ckptState(sim, 'b'), 'active')
  sim = fireCkptTransition(flow, sim, 'b', 'inactive', 'activated')
  assert.equal(ckptState(sim, 'b'), 'active')
  sim = fireCkptTransition(flow, sim, 'b', 'active', 'activated')
  assert.equal(ckptState(sim, 'b'), 'activated')
})

test('Linear transition Parent A drives Next S and Goal A; Goal G closes and activates next ckpt', () => {
  let flow = createFlow('sim-linear')
  flow.nodes.parent = makeNode('父阶段')
  flow.nodes.child = makeNode('子阶段')
  flow.entry.target = 'parent'
  const linear = createTransitionNode(flow, { x: 300, y: 100 })
  const goal = createGoalNode(linear.flow, { x: 100, y: 100 })
  flow = connectNodes(goal.flow, 'parent', linear.id, 'input2').flow
  flow = connectNodes(flow, linear.id, 'child').flow
  flow = connectNodes(flow, goal.id, linear.id, 'input').flow
  assert.equal(errors(flow).length, 0)

  let sim = createSimState(flow)
  sim = fireStart(flow, sim)
  assert.equal(ckptState(sim, 'parent'), 'activated')
  assert.equal(ckptState(sim, 'child'), 'active')
  assert.equal(goalState(sim, goal.id), 'subscribed')
  assert.equal(GOAL_STATES[goalState(sim, goal.id)], '订阅中')
  assert.ok(sim.log.some(item => item.to === linear.id && item.port === 'input2' && item.signal.kind === 'activation' && item.accepted))
  assert.ok(sim.log.some(item => item.to === 'child' && item.signal.kind === 'ckpt-transition' && item.accepted))
  assert.ok(sim.log.some(item => item.to === goal.id && item.signal.kind === 'activation' && item.accepted))

  sim = fireGoalComplete(flow, sim, goal.id)
  assert.equal(goalState(sim, goal.id), 'closed')
  assert.equal(ckptState(sim, 'child'), 'activated')
  assert.ok(sim.log.some(item => item.to === linear.id && item.port === 'input' && item.signal.kind === 'goal-complete' && item.accepted))
  assert.ok(sim.log.some(item => item.to === goal.id && item.signal.kind === 'cancel' && item.accepted))
  assert.ok(sim.log.some(item => item.to === goal.id && item.signal.kind === 'query' && item.accepted))
  assert.ok(sim.log.some(item => item.to === linear.id && item.signal.kind === 'query-response' && item.accepted))

  const blocked = fireGoalComplete(flow, sim, goal.id)
  assert.equal(goalState(blocked, goal.id), 'closed')
  assert.ok(blocked.log.at(-1)?.accepted === false)
})

test('Goal cannot emit G before subscribe; Goal out is single-wire', () => {
  const linear = createTransitionNode(createFlow('goal-wire'), { x: 0, y: 0 })
  const other = createTransitionNode(linear.flow, { x: 80, y: 0 })
  const first = createGoalNode(other.flow, { x: 0, y: 0 })
  const second = createGoalNode(first.flow, { x: 40, y: 40 })
  let flow = connectNodes(second.flow, first.id, linear.id, 'input').flow
  flow = connectNodes(flow, second.id, linear.id, 'input').flow
  assert.equal(flow.logic!.links.filter(link => link.to === linear.id && link.port === 'input').length, 2)
  // Goal 出口仍是单线：改挂到另一变迁会拆掉旧线
  flow = connectNodes(flow, first.id, other.id, 'input').flow
  assert.equal(flow.logic!.links.filter(link => link.from === first.id).length, 1)
  assert.equal(flow.logic!.links.find(link => link.from === first.id)!.to, other.id)
  const sim = fireGoalComplete(flow, createSimState(flow), second.id)
  assert.equal(goalState(sim, second.id), 'inactive')
  assert.ok(sim.log.at(-1)?.reason?.includes('尚未订阅'))
})

test('Linear Goal conjunction waits for all closed Goals via C/C-R', () => {
  let flow = createFlow('sim-goal-and')
  flow.nodes.parent = makeNode('父阶段')
  flow.nodes.child = makeNode('子阶段')
  flow.entry.target = 'parent'
  const linear = createTransitionNode(flow, { x: 300, y: 100 })
  const g1 = createGoalNode(linear.flow, { x: 40, y: 40 })
  const g2 = createGoalNode(g1.flow, { x: 40, y: 120 })
  flow = connectNodes(g2.flow, 'parent', linear.id, 'input2').flow
  flow = connectNodes(flow, linear.id, 'child').flow
  flow = connectNodes(flow, g1.id, linear.id, 'input').flow
  flow = connectNodes(flow, g2.id, linear.id, 'input').flow
  assert.equal(errors(flow).length, 0)

  let sim = fireStart(flow, createSimState(flow))
  assert.equal(ckptState(sim, 'child'), 'active')
  assert.equal(goalState(sim, g1.id), 'subscribed')
  assert.equal(goalState(sim, g2.id), 'subscribed')

  sim = fireGoalComplete(flow, sim, g1.id)
  assert.equal(goalState(sim, g1.id), 'closed')
  assert.equal(goalState(sim, g2.id), 'subscribed')
  assert.equal(ckptState(sim, 'child'), 'active')
  assert.ok(sim.log.some(item => item.to === g1.id && item.signal.kind === 'query' && item.accepted))
  assert.ok(sim.log.some(item => item.to === g2.id && item.signal.kind === 'query' && !item.accepted))

  sim = fireGoalComplete(flow, sim, g2.id)
  assert.equal(goalState(sim, g2.id), 'closed')
  assert.equal(ckptState(sim, 'child'), 'activated')
  assert.ok(sim.log.some(item => item.to === linear.id && item.signal.kind === 'query-response' && item.accepted))
})

test('Simulator state syncs with graph edits and reset clears runtime', () => {
  const flow = createFlow('sim-sync')
  flow.nodes.a = makeNode('A')
  flow.entry.target = 'a'
  let sim = fireStart(flow, createSimState(flow))
  assert.equal(ckptState(sim, 'a'), 'activated')
  const added = createCheckpoint(flow, { x: 10, y: 10 })
  sim = syncSimState(sim, added.flow)
  assert.equal(ckptState(sim, 'a'), 'activated')
  assert.equal(ckptState(sim, added.id), 'inactive')
  const removed = removeNode(added.flow, 'a')
  sim = syncSimState(sim, removed)
  assert.equal(Object.hasOwn(sim.ckpt, 'a'), false)
  sim = resetSimState(added.flow)
  assert.equal(ckptState(sim, 'a'), 'inactive')
  assert.equal(ckptState(sim, added.id), 'inactive')
})

test('Unconnected start records a rejected pulse without mutating checkpoints', () => {
  const flow = createFlow('sim-open')
  flow.nodes.a = makeNode('A')
  const sim = fireStart(flow, createSimState(flow))
  assert.equal(ckptState(sim, 'a'), 'inactive')
  assert.equal(sim.pulse, 1)
  assert.equal(sim.log[0]?.accepted, false)
})

test('Merge node create, roundtrip, multi-in single-out cardinality', () => {
  const merge = createMergeNode(fixture(), { x: 200, y: 100 })
  assert.equal(merge.flow.merges![merge.id].title.text, '合并变迁')
  assert.deepEqual(inputPorts(merge.flow, merge.id), ['input'])
  assert.deepEqual(outputPorts(merge.flow, merge.id), ['output'])
  assert.deepEqual(parseFlow(JSON.stringify(merge.flow)).merges, merge.flow.merges)
  let flow = connectNodes(merge.flow, 'start', merge.id).flow
  flow = connectNodes(flow, 'node_1', merge.id).flow
  assert.equal(flow.logic!.links.filter(link => link.to === merge.id).length, 2)
  flow = connectNodes(flow, merge.id, 'node_2').flow
  const swapped = connectNodes(flow, merge.id, 'node_3').flow
  assert.equal(swapped.logic!.links.filter(link => link.from === merge.id).length, 1)
  assert.equal(swapped.logic!.links.find(link => link.from === merge.id)!.to, 'node_3')
  assert.equal(errors(swapped).length, 0)
  assert.throws(() => connectNodes(swapped, swapped.entry.id, merge.id), /端口/)
  assert.throws(() => connectNodes(swapped, merge.id, merge.id), /端口/)
})

test('Merge on A queries upstream; all C-R then emit S(活跃中→已激活)', () => {
  let flow = createFlow('sim-merge')
  flow.nodes.a = makeNode('A')
  flow.nodes.b = makeNode('B')
  flow.nodes.child = makeNode('Child')
  const merge = createMergeNode(flow, { x: 0, y: 0 })
  flow = connectNodes(merge.flow, 'a', merge.id).flow
  flow = connectNodes(flow, 'b', merge.id).flow
  flow = connectNodes(flow, merge.id, 'child').flow
  let sim = createSimState(flow)
  sim = fireCkptTransition(flow, sim, 'a', 'inactive', 'activated')
  sim = fireCkptTransition(flow, sim, 'b', 'inactive', 'activated')
  sim = propagateSignals(flow, sim, [{ from: 'a', to: merge.id, port: 'input', signal: { kind: 'activation' } }])
  assert.equal(ckptState(sim, 'child'), 'activated')
  assert.ok(sim.log.some(item => item.to === 'a' && item.port === 'output' && item.signal.kind === 'query' && item.accepted))
  assert.ok(sim.log.some(item => item.to === 'b' && item.signal.kind === 'query' && item.accepted))
  assert.ok(sim.log.some(item => item.to === merge.id && item.signal.kind === 'query-response' && item.accepted))
  assert.deepEqual(mergeSim(sim, merge.id), { awaiting: [], reported: [] })
})

test('Merge waits until every incoming wire returns C-R', () => {
  let flow = createFlow('sim-merge-partial')
  flow.nodes.a = makeNode('A')
  flow.nodes.b = makeNode('B')
  flow.nodes.child = makeNode('Child')
  const merge = createMergeNode(flow, { x: 0, y: 0 })
  flow = connectNodes(merge.flow, 'a', merge.id).flow
  flow = connectNodes(flow, 'b', merge.id).flow
  flow = connectNodes(flow, merge.id, 'child').flow
  let sim = createSimState(flow)
  sim = fireCkptTransition(flow, sim, 'a', 'inactive', 'activated')
  // b stays inactive → refuses C
  sim = propagateSignals(flow, sim, [{ from: 'a', to: merge.id, port: 'input', signal: { kind: 'activation' } }])
  assert.equal(ckptState(sim, 'child'), 'active')
  assert.ok(sim.log.some(item => item.to === 'b' && item.signal.kind === 'query' && item.accepted === false))
  assert.deepEqual(mergeSim(sim, merge.id).awaiting.sort(), ['a', 'b'])
  assert.deepEqual(mergeSim(sim, merge.id).reported, ['a'])
  // Activate b and re-fire A to start a fresh query round
  sim = fireCkptTransition(flow, sim, 'b', 'inactive', 'activated')
  sim = propagateSignals(flow, sim, [{ from: 'a', to: merge.id, port: 'input', signal: { kind: 'activation' } }])
  assert.equal(ckptState(sim, 'child'), 'activated')
})

test('Entering 已激活 emits S-C from S input; transitions forward S-C to A sources', () => {
  let flow = createFlow('sim-sc')
  flow.nodes.parent = makeNode('P')
  flow.nodes.child = makeNode('C')
  flow.entry.target = 'parent'
  const linear = createTransitionNode(flow, { x: 0, y: 0 })
  const goal = createGoalNode(linear.flow, { x: 40, y: 40 })
  flow = connectNodes(goal.flow, 'parent', linear.id, 'input2').flow
  flow = connectNodes(flow, linear.id, 'child').flow
  flow = connectNodes(flow, goal.id, linear.id, 'input').flow
  let sim = createSimState(flow)
  sim = fireStart(flow, sim)
  assert.equal(ckptState(sim, 'parent'), 'activated')
  assert.equal(ckptState(sim, 'child'), 'active')
  // parent 进入已激活时发出 S-C；无 S 入线（起点）则无处投递，child 仍活跃中
  assert.ok(sim.log.some(item => item.to === 'parent' && item.accepted && item.signal.kind === 'ckpt-transition' && item.signal.to === 'activated'))
  sim = fireCkptTransition(flow, sim, 'child', 'active', 'activated')
  assert.equal(ckptState(sim, 'child'), 'activated')
  // child → S-C → 线性变迁 Next → Parent 来源 parent（已激活，忽略）
  assert.ok(sim.log.some(item => item.to === linear.id && item.port === 'output' && item.signal.kind === 'cancel-cascade' && item.accepted))
  assert.ok(sim.log.some(item => item.to === 'parent' && item.signal.kind === 'cancel-cascade' && item.accepted === false))
  assert.equal(ckptState(sim, 'parent'), 'activated')
})

test('S-C cancels 活跃中 without forward; 未激活 only forwards and never cancels', () => {
  let flow = createFlow('sim-sc-cancel')
  flow.nodes.live = makeNode('Live')
  flow.nodes.idle = makeNode('Idle')
  flow.nodes.upstream = makeNode('Up')
  const linear = createTransitionNode(flow, { x: 0, y: 0 })
  // upstream → linear → idle；另用注入把 live 设为活跃中后直接喂 S-C
  flow = connectNodes(linear.flow, 'upstream', linear.id, 'input2').flow
  flow = connectNodes(flow, linear.id, 'idle').flow
  let sim = createSimState(flow)
  sim = fireCkptTransition(flow, sim, 'live', 'inactive', 'active')
  sim = propagateSignals(flow, sim, [{ from: null, to: 'live', port: 'input', signal: { kind: 'cancel-cascade' } }])
  assert.equal(ckptState(sim, 'live'), 'cancelled')
  assert.ok(!sim.log.some(item => item.from === 'live' && item.signal.kind === 'cancel-cascade' && item.accepted && item.to !== 'live'))

  // 入点收到 S-C：未激活不取消、不转发
  sim = propagateSignals(flow, sim, [{ from: linear.id, to: 'idle', port: 'input', signal: { kind: 'cancel-cascade' } }])
  assert.equal(ckptState(sim, 'idle'), 'inactive')
  assert.ok(sim.log.some(item => item.to === 'idle' && item.signal.kind === 'cancel-cascade' && item.accepted))
  assert.ok(!sim.log.some(item => item.to === linear.id && item.signal.kind === 'cancel-cascade' && item.from === 'idle'))
  assert.equal(ckptState(sim, 'upstream'), 'inactive')

  // 出点回灌 S-C：未激活只转发、不取消
  sim = propagateSignals(flow, sim, [{ from: null, to: 'idle', port: 'output', signal: { kind: 'cancel-cascade' } }])
  assert.equal(ckptState(sim, 'idle'), 'inactive')
  assert.ok(sim.log.some(item => item.to === linear.id && item.signal.kind === 'cancel-cascade' && item.accepted))
})

test('Active ckpt on S-C emits G-C; linear transition forwards D from Goal', () => {
  let flow = createFlow('sim-gc')
  flow.nodes.parent = makeNode('P')
  flow.nodes.child = makeNode('C')
  flow.entry.target = 'parent'
  const linear = createTransitionNode(flow, { x: 0, y: 0 })
  const goal = createGoalNode(linear.flow, { x: 40, y: 40 })
  flow = connectNodes(goal.flow, 'parent', linear.id, 'input2').flow
  flow = connectNodes(flow, linear.id, 'child').flow
  flow = connectNodes(flow, goal.id, linear.id, 'input').flow
  let sim = createSimState(flow)
  sim = fireStart(flow, sim)
  assert.equal(ckptState(sim, 'child'), 'active')
  assert.equal(goalState(sim, goal.id), 'subscribed')
  sim = propagateSignals(flow, sim, [{ from: null, to: 'child', port: 'input', signal: { kind: 'cancel-cascade' } }])
  assert.equal(ckptState(sim, 'child'), 'cancelled')
  assert.ok(sim.log.some(item => item.to === linear.id && item.port === 'output' && item.signal.kind === 'goal-cancel-cascade' && item.accepted))
  assert.ok(sim.log.some(item => item.to === goal.id && item.signal.kind === 'cancel' && item.accepted))
  assert.equal(goalState(sim, goal.id), 'closed')
})

test('Swap node defaults to one entry and auto-expands when last slot is used', () => {
  const swap = createSwapNode(fixture(), { x: 200, y: 100 })
  assert.equal(swap.flow.swaps![swap.id].title.text, '交换变迁')
  assert.equal(swap.flow.swaps![swap.id].entries, 1)
  assert.deepEqual(inputPorts(swap.flow, swap.id), ['in0'])
  assert.deepEqual(outputPorts(swap.flow, swap.id), ['out0'])
  assert.deepEqual(parseFlow(JSON.stringify(swap.flow)).swaps, swap.flow.swaps)
  let flow = connectNodes(swap.flow, 'start', swap.id, swapInPort(0)).flow
  assert.equal(flow.swaps![swap.id].entries, 2)
  assert.deepEqual(inputPorts(flow, swap.id), ['in0', 'in1'])
  flow = connectNodes(flow, 'node_1', swap.id, swapInPort(1)).flow
  assert.equal(flow.swaps![swap.id].entries, 3)
  flow = connectNodes(flow, swap.id, 'node_2', 'input', swapOutPort(0)).flow
  assert.equal(flow.logic!.links.find(link => link.from === swap.id)!.fromPort, 'out0')
  const replaced = connectNodes(flow, swap.id, 'node_3', 'input', swapOutPort(0)).flow
  assert.equal(replaced.logic!.links.filter(link => link.from === swap.id && link.fromPort === 'out0').length, 1)
  assert.equal(replaced.logic!.links.find(link => link.from === swap.id && link.fromPort === 'out0')!.to, 'node_3')
  assert.equal(errors(replaced).length, 0)
  const cut = disconnectLink(replaced, { kind: 'logic-link', id: replaced.logic!.links.find(link => link.to === swap.id && link.port === 'in1')!.id })
  assert.equal(cut.swaps![swap.id].entries, 2)
  assert.throws(() => connectNodes(cut, cut.entry.id, swap.id, swapInPort(0)), /端口/)
})

test('Swap on A emits S(未激活→已激活) on same entry and S-C on other entry inputs', () => {
  let flow = createFlow('sim-swap')
  flow.nodes.a = makeNode('A')
  flow.nodes.b = makeNode('B')
  flow.nodes.nextA = makeNode('NextA')
  flow.nodes.nextB = makeNode('NextB')
  const swap = createSwapNode(flow, { x: 0, y: 0 })
  flow = connectNodes(swap.flow, 'a', swap.id, swapInPort(0)).flow
  flow = connectNodes(flow, 'b', swap.id, swapInPort(1)).flow
  flow = connectNodes(flow, swap.id, 'nextA', 'input', swapOutPort(0)).flow
  flow = connectNodes(flow, swap.id, 'nextB', 'input', swapOutPort(1)).flow
  assert.equal(flow.swaps![swap.id].entries, 3)
  let sim = createSimState(flow)
  sim = propagateSignals(flow, sim, [{ from: 'a', to: swap.id, port: swapInPort(0), signal: { kind: 'activation' } }])
  assert.equal(ckptState(sim, 'nextA'), 'activated')
  assert.equal(ckptState(sim, 'nextB'), 'inactive')
  assert.ok(sim.log.some(item => item.to === 'nextA' && item.accepted && item.signal.kind === 'ckpt-transition' && item.signal.from === 'inactive' && item.signal.to === 'activated'))
  assert.ok(sim.log.some(item => item.to === 'b' && item.accepted && item.signal.kind === 'cancel-cascade'))
  // 未激活 ckpt 遇 S-C（出点回灌）只转发、不取消
  assert.equal(ckptState(sim, 'b'), 'inactive')
})

test('Diff node G-Y activates success path; G-N sends S-C on success and activates fail path', () => {
  let flow = createFlow('sim-diff')
  flow.nodes.parent = makeNode('P')
  flow.nodes.ok = makeNode('Ok')
  flow.nodes.fail = makeNode('Fail')
  flow.entry.target = 'parent'
  const diff = createDiffNode(flow, { x: 0, y: 0 })
  const goal = createGoalNode(diff.flow, { x: 40, y: 40 })
  flow = connectNodes(goal.flow, 'parent', diff.id, 'input2').flow
  flow = connectNodes(flow, goal.id, diff.id, 'input').flow
  flow = connectNodes(flow, diff.id, 'ok', 'input', 'output').flow
  flow = connectNodes(flow, diff.id, 'fail', 'input', 'output2').flow
  assert.equal(errors(flow).length, 0)
  assert.deepEqual(outputPorts(flow, diff.id), ['output', 'output2'])
  assert.deepEqual(parseFlow(JSON.stringify(flow)).diffs, flow.diffs)

  let sim = fireStart(flow, createSimState(flow))
  assert.equal(ckptState(sim, 'ok'), 'active')
  assert.equal(ckptState(sim, 'fail'), 'inactive')
  assert.equal(goalState(sim, goal.id), 'subscribed')

  sim = fireGoalYes(flow, sim, goal.id)
  assert.equal(goalState(sim, goal.id), 'closed')
  assert.equal(ckptState(sim, 'ok'), 'activated')
  assert.equal(ckptState(sim, 'fail'), 'inactive')
})

test('Diff G-N cancels active success via input S-C without cascade; activates fail', () => {
  let flow = createFlow('sim-diff-no')
  flow.nodes.parent = makeNode('P')
  flow.nodes.ok = makeNode('Ok')
  flow.nodes.fail = makeNode('Fail')
  flow.entry.target = 'parent'
  const diff = createDiffNode(flow, { x: 0, y: 0 })
  const goal = createGoalNode(diff.flow, { x: 40, y: 40 })
  flow = connectNodes(goal.flow, 'parent', diff.id, 'input2').flow
  flow = connectNodes(flow, goal.id, diff.id, 'input').flow
  flow = connectNodes(flow, diff.id, 'ok', 'input', 'output').flow
  flow = connectNodes(flow, diff.id, 'fail', 'input', 'output2').flow
  let sim = fireStart(flow, createSimState(flow))
  assert.equal(ckptState(sim, 'ok'), 'active')
  sim = fireGoalNo(flow, sim, goal.id)
  assert.equal(goalState(sim, goal.id), 'closed')
  assert.equal(ckptState(sim, 'ok'), 'cancelled')
  assert.equal(ckptState(sim, 'fail'), 'activated')
  assert.ok(sim.log.some(item => item.to === 'ok' && item.port === 'input' && item.signal.kind === 'cancel-cascade' && item.accepted))
  // 入点 S-C 不继续转发
  assert.ok(!sim.log.some(item => item.from === 'ok' && item.signal.kind === 'cancel-cascade' && item.to === diff.id))
})

test('Diff success/fail outs forward S-C to Parent and D to Goal', () => {
  let flow = createFlow('sim-diff-sc')
  flow.nodes.parent = makeNode('P')
  flow.nodes.ok = makeNode('Ok')
  flow.nodes.fail = makeNode('Fail')
  const diff = createDiffNode(flow, { x: 0, y: 0 })
  const goal = createGoalNode(diff.flow, { x: 40, y: 40 })
  flow = connectNodes(goal.flow, 'parent', diff.id, 'input2').flow
  flow = connectNodes(flow, goal.id, diff.id, 'input').flow
  flow = connectNodes(flow, diff.id, 'ok', 'input', 'output').flow
  flow = connectNodes(flow, diff.id, 'fail', 'input', 'output2').flow
  let sim = createSimState(flow)
  sim = { ...sim, goals: { ...sim.goals, [goal.id]: 'subscribed' } }
  // 从成功出点回灌 S-C（Parent 仍未激活，故会接受并只转发）
  sim = propagateSignals(flow, sim, [{ from: 'ok', to: diff.id, port: 'output', signal: { kind: 'cancel-cascade' } }])
  assert.ok(sim.log.some(item => item.to === diff.id && item.port === 'output' && item.signal.kind === 'cancel-cascade' && item.accepted))
  assert.ok(sim.log.some(item => item.to === 'parent' && item.signal.kind === 'cancel-cascade' && item.accepted))
  assert.equal(ckptState(sim, 'parent'), 'inactive')
  assert.ok(sim.log.some(item => item.to === goal.id && item.signal.kind === 'cancel' && item.accepted))
  assert.equal(goalState(sim, goal.id), 'closed')

  // 失败出点同样转发
  sim = { ...createSimState(flow), goals: { [goal.id]: 'subscribed' } }
  sim = propagateSignals(flow, sim, [{ from: 'fail', to: diff.id, port: 'output2', signal: { kind: 'cancel-cascade' } }])
  assert.ok(sim.log.some(item => item.to === 'parent' && item.signal.kind === 'cancel-cascade' && item.accepted))
  assert.equal(goalState(sim, goal.id), 'closed')
})

test('Conditional node Predicate/Parent/Next are single-wire; Goal cannot connect', () => {
  const conditional = createConditionalNode(fixture(), { x: 0, y: 0 })
  const predicate = createPredicateNode(conditional.flow, { x: 40, y: 40 })
  const other = createPredicateNode(predicate.flow, { x: 40, y: 80 })
  const goal = createGoalNode(other.flow, { x: 80, y: 40 })
  assert.equal(conditional.flow.conditionals![conditional.id].title.text, '条件变迁')
  assert.equal(predicate.flow.predicates![predicate.id].title.text, '新谓词')
  assert.deepEqual(inputPorts(predicate.flow, conditional.id), ['input', 'input2'])
  assert.deepEqual(outputPorts(predicate.flow, conditional.id), ['output'])
  assert.ok(!canConnectNodes(goal.flow, goal.id, conditional.id, 'input'))
  let flow = connectNodes(goal.flow, predicate.id, conditional.id, 'input').flow
  flow = connectNodes(flow, 'start', conditional.id, 'input2').flow
  flow = connectNodes(flow, conditional.id, 'node_1').flow
  assert.equal(errors(flow).length, 0)
  // Predicate 口只保留一条线
  const replaced = connectNodes(flow, other.id, conditional.id, 'input').flow
  assert.equal(replaced.logic!.links.filter(link => link.to === conditional.id && link.port === 'input').length, 1)
  assert.equal(replaced.logic!.links.find(link => link.to === conditional.id && link.port === 'input')!.from, other.id)
  assert.deepEqual(parseFlow(JSON.stringify(replaced)).conditionals, replaced.conditionals)
  assert.deepEqual(parseFlow(JSON.stringify(replaced)).predicates, replaced.predicates)
})

test('Conditional Parent A activates Next and Predicate; P closes and activates next ckpt', () => {
  let flow = createFlow('sim-conditional')
  flow.nodes.parent = makeNode('P')
  flow.nodes.child = makeNode('C')
  flow.entry.target = 'parent'
  const conditional = createConditionalNode(flow, { x: 0, y: 0 })
  const predicate = createPredicateNode(conditional.flow, { x: 40, y: 40 })
  flow = connectNodes(predicate.flow, 'parent', conditional.id, 'input2').flow
  flow = connectNodes(flow, predicate.id, conditional.id, 'input').flow
  flow = connectNodes(flow, conditional.id, 'child').flow
  let sim = fireStart(flow, createSimState(flow))
  assert.equal(ckptState(sim, 'child'), 'active')
  assert.equal(predicateState(sim, predicate.id), 'subscribed')
  sim = firePredicateComplete(flow, sim, predicate.id)
  assert.equal(predicateState(sim, predicate.id), 'closed')
  assert.equal(ckptState(sim, 'child'), 'activated')
})

test('Predicate cannot emit P before subscribe; out is single-wire', () => {
  const conditional = createConditionalNode(createFlow('pred-wire'), { x: 0, y: 0 })
  const other = createConditionalNode(conditional.flow, { x: 80, y: 0 })
  const first = createPredicateNode(other.flow, { x: 0, y: 0 })
  const second = createPredicateNode(first.flow, { x: 40, y: 40 })
  let flow = connectNodes(second.flow, first.id, conditional.id, 'input').flow
  flow = connectNodes(flow, first.id, other.id, 'input').flow
  assert.equal(flow.logic!.links.filter(link => link.from === first.id).length, 1)
  assert.equal(flow.logic!.links.find(link => link.from === first.id)!.to, other.id)
  let sim = createSimState(flow)
  sim = firePredicateComplete(flow, sim, first.id)
  assert.ok(sim.log.some(item => item.from === first.id && item.signal.kind === 'predicate-complete' && !item.accepted))
})

console.log(`Progress model: ${passed} checks passed.`)
