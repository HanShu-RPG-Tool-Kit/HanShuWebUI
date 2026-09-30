import { getConditionalNode, getDiffNode, getGoalNode, getMergeNode, getNode, getPredicateNode, getSwapNode, getTransitionNode, isOutputPort, linkSourcePort, parseSwapInIndex, parseSwapOutIndex, swapInPort, swapOutPort, type FlowInputPort, type FlowPort, type ProgressFlow } from './model'

/** Checkpoint runtime states. Authoring document does not store these. */
export const CKPT_STATES = {
  inactive: '未激活',
  active: '活跃中',
  activated: '已激活',
  cancelled: '已取消',
} as const
export type CkptState = keyof typeof CKPT_STATES

/** Goal runtime states. */
export const GOAL_STATES = {
  inactive: '未激活',
  subscribed: '订阅中',
  closed: '已关闭',
} as const
export type GoalState = keyof typeof GOAL_STATES
export const PREDICATE_STATES = GOAL_STATES
export type PredicateState = GoalState

/**
 * Signals on wires:
 * - S = ckpt-transition
 * - A = activation
 * - G = goal-complete（线性变迁 Goal 合取）
 * - G-Y = goal-yes（差分变迁成功）
 * - G-N = goal-no（差分变迁失败）
 * - P = predicate-complete（条件变迁谓词）
 * - D = cancel
 * - C = query
 * - C-R = query-response
 * - S-C = cancel-cascade（任一 ckpt 进入已激活时从 S 入点发出）
 * - G-C = goal-cancel-cascade（活跃中 ckpt 收到 S-C 后从 S 入点发出）
 */
export type FlowSignal =
  | { kind: 'ckpt-transition'; from: CkptState; to: CkptState }
  | { kind: 'activation' }
  | { kind: 'goal-complete' }
  | { kind: 'goal-yes' }
  | { kind: 'goal-no' }
  | { kind: 'predicate-complete' }
  | { kind: 'cancel' }
  | { kind: 'query' }
  | { kind: 'query-response' }
  | { kind: 'cancel-cascade' }
  | { kind: 'goal-cancel-cascade' }

export type SimDelivery = {
  from: string | null
  to: string
  port: FlowPort
  signal: FlowSignal
  accepted: boolean
  reason?: string
}

/** Per merge / linear-Goal query round: which upstream sources must still return C-R. */
export type MergeSimState = { awaiting: string[]; reported: string[] }
export type TransitionSimState = MergeSimState

export type FlowSimState = {
  ckpt: Record<string, CkptState>
  goals: Record<string, GoalState>
  predicates: Record<string, PredicateState>
  merges: Record<string, MergeSimState>
  transitions: Record<string, TransitionSimState>
  log: SimDelivery[]
  pulse: number
}

export type SignalSeed = { from: string | null; to: string; port: FlowPort; signal: FlowSignal }
type Emit = { from: string; via: FlowPort; signal: FlowSignal; onlyTo?: string }
type SimPatch = Partial<Pick<FlowSimState, 'ckpt' | 'goals' | 'predicates' | 'merges' | 'transitions'>>

export const START_SIGNAL: FlowSignal = { kind: 'ckpt-transition', from: 'inactive', to: 'activated' }
export const SIGNAL_LABELS: Record<FlowSignal['kind'], string> = {
  'ckpt-transition': 'S',
  activation: 'A',
  'goal-complete': 'G',
  'goal-yes': 'G-Y',
  'goal-no': 'G-N',
  'predicate-complete': 'P',
  cancel: 'D',
  query: 'C',
  'query-response': 'C-R',
  'cancel-cascade': 'S-C',
  'goal-cancel-cascade': 'G-C',
}

export function ckptState(sim: FlowSimState, id: string): CkptState {
  return Object.hasOwn(sim.ckpt, id) ? sim.ckpt[id] : 'inactive'
}
export function goalState(sim: FlowSimState, id: string): GoalState {
  return Object.hasOwn(sim.goals, id) ? sim.goals[id] : 'inactive'
}
export function predicateState(sim: FlowSimState, id: string): PredicateState {
  return Object.hasOwn(sim.predicates, id) ? sim.predicates[id] : 'inactive'
}
export function mergeSim(sim: FlowSimState, id: string): MergeSimState {
  return Object.hasOwn(sim.merges, id) ? sim.merges[id] : { awaiting: [], reported: [] }
}
export function transitionSim(sim: FlowSimState, id: string): TransitionSimState {
  return Object.hasOwn(sim.transitions, id) ? sim.transitions[id] : { awaiting: [], reported: [] }
}

export function createSimState(flow: ProgressFlow): FlowSimState {
  const ckpt: Record<string, CkptState> = {}
  const goals: Record<string, GoalState> = {}
  const predicates: Record<string, PredicateState> = {}
  const merges: Record<string, MergeSimState> = {}
  const transitions: Record<string, TransitionSimState> = {}
  for (const id of Object.keys(flow.nodes)) ckpt[id] = 'inactive'
  for (const id of Object.keys(flow.goals ?? {})) goals[id] = 'inactive'
  for (const id of Object.keys(flow.predicates ?? {})) predicates[id] = 'inactive'
  for (const id of Object.keys(flow.merges ?? {})) merges[id] = { awaiting: [], reported: [] }
  for (const id of Object.keys(flow.transitions ?? {})) transitions[id] = { awaiting: [], reported: [] }
  return { ckpt, goals, predicates, merges, transitions, log: [], pulse: 0 }
}

/** Drop removed nodes; keep surviving runtime state when the graph is edited. */
export function syncSimState(sim: FlowSimState, flow: ProgressFlow): FlowSimState {
  const ckpt: Record<string, CkptState> = {}
  const goals: Record<string, GoalState> = {}
  const predicates: Record<string, PredicateState> = {}
  const merges: Record<string, MergeSimState> = {}
  const transitions: Record<string, TransitionSimState> = {}
  let changed = false
  for (const id of Object.keys(flow.nodes)) {
    ckpt[id] = Object.hasOwn(sim.ckpt, id) ? sim.ckpt[id] : 'inactive'
    if (!Object.hasOwn(sim.ckpt, id)) changed = true
  }
  for (const id of Object.keys(sim.ckpt)) if (!Object.hasOwn(flow.nodes, id)) changed = true
  for (const id of Object.keys(flow.goals ?? {})) {
    goals[id] = Object.hasOwn(sim.goals, id) ? sim.goals[id] : 'inactive'
    if (!Object.hasOwn(sim.goals, id)) changed = true
  }
  for (const id of Object.keys(sim.goals)) if (!Object.hasOwn(flow.goals ?? {}, id)) changed = true
  for (const id of Object.keys(flow.predicates ?? {})) {
    predicates[id] = Object.hasOwn(sim.predicates, id) ? sim.predicates[id] : 'inactive'
    if (!Object.hasOwn(sim.predicates, id)) changed = true
  }
  for (const id of Object.keys(sim.predicates ?? {})) if (!Object.hasOwn(flow.predicates ?? {}, id)) changed = true
  for (const id of Object.keys(flow.merges ?? {})) {
    merges[id] = Object.hasOwn(sim.merges, id) ? sim.merges[id] : { awaiting: [], reported: [] }
    if (!Object.hasOwn(sim.merges, id)) changed = true
  }
  for (const id of Object.keys(sim.merges)) if (!Object.hasOwn(flow.merges ?? {}, id)) changed = true
  for (const id of Object.keys(flow.transitions ?? {})) {
    transitions[id] = Object.hasOwn(sim.transitions, id) ? sim.transitions[id] : { awaiting: [], reported: [] }
    if (!Object.hasOwn(sim.transitions, id)) changed = true
  }
  for (const id of Object.keys(sim.transitions)) if (!Object.hasOwn(flow.transitions ?? {}, id)) changed = true
  if (!changed
    && Object.keys(sim.ckpt).length === Object.keys(ckpt).length
    && Object.keys(sim.goals).length === Object.keys(goals).length
    && Object.keys(sim.predicates ?? {}).length === Object.keys(predicates).length
    && Object.keys(sim.merges).length === Object.keys(merges).length
    && Object.keys(sim.transitions).length === Object.keys(transitions).length) return sim
  return { ...sim, ckpt, goals, predicates, merges, transitions }
}

export function resetSimState(flow: ProgressFlow): FlowSimState {
  return createSimState(flow)
}

/** Forward outgoing wire endpoints from a node (entry uses its single target). */
export function outgoingSignalTargets(flow: ProgressFlow, from: string, via: FlowPort = 'output'): { to: string; port: FlowInputPort }[] {
  return emitTargets(flow, from, via, START_SIGNAL)
    .filter(seed => seed.port === 'input' || seed.port === 'input2')
    .map(seed => ({ to: seed.to, port: seed.port as FlowInputPort }))
}

/**
 * Resolve emit targets for a port.
 * Output ports follow wires forward; input ports emit back along incoming wires (Goal / 合并入点 / Parent).
 * onlyTo limits reverse fan-out to a single upstream source (e.g. D back to the Goal that just sent G).
 */
export function emitTargets(flow: ProgressFlow, from: string, via: FlowPort, signal: FlowSignal, onlyTo?: string): SignalSeed[] {
  if (isOutputPort(via)) {
    if (from === flow.entry.id) {
      if (via !== 'output' || flow.entry.target === null) return []
      return [{ from, to: flow.entry.target, port: flow.entry.port ?? 'input', signal }]
    }
    const seeds: SignalSeed[] = []
    for (const branch of getNode(flow, from)?.children ?? []) {
      if (via === 'output') seeds.push({ from, to: branch.target, port: 'input', signal })
    }
    for (const link of flow.logic?.links ?? []) {
      if (link.from === from && linkSourcePort(flow, link.from, link.to, link.port, link.fromPort) === via) {
        seeds.push({ from, to: link.to, port: link.port, signal })
      }
    }
    return seeds
  }
  const seeds: SignalSeed[] = []
  for (const link of flow.logic?.links ?? []) {
    if (link.to === from && link.port === via) {
      if (onlyTo && link.from !== onlyTo) continue
      seeds.push({ from, to: link.from, port: 'output', signal })
    }
  }
  return seeds
}

function reject(sim: FlowSimState, from: string | null, to: string, port: FlowPort, signal: FlowSignal, reason: string): { sim: FlowSimState; emit: Emit[] } {
  return { sim: { ...sim, log: [...sim.log, { from, to, port, signal, accepted: false, reason }] }, emit: [] }
}

function accept(sim: FlowSimState, from: string | null, to: string, port: FlowPort, signal: FlowSignal, patch: SimPatch, emit: Emit[]): { sim: FlowSimState; emit: Emit[] } {
  return {
    sim: {
      ...sim,
      ckpt: patch.ckpt ?? sim.ckpt,
      goals: patch.goals ?? sim.goals,
      predicates: patch.predicates ?? sim.predicates,
      merges: patch.merges ?? sim.merges,
      transitions: patch.transitions ?? sim.transitions,
      log: [...sim.log, { from, to, port, signal, accepted: true }],
    },
    emit,
  }
}

function incomingSources(flow: ProgressFlow, id: string, port: FlowInputPort = 'input') {
  return (flow.logic?.links ?? []).filter(link => link.to === id && link.port === port).map(link => link.from)
}

function deliverCkpt(flow: ProgressFlow, sim: FlowSimState, from: string | null, to: string, port: FlowPort, signal: FlowSignal) {
  // Query C arrives on the ckpt output socket (reverse wire from 合并变迁).
  if (signal.kind === 'query') {
    if (port !== 'output') return reject(sim, from, to, port, signal, '查询信号 C 应到达 checkpoint 出点')
    if (ckptState(sim, to) !== 'activated') return reject(sim, from, to, port, signal, `checkpoint 当前为「${CKPT_STATES[ckptState(sim, to)]}」，未已激活则不回报 C-R`)
    return accept(sim, from, to, port, signal, {}, [{ from: to, via: 'output', signal: { kind: 'query-response' } }])
  }
  // S-C:
  // - 入点收到：不转发（活跃中仍取消并发 G-C；未激活只吞掉）
  // - 其它端口（通常出点回灌）：活跃中→已取消并发 G-C；未激活只转发、不改自身状态
  if (signal.kind === 'cancel-cascade') {
    const current = ckptState(sim, to)
    if (port === 'input') {
      if (current === 'active') {
        return accept(sim, from, to, port, signal, { ckpt: { ...sim.ckpt, [to]: 'cancelled' } }, [
          { from: to, via: 'input', signal: { kind: 'goal-cancel-cascade' } },
        ])
      }
      if (current === 'inactive') return accept(sim, from, to, port, signal, {}, [])
      return reject(sim, from, to, port, signal, `checkpoint 当前为「${CKPT_STATES[current]}」，入点忽略 S-C`)
    }
    if (current === 'active') {
      return accept(sim, from, to, port, signal, { ckpt: { ...sim.ckpt, [to]: 'cancelled' } }, [
        { from: to, via: 'input', signal: { kind: 'goal-cancel-cascade' } },
      ])
    }
    if (current === 'inactive') {
      return accept(sim, from, to, port, signal, {}, [
        { from: to, via: 'input', signal: { kind: 'cancel-cascade' } },
      ])
    }
    return reject(sim, from, to, port, signal, `checkpoint 当前为「${CKPT_STATES[current]}」，忽略 S-C`)
  }
  if (signal.kind !== 'ckpt-transition') return reject(sim, from, to, port, signal, 'checkpoint 入点只接受状态转移信号 S')
  const current = ckptState(sim, to)
  if (current !== signal.from) return reject(sim, from, to, port, signal, `当前为「${CKPT_STATES[current]}」，与信号原状态「${CKPT_STATES[signal.from]}」不符`)
  const emit: Emit[] = []
  if (signal.to === 'activated') {
    emit.push({ from: to, via: 'output', signal: { kind: 'activation' } })
    // 从任意状态进入已激活：从 S 入点发出 S-C
    emit.push({ from: to, via: 'input', signal: { kind: 'cancel-cascade' } })
  }
  return accept(sim, from, to, port, signal, { ckpt: { ...sim.ckpt, [to]: signal.to } }, emit)
}

function deliverGoal(sim: FlowSimState, from: string | null, to: string, port: FlowPort, signal: FlowSignal) {
  const current = goalState(sim, to)
  // C arrives on Goal output (reverse wire from 线性变迁 Goal 合取询问)
  if (signal.kind === 'query') {
    if (port !== 'output') return reject(sim, from, to, port, signal, '查询信号 C 应到达 Goal 出点')
    if (current !== 'closed') return reject(sim, from, to, port, signal, `Goal 当前为「${GOAL_STATES[current]}」，未关闭则不回报 C-R`)
    return accept(sim, from, to, port, signal, {}, [{ from: to, via: 'output', signal: { kind: 'query-response' } }])
  }
  if (signal.kind === 'activation') {
    if (current !== 'inactive') return reject(sim, from, to, port, signal, `Goal 当前为「${GOAL_STATES[current]}」，无法再订阅`)
    return accept(sim, from, to, port, signal, { goals: { ...sim.goals, [to]: 'subscribed' } }, [])
  }
  if (signal.kind === 'cancel') {
    if (current !== 'subscribed') return reject(sim, from, to, port, signal, `Goal 当前为「${GOAL_STATES[current]}」，无法关闭`)
    return accept(sim, from, to, port, signal, { goals: { ...sim.goals, [to]: 'closed' } }, [])
  }
  return reject(sim, from, to, port, signal, 'Goal 只接受激活信号 A、取消信号 D 与查询信号 C')
}

function deliverPredicate(sim: FlowSimState, from: string | null, to: string, port: FlowPort, signal: FlowSignal) {
  const current = predicateState(sim, to)
  if (signal.kind === 'activation') {
    if (current !== 'inactive') return reject(sim, from, to, port, signal, `Predicate 当前为「${PREDICATE_STATES[current]}」，无法再订阅`)
    return accept(sim, from, to, port, signal, { predicates: { ...sim.predicates, [to]: 'subscribed' } }, [])
  }
  if (signal.kind === 'cancel') {
    if (current !== 'subscribed') return reject(sim, from, to, port, signal, `Predicate 当前为「${PREDICATE_STATES[current]}」，无法关闭`)
    return accept(sim, from, to, port, signal, { predicates: { ...sim.predicates, [to]: 'closed' } }, [])
  }
  return reject(sim, from, to, port, signal, 'Predicate 只接受激活信号 A 与取消信号 D')
}

function deliverTransition(flow: ProgressFlow, sim: FlowSimState, from: string | null, to: string, port: FlowPort, signal: FlowSignal) {
  // Next 口收到 S-C → 转发到所有激活信号来源（Parent）
  if (signal.kind === 'cancel-cascade') {
    if (port !== 'output') return reject(sim, from, to, port, signal, '线性变迁从 Next 接收 S-C')
    return accept(sim, from, to, port, signal, {}, [{ from: to, via: 'input2', signal: { kind: 'cancel-cascade' } }])
  }
  // Next 口收到 G-C → 从 Goal 入点向全部 Goal 发出 D
  if (signal.kind === 'goal-cancel-cascade') {
    if (port !== 'output') return reject(sim, from, to, port, signal, '线性变迁从 Next 接收 G-C')
    return accept(sim, from, to, port, signal, {}, [{ from: to, via: 'input', signal: { kind: 'cancel' } }])
  }
  if (port === 'input2') {
    if (signal.kind !== 'activation') return reject(sim, from, to, port, signal, 'Parent 只接受激活信号 A')
    const goals = incomingSources(flow, to, 'input')
    const emit: Emit[] = [
      { from: to, via: 'output', signal: { kind: 'ckpt-transition', from: 'inactive', to: 'active' } },
      { from: to, via: 'input', signal: { kind: 'activation' } },
    ]
    // 无 Goal 线：空合取成立，直接推进 活跃中→已激活
    if (!goals.length) emit.push({ from: to, via: 'output', signal: { kind: 'ckpt-transition', from: 'active', to: 'activated' } })
    return accept(sim, from, to, port, signal, { transitions: { ...sim.transitions, [to]: { awaiting: [], reported: [] } } }, emit)
  }
  if (port === 'input') {
    if (signal.kind === 'goal-complete') {
      if (from === null) return reject(sim, from, to, port, signal, 'G 缺少来源')
      const awaiting = incomingSources(flow, to, 'input')
      const emit: Emit[] = [
        // 只关闭刚完成的 Goal，再向全部 Goal 发 C（与合并每次 A 重开查询一致）
        { from: to, via: 'input', signal: { kind: 'cancel' }, onlyTo: from },
        { from: to, via: 'input', signal: { kind: 'query' } },
      ]
      if (!awaiting.length) emit.push({ from: to, via: 'output', signal: { kind: 'ckpt-transition', from: 'active', to: 'activated' } })
      return accept(sim, from, to, port, signal, { transitions: { ...sim.transitions, [to]: { awaiting, reported: [] } } }, emit)
    }
    if (signal.kind === 'query-response') {
      if (from === null) return reject(sim, from, to, port, signal, 'C-R 缺少来源')
      const current = transitionSim(sim, to)
      if (!current.awaiting.length) return reject(sim, from, to, port, signal, '线性变迁当前没有进行中的 Goal 查询')
      if (!current.awaiting.includes(from)) return reject(sim, from, to, port, signal, '该来源不在本次查询名单中')
      if (current.reported.includes(from)) return reject(sim, from, to, port, signal, '该来源已回报过 C-R')
      const reported = [...current.reported, from]
      const done = current.awaiting.every(id => reported.includes(id))
      const nextQuery = done ? { awaiting: [], reported: [] } : { awaiting: current.awaiting, reported }
      const emit: Emit[] = done
        ? [{ from: to, via: 'output', signal: { kind: 'ckpt-transition', from: 'active', to: 'activated' } }]
        : []
      return accept(sim, from, to, port, signal, { transitions: { ...sim.transitions, [to]: nextQuery } }, emit)
    }
    return reject(sim, from, to, port, signal, 'Goal 入点只接受完成信号 G 与回报信号 C-R')
  }
  return reject(sim, from, to, port, signal, '未知的线性变迁端口')
}

function deliverMerge(flow: ProgressFlow, sim: FlowSimState, from: string | null, to: string, port: FlowPort, signal: FlowSignal) {
  // Next 口收到 S-C → 转发到所有激活信号来源（入点多线）
  if (signal.kind === 'cancel-cascade') {
    if (port !== 'output') return reject(sim, from, to, port, signal, '合并变迁从 Next 接收 S-C')
    return accept(sim, from, to, port, signal, {}, [{ from: to, via: 'input', signal: { kind: 'cancel-cascade' } }])
  }
  if (port !== 'input') return reject(sim, from, to, port, signal, '合并变迁只有一个入点')
  if (signal.kind === 'activation') {
    const awaiting = incomingSources(flow, to, 'input')
    const emit: Emit[] = [
      { from: to, via: 'output', signal: { kind: 'ckpt-transition', from: 'inactive', to: 'active' } },
      { from: to, via: 'input', signal: { kind: 'query' } },
    ]
    // No incoming wires: vacuous "all lines reported" → also advance 活跃中→已激活 (已完成).
    if (!awaiting.length) emit.push({ from: to, via: 'output', signal: { kind: 'ckpt-transition', from: 'active', to: 'activated' } })
    return accept(sim, from, to, port, signal, { merges: { ...sim.merges, [to]: { awaiting, reported: [] } } }, emit)
  }
  if (signal.kind === 'query-response') {
    if (from === null) return reject(sim, from, to, port, signal, 'C-R 缺少来源')
    const current = mergeSim(sim, to)
    if (!current.awaiting.length) return reject(sim, from, to, port, signal, '合并变迁当前没有进行中的查询')
    if (!current.awaiting.includes(from)) return reject(sim, from, to, port, signal, '该来源不在本次查询名单中')
    if (current.reported.includes(from)) return reject(sim, from, to, port, signal, '该来源已回报过 C-R')
    const reported = [...current.reported, from]
    const done = current.awaiting.every(id => reported.includes(id))
    const nextMerge = done ? { awaiting: [], reported: [] } : { awaiting: current.awaiting, reported }
    const emit: Emit[] = done
      ? [{ from: to, via: 'output', signal: { kind: 'ckpt-transition', from: 'active', to: 'activated' } }]
      : []
    return accept(sim, from, to, port, signal, { merges: { ...sim.merges, [to]: nextMerge } }, emit)
  }
  return reject(sim, from, to, port, signal, '合并变迁入点只接受激活信号 A 与回报信号 C-R')
}

function deliverSwap(flow: ProgressFlow, sim: FlowSimState, from: string | null, to: string, port: FlowPort, signal: FlowSignal) {
  const inIndex = parseSwapInIndex(port)
  if (inIndex !== null) {
    if (signal.kind !== 'activation') return reject(sim, from, to, port, signal, '交换变迁入点只接受激活信号 A')
    const swap = getSwapNode(flow, to)!
    const emit: Emit[] = [
      { from: to, via: swapOutPort(inIndex), signal: { kind: 'ckpt-transition', from: 'inactive', to: 'activated' } },
    ]
    for (let j = 0; j < swap.entries; j++) {
      if (j === inIndex) continue
      emit.push({ from: to, via: swapInPort(j), signal: { kind: 'cancel-cascade' } })
    }
    return accept(sim, from, to, port, signal, {}, emit)
  }
  const outIndex = parseSwapOutIndex(port)
  if (outIndex !== null) {
    // Out 口收到 S-C → 转发到同条目激活来源
    if (signal.kind === 'cancel-cascade') {
      return accept(sim, from, to, port, signal, {}, [{ from: to, via: swapInPort(outIndex), signal: { kind: 'cancel-cascade' } }])
    }
    return reject(sim, from, to, port, signal, '交换变迁出点只转发 S-C')
  }
  return reject(sim, from, to, port, signal, '未知的交换变迁端口')
}

function deliverDiff(flow: ProgressFlow, sim: FlowSimState, from: string | null, to: string, port: FlowPort, signal: FlowSignal) {
  // 成功/失败出点收到 S-C → 转发到 Parent，并对 Goal 发 D
  if (signal.kind === 'cancel-cascade') {
    if (port !== 'output' && port !== 'output2') return reject(sim, from, to, port, signal, '差分变迁从成功/失败出点接收 S-C')
    return accept(sim, from, to, port, signal, {}, [
      { from: to, via: 'input2', signal: { kind: 'cancel-cascade' } },
      { from: to, via: 'input', signal: { kind: 'cancel' } },
    ])
  }
  // 成功/失败出点收到 G-C → 对 Goal 发 D
  if (signal.kind === 'goal-cancel-cascade') {
    if (port !== 'output' && port !== 'output2') return reject(sim, from, to, port, signal, '差分变迁从成功/失败出点接收 G-C')
    return accept(sim, from, to, port, signal, {}, [{ from: to, via: 'input', signal: { kind: 'cancel' } }])
  }
  if (port === 'input2') {
    if (signal.kind !== 'activation') return reject(sim, from, to, port, signal, 'Parent 只接受激活信号 A')
    return accept(sim, from, to, port, signal, {}, [
      { from: to, via: 'output', signal: { kind: 'ckpt-transition', from: 'inactive', to: 'active' } },
      { from: to, via: 'input', signal: { kind: 'activation' } },
    ])
  }
  if (port === 'input') {
    if (signal.kind === 'goal-yes') {
      return accept(sim, from, to, port, signal, {}, [
        { from: to, via: 'input', signal: { kind: 'cancel' }, ...(from ? { onlyTo: from } : {}) },
        { from: to, via: 'output', signal: { kind: 'ckpt-transition', from: 'active', to: 'activated' } },
      ])
    }
    if (signal.kind === 'goal-no') {
      return accept(sim, from, to, port, signal, {}, [
        { from: to, via: 'input', signal: { kind: 'cancel' }, ...(from ? { onlyTo: from } : {}) },
        { from: to, via: 'output', signal: { kind: 'cancel-cascade' } },
        { from: to, via: 'output2', signal: { kind: 'ckpt-transition', from: 'inactive', to: 'activated' } },
      ])
    }
    return reject(sim, from, to, port, signal, '差分变迁 Goal 入点只接受 G-Y / G-N')
  }
  return reject(sim, from, to, port, signal, '未知的差分变迁端口')
}

function deliverConditional(flow: ProgressFlow, sim: FlowSimState, from: string | null, to: string, port: FlowPort, signal: FlowSignal) {
  // Next 口收到 S-C → 转发到 Parent
  if (signal.kind === 'cancel-cascade') {
    if (port !== 'output') return reject(sim, from, to, port, signal, '条件变迁从 Next 接收 S-C')
    return accept(sim, from, to, port, signal, {}, [{ from: to, via: 'input2', signal: { kind: 'cancel-cascade' } }])
  }
  // Next 口收到 G-C → 对 Predicate 发 D
  if (signal.kind === 'goal-cancel-cascade') {
    if (port !== 'output') return reject(sim, from, to, port, signal, '条件变迁从 Next 接收 G-C')
    return accept(sim, from, to, port, signal, {}, [{ from: to, via: 'input', signal: { kind: 'cancel' } }])
  }
  if (port === 'input2') {
    if (signal.kind !== 'activation') return reject(sim, from, to, port, signal, 'Parent 只接受激活信号 A')
    const predicates = incomingSources(flow, to, 'input')
    const emit: Emit[] = [
      { from: to, via: 'output', signal: { kind: 'ckpt-transition', from: 'inactive', to: 'active' } },
      { from: to, via: 'input', signal: { kind: 'activation' } },
    ]
    // 无 Predicate：空条件成立，直接推进 活跃中→已激活
    if (!predicates.length) emit.push({ from: to, via: 'output', signal: { kind: 'ckpt-transition', from: 'active', to: 'activated' } })
    return accept(sim, from, to, port, signal, {}, emit)
  }
  if (port === 'input') {
    if (signal.kind !== 'predicate-complete') return reject(sim, from, to, port, signal, '条件变迁 Predicate 入点只接受 P')
    return accept(sim, from, to, port, signal, {}, [
      { from: to, via: 'input', signal: { kind: 'cancel' }, ...(from ? { onlyTo: from } : {}) },
      { from: to, via: 'output', signal: { kind: 'ckpt-transition', from: 'active', to: 'activated' } },
    ])
  }
  return reject(sim, from, to, port, signal, '未知的条件变迁端口')
}

function deliverOne(flow: ProgressFlow, sim: FlowSimState, seed: SignalSeed): { sim: FlowSimState; emit: Emit[] } {
  const { from, to, port, signal } = seed
  if (getNode(flow, to)) return deliverCkpt(flow, sim, from, to, port, signal)
  if (getGoalNode(flow, to)) return deliverGoal(sim, from, to, port, signal)
  if (getPredicateNode(flow, to)) return deliverPredicate(sim, from, to, port, signal)
  if (getTransitionNode(flow, to)) return deliverTransition(flow, sim, from, to, port, signal)
  if (getConditionalNode(flow, to)) return deliverConditional(flow, sim, from, to, port, signal)
  if (getDiffNode(flow, to)) return deliverDiff(flow, sim, from, to, port, signal)
  if (getMergeNode(flow, to)) return deliverMerge(flow, sim, from, to, port, signal)
  if (getSwapNode(flow, to)) return deliverSwap(flow, sim, from, to, port, signal)
  return reject(sim, from, to, port, signal, '该节点尚未接入信号运行时')
}

/** Propagate signals through wires until the queue drains. */
export function propagateSignals(flow: ProgressFlow, sim: FlowSimState, seeds: SignalSeed[]): FlowSimState {
  let next: FlowSimState = { ...sim, log: [...sim.log], ckpt: { ...sim.ckpt }, goals: { ...sim.goals }, predicates: { ...sim.predicates }, merges: { ...sim.merges }, transitions: { ...sim.transitions }, pulse: sim.pulse + 1 }
  const queue = [...seeds]
  const nodeCount = Object.keys(flow.nodes).length + Object.keys(flow.goals ?? {}).length + Object.keys(flow.predicates ?? {}).length + Object.keys(flow.transitions ?? {}).length + Object.keys(flow.conditionals ?? {}).length + Object.keys(flow.diffs ?? {}).length + Object.keys(flow.merges ?? {}).length + Object.keys(flow.swaps ?? {}).length
  const guard = Math.max(64, nodeCount * 16 + 16)
  for (let i = 0; i < queue.length && i < guard; i++) {
    const result = deliverOne(flow, next, queue[i])
    next = result.sim
    for (const out of result.emit) queue.push(...emitTargets(flow, out.from, out.via, out.signal, out.onlyTo))
  }
  return next
}

/** Start node system event: emit S(未激活, 已激活) on its single outgoing wire. */
export function fireStart(flow: ProgressFlow, sim: FlowSimState): FlowSimState {
  const targets = emitTargets(flow, flow.entry.id, 'output', START_SIGNAL)
  if (!targets.length) {
    return {
      ...sim,
      pulse: sim.pulse + 1,
      log: [...sim.log, { from: flow.entry.id, to: flow.entry.id, port: 'output', signal: START_SIGNAL, accepted: false, reason: '开始节点尚未连接' }],
    }
  }
  return propagateSignals(flow, sim, targets)
}

/** Goal signal source: emit G / G-Y / G-N on its single outgoing wire while 订阅中. */
export function fireGoalSignal(flow: ProgressFlow, sim: FlowSimState, id: string, kind: 'goal-complete' | 'goal-yes' | 'goal-no'): FlowSimState {
  if (!getGoalNode(flow, id)) return sim
  const label = SIGNAL_LABELS[kind]
  const current = goalState(sim, id)
  if (current !== 'subscribed') {
    return {
      ...sim,
      pulse: sim.pulse + 1,
      log: [...sim.log, { from: id, to: id, port: 'output', signal: { kind }, accepted: false, reason: current === 'inactive' ? `Goal 尚未订阅，无法发出 ${label}` : `Goal 已关闭，无法发出 ${label}` }],
    }
  }
  const targets = emitTargets(flow, id, 'output', { kind })
  if (!targets.length) {
    return {
      ...sim,
      pulse: sim.pulse + 1,
      log: [...sim.log, { from: id, to: id, port: 'output', signal: { kind }, accepted: false, reason: 'Goal 尚未连接' }],
    }
  }
  return propagateSignals(flow, sim, targets)
}

export function fireGoalComplete(flow: ProgressFlow, sim: FlowSimState, id: string): FlowSimState {
  return fireGoalSignal(flow, sim, id, 'goal-complete')
}
export function fireGoalYes(flow: ProgressFlow, sim: FlowSimState, id: string): FlowSimState {
  return fireGoalSignal(flow, sim, id, 'goal-yes')
}
export function fireGoalNo(flow: ProgressFlow, sim: FlowSimState, id: string): FlowSimState {
  return fireGoalSignal(flow, sim, id, 'goal-no')
}

/** Predicate signal source: emit P on its single outgoing wire while 订阅中. */
export function firePredicateComplete(flow: ProgressFlow, sim: FlowSimState, id: string): FlowSimState {
  if (!getPredicateNode(flow, id)) return sim
  const current = predicateState(sim, id)
  if (current !== 'subscribed') {
    return {
      ...sim,
      pulse: sim.pulse + 1,
      log: [...sim.log, { from: id, to: id, port: 'output', signal: { kind: 'predicate-complete' }, accepted: false, reason: current === 'inactive' ? 'Predicate 尚未订阅，无法发出 P' : 'Predicate 已关闭，无法发出 P' }],
    }
  }
  const targets = emitTargets(flow, id, 'output', { kind: 'predicate-complete' })
  if (!targets.length) {
    return {
      ...sim,
      pulse: sim.pulse + 1,
      log: [...sim.log, { from: id, to: id, port: 'output', signal: { kind: 'predicate-complete' }, accepted: false, reason: 'Predicate 尚未连接' }],
    }
  }
  return propagateSignals(flow, sim, targets)
}

/** Inject an arbitrary transition into a checkpoint (tests / future sources). */
export function fireCkptTransition(flow: ProgressFlow, sim: FlowSimState, id: string, from: CkptState, to: CkptState): FlowSimState {
  if (!getNode(flow, id)) return sim
  return propagateSignals(flow, sim, [{ from: null, to: id, port: 'input', signal: { kind: 'ckpt-transition', from, to } }])
}
