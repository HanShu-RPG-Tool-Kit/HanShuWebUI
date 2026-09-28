import assert from 'node:assert/strict'
import { addNode, canConnectNodes, clone, connectEntry, connectNodes, createFlow, descendants, disconnectLink, getCanvasNote, hasContentNode, inputPorts, makeNode, moveNode, parseFlow, removeNode, renameNode, reorderBranch, text, validateFlow, type ProgressFlow } from '../src/workspaces/progress/model.ts'
import { FLOW_STORAGE_KEY, createFlowDocument, importFlowDocument, loadFlowWorkspace, saveFlowWorkspace } from '../src/workspaces/progress/storage.ts'
import { addFlowFolder, moveFlowEntry, renameFlowEntry, uniqueDocumentName } from '../src/workspaces/progress/library.ts'
import { addNextCheckpoint, createCanvasNote, removeCanvasItems, updateCanvasNote, removeCanvasNote, groupCanvasNodes, moveCanvasNodes, nodeMetrics, createCheckpoint, createLogicNode, createGoalNode, createTransitionNode, layoutCanvas, moveCheckpoint, socketOffset, withCanvasPositions } from '../src/workspaces/progress/canvas.ts'
import { smartArrangeCanvas } from '../src/workspaces/progress/arrange.ts'
import { MAX_CANVAS_ZOOM, MIN_CANVAS_ZOOM, worldPoint, zoomCamera } from '../src/workspaces/progress/camera.ts'

let passed = 0
function test(name: string, check: () => void) { check(); passed++; console.log(`[OK] ${name}`) }
const errors = (f: ProgressFlow) => validateFlow(f).filter((i) => i.severity === 'error')
function fixture() {
  let flow = createFlow('story-progress', '驿站的约定')
  flow.nodes.start = makeNode('收到委托'); flow.entry.target = 'start'
  flow = addNode(flow, 'start').flow
  flow = addNode(flow, 'start').flow
  flow = addNode(flow, 'node_1').flow
  flow.nodes.start.branching = 'choice'
  flow.nodes.node_2.completion = 'finish'
  flow.nodes.node_3.completion = 'finish'
  flow.nodes.start.children[0].conditions.items.push({ id: 'ready', kind: 'nodes', title: text('等待准备'), params: {}, nodeRefs: ['start'] })
  return flow
}

test('A portable flow has ordered child references and no game fields', () => {
  const flow = fixture()
  assert.equal(errors(flow).length, 0)
  assert.deepEqual(flow.nodes.start.children.map((b) => b.target), ['node_1', 'node_2'])
  assert.equal(Object.hasOwn(flow, 'edges'), false)
  assert.equal(Object.hasOwn(flow, 'format_version'), false)
  assert.equal(Object.hasOwn(flow, 'checkpoints'), false)
})
test('Native document roundtrip keeps text keys and extension data', () => {
  const flow = fixture(); flow.title = { text: '原文', key: 'story.title' }; flow.extensions = { designer: { note: 'keep' } }
  assert.deepEqual(parseFlow(JSON.stringify(flow)), flow)
})
test('Mod quest JSON and unknown document versions are rejected', () => {
  assert.throws(() => parseFlow('{"format_version":1,"id":"demo:task","checkpoints":{},"edges":[]}'), /格式或版本/)
  assert.throws(() => parseFlow(JSON.stringify({ ...fixture(), version: 2 })), /格式或版本/)
})
test('Duplicate JSON keys cannot silently discard author content', () => {
  assert.throws(() => parseFlow('{"format":"hanshu.progress-tree","format":"other"}'), /重复/)
})
test('Malformed branch containers are rejected before a view uses them', () => {
  const v = clone(fixture()) as unknown as { nodes: { start: { children: unknown } } }
  v.nodes.start.children = null
  assert.throws(() => parseFlow(JSON.stringify(v)), /结构/)
})
test('Dangling references are reported; shared targets and cycles remain editable', () => {
  const missing = fixture(); missing.nodes.start.children[0].target = 'missing'
  assert(errors(missing).some((i) => i.message.includes('不存在')))
  const repeated = fixture(); repeated.nodes.start.children[1].target = 'node_1'
  assert.equal(errors(repeated).length, 0)
  const cycle = fixture(); cycle.nodes.node_3.completion = 'continue'
  cycle.nodes.node_3.children.push({ ...clone(cycle.nodes.start.children[0]), id: 'loop', target: 'start' })
  assert.equal(errors(cycle).length, 0)
  assert.equal(layoutCanvas(cycle).positions.size, Object.keys(cycle.nodes).length + 1)
})
test('An independent checkpoint is a valid draft without a finish marker', () => {
  const flow = createFlow('draft')
  assert.equal(errors(flow).length, 0)
  assert.equal(validateFlow(flow).length, 0)
})
test('Renaming the first checkpoint updates the independent entry connection and references', () => {
  const before = fixture(), after = renameNode(before, 'start', 'invitation')
  assert.equal(before.entry.target, 'start')
  assert.equal(after.entry.target, 'invitation')
  assert.equal(after.entry.id, before.entry.id)
  assert.deepEqual(after.nodes.invitation.children[0].conditions.items[0].nodeRefs, ['invitation'])
  assert.equal(errors(after).length, 0)
})
test('Renaming a node updates its parent child reference and preserves resources', () => {
  const flow = fixture(); flow.nodes.node_1.onEnter = [{ id: 'intro', reference: 'dialogue.intro', params: { speaker: 'guide' } }]
  const next = renameNode(flow, 'node_1', 'prepare')
  assert.equal(next.nodes.start.children[0].target, 'prepare')
  assert.deepEqual(next.nodes.prepare.onEnter, flow.nodes.node_1.onEnter)
  assert.throws(() => renameNode(next, 'prepare', 'constructor'))
  assert.throws(() => renameNode(next, 'prepare', 'node_2'))
})
test('Moving a subtree keeps branch IDs, conditions and descendants', () => {
  const flow = fixture(); flow.nodes.node_2.completion = 'continue'
  const branch = clone(flow.nodes.start.children[0])
  const moved = moveNode(flow, 'node_1', 'node_2')
  assert.deepEqual(moved.nodes.node_2.children[0], branch)
  assert.deepEqual([...descendants(moved, 'node_1')], ['node_1', 'node_3'])
  assert.equal(errors(moved).length, 0)
  assert.equal(flow.nodes.start.children.length, 2)
})
test('The entry is not a checkpoint; moves cannot create cycles or use finish parents', () => {
  const flow = fixture()
  assert.throws(() => moveNode(flow, flow.entry.id, 'node_1'))
  assert.throws(() => moveNode(flow, 'node_1', 'node_3'))
  assert.throws(() => moveNode(flow, 'node_1', 'node_2'))
})
test('Reordering changes only the ordered children, not stable identities', () => {
  const flow = fixture(), next = reorderBranch(flow, 'start', 'branch_1', 1)
  assert.deepEqual(next.nodes.start.children, [...flow.nodes.start.children].reverse())
  assert.deepEqual(flow.nodes.start.children.map((b) => b.id), ['branch_1', 'branch_2'])
})
test('Canvas connections preserve existing branch conditions, resources and positions', () => {
  const before = withCanvasPositions(fixture()), original = clone(before)
  const result = connectNodes(before, 'node_1', 'node_2')
  assert.deepEqual(before, original)
  assert.deepEqual(result.flow.layout, before.layout)
  assert.deepEqual(result.flow.nodes.start, before.nodes.start)
  assert.deepEqual(result.flow.nodes.node_1.children[0], before.nodes.node_1.children[0])
  assert.equal(result.flow.nodes.node_1.children[1].target, 'node_2')
  assert.equal(new Set(Object.values(result.flow.nodes).flatMap(node => node.children.map(branch => branch.id))).size, 4)
  assert.equal(errors(result.flow).length, 0)
  assert.deepEqual(parseFlow(JSON.stringify(result.flow)), result.flow)
  const duplicate = connectNodes(result.flow, 'node_1', 'node_2')
  assert.equal(duplicate.flow, result.flow)
  assert.deepEqual(duplicate.selection, result.selection)
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
test('Disconnecting a branch removes only that connection, preserving endpoint content and other branches', () => {
  const before = withCanvasPositions(fixture()), result = disconnectLink(before, { kind: 'branch', parent: 'start', id: 'branch_1' })
  assert.deepEqual(result.nodes.node_1, before.nodes.node_1)
  assert.deepEqual(result.nodes.start.children, [before.nodes.start.children[1]])
  assert.deepEqual(result.entry, before.entry)
  assert.deepEqual(result.layout, before.layout)
  assert.equal(before.nodes.start.children.length, 2)
  assert.equal(disconnectLink(result, { kind: 'branch', parent: 'start', id: 'branch_1' }), result)
})
test('Connections reject missing endpoints, entry inputs and finish outputs; cycles stay editable', () => {
  const flow = fixture()
  assert.throws(() => connectNodes(flow, 'missing', 'start'), /输出端口/)
  assert.throws(() => connectNodes(flow, 'start', 'missing'), /连接目标/)
  assert.throws(() => connectNodes(flow, 'start', flow.entry.id), /连接目标/)
  assert.throws(() => connectNodes(flow, 'node_2', 'start'), /输出端口/)
  const loop = connectNodes(flow, 'node_1', 'node_1')
  assert.equal(errors(loop.flow).length, 0)
  assert.equal(layoutCanvas(loop.flow).positions.size, 5)
})
test('Deleting one checkpoint preserves descendants, clearing only its references', () => {
  const flow = fixture()
  flow.nodes.start.children[1].conditions.items.push({ id: 'wait', kind: 'nodes', title: text(), params: {}, nodeRefs: ['node_1', 'node_3'] })
  const next = removeNode(flow, 'node_1')
  assert.deepEqual(Object.keys(next.nodes), ['start', 'node_2', 'node_3'])
  assert.deepEqual(next.nodes.start.children[0].conditions.items[0].nodeRefs, ['node_3'])
  assert.deepEqual(next.nodes.node_3, flow.nodes.node_3)
  assert.equal(errors(next).length, 0)
  assert.equal(Object.keys(flow.nodes).length, 4)
})
test('Deleting a referenced checkpoint surfaces an emptied wait condition', () => {
  const flow = fixture()
  flow.nodes.start.children[1].conditions.items.push({ id: 'wait', kind: 'nodes', title: text(), params: {}, nodeRefs: ['node_1'] })
  assert(errors(removeNode(flow, 'node_1')).some((i) => i.message.includes('至少一个')))
})
test('A new canvas has one immutable entry and freely created checkpoints', () => {
  const empty = createFlow('empty')
  assert.equal(removeNode(empty, empty.entry.id), empty)
  assert.deepEqual(empty.entry, { id: 'entry', target: null })
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
test('Missing entries and duplicate canvas identities cannot silently erase an entry', () => {
  const flow = createFlow('shape')
  assert.throws(() => parseFlow(JSON.stringify({ ...flow, entry: undefined })), /entry/)
  assert.throws(() => parseFlow(JSON.stringify({ ...flow, nodes: { [flow.entry.id]: makeNode() } })), /entry.id/)
  assert.throws(() => parseFlow(JSON.stringify({ ...flow, root: null })), /entry/)
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
test('Both logic nodes remain portable authoring content with independent positions', () => {
  let flow = withCanvasPositions(fixture())
  const original = clone(flow)
  for (const [index, operator] of (['and', 'or'] as const).entries()) {
    const added = createLogicNode(flow, operator, { x: 800, y: 100 + index * 200 })
    assert.equal(added.flow.logic!.nodes[added.id].operator, operator)
    assert.deepEqual(Object.keys(added.flow.logic!.nodes[added.id]), ['operator', 'title', 'description'])
    assert.deepEqual(added.flow.layout!.positions[added.id], { x: 800, y: 100 + index * 200 })
    assert.deepEqual(added.flow.nodes, original.nodes)
    flow = added.flow
  }
  assert.equal(layoutCanvas(flow).positions.size, 7)
  assert.equal(errors(flow).length, 0)
  assert.deepEqual(parseFlow(JSON.stringify(flow)), flow)
  assert.equal(original.logic, undefined)
})
test('Logic input ports allow multiple sources without changing checkpoint branches', () => {
  const conjunction = createLogicNode(fixture(), 'and', { x: 800, y: 100 })
  let flow = connectNodes(conjunction.flow, 'start', conjunction.id).flow
  flow = connectNodes(flow, 'node_1', conjunction.id).flow
  assert.deepEqual(flow.logic!.links.map(link => link.port), ['input', 'input'])
  assert.equal(connectNodes(flow, 'start', conjunction.id).flow, flow)
  assert.deepEqual(flow.nodes, conjunction.flow.nodes)
  assert.deepEqual(inputPorts(flow, conjunction.id), ['input'])
  assert.equal(socketOffset(flow, conjunction.id, 'output').y, socketOffset(flow, conjunction.id, 'input').y)
  assert.equal(errors(flow).length, 0)
  assert.deepEqual(parseFlow(JSON.stringify(flow)), flow)
})
test('Logic links can target checkpoints without rewriting their existing branches', () => {
  const added = createLogicNode(fixture(), 'or', { x: 800, y: 100 })
  const connected = connectNodes(added.flow, added.id, 'node_1')
  assert.deepEqual(connected.flow.nodes, added.flow.nodes)
  assert.equal(connected.selection.kind, 'logic-link')
  const disconnected = disconnectLink(connected.flow, connected.selection)
  assert.deepEqual(disconnected, added.flow)
  assert.equal(errors(connected.flow).length, 0)
})
test('Renaming and removing nodes maintain logic endpoints without removing unrelated content', () => {
  const first = createLogicNode(fixture(), 'and', { x: 800, y: 100 })
  const second = createLogicNode(first.flow, 'or', { x: 1100, y: 100 })
  let flow = connectNodes(second.flow, 'start', first.id).flow
  flow = connectNodes(flow, first.id, second.id).flow
  flow = connectNodes(flow, second.id, 'node_1').flow
  const renamed = renameNode(flow, 'start', 'invitation')
  assert.equal(renamed.logic!.links[0].from, 'invitation')
  assert.throws(() => renameNode(flow, 'start', first.id), /节点 ID/)
  const moved = moveCheckpoint(renamed, first.id, { x: 20, y: 600 })
  assert.deepEqual(moved.logic, renamed.logic)
  assert.deepEqual(moved.layout!.positions[second.id], renamed.layout!.positions[second.id])
  const removed = removeNode(connectEntry(moved, first.id), first.id)
  assert.equal(removed.entry.target, null)
  assert.equal(removed.logic!.nodes[first.id], undefined)
  assert.deepEqual(removed.logic!.nodes[second.id], flow.logic!.nodes[second.id])
  assert.deepEqual(removed.logic!.links, [flow.logic!.links[2]])
  assert.deepEqual(removed.nodes, renamed.nodes)
  assert.equal(removed.layout!.positions[first.id], undefined)
  assert.equal(removeNode(removed, removed.entry.id), removed)
  const checkpointRemoved = removeNode(removed, 'node_1')
  assert.deepEqual(checkpointRemoved.logic!.links, [])
  assert.equal(errors(checkpointRemoved).length, 0)
})
test('The entry can target logic and draft cycles or unused ports remain editable', () => {
  const added = createLogicNode(createFlow('logic-draft'), 'or', { x: 400, y: 100 })
  const connected = connectNodes(added.flow, added.flow.entry.id, added.id)
  assert.equal(connected.flow.entry.target, added.id)
  assert.equal(canConnectNodes(added.flow, added.flow.entry.id, added.id, 'input'), true)
  const loop = connectNodes(connected.flow, added.id, added.id)
  assert.equal(errors(loop.flow).length, 0)
  assert.equal(layoutCanvas(loop.flow).positions.size, 2)
  assert.equal(errors(disconnectLink(loop.flow, connected.selection)).length, 0)
})
test('Malformed logic operators, identities and ports cannot be silently accepted', () => {
  const added = createLogicNode(createFlow('logic-shape'), 'and', { x: 0, y: 0 })
  const invalidOperator = clone(added.flow)
  Reflect.set(invalidOperator.logic!.nodes[added.id], 'operator', 'not')
  assert.throws(() => parseFlow(JSON.stringify(invalidOperator)), /operator/)
  const collision = clone(added.flow)
  collision.nodes[added.id] = makeNode()
  assert.throws(() => parseFlow(JSON.stringify(collision)), /logic.nodes/)
  const badLink = clone(added.flow)
  badLink.logic!.links.push({ id: 'link', from: added.id, to: 'missing', port: 'input' })
  assert(errors(badLink).some(issue => issue.message.includes('端点')))
  badLink.logic!.links[0].to = added.id
  Reflect.set(badLink.logic!.links[0], 'port', 'b')
  assert(errors(badLink).some(issue => issue.message.includes('端口')))
  assert.throws(() => createLogicNode(added.flow, 'or', { x: Infinity, y: 0 }))
})

test('Bad condition declarations and resource references are reported', () => {
  const flow = fixture()
  flow.nodes.start.children[0].conditions.items = [{ id: 'count', kind: 'counter', title: text(), params: { event: '', target: 0 }, nodeRefs: [] }]
  flow.nodes.node_1.onEnter = [{ id: 'action', reference: '', params: {} }]
  assert(errors(flow).some((i) => i.message.includes('目标值')))
  assert(errors(flow).some((i) => i.message.includes('事件引用')))
  assert(errors(flow).some((i) => i.message.includes('资源引用')))
})
test('Flat storage supports deep trees without deeply nested document JSON', () => {
  let flow = createFlow('deep'), parent = flow.entry.id
  for (let n = 0; n < 600; n++) { const added = addNode(flow, parent); flow = added.flow; parent = added.id }
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
test('Workspace save and reload preserve logic names, positions and port connections', () => {
  const added = createLogicNode(fixture(), 'or', { x: 900, y: 300 })
  const flow = connectNodes(added.flow, 'start', added.id).flow
  flow.logic!.nodes[added.id].title = { text: '条件关系', key: 'logic.title' }
  const doc = createFlowDocument(flow)
  saveFlowWorkspace({ documents: [doc], folders: [], activeKey: doc.key })
  assert.deepEqual(parseFlow(loadFlowWorkspace().state.documents[0].source), flow)
})
test('Nested resource folders persist without changing flow content or active identity', () => {
  const doc = createFlowDocument(fixture()), empty = { documents: [doc], folders: [], activeKey: doc.key }
  const chapter = addFlowFolder(empty, '第一章', null), story = addFlowFolder(chapter.state, '支线', chapter.folder.key)
  const entry = { kind: 'document' as const, key: doc.key }
  const moved = moveFlowEntry(story.state, entry, story.folder.key), renamed = renameFlowEntry(moved, entry, '驿站')
  assert.equal(empty.documents[0].folderId, undefined)
  assert.equal(renamed.documents[0].source, doc.source)
  assert.equal(renamed.documents[0].name, '驿站.hflow')
  assert.equal(renamed.activeKey, doc.key)
  saveFlowWorkspace(renamed)
  assert.deepEqual(loadFlowWorkspace().state, renamed)
  assert.throws(() => moveFlowEntry(renamed, { kind: 'folder', key: chapter.folder.key }, story.folder.key), /子文件夹/)
  assert.equal(moveFlowEntry(renamed, entry, null).documents[0].folderId, null)
})
test('Resource name collisions are rejected and repeated imports receive distinct names', () => {
  const doc = { ...createFlowDocument(), name: '故事.hflow' }, state = { documents: [doc], folders: [], activeKey: doc.key }
  assert.throws(() => addFlowFolder(state, '故事.hflow', null), /同名/)
  assert.throws(() => renameFlowEntry(state, { kind: 'document', key: doc.key }, '../故事'), /有效名称/)
  assert.equal(uniqueDocumentName(state, '故事.hflow', null), '故事 (2).hflow')
  const folder = addFlowFolder(state, '章节', null)
  assert.equal(uniqueDocumentName(folder.state, '故事.hflow', folder.folder.key), '故事.hflow')
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
  const logic = createLogicNode(note.flow, 'and', { x: 500, y: -100 })
  const linked = connectNodes(logic.flow, 'start', logic.id).flow
  const grouped = groupCanvasNodes(linked, ['start', note.id, 'node_1']).flow, before = clone(grouped)
  const after = removeCanvasItems(grouped, [grouped.entry.id, 'start', 'start', note.id, logic.id, 'missing'])
  assert.equal(after.entry.id, before.entry.id)
  assert.equal(after.entry.target, null)
  assert.equal(after.nodes.start, undefined)
  assert.equal(getCanvasNote(after, note.id), undefined)
  assert.equal(after.logic!.nodes[logic.id], undefined)
  assert.deepEqual(after.logic!.links, [])
  assert.deepEqual(after.layout!.groups, {})
  for (const id of ['node_1', 'node_2', 'node_3']) {
    assert.deepEqual(after.nodes[id], before.nodes[id])
    assert.deepEqual(after.layout!.positions[id], before.layout!.positions[id])
  }
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
  const original = createLogicNode(createCanvasNote(arrangeFixture({ a: { x: 0, y: 10 } }), { x: 275, y: 0 }).flow, 'or', { x: 620, y: 7 })
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

test('Transition connections preserve both input identities and reject extra inputs on other nodes', () => {
  const added = createTransitionNode(fixture(), { x: 400, y: 100 })
  const goal = createGoalNode(added.flow, { x: 100, y: 240 })
  let flow = connectNodes(goal.flow, 'start', added.id, 'input').flow
  flow = connectNodes(flow, goal.id, added.id, 'input2').flow
  flow = connectNodes(flow, added.id, 'node_2').flow
  const secondFromSameSource = connectNodes(flow, 'start', added.id, 'input2')
  assert.equal(secondFromSameSource.flow.logic!.links.length, 4)
  assert.equal(connectNodes(flow, goal.id, added.id, 'input2').flow, flow)
  assert.deepEqual(flow.logic!.links.map(link => link.port), ['input', 'input2', 'input'])
  assert.deepEqual(flow.nodes, added.flow.nodes)
  assert.equal(errors(flow).length, 0)
  assert.deepEqual(parseFlow(JSON.stringify(flow)), flow)
  assert.throws(() => connectNodes(flow, added.id, 'node_1', 'input2'), /端口/)
  const cut = disconnectLink(flow, { kind: 'logic-link', id: flow.logic!.links[1].id })
  assert.equal(cut.logic!.links.length, 2)
  assert.equal(cut.logic!.links[0].port, 'input')
  const removed = removeCanvasItems(flow, [added.id])
  assert.equal(removed.transitions![added.id], undefined)
  assert.equal(removed.logic!.links.length, 0)
  assert.deepEqual(removed.nodes, added.flow.nodes)
})

test('Entry links retain the chosen transition input through reload, replacement and deletion', () => {
  const added = createTransitionNode(fixture(), { x: 400, y: 100 })
  const second = connectNodes(added.flow, added.flow.entry.id, added.id, 'input2').flow
  assert.equal(second.entry.port, 'input2')
  assert.deepEqual(parseFlow(JSON.stringify(second)), second)
  assert.equal(errors(second).length, 0)
  const first = connectNodes(second, second.entry.id, added.id, 'input').flow
  assert.equal(first.entry.target, added.id)
  assert.equal(first.entry.port, undefined)
  assert.equal(connectEntry(first, added.id), first)
  assert.equal(connectEntry(second, 'start').entry.port, undefined)
  assert.equal(disconnectLink(second, { kind: 'entry-link' }).entry.port, undefined)
  assert.equal(removeNode(second, added.id).entry.port, undefined)
  assert.equal(removeNode(second, added.id).entry.target, null)
  assert.throws(() => connectEntry(second, 'start', 'input2'), /输入端口/)
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

console.log(`Progress model: ${passed} checks passed.`)
