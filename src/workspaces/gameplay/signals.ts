import { FLOW_LIMITS, orderedLinks, validateFlow, connectedToStart, getEndNode, getPredicateNode, getObjectiveNode, getProgressNode, getTransitionNode, linkSourcePort, type FlowPort, type ProgressFlow } from './model'

/** 进度、条件和后台目标持有生命周期状态；唯一终局锁存在 quest 实例上。 */
export const PROGRESS_STATES = {
  inactive: '未激活',
  running: '运行中',
  succeeded: '已成功',
  failed: '已失败',
  cancelled: '已取消',
  terminated: '随任务结束',
} as const
export type ProgressState = keyof typeof PROGRESS_STATES
export const OBJECTIVE_STATES = { inactive: '未激活', running: '运行中', succeeded: '已成功', failed: '已失败', closed: '已关闭' } as const
export const CONDITION_STATES = { inactive: '未激活', running: '运行中', closed: '已关闭' } as const
export type ObjectiveState = keyof typeof OBJECTIVE_STATES
export type ConditionState = keyof typeof CONDITION_STATES

/**
 * 线上只有四种信号：
 * - A activate：顺流。「我被激活 / 我成立 / 这是我的结局」
 * - Q query：逆流。「你现在是什么状态？」
 * - C cancel：逆流。「这个消费者不要你了」
 * - N none：逆流。「对 Q 的否定应答」；也是任何未特别说明节点的默认回应
 */
export type FlowSignal = { kind: 'activate' } | { kind: 'query' } | { kind: 'cancel' } | { kind: 'none' }
export const SIGNAL_LABELS: Record<FlowSignal['kind'], string> = { activate: 'A', query: 'Q', cancel: 'C', none: 'N' }

export type SignalChange = { id: string; text: string }
export type SimDelivery = Delivery & {
  accepted: boolean
  reason?: string
  emitted?: Delivery[]
  changes?: SignalChange[]
  rolledBack?: boolean
  assessment?: { round: number; mode?: 'query'; conjunction: boolean; disjunction: boolean; answers: { link: string; signal: 'activate' | 'none'; traceId?: number }[] }
}

/**
 * 逻辑一轮查询的临时簿记：轮次编号让"对上一轮的迟到应答"不会开启新的一轮。
 * 它只在模拟器内存里，不落盘。
 */
export type TransitionRound = { open: boolean; id: number; answered: Record<string, 'activate' | 'none'>; evidence?: Record<string, number> }
/** A read-only recursive evaluation, isolated from activation and other callers. */
export type TransitionQuery = { request: Delivery; answered: Record<string, 'activate' | 'none'>; evidence?: Record<string, number> }

export type FlowSimState = {
  progress: Record<string, ProgressState>
  objectives: Record<string, ObjectiveState>
  predicates: Record<string, boolean>
  conditionStates: Record<string, ConditionState>
  rounds: Record<string, TransitionRound>
  queryRounds: Record<string, Record<number, TransitionQuery>>
  ends: Record<string, 'success' | 'failure' | null>
  log: SimDelivery[]
  pulse: number
  nextTraceId: number
  events: { id: number; label: string; nodeId?: string }[]
  /** 实例是否已初始化；初始化之前改条件真值只是「预置」，不广播。 */
  initialized: boolean
  outcome: { endId: string; result: 'success' | 'failure' } | { endId: null; result: 'failure'; reason: 'no-running-progress' | 'no-reachable-end' } | null
  queue: Delivery[]
  discarded: (Delivery & { reason: string })[]
  last: { delivery: Delivery; emitted: Delivery[]; accepted: boolean; reason?: string; changes: SignalChange[] } | null
  fault: { code: string; message: string } | null
  execution: { checkpoint: RuntimeSnapshot; signature: string; processed: number; budget: number; seen: string[] } | null
}
type RuntimeSnapshot = Pick<FlowSimState, 'progress' | 'objectives' | 'predicates' | 'conditionStates' | 'rounds' | 'queryRounds' | 'ends' | 'outcome' | 'initialized'>

export type Delivery = { signal: FlowSignal; to: string; port: FlowPort; link?: string; round?: number; queryId?: number; from: string | null; traceId?: number; eventId?: number; parentId?: number | null; causes?: number[] }

const A: FlowSignal = { kind: 'activate' }
const Q: FlowSignal = { kind: 'query' }
const C: FlowSignal = { kind: 'cancel' }
const N: FlowSignal = { kind: 'none' }

const emptyRound = (): TransitionRound => ({ open: false, id: 0, answered: {} })

export function progressState(sim: FlowSimState, id: string): ProgressState {
  return Object.hasOwn(sim.progress, id) ? sim.progress[id] : 'inactive'
}
export function predicateTruth(sim: FlowSimState, id: string): boolean {
  return Object.hasOwn(sim.predicates, id) ? sim.predicates[id] : false
}
export function objectiveState(sim: FlowSimState, id: string): ObjectiveState {
  return Object.hasOwn(sim.objectives, id) ? sim.objectives[id] : 'inactive'
}
export function conditionState(sim: FlowSimState, id: string): ConditionState {
  return Object.hasOwn(sim.conditionStates, id) ? sim.conditionStates[id] : 'inactive'
}
export function transitionRound(sim: FlowSimState, id: string): TransitionRound {
  return Object.hasOwn(sim.rounds, id) ? sim.rounds[id] : emptyRound()
}
export function endOutcome(sim: FlowSimState, id: string): 'success' | 'failure' | null {
  return Object.hasOwn(sim.ends, id) ? sim.ends[id] : null
}

export function createSimState(flow: ProgressFlow): FlowSimState {
  const objectives: Record<string, ObjectiveState> = Object.fromEntries(Object.keys(flow.objectives ?? {}).map(id => [id, 'inactive']))
  const progress: Record<string, ProgressState> = {}
  const predicates: Record<string, boolean> = {}
  const rounds: Record<string, TransitionRound> = {}
  const ends: Record<string, 'success' | 'failure' | null> = {}
  for (const id of Object.keys(flow.progress)) progress[id] = 'inactive'
  for (const id of Object.keys(flow.predicates ?? {})) predicates[id] = false
  for (const id of Object.keys(flow.transitions ?? {})) rounds[id] = emptyRound()
  for (const id of Object.keys(flow.ends ?? {})) ends[id] = null
  const conditionStates = Object.fromEntries(Object.keys(predicates).map(id => [id, 'inactive' as const]))
  return { progress, objectives, predicates, conditionStates, rounds, queryRounds: {}, ends, log: [], pulse: 0, nextTraceId: 1, events: [], initialized: false, outcome: null, queue: [], discarded: [], last: null, fault: null, execution: null }
}

/** Drop removed nodes; keep surviving runtime state when the graph is edited. */
export function syncSimState(sim: FlowSimState, flow: ProgressFlow): FlowSimState {
  const conditionStates = Object.fromEntries(Object.keys(flow.predicates ?? {}).map(id => [id, conditionState(sim, id)]))
  const objectives: Record<string, ObjectiveState> = Object.fromEntries(Object.keys(flow.objectives ?? {}).map(id => [id, objectiveState(sim, id)]))
  const progress: Record<string, ProgressState> = {}
  const predicates: Record<string, boolean> = {}
  const rounds: Record<string, TransitionRound> = {}
  const ends: Record<string, 'success' | 'failure' | null> = {}
  for (const id of Object.keys(flow.progress)) progress[id] = Object.hasOwn(sim.progress, id) ? sim.progress[id] : 'inactive'
  for (const id of Object.keys(flow.predicates ?? {})) predicates[id] = Object.hasOwn(sim.predicates, id) ? sim.predicates[id] : false
  for (const id of Object.keys(flow.transitions ?? {})) rounds[id] = Object.hasOwn(sim.rounds, id) ? sim.rounds[id] : emptyRound()
  for (const id of Object.keys(flow.ends ?? {})) ends[id] = Object.hasOwn(sim.ends, id) ? sim.ends[id] : null
  const same = (a: object, b: object) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key))
  if (same(sim.progress, progress) && same(sim.objectives, objectives) && same(sim.predicates, predicates) && same(sim.rounds, rounds) && same(sim.ends, ends)) return sim
  const queryRounds = Object.fromEntries(Object.entries(sim.queryRounds).filter(([id]) => getTransitionNode(flow,id)))
  return { ...sim, progress, objectives, predicates, conditionStates, rounds, queryRounds, ends }
}

export function resetSimState(flow: ProgressFlow): FlowSimState {
  return createSimState(flow)
}

/** 顺流：沿 from 的输出端口发出，落到连线的目标输入端口。 */
function forward(flow: ProgressFlow, from: string, port: FlowPort, signal: FlowSignal): Delivery[] {
  return orderedLinks(flow)
    .filter(link => link.from === from && linkSourcePort(flow, link.from, link.fromPort) === port)
    .map(link => ({ signal, to: link.to, port: link.port, link: link.id, from }))
}
/** 逆流：沿连到 from 的该端口的入线，回到上游节点的输出端口。 */
function backward(flow: ProgressFlow, from: string, port: FlowPort, signal: FlowSignal): Delivery[] {
  return orderedLinks(flow, true)
    .filter(link => link.to === from && link.port === port)
    .map(link => ({ signal, to: link.from, port: linkSourcePort(flow, link.from, link.fromPort), link: link.id, from }))
}
/** 本轮查询：Q 逆流，携带轮次编号。 */
function queryRound(flow: ProgressFlow, id: string, round: number, queryId?: number): Delivery[] {
  return [...backward(flow, id, 'input', Q), ...backward(flow, id, 'input2', Q)]
    .map(delivery => ({ ...delivery, round, ...(queryId === undefined ? {} : {queryId}) }))
}
/** 对 Q 的应答沿同一通道送回发起方。 */
function reply(flow: ProgressFlow, delivery: Delivery, signal: FlowSignal): Delivery[] {
  const link = (flow.logic?.links ?? []).find(item => item.id === delivery.link)
  return link ? [{ signal, to: link.to, port: link.port, link: link.id, round: delivery.round, ...(delivery.queryId === undefined ? {} : {queryId:delivery.queryId}), from: link.from }] : []
}

function accept(sim: FlowSimState, delivery: Delivery): void {
  sim.log.push({ ...delivery, accepted: true })
}
function reject(sim: FlowSimState, delivery: Delivery, reason: string): void {
  sim.log.push({ ...delivery, accepted: false, reason })
}

function deliverProgress(flow: ProgressFlow, sim: FlowSimState, delivery: Delivery, id: string): Delivery[] {
  const current = progressState(sim, id)
  if (delivery.signal.kind === 'activate') {
    if (current !== 'inactive') { reject(sim, delivery, `进度当前为「${PROGRESS_STATES[current]}」，只有未激活能被激活`); return [] }
    sim.progress[id] = 'running'
    accept(sim, delivery)
    // 激活即消费输入：上游不必再为这个进度等待或重复触发。
    return backward(flow, id, 'input', C)
  }
  if (delivery.signal.kind === 'query') {
    const answer = (current === 'succeeded' && delivery.port === 'output') || (current === 'failed' && delivery.port === 'output2') ? A : N
    accept(sim, delivery)
    return reply(flow, delivery, answer)
  }
  if (delivery.signal.kind === 'cancel') {
    if (current === 'running') {
      sim.progress[id] = 'cancelled'
      accept(sim, delivery)
      return []
    }
    if (current === 'inactive') {
      accept(sim, delivery)
      return backward(flow, id, 'input', C)
    }
    reject(sim, delivery, `进度当前为「${PROGRESS_STATES[current]}」，忽略取消`)
    return []
  }
  reject(sim, delivery, '进度不接收 N')
  return []
}

function deliverPredicate(flow: ProgressFlow, sim: FlowSimState, delivery: Delivery, id: string): Delivery[] {
  if (delivery.signal.kind === 'query') {
    accept(sim, delivery)
    return reply(flow, delivery, conditionState(sim, id) === 'running' && predicateTruth(sim, id) ? A : N)
  }
  if (delivery.signal.kind === 'cancel') { sim.conditionStates[id] = 'closed'; accept(sim, delivery); return [] }
  reject(sim, delivery, '条件没有左端口，只接受查询')
  return []
}

function deliverObjective(flow: ProgressFlow, sim: FlowSimState, delivery: Delivery, id: string): Delivery[] {
  if (delivery.signal.kind === 'query') {
    const state = objectiveState(sim, id)
    accept(sim, delivery)
    return reply(flow, delivery, (state === 'succeeded' && delivery.port === 'output') || (state === 'failed' && delivery.port === 'output2') ? A : N)
  }
  if (delivery.signal.kind === 'cancel') { sim.objectives[id] = 'closed'; accept(sim, delivery); return [] }
  reject(sim, delivery, '目标没有左端口，只接受查询；结算由实例报告')
  return []
}

function deliverEnd(sim: FlowSimState, delivery: Delivery, id: string): Delivery[] {
  if (delivery.signal.kind !== 'activate' || !['input', 'input2'].includes(delivery.port)) { reject(sim, delivery, '结束节点只从成功入或失败入接收 A'); return [] }
  if (sim.outcome || endOutcome(sim, id)) { reject(sim, delivery, '任务已结束'); return [] }
  const result = delivery.port === 'input2' ? 'failure' : 'success'
  sim.ends[id] = result
  sim.outcome = { endId: id, result }
  for (const [node, state] of Object.entries(sim.progress)) if (state === 'running') sim.progress[node] = 'terminated'
  for (const node of Object.keys(sim.rounds)) sim.rounds[node] = { ...sim.rounds[node], open: false, answered: {} }
  sim.queryRounds = {}
  accept(sim, delivery)
  return []
}

/** 一轮问答收齐后判定：非空端口都要满足；并且=全部 A，或者=任一 A。 */
function settleRound(flow: ProgressFlow, sim: FlowSimState, id: string): Delivery[] {
  const incoming = (flow.logic?.links ?? []).filter(link => link.to === id)
  const round = transitionRound(sim, id)
  if (!round.open || !incoming.every(link => Object.hasOwn(round.answered, link.id))) return []
  const conj = incoming.filter(link => link.port === 'input')
  const disj = incoming.filter(link => link.port === 'input2')
  const conjOk = conj.length === 0 || conj.every(link => round.answered[link.id] === 'activate')
  const disjOk = disj.length === 0 || disj.some(link => round.answered[link.id] === 'activate')
  const entry = sim.log.at(-1)
  if (entry) entry.assessment = { round:round.id, conjunction:conjOk, disjunction:disjOk, answers:Object.entries(round.answered).map(([link,signal])=>({link,signal,traceId:round.evidence?.[link]})) }
  sim.rounds[id] = { open: false, id: round.id, answered: {} }
  if (!conjOk || !disjOk) return []
  const causes = [...new Set(Object.values(round.evidence ?? {}))].sort((a,b)=>a-b)
  // Logic only judges and forwards activation; consumption starts at an activated progress.
  return forward(flow, id, 'output', A).map(delivery => ({ ...delivery, causes }))
}

function rememberAnswer(round: Pick<TransitionRound,'answered'|'evidence'>, delivery: Delivery, answer: 'activate' | 'none') {
  if (!delivery.link || Object.hasOwn(round.answered,delivery.link)) return
  round.answered[delivery.link] = answer
  if (delivery.traceId !== undefined) (round.evidence ??= {})[delivery.link] = delivery.traceId
}

function settleQuery(flow: ProgressFlow, sim: FlowSimState, id: string, queryId: number): Delivery[] {
  const query = sim.queryRounds[id]?.[queryId]
  if (!query) return []
  const incoming = (flow.logic?.links ?? []).filter(link => link.to === id)
  if (!incoming.every(link => Object.hasOwn(query.answered,link.id))) return []
  const conjunction = incoming.length > 0 && incoming.filter(link=>link.port==='input').every(link=>query.answered[link.id]==='activate')
  const alternatives = incoming.filter(link=>link.port==='input2')
  const disjunction = !alternatives.length || alternatives.some(link=>query.answered[link.id]==='activate')
  const entry = sim.log.at(-1)
  if (entry) entry.assessment = {round:queryId,mode:'query',conjunction,disjunction,answers:Object.entries(query.answered).map(([link,signal])=>({link,signal,traceId:query.evidence?.[link]}))}
  delete sim.queryRounds[id][queryId]
  if (!Object.keys(sim.queryRounds[id]).length) delete sim.queryRounds[id]
  const causes = [...new Set([query.request.traceId!, ...Object.values(query.evidence ?? {})])].sort((a,b)=>a-b)
  // A query never releases the node or consumes its inputs; only its caller gets the answer.
  return reply(flow,query.request,incoming.length && conjunction && disjunction ? A : N).map(delivery=>({...delivery,causes}))
}

function deliverTransition(flow: ProgressFlow, sim: FlowSimState, delivery: Delivery, id: string): Delivery[] {
  if (delivery.signal.kind === 'query') {
    if (delivery.port !== 'output' || delivery.traceId === undefined) { reject(sim,delivery,'逻辑只从右端口接受查询'); return [] }
    accept(sim, delivery)
    const queryId = delivery.traceId
    sim.queryRounds[id] ??= {}
    sim.queryRounds[id][queryId] = {request:delivery,answered:{}}
    return [...queryRound(flow,id,queryId,queryId), ...settleQuery(flow,sim,id,queryId)]
  }
  if (delivery.signal.kind === 'cancel') {
    accept(sim, delivery)
    const round = transitionRound(sim, id)
    sim.rounds[id] = { open: false, id: round.id, answered: {} }
    return [...backward(flow, id, 'input', C), ...backward(flow, id, 'input2', C)]
  }
  if (delivery.queryId !== undefined) {
    const query = sim.queryRounds[id]?.[delivery.queryId]
    if (!query || delivery.round !== delivery.queryId) { reject(sim,delivery,'过期递归查询应答'); return [] }
    if (!delivery.link || !(flow.logic?.links ?? []).some(link=>link.id===delivery.link && link.to===id && link.port===delivery.port)) { reject(sim,delivery,'递归查询应答通道不匹配'); return [] }
    if (Object.hasOwn(query.answered,delivery.link)) { reject(sim,delivery,'本次递归查询该连线已有应答'); return [] }
    if (delivery.signal.kind !== 'activate' && delivery.signal.kind !== 'none') { reject(sim,delivery,'递归查询仅接受 A / N 应答'); return [] }
    rememberAnswer(query,delivery,delivery.signal.kind)
    accept(sim,delivery)
    return settleQuery(flow,sim,id,delivery.queryId)
  }
  const round = transitionRound(sim, id)
  if (delivery.signal.kind === 'activate') {
    if (delivery.port !== 'input' && delivery.port !== 'input2') { reject(sim, delivery, '逻辑只从左端口接收 A'); return [] }
    if (delivery.round !== undefined) {
      // 对某轮 Q 的应答；过期轮次直接吞掉，不能开新一轮。
      if (!round.open || round.id !== delivery.round) { reject(sim, delivery, '过期查询应答，不启动新轮次'); return [] }
      if (delivery.link && Object.hasOwn(round.answered, delivery.link)) { reject(sim, delivery, '本轮该连线已有应答'); return [] }
      rememberAnswer(round,delivery,'activate')
      accept(sim, delivery)
      return settleRound(flow, sim, id)
    }
    if (!round.open) {
      const answered: Record<string, 'activate' | 'none'> = delivery.link ? { [delivery.link]: 'activate' } : {}
      const next: TransitionRound = { open: true, id: round.id + 1, answered, evidence: delivery.link && delivery.traceId !== undefined ? { [delivery.link]: delivery.traceId } : {} }
      sim.rounds[id] = next
      accept(sim, delivery)
      // 没有非触发器入线时（例如开始直接连逻辑），这一轮当场判定，不需要等应答。
      return [...queryRound(flow, id, next.id), ...settleRound(flow, sim, id)]
    }
    rememberAnswer(round,delivery,'activate')
    accept(sim, delivery)
    return settleRound(flow, sim, id)
  }
  if (delivery.signal.kind === 'none') {
    if (delivery.round === undefined) { reject(sim, delivery, '没有查询轮次的 N'); return [] }
    if (!round.open || round.id !== delivery.round) { reject(sim, delivery, '过期查询应答，不启动新轮次'); return [] }
    if (delivery.link && Object.hasOwn(round.answered, delivery.link)) { reject(sim, delivery, '本轮该连线已有应答'); return [] }
    rememberAnswer(round,delivery,'none')
    accept(sim, delivery)
    return settleRound(flow, sim, id)
  }
  return []
}

function deliverOne(flow: ProgressFlow, sim: FlowSimState, delivery: Delivery): Delivery[] {
  if (getProgressNode(flow, delivery.to)) return deliverProgress(flow, sim, delivery, delivery.to)
  if (getPredicateNode(flow, delivery.to)) return deliverPredicate(flow, sim, delivery, delivery.to)
  if (getObjectiveNode(flow, delivery.to)) return deliverObjective(flow, sim, delivery, delivery.to)
  if (getTransitionNode(flow, delivery.to)) return deliverTransition(flow, sim, delivery, delivery.to)
  if (getEndNode(flow, delivery.to)) return deliverEnd(sim, delivery, delivery.to)
  reject(sim, delivery, '目标节点不存在')
  return []
}

/** A pulse is atomic with respect to external events; animation never owns execution. */
function snapshot(sim: FlowSimState): RuntimeSnapshot {
  return structuredClone({ progress: sim.progress, objectives: sim.objectives, predicates: sim.predicates, conditionStates: sim.conditionStates, rounds: sim.rounds, queryRounds: sim.queryRounds, ends: sim.ends, outcome: sim.outcome, initialized: sim.initialized })
}
const signature = (flow: ProgressFlow) => JSON.stringify([flow.start, flow.progress, flow.objectives, flow.predicates, flow.transitions, flow.ends, orderedLinks(flow)])
export const isBusy = (sim: FlowSimState) => sim.queue.length > 0
export const canTrigger = (sim: FlowSimState) => !isBusy(sim) && !sim.outcome && !sim.fault
export const AUTO_FAILURE_REASONS = {
  'no-running-progress': '没有运行中的进度',
  'no-reachable-end': '运行中的进度均无法到达结束节点',
} as const

/** Quiescence only: queued predicate, query and cancellation effects settle first.
 * Reverse reachability follows business edges, never inverse Q/C or layout. */
function finishPulse(flow: ProgressFlow, sim: FlowSimState): void {
  if (!sim.initialized || sim.outcome || sim.fault || sim.queue.length) return
  const running = Object.keys(flow.progress).filter(id => progressState(sim, id) === 'running')
  const upstream = new Map<string, string[]>()
  for (const link of flow.logic?.links ?? []) {
    const sources = upstream.get(link.to) ?? []
    sources.push(link.from); upstream.set(link.to, sources)
  }
  const reachable = new Set(Object.keys(flow.ends ?? {})), pending = [...reachable]
  for (let index = 0; index < pending.length; index++) for (const id of upstream.get(pending[index]) ?? []) {
    if (!reachable.has(id)) { reachable.add(id); pending.push(id) }
  }
  if (running.some(id => reachable.has(id))) return
  sim.outcome = { endId: null, result: 'failure', reason: running.length ? 'no-reachable-end' : 'no-running-progress' }
  for (const id of running) sim.progress[id] = 'terminated'
  sim.execution = null
}
function fail(sim: FlowSimState, code: string, message: string) {
  if (sim.execution) Object.assign(sim, structuredClone(sim.execution.checkpoint))
  sim.discarded.push(...sim.queue.map(delivery => ({ ...delivery, reason: '传播故障，状态已回退' })))
  for (const row of sim.log) if (row.eventId === sim.pulse) row.rolledBack = true
  sim.queue = []; sim.fault = { code, message }; sim.execution = null
}
function begin(flow: ProgressFlow, sim: FlowSimState, base: FlowSimState, seeds: Delivery[], event = { label: '手动投递', nodeId: undefined as string | undefined }): FlowSimState {
  if (!canTrigger(sim)) return sim
  const next = structuredClone(base)
  next.log = next.log.slice(-4000); next.pulse = sim.pulse + 1; next.last = null; next.discarded = []
  const nodes = Object.keys(flow.progress).length + Object.keys(flow.objectives ?? {}).length + Object.keys(flow.predicates ?? {}).length + Object.keys(flow.transitions ?? {}).length + Object.keys(flow.ends ?? {}).length
  const budget = Math.min(FLOW_LIMITS.deliveries, Math.max(512, (flow.logic?.links.length ?? 0) * 128 + nodes * 32))
  next.execution = { checkpoint: snapshot(sim), signature: signature(flow), processed: 0, budget, seen: [] }
  next.events = [...next.events.slice(-3999), { id: next.pulse, ...event }]
  next.queue = seeds.map(delivery => ({ ...delivery, traceId: next.nextTraceId++, eventId: next.pulse, parentId: null, causes: [] }))
  const errors = validateFlow(flow).filter(issue => issue.severity === 'error')
  if (errors.length) fail(next, 'invalid-graph', errors[0].message)
  else if (seeds.length > budget) fail(next, 'budget-exceeded', `初始队列超过 ${budget} 条预算。`)
  else if (!seeds.length) { next.execution = null; finishPulse(flow, next) }
  return next
}
/** Mutates only this execution's working copy; callers return an immutable snapshot. */
function advance(flow: ProgressFlow, next: FlowSimState, verify = true): void {
  const run = next.execution
  if (!run || !next.queue.length || next.outcome || next.fault) return
  if (verify && run.signature !== signature(flow)) { fail(next, 'graph-changed', '传播期间图发生变化，请重置模拟。'); return }
  if (run.processed >= run.budget) { fail(next, 'budget-exceeded', `信号预算 ${run.budget} 已耗尽；本次事件的业务状态已回退。`); return }
  const delivery = next.queue.shift()!
  run.processed++
  const beforeProgress = { ...next.progress }, beforeRound = JSON.stringify([next.rounds[delivery.to],next.queryRounds[delivery.to]]), previousLog = next.log.length
  const beforeObjectives = { ...next.objectives }, beforeConditions = { ...next.conditionStates }
  // Repeated inverse cancellation in a diamond must not expand exponentially.
  // A newly changed progress state / transition round is a distinct cancellation target.
  const key = JSON.stringify([delivery.to, delivery.port, progressState(next, delivery.to), transitionRound(next, delivery.to).id])
  let emitted: Delivery[] = []
  if (delivery.signal.kind === 'cancel' && run.seen.includes(key)) reject(next, delivery, '本次传播已处理相同状态的取消')
  else {
    if (delivery.signal.kind === 'cancel') run.seen.push(key)
    emitted = deliverOne(flow, next, delivery).map(item=>({...item, traceId:next.nextTraceId++, eventId:next.pulse, parentId:delivery.traceId ?? null}))
  }
  const entry = next.log[previousLog]
  const changes = Object.keys(next.progress).filter(id => beforeProgress[id] !== next.progress[id]).map(id => ({ id, text: `${PROGRESS_STATES[beforeProgress[id]]} → ${PROGRESS_STATES[next.progress[id]]}` }))
  for (const id of Object.keys(next.objectives)) if (beforeObjectives[id] !== next.objectives[id]) changes.push({ id, text: `${OBJECTIVE_STATES[beforeObjectives[id]]} → ${OBJECTIVE_STATES[next.objectives[id]]}` })
  for (const id of Object.keys(next.conditionStates)) if (beforeConditions[id] !== next.conditionStates[id]) changes.push({ id, text: `${CONDITION_STATES[beforeConditions[id]]} → ${CONDITION_STATES[next.conditionStates[id]]}` })
  if (beforeRound !== JSON.stringify([next.rounds[delivery.to],next.queryRounds[delivery.to]])) changes.push({ id: delivery.to, text: '查询轮次更新' })
  if (entry) { entry.emitted = emitted; entry.changes = changes }
  next.last = { delivery, emitted, accepted: entry?.accepted ?? false, reason: entry?.reason, changes }
  if (next.outcome) {
    next.discarded.push(...next.queue.map(item => ({ ...item, reason: '任务已结束，不再投递' })))
    next.queue = []; next.execution = null
  } else if (run.processed + next.queue.length + emitted.length > run.budget) {
    next.queue.push(...emitted); fail(next, 'budget-exceeded', `信号队列超过 ${run.budget} 条预算；本次事件的业务状态已回退。`)
  } else {
    next.queue.push(...emitted)
    if (!next.queue.length) { next.execution = null; finishPulse(flow, next) }
  }
}
export function stepSignal(flow: ProgressFlow, sim: FlowSimState): FlowSimState {
  if (!isBusy(sim) || sim.fault || sim.outcome) return sim
  const next = structuredClone(sim); advance(flow, next); return next
}
export function drainSignals(flow: ProgressFlow, sim: FlowSimState): FlowSimState {
  const next = structuredClone(sim)
  if (next.execution && next.execution.signature !== signature(flow)) { fail(next, 'graph-changed', '传播期间图发生变化，请重置模拟。'); return next }
  while (next.queue.length && !next.fault && !next.outcome) advance(flow, next, false)
  finishPulse(flow, next)
  return next
}
export function propagateSignals(flow: ProgressFlow, sim: FlowSimState, seeds: Delivery[], deferred = false): FlowSimState {
  if (!canTrigger(sim)) return sim
  const next = begin(flow, sim, sim, seeds)
  return deferred ? next : drainSignals(flow, next)
}
export function initializeQuest(flow: ProgressFlow, sim: FlowSimState, deferred = false): FlowSimState {
  if (sim.initialized || !canTrigger(sim) || !getProgressNode(flow, flow.start)) return sim
  const effective = connectedToStart(flow)
  // All effective background goals start together, before any initialization deliveries.
  const objectives: Record<string, ObjectiveState> = Object.fromEntries(Object.keys(flow.objectives ?? {}).map(id => [id, objectiveState(sim, id) === 'closed' ? 'closed' : effective.has(id) ? 'running' : 'inactive']))
  const conditionStates: Record<string, ConditionState> = Object.fromEntries(Object.keys(flow.predicates ?? {}).map(id => [id, conditionState(sim, id) === 'closed' ? 'closed' : effective.has(id) ? 'running' : 'inactive']))
  const base = { ...sim, initialized: true, objectives, conditionStates, progress: { ...sim.progress, [flow.start]: 'running' as const } }
  const seeds = Object.keys(flow.predicates ?? {}).filter(id => conditionStates[id] === 'running' && predicateTruth(sim, id)).sort().flatMap(id => forward(flow, id, 'output', A))
  const next = begin(flow, sim, base, seeds, { label: '初始化任务', nodeId: flow.start })
  return deferred ? next : drainSignals(flow, next)
}
export function settleProgress(flow: ProgressFlow, sim: FlowSimState, id: string, outcome: 'succeeded' | 'failed', deferred = false): FlowSimState {
  if (!canTrigger(sim) || !sim.initialized || !connectedToStart(flow).has(id) || !getProgressNode(flow, id) || progressState(sim, id) !== 'running') return sim
  const port: FlowPort = outcome === 'succeeded' ? 'output' : 'output2'
  const base = { ...sim, progress: { ...sim.progress, [id]: outcome } }
  const next = begin(flow, sim, base, forward(flow, id, port, A), { label: outcome === 'succeeded' ? '结算成功' : '结算失败', nodeId: id })
  return deferred ? next : drainSignals(flow, next)
}
export function setPredicateTruth(flow: ProgressFlow, sim: FlowSimState, id: string, truth: boolean, deferred = false): FlowSimState {
  if (!canTrigger(sim) || !getPredicateNode(flow, id) || conditionState(sim, id) === 'closed' || predicateTruth(sim, id) === truth) return sim
  const base = { ...sim, predicates: { ...sim.predicates, [id]: truth } }
  if (!sim.initialized || !truth || conditionState(sim, id) !== 'running' || !connectedToStart(flow).has(id)) return base
  const next = begin(flow, sim, base, forward(flow, id, 'output', A), { label: '条件变真', nodeId: id })
  return deferred ? next : drainSignals(flow, next)
}
/** Instance outcome injection only: no goal execution, counters or UI tracking here. */
export function settleObjective(flow: ProgressFlow, sim: FlowSimState, id: string, outcome: 'succeeded' | 'failed', deferred = false): FlowSimState {
  if (outcome === 'succeeded' && getObjectiveNode(flow, id)?.submission) return sim
  return reportObjectiveOutcome(flow, sim, id, outcome, deferred)
}
/** External submission outcome, not execution of the goal or its delivery hook. A rejected attempt is retryable. */
export function submitObjective(flow: ProgressFlow, sim: FlowSimState, id: string, accepted: boolean, deferred = false): FlowSimState {
  if (!getObjectiveNode(flow, id)?.submission || objectiveState(sim, id) !== 'running' || !sim.initialized || !connectedToStart(flow).has(id) || !canTrigger(sim)) return sim
  if (accepted) return reportObjectiveOutcome(flow, sim, id, 'succeeded', deferred)
  const next = begin(flow, sim, sim, [], { label: '提交未成功（可重试，不发信号）', nodeId: id })
  return deferred ? next : drainSignals(flow, next)
}
function reportObjectiveOutcome(flow: ProgressFlow, sim: FlowSimState, id: string, outcome: 'succeeded' | 'failed', deferred: boolean): FlowSimState {
  if (!canTrigger(sim) || !sim.initialized || !connectedToStart(flow).has(id) || !getObjectiveNode(flow, id) || objectiveState(sim, id) !== 'running') return sim
  const base = { ...sim, objectives: { ...sim.objectives, [id]: outcome } }
  const next = begin(flow, sim, base, forward(flow, id, outcome === 'succeeded' ? 'output' : 'output2', A), { label: outcome === 'succeeded' ? '目标结算成功' : '目标结算失败', nodeId: id })
  return deferred ? next : drainSignals(flow, next)
}
/** Debug injection has the same terminal, draft and safety boundaries. */
export function injectSignal(flow: ProgressFlow, sim: FlowSimState, to: string, port: FlowPort, signal: FlowSignal, deferred = false): FlowSimState {
  if (!connectedToStart(flow).has(to)) return sim
  return propagateSignals(flow, sim, [{ signal, to, port, from: null }], deferred)
}


/** Diagnostics never participate in scheduling or business state. Trimmed parents remain explicit. */
export function traceIndex(sim: FlowSimState): Map<number, SimDelivery | Delivery> {
  const index = new Map<number, SimDelivery | Delivery>()
  for (const delivery of [...sim.queue, ...sim.discarded, ...sim.log]) if (delivery.traceId !== undefined) index.set(delivery.traceId, delivery)
  return index
}
export function traceParents(delivery: Delivery): number[] {
  return [...new Set([...(delivery.parentId == null ? [] : [delivery.parentId]), ...(delivery.causes ?? [])])]
}
