/** 条件组编辑糖；导出时编译为 Mod 条件表达式（见 RPGToolKit docs/webui-condition-alignment.md）。 */

export const QUEST_OPS = {
  before_start: '开始之前',
  after_start: '开始之后',
  active: '激活中',
  succeeded: '已成功',
  failed: '已失败',
  completed: '已完成（成功/失败，放弃不算）',
} as const

export const CMP_OPS = {
  '==': '等于',
  '>': '大于',
  '<': '小于',
  '>=': '不小于',
  '<=': '不大于',
  '!=': '不等于',
} as const

export const TALK_OPS = {
  read: '读过',
  unread: '没读过',
} as const

export const TIME_OPS = {
  day: '白天',
  night: '黑夜',
} as const

export const CONDITION_KIND_LABELS = {
  expr: '表达式',
  quest: '任务',
  progress: '进度',
  talk: '对话',
  level: '等级',
  reputation: '声誉',
  time: '时间',
} as const

export type QuestOp = keyof typeof QUEST_OPS
export type CmpOp = keyof typeof CMP_OPS
export type TalkOp = keyof typeof TALK_OPS
export type TimeOp = keyof typeof TIME_OPS
export type ConditionKind = keyof typeof CONDITION_KIND_LABELS

export type ProgressConditionRule =
  | { kind: 'expr'; source: string }
  | { kind: 'quest'; op: QuestOp; questId: string }
  | { kind: 'progress'; op: QuestOp; questId: string; progressId: string }
  | { kind: 'talk'; op: TalkOp; injectId: string }
  | { kind: 'level'; cmp: CmpOp; n: number }
  | { kind: 'reputation'; cmp: CmpOp; factionId: string; n: number }
  | { kind: 'time'; op: TimeOp }

/** @deprecated 旧 UI 状态表；仅用于读入迁移。 */
export const TASK_VISIBILITY_STATES = {
  before_accept: '接取之前',
  after_accept: '接取之后',
  active: '激活中',
  succeeded: '成功后',
  ended: '结束后',
} as const
/** @deprecated */
export const DIALOGUE_VISIBILITY_STATES = { before: '之前', after: '之后' } as const
/** @deprecated */
export const EXPR_VISIBILITY_STATES = { true: '满足' } as const
/** @deprecated */
export const REPEAT_CYCLE_STATES = { satisfied: '已满足', unsatisfied: '不满足' } as const

const OLD_TASK_TO_OP: Record<string, QuestOp> = {
  before_accept: 'before_start',
  after_accept: 'after_start',
  active: 'active',
  succeeded: 'succeeded',
  ended: 'completed',
  before_start: 'before_start',
  after_start: 'after_start',
  failed: 'failed',
  completed: 'completed',
}

export function createConditionRule(kind: ConditionKind): ProgressConditionRule {
  switch (kind) {
    case 'expr':
      return { kind: 'expr', source: '' }
    case 'quest':
      return { kind: 'quest', op: 'active', questId: '' }
    case 'progress':
      return { kind: 'progress', op: 'active', questId: '', progressId: '' }
    case 'talk':
      return { kind: 'talk', op: 'read', injectId: '' }
    case 'level':
      return { kind: 'level', cmp: '>=', n: 1 }
    case 'reputation':
      return { kind: 'reputation', cmp: '>', factionId: '', n: 0 }
    case 'time':
      return { kind: 'time', op: 'day' }
  }
}

/** 兼容旧 `conditionStatesFor(kind)` 调用点；新 UI 按叶子字段编辑。 */
export function conditionStatesFor(kind: string): Record<string, string> {
  if (kind === 'quest' || kind === 'progress' || kind === 'task') return { ...QUEST_OPS }
  if (kind === 'level' || kind === 'reputation') return { ...CMP_OPS }
  if (kind === 'talk' || kind === 'dialogue') return { ...TALK_OPS }
  if (kind === 'time') return { ...TIME_OPS }
  if (kind === 'repeat') return { ...REPEAT_CYCLE_STATES }
  if (kind === 'expr') return { ...EXPR_VISIBILITY_STATES }
  return {}
}

export function conditionRuleIssue(rule: ProgressConditionRule, label: string): string | null {
  switch (rule.kind) {
    case 'expr':
      return rule.source.trim() ? null : `${label}：请填写表达式`
    case 'quest':
      return rule.questId.trim() ? null : `${label}：请填写任务标识符`
    case 'progress':
      if (!rule.questId.trim()) return `${label}：请填写任务标识符`
      if (!rule.progressId.trim()) return `${label}：请填写进度标识符`
      return null
    case 'talk':
      return rule.injectId.trim() ? null : `${label}：请填写对话注入点`
    case 'level':
      return Number.isFinite(rule.n) ? null : `${label}：等级必须是数字`
    case 'reputation':
      if (!rule.factionId.trim()) return `${label}：请填写声誉主体标识符`
      return Number.isFinite(rule.n) ? null : `${label}：数值必须是数字`
    case 'time':
      return null
  }
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}无效`)
  return value as Record<string, unknown>
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label}无效`)
  return value
}

function requireQuestOp(value: unknown, label: string): QuestOp {
  const op = String(value)
  if (!Object.hasOwn(QUEST_OPS, op) && !Object.hasOwn(OLD_TASK_TO_OP, op)) throw new Error(`${label}状态无效`)
  return (OLD_TASK_TO_OP[op] ?? op) as QuestOp
}

function requireCmp(value: unknown, label: string): CmpOp {
  const cmp = String(value)
  if (!Object.hasOwn(CMP_OPS, cmp)) throw new Error(`${label}比较符无效`)
  return cmp as CmpOp
}

function requireTalkOp(value: unknown, label: string): TalkOp {
  const op = String(value)
  if (!Object.hasOwn(TALK_OPS, op)) throw new Error(`${label}对话状态无效`)
  return op as TalkOp
}

function requireTimeOp(value: unknown, label: string): TimeOp {
  const op = String(value)
  if (!Object.hasOwn(TIME_OPS, op)) throw new Error(`${label}时间状态无效`)
  return op as TimeOp
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label}必须是数字`)
  return value
}

/** 将一条作者叶子（含旧格式）解析为现行叶子；`repeat` 不在此返回。 */
function parseOneRule(value: unknown, label: string): ProgressConditionRule | { kind: 'repeat'; state: 'satisfied' | 'unsatisfied' } {
  const rule = requireObject(value, label)
  const kind = rule.kind

  if (kind === 'expr') {
    if (typeof rule.source === 'string') return { kind: 'expr', source: rule.source }
    // 旧：{ kind:'expr', state:'true', target }
    if (typeof rule.target === 'string') return { kind: 'expr', source: rule.target }
    throw new Error(`${label}表达式无效`)
  }
  if (kind === 'quest') {
    return { kind: 'quest', op: requireQuestOp(rule.op ?? rule.state, label), questId: requireString(rule.questId ?? rule.target, label) }
  }
  if (kind === 'progress') {
    return {
      kind: 'progress',
      op: requireQuestOp(rule.op ?? rule.state, label),
      questId: requireString(rule.questId, `${label}.questId`),
      progressId: requireString(rule.progressId ?? rule.target, `${label}.progressId`),
    }
  }
  if (kind === 'talk') {
    return { kind: 'talk', op: requireTalkOp(rule.op ?? rule.state, label), injectId: requireString(rule.injectId ?? rule.target ?? rule.inject, label) }
  }
  if (kind === 'level') {
    return { kind: 'level', cmp: requireCmp(rule.cmp ?? rule.state, label), n: requireNumber(rule.n ?? rule.target, label) }
  }
  if (kind === 'reputation') {
    return {
      kind: 'reputation',
      cmp: requireCmp(rule.cmp ?? rule.state, label),
      factionId: requireString(rule.factionId ?? rule.target, label),
      n: requireNumber(rule.n, `${label}.n`),
    }
  }
  if (kind === 'time') {
    return { kind: 'time', op: requireTimeOp(rule.op ?? rule.state, label) }
  }

  // —— 旧叶子迁移 ——
  if (kind === 'talk_read') {
    return { kind: 'talk', op: 'read', injectId: requireString(rule.injectId ?? rule.target ?? rule.inject, label) }
  }
  if (kind === 'talk_unread') {
    return { kind: 'talk', op: 'unread', injectId: requireString(rule.injectId ?? rule.target ?? rule.inject, label) }
  }
  if (kind === 'day') return { kind: 'time', op: 'day' }
  if (kind === 'night') return { kind: 'time', op: 'night' }
  if (kind === 'task') {
    return { kind: 'quest', op: requireQuestOp(rule.state, label), questId: requireString(rule.target, label) }
  }
  if (kind === 'dialogue') {
    const state = String(rule.state)
    const injectId = requireString(rule.target, label)
    if (state === 'after') return { kind: 'talk', op: 'read', injectId }
    if (state === 'before') return { kind: 'talk', op: 'unread', injectId }
    throw new Error(`${label}对话条件状态无效`)
  }
  if (kind === 'repeat') {
    if (!Object.hasOwn(REPEAT_CYCLE_STATES, String(rule.state))) throw new Error(`${label}重复周期条件状态无效`)
    if (rule.target !== undefined && rule.target !== '') throw new Error(`${label}重复周期条件不需要对象`)
    return { kind: 'repeat', state: rule.state as 'satisfied' | 'unsatisfied' }
  }
  throw new Error(`${label}条件类型无效`)
}

export type VisibilityParseResult = {
  rules: ProgressConditionRule[]
  hideWhenRepeatUnsatisfied: boolean
}

/**
 * 解析条件数组。可见性里旧 `repeat:satisfied` → hideWhenRepeatUnsatisfied；
 * `repeat:unsatisfied` 与可承接里的 repeat 一律拒绝。
 */
export function parseConditionRules(values: unknown, label: string, options: { allowHideRepeat?: boolean } = {}): VisibilityParseResult {
  if (!Array.isArray(values)) throw new Error(`${label}必须是条件数组`)
  const allowHideRepeat = options.allowHideRepeat === true
  const rules: ProgressConditionRule[] = []
  let hideWhenRepeatUnsatisfied = false
  values.forEach((value, index) => {
    const parsed = parseOneRule(value, `${label} ${index + 1}`)
    if (parsed.kind === 'repeat') {
      if (!allowHideRepeat) throw new Error(`${label}不能写入重复周期；可见性用 hideWhenRepeatUnsatisfied，可承接由引擎投影`)
      if (parsed.state === 'unsatisfied') {
        throw new Error(`${label}不再支持「周期不满足」叶子；请改用表达式 !repeatSatisfied(ctx.player, "<questId>")`)
      }
      hideWhenRepeatUnsatisfied = true
      return
    }
    rules.push(parsed)
  })
  return { rules, hideWhenRepeatUnsatisfied }
}

/** 兼容旧签名：第三参 true=允许从旧 repeat.satisfied 抽出 hide 标志（调用方应改用 parseConditionRules + hide 字段）。 */
export function parseConditionRuleList(values: unknown, label: string, allowRepeat = false): ProgressConditionRule[] {
  return parseConditionRules(values, label, { allowHideRepeat: allowRepeat }).rules
}

export function parseHideWhenRepeatUnsatisfied(value: unknown, fromLegacyVisibility: boolean): boolean {
  if (value === undefined) return fromLegacyVisibility
  if (typeof value !== 'boolean') throw new Error('hideWhenRepeatUnsatisfied 必须是布尔值')
  return value || fromLegacyVisibility
}

export function emitConditionLeaf(rule: ProgressConditionRule): string {
  switch (rule.kind) {
    case 'expr': {
      const source = rule.source.trim()
      if (!source) throw new Error('表达式叶子不能为空')
      if (/[;\n\r]/.test(source) || /\bvar\b|\blet\b|\bconst\b/.test(source)) {
        throw new Error('条件只能是表达式，不能含语句')
      }
      return source
    }
    case 'quest':
      return `questState(ctx.player, ${JSON.stringify(rule.op)}, ${JSON.stringify(rule.questId.trim())})`
    case 'progress':
      return `progressState(ctx.player, ${JSON.stringify(rule.op)}, ${JSON.stringify(rule.questId.trim())}, ${JSON.stringify(rule.progressId.trim())})`
    case 'talk':
      return rule.op === 'read'
        ? `talkRead(ctx.player, ${JSON.stringify(rule.injectId.trim())})`
        : `!talkRead(ctx.player, ${JSON.stringify(rule.injectId.trim())})`
    case 'level':
      return `ctx.player.experienceLevel ${rule.cmp} ${rule.n}`
    case 'reputation':
      return `reputationPoints(ctx.player, ${JSON.stringify(rule.factionId.trim())}) ${rule.cmp} ${rule.n}`
    case 'time':
      return rule.op === 'day' ? `isDay(ctx.player)` : `!isDay(ctx.player)`
  }
}

/** 条件组 → 一条布尔表达式；空组为 `""`（恒真）。 */
export function emitConditionExpression(rules: readonly ProgressConditionRule[]): string {
  if (!rules.length) return ''
  return rules.map(rule => `(${emitConditionLeaf(rule)})`).join(' && ')
}

/** questc / actor 落盘字段：必须是字符串。 */
export function parseConditionExpressionString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label}必须是表达式字符串`)
  if (/[;\n\r]/.test(value)) throw new Error(`${label}只能是表达式，不能含语句`)
  return value
}
