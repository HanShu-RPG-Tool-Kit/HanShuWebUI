import { parseCompletionGraph, completionIssues, type CompletionGraph } from './completionGraph'
import { randomId } from '../../project/crypto'
import { isObject } from './model'
import { parseJsonValue } from '../../utils/strictJson'
import { type GoalConfigValue, type GoalDefinition } from './goalDefinitions'
import {
  conditionRuleIssue,
  parseConditionRules,
  parseHideWhenRepeatUnsatisfied,
  type ProgressConditionRule,
} from './conditions'

export { conditionStatesFor, createConditionRule, emitConditionExpression } from './conditions'
export { DIALOGUE_VISIBILITY_STATES, EXPR_VISIBILITY_STATES, REPEAT_CYCLE_STATES, TASK_VISIBILITY_STATES } from './conditions'
export type { ProgressConditionRule } from './conditions'

export const PROGRESS_FORMAT = 'hanshu.progress'
export type ProgressConfigValue = GoalConfigValue
export type ProgressRepeatKind = 'once' | 'game_daily' | 'game_weekly' | 'real_daily' | 'real_weekly' | 'real_monthly' | 'duration' | 'manual'
export type ProgressGoal = { id: string; kind: string; config: Record<string, ProgressConfigValue> }
/** 任务追踪文本：单进度与多进度进度节点共用；编译进 questc（引擎可先忽略）。 */
export type ProgressTrackingMode = 'auto' | 'manual'
export type ProgressTracking = {
  mode: ProgressTrackingMode
  /** manual 时的本地化语义键；切回 auto 时可保留以免丢草稿。 */
  text?: string
}
/** questc / 运行模板上的追踪形态（无草稿键）。 */
export type QuestTracking = { mode: 'auto' } | { mode: 'manual'; text: string }
export type ProgressDocument = {
  format: typeof PROGRESS_FORMAT
  version: 1
  id: string
  name: string
  description: string
  authorNotes: string
  tags: string[]
  completion: 'all' | 'any' | 'custom'
  completionGraph?: CompletionGraph
  goals: ProgressGoal[]
  /** Independent conjunctions; each empty list is satisfied. */
  visibility: ProgressConditionRule[]
  acceptance: ProgressConditionRule[]
  /** After visibility expr, also require metadata.repeat satisfied. */
  hideWhenRepeatUnsatisfied: boolean
  abandonable: boolean
  /** When acceptance holds, start without a separate player accept action. Independent of visibility. */
  autoStartWhenAcceptable: boolean
  repeat: { kind: ProgressRepeatKind; hours: number }
  rewardKits: string[]
  /** 任务追踪文案；缺省＝自动（引擎提供）。编译进 questc 进度节点。 */
  tracking?: ProgressTracking
}
export const PROGRESS_REPEAT_LABELS: Record<ProgressRepeatKind, string> = {
  once: '仅一次', game_daily: '每个游戏日', game_weekly: '每个游戏周',
  real_daily: '每天', real_weekly: '每周', real_monthly: '每月', duration: '结束后间隔', manual: '手动重开',
}
const uid = () => randomId()
export function createProgressGoal(kind: string, _definitions: readonly GoalDefinition[] = []): ProgressGoal {
  return { id: uid(), kind, config: {} }
}
export function createProgress(name = '新建进度', _definitions: readonly GoalDefinition[] = []): ProgressDocument {
  void name
  return {
    format: PROGRESS_FORMAT, version: 1, id: uid(),
    name: 'name', description: 'description', authorNotes: '', tags: [],
    completion: 'all', goals: [], visibility: [], acceptance: [], hideWhenRepeatUnsatisfied: false,
    abandonable: true, autoStartWhenAcceptable: false, repeat: { kind: 'once', hours: 24 }, rewardKits: [],
    tracking: { mode: 'auto' },
  }
}

export const PROGRESS_TRACKING_TEXT_KEY = 'tracking'

/** 新建进度时写入默认语的文案种子（文档字段已是语义键） */
export function createProgressLocaleSeeds(name = '新建进度'): Record<string, string> {
  return { name: name.trim() || '新建进度', description: '' }
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
export function normalizeProgressTracking(
  tracking: ProgressTracking | undefined,
  fallbackText = PROGRESS_TRACKING_TEXT_KEY,
): ProgressTracking {
  const mode = tracking?.mode === 'manual' ? 'manual' : 'auto'
  const text = typeof tracking?.text === 'string' && tracking.text.trim() ? tracking.text.trim() : undefined
  if (mode === 'manual') return { mode: 'manual', text: text ?? fallbackText }
  return text ? { mode: 'auto', text } : { mode: 'auto' }
}

/** 编译到 questc：去掉 auto 下的草稿键。 */
export function emitQuestTracking(
  tracking: ProgressTracking | undefined,
  fallbackText = PROGRESS_TRACKING_TEXT_KEY,
): QuestTracking {
  const normalized = normalizeProgressTracking(tracking, fallbackText)
  return normalized.mode === 'manual'
    ? { mode: 'manual', text: normalized.text ?? fallbackText }
    : { mode: 'auto' }
}

export function parseQuestTracking(raw: unknown, path = 'tracking'): QuestTracking {
  if (!isObject(raw)) throw new Error(`${path} 必须是对象`)
  if (Object.keys(raw).some(key => key !== 'mode' && key !== 'text')) throw new Error(`${path} 含未知字段`)
  if (raw.mode === 'auto') {
    if (raw.text !== undefined) throw new Error(`${path}.auto 不应携带 text`)
    return { mode: 'auto' }
  }
  if (raw.mode === 'manual') {
    if (typeof raw.text !== 'string' || !raw.text.trim()) throw new Error(`${path}.text 不能为空`)
    return { mode: 'manual', text: raw.text.trim() }
  }
  throw new Error(`${path}.mode 必须是 auto 或 manual`)
}

export function stringifyProgress(doc: ProgressDocument) {
  return JSON.stringify({ ...doc,
    goals: doc.goals.map(({ id, kind, config }) => ({ id, kind, config })),
    repeat: doc.repeat.kind === 'duration' ? doc.repeat : { kind: doc.repeat.kind },
    tracking: normalizeProgressTracking(doc.tracking),
  }, null, 2) + '\n'
}

export function parseProgressTracking(raw: unknown, fallbackText = PROGRESS_TRACKING_TEXT_KEY): ProgressTracking {
  if (raw === undefined) return { mode: 'auto' }
  if (!isObject(raw)) throw new Error('tracking 必须是对象')
  // 试水期兼容刚写过的 default/advanced 草稿。
  const rawMode = raw.mode
  const mode =
    rawMode === 'auto' || rawMode === 'default' ? 'auto'
      : rawMode === 'manual' || rawMode === 'advanced' ? 'manual'
        : null
  if (!mode) throw new Error('tracking.mode 必须是 auto 或 manual')
  if (Object.keys(raw).some(key => !['mode', 'text', 'lines'].includes(key))) {
    throw new Error('tracking 含未知字段')
  }
  let text: string | undefined
  if (typeof raw.text === 'string' && raw.text.trim()) text = raw.text.trim()
  else if (Array.isArray(raw.lines) && raw.lines[0] && isObject(raw.lines[0]) && typeof raw.lines[0].text === 'string' && raw.lines[0].text.trim()) {
    text = raw.lines[0].text.trim()
  }
  if (mode === 'manual') return { mode: 'manual', text: text ?? fallbackText }
  return text ? { mode: 'auto', text } : { mode: 'auto' }
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
  const visibilityParsed = parseConditionRules(raw.visibility, '可见性条件', { allowHideRepeat: true })
  const acceptance = parseConditionRules(raw.acceptance, '可承接条件').rules
  const hideWhenRepeatUnsatisfied = parseHideWhenRepeatUnsatisfied(raw.hideWhenRepeatUnsatisfied, visibilityParsed.hideWhenRepeatUnsatisfied)
  const visibility = visibilityParsed.rules
  const docId = id(raw.id, '进度')
  check(raw.completion === 'all' || raw.completion === 'any' || raw.completion === 'custom', 'completion 必须是 all、any 或 custom')
  const completionGraph = raw.completionGraph === undefined ? undefined : parseCompletionGraph(raw.completionGraph)
  check(raw.completion !== 'custom' || completionGraph, '自定义完成需要 completionGraph')
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
  check(raw.autoStartWhenAcceptable === undefined || typeof raw.autoStartWhenAcceptable === 'boolean', 'autoStartWhenAcceptable 必须是布尔值')
  check(Array.isArray(raw.rewardKits) && raw.rewardKits.every(ref => typeof ref === 'string' && ref.trim()), 'rewardKits 必须是礼包引用数组')
  check(new Set(raw.rewardKits).size === raw.rewardKits.length, '奖励礼包不能重复')
  const tracking = parseProgressTracking(raw.tracking)
  return {
    format: PROGRESS_FORMAT, version: 1, id: docId, name: str(raw.name, '名称'), description: str(raw.description, '简介'),
    authorNotes: str(raw.authorNotes ?? '', '作者备注'), tags: raw.tags as string[], completion: raw.completion, goals,
    ...(completionGraph ? { completionGraph } : {}),
    visibility, acceptance, hideWhenRepeatUnsatisfied,
    abandonable: raw.abandonable, autoStartWhenAcceptable: raw.autoStartWhenAcceptable ?? false,
    repeat: { kind: raw.repeat.kind as ProgressRepeatKind, hours }, rewardKits: raw.rewardKits as string[],
    tracking,
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
export function progressIssues(
  doc: ProgressDocument,
  definitions: readonly GoalDefinition[],
  resolveText?: ((key: string) => string | null) | null,
): string[] {
  const issues: string[] = []
  if (resolveText) {
    if (!(resolveText(doc.name) ?? '').trim()) issues.push('请填写进度名称')
  } else if (doc.name !== 'name' && !doc.name.trim()) {
    issues.push('请填写进度名称')
  }
  if (doc.completion === 'custom' && doc.completionGraph) issues.push(...completionIssues(doc.completionGraph, doc.goals))
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
    rules.forEach((rule, index) => {
      const issue = conditionRuleIssue(rule, `${label} ${index + 1}`)
      if (issue) issues.push(issue)
    })
  }
  const tracking = doc.tracking ?? { mode: 'auto' as const }
  if (tracking.mode === 'manual') {
    const key = tracking.text?.trim() || PROGRESS_TRACKING_TEXT_KEY
    const line = resolveText?.(key) ?? ''
    if (resolveText && !line.trim()) issues.push('请填写手动追踪文案')
    else if (/[\r\n]/.test(line)) issues.push('手动追踪文案只能是一行')
  }
  return issues
}
