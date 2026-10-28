import { readComponents, type ItemComponents } from './tnbtJson'
import { isObject } from './model'
import { parseJsonValue } from '../../utils/strictJson'
import type { ItemDocument } from './itemDoc'
import { ingestDisplay } from './itemSnapshotCache'
import { readItemStackDisplay, type ItemStackDisplay } from './itemstack'
import { buildKitModifierEnv, interpolateKitText, resolveKitNumber, type KitModifierEnv, type KitNumberRule } from './kitExpr'

/** 数值字段 → 绑定的修饰器 id；最终值 = 字段规则(修饰器(raw)) */
export type KitMods<K extends string> = Partial<Record<K, string>>

/**
 * 礼包物品：内嵌 ItemStack，或链接物品库 `.item`（`item` = 文件名无后缀）。
 * 有 `item` 时 id/components/display 由物品目录展开；文件里只持久化 item + count + mods。
 */
export type KitItem = {
  /** 物品库链接（规范化后的 `.item` 文件名，无后缀） */
  item?: string
  id: string
  count: number
  components: ItemComponents
  display?: ItemStackDisplay
  mods?: KitMods<'count'>
}

/** 物品库目录：key 为规范化引用（无 `.item` 后缀） */
export type ItemCatalog = ReadonlyMap<string, ItemDocument>

export const ITEM_LINK_MIME = 'application/x-hanshu-item-link'
/** 资源树拖出 `.kit` 链接（进度奖励等落点） */
export const KIT_LINK_MIME = 'application/x-hanshu-kit-link'

/** `sword.item` / `sword` → `sword` */
export function normalizeItemRef(value: string): string {
  return value.trim().replace(/\.itemstack$/i, '').replace(/\.item$/i, '')
}

export function itemRefFromFileName(fileName: string): string {
  return normalizeItemRef(fileName)
}

export function isKitItemLink(item: KitItem): boolean {
  return Boolean(item.item && normalizeItemRef(item.item))
}

/** 把链接条目展开为可展示 / 可模拟的完整堆；找不到引用时保留空壳并带上 ref 作 id 兜底 */
export function expandKitItem(item: KitItem, catalog?: ItemCatalog): KitItem {
  const ref = item.item ? normalizeItemRef(item.item) : ''
  if (!ref) return item
  const doc = catalog?.get(ref)
  if (!doc) {
    return {
      ...item,
      item: ref,
      id: item.id || ref,
      components: item.components,
    }
  }
  return {
    ...item,
    item: ref,
    id: doc.item.id,
    components: { ...doc.item.components },
  }
}

export function createKitItemLink(ref: string, count = 1): KitItem {
  return { item: normalizeItemRef(ref), id: '', count: Math.max(0, Math.floor(count)), components: {} }
}

export function encodeItemLinkPayload(ref: string): string {
  return JSON.stringify({ ref: normalizeItemRef(ref) })
}

export function decodeItemLinkPayload(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as unknown
    if (isObject(parsed) && typeof parsed.ref === 'string') {
      const ref = normalizeItemRef(parsed.ref)
      return ref || null
    }
  } catch { /* 纯文本引用 */ }
  const ref = normalizeItemRef(text)
  return ref || null
}

export function encodeKitLinkPayload(ref: string): string {
  return JSON.stringify({ ref: normalizeKitRef(ref) })
}

export function decodeKitLinkPayload(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as unknown
    if (isObject(parsed) && typeof parsed.ref === 'string') {
      const ref = normalizeKitRef(parsed.ref)
      return ref || null
    }
  } catch { /* 纯文本引用 */ }
  const ref = normalizeKitRef(text)
  return ref || null
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
  /** 当前礼包的游戏标签。 */
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
  /** New resources use a typed reference. Strings retain legacy source only for explicit extraction. */
  script: string | {ref:string} | {ref:string}[]
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
 * `itemCatalog` 用于展开 `.item` 链接。
 */
export function resolveKit(
  kit: KitDocument,
  overrides?: Record<string, unknown>,
  itemCatalog?: ItemCatalog,
): KitResolved {
  const env = kitModifierEnv(kit, overrides)
  const issues: KitResolveIssue[] = []
  const field = (path: string, raw: number, mod: string | undefined, rule: KitNumberRule) => {
    const result = resolveKitNumber(raw, mod, env, rule)
    if (result.error) issues.push({ path, level: 'error', message: result.error })
    else if (result.warning) issues.push({ path, level: 'warning', message: result.warning })
    return result.value
  }
  const item = (path: string, value: KitItem): KitItem => {
    const ref = value.item ? normalizeItemRef(value.item) : ''
    if (ref && !itemCatalog?.has(ref)) {
      issues.push({ path, level: 'error', message: `找不到物品库引用「${ref}」` })
    }
    const expanded = expandKitItem(value, itemCatalog)
    return {
      ...expanded,
      count: field(`${path}.count`, expanded.count, expanded.mods?.count, KIT_NUMBER_RULES.count),
    }
  }

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

export function createKit(_name = '新礼包'): KitDocument {
  void _name
  return {
    /** 语义键；译文在 lang_kit */
    name: 'name',
    tags: [],
    params: defaultKitParams(),
    modifiers: [],
    items: [],
    pools: [],
    effects: [],
    commands: [],
    experience: { kind: 'points', amount: 0 },
    feedback: emptyFeedback(),
    script: [],
  }
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

export function writeKitItem(item: KitItem): Record<string, unknown> {
  const mods = cleanMods(item.mods)
  const ref = item.item ? normalizeItemRef(item.item) : ''
  if (ref) {
    const next: Record<string, unknown> = { item: ref, count: item.count }
    if (mods) next.mods = mods
    return next
  }
  const next: Record<string, unknown> = { id: item.id, count: item.count }
  if (mods) next.mods = mods
  if (Object.keys(item.components).length > 0) next.components = readComponents(item.components)
  // display 迁出本机缓存，kit 文件不再写入
  return next
}

export function stringifyKit(kit: KitDocument): string {
  const out: Record<string, unknown> = { name: kit.name }
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
  out.items = kit.items.map(writeKitItem)
  if (kit.pools.length > 0) {
    out.pools = kit.pools.map((pool) => {
      const mods = cleanMods(pool.mods)
      return {
        rolls: pool.rolls,
        ...(mods ? { mods } : {}),
        entries: pool.entries.map((entry) => {
          const entryMods = cleanMods(entry.mods)
          return { weight: entry.weight, ...(entryMods ? { mods: entryMods } : {}), items: entry.items.map(writeKitItem) }
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

export function kitScriptRefs(value:KitDocument['script']):string[]{return typeof value==='string'?[]:(Array.isArray(value)?value:[value]).map(s=>s.ref).filter(Boolean)}
export function hasKitScript(value:KitDocument['script']):boolean{return typeof value==='string'?!!value.trim():kitScriptRefs(value).length>0}
export function kitScriptRef(value:KitDocument['script']):string{return kitScriptRefs(value)[0]??''}
function readKitScript(raw:unknown):KitDocument['script']{
 if(raw==null)return []
 if(typeof raw==='string')return raw
 const values=Array.isArray(raw)?raw:[raw]
 const refs=values.map(value=>{
  if(!isObject(value)||typeof value.ref!=='string')throw Error('script 应为脚本引用数组 [{ref:名称}]')
  const ref=value.ref.trim()
  if(ref==='.'||ref==='..'||/[\\/:*?"<>|\x00-\x1f]/.test(ref))throw Error('礼包脚本引用应为扁平文件名')
  return ref
 }).filter(Boolean)
 if(new Set(refs).size!==refs.length)throw Error('礼包脚本不能重复绑定')
 return refs.map(ref=>({ref}))
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
  if (!isObject(value)) throw new Error(`${path} 应为 ItemStack 或物品链接对象`)
  const count = readInt(value.count, 1)
  const mods = readMods(value.mods, `${path}.mods`, ['count'])
  const link = typeof value.item === 'string' ? normalizeItemRef(value.item) : ''
  if (link) {
    const item: KitItem = { item: link, id: '', count, components: {} }
    if (mods) item.mods = mods
    return item
  }
  let components: ItemComponents = {}
  if (value.components !== undefined) {
    if (!isObject(value.components)) throw new Error(`${path}.components 应为对象`)
    components = readComponents(value.components, `${path}.components`)
  }
  const display = readItemStackDisplay(value.display)
  const item: KitItem = { id: readString(value.id), count, components }
  if (mods) item.mods = mods
  if (display) ingestDisplay(item, display)
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
  const raw = parseJsonValue(source.replace(/^\uFEFF/, ''), 96)
  if (!isObject(raw)) throw new Error('礼包根节点应为 JSON 对象')
  if ('extends' in raw || 'includes' in raw) throw new Error('礼包已移除 extends/includes，请改为独立定义')
  return {
    name: readString(raw.name),
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
    script: readKitScript(raw.script),
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
