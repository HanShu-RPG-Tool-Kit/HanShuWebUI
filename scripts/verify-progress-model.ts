import assert from 'node:assert/strict'
import { addNode, canConnectNodes, clone, connectEntry, connectNodes, createFlow, descendants, disconnectLink, getCanvasNote, getHubNode, getGatewayNode, hasContentNode, inputPorts, linkSourcePort, makeNode, moveNode, outgoingCount, outputPorts, parseFlow, portKind, removeNode, renameNode, reorderBranch, text, validateFlow, type ProgressFlow } from '../src/workspaces/progress/model.ts'
import { FLOW_STORAGE_KEY, createFlowDocument, importFlowDocument, loadFlowWorkspace, saveFlowWorkspace } from '../src/workspaces/progress/storage.ts'
import { addFlowFolder, moveFlowEntry, renameFlowEntry, uniqueDocumentName } from '../src/workspaces/progress/library.ts'
import { addNextCheckpoint, createCanvasNote, removeCanvasItems, updateCanvasNote, removeCanvasNote, groupCanvasNodes, moveCanvasNodes, nodeMetrics, createCheckpoint, createLogicNode, createGoalNode, createTransitionNode, createHubNode, createGatewayNode, layoutCanvas, moveCheckpoint, socketOffset, withCanvasPositions } from '../src/workspaces/progress/canvas.ts'
import { smartArrangeCanvas } from '../src/workspaces/progress/arrange.ts'
import { MAX_CANVAS_ZOOM, MIN_CANVAS_ZOOM, worldPoint, zoomCamera } from '../src/workspaces/progress/camera.ts'

let passed = 0
function test(name: string, check: () => void) { check(); passed++; console.log(`[OK] ${name}`) }
const errors = (f: ProgressFlow) => validateFlow(f).filter((i) => i.severity === 'error')
function fixture() {
  const flow = createFlow('story-progress', '驿站的约定')
  flow.nodes.start = makeNode('收到委托'); flow.entry.target = 'start'
  flow.nodes.node_1 = makeNode('阶段 1')
  flow.nodes.node_2 = makeNode('阶段 2'); flow.nodes.node_2.completion = 'finish'
  flow.nodes.node_3 = makeNode('阶段 3'); flow.nodes.node_3.completion = 'finish'
  return flow
}
function linkViaTransition(flow: ProgressFlow, fromCkpt: string, toCkpt: string) {
  const added = createTransitionNode(flow, { x: 0, y: 0 })
  let next = connectNodes(added.flow, fromCkpt, added.id, 'input2').flow
  next = connectNodes(next, added.id, toCkpt).flow
  return { flow: next, id: added.id }
}
const strayBranch = (id: string, target: string, items: ProgressFlow['nodes'][string]['children'][number]['conditions']['items'] = []) => ({
  id, target, title: text(), trigger: 'automatic' as const, conditions: { mode: 'all' as const, items },
})

test('A portable flow has empty children and no game fields; routing uses transitions', () => {
  const flow = fixture()
  assert.equal(errors(flow).length, 0)
  for (const node of Object.values(flow.nodes)) assert.deepEqual(node.children, [])
  const linked = linkViaTransition(flow, 'start', 'node_1')
  assert.equal(linked.flow.logic!.links.length, 2)
  assert.equal(errors(linked.flow).length, 0)
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
test('Direct children fail validation; shared targets and cycles via transitions remain editable', () => {
  const missing = fixture(); missing.nodes.start.children = [strayBranch('branch_1', 'missing')]
  assert(errors(missing).some((i) => i.message.includes('直连')))
  assert(errors(missing).some((i) => i.message.includes('不存在')))
  const shared = linkViaTransition(linkViaTransition(fixture(), 'start', 'node_1').flow, 'start', 'node_1')
  assert.equal(errors(shared.flow).length, 0)
  assert.equal(shared.flow.logic!.links.filter(link => link.to === 'node_1').length, 2)
  const cycle = linkViaTransition(fixture(), 'start', 'start')
  assert.equal(errors(cycle.flow).length, 0)
  assert.equal(layoutCanvas(cycle.flow).positions.size, Object.keys(cycle.flow.nodes).length + Object.keys(cycle.flow.transitions!).length + 1)
})
test('An independent checkpoint is a valid draft without a finish marker', () => {
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
  const flow = fixture(); flow.nodes.node_1.onEnter = [{ id: 'intro', reference: 'dialogue.intro', params: { speaker: 'guide' } }]
  const linked = linkViaTransition(flow, 'start', 'node_1')
  const next = renameNode(linked.flow, 'node_1', 'prepare')
  assert.equal(next.logic!.links.find(link => link.to === 'prepare')!.to, 'prepare')
  assert.deepEqual(next.nodes.prepare.onEnter, flow.nodes.node_1.onEnter)
  assert.throws(() => renameNode(next, 'prepare', 'constructor'))
  assert.throws(() => renameNode(next, 'prepare', 'node_2'))
})
test('Direct checkpoint children fail validation while moveNode can still mutate them', () => {
  const flow = fixture(); flow.nodes.node_2.completion = 'continue'
  const branch = strayBranch('branch_1', 'node_1')
  flow.nodes.start.children = [clone(branch)]
  assert(errors(flow).some((i) => i.message.includes('直连')))
  const moved = moveNode(flow, 'node_1', 'node_2')
  assert.deepEqual(moved.nodes.node_2.children[0], branch)
  assert.deepEqual([...descendants(moved, 'node_1')], ['node_1'])
  assert(errors(moved).some((i) => i.message.includes('直连')))
  assert.equal(flow.nodes.start.children.length, 1)
})
test('The entry is not a checkpoint; moves cannot create cycles or use finish parents', () => {
  const flow = fixture()
  flow.nodes.start.children = [strayBranch('b1', 'node_1')]
  flow.nodes.node_1.children = [strayBranch('b2', 'node_3')]
  assert.throws(() => moveNode(flow, flow.entry.id, 'node_1'))
  assert.throws(() => moveNode(flow, 'node_1', 'node_3'))
  assert.throws(() => moveNode(flow, 'node_1', 'node_2'))
})
test('Reordering mutates children even though direct links are invalid', () => {
  const flow = fixture()
  flow.nodes.start.children = [strayBranch('branch_1', 'node_1'), strayBranch('branch_2', 'node_2')]
  const next = reorderBranch(flow, 'start', 'branch_1', 1)
  assert.deepEqual(next.nodes.start.children.map((b) => b.id), ['branch_2', 'branch_1'])
  assert.deepEqual(flow.nodes.start.children.map((b) => b.id), ['branch_1', 'branch_2'])
  assert(errors(next).some((i) => i.message.includes('直连')))
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
test('Connections reject missing endpoints, entry inputs, finish outputs and checkpoint直连', () => {
  const flow = fixture()
  assert.throws(() => connectNodes(flow, 'missing', 'start'), /端口/)
  assert.throws(() => connectNodes(flow, 'start', 'missing'), /连接目标/)
  assert.throws(() => connectNodes(flow, 'start', flow.entry.id), /连接目标/)
  assert.throws(() => connectNodes(flow, 'node_2', 'start'), /直连/)
  assert.throws(() => connectNodes(flow, 'node_1', 'node_1'), /直连/)
  const loop = linkViaTransition(flow, 'start', 'start')
  assert.equal(errors(loop.flow).length, 0)
  assert.equal(layoutCanvas(loop.flow).positions.size, Object.keys(loop.flow.nodes).length + Object.keys(loop.flow.transitions!).length + 1)
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
test('Deleting a referenced checkpoint surfaces an emptied wait condition', () => {
  const flow = fixture()
  flow.nodes.start.children = [strayBranch('branch_1', 'node_2', [{ id: 'wait', kind: 'nodes', title: text(), params: {}, nodeRefs: ['node_1'] }])]
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
  assert.throws(() => connectEntry(moved, first.id), /输入端口/)
  const removed = removeNode(moved, first.id)
  assert.equal(removed.entry.target, 'invitation')
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
test('The entry only targets checkpoints; logic drafts and unused ports remain editable', () => {
  const added = createLogicNode(createFlow('logic-draft'), 'or', { x: 400, y: 100 })
  assert.equal(canConnectNodes(added.flow, added.flow.entry.id, added.id, 'input'), false)
  assert.throws(() => connectNodes(added.flow, added.flow.entry.id, added.id), /端口/)
  const ckpt = createCheckpoint(added.flow, { x: 200, y: 100 })
  const connected = connectNodes(ckpt.flow, ckpt.flow.entry.id, ckpt.id)
  assert.equal(connected.flow.entry.target, ckpt.id)
  const loop = connectNodes(connected.flow, added.id, added.id)
  assert.equal(errors(loop.flow).length, 0)
  assert.equal(layoutCanvas(loop.flow).positions.size, 3)
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
  flow.nodes.start.children = [strayBranch('branch_1', 'node_1', [{ id: 'count', kind: 'counter', title: text(), params: { event: '', target: 0 }, nodeRefs: [] }])]
  flow.nodes.node_1.onEnter = [{ id: 'action', reference: '', params: {} }]
  assert(errors(flow).some((i) => i.message.includes('直连')))
  assert(errors(flow).some((i) => i.message.includes('目标值')))
  assert(errors(flow).some((i) => i.message.includes('事件引用')))
  assert(errors(flow).some((i) => i.message.includes('资源引用')))
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

test('Transition connections match Goals / Parent / Next types and replace exclusive ports', () => {
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
  flow = connectNodes(flow, secondGoal.id, added.id, 'input').flow
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
  assert.equal(connectNodes(flow, goal.id, added.id, 'input').flow, flow)
  assert.deepEqual(flow.logic!.links.map(link => link.port).sort(), ['input', 'input', 'input', 'input2'])
  assert.deepEqual(flow.nodes, added.flow.nodes)
  assert.equal(errors(flow).length, 0)
  assert.deepEqual(parseFlow(JSON.stringify(flow)), flow)
  assert.throws(() => connectNodes(flow, added.id, goal.id), /端口/)
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
  const logic = createLogicNode(second.flow, 'or', { x: 100, y: 400 })
  let flow = connectNodes(logic.flow, 'start', first.id, 'input2').flow
  flow = connectNodes(flow, 'start', second.id, 'input2').flow
  assert.equal(flow.logic!.links.filter(link => link.from === 'start' && link.port === 'input2').length, 2)
  assert.ok(outgoingCount(flow, 'start') >= 2)
  flow = connectNodes(flow, first.id, 'node_1').flow
  flow = connectNodes(flow, second.id, 'node_1').flow
  flow = connectNodes(flow, logic.id, 'node_1').flow
  assert.equal(flow.logic!.links.filter(link => link.to === 'node_1').length, 3)
  assert.equal(flow.nodes.start.children.length, 0)
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

test('Hub and gateway create, roundtrip, and metrics', () => {
  const hub = createHubNode(fixture(), { x: 120, y: 80 })
  const gateway = createGatewayNode(hub.flow, { x: 320, y: 80 })
  assert.ok(getHubNode(gateway.flow, hub.id))
  assert.ok(getGatewayNode(gateway.flow, gateway.id))
  assert.deepEqual(inputPorts(gateway.flow, hub.id), ['input'])
  assert.deepEqual(inputPorts(gateway.flow, gateway.id), ['input', 'input2'])
  assert.deepEqual(outputPorts(gateway.flow, hub.id), ['output', 'output2'])
  assert.deepEqual(outputPorts(gateway.flow, gateway.id), ['output'])
  assert.equal(portKind(gateway.flow, hub.id, 'input'), 'checkpoint')
  assert.equal(portKind(gateway.flow, hub.id, 'output'), 'checkpoint')
  assert.equal(portKind(gateway.flow, hub.id, 'output2'), 'bridge')
  assert.equal(portKind(gateway.flow, gateway.id, 'input'), 'checkpoint')
  assert.equal(portKind(gateway.flow, gateway.id, 'input2'), 'bridge')
  assert.equal(portKind(gateway.flow, gateway.id, 'output'), 'checkpoint')
  assert.equal(nodeMetrics(gateway.flow, hub.id).width, 180)
  assert.equal(nodeMetrics(gateway.flow, gateway.id).height, 108)
  assert.deepEqual(socketOffset(gateway.flow, hub.id, 'output'), { x: 180, y: 58 })
  assert.deepEqual(socketOffset(gateway.flow, hub.id, 'output2'), { x: 180, y: 86 })
  assert.deepEqual(socketOffset(gateway.flow, gateway.id, 'input'), { x: 0, y: 58 })
  assert.deepEqual(socketOffset(gateway.flow, gateway.id, 'input2'), { x: 0, y: 86 })
  const restored = parseFlow(JSON.stringify(gateway.flow))
  assert.deepEqual(restored.hubs, gateway.flow.hubs)
  assert.deepEqual(restored.gateways, gateway.flow.gateways)
  assert.equal(errors(restored).length, 0)
  assert.ok(layoutCanvas(restored).positions.has(hub.id))
  assert.ok(layoutCanvas(restored).positions.has(gateway.id))
})

test('Hub and gateway connection rules and cardinalities', () => {
  const hub = createHubNode(fixture(), { x: 200, y: 100 })
  const gateway = createGatewayNode(hub.flow, { x: 420, y: 100 })
  const t1 = createTransitionNode(gateway.flow, { x: 300, y: 40 })
  const t2 = createTransitionNode(t1.flow, { x: 300, y: 180 })
  let flow = t2.flow
  assert.equal(canConnectNodes(flow, flow.entry.id, hub.id, 'input'), true)
  assert.equal(canConnectNodes(flow, 'start', hub.id, 'input'), true)
  assert.equal(canConnectNodes(flow, hub.id, t1.id, 'input2', 'output'), true)
  assert.equal(canConnectNodes(flow, hub.id, gateway.id, 'input', 'output'), false)
  assert.equal(canConnectNodes(flow, hub.id, gateway.id, 'input2', 'output'), false)
  assert.equal(canConnectNodes(flow, hub.id, gateway.id, 'input2', 'output2'), true)
  assert.equal(canConnectNodes(flow, t1.id, gateway.id, 'input'), true)
  assert.equal(canConnectNodes(flow, t1.id, gateway.id, 'input2'), false)
  assert.equal(canConnectNodes(flow, gateway.id, 'node_1', 'input'), true)
  assert.equal(canConnectNodes(flow, gateway.id, hub.id, 'input'), false)
  assert.equal(canConnectNodes(flow, hub.id, 'node_1', 'input'), false)
  assert.equal(canConnectNodes(flow, 'start', gateway.id, 'input'), false)
  assert.equal(canConnectNodes(flow, flow.entry.id, gateway.id, 'input'), false)

  flow = connectNodes(flow, 'start', hub.id, 'input').flow
  assert.equal(flow.logic!.links.filter(link => link.to === hub.id).length, 1)
  flow = connectNodes(flow, flow.entry.id, hub.id, 'input').flow
  assert.equal(flow.entry.target, hub.id)
  assert.equal(flow.logic!.links.filter(link => link.to === hub.id).length, 0)

  flow = connectNodes(flow, hub.id, t1.id, 'input2', 'output').flow
  flow = connectNodes(flow, hub.id, t2.id, 'input2', 'output').flow
  assert.equal(flow.logic!.links.filter(link => link.from === hub.id && link.port === 'input2' && getGatewayNode(flow, link.to) === undefined).length, 2)

  flow = connectNodes(flow, t1.id, gateway.id).flow
  flow = connectNodes(flow, t2.id, gateway.id).flow
  assert.equal(flow.logic!.links.filter(link => link.to === gateway.id && link.port === 'input' && (link.from === t1.id || link.from === t2.id)).length, 2)

  assert.throws(() => connectNodes(flow, hub.id, gateway.id), /端口/)
  assert.throws(() => connectNodes(flow, hub.id, gateway.id, 'input', 'output2'), /端口/)
  flow = connectNodes(flow, hub.id, gateway.id, 'input2', 'output2').flow
  assert.equal(flow.logic!.links.filter(link => link.from === hub.id && link.to === gateway.id && link.port === 'input2').length, 1)
  assert.equal(linkSourcePort(flow, hub.id, gateway.id, 'input2'), 'output2')
  assert.equal(flow.logic!.links.filter(link => link.from === hub.id && link.port === 'input2').length, 3)
  const otherHub = createHubNode(flow, { x: 200, y: 260 })
  const otherGateway = createGatewayNode(otherHub.flow, { x: 420, y: 260 })
  flow = connectNodes(otherGateway.flow, otherHub.id, gateway.id, 'input2', 'output2').flow
  assert.equal(flow.logic!.links.filter(link => link.from === hub.id && link.to === gateway.id).length, 0)
  assert.equal(flow.logic!.links.filter(link => link.from === otherHub.id && link.to === gateway.id && link.port === 'input2').length, 1)
  flow = connectNodes(flow, otherHub.id, otherGateway.id, 'input2', 'output2').flow
  assert.equal(flow.logic!.links.filter(link => link.from === otherHub.id && link.to === gateway.id).length, 0)
  assert.equal(flow.logic!.links.filter(link => link.from === otherHub.id && link.to === otherGateway.id && link.port === 'input2').length, 1)

  flow = connectNodes(flow, gateway.id, 'node_1').flow
  assert.equal(flow.logic!.links.find(link => link.from === gateway.id)!.to, 'node_1')
  flow = connectNodes(flow, gateway.id, 'node_2').flow
  assert.equal(flow.logic!.links.filter(link => link.from === gateway.id).length, 1)
  assert.equal(flow.logic!.links.find(link => link.from === gateway.id)!.to, 'node_2')
  assert.equal(errors(flow).length, 0)

  assert.throws(() => connectNodes(flow, gateway.id, otherHub.id), /端口/)
  assert.throws(() => connectNodes(flow, otherHub.id, 'node_1'), /端口/)
  const removed = removeNode(flow, otherHub.id)
  assert.equal(removed.hubs![otherHub.id], undefined)
  assert.ok(!removed.logic!.links.some(link => link.from === otherHub.id || link.to === otherHub.id))
})

test('Hub/gateway identity collisions and malformed content are rejected', () => {
  const hub = createHubNode(fixture(), { x: 0, y: 0 })
  const collision = clone(hub.flow)
  collision.hubs!.start = collision.hubs![hub.id]
  assert.throws(() => parseFlow(JSON.stringify(collision)), /hubs/)
  const gateway = createGatewayNode(hub.flow, { x: 40, y: 40 })
  const bad = clone(gateway.flow)
  Reflect.set(bad.gateways![gateway.id], 'description', 1)
  assert.throws(() => parseFlow(JSON.stringify(bad)), /gateways/)
})

console.log(`Progress model: ${passed} checks passed.`)
