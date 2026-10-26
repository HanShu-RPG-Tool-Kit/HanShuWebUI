import { connectedToStart, getEndNode, getPredicateNode, getProgressNode, getTransitionNode, linkSourcePort, type FlowPort, type ProgressFlow } from './model'

/** 进度节点是唯一有持久运行状态的节点；其余节点没有跨事件的业务状态。 */
export const PROGRESS_STATES = {
  inactive: '未激活',
  running: '运行中',
  succeeded: '已成功',
  failed: '已失败',
  cancelled: '已取消',
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
}

type Delivery = { signal: FlowSignal; to: string; port: FlowPort; link?: string; round?: number; from: string | null }

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
  return { progress, predicates, rounds, ends, log: [], pulse: 0, initialized: false }
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
  return (flow.logic?.links ?? [])
    .filter(link => link.from === from && linkSourcePort(flow, link.from, link.fromPort) === port)
    .map(link => ({ signal, to: link.to, port: link.port, link: link.id, from }))
}
/** 逆流：沿连到 from 的该端口的入线，回到上游节点的输出端口。 */
function backward(flow: ProgressFlow, from: string, port: FlowPort, signal: FlowSignal): Delivery[] {
  return (flow.logic?.links ?? [])
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
  sim.log.push({ from: delivery.from, to: delivery.to, port: delivery.port, link: delivery.link, signal: delivery.signal, accepted: true })
}
function reject(sim: FlowSimState, delivery: Delivery, reason: string): void {
  sim.log.push({ from: delivery.from, to: delivery.to, port: delivery.port, link: delivery.link, signal: delivery.signal, accepted: false, reason })
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
  if (delivery.signal.kind !== 'activate') { reject(sim, delivery, '结束节点只接受 A'); return [] }
  sim.ends[id] = delivery.port === 'input2' ? 'failure' : 'success'
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
      if (!round.open || round.id !== delivery.round) { accept(sim, delivery); return [] }
      if (delivery.link) round.answered[delivery.link] = 'activate'
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
    if (delivery.link) round.answered[delivery.link] = 'activate'
    accept(sim, delivery)
    return settleRound(flow, sim, id)
  }
  if (delivery.signal.kind === 'none') {
    if (delivery.round === undefined) { reject(sim, delivery, '没有查询轮次的 N'); return [] }
    if (!round.open || round.id !== delivery.round) { accept(sim, delivery); return [] }
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

/** Propagate signals through wires until the queue drains. */
export function propagateSignals(flow: ProgressFlow, sim: FlowSimState, seeds: Delivery[]): FlowSimState {
  const next: FlowSimState = {
    progress: { ...sim.progress },
    predicates: { ...sim.predicates },
    rounds: Object.fromEntries(Object.entries(sim.rounds).map(([id, round]) => [id, { open: round.open, id: round.id, answered: { ...round.answered } }])),
    ends: { ...sim.ends },
    log: [...sim.log],
    pulse: sim.pulse + 1,
    initialized: sim.initialized,
  }
  const queue = [...seeds]
  const nodeCount = Object.keys(flow.progress).length + Object.keys(flow.predicates ?? {}).length + Object.keys(flow.transitions ?? {}).length + Object.keys(flow.ends ?? {}).length
  const guard = Math.max(64, nodeCount * 32 + 32)
  for (let i = 0; i < queue.length && i < guard; i++) queue.push(...deliverOne(flow, next, queue[i]))
  return next
}

/**
 * 初始化 quest 实例（首次接取或 load）：
 * 1. 开始进度节点进入运行中；
 * 2. 对每个生效谓词按当前真值整体求值；
 * 3. 按节点 ID 的稳定顺序，为真值谓词各广播一次 A；
 * 4. 运行信号队列。
 * 只广播一次；之后谓词只在 假→真 的上升沿增量广播。
 */
export function initializeQuest(flow: ProgressFlow, sim: FlowSimState): FlowSimState {
  if (sim.initialized || !getProgressNode(flow, flow.start)) return sim
  const base: FlowSimState = {
    ...sim,
    initialized: true,
    progress: { ...sim.progress, [flow.start]: 'running' },
    log: [...sim.log, { from: flow.start, to: flow.start, port: 'input' as FlowPort, signal: A, accepted: true }],
  }
  const effective = connectedToStart(flow)
  const seeds = Object.keys(flow.predicates ?? {})
    .filter(id => effective.has(id) && predicateTruth(sim, id))
    .sort()
    .flatMap(id => forward(flow, id, 'output', A))
  if (!seeds.length) return { ...base, pulse: sim.pulse + 1 }
  return propagateSignals(flow, base, seeds)
}

/** 模拟器手动结算：只有运行中的进度能结算，成功/失败从对应端口发 A。 */
export function settleProgress(flow: ProgressFlow, sim: FlowSimState, id: string, outcome: 'succeeded' | 'failed'): FlowSimState {
  if (!getProgressNode(flow, id)) return sim
  if (progressState(sim, id) !== 'running') return sim
  const port: FlowPort = outcome === 'succeeded' ? 'output' : 'output2'
  const next = {
    ...sim,
    progress: { ...sim.progress, [id]: outcome },
    log: [...sim.log, { from: id, to: id, port, signal: A, accepted: true }],
  }
  return propagateSignals(flow, next, forward(flow, id, port, A))
}

/**
 * 模拟器手动改谓词真值。
 * 初始化之前只算「预置」，不发信号；初始化之后只在 假→真 的上升沿广播 A。
 */
export function setPredicateTruth(flow: ProgressFlow, sim: FlowSimState, id: string, truth: boolean): FlowSimState {
  if (!getPredicateNode(flow, id)) return sim
  const was = predicateTruth(sim, id)
  if (was === truth) return sim
  const next = { ...sim, predicates: { ...sim.predicates, [id]: truth } }
  if (!sim.initialized || !truth) return next
  return propagateSignals(flow, next, forward(flow, id, 'output', A))
}

/** 测试 / 工具：向某节点注入任意信号。 */
export function injectSignal(flow: ProgressFlow, sim: FlowSimState, to: string, port: FlowPort, signal: FlowSignal): FlowSimState {
  return propagateSignals(flow, sim, [{ signal, to, port, from: null }])
}
