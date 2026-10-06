import { isObject } from './model'
import { parseJsonValue } from '../../utils/strictJson'
import { defaultConfigFromFields, type GoalConfigField, type GoalConfigValue, type GoalDefinition } from './goalDefinitions'

export const PROGRESS_FORMAT = 'hanshu.progress'

export type ProgressGroupKind = 'all' | 'choose_n' | 'any' | 'optional'
export type ProgressRepeatKind =
  | 'once'
  | 'game_daily'
  | 'game_weekly'
  | 'real_daily'
  | 'real_weekly'
  | 'real_monthly'
  | 'duration'
  | 'manual'

export type ProgressCondMode = 'default' | 'expr'

export type ProgressConfigValue = GoalConfigValue
export type ProgressConfigField = GoalConfigField

/** 目标实例：仅 kind + config；列表下标即 index。kind 必须来自目标定义目录。 */
export type ProgressGoal = {
  kind: string
  config: Record<string, ProgressConfigValue>
}

export type ProgressGoalGroup = {
  id: string
  kind: ProgressGroupKind
  /** choose_n 时有效 */
  count: number
  title: string
  /** 引用 goals 数组下标 */
  goals: number[]
}

export type ProgressCondition = {
  mode: ProgressCondMode
  expr: string
}

export type ProgressRepeat = {
  kind: ProgressRepeatKind
  /** duration：小时；其它策略可忽略 */
  hours: number
}

export type ProgressDocument = {
  format: typeof PROGRESS_FORMAT
  name: string
  description: string
  tags: string[]
  goals: ProgressGoal[]
  groups: ProgressGoalGroup[]
  accept: ProgressCondition
  deliver: ProgressCondition
  fail: ProgressCondition
  abandonable: boolean
  repeat: ProgressRepeat
  /** 礼包引用（文件名去 .kit），空表示无 */
  rewardKit: string
}

export const PROGRESS_GROUP_LABELS: Record<ProgressGroupKind, string> = {
  all: '必修 · 全部完成',
  choose_n: '选择性必修 · 完成 n 个',
  any: '多完成方式 · 完成其一',
  optional: '选修 · 不挡交付',
}

export const PROGRESS_REPEAT_LABELS: Record<ProgressRepeatKind, string> = {
  once: '终身一次',
  game_daily: '游戏日刷新',
  game_weekly: '游戏周刷新',
  real_daily: '现实日刷新',
  real_weekly: '现实周刷新',
  real_monthly: '现实月刷新',
  duration: '结束后间隔',
  manual: '仅手动重开',
}

const uid = () => crypto.randomUUID().slice(0, 8)

export function defaultConfigForKind(kind: string, definitions: readonly GoalDefinition[] = []): Record<string, ProgressConfigValue> {
  const def = definitions.find((item) => item.kind === kind)
  return defaultConfigFromFields(def?.fields ?? [])
}

export function createProgressGoal(kind = '', definitions: readonly GoalDefinition[] = []): ProgressGoal {
  const resolved = kind || definitions[0]?.kind || ''
  return { kind: resolved, config: defaultConfigForKind(resolved, definitions) }
}

export function goalLabel(goal: ProgressGoal, index: number, definitions: readonly GoalDefinition[] = []) {
  const name = definitions.find((item) => item.kind === goal.kind)?.label ?? (goal.kind || '（未选种类）')
  return `#${index} ${name}`
}

export function createProgress(name = '新建委托', definitions: readonly GoalDefinition[] = []): ProgressDocument {
  const first = createProgressGoal(definitions[0]?.kind ?? '', definitions)
  return {
    format: PROGRESS_FORMAT,
    name,
    description: '',
    tags: [],
    goals: first.kind ? [first] : [],
    groups: [{ id: uid(), kind: 'all', count: 1, title: '主目标', goals: first.kind ? [0] : [] }],
    accept: { mode: 'default', expr: '' },
    deliver: { mode: 'default', expr: '' },
    fail: { mode: 'default', expr: '' },
    abandonable: true,
    repeat: { kind: 'once', hours: 24 },
    rewardKit: '',
  }
}

export function stringifyProgress(doc: ProgressDocument): string {
  const body: Record<string, unknown> = {
    format: PROGRESS_FORMAT,
    name: doc.name,
    description: doc.description,
    goals: doc.goals.map((goal) => ({
      kind: goal.kind,
      ...(Object.keys(goal.config).length ? { config: goal.config } : {}),
    })),
    groups: doc.groups.map((group) => ({
      id: group.id,
      kind: group.kind,
      title: group.title,
      goals: group.goals,
      ...(group.kind === 'choose_n' ? { count: group.count } : {}),
    })),
    accept: condOut(doc.accept),
    deliver: condOut(doc.deliver),
    fail: condOut(doc.fail),
    abandonable: doc.abandonable,
    repeat: doc.repeat.kind === 'duration'
      ? { kind: doc.repeat.kind, hours: doc.repeat.hours }
      : { kind: doc.repeat.kind },
  }
  if (doc.tags.length) body.tags = doc.tags
  if (doc.rewardKit.trim()) body.rewardKit = doc.rewardKit.trim()
  return `${JSON.stringify(body, null, 2)}\n`
}

function condOut(cond: ProgressCondition) {
  return cond.mode === 'expr' && cond.expr.trim()
    ? { mode: 'expr', expr: cond.expr.trim() }
    : { mode: 'default' }
}

function readConfig(kind: string, raw: unknown, legacyText?: unknown, definitions: readonly GoalDefinition[] = []): Record<string, ProgressConfigValue> {
  const base = defaultConfigForKind(kind, definitions)
  if (isObject(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') base[key] = value
    }
    return base
  }
  // 旧草稿：configText 多行 key=value
  if (typeof legacyText === 'string' && legacyText.trim()) {
    for (const line of legacyText.split(/\r?\n/)) {
      const match = /^\s*([^=]+)=(.*)$/.exec(line)
      if (!match) continue
      const key = match[1]!.trim()
      const text = match[2]!.trim()
      if (!key) continue
      if (text === 'true' || text === 'false') base[key] = text === 'true'
      else if (text !== '' && Number.isFinite(Number(text))) base[key] = Number(text)
      else base[key] = text
    }
  }
  return base
}

export function parseProgress(source: string, definitions: readonly GoalDefinition[] = []): ProgressDocument {
  const raw = parseJsonValue(source)
  if (!isObject(raw)) throw new Error('进度文档必须是 JSON 对象')
  if (raw.format !== undefined && raw.format !== PROGRESS_FORMAT) {
    throw new Error(`未知进度格式：${String(raw.format)}`)
  }
  const base = createProgress(typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : '未命名委托', definitions)
  const goals = Array.isArray(raw.goals)
    ? raw.goals.filter(isObject).map((item) => {
      const kind = typeof item.kind === 'string' && item.kind ? item.kind : ''
      return { kind, config: readConfig(kind, item.config, item.configText, definitions) }
    })
    : base.goals
  const groups = Array.isArray(raw.groups)
    ? raw.groups.filter(isObject).map((item, index) => {
      const kind = isGroupKind(item.kind) ? item.kind : 'all'
      let indexes: number[] = []
      if (Array.isArray(item.goals)) {
        indexes = item.goals.filter((value): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < goals.length)
      } else if (Array.isArray(item.goalIds) && Array.isArray(raw.goals)) {
        // 旧草稿用 id；按出现顺序映射
        const idToIndex = new Map<string, number>()
        raw.goals.forEach((goal, goalIndex) => {
          if (isObject(goal) && typeof goal.id === 'string' && goal.id && !idToIndex.has(goal.id)) idToIndex.set(goal.id, goalIndex)
        })
        indexes = item.goalIds
          .map((id) => typeof id === 'string' ? idToIndex.get(id) : undefined)
          .filter((value): value is number => value !== undefined)
      }
      return {
        id: typeof item.id === 'string' && item.id ? item.id : `grp${index}`,
        kind,
        count: typeof item.count === 'number' && item.count > 0 ? Math.floor(item.count) : 1,
        title: typeof item.title === 'string' ? item.title : `组 ${index + 1}`,
        goals: indexes,
      }
    })
    : base.groups
  return {
    format: PROGRESS_FORMAT,
    name: base.name,
    description: typeof raw.description === 'string' ? raw.description : '',
    tags: readTags(raw.tags),
    goals,
    groups: groups.length ? groups : [{ id: uid(), kind: 'all', count: 1, title: '主目标', goals: goals.map((_, index) => index) }],
    accept: readCond(raw.accept),
    deliver: readCond(raw.deliver),
    fail: readCond(raw.fail),
    abandonable: raw.abandonable !== false,
    repeat: readRepeat(raw.repeat),
    rewardKit: typeof raw.rewardKit === 'string' ? raw.rewardKit.trim() : '',
  }
}

export function readProgressSource(source: string, definitions: readonly GoalDefinition[] = []): { doc: ProgressDocument; error: string } {
  try {
    return { doc: parseProgress(source, definitions), error: '' }
  } catch (error) {
    return { doc: createProgress('未命名委托', definitions), error: error instanceof Error ? error.message : String(error) }
  }
}

/** 删除 goals[index] 后重写各组下标。 */
export function removeGoalAt(doc: ProgressDocument, index: number): ProgressDocument {
  const goals = doc.goals.filter((_, i) => i !== index)
  const groups = doc.groups.map((group) => ({
    ...group,
    goals: group.goals
      .filter((item) => item !== index)
      .map((item) => item > index ? item - 1 : item),
  }))
  return { ...doc, goals, groups }
}

function isGroupKind(value: unknown): value is ProgressGroupKind {
  return value === 'all' || value === 'choose_n' || value === 'any' || value === 'optional'
}

function isRepeatKind(value: unknown): value is ProgressRepeatKind {
  return value === 'once' || value === 'game_daily' || value === 'game_weekly'
    || value === 'real_daily' || value === 'real_weekly' || value === 'real_monthly'
    || value === 'duration' || value === 'manual'
}

function readTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const tags: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const tag = item.trim().normalize('NFC')
    if (!tag) continue
    const key = tag.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
  }
  return tags
}

function readCond(value: unknown): ProgressCondition {
  if (!isObject(value)) return { mode: 'default', expr: '' }
  if (value.mode === 'expr') {
    return { mode: 'expr', expr: typeof value.expr === 'string' ? value.expr : '' }
  }
  return { mode: 'default', expr: typeof value.expr === 'string' ? value.expr : '' }
}

function readRepeat(value: unknown): ProgressRepeat {
  if (!isObject(value) || !isRepeatKind(value.kind)) return { kind: 'once', hours: 24 }
  return {
    kind: value.kind,
    hours: typeof value.hours === 'number' && value.hours > 0 ? value.hours : 24,
  }
}

export function createProgressGroup(title = '新组'): ProgressGoalGroup {
  return { id: uid(), kind: 'all', count: 1, title, goals: [] }
}

/** 人话摘要，给表单底部对照 */
export function summarizeProgress(doc: ProgressDocument, definitions: readonly GoalDefinition[] = []): string[] {
  const lines: string[] = []
  lines.push(doc.name || '未命名')
  if (doc.tags.length) lines.push(`标签：${doc.tags.join('、')}`)
  const accept = doc.accept.mode === 'expr' && doc.accept.expr.trim()
    ? `可接取：${doc.accept.expr.trim()}`
    : '可接取：默认（冷却结束等）'
  lines.push(accept)
  if (doc.goals.length) {
    lines.push(`目标：${doc.goals.map((goal, index) => goalLabel(goal, index, definitions)).join('、')}`)
  }
  for (const group of doc.groups) {
    const refs = group.goals
      .filter((index) => index >= 0 && index < doc.goals.length)
      .map((index) => goalLabel(doc.goals[index]!, index, definitions))
    const head = group.kind === 'choose_n'
      ? `${group.title || '组'} · 完成 ${group.count} 个`
      : `${group.title || '组'} · ${PROGRESS_GROUP_LABELS[group.kind]}`
    lines.push(`${head}：${refs.length ? refs.join('、') : '（未挂目标）'}`)
  }
  const deliver = doc.deliver.mode === 'expr' && doc.deliver.expr.trim()
    ? `可交付：${doc.deliver.expr.trim()}`
    : '可交付：默认（非选修组均满足）'
  lines.push(deliver)
  if (doc.fail.mode === 'expr' && doc.fail.expr.trim()) lines.push(`失败：${doc.fail.expr.trim()}`)
  lines.push(`放弃：${doc.abandonable ? '允许' : '不允许'}`)
  const repeat = doc.repeat.kind === 'duration'
    ? `刷新：结束后 ${doc.repeat.hours} 小时`
    : `刷新：${PROGRESS_REPEAT_LABELS[doc.repeat.kind]}`
  lines.push(repeat)
  if (doc.rewardKit.trim()) lines.push(`奖励礼包：${doc.rewardKit.trim()}`)
  return lines
}
