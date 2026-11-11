import { parseJsonValue } from '../../utils/strictJson'
import {
  conditionRuleIssue,
  emitConditionExpression,
  parseConditionRuleList,
  type ProgressConditionRule,
} from './conditions'
import { normalizeItemRef, writeKitItem, type KitItem } from './kit'
import { isObject } from './model'
import { readComponents, type ItemComponents } from './tnbtJson'

/** 对话条目条件组（AND）；空组恒真。导出 PAK 时编译为表达式字符串。 */
export type ActorDialogueEntry = { when: ProgressConditionRule[]; inject: string }
export type ActorDialogue = { talkId: string; playerRole: string; entries: ActorDialogueEntry[] }
export type { ProgressConditionRule }
export type ActorInteractService =
  | { type: 'shop'; param: { templates: string[] } }
  | { type: 'vault'; param: Record<string, never> }
export type ActorSideEffectMode = 'leave' | 'set' | 'clear'
export type ActorDisplaySpec =
  | { mode: 'leave' | 'clear' }
  | { mode: 'set'; title: string; subtitle: string }
export type ActorReputationSpec =
  | { mode: 'leave' | 'clear' }
  | { mode: 'set'; id: string }
export type ActorLootXpMode = 'leave' | 'dropXp' | 'giveXp' | 'giveLv'
export type ActorLootXp =
  | { mode: 'leave' }
  | { mode: Exclude<ActorLootXpMode, 'leave'>; amount: number }
export type ActorLootItemRow = {
  item?: string
  id: string
  count: number
  components: ItemComponents
  chance: number
  playerKill: boolean
}
export type ActorLootItemSpec = {
  leave: boolean
  items: ActorLootItemRow[]
}
export type ActorLootSpec = {
  xp?: ActorLootXp | null
  item?: ActorLootItemSpec | null
}
/** 音效槽位：leave 跟原版／set 替换／mute 静音。 */
export type ActorSoundMode = 'leave' | 'set' | 'mute'
export type ActorSimpleSoundSpec =
  | { mode: 'leave' | 'mute' }
  | { mode: 'set'; id: string }
export type ActorMoveSoundSpec =
  | { mode: 'leave' | 'mute' }
  | { mode: 'set'; ground: string; water: string; air: string }
export type ActorSoundsSpec = {
  hurt?: ActorSimpleSoundSpec
  death?: ActorSimpleSoundSpec
  ambient?: ActorSimpleSoundSpec
  melee?: ActorSimpleSoundSpec
  move?: ActorMoveSoundSpec
}
export const ACTOR_SOUND_SLOTS: readonly {
  id: keyof ActorSoundsSpec
  label: string
  kind: 'simple' | 'move'
}[] = [
  { id: 'hurt', label: '受伤', kind: 'simple' },
  { id: 'death', label: '死亡', kind: 'simple' },
  { id: 'ambient', label: '环境', kind: 'simple' },
  { id: 'melee', label: '近战', kind: 'simple' },
  { id: 'move', label: '移动', kind: 'move' },
]
/** 模板级消失行为；缺省 inherit 表示不动原版判定。 */
export type ActorDespawnMode = 'inherit' | 'persistent' | 'despawn'
export const ACTOR_DESPAWN_MODES: readonly { id: ActorDespawnMode; label: string; hint: string }[] = [
  { id: 'inherit', label: '遵循原版', hint: '不干预：实体类型与 NBT 决定' },
  { id: 'persistent', label: '持久化', hint: '不因距离或空闲消失' },
  { id: 'despawn', label: '自然消失', hint: '强制按原版规则消失' },
]
export type ActorDocument = {
  format: 'rpgtoolkit:actor-template'
  version: 1
  scripts: string[]
  tags: string[]
  freezeAi: boolean
  despawn: ActorDespawnMode
  display?: ActorDisplaySpec | null
  reputation?: ActorReputationSpec | null
  dialogue?: ActorDialogue | null
  interactService?: ActorInteractService | null
  loot?: ActorLootSpec | null
  sounds?: ActorSoundsSpec | null
}

const REQUIRED_KEYS = ['format', 'version', 'scripts', 'tags', 'freezeAi'] as const
const OPTIONAL_KEYS = ['despawn', 'dialogue', 'interactService', 'display', 'reputation', 'loot', 'sounds'] as const
const ALL_KEYS = new Set<string>([...REQUIRED_KEYS, ...OPTIONAL_KEYS])
const SIDE_EFFECT_MODES = new Set<ActorSideEffectMode>(['leave', 'set', 'clear'])
const SOUND_MODES = new Set<ActorSoundMode>(['leave', 'set', 'mute'])
const SOUND_SLOT_KEYS = new Set<string>(ACTOR_SOUND_SLOTS.map(slot => slot.id))
const LOOT_XP_MODES = new Set<ActorLootXpMode>(['leave', 'dropXp', 'giveXp', 'giveLv'])

export function actorLootRowToKitItem(row: ActorLootItemRow): KitItem {
  return { item: row.item, id: row.id, count: row.count, components: row.components }
}

export function kitItemToActorLootRow(item: KitItem, previous?: ActorLootItemRow): ActorLootItemRow {
  return {
    item: item.item,
    id: item.id,
    count: item.count,
    components: item.components,
    chance: previous?.chance ?? 1,
    playerKill: previous?.playerKill ?? false,
  }
}

export function createActorLootItemRow(): ActorLootItemRow {
  return { id: '', count: 1, components: {}, chance: 1, playerKill: false }
}

export const createActor = (): ActorDocument => ({
  format: 'rpgtoolkit:actor-template',
  version: 1,
  scripts: [],
  tags: [],
  freezeAi: false,
  despawn: 'inherit',
})

function writeDialogueEntry(entry: ActorDialogueEntry, compileWhen: boolean): Record<string, unknown> {
  if (!compileWhen) return { when: entry.when, inject: entry.inject }
  for (const [index, rule] of entry.when.entries()) {
    const issue = conditionRuleIssue(rule, `dialogue entry when ${index + 1}`)
    if (issue) throw new Error(issue)
  }
  return { when: emitConditionExpression(entry.when), inject: entry.inject }
}

/** `plane: 'source'`（默认）落盘条件组；`plane: 'pak'` 把 when 编译成 Mod 表达式字符串。 */
export function stringifyActor(doc: ActorDocument, options?: { plane?: 'source' | 'pak' }): string {
  const compileWhen = options?.plane === 'pak'
  const out: Record<string, unknown> = {
    format: 'rpgtoolkit:actor-template',
    version: 1,
    scripts: doc.scripts,
    tags: doc.tags,
    freezeAi: doc.freezeAi,
  }
  if (doc.despawn !== 'inherit') out.despawn = doc.despawn
  if (doc.display != null) {
    out.display = doc.display.mode === 'set'
      ? { mode: 'set', title: doc.display.title, subtitle: doc.display.subtitle }
      : { mode: doc.display.mode }
  }
  if (doc.reputation != null) {
    out.reputation = doc.reputation.mode === 'set'
      ? { mode: 'set', id: doc.reputation.id }
      : { mode: doc.reputation.mode }
  }
  if (doc.dialogue != null) out.dialogue = {
    talkId: doc.dialogue.talkId,
    playerRole: doc.dialogue.playerRole,
    entries: doc.dialogue.entries.map(entry => writeDialogueEntry(entry, compileWhen)),
  }
  if (doc.interactService != null) {
    out.interactService = doc.interactService.type === 'shop'
      ? { type: 'shop', param: { templates: [...doc.interactService.param.templates] } }
      : { type: 'vault', param: {} }
  }
  if (doc.loot != null) out.loot = writeLoot(doc.loot)
  if (doc.sounds != null) out.sounds = writeSounds(doc.sounds)
  return JSON.stringify(out, null, 2)
}

function writeSimpleSound(spec: ActorSimpleSoundSpec): Record<string, unknown> {
  return spec.mode === 'set' ? { mode: 'set', id: spec.id } : { mode: spec.mode }
}

function writeMoveSound(spec: ActorMoveSoundSpec): Record<string, unknown> {
  return spec.mode === 'set'
    ? { mode: 'set', ground: spec.ground, water: spec.water, air: spec.air }
    : { mode: spec.mode }
}

function writeSounds(sounds: ActorSoundsSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (sounds.hurt) out.hurt = writeSimpleSound(sounds.hurt)
  if (sounds.death) out.death = writeSimpleSound(sounds.death)
  if (sounds.ambient) out.ambient = writeSimpleSound(sounds.ambient)
  if (sounds.melee) out.melee = writeSimpleSound(sounds.melee)
  if (sounds.move) out.move = writeMoveSound(sounds.move)
  return out
}

function writeLoot(loot: ActorLootSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (loot.xp != null) {
    out.xp = loot.xp.mode === 'leave'
      ? { mode: 'leave' }
      : { mode: loot.xp.mode, amount: loot.xp.amount }
  } else if (loot.xp === null) {
    out.xp = null
  }
  if (loot.item != null) {
    out.item = {
      leave: loot.item.leave,
      items: loot.item.items.map(writeLootItem),
    }
  } else if (loot.item === null) {
    out.item = null
  }
  return out
}

function writeLootItem(row: ActorLootItemRow): Record<string, unknown> {
  const next = writeKitItem({ item: row.item, id: row.id, count: row.count, components: row.components })
  if (row.chance !== 1) next.chance = row.chance
  if (row.playerKill) next.playerKill = true
  return next
}

export function parseFlatResourceId(value: string, label: string): string {
  const id = value.trim().normalize('NFC')
  if (!id || id === '.' || id === '..' || /[/\\:]/.test(id) || [...id].some(c => {
    const code = c.charCodeAt(0)
    return code < 32 || (code >= 127 && code <= 159)
  })) throw new Error(`${label}必须是扁平 ID`)
  return id
}

function requireExactKeys(raw: Record<string, unknown>, keys: ReadonlySet<string>, label: string) {
  const actual = new Set(Object.keys(raw))
  if (actual.size !== keys.size || [...keys].some(key => !actual.has(key))) {
    throw new Error(`${label}键必须恰好为 ${[...keys].sort().join('、')}`)
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label}必须是字符串`)
  return value
}

function optionalStringField(raw: Record<string, unknown>, key: string, label: string): string {
  if (!(key in raw) || raw[key] == null) return ''
  return requireString(raw[key], label)
}

function parseSideEffectMode(value: unknown, label: string): ActorSideEffectMode {
  if (typeof value !== 'string') throw new Error(`${label}.mode 必须是 leave|set|clear`)
  const mode = value.trim().toLowerCase() as ActorSideEffectMode
  if (!SIDE_EFFECT_MODES.has(mode)) throw new Error(`${label}.mode 必须是 leave|set|clear`)
  return mode
}

function parseDisplay(value: unknown): ActorDisplaySpec {
  if (!isObject(value)) throw new Error('display 必须是对象或 null')
  for (const key of Object.keys(value)) if (key !== 'mode' && key !== 'title' && key !== 'subtitle') {
    throw new Error(`未知 display 字段：${key}`)
  }
  if (!('mode' in value) || value.mode == null) throw new Error('display.mode 必填')
  const mode = parseSideEffectMode(value.mode, 'display')
  if (mode !== 'set') {
    if ('title' in value || 'subtitle' in value) throw new Error('display title/subtitle 仅允许 mode=set')
    return { mode }
  }
  return {
    mode: 'set',
    title: optionalStringField(value, 'title', 'display.title'),
    subtitle: optionalStringField(value, 'subtitle', 'display.subtitle'),
  }
}

function parseReputation(value: unknown): ActorReputationSpec {
  if (!isObject(value)) throw new Error('reputation 必须是对象或 null')
  for (const key of Object.keys(value)) if (key !== 'mode' && key !== 'id') {
    throw new Error(`未知 reputation 字段：${key}`)
  }
  if (!('mode' in value) || value.mode == null) throw new Error('reputation.mode 必填')
  const mode = parseSideEffectMode(value.mode, 'reputation')
  if (mode !== 'set') {
    if ('id' in value) throw new Error('reputation.id 仅允许 mode=set')
    return { mode }
  }
  if (!('id' in value) || value.id == null) throw new Error('reputation.id 在 mode=set 时必填')
  return { mode: 'set', id: parseFlatResourceId(requireString(value.id, 'reputation.id'), '声誉阵营') }
}

function parseDialogueWhen(value: unknown): ProgressConditionRule[] {
  if (typeof value === 'string') {
    if (/[;\n\r]/.test(value)) throw new Error('dialogue entry when 只能是表达式，不能含语句')
    const source = value.trim()
    return source ? [{ kind: 'expr', source }] : []
  }
  if (!Array.isArray(value)) throw new Error('dialogue entry when 必须是条件组数组')
  const kept: unknown[] = []
  for (const item of value) {
    if (isObject(item) && typeof item.kind === 'string' && item.kind.trim().toLowerCase() === 'always') {
      requireExactKeys(item, new Set(['kind']), 'always 条件')
      continue
    }
    kept.push(item)
  }
  return parseConditionRuleList(kept, 'dialogue entry when')
}

function parseDialogue(value: unknown): ActorDialogue {
  if (!isObject(value)) throw new Error('dialogue 必须是对象或 null')
  requireExactKeys(value, new Set(['talkId', 'playerRole', 'entries']), 'dialogue')
  const talkId = requireString(value.talkId, 'dialogue.talkId').trim()
  const playerRole = requireString(value.playerRole, 'dialogue.playerRole').trim()
  if (!talkId) throw new Error('dialogue.talkId 不能为空')
  if (!playerRole) throw new Error('dialogue.playerRole 不能为空')
  if (talkId === playerRole) throw new Error('dialogue.talkId 与 playerRole 必须不同')
  if (!Array.isArray(value.entries)) throw new Error('dialogue.entries 必须是数组')
  const entries = value.entries.map(entry => {
    if (!isObject(entry)) throw new Error('dialogue entry 必须是对象')
    requireExactKeys(entry, new Set(['when', 'inject']), 'dialogue entry')
    const inject = requireString(entry.inject, 'dialogue entry inject').trim()
    if (!inject) throw new Error('dialogue entry inject 不能为空')
    return { when: parseDialogueWhen(entry.when), inject }
  })
  return { talkId, playerRole, entries }
}

function parseInteractService(value: unknown): ActorInteractService {
  if (!isObject(value)) throw new Error('interactService 必须是对象或 null')
  requireExactKeys(value, new Set(['type', 'param']), 'interactService')
  if (typeof value.type !== 'string') throw new Error('interactService.type 必须是字符串')
  const type = value.type.trim().toLowerCase()
  if (!isObject(value.param)) throw new Error('interactService.param 必须是对象')
  if (type === 'shop') {
    const keys = Object.keys(value.param)
    if (keys.length === 1 && keys[0] === 'templates') {
      if (!Array.isArray(value.param.templates)) throw new Error('shop templates 必须是数组')
      const templates: string[] = []
      const seen = new Set<string>()
      for (const entry of value.param.templates) {
        const template = requireString(entry, 'shop template').trim()
        if (!template) throw new Error('shop template 不能为空')
        if (seen.has(template)) throw new Error(`重复的商店模板：${template}`)
        seen.add(template)
        templates.push(template)
      }
      if (!templates.length) throw new Error('shop interactService 需要至少一个 template')
      if (templates.length > 64) throw new Error('shop interactService 最多 64 个 template')
      return { type: 'shop', param: { templates } }
    }
    // Legacy single-template form.
    if (keys.length === 1 && keys[0] === 'template') {
      const template = requireString(value.param.template, 'shop template').trim()
      if (!template) throw new Error('shop interactService 需要 template')
      return { type: 'shop', param: { templates: [template] } }
    }
    throw new Error('shop interactService.param 必须是 { templates: [...] }（或旧版 { template: "…" }）')
  }
  if (type === 'vault') {
    if (Object.keys(value.param).length) throw new Error('vault interactService.param 必须是 {}')
    return { type: 'vault', param: {} }
  }
  throw new Error(`未知 interactService type：${value.type}`)
}

function requireNonNegNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${label} 必须是 >= 0 的有限数字`)
  return value
}

function parseLootXp(value: unknown): ActorLootXp {
  if (!isObject(value)) throw new Error('loot.xp 必须是对象或 null')
  for (const key of Object.keys(value)) if (key !== 'mode' && key !== 'amount') {
    throw new Error(`未知 loot.xp 字段：${key}`)
  }
  if (!('mode' in value) || value.mode == null) throw new Error('loot.xp.mode 必填')
  if (typeof value.mode !== 'string') throw new Error('loot.xp.mode 必须是 leave|dropXp|giveXp|giveLv')
  const mode = value.mode.trim() as ActorLootXpMode
  if (!LOOT_XP_MODES.has(mode)) throw new Error('loot.xp.mode 必须是 leave|dropXp|giveXp|giveLv')
  if (mode === 'leave') {
    if ('amount' in value) throw new Error('loot.xp.amount 在 mode=leave 时禁止')
    return { mode: 'leave' }
  }
  if (!('amount' in value) || value.amount == null) throw new Error('loot.xp.amount 在非 leave 时必填')
  return { mode, amount: requireNonNegNumber(value.amount, 'loot.xp.amount') }
}

function parseLootItemRow(value: unknown, path: string): ActorLootItemRow {
  if (!isObject(value)) throw new Error(`${path} 必须是对象`)
  for (const key of Object.keys(value)) {
    if (!['item', 'id', 'count', 'components', 'chance', 'playerKill'].includes(key)) {
      throw new Error(`${path} 未知字段：${key}`)
    }
  }
  const count = value.count == null ? 1 : requireNonNegNumber(value.count, `${path}.count`)
  if (!Number.isInteger(count)) throw new Error(`${path}.count 必须是整数`)
  const chance = value.chance == null ? 1 : (() => {
    if (typeof value.chance !== 'number' || !Number.isFinite(value.chance) || value.chance < 0 || value.chance > 1) {
      throw new Error(`${path}.chance 必须在 [0,1]`)
    }
    return value.chance
  })()
  const playerKill = value.playerKill == null ? false : (() => {
    if (typeof value.playerKill !== 'boolean') throw new Error(`${path}.playerKill 必须是布尔值`)
    return value.playerKill
  })()
  const link = typeof value.item === 'string' ? normalizeItemRef(value.item) : ''
  if (link) {
    if ('id' in value || 'components' in value) throw new Error(`${path} 使用 item 链接时不能带 id/components`)
    return { item: link, id: '', count, components: {}, chance, playerKill }
  }
  if (!('id' in value) || typeof value.id !== 'string') throw new Error(`${path} 需要 item 链接或 id`)
  let components: ItemComponents = {}
  if (value.components !== undefined) {
    if (!isObject(value.components)) throw new Error(`${path}.components 必须是对象`)
    components = readComponents(value.components, `${path}.components`)
  }
  return { id: value.id, count, components, chance, playerKill }
}

function parseLootItem(value: unknown): ActorLootItemSpec {
  if (!isObject(value)) throw new Error('loot.item 必须是对象或 null')
  for (const key of Object.keys(value)) if (key !== 'leave' && key !== 'items') {
    throw new Error(`未知 loot.item 字段：${key}`)
  }
  const leave = value.leave == null ? true : (() => {
    if (typeof value.leave !== 'boolean') throw new Error('loot.item.leave 必须是布尔值')
    return value.leave
  })()
  const items = value.items == null ? [] : (() => {
    if (!Array.isArray(value.items)) throw new Error('loot.item.items 必须是数组')
    return value.items.map((entry, index) => parseLootItemRow(entry, `loot.item.items[${index}]`))
  })()
  return { leave, items }
}

function parseLoot(value: unknown): ActorLootSpec {
  if (!isObject(value)) throw new Error('loot 必须是对象或 null')
  for (const key of Object.keys(value)) if (key !== 'xp' && key !== 'item') {
    throw new Error(`未知 loot 字段：${key}`)
  }
  const loot: ActorLootSpec = {}
  if ('xp' in value) loot.xp = value.xp == null ? null : parseLootXp(value.xp)
  if ('item' in value) loot.item = value.item == null ? null : parseLootItem(value.item)
  return loot
}

function parseSoundMode(value: unknown, label: string): ActorSoundMode {
  if (typeof value !== 'string') throw new Error(`${label}.mode 必须是 leave|set|mute`)
  const mode = value.trim().toLowerCase() as ActorSoundMode
  if (!SOUND_MODES.has(mode)) throw new Error(`${label}.mode 必须是 leave|set|mute`)
  return mode
}

function parseSoundEventId(value: unknown, label: string): string {
  const id = requireString(value, label).trim()
  if (!id) throw new Error(`${label} 不能为空`)
  return id
}

function parseSimpleSound(value: unknown, label: string): ActorSimpleSoundSpec {
  if (!isObject(value)) throw new Error(`${label} 必须是对象`)
  for (const key of Object.keys(value)) if (key !== 'mode' && key !== 'id') {
    throw new Error(`${label} 未知字段：${key}`)
  }
  if (!('mode' in value) || value.mode == null) throw new Error(`${label}.mode 必填`)
  const mode = parseSoundMode(value.mode, label)
  if (mode !== 'set') {
    if ('id' in value) throw new Error(`${label}.id 仅允许 mode=set`)
    return { mode }
  }
  if (!('id' in value) || value.id == null) throw new Error(`${label}.id 在 mode=set 时必填`)
  return { mode: 'set', id: parseSoundEventId(value.id, `${label}.id`) }
}

function parseMoveSound(value: unknown): ActorMoveSoundSpec {
  if (!isObject(value)) throw new Error('sounds.move 必须是对象')
  for (const key of Object.keys(value)) if (!['mode', 'ground', 'water', 'air'].includes(key)) {
    throw new Error(`sounds.move 未知字段：${key}`)
  }
  if (!('mode' in value) || value.mode == null) throw new Error('sounds.move.mode 必填')
  const mode = parseSoundMode(value.mode, 'sounds.move')
  if (mode !== 'set') {
    if ('ground' in value || 'water' in value || 'air' in value) {
      throw new Error('sounds.move ground/water/air 仅允许 mode=set')
    }
    return { mode }
  }
  requireExactKeys(value, new Set(['mode', 'ground', 'water', 'air']), 'sounds.move')
  return {
    mode: 'set',
    ground: parseSoundEventId(value.ground, 'sounds.move.ground'),
    water: parseSoundEventId(value.water, 'sounds.move.water'),
    air: parseSoundEventId(value.air, 'sounds.move.air'),
  }
}

function parseSounds(value: unknown): ActorSoundsSpec {
  if (!isObject(value)) throw new Error('sounds 必须是对象或 null')
  for (const key of Object.keys(value)) if (!SOUND_SLOT_KEYS.has(key)) {
    throw new Error(`未知 sounds 字段：${key}`)
  }
  const sounds: ActorSoundsSpec = {}
  if ('hurt' in value) sounds.hurt = parseSimpleSound(value.hurt, 'sounds.hurt')
  if ('death' in value) sounds.death = parseSimpleSound(value.death, 'sounds.death')
  if ('ambient' in value) sounds.ambient = parseSimpleSound(value.ambient, 'sounds.ambient')
  if ('melee' in value) sounds.melee = parseSimpleSound(value.melee, 'sounds.melee')
  if ('move' in value) sounds.move = parseMoveSound(value.move)
  return sounds
}

function parseDespawn(value: unknown): ActorDespawnMode {
  if (value === undefined || value === null) return 'inherit'
  if (typeof value !== 'string' || !ACTOR_DESPAWN_MODES.some(mode => mode.id === value)) {
    throw new Error('despawn 必须是 inherit/persistent/despawn')
  }
  return value as ActorDespawnMode
}

function parseOptionalObject<T>(raw: Record<string, unknown>, key: string, parse: (value: unknown) => T): T | null | undefined {
  if (!(key in raw)) return undefined
  if (raw[key] == null) return null
  return parse(raw[key])
}

export function parseActor(source: string): ActorDocument {
  const raw = parseJsonValue(source)
  if (!isObject(raw) || raw.format !== 'rpgtoolkit:actor-template' || raw.version !== 1) {
    throw new Error('需要 rpgtoolkit:actor-template version 1 演员模板')
  }
  for (const key of REQUIRED_KEYS) if (!(key in raw)) throw new Error(`演员模板缺少字段：${key}`)
  for (const key of Object.keys(raw)) if (!ALL_KEYS.has(key)) throw new Error(`未知演员模板字段：${key}`)
  if (typeof raw.freezeAi !== 'boolean') throw new Error('freezeAi 必须是布尔值')
  if (!Array.isArray(raw.scripts) || raw.scripts.some(id => typeof id !== 'string')) throw new Error('演员脚本引用必须是字符串列表')
  const scripts = (raw.scripts as string[]).map(id => parseFlatResourceId(id, '演员脚本引用'))
  if (new Set(scripts).size !== scripts.length) throw new Error('演员脚本不能重复绑定')
  if (!Array.isArray(raw.tags) || raw.tags.some(tag => typeof tag !== 'string' || !tag.trim())) throw new Error('标签必须是非空字符串列表')
  const tags = [...new Set((raw.tags as string[]).map(tag => tag.trim()))]
  return {
    format: 'rpgtoolkit:actor-template',
    version: 1,
    scripts,
    tags,
    freezeAi: raw.freezeAi,
    despawn: parseDespawn(raw.despawn),
    display: parseOptionalObject(raw, 'display', parseDisplay),
    reputation: parseOptionalObject(raw, 'reputation', parseReputation),
    dialogue: parseOptionalObject(raw, 'dialogue', parseDialogue),
    interactService: parseOptionalObject(raw, 'interactService', parseInteractService),
    loot: parseOptionalObject(raw, 'loot', parseLoot),
    sounds: parseOptionalObject(raw, 'sounds', parseSounds),
  }
}
