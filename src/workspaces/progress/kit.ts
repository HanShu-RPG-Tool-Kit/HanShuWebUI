import { isObject } from './model'
import { parseJsonValue } from '../../utils/strictJson'
import { itemFingerprint, readItemStackDisplay, type ItemStackDisplay } from './itemstack'

/** Minecraft 1.20.5+ ItemStack：id / count / components；display 仅编辑器展示，运行时忽略 */
export type KitItem = {
  id: string
  count: number
  components: Record<string, unknown>
  display?: ItemStackDisplay
}

export type KitExperienceKind = 'levels' | 'points'
export type KitExperience = {
  kind: KitExperienceKind
  amount: number
}

export type KitEffect = {
  id: string
  /** 0 起，与 /effect 的 amplifier 一致 */
  amplifier: number
  /** 秒；0 表示无限 */
  duration: number
  particles: boolean
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
}

/** 每次领取从 entries 中按权重抽取 rolls 次 */
export type KitPool = {
  rolls: number
  entries: KitPoolEntry[]
}

export type KitDocument = {
  name: string
  items: KitItem[]
  pools: KitPool[]
  effects: KitEffect[]
  commands: string[]
  experience: KitExperience
  feedback: KitFeedback
  /** 内联脚本原文，不是外调路径 */
  script: string
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
    items: [],
    pools: [],
    effects: [],
    commands: [],
    experience: { kind: 'points', amount: 0 },
    feedback: emptyFeedback(),
    script: '',
  }
}

function writeItem(item: KitItem): Record<string, unknown> {
  const next: Record<string, unknown> = { id: item.id, count: item.count }
  if (Object.keys(item.components).length > 0) next.components = item.components
  if (item.display) next.display = item.display
  return next
}

export function stringifyKit(kit: KitDocument): string {
  const out: Record<string, unknown> = { name: kit.name, items: kit.items.map(writeItem) }
  if (kit.pools.length > 0) {
    out.pools = kit.pools.map((pool) => ({
      rolls: pool.rolls,
      entries: pool.entries.map((entry) => ({ weight: entry.weight, items: entry.items.map(writeItem) })),
    }))
  }
  if (kit.effects.length > 0) out.effects = kit.effects
  out.commands = kit.commands
  out.experience = kit.experience
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

function readItem(value: unknown, path: string): KitItem {
  if (!isObject(value)) throw new Error(`${path} 应为 ItemStack 对象`)
  let components: Record<string, unknown> = {}
  if (value.components !== undefined) {
    if (!isObject(value.components)) throw new Error(`${path}.components 应为对象`)
    components = value.components
  }
  const display = readItemStackDisplay(value.display)
  const item: KitItem = { id: readString(value.id), count: readInt(value.count, 1), components }
  if (display) {
    // 早期存档没有指纹：视为保存时快照有效
    item.display = display.snapshotOf ? display : { ...display, snapshotOf: itemFingerprint(item) }
  }
  return item
}

function readEffect(value: unknown, path: string): KitEffect {
  if (!isObject(value)) throw new Error(`${path} 应为对象`)
  return {
    id: readString(value.id),
    amplifier: readInt(value.amplifier, 0),
    duration: readInt(value.duration, 30),
    particles: value.particles !== false,
  }
}

function readPool(value: unknown, path: string): KitPool {
  if (!isObject(value)) throw new Error(`${path} 应为对象`)
  return {
    rolls: readInt(value.rolls, 1, 1),
    entries: readList(value.entries, `${path}.entries`, (entry, entryPath) => {
      if (!isObject(entry)) throw new Error(`${entryPath} 应为对象`)
      return { weight: readInt(entry.weight, 1), items: readList(entry.items, `${entryPath}.items`, readItem) }
    }),
  }
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
    return { kind: value.kind === 'levels' ? 'levels' : 'points', amount: readInt(value.amount, 0) }
  }
  return { kind: 'points', amount: 0 }
}

export function parseKit(source: string): KitDocument {
  const raw = parseJsonValue(source.replace(/^\uFEFF/, ''))
  if (!isObject(raw)) throw new Error('礼包根节点应为 JSON 对象')
  return {
    name: readString(raw.name),
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
