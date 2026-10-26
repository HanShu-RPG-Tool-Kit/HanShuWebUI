import { FLOW_LIMITS, orderedLinks, validateFlow, connectedToStart, getEndNode, getPredicateNode, getProgressNode, getTransitionNode, linkSourcePort, type FlowPort, type ProgressFlow } from './model'

/** 进度持有阶段状态；唯一终局锁存在 quest 实例上，查询轮次仅为执行簿记。 */
export const PROGRESS_STATES = {
  inactive: '未激活',
  running: '运行中',
  succeeded: '已成功',
  failed: '已失败',
  cancelled: '已取消',
  terminated: '随任务结束',
} as const
export type ProgressState = keyof typeof PROGRESS_STATES

/**
 * 线上只有四种信号：
 * - A activate：顺流。「我被激活 / 我成立 / 这是我的结局」
 * - Q query：逆流。「你现在是什么状态？」
 * - C cancel：逆流。「这个消费者不要你了」
 * - N none：逆流。「对 Q 的否定应答」；也是任何未特别说明节点的默认回应
 */
export type FlowSignal = { kind: 'activate' } | { kind: 'query' } | { kind: 'cancel' } | { kind: 'none' }
export const SIGNAL_LABELS: Record<FlowSignal['kind'], string> = { activate: 'A', query: 'Q', cancel: 'C', none: 'N' }

export type SimDelivery = {
  from: string | null
  to: string
  port: FlowPort
  link?: string
  round?: number
  signal: FlowSignal
  accepted: boolean
  reason?: string
}

/**
 * 变迁一轮查询的临时簿记：轮次编号让"对上一轮的迟到应答"不会开启新的一轮。
 * 它只在模拟器内存里，不落盘。
 */
export type TransitionRound = { open: boolean; id: number; answered: Record<string, 'activate' | 'none'> }

export type FlowSimState = {
  progress: Record<string, ProgressState>
  predicates: Record<string, boolean>
  rounds: Record<string, TransitionRound>
  ends: Record<string, 'success' | 'failure' | null>
  log: SimDelivery[]
  pulse: number
  /** 实例是否已初始化；初始化之前改谓词真值只是「预置」，不广播。 */
  initialized: boolean
  outcome: { endId: string; result: 'success' | 'failure' } | null
  queue: Delivery[]
  discarded: (Delivery & { reason: string })[]
  last: { delivery: Delivery; emitted: Delivery[]; accepted: boolean; reason?: string; changes: { id: string; text: string }[] } | null
  fault: { code: string; message: string } | null
  execution: { checkpoint: RuntimeSnapshot; signature: string; processed: number; budget: number; seen: string[] } | null
}
type RuntimeSnapshot = Pick<FlowSimState, 'progress' | 'predicates' | 'rounds' | 'ends' | 'outcome' | 'initialized'>

export type Delivery = { signal: FlowSignal; to: string; port: FlowPort; link?: string; round?: number; from: string | null }

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
export function transitionRound(sim: FlowSimState, id: string): TransitionRound {
  return Object.hasOwn(sim.rounds, id) ? sim.rounds[id] : emptyRound()
}
export function endOutcome(sim: FlowSimState, id: string): 'success' | 'failure' | null {
  return Object.hasOwn(sim.ends, id) ? sim.ends[id] : null
}

export function createSimState(flow: ProgressFlow): FlowSimState {
  const progress: Record<string, ProgressState> = {}
  const predicates: Record<string, boolean> = {}
  const rounds: Record<string, TransitionRound> = {}
  const ends: Record<string, 'success' | 'failure' | null> = {}
  for (const id of Object.keys(flow.progress)) progress[id] = 'inactive'
  for (const id of Object.keys(flow.predicates ?? {})) predicates[id] = false
  for (const id of Object.keys(flow.transitions ?? {})) rounds[id] = emptyRound()
  for (const id of Object.keys(flow.ends ?? {})) ends[id] = null
  return { progress, predicates, rounds, ends, log: [], pulse: 0, initialized: false, outcome: null, queue: [], discarded: [], last: null, fault: null, execution: null }
}

/** Drop removed nodes; keep surviving runtime state when the graph is edited. */
export function syncSimState(sim: FlowSimState, flow: ProgressFlow): FlowSimState {
  const progress: Record<string, ProgressState> = {}
  const predicates: Record<string, boolean> = {}
  const rounds: Record<string, TransitionRound> = {}
  const ends: Record<string, 'success' | 'failure' | null> = {}
  for (const id of Object.keys(flow.progress)) progress[id] = Object.hasOwn(sim.progress, id) ? sim.progress[id] : 'inactive'
  for (const id of Object.keys(flow.predicates ?? {})) predicates[id] = Object.hasOwn(sim.predicates, id) ? sim.predicates[id] : false
  for (const id of Object.keys(flow.transitions ?? {})) rounds[id] = Object.hasOwn(sim.rounds, id) ? sim.rounds[id] : emptyRound()
  for (const id of Object.keys(flow.ends ?? {})) ends[id] = Object.hasOwn(sim.ends, id) ? sim.ends[id] : null
  const same = (a: object, b: object) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key))
  if (same(sim.progress, progress) && same(sim.predicates, predicates) && same(sim.rounds, rounds) && same(sim.ends, ends)) return sim
  return { ...sim, progress, predicates, rounds, ends }
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
function queryRound(flow: ProgressFlow, id: string, round: number): Delivery[] {
  return [...backward(flow, id, 'input', Q), ...backward(flow, id, 'input2', Q)]
    .map(delivery => ({ ...delivery, round }))
}
/** 对 Q 的应答沿同一通道送回发起方。 */
function reply(flow: ProgressFlow, delivery: Delivery, signal: FlowSignal): Delivery[] {
  const link = (flow.logic?.links ?? []).find(item => item.id === delivery.link)
  return link ? [{ signal, to: link.to, port: link.port, link: link.id, round: delivery.round, from: link.from }] : []
}

function accept(sim: FlowSimState, delivery: Delivery): void {
  sim.log.push({ from: delivery.from, to: delivery.to, port: delivery.port, link: delivery.link, round: delivery.round, signal: delivery.signal, accepted: true })
}
function reject(sim: FlowSimState, delivery: Delivery, reason: string): void {
  sim.log.push({ from: delivery.from, to: delivery.to, port: delivery.port, link: delivery.link, round: delivery.round, signal: delivery.signal, accepted: false, reason })
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
    return reply(flow, delivery, predicateTruth(sim, id) ? A : N)
  }
  if (delivery.signal.kind === 'cancel') { accept(sim, delivery); return [] }
  reject(sim, delivery, '谓词没有左端口，只接受查询')
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
  accept(sim, delivery)
  return []
}

/** 一轮问答收齐后判定：非空端口都要满足；合取=全部 A，析取=任一 A。 */
function settleRound(flow: ProgressFlow, sim: FlowSimState, id: string): Delivery[] {
  const incoming = (flow.logic?.links ?? []).filter(link => link.to === id)
  const round = transitionRound(sim, id)
  if (!round.open || !incoming.every(link => Object.hasOwn(round.answered, link.id))) return []
  const conj = incoming.filter(link => link.port === 'input')
  const disj = incoming.filter(link => link.port === 'input2')
  const conjOk = conj.length === 0 || conj.every(link => round.answered[link.id] === 'activate')
  const disjOk = disj.length === 0 || disj.some(link => round.answered[link.id] === 'activate')
  sim.rounds[id] = { open: false, id: round.id, answered: {} }
  if (!conjOk || !disjOk) return []
  return [
    ...forward(flow, id, 'output', A),
    ...backward(flow, id, 'input', C),
    ...backward(flow, id, 'input2', C),
  ]
}

function deliverTransition(flow: ProgressFlow, sim: FlowSimState, delivery: Delivery, id: string): Delivery[] {
  if (delivery.signal.kind === 'query') {
    accept(sim, delivery)
    return reply(flow, delivery, N)
  }
  if (delivery.signal.kind === 'cancel') {
    accept(sim, delivery)
    const round = transitionRound(sim, id)
    sim.rounds[id] = { open: false, id: round.id, answered: {} }
    return [...backward(flow, id, 'input', C), ...backward(flow, id, 'input2', C)]
  }
  const round = transitionRound(sim, id)
  if (delivery.signal.kind === 'activate') {
    if (delivery.port !== 'input' && delivery.port !== 'input2') { reject(sim, delivery, '变迁只从左端口接收 A'); return [] }
    if (delivery.round !== undefined) {
      // 对某轮 Q 的应答；过期轮次直接吞掉，不能开新一轮。
      if (!round.open || round.id !== delivery.round) { reject(sim, delivery, '过期查询应答，不启动新轮次'); return [] }
      if (delivery.link && Object.hasOwn(round.answered, delivery.link)) { reject(sim, delivery, '本轮该连线已有应答'); return [] }
      if (delivery.link && !Object.hasOwn(round.answered, delivery.link)) round.answered[delivery.link] = 'activate'
      accept(sim, delivery)
      return settleRound(flow, sim, id)
    }
    if (!round.open) {
      const answered: Record<string, 'activate' | 'none'> = delivery.link ? { [delivery.link]: 'activate' } : {}
      const next: TransitionRound = { open: true, id: round.id + 1, answered }
      sim.rounds[id] = next
      accept(sim, delivery)
      // 没有非触发器入线时（例如开始直接连变迁），这一轮当场判定，不需要等应答。
      return [...queryRound(flow, id, next.id), ...settleRound(flow, sim, id)]
    }
    if (delivery.link && !Object.hasOwn(round.answered, delivery.link)) round.answered[delivery.link] = 'activate'
    accept(sim, delivery)
    return settleRound(flow, sim, id)
  }
  if (delivery.signal.kind === 'none') {
    if (delivery.round === undefined) { reject(sim, delivery, '没有查询轮次的 N'); return [] }
    if (!round.open || round.id !== delivery.round) { reject(sim, delivery, '过期查询应答，不启动新轮次'); return [] }
      if (delivery.link && Object.hasOwn(round.answered, delivery.link)) { reject(sim, delivery, '本轮该连线已有应答'); return [] }
    if (delivery.link && !Object.hasOwn(round.answered, delivery.link)) round.answered[delivery.link] = 'none'
    accept(sim, delivery)
    return settleRound(flow, sim, id)
  }
  return []
}

function deliverOne(flow: ProgressFlow, sim: FlowSimState, delivery: Delivery): Delivery[] {
  if (getProgressNode(flow, delivery.to)) return deliverProgress(flow, sim, delivery, delivery.to)
  if (getPredicateNode(flow, delivery.to)) return deliverPredicate(flow, sim, delivery, delivery.to)
  if (getTransitionNode(flow, delivery.to)) return deliverTransition(flow, sim, delivery, delivery.to)
  if (getEndNode(flow, delivery.to)) return deliverEnd(sim, delivery, delivery.to)
  reject(sim, delivery, '目标节点不存在')
  return []
}

/** A pulse is atomic with respect to external events; animation never owns execution. */
function snapshot(sim: FlowSimState): RuntimeSnapshot {
  return structuredClone({ progress: sim.progress, predicates: sim.predicates, rounds: sim.rounds, ends: sim.ends, outcome: sim.outcome, initialized: sim.initialized })
}
const signature = (flow: ProgressFlow) => JSON.stringify([flow.start, flow.progress, flow.predicates, flow.transitions, flow.ends, orderedLinks(flow)])
export const isBusy = (sim: FlowSimState) => sim.queue.length > 0
export const canTrigger = (sim: FlowSimState) => !isBusy(sim) && !sim.outcome && !sim.fault
function fail(sim: FlowSimState, code: string, message: string) {
  if (sim.execution) Object.assign(sim, structuredClone(sim.execution.checkpoint))
  sim.discarded.push(...sim.queue.map(delivery => ({ ...delivery, reason: '传播故障，状态已回退' })))
  sim.queue = []; sim.fault = { code, message }; sim.execution = null
}
function begin(flow: ProgressFlow, sim: FlowSimState, base: FlowSimState, seeds: Delivery[]): FlowSimState {
  if (!canTrigger(sim)) return sim
  const next = structuredClone(base)
  next.log = next.log.slice(-4000); next.pulse = sim.pulse + 1; next.last = null; next.discarded = []
  const nodes = Object.keys(flow.progress).length + Object.keys(flow.predicates ?? {}).length + Object.keys(flow.transitions ?? {}).length + Object.keys(flow.ends ?? {}).length
  const budget = Math.min(FLOW_LIMITS.deliveries, Math.max(512, (flow.logic?.links.length ?? 0) * 128 + nodes * 32))
  next.execution = { checkpoint: snapshot(sim), signature: signature(flow), processed: 0, budget, seen: [] }
  next.queue = seeds
  const errors = validateFlow(flow).filter(issue => issue.severity === 'error')
  if (errors.length) fail(next, 'invalid-graph', errors[0].message)
  else if (seeds.length > budget) fail(next, 'budget-exceeded', `初始队列超过 ${budget} 条预算。`)
  else if (!seeds.length) next.execution = null
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
  const beforeProgress = { ...next.progress }, beforeRound = JSON.stringify(next.rounds[delivery.to]), previousLog = next.log.length
  // Repeated inverse cancellation in a diamond must not expand exponentially.
  // A newly changed progress state / transition round is a distinct cancellation target.
  const key = JSON.stringify([delivery.to, delivery.port, progressState(next, delivery.to), transitionRound(next, delivery.to).id])
  let emitted: Delivery[] = []
  if (delivery.signal.kind === 'cancel' && run.seen.includes(key)) reject(next, delivery, '本次传播已处理相同状态的取消')
  else {
    if (delivery.signal.kind === 'cancel') run.seen.push(key)
    emitted = deliverOne(flow, next, delivery)
  }
  const entry = next.log[previousLog]
  const changes = Object.keys(next.progress).filter(id => beforeProgress[id] !== next.progress[id]).map(id => ({ id, text: `${PROGRESS_STATES[beforeProgress[id]]} → ${PROGRESS_STATES[next.progress[id]]}` }))
  if (beforeRound !== JSON.stringify(next.rounds[delivery.to])) changes.push({ id: delivery.to, text: '查询轮次更新' })
  next.last = { delivery, emitted, accepted: entry?.accepted ?? false, reason: entry?.reason, changes }
  if (next.outcome) {
    next.discarded.push(...next.queue.map(item => ({ ...item, reason: '任务已结束，不再投递' })))
    next.queue = []; next.execution = null
  } else if (run.processed + next.queue.length + emitted.length > run.budget) {
    next.queue.push(...emitted); fail(next, 'budget-exceeded', `信号队列超过 ${run.budget} 条预算；本次事件的业务状态已回退。`)
  } else {
    next.queue.push(...emitted)
    if (!next.queue.length) next.execution = null
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
  return next
}
export function propagateSignals(flow: ProgressFlow, sim: FlowSimState, seeds: Delivery[], deferred = false): FlowSimState {
  if (!canTrigger(sim)) return sim
  const next = begin(flow, sim, sim, seeds)
  return deferred ? next : drainSignals(flow, next)
}
export function initializeQuest(flow: ProgressFlow, sim: FlowSimState, deferred = false): FlowSimState {
  if (sim.initialized || !canTrigger(sim) || !getProgressNode(flow, flow.start)) return sim
  const base = { ...sim, initialized: true, progress: { ...sim.progress, [flow.start]: 'running' as const } }
  const effective = connectedToStart(flow)
  const seeds = Object.keys(flow.predicates ?? {}).filter(id => effective.has(id) && predicateTruth(sim, id)).sort().flatMap(id => forward(flow, id, 'output', A))
  const next = begin(flow, sim, base, seeds)
  return deferred ? next : drainSignals(flow, next)
}
export function settleProgress(flow: ProgressFlow, sim: FlowSimState, id: string, outcome: 'succeeded' | 'failed', deferred = false): FlowSimState {
  if (!canTrigger(sim) || !sim.initialized || !connectedToStart(flow).has(id) || !getProgressNode(flow, id) || progressState(sim, id) !== 'running') return sim
  const port: FlowPort = outcome === 'succeeded' ? 'output' : 'output2'
  const base = { ...sim, progress: { ...sim.progress, [id]: outcome } }
  const next = begin(flow, sim, base, forward(flow, id, port, A))
  return deferred ? next : drainSignals(flow, next)
}
export function setPredicateTruth(flow: ProgressFlow, sim: FlowSimState, id: string, truth: boolean, deferred = false): FlowSimState {
  if (!canTrigger(sim) || !getPredicateNode(flow, id) || predicateTruth(sim, id) === truth) return sim
  const base = { ...sim, predicates: { ...sim.predicates, [id]: truth } }
  if (!sim.initialized || !truth || !connectedToStart(flow).has(id)) return base
  const next = begin(flow, sim, base, forward(flow, id, 'output', A))
  return deferred ? next : drainSignals(flow, next)
}
/** Debug injection has the same terminal, draft and safety boundaries. */
export function injectSignal(flow: ProgressFlow, sim: FlowSimState, to: string, port: FlowPort, signal: FlowSignal, deferred = false): FlowSimState {
  if (!connectedToStart(flow).has(to)) return sim
  return propagateSignals(flow, sim, [{ signal, to, port, from: null }], deferred)
}
