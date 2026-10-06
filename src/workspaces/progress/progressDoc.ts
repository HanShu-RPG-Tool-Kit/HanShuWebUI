import { isObject } from './model'
import { parseJsonValue } from '../../utils/strictJson'
import { type GoalConfigValue, type GoalDefinition } from './goalDefinitions'

export const PROGRESS_FORMAT = 'hanshu.progress'
export type ProgressConfigValue = GoalConfigValue
export const TASK_VISIBILITY_STATES = { before_accept: '接取之前', after_accept: '接取之后', active: '激活中', succeeded: '成功后', ended: '结束后' } as const
export const DIALOGUE_VISIBILITY_STATES = { before: '之前', after: '之后' } as const
export type ProgressConditionRule =
  | { kind: 'task'; state: keyof typeof TASK_VISIBILITY_STATES; target: string }
  | { kind: 'dialogue'; state: keyof typeof DIALOGUE_VISIBILITY_STATES; target: string }
export type ProgressRepeatKind = 'once' | 'game_daily' | 'game_weekly' | 'real_daily' | 'real_weekly' | 'real_monthly' | 'duration' | 'manual'
export type ProgressGoal = { id: string; kind: string; config: Record<string, ProgressConfigValue> }
export type ProgressDocument = {
  format: typeof PROGRESS_FORMAT
  version: 1
  id: string
  name: string
  description: string
  authorNotes: string
  tags: string[]
  completion: 'all' | 'any'
  goals: ProgressGoal[]
  /** Independent conjunctions; each empty list is satisfied. */
  visibility: ProgressConditionRule[]
  acceptance: ProgressConditionRule[]
  abandonable: boolean
  repeat: { kind: ProgressRepeatKind; hours: number }
  rewardKits: string[]
}
export const PROGRESS_REPEAT_LABELS: Record<ProgressRepeatKind, string> = {
  once: '仅一次', game_daily: '每个游戏日', game_weekly: '每个游戏周',
  real_daily: '每天', real_weekly: '每周', real_monthly: '每月', duration: '结束后间隔', manual: '手动重开',
}
const uid = () => crypto.randomUUID()
export function createProgressGoal(kind: string, _definitions: readonly GoalDefinition[] = []): ProgressGoal {
  return { id: uid(), kind, config: {} }
}
export function createProgress(name = '新建进度', _definitions: readonly GoalDefinition[] = []): ProgressDocument {
  return {
    format: PROGRESS_FORMAT, version: 1, id: uid(), name, description: '', authorNotes: '', tags: [],
    completion: 'all', goals: [], visibility: [], acceptance: [],
    abandonable: true, repeat: { kind: 'once', hours: 24 }, rewardKits: [],
  }
}
export function goalLabel(goal: ProgressGoal, definitions: readonly GoalDefinition[] = []) {
  return definitions.find(item => item.kind === goal.kind)?.label || goal.kind || '未选择目标类型'
}
export function goalConfigSummary(goal: ProgressGoal, definitions: readonly GoalDefinition[]) {
  const def = definitions.find(item => item.kind === goal.kind)
  const effective = { ...Object.fromEntries((def?.fields ?? []).filter(field => field.default !== undefined).map(field => [field.key, field.default])), ...goal.config }
  return Object.entries(effective).filter(([, value]) => value !== '').map(([key, value]) => {
    const field = def?.fields.find(item => item.key === key)
    return `${field?.label || key} ${typeof value === 'boolean' ? value ? '是' : '否' : value}`
  }).join(' · ')
}
export function stringifyProgress(doc: ProgressDocument) {
  return JSON.stringify({ ...doc,
    goals: doc.goals.map(({ id, kind, config }) => ({ id, kind, config })),
    repeat: doc.repeat.kind === 'duration' ? doc.repeat : { kind: doc.repeat.kind },
  }, null, 2) + '\n'
}

// Read without normalizing in-progress text or injecting evolving definition defaults.
// Unsupported old drafts are preserved as source, never replaced with an editable fallback.
export function parseProgress(source: string, _definitions: readonly GoalDefinition[] = []): ProgressDocument {
  const raw = parseJsonValue(source)
  function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message) }
  check(isObject(raw), '进度文档必须是 JSON 对象')
  check(raw.format === PROGRESS_FORMAT && raw.version === 1 && !('groups' in raw), '此文件不是当前的进度结构。需要 version: 1、goals 列表和 completion 完成规则；原始内容已保留。')
  const ids = new Set<string>()
  const id = (value: unknown, path: string) => {
    check(typeof value === 'string' && value.trim(), `${path} 缺少 ID`)
    check(!ids.has(value), `重复 ID：${value}`)
    ids.add(value); return value
  }
  const str = (value: unknown, path: string): string => { check(typeof value === 'string', `${path} 必须是文本`); return value }
  const readConditions = (values: unknown, label: string): ProgressConditionRule[] => {
    check(Array.isArray(values), `${label}必须是条件数组`)
    return values.map((value): ProgressConditionRule => {
    check(isObject(value), `${label}无效`)
    const target = str(value.target, '条件对象')
    if (value.kind === 'task') {
      check(Object.hasOwn(TASK_VISIBILITY_STATES, String(value.state)), '任务条件状态无效')
      return { kind: 'task', state: value.state as keyof typeof TASK_VISIBILITY_STATES, target }
    }
    check(value.kind === 'dialogue' && Object.hasOwn(DIALOGUE_VISIBILITY_STATES, String(value.state)), '对话条件状态无效')
    return { kind: 'dialogue', state: value.state as keyof typeof DIALOGUE_VISIBILITY_STATES, target }
    })
  }
  const visibility = readConditions(raw.visibility, '可见性条件')
  const acceptance = readConditions(raw.acceptance, '可承接条件')
  const docId = id(raw.id, '进度')
  check(raw.completion === 'all' || raw.completion === 'any', 'completion 必须是 all 或 any')
  check(Array.isArray(raw.goals), 'goals 必须是数组')
  const goals = raw.goals.map((item): ProgressGoal => {
      check(isObject(item) && isObject(item.config), '目标或目标参数无效')
      const config: Record<string, ProgressConfigValue> = {}
      for (const [key, data] of Object.entries(item.config)) {
        check(typeof data === 'string' || typeof data === 'boolean' || (typeof data === 'number' && Number.isFinite(data)), `目标参数 ${key} 必须是文本、数值或布尔值`)
        Object.defineProperty(config, key, { value: data, enumerable: true, writable: true, configurable: true })
      }
      return { id: id(item.id, '目标'), kind: str(item.kind, '目标类型'), config }
  })
  check(Array.isArray(raw.tags) && raw.tags.every(value => typeof value === 'string'), 'tags 必须是文本数组')
  check(isObject(raw.repeat) && Object.hasOwn(PROGRESS_REPEAT_LABELS, String(raw.repeat.kind)), '重复策略无效')
  const hours = raw.repeat.kind === 'duration' ? raw.repeat.hours : 24
  check(typeof hours === 'number' && Number.isFinite(hours) && hours > 0, '重复间隔必须大于零')
  check(typeof raw.abandonable === 'boolean', 'abandonable 必须是布尔值')
  check(Array.isArray(raw.rewardKits) && raw.rewardKits.every(ref => typeof ref === 'string' && ref.trim()), 'rewardKits 必须是礼包引用数组')
  check(new Set(raw.rewardKits).size === raw.rewardKits.length, '奖励礼包不能重复')
  return {
    format: PROGRESS_FORMAT, version: 1, id: docId, name: str(raw.name, '名称'), description: str(raw.description, '简介'),
    authorNotes: str(raw.authorNotes ?? '', '作者备注'), tags: raw.tags as string[], completion: raw.completion, goals,
    visibility, acceptance,
    abandonable: raw.abandonable, repeat: { kind: raw.repeat.kind as ProgressRepeatKind, hours }, rewardKits: raw.rewardKits as string[],
  }
}
export function readProgressSource(source: string, definitions: readonly GoalDefinition[] = []): { doc: ProgressDocument | null; error: string } {
  try { return { doc: parseProgress(source, definitions), error: '' } }
  catch (error) { return { doc: null, error: error instanceof Error ? error.message : String(error) } }
}
/** The insertion index is measured before removal; identity survives all moves. */
export function moveProgressGoal(doc: ProgressDocument, goalId: string, targetIndex: number): ProgressDocument {
  const oldIndex = doc.goals.findIndex(goal => goal.id === goalId)
  if (oldIndex < 0) return doc
  const goals = doc.goals.filter(goal => goal.id !== goalId)
  const insertion = targetIndex - (oldIndex < targetIndex ? 1 : 0)
  goals.splice(Math.max(0, Math.min(insertion, goals.length)), 0, doc.goals[oldIndex]!)
  return { ...doc, goals }
}
export function duplicateProgressGoal(goal: ProgressGoal): ProgressGoal {
  return { ...goal, id: uid(), config: { ...goal.config } }
}
export function progressIssues(doc: ProgressDocument, definitions: readonly GoalDefinition[]): string[] {
  const issues: string[] = []
  if (!doc.name.trim()) issues.push('请填写进度名称')
  if (!doc.goals.length) issues.push('添加至少一个目标')
  for (const goal of doc.goals) {
      const definition = definitions.find(item => item.kind === goal.kind)
      if (!definition) { issues.push(`目标类型 ${goal.kind || '（空）'} 的定义脚本未找到`); continue }
      for (const field of definition.fields) {
        const value = Object.hasOwn(goal.config, field.key) ? goal.config[field.key] : field.default
        if (field.required && (value === undefined || (typeof value === 'string' && !value.trim()))) issues.push(`${goalLabel(goal, definitions)}：请填写 ${field.label || field.key}`)
        if (value !== undefined && ((field.type === 'string' && typeof value !== 'string') || (field.type === 'bool' && typeof value !== 'boolean') || (['int', 'float'].includes(field.type) && typeof value !== 'number') || (field.type === 'int' && typeof value === 'number' && !Number.isInteger(value)))) issues.push(`${goalLabel(goal, definitions)}：${field.label || field.key} 类型不符合定义`)
      }
  }
  for (const [label, rules] of [['可见性条件', doc.visibility], ['可承接条件', doc.acceptance]] as const) {
    rules.forEach((rule, index) => { if (!rule.target.trim()) issues.push(`${label} ${index + 1}：请选择或填写对象`) })
  }
  return issues
}
