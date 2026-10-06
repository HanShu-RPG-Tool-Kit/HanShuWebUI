import { isObject } from './model'
import { parseJsonValue } from '../../utils/strictJson'
import { itemFingerprint, readItemStackDisplay, type ItemStackDisplay } from './itemstack'
import { buildKitModifierEnv, interpolateKitText, resolveKitNumber, type KitModifierEnv, type KitNumberRule } from './kitExpr'

/** 数值字段 → 绑定的修饰器 id；最终值 = 字段规则(修饰器(raw)) */
export type KitMods<K extends string> = Partial<Record<K, string>>

/** Minecraft 1.20.5+ ItemStack：id / count / components；display 仅编辑器展示，运行时忽略 */
export type KitItem = {
  id: string
  count: number
  components: Record<string, unknown>
  display?: ItemStackDisplay
  mods?: KitMods<'count'>
}

export type KitExperienceKind = 'levels' | 'points'
export type KitExperience = {
  kind: KitExperienceKind
  amount: number
  mods?: KitMods<'amount'>
}

export type KitEffect = {
  id: string
  /** 0 起，与 /effect 的 amplifier 一致 */
  amplifier: number
  /** 秒；0 表示无限 */
  duration: number
  particles: boolean
  /** amplifier 绑定的输入是等级（amplifier + 1） */
  mods?: KitMods<'amplifier' | 'duration'>
}

export type KitFeedback = {
  message: string
  title: string
  subtitle: string
  sound: string
}

export type KitPoolEntry = {
  weight: number
  items: KitItem[]
  mods?: KitMods<'weight'>
}

/** 每次领取从 entries 中按权重抽取 rolls 次 */
export type KitPool = {
  rolls: number
  entries: KitPoolEntry[]
  mods?: KitMods<'rolls'>
}

export type KitDocument = {
  name: string
  /**
   * 继承：单个父礼包引用（资源文件名去掉 `.kit`）。
   * 先展开父礼包，再按卡片稀疏覆盖本文件字段，最后叠 includes。
   */
  extends: string
  /** 组合：按顺序追加其它礼包的物品/池/效果/指令 */
  includes: string[]
  /**
   * 游戏标签（类似 MC Tag 的成员声明）：引擎可按标签查询 / 发放。
   * 继承时与父礼包并集；组合 includes 不并入宿主标签。
   */
  tags: string[]
  /**
   * 超参数声明：由作者与后端引擎约定、领取时注入。
   * 每项必须有默认值；`id` 为空的条目运行时忽略。
   */
  params: KitParam[]
  /**
   * 修饰器：标量一元函数 f(x)，x 为条目字段的 rawdata，表达式遵循 hanshu.kit.expr V1。
   * `id` 为空的条目运行时忽略。
   */
  modifiers: KitModifier[]
  items: KitItem[]
  pools: KitPool[]
  effects: KitEffect[]
  commands: string[]
  experience: KitExperience
  feedback: KitFeedback
  /** 内联脚本原文，不是外调路径 */
  script: string
}

/** 礼包参数类型（声明时指定，默认值必须可按此解释） */
export type KitParamKind = 'float' | 'int' | 'string' | 'bool'

/** 超参数：领取时由引擎注入；缺省用 default */
export type KitParam = {
  id: string
  kind: KitParamKind
  default: number | string | boolean
  hint: string
}

export type KitModifier = {
  id: string
  label: string
  /** hanshu.kit.expr V1 表达式；`x` 为输入 rawdata */
  expr: string
}

/** 礼包目录：key 为规范化引用（无 `.kit` 后缀） */
export type KitCatalog = ReadonlyMap<string, KitDocument>

export type KitFlattenResult = {
  kit: KitDocument
  /** 展开顺序（含自身），便于 UI 展示来源链 */
  chain: string[]
  errors: string[]
}

const MAX_KIT_DEPTH = 8

/** `starter.kit` / `starter` → `starter` */
export function normalizeKitRef(value: string): string {
  return value.trim().replace(/\.kit$/i, '')
}

export function kitRefFromFileName(fileName: string): string {
  return normalizeKitRef(fileName)
}

/** 标识符非空才生效；空 id 的参数/修饰器被无视 */
export function isKitBindingId(id: string): boolean {
  return id.trim().length > 0
}

export function activeKitParams(params: KitParam[]): KitParam[] {
  return params.filter((param) => isKitBindingId(param.id))
}

export function activeKitModifiers(modifiers: KitModifier[]): KitModifier[] {
  return modifiers.filter((modifier) => isKitBindingId(modifier.id))
}

/** 规范化标签：去首尾空白；空串视为无效 */
export function normalizeKitTag(value: string): string {
  return value.trim().normalize('NFC')
}

/** 去重并集：大小写不敏感，保留先出现的写法 */
export function unionKitTags(...groups: string[][]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const group of groups) {
    for (const raw of group) {
      const tag = normalizeKitTag(raw)
      if (!tag) continue
      const key = tag.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      result.push(tag)
    }
  }
  return result
}

export function createKitParam(id = '', kind: KitParamKind = 'float'): KitParam {
  const defaults: Record<KitParamKind, number | string | boolean> = {
    float: 1,
    int: 0,
    string: '',
    bool: false,
  }
  return { id, kind, default: defaults[kind], hint: '' }
}

/** 新建礼包默认带的超参数（引擎约定注入） */
export function defaultKitParams(): KitParam[] {
  return [
    { id: 'intensity', kind: 'float', default: 1, hint: '奖励强度' },
    { id: 'difficulty', kind: 'int', default: 0, hint: '难度' },
    { id: 'distributionCount', kind: 'int', default: 1, hint: '本次参与分配的人数' },
    { id: 'distributionId', kind: 'int', default: 0, hint: '当前玩家在本次分配中的序号（0 起）' },
  ]
}

export function createKitModifier(id = ''): KitModifier {
  return { id, label: '', expr: 'x' }
}

/** 条目数值字段的取整与下限规则（Standard V1 §9） */
export const KIT_NUMBER_RULES = {
  count: { int: true, min: 0 },
  level: { int: true, min: 1 },
  duration: { int: true, min: 0 },
  amount: { int: true, min: 0 },
  rolls: { int: true, min: 1 },
  weight: { int: true, min: 0 },
} satisfies Record<string, KitNumberRule>

export function kitModifierEnv(kit: Pick<KitDocument, 'params' | 'modifiers'>, overrides?: Record<string, unknown>): KitModifierEnv {
  return buildKitModifierEnv(kit.params, kit.modifiers, overrides)
}

export type KitResolveIssue = { path: string; level: 'error' | 'warning'; message: string }

export type KitResolved = KitDocument & {
  env: KitModifierEnv
  issues: KitResolveIssue[]
}

/**
 * 按修饰器绑定计算条目字段最终值（用于预览 / 运行时对齐）。
 * 通常传入 flatten 之后的礼包；`overrides` 模拟引擎注入的超参数。
 */
export function resolveKit(kit: KitDocument, overrides?: Record<string, unknown>): KitResolved {
  const env = kitModifierEnv(kit, overrides)
  const issues: KitResolveIssue[] = []
  const field = (path: string, raw: number, mod: string | undefined, rule: KitNumberRule) => {
    const result = resolveKitNumber(raw, mod, env, rule)
    if (result.error) issues.push({ path, level: 'error', message: result.error })
    else if (result.warning) issues.push({ path, level: 'warning', message: result.warning })
    return result.value
  }
  const item = (path: string, value: KitItem): KitItem => ({ ...value, count: field(`${path}.count`, value.count, value.mods?.count, KIT_NUMBER_RULES.count) })

  return {
    ...kit,
    env,
    issues,
    items: kit.items.map((value, index) => item(`items[${index}]`, value)),
    effects: kit.effects.map((effect, index) => ({
      ...effect,
      amplifier: field(`effects[${index}].amplifier`, effect.amplifier + 1, effect.mods?.amplifier, KIT_NUMBER_RULES.level) - 1,
      // 0 表示无限时长，不经修饰器
      duration: effect.duration === 0 ? 0 : field(`effects[${index}].duration`, effect.duration, effect.mods?.duration, KIT_NUMBER_RULES.duration),
    })),
    pools: kit.pools.map((pool, poolIndex) => ({
      ...pool,
      rolls: field(`pools[${poolIndex}].rolls`, pool.rolls, pool.mods?.rolls, KIT_NUMBER_RULES.rolls),
      entries: pool.entries.map((entry, entryIndex) => ({
        ...entry,
        weight: field(`pools[${poolIndex}].entries[${entryIndex}].weight`, entry.weight, entry.mods?.weight, KIT_NUMBER_RULES.weight),
        items: entry.items.map((value, itemIndex) => item(`pools[${poolIndex}].entries[${entryIndex}].items[${itemIndex}]`, value)),
      })),
    })),
    commands: kit.commands.map((command, index) => {
      const result = interpolateKitText(command, env)
      for (const message of result.errors) issues.push({ path: `commands[${index}]`, level: 'error', message })
      return result.text
    }),
    experience: {
      ...kit.experience,
      amount: field('experience.amount', kit.experience.amount, kit.experience.mods?.amount, KIT_NUMBER_RULES.amount),
    },
  }
}

export function createKitItem(id = '', count = 1): KitItem {
  return { id, count, components: {} }
}

export function createKitEffect(): KitEffect {
  return { id: '', amplifier: 0, duration: 30, particles: true }
}

export function createKitPoolEntry(): KitPoolEntry {
  return { weight: 1, items: [createKitItem()] }
}

export function createKitPool(): KitPool {
  return { rolls: 1, entries: [createKitPoolEntry()] }
}

export type KitPoolHit = { pool: number; roll: number; entry: number }

/** 每个池独立抽 rolls 次，每次按权重放回抽一个分组；总权重为 0 的池不产出 */
export function rollKitPools(pools: KitPool[], random: () => number = Math.random): KitPoolHit[] {
  const hits: KitPoolHit[] = []
  pools.forEach((pool, poolIndex) => {
    const total = pool.entries.reduce((sum, entry) => sum + entry.weight, 0)
    if (total <= 0) return
    for (let roll = 0; roll < pool.rolls; roll++) {
      let ticket = random() * total
      const entry = pool.entries.findIndex((candidate) => (ticket -= candidate.weight) < 0)
      hits.push({ pool: poolIndex, roll, entry: entry < 0 ? pool.entries.length - 1 : entry })
    }
  })
  return hits
}

const emptyFeedback = (): KitFeedback => ({ message: '', title: '', subtitle: '', sound: '' })

export function createKit(name = '新礼包'): KitDocument {
  return {
    name,
    extends: '',
    includes: [],
    tags: [],
    params: defaultKitParams(),
    modifiers: [],
    items: [],
    pools: [],
    effects: [],
    commands: [],
    experience: { kind: 'points', amount: 0 },
    feedback: emptyFeedback(),
    script: '',
  }
}

/** 仅本层内容（去掉引用），用于合并时叠本地字段 */
function localLayer(kit: KitDocument): KitDocument {
  return { ...kit, extends: '', includes: [] }
}

function feedbackSet(feedback: KitFeedback): boolean {
  return Boolean(feedback.message || feedback.title || feedback.subtitle || feedback.sound)
}

/** 按标识符覆盖：同 id 原位替换，新 id 追加；空 id 的条目被无视，不参与合并 */
function overrideById<T extends { id: string }>(base: T[], overlay: T[]): T[] {
  const result = [...base]
  for (const item of overlay) {
    if (!isKitBindingId(item.id)) continue
    const index = result.findIndex((candidate) => candidate.id === item.id)
    if (index >= 0) result[index] = item
    else result.push(item)
  }
  return result
}

/**
 * 继承合并：内容卡按卡片覆盖，声明卡按标识符覆盖。
 * - tags：与父礼包并集（去重）；组合 includes 另走 concat，不改标签
 * - params / modifiers：同 id 覆盖父礼包的定义，新 id 追加
 * - items / pools / effects / commands：非空数组整表替换
 * - experience：amount>0 时替换整张经验卡
 * - feedback：任一字段非空则整张反馈卡替换
 * - script：非空则替换
 */
export function overlayKitLayer(base: KitDocument, overlay: KitDocument): KitDocument {
  return {
    name: overlay.name || base.name,
    extends: '',
    includes: [],
    tags: unionKitTags(base.tags, overlay.tags),
    params: overrideById(base.params, overlay.params),
    modifiers: overrideById(base.modifiers, overlay.modifiers),
    items: overlay.items.length > 0 ? overlay.items : base.items,
    pools: overlay.pools.length > 0 ? overlay.pools : base.pools,
    effects: overlay.effects.length > 0 ? overlay.effects : base.effects,
    commands: overlay.commands.length > 0 ? overlay.commands : base.commands,
    experience: overlay.experience.amount > 0 ? overlay.experience : base.experience,
    feedback: feedbackSet(overlay.feedback) ? { ...overlay.feedback } : { ...base.feedback },
    script: overlay.script || base.script,
  }
}

/**
 * 按 id 并入声明：已有同 id 的保留前者；定义不同则记一条冲突。空 id 的条目不并入。
 */
function unionById<T extends { id: string }>(base: T[], extra: T[], kind: string, from: string, errors: string[]): T[] {
  const result = [...base]
  for (const item of extra) {
    if (!isKitBindingId(item.id)) continue
    const existing = result.find((candidate) => candidate.id === item.id)
    if (!existing) result.push(item)
    else if (JSON.stringify(existing) !== JSON.stringify(item)) errors.push(`组合「${from}」的${kind}「${item.id}」与已有定义不同，保留先声明的一份`)
  }
  return result
}

/**
 * 组合合并（并入）：追加内容卡；超参数 / 修饰器按 id 并入（先到者优先），不动经验 / 反馈 / 脚本 / 标签。
 * 继承特化先发生，组合模块叠在最终内容上。
 */
export function concatKitLayer(base: KitDocument, overlay: KitDocument, errors: string[] = [], from = overlay.name): KitDocument {
  return {
    ...base,
    extends: '',
    includes: [],
    tags: base.tags,
    params: unionById(base.params, overlay.params, '超参数', from, errors),
    modifiers: unionById(base.modifiers, overlay.modifiers, '修饰器', from, errors),
    items: [...base.items, ...overlay.items],
    pools: [...base.pools, ...overlay.pools],
    effects: [...base.effects, ...overlay.effects],
    commands: [...base.commands, ...overlay.commands],
  }
}

/** @deprecated 使用 overlayKitLayer；保留别名以免外部旧引用断裂 */
export const mergeKitLayer = overlayKitLayer

/** 合并起点：不带新建礼包的默认超参数，避免凭空并入 */
const emptyLayer = (name = ''): KitDocument => ({ ...createKit(name), params: [] })

function resolveRef(
  ref: string,
  selfRef: string,
  self: KitDocument,
  catalog: KitCatalog,
  stack: string[],
  errors: string[],
  chain: string[],
): KitDocument {
  const key = normalizeKitRef(ref)
  if (!key) return emptyLayer()
  if (stack.includes(key)) {
    errors.push(`礼包引用成环：${[...stack, key].join(' → ')}`)
    return emptyLayer()
  }
  if (stack.length >= MAX_KIT_DEPTH) {
    errors.push(`礼包引用过深（>${MAX_KIT_DEPTH}）：${key}`)
    return emptyLayer()
  }

  const source = key === normalizeKitRef(selfRef) ? self : catalog.get(key)
  if (!source) {
    errors.push(`找不到礼包「${key}」`)
    return emptyLayer()
  }

  const nextStack = [...stack, key]
  chain.push(key)
  let acc = emptyLayer(source.name)

  // 继承：父礼包为基线，本层按卡片覆盖；组合：再追加内容模块
  if (source.extends) {
    acc = overlayKitLayer(acc, resolveRef(source.extends, selfRef, self, catalog, nextStack, errors, chain))
  }
  acc = overlayKitLayer(acc, localLayer(source))
  for (const include of source.includes) {
    if (!normalizeKitRef(include)) continue
    acc = concatKitLayer(acc, resolveRef(include, selfRef, self, catalog, nextStack, errors, chain), errors, normalizeKitRef(include))
  }
  acc.name = source.name
  return acc
}

/**
 * 展开继承与组合，得到领取时的有效礼包。
 * `selfRef` 为当前文件引用名；`catalog` 为其它礼包（通常不含自身，或会被 self 覆盖）。
 */
export function flattenKit(
  kit: KitDocument,
  selfRef: string,
  catalog: KitCatalog = new Map(),
): KitFlattenResult {
  const errors: string[] = []
  const chain: string[] = []
  const key = normalizeKitRef(selfRef) || normalizeKitRef(kit.name) || 'kit'
  const flat = resolveRef(key, key, kit, catalog, [], errors, chain)
  flat.name = kit.name
  return { kit: flat, chain, errors }
}

function cleanMods<K extends string>(mods: KitMods<K> | undefined): KitMods<K> | undefined {
  if (!mods) return undefined
  const entries = Object.entries(mods).filter(([, id]) => typeof id === 'string' && id.trim() !== '')
  return entries.length > 0 ? Object.fromEntries(entries) as KitMods<K> : undefined
}

function withMods<T extends { mods?: KitMods<string> }>(value: T): Omit<T, 'mods'> & { mods?: KitMods<string> } {
  const { mods, ...rest } = value
  const cleaned = cleanMods(mods)
  return cleaned ? { ...rest, mods: cleaned } : rest
}

function writeItem(item: KitItem): Record<string, unknown> {
  const next: Record<string, unknown> = { id: item.id, count: item.count }
  const mods = cleanMods(item.mods)
  if (mods) next.mods = mods
  if (Object.keys(item.components).length > 0) next.components = item.components
  if (item.display) next.display = item.display
  return next
}

export function stringifyKit(kit: KitDocument): string {
  const out: Record<string, unknown> = { name: kit.name }
  const parent = normalizeKitRef(kit.extends)
  if (parent) out.extends = parent
  const includes = kit.includes.map(normalizeKitRef).filter(Boolean)
  if (includes.length > 0) out.includes = includes
  const tags = unionKitTags(kit.tags)
  if (tags.length > 0) out.tags = tags
  if (kit.params.length > 0) {
    out.params = kit.params.map((param) => ({
      id: param.id,
      kind: param.kind,
      default: param.default,
      ...(param.hint ? { hint: param.hint } : {}),
    }))
  }
  if (kit.modifiers.length > 0) {
    out.modifiers = kit.modifiers.map((modifier) => ({
      id: modifier.id,
      ...(modifier.label ? { label: modifier.label } : {}),
      expr: modifier.expr,
    }))
  }
  out.items = kit.items.map(writeItem)
  if (kit.pools.length > 0) {
    out.pools = kit.pools.map((pool) => {
      const mods = cleanMods(pool.mods)
      return {
        rolls: pool.rolls,
        ...(mods ? { mods } : {}),
        entries: pool.entries.map((entry) => {
          const entryMods = cleanMods(entry.mods)
          return { weight: entry.weight, ...(entryMods ? { mods: entryMods } : {}), items: entry.items.map(writeItem) }
        }),
      }
    })
  }
  if (kit.effects.length > 0) out.effects = kit.effects.map(withMods)
  out.commands = kit.commands
  out.experience = withMods(kit.experience)
  const feedback = Object.fromEntries(Object.entries(kit.feedback).filter(([, value]) => value !== ''))
  if (Object.keys(feedback).length > 0) out.feedback = feedback
  out.script = kit.script
  return `${JSON.stringify(out, null, 2)}\n`
}

const readInt = (value: unknown, fallback: number, min = 0) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.floor(value)) : fallback

const readString = (value: unknown) => typeof value === 'string' ? value : ''

function readList<T>(value: unknown, path: string, read: (item: unknown, path: string) => T): T[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${path} 应为数组`)
  return value.map((item, index) => read(item, `${path}[${index}]`))
}

function readMods<K extends string>(value: unknown, path: string, keys: readonly K[]): KitMods<K> | undefined {
  if (value === undefined) return undefined
  if (!isObject(value)) throw new Error(`${path} 应为对象`)
  const mods: KitMods<K> = {}
  for (const key of keys) {
    const id = value[key]
    if (id === undefined) continue
    if (typeof id !== 'string') throw new Error(`${path}.${key} 应为修饰器 id 字符串`)
    if (id.trim()) mods[key] = id.trim()
  }
  return Object.keys(mods).length > 0 ? mods : undefined
}

function readItem(value: unknown, path: string): KitItem {
  if (!isObject(value)) throw new Error(`${path} 应为 ItemStack 对象`)
  let components: Record<string, unknown> = {}
  if (value.components !== undefined) {
    if (!isObject(value.components)) throw new Error(`${path}.components 应为对象`)
    components = value.components
  }
  const display = readItemStackDisplay(value.display)
  const item: KitItem = { id: readString(value.id), count: readInt(value.count, 1), components }
  const mods = readMods(value.mods, `${path}.mods`, ['count'])
  if (mods) item.mods = mods
  if (display) {
    // 早期存档没有指纹：视为保存时快照有效
    item.display = display.snapshotOf ? display : { ...display, snapshotOf: itemFingerprint(item) }
  }
  return item
}

function readEffect(value: unknown, path: string): KitEffect {
  if (!isObject(value)) throw new Error(`${path} 应为对象`)
  const effect: KitEffect = {
    id: readString(value.id),
    amplifier: readInt(value.amplifier, 0),
    duration: readInt(value.duration, 30),
    particles: value.particles !== false,
  }
  const mods = readMods(value.mods, `${path}.mods`, ['amplifier', 'duration'])
  if (mods) effect.mods = mods
  return effect
}

function readPool(value: unknown, path: string): KitPool {
  if (!isObject(value)) throw new Error(`${path} 应为对象`)
  const pool: KitPool = {
    rolls: readInt(value.rolls, 1, 1),
    entries: readList(value.entries, `${path}.entries`, (entry, entryPath) => {
      if (!isObject(entry)) throw new Error(`${entryPath} 应为对象`)
      const next: KitPoolEntry = { weight: readInt(entry.weight, 1), items: readList(entry.items, `${entryPath}.items`, readItem) }
      const mods = readMods(entry.mods, `${entryPath}.mods`, ['weight'])
      if (mods) next.mods = mods
      return next
    }),
  }
  const mods = readMods(value.mods, `${path}.mods`, ['rolls'])
  if (mods) pool.mods = mods
  return pool
}

function readFeedback(value: unknown): KitFeedback {
  if (!isObject(value)) return emptyFeedback()
  return {
    message: readString(value.message),
    title: readString(value.title),
    subtitle: readString(value.subtitle),
    sound: readString(value.sound),
  }
}

function readExperience(value: unknown): KitExperience {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { kind: 'points', amount: Math.max(0, Math.floor(value)) }
  }
  if (isObject(value)) {
    const experience: KitExperience = { kind: value.kind === 'levels' ? 'levels' : 'points', amount: readInt(value.amount, 0) }
    const mods = readMods(value.mods, 'experience.mods', ['amount'])
    if (mods) experience.mods = mods
    return experience
  }
  return { kind: 'points', amount: 0 }
}

function readKitRef(value: unknown, path: string): string {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string') throw new Error(`${path} 应为字符串`)
  return normalizeKitRef(value)
}

const PARAM_KINDS: KitParamKind[] = ['float', 'int', 'string', 'bool']

function readParamDefault(kind: KitParamKind, value: unknown): number | string | boolean {
  if (kind === 'bool') return value === true || value === 'true' || value === 1
  if (kind === 'string') return typeof value === 'string' ? value : value == null ? '' : String(value)
  if (kind === 'int') {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value)
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Math.floor(Number(value))
    return 0
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return 1
}

function readParam(value: unknown, path: string): KitParam {
  if (!isObject(value)) throw new Error(`${path} 应为对象`)
  const kind = PARAM_KINDS.includes(value.kind as KitParamKind) ? value.kind as KitParamKind : 'float'
  if (!('default' in value)) throw new Error(`${path}.default 必填`)
  return {
    id: readString(value.id),
    kind,
    default: readParamDefault(kind, value.default),
    hint: readString(value.hint),
  }
}

function readModifier(value: unknown, path: string): KitModifier {
  if (!isObject(value)) throw new Error(`${path} 应为对象`)
  if (value.expr !== undefined && typeof value.expr !== 'string') throw new Error(`${path}.expr 应为字符串`)
  return {
    id: readString(value.id),
    label: readString(value.label),
    expr: typeof value.expr === 'string' ? value.expr : 'x',
  }
}

export function parseKit(source: string): KitDocument {
  const raw = parseJsonValue(source.replace(/^\uFEFF/, ''))
  if (!isObject(raw)) throw new Error('礼包根节点应为 JSON 对象')
  return {
    name: readString(raw.name),
    extends: readKitRef(raw.extends, 'extends'),
    includes: readList(raw.includes, 'includes', (item, path) => {
      const ref = readKitRef(item, path)
      if (!ref) throw new Error(`${path} 不能为空`)
      return ref
    }),
    tags: readList(raw.tags, 'tags', (item, path) => {
      if (typeof item !== 'string') throw new Error(`${path} 应为字符串`)
      const tag = normalizeKitTag(item)
      if (!tag) throw new Error(`${path} 不能为空`)
      return tag
    }).filter((tag, index, list) => list.findIndex((candidate) => candidate.toLowerCase() === tag.toLowerCase()) === index),
    params: readList(raw.params, 'params', readParam),
    modifiers: readList(raw.modifiers, 'modifiers', readModifier),
    items: readList(raw.items, 'items', readItem),
    pools: readList(raw.pools, 'pools', readPool),
    effects: readList(raw.effects, 'effects', readEffect),
    commands: readList(raw.commands, 'commands', (command, path) => {
      if (typeof command !== 'string') throw new Error(`${path} 应为字符串`)
      return command
    }),
    experience: readExperience(raw.experience),
    feedback: readFeedback(raw.feedback),
    script: readString(raw.script),
  }
}

/** 编辑器容错读取：坏草稿落回空礼包，并带上错误信息 */
export function readKitSource(source: string): { kit: KitDocument; error: string } {
  try {
    return { kit: parseKit(source || '{}'), error: '' }
  } catch (error) {
    return { kit: createKit(), error: error instanceof Error ? error.message : String(error) }
  }
}
