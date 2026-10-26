import assert from 'node:assert/strict'
import { canConnectNodes, connectedToStart, connectNodes, createFlow, disconnectLink, findCanvasCycle, getEndNode, getPredicateNode, getTransitionNode, hasContentNode, inputPorts, isStartNode, outputPorts, parseFlow, removeNode, validateFlow, type ProgressFlow } from '../src/workspaces/gameplay/model.ts'
import { createCanvasNote, createEndNode, createPredicateNode, createProgressNode, createTransitionNode, groupCanvasNodes, layoutCanvas, moveCanvasNodes, nodeMetrics, removeCanvasItems, updateCanvasNote } from '../src/workspaces/gameplay/canvas.ts'
import { createSimState, endOutcome, initializeQuest, injectSignal, predicateTruth, progressState, resetSimState, setPredicateTruth, settleProgress, transitionRound } from '../src/workspaces/gameplay/signals.ts'
import { MAX_CANVAS_ZOOM, MIN_CANVAS_ZOOM, worldPoint, zoomCamera } from '../src/nodeEditor/camera.ts'
import { FLOW_STORAGE_KEY, createFlowDocument, importFlowDocument, loadFlowWorkspace, saveFlowWorkspace } from '../src/workspaces/gameplay/storage.ts'
import { addFlowFolder, moveFlowEntry, renameFlowEntry, uniqueDocumentName } from '../src/workspaces/gameplay/library.ts'

let passed = 0
const pending: Promise<void>[] = []
function test(name: string, check: () => void | Promise<void>) {
  const result = check()
  const success = () => { passed++; console.log(`[OK] ${name}`) }
  if (result instanceof Promise) pending.push(result.then(success)); else success()
}
const errors = (f: ProgressFlow) => validateFlow(f).filter(i => i.severity === 'error')
const A = { kind: 'activate' } as const
const C = { kind: 'cancel' } as const

/** 开始进度 → t1 → p2，另给开始配一个失败去向。 */
function chain() {
  let flow = createFlow('chain')
  const start = flow.start
  const t1 = createTransitionNode(flow, { x: 400, y: 0 }); flow = t1.flow
  const p2 = createProgressNode(flow, { x: 700, y: 0 }); flow = p2.flow
  flow = connectNodes(flow, start, t1.id, 'input', 'output').flow
  flow = connectNodes(flow, t1.id, p2.id, 'input', 'output').flow
  return { flow, start, t1: t1.id, p2: p2.id }
}

test('v2 文档：开始进度 / 进度 / 谓词 / 变迁 / 结束 可解析并往返', () => {
  const base = chain()
  const predicate = createPredicateNode(base.flow, { x: 200, y: 300 }); let flow = predicate.flow
  const end = createEndNode(flow, { x: 900, y: 0 }); flow = end.flow
  flow = connectNodes(flow, base.p2, end.id, 'input', 'output').flow
  flow = connectNodes(flow, base.p2, end.id, 'input2', 'output2').flow
  assert.deepEqual(parseFlow(JSON.stringify(flow)), flow)
  assert.equal(parseFlow(JSON.stringify(flow)).progress[base.start].title.text, `progress.${base.start}.title`)
  assert.ok(getPredicateNode(flow, predicate.id))
  assert.ok(getTransitionNode(flow, base.t1))
  assert.ok(getEndNode(flow, end.id))
  assert.equal(errors(flow).length, 0)
})

test('旧草稿字段直接报错，不做迁移', () => {
  const flow = createFlow('legacy')
  assert.throws(() => parseFlow(JSON.stringify({ ...flow, entry: { id: 'entry' } })), /旧草稿/)
  assert.throws(() => parseFlow(JSON.stringify({ ...flow, nodes: {} })), /旧草稿/)
  assert.throws(() => parseFlow(JSON.stringify({ ...flow, start: 'missing' })), /开始进度节点不存在/)
  assert.throws(() => parseFlow(JSON.stringify({ ...flow, version: 2 })), /格式或版本/)
})

test('新建任务只有一个开始进度节点：无左端口、有成功/失败出口、不可删除', () => {
  const flow = createFlow('new')
  assert.equal(Object.keys(flow.progress).length, 1)
  assert.equal(flow.start, 'progress_start')
  assert.equal(isStartNode(flow, flow.start), true)
  assert.deepEqual(inputPorts(flow, flow.start), [])
  assert.deepEqual(outputPorts(flow, flow.start), ['output', 'output2'])
  assert.equal(removeNode(flow, flow.start), flow)
  assert.equal(hasContentNode(flow, flow.start), true)
})

test('端口表：普通进度 1 入 2 出、变迁 2 入 1 出、结束 2 入、谓词无入', () => {
  let flow = createFlow('ports')
  const p = createProgressNode(flow, { x: 0, y: 0 }); flow = p.flow
  const t = createTransitionNode(flow, { x: 0, y: 0 }); flow = t.flow
  const e = createEndNode(flow, { x: 0, y: 0 }); flow = e.flow
  const q = createPredicateNode(flow, { x: 0, y: 0 }); flow = q.flow
  assert.deepEqual(inputPorts(flow, p.id), ['input'])
  assert.deepEqual(outputPorts(flow, p.id), ['output', 'output2'])
  assert.deepEqual(inputPorts(flow, t.id), ['input', 'input2'])
  assert.deepEqual(outputPorts(flow, t.id), ['output'])
  assert.deepEqual(inputPorts(flow, e.id), ['input', 'input2'])
  assert.deepEqual(outputPorts(flow, e.id), [])
  assert.deepEqual(inputPorts(flow, q.id), [])
  assert.deepEqual(outputPorts(flow, q.id), ['output'])
})

test('唯一连接约束：右端口 → 左端口，且拒绝自环与成环', () => {
  let flow = createFlow('rules')
  const a = createProgressNode(flow, { x: 0, y: 0 }); flow = a.flow
  const b = createProgressNode(flow, { x: 300, y: 0 }); flow = b.flow
  const t = createTransitionNode(flow, { x: 600, y: 0 }); flow = t.flow
  flow = connectNodes(flow, flow.start, a.id, 'input', 'output').flow
  flow = connectNodes(flow, a.id, b.id, 'input', 'output').flow
  assert.throws(() => connectNodes(flow, b.id, a.id, 'input', 'output'), /成环/)
  assert.throws(() => connectNodes(flow, a.id, a.id, 'input', 'output'), /成环|右端口/)
  assert.throws(() => connectNodes(flow, b.id, flow.start, 'input', 'output'))
  assert.equal(canConnectNodes(flow, t.id, a.id, 'input'), true, '变迁的右端口可以接普通进度的左端口')
  assert.equal(canConnectNodes(flow, a.id, t.id, 'input2', 'output2'), true)
  assert.equal(canConnectNodes(flow, flow.start, b.id, 'input'), true, '开始进度也有右端口')
})

test('成功链：开始运行中 → 结算成功 → 变迁放行 → 下一进度运行中', () => {
  const { flow, start, p2 } = chain()
  let sim = createSimState(flow)
  sim = initializeQuest(flow, sim)
  assert.equal(progressState(sim, start), 'running')
  assert.equal(progressState(sim, p2), 'inactive')
  sim = settleProgress(flow, sim, start, 'succeeded')
  assert.equal(progressState(sim, start), 'succeeded')
  assert.equal(progressState(sim, p2), 'running')
})

test('进度激活时向左端口发 C，消费上游', () => {
  let flow = createFlow('consume')
  const up = createProgressNode(flow, { x: 300, y: 0 }); flow = up.flow
  const t = createTransitionNode(flow, { x: 600, y: 0 }); flow = t.flow
  const p = createProgressNode(flow, { x: 900, y: 0 }); flow = p.flow
  flow = connectNodes(flow, flow.start, up.id, 'input', 'output').flow
  flow = connectNodes(flow, up.id, t.id, 'input', 'output').flow
  flow = connectNodes(flow, t.id, p.id, 'input', 'output').flow
  let sim = initializeQuest(flow, createSimState(flow))
  sim = settleProgress(flow, sim, flow.start, 'succeeded')
  assert.equal(progressState(sim, up.id), 'running')
  sim = settleProgress(flow, sim, up.id, 'succeeded')
  assert.equal(progressState(sim, p.id), 'running')
  assert.ok(sim.log.some(item => item.signal.kind === 'cancel' && item.from === p.id && item.accepted), '激活后向左端口发 C')
  assert.ok(sim.log.some(item => item.signal.kind === 'cancel' && item.from === t.id), 'C 继续向上游转发')
})

test('失败口：结算失败只走失败边；成功边不触发', () => {
  let flow = createFlow('failure')
  const start = flow.start
  const ok = createProgressNode(flow, { x: 300, y: 0 }); flow = ok.flow
  const bad = createProgressNode(flow, { x: 300, y: 240 }); flow = bad.flow
  flow = connectNodes(flow, start, ok.id, 'input', 'output').flow
  flow = connectNodes(flow, start, bad.id, 'input', 'output2').flow
  let sim = initializeQuest(flow, createSimState(flow))
  sim = settleProgress(flow, sim, start, 'failed')
  assert.equal(progressState(sim, ok.id), 'inactive')
  assert.equal(progressState(sim, bad.id), 'running')
})

test('合取：两个进度都成功才放行；先到的成功会被新的一轮重新问到', () => {
  let flow = createFlow('conjunction')
  const start = flow.start
  const a = createProgressNode(flow, { x: 300, y: 0 }); flow = a.flow
  const b = createProgressNode(flow, { x: 300, y: 200 }); flow = b.flow
  const t = createTransitionNode(flow, { x: 600, y: 90 }); flow = t.flow
  const next = createProgressNode(flow, { x: 900, y: 90 }); flow = next.flow
  flow = connectNodes(flow, start, a.id, 'input', 'output').flow
  flow = connectNodes(flow, start, b.id, 'input', 'output').flow
  flow = connectNodes(flow, a.id, t.id, 'input', 'output').flow
  flow = connectNodes(flow, b.id, t.id, 'input', 'output').flow
  flow = connectNodes(flow, t.id, next.id, 'input', 'output').flow
  let sim = initializeQuest(flow, createSimState(flow))
  sim = settleProgress(flow, sim, start, 'succeeded')
  assert.equal(progressState(sim, a.id), 'running')
  assert.equal(progressState(sim, b.id), 'running')
  sim = settleProgress(flow, sim, a.id, 'succeeded')
  assert.equal(progressState(sim, next.id), 'inactive')
  sim = settleProgress(flow, sim, b.id, 'succeeded')
  assert.equal(progressState(sim, next.id), 'running')
  assert.equal(transitionRound(sim, t.id).open, false)
})

test('析取：任一成功即放行，并取消其余运行中的输入', () => {
  let flow = createFlow('disjunction')
  const start = flow.start
  const a = createProgressNode(flow, { x: 300, y: 0 }); flow = a.flow
  const b = createProgressNode(flow, { x: 300, y: 200 }); flow = b.flow
  const t = createTransitionNode(flow, { x: 600, y: 90 }); flow = t.flow
  const next = createProgressNode(flow, { x: 900, y: 90 }); flow = next.flow
  flow = connectNodes(flow, start, a.id, 'input', 'output').flow
  flow = connectNodes(flow, start, b.id, 'input', 'output').flow
  flow = connectNodes(flow, a.id, t.id, 'input2', 'output').flow
  flow = connectNodes(flow, b.id, t.id, 'input2', 'output').flow
  flow = connectNodes(flow, t.id, next.id, 'input', 'output').flow
  let sim = initializeQuest(flow, createSimState(flow))
  sim = settleProgress(flow, sim, start, 'succeeded')
  sim = settleProgress(flow, sim, a.id, 'succeeded')
  assert.equal(progressState(sim, next.id), 'running')
  assert.equal(progressState(sim, b.id), 'cancelled')
})

test('合取端口 + 析取端口：非空端口都要满足，谓词可以当门', () => {
  let flow = createFlow('gate')
  const start = flow.start
  const t = createTransitionNode(flow, { x: 300, y: 0 }); flow = t.flow
  const predicate = createPredicateNode(flow, { x: 300, y: 240 }); flow = predicate.flow
  const next = createProgressNode(flow, { x: 600, y: 0 }); flow = next.flow
  flow = connectNodes(flow, start, t.id, 'input', 'output').flow
  flow = connectNodes(flow, predicate.id, t.id, 'input2', 'output').flow
  flow = connectNodes(flow, t.id, next.id, 'input', 'output').flow
  let sim = initializeQuest(flow, createSimState(flow))
  sim = settleProgress(flow, sim, start, 'succeeded')
  assert.equal(progressState(sim, next.id), 'inactive', '谓词为假时不放行')
  sim = setPredicateTruth(flow, sim, predicate.id, true)
  assert.equal(progressState(sim, next.id), 'running', '谓词变真后重开一轮并放行')
})

test('谓词：初始化后只在上升沿发 A；假时对 Q 回 N；没有输入端口', () => {
  let flow = createFlow('predicate')
  const predicate = createPredicateNode(flow, { x: 0, y: 0 }); flow = predicate.flow
  const t = createTransitionNode(flow, { x: 300, y: 0 }); flow = t.flow
  const next = createProgressNode(flow, { x: 600, y: 0 }); flow = next.flow
  flow = connectNodes(flow, predicate.id, t.id, 'input2', 'output').flow
  flow = connectNodes(flow, t.id, next.id, 'input', 'output').flow
  // Keep this predicate effective without triggering the endpoint during initialization.
  const end = createEndNode(flow, { x: 900, y: 0 }); flow = end.flow
  flow = connectNodes(flow, flow.start, end.id, 'input', 'output').flow
  flow = connectNodes(flow, next.id, end.id, 'input2', 'output').flow
  let sim = initializeQuest(flow, createSimState(flow))
  assert.equal(predicateTruth(sim, predicate.id), false)
  assert.equal(progressState(sim, next.id), 'inactive')
  sim = setPredicateTruth(flow, sim, predicate.id, true)
  assert.equal(progressState(sim, next.id), 'running')
  const same = setPredicateTruth(flow, sim, predicate.id, true)
  assert.equal(same, sim, '真值没变时不做任何事')
  const quiet = setPredicateTruth(flow, createSimState(flow), predicate.id, false)
  assert.equal(progressState(quiet, next.id), 'inactive')
})

test('初始化：预置为真的谓词在实例初始化时整体广播一次', () => {
  let flow = createFlow('init-broadcast')
  const t = createTransitionNode(flow, { x: 300, y: 0 }); flow = t.flow
  const next = createProgressNode(flow, { x: 600, y: 0 }); flow = next.flow
  const predicate = createPredicateNode(flow, { x: 300, y: 240 }); flow = predicate.flow
  flow = connectNodes(flow, predicate.id, t.id, 'input2', 'output').flow
  flow = connectNodes(flow, t.id, next.id, 'input', 'output').flow
  // 用结束节点把谓词所在分量与开始进度连起来（开局广播只播报生效谓词）。
  const end = createEndNode(flow, { x: 900, y: 0 }); flow = end.flow
  flow = connectNodes(flow, flow.start, end.id, 'input', 'output').flow
  flow = connectNodes(flow, next.id, end.id, 'input2', 'output').flow
  let sim = createSimState(flow)
  sim = setPredicateTruth(flow, sim, predicate.id, true)
  assert.equal(progressState(sim, next.id), 'inactive', '初始化之前只是预置，不广播')
  assert.equal(sim.pulse, 0)
  sim = initializeQuest(flow, sim)
  assert.equal(sim.initialized, true)
  assert.equal(progressState(sim, flow.start), 'running')
  assert.equal(progressState(sim, next.id), 'running', '初始化时把已为真的事实播报出去')
  assert.equal(initializeQuest(flow, sim), sim, '同一个实例不会重复初始化')
  const reset = resetSimState(flow)
  assert.equal(reset.initialized, false)
  assert.equal(predicateTruth(reset, predicate.id), false)
})

test('取消：运行中变已取消；已成功忽略；未激活向输入侧转发', () => {
  let flow = createFlow('cancel')
  const start = flow.start
  const a = createProgressNode(flow, { x: 300, y: 0 }); flow = a.flow
  const t = createTransitionNode(flow, { x: 600, y: 0 }); flow = t.flow
  const b = createProgressNode(flow, { x: 900, y: 0 }); flow = b.flow
  flow = connectNodes(flow, start, a.id, 'input', 'output').flow
  flow = connectNodes(flow, a.id, t.id, 'input', 'output').flow
  flow = connectNodes(flow, t.id, b.id, 'input', 'output').flow
  let sim = initializeQuest(flow, createSimState(flow))
  sim = settleProgress(flow, sim, start, 'succeeded')
  assert.equal(progressState(sim, a.id), 'running')
  assert.equal(progressState(sim, b.id), 'inactive')
  sim = injectSignal(flow, sim, b.id, 'output', C)
  assert.equal(progressState(sim, b.id), 'inactive', '未激活不因取消而死')
  assert.equal(progressState(sim, a.id), 'cancelled', '取消沿输入侧传到运行中的生产者')
  const done = settleProgress(flow, initializeQuest(flow, createSimState(flow)), start, 'succeeded')
  const settled = settleProgress(flow, done, a.id, 'succeeded')
  const kept = injectSignal(flow, settled, a.id, 'output', C)
  assert.equal(progressState(kept, a.id), 'succeeded', '已成功不被取消打回')
})

test('查询：运行中回 N；结算后新一轮回 A 并放行；失败只回应失败口', () => {
  let flow = createFlow('query')
  const start = flow.start
  const t = createTransitionNode(flow, { x: 300, y: 0 }); flow = t.flow
  const next = createProgressNode(flow, { x: 600, y: 0 }); flow = next.flow
  flow = connectNodes(flow, start, t.id, 'input', 'output').flow
  flow = connectNodes(flow, t.id, next.id, 'input', 'output').flow
  let sim = initializeQuest(flow, createSimState(flow))
  sim = injectSignal(flow, sim, t.id, 'input', A)
  assert.ok(sim.log.some(item => item.signal.kind === 'none' && item.to === t.id), '运行中的进度对 Q 回 N')
  assert.equal(progressState(sim, next.id), 'inactive')
  sim = settleProgress(flow, sim, start, 'succeeded')
  assert.equal(progressState(sim, next.id), 'running')

  let failedFlow = createFlow('query-failure')
  const f = failedFlow.start
  const ft = createTransitionNode(failedFlow, { x: 300, y: 0 }); failedFlow = ft.flow
  const fnext = createProgressNode(failedFlow, { x: 600, y: 0 }); failedFlow = fnext.flow
  failedFlow = connectNodes(failedFlow, f, ft.id, 'input', 'output2').flow
  failedFlow = connectNodes(failedFlow, ft.id, fnext.id, 'input', 'output').flow
  let failedSim = initializeQuest(failedFlow, createSimState(failedFlow))
  failedSim = settleProgress(failedFlow, failedSim, f, 'failed')
  assert.equal(progressState(failedSim, fnext.id), 'running')
})

test('结束节点：成功入 / 失败入决定终局', () => {
  let flow = createFlow('end')
  const start = flow.start
  const end = createEndNode(flow, { x: 300, y: 0 }); flow = end.flow
  flow = connectNodes(flow, start, end.id, 'input', 'output').flow
  flow = connectNodes(flow, start, end.id, 'input2', 'output2').flow
  let sim = initializeQuest(flow, createSimState(flow))
  sim = settleProgress(flow, sim, start, 'failed')
  assert.equal(endOutcome(sim, end.id), 'failure')
  assert.equal(errors(flow).length, 0)
})

test('草稿节点：与开始进度不联通才是草稿；谓词只有出边也算联通', () => {
  let flow = createFlow('draft')
  const orphan = createProgressNode(flow, { x: 300, y: 0 }); flow = orphan.flow
  assert.equal(connectedToStart(flow).has(orphan.id), false)
  assert.ok(validateFlow(flow).some(issue => issue.path === orphan.id && issue.message.includes('草稿')))
  assert.ok(validateFlow(flow).some(issue => issue.path === 'ends' && issue.message.includes('结束')))
  const linked = connectNodes(flow, flow.start, orphan.id, 'input', 'output').flow
  assert.equal(connectedToStart(linked).has(orphan.id), true)
  assert.ok(!validateFlow(linked).some(issue => issue.message.includes('草稿')))

  // 谓词没有左端口，边只能从它出发；联通性必须视为无向。
  let gated = createFlow('draft-predicate')
  const t = createTransitionNode(gated, { x: 300, y: 0 }); gated = t.flow
  const predicate = createPredicateNode(gated, { x: 300, y: 240 }); gated = predicate.flow
  const next = createProgressNode(gated, { x: 600, y: 0 }); gated = next.flow
  gated = connectNodes(gated, gated.start, t.id, 'input', 'output').flow
  gated = connectNodes(gated, predicate.id, t.id, 'input2', 'output').flow
  gated = connectNodes(gated, t.id, next.id, 'input', 'output').flow
  assert.equal(connectedToStart(gated).has(predicate.id), true, '谓词接在生效变迁上就不再是草稿')
  assert.ok(!validateFlow(gated).some(issue => issue.path === predicate.id && issue.message.includes('草稿')))
})

test('结算幂等：非运行中不产生新事件', () => {
  const { flow, start } = chain()
  const sim = createSimState(flow)
  assert.equal(settleProgress(flow, sim, start, 'succeeded'), sim)
  const running = initializeQuest(flow, sim)
  const once = settleProgress(flow, running, start, 'succeeded')
  const twice = settleProgress(flow, once, start, 'failed')
  assert.equal(progressState(twice, start), 'succeeded')
  assert.equal(twice.log.length, once.log.length)
})

test('编辑图后保留存活状态、丢弃已删除节点', () => {
  const { flow, start, p2 } = chain()
  let sim = initializeQuest(flow, createSimState(flow))
  sim = settleProgress(flow, sim, start, 'succeeded')
  assert.equal(progressState(sim, p2), 'running')
  const removed = removeNode(flow, p2)
  const synced = resetSimState(removed)
  assert.deepEqual(synced.progress, { [start]: 'inactive' })
  assert.equal(hasContentNode(removed, p2), false)
})

test('删除节点会清理连线、位置与分组，但不能删开始进度', () => {
  const { flow, start, t1, p2 } = chain()
  const grouped = groupCanvasNodes(flow, [start, t1]).flow
  const removed = removeNode(grouped, t1)
  assert.equal(removed.logic!.links.filter(link => link.from === t1 || link.to === t1).length, 0)
  assert.equal(Object.hasOwn(removed.layout!.positions, t1), false)
  assert.equal(Object.hasOwn(removed.layout!.positions, p2), true)
  assert.equal(removeNode(removed, start), removed)
})

test('画布布局、端口坐标与自由拖动', () => {
  const { flow, start, t1 } = chain()
  const layout = layoutCanvas(flow)
  assert.equal(layout.positions.size, 3)
  assert.deepEqual(nodeMetrics(flow, start), { width: 216, height: 118, socketY: 44 })
  assert.deepEqual(nodeMetrics(flow, t1), { width: 180, height: 96, socketY: 48 })
  const moved = moveCanvasNodes(flow, { [start]: { x: -120, y: 40 } })
  assert.deepEqual(moved.layout!.positions[start], { x: -120, y: 40 })
  assert.deepEqual(moved.logic, flow.logic)
  assert.throws(() => moveCanvasNodes(flow, { [t1]: { x: Number.NaN, y: 0 } }))
})

test('注释仍是画布项：不可连线、可分组、可往返', () => {
  const { flow, start } = chain()
  const note = createCanvasNote(flow, { x: 40, y: 300 })
  const updated = updateCanvasNote(note.flow, note.id, { title: '设计说明', text: '第一行', color: 'sage', width: 320, height: 180 })
  assert.equal(hasContentNode(updated, note.id), false)
  assert.equal(canConnectNodes(updated, note.id, start, 'input'), false)
  assert.deepEqual(parseFlow(JSON.stringify(updated)).layout!.notes![note.id], { title: '设计说明', text: '第一行', color: 'sage', width: 320, height: 180 })
  const grouped = groupCanvasNodes(updated, [note.id, start])
  assert.deepEqual(grouped.flow.layout!.groups![grouped.id].nodes.sort(), [note.id, start].sort())
  assert.deepEqual(removeCanvasItems(updated, [note.id]).layout!.notes, {})
})

test('文档里的环是 error，而不是 warning', () => {
  const flow = createFlow('cycle')
  const a = flow.start
  const b = createProgressNode(flow, { x: 300, y: 0 })
  const linked = connectNodes(b.flow, a, b.id, 'input', 'output').flow
  const cyclic = { ...linked, logic: { links: [...(linked.logic?.links ?? []), { id: 'link_9', from: b.id, to: a, port: 'input' as const, fromPort: 'output' as const }] } }
  assert.ok(findCanvasCycle(cyclic))
  assert.ok(validateFlow(cyclic).some(issue => issue.severity === 'error' && issue.path === 'graph'))
})

test('断开连接只移除目标边', () => {
  const { flow, p2 } = chain()
  const link = flow.logic!.links.find(item => item.to === p2)!
  const cut = disconnectLink(flow, { kind: 'logic-link', id: link.id })
  assert.equal(cut.logic!.links.filter(item => item.id === link.id).length, 0)
  assert.deepEqual(cut.progress, flow.progress)
  assert.equal(disconnectLink(flow, { kind: 'flow' }), flow)
})

test('光标缩放保持世界点不动', () => {
  for (const camera of [{ x: -900, y: 420, zoom: .8 }, { x: 1300, y: -760, zoom: 1.6 }]) {
    for (const zoom of [.01, .5, 1, 1.8, 10]) {
      const cursor = { x: 340, y: 190 }, before = worldPoint(camera, cursor), next = zoomCamera(camera, zoom, cursor), after = worldPoint(next, cursor)
      assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9)
      assert.ok(next.zoom >= MIN_CANVAS_ZOOM && next.zoom <= MAX_CANVAS_ZOOM)
    }
  }
})

const store = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) }, configurable: true })
test('工程库：保存 / 载入 / 导入往返', () => {
  store.clear()
  const doc = createFlowDocument()
  saveFlowWorkspace({ documents: [doc], folders: [], activeKey: doc.key })
  const loaded = loadFlowWorkspace()
  assert.equal(loaded.error, '')
  assert.equal(loaded.state.documents[0].source, doc.source)
  const imported = importFlowDocument('故事.json', JSON.stringify(createFlow('imported')))
  assert.equal(imported.name, '故事.quest')
  assert.deepEqual(parseFlow(imported.source), createFlow('imported'))
})

test('资源库：文件夹、移动、改名与重名冲突', () => {
  const doc = { ...createFlowDocument(createFlow('library')), name: '故事.quest' }
  const empty = { documents: [doc], folders: [], activeKey: doc.key }
  const chapter = addFlowFolder(empty, '第一章', 'quest', null)
  const story = addFlowFolder(chapter.state, '支线', 'quest', chapter.folder.key)
  const entry = { kind: 'document' as const, key: doc.key }
  const moved = moveFlowEntry(story.state, entry, 'quest', story.folder.key)
  const renamed = renameFlowEntry(moved, entry, '驿站')
  assert.equal(renamed.documents[0].source, doc.source)
  assert.equal(renamed.documents[0].name, '驿站.quest')
  saveFlowWorkspace(renamed)
  assert.deepEqual(loadFlowWorkspace().state.documents, renamed.documents)
  assert.throws(() => addFlowFolder(chapter.state, '第一章', 'quest', null), /同名/)
  assert.throws(() => renameFlowEntry(empty, entry, '../故事'), /有效名称/)
  assert.equal(uniqueDocumentName(empty, '故事.quest', 'quest', null), '故事 (2).quest')
})

test('破坏的存储不静默改写', () => {
  store.set(FLOW_STORAGE_KEY, '{bad}')
  assert.ok(loadFlowWorkspace().error)
  assert.equal(store.get(FLOW_STORAGE_KEY), '{bad}')
})

await Promise.all(pending)
console.log(`Progress model: ${passed} checks passed.`)
