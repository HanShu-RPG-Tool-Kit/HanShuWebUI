/** 条件求值器的状态闭集；谓词节点与单进度任务的可见性/可承接条件共用。 */

export const TASK_VISIBILITY_STATES = { before_accept: '接取之前', after_accept: '接取之后', active: '激活中', succeeded: '成功后', ended: '结束后' } as const
export const DIALOGUE_VISIBILITY_STATES = { before: '之前', after: '之后' } as const
/** 条件求值器：表达式本身即条件，仅「满足」一态 */
export const EXPR_VISIBILITY_STATES = { true: '满足' } as const
/** 本进度重复周期；仅允许写入可见性条件。可承接侧由引擎投影「已满足」，不占条件槽。 */
export const REPEAT_CYCLE_STATES = { satisfied: '已满足', unsatisfied: '不满足' } as const

export type ProgressConditionRule =
  | { kind: 'task'; state: keyof typeof TASK_VISIBILITY_STATES; target: string }
  | { kind: 'dialogue'; state: keyof typeof DIALOGUE_VISIBILITY_STATES; target: string }
  | { kind: 'expr'; state: keyof typeof EXPR_VISIBILITY_STATES; target: string }
  | { kind: 'repeat'; state: keyof typeof REPEAT_CYCLE_STATES; target: '' }

export function conditionStatesFor(kind: ProgressConditionRule['kind']) {
  if (kind === 'task') return TASK_VISIBILITY_STATES
  if (kind === 'dialogue') return DIALOGUE_VISIBILITY_STATES
  if (kind === 'repeat') return REPEAT_CYCLE_STATES
  return EXPR_VISIBILITY_STATES
}

export function createConditionRule(kind: ProgressConditionRule['kind']): ProgressConditionRule {
  if (kind === 'task') return { kind: 'task', state: 'succeeded', target: '' }
  if (kind === 'dialogue') return { kind: 'dialogue', state: 'after', target: '' }
  if (kind === 'repeat') return { kind: 'repeat', state: 'satisfied', target: '' }
  return { kind: 'expr', state: 'true', target: '' }
}

/** 严格读取一组条件；`allowRepeat` 关闭时拒绝 `repeat`（可承接条件不接受周期）。 */
export function parseConditionRules(values: unknown, label: string, allowRepeat: boolean): ProgressConditionRule[] {
  if (!Array.isArray(values)) throw new Error(`${label}必须是条件数组`)
  return values.map((value): ProgressConditionRule => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}无效`)
    const rule = value as Record<string, unknown>
    if (typeof rule.target !== 'string') throw new Error(`${label}无效`)
    const target = rule.target
    if (rule.kind === 'task') {
      if (!Object.hasOwn(TASK_VISIBILITY_STATES, String(rule.state))) throw new Error('任务条件状态无效')
      return { kind: 'task', state: rule.state as keyof typeof TASK_VISIBILITY_STATES, target }
    }
    if (rule.kind === 'dialogue') {
      if (!Object.hasOwn(DIALOGUE_VISIBILITY_STATES, String(rule.state))) throw new Error('对话条件状态无效')
      return { kind: 'dialogue', state: rule.state as keyof typeof DIALOGUE_VISIBILITY_STATES, target }
    }
    if (rule.kind === 'repeat') {
      if (!allowRepeat) throw new Error('可承接条件不能写入重复周期；周期由引擎投影，不占条件槽')
      if (!Object.hasOwn(REPEAT_CYCLE_STATES, String(rule.state))) throw new Error('重复周期条件状态无效')
      if (target !== '') throw new Error('重复周期条件不需要对象')
      return { kind: 'repeat', state: rule.state as keyof typeof REPEAT_CYCLE_STATES, target: '' }
    }
    if (rule.kind !== 'expr' || !Object.hasOwn(EXPR_VISIBILITY_STATES, String(rule.state))) throw new Error('求值条件状态无效')
    return { kind: 'expr', state: rule.state as keyof typeof EXPR_VISIBILITY_STATES, target }
  })
}
