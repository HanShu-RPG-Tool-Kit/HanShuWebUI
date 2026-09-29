import assert from 'node:assert/strict'
import { addNode, clone, createFlow, descendants, moveNode, parseFlow, removeNode, renameNode, reorderBranch, text, validateFlow, type ProgressFlow } from '../src/workspaces/progress/model.ts'
import { FLOW_STORAGE_KEY, createFlowDocument, importFlowDocument, loadFlowWorkspace, saveFlowWorkspace } from '../src/workspaces/progress/storage.ts'

let passed = 0
function test(name: string, check: () => void) { check(); passed++; console.log(`[OK] ${name}`) }
const errors = (f: ProgressFlow) => validateFlow(f).filter((i) => i.severity === 'error')
function fixture() {
  let flow = createFlow('story-progress', '驿站的约定')
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
test('Dangling child references, duplicate parents and cycles are reported', () => {
  const missing = fixture(); missing.nodes.start.children[0].target = 'missing'
  assert(errors(missing).some((i) => i.message.includes('不存在')))
  const repeated = fixture(); repeated.nodes.start.children[1].target = 'node_1'
  assert(errors(repeated).some((i) => i.message.includes('父节点')))
  const cycle = fixture(); cycle.nodes.node_3.children.push({ ...clone(cycle.nodes.start.children[0]), id: 'loop', target: 'start' })
  assert(errors(cycle).some((i) => i.message.includes('起点')))
})
test('Unfinished leaves are design hints, not game-dependent export errors', () => {
  const flow = createFlow('draft')
  assert.equal(errors(flow).length, 0)
  assert(validateFlow(flow).some((i) => i.severity === 'warning'))
})
test('Renaming the root updates the root and condition references immutably', () => {
  const before = fixture(), after = renameNode(before, 'start', 'invitation')
  assert.equal(before.root, 'start')
  assert.equal(after.root, 'invitation')
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
test('Moves cannot put the root or a subtree under its descendant or a finish node', () => {
  const flow = fixture()
  assert.throws(() => moveNode(flow, 'start', 'node_1'))
  assert.throws(() => moveNode(flow, 'node_1', 'node_3'))
  assert.throws(() => moveNode(flow, 'node_1', 'node_2'))
})
test('Reordering changes only the ordered children, not stable identities', () => {
  const flow = fixture(), next = reorderBranch(flow, 'start', 'branch_1', 1)
  assert.deepEqual(next.nodes.start.children, [...flow.nodes.start.children].reverse())
  assert.deepEqual(flow.nodes.start.children.map((b) => b.id), ['branch_1', 'branch_2'])
})
test('Deleting a subtree clears references and surfaces an emptied wait condition', () => {
  const flow = fixture()
  flow.nodes.start.children[1].conditions.items.push({ id: 'wait', kind: 'nodes', title: text(), params: {}, nodeRefs: ['node_3'] })
  const next = removeNode(flow, 'node_1')
  assert.deepEqual(Object.keys(next.nodes), ['start', 'node_2'])
  assert.deepEqual(next.nodes.start.children[0].conditions.items[0].nodeRefs, [])
  assert(errors(next).some((i) => i.message.includes('至少一个')))
  assert.throws(() => removeNode(flow, 'start'))
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
  let flow = createFlow('deep'), parent = 'start'
  for (let n = 0; n < 600; n++) { const added = addNode(flow, parent); flow = added.flow; parent = added.id }
  assert.equal(Object.keys(parseFlow(JSON.stringify(flow)).nodes).length, 601)
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
  saveFlowWorkspace({ documents: [doc], activeKey: doc.key })
  assert.equal(loadFlowWorkspace().state.documents[0].source, doc.source)
  saveFlowWorkspace({ documents: [], activeKey: null })
  assert.deepEqual(loadFlowWorkspace().state, { documents: [], activeKey: null })
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
console.log(`Progress model: ${passed} checks passed.`)
