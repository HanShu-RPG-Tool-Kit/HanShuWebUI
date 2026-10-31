import { parseJsonValue } from '../../utils/strictJson'
import { isObject } from './model'

export type ActorDialogueConditionKind = 'always' | 'talk_read' | 'talk_unread'
export type ActorDialogueCondition =
  | { kind: 'always' }
  | { kind: 'talk_read' | 'talk_unread'; inject: string }
export type ActorDialogueEntry = { when: ActorDialogueCondition[]; inject: string }
export type ActorDialogue = { talkId: string; playerRole: string; entries: ActorDialogueEntry[] }
export type ActorInteractService =
  | { type: 'shop'; param: { template: string } }
  | { type: 'vault'; param: Record<string, never> }
export type ActorSideEffectMode = 'leave' | 'set' | 'clear'
export type ActorDisplaySpec =
  | { mode: 'leave' | 'clear' }
  | { mode: 'set'; title: string; subtitle: string }
export type ActorReputationSpec =
  | { mode: 'leave' | 'clear' }
  | { mode: 'set'; id: string }
export type ActorDocument = {
  format: 'rpgtoolkit:actor-template'
  version: 1
  scripts: string[]
  tags: string[]
  freezeAi: boolean
  display?: ActorDisplaySpec | null
  reputation?: ActorReputationSpec | null
  dialogue?: ActorDialogue | null
  interactService?: ActorInteractService | null
}

const REQUIRED_KEYS = ['format', 'version', 'scripts', 'tags', 'freezeAi'] as const
const OPTIONAL_KEYS = ['dialogue', 'interactService', 'display', 'reputation'] as const
const ALL_KEYS = new Set<string>([...REQUIRED_KEYS, ...OPTIONAL_KEYS])
const SIDE_EFFECT_MODES = new Set<ActorSideEffectMode>(['leave', 'set', 'clear'])

export const createActor = (): ActorDocument => ({
  format: 'rpgtoolkit:actor-template',
  version: 1,
  scripts: [],
  tags: [],
  freezeAi: false,
})

export function stringifyActor(doc: ActorDocument): string {
  const out: Record<string, unknown> = {
    format: 'rpgtoolkit:actor-template',
    version: 1,
    scripts: doc.scripts,
    tags: doc.tags,
    freezeAi: doc.freezeAi,
  }
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
    entries: doc.dialogue.entries.map(entry => ({
      when: entry.when.map(condition => condition.kind === 'always'
        ? { kind: 'always' }
        : { kind: condition.kind, inject: condition.inject }),
      inject: entry.inject,
    })),
  }
  if (doc.interactService != null) {
    out.interactService = doc.interactService.type === 'shop'
      ? { type: 'shop', param: { template: doc.interactService.param.template } }
      : { type: 'vault', param: {} }
  }
  return JSON.stringify(out, null, 2)
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

function parseCondition(value: unknown): ActorDialogueCondition {
  if (!isObject(value) || typeof value.kind !== 'string') throw new Error('dialogue 条件需要 kind')
  const kind = value.kind.trim().toLowerCase()
  if (kind === 'always') {
    requireExactKeys(value, new Set(['kind']), 'always 条件')
    return { kind: 'always' }
  }
  if (kind === 'talk_read' || kind === 'talk_unread') {
    requireExactKeys(value, new Set(['kind', 'inject']), `${kind} 条件`)
    const inject = requireString(value.inject, 'dialogue 条件 inject').trim()
    if (!inject) throw new Error('dialogue 条件 inject 不能为空')
    return { kind, inject }
  }
  throw new Error(`未知 dialogue 条件 kind：${value.kind}`)
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
    if (!Array.isArray(entry.when)) throw new Error('dialogue entry when 必须是数组')
    const inject = requireString(entry.inject, 'dialogue entry inject').trim()
    if (!inject) throw new Error('dialogue entry inject 不能为空')
    return { when: entry.when.map(parseCondition), inject }
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
    requireExactKeys(value.param, new Set(['template']), 'shop interactService.param')
    const template = requireString(value.param.template, 'shop template').trim()
    if (!template) throw new Error('shop interactService 需要 template')
    return { type: 'shop', param: { template } }
  }
  if (type === 'vault') {
    if (Object.keys(value.param).length) throw new Error('vault interactService.param 必须是 {}')
    return { type: 'vault', param: {} }
  }
  throw new Error(`未知 interactService type：${value.type}`)
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
    display: parseOptionalObject(raw, 'display', parseDisplay),
    reputation: parseOptionalObject(raw, 'reputation', parseReputation),
    dialogue: parseOptionalObject(raw, 'dialogue', parseDialogue),
    interactService: parseOptionalObject(raw, 'interactService', parseInteractService),
  }
}
