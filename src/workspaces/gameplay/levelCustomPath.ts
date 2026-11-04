import type { LevelCustomData } from './levelDoc'
import { classifyDraftNumber } from './levelLayoutModel'

/** Segment is an object key or an array index. Order is the edit path from the custom root. */
export type CustomPath = readonly (string | number)[]

export type CustomValueKind = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array'

export type CustomLeafDraft = {
  path: CustomPath
  kind: 'string' | 'number'
  raw: string
}

export type CustomAddDraft = {
  container: CustomPath
  mode: 'key' | 'item'
  name: string
  kind: CustomValueKind
  raw: string
}

const DATA_PROPERTY = { enumerable: true, writable: true, configurable: true } as const

export function customPathKey(path: CustomPath): string {
  return JSON.stringify(path)
}

export function customPathLabel(path: CustomPath): string {
  let text = ''
  for (const segment of path) {
    if (typeof segment === 'number') text += `[${segment}]`
    else text += text ? `.${segment}` : segment
  }
  return text
}

export function customKindLabel(kind: CustomValueKind): string {
  if (kind === 'string') return '文本'
  if (kind === 'number') return '数字'
  if (kind === 'boolean') return '布尔'
  if (kind === 'null') return '空值'
  if (kind === 'object') return '对象'
  return '列表'
}

export function customValueKind(value: unknown): CustomValueKind | null {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'object') return 'object'
  return null
}

export function summarizeCustomValue(value: unknown): string {
  const kind = customValueKind(value)
  if (kind === 'null') return '空值'
  if (kind === 'string') {
    const text = value as string
    return text.length > 18 ? `${text.slice(0, 18)}…` : text
  }
  if (kind === 'number' || kind === 'boolean') return kind === 'boolean' ? (value ? '开' : '关') : String(value)
  if (kind === 'array') {
    const items = value as unknown[]
    const preview = items.slice(0, 3).map((item) => summarizeCustomValue(item)).filter(Boolean).join(', ')
    return `${items.length} 项${preview ? ` · ${preview}` : ''}`
  }
  if (kind === 'object') {
    const keys = Object.keys(value as object)
    const preview = keys.slice(0, 3).join(', ')
    return `${keys.length} 个键${preview ? ` · ${preview}` : ''}`
  }
  return ''
}

export function isCustomRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Enumerable own keys, including a literal __proto__ key. Values come from the descriptor, not assignment. */
export function ownCustomEntries(value: object): [string, unknown][] {
  return Object.keys(value).map((key) => [key, Object.getOwnPropertyDescriptor(value, key)?.value])
}

function defineData(target: object, key: string, value: unknown) {
  Object.defineProperty(target, key, { ...DATA_PROPERTY, value })
}

function cloneRecord(source: object): Record<string, unknown> {
  const next = Object.create(null) as Record<string, unknown>
  for (const [key, item] of ownCustomEntries(source)) defineData(next, key, item)
  return next
}

export function getAt(root: unknown, path: CustomPath): unknown {
  let current = root
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current) || !Number.isInteger(segment) || segment < 0 || segment >= current.length) return undefined
      current = current[segment]
      continue
    }
    if (!isCustomRecord(current)) return undefined
    const descriptor = Object.getOwnPropertyDescriptor(current, segment)
    if (!descriptor || descriptor.enumerable === false) return undefined
    current = descriptor.value
  }
  return current
}

function writeKey(parent: unknown, key: string, value: unknown): Record<string, unknown> {
  const next = isCustomRecord(parent) ? cloneRecord(parent) : Object.create(null) as Record<string, unknown>
  if (value === undefined) delete next[key]
  else defineData(next, key, value)
  return next
}

function writeIndex(parent: unknown, index: number, value: unknown): unknown[] {
  const next = Array.isArray(parent) ? parent.slice() : []
  if (value === undefined) {
    if (index >= 0 && index < next.length) next.splice(index, 1)
    return next
  }
  next[index] = value
  return next
}

function assign(node: unknown, path: CustomPath, depth: number, value: unknown): unknown {
  const segment = path[depth]!
  if (depth === path.length - 1) {
    return typeof segment === 'number' ? writeIndex(node, segment, value) : writeKey(node, segment, value)
  }
  const child = typeof segment === 'number'
    ? (Array.isArray(node) && segment >= 0 && segment < node.length ? node[segment] : undefined)
    : (isCustomRecord(node) ? Object.getOwnPropertyDescriptor(node, segment)?.value : undefined)
  const nextChild = assign(child, path, depth + 1, value)
  return typeof segment === 'number' ? writeIndex(node, segment, nextChild) : writeKey(node, segment, nextChild)
}

/** Immutable write. `undefined` removes an object key or splices an array index. Null is stored. */
export function setAt(root: LevelCustomData, path: CustomPath, value: unknown): LevelCustomData {
  if (path.length === 0) return root
  const edited = assign(root, path, 0, value)
  return isCustomRecord(edited) ? edited as LevelCustomData : root
}

export function deleteAt(root: LevelCustomData, path: CustomPath): LevelCustomData {
  return setAt(root, path, undefined)
}

export function insertAt(root: LevelCustomData, container: CustomPath, index: number, value: unknown): LevelCustomData {
  const current = getAt(root, container)
  if (!Array.isArray(current)) return root
  const next = current.slice()
  const at = Math.max(0, Math.min(Number.isInteger(index) ? index : next.length, next.length))
  next.splice(at, 0, value)
  return setAt(root, container, next)
}

function place(custom: LevelCustomData, add: CustomAddDraft, value: unknown): LevelCustomData {
  if (add.mode === 'item') {
    const items = getAt(custom, add.container)
    return insertAt(custom, add.container, Array.isArray(items) ? items.length : 0, value)
  }
  return setAt(custom, [...add.container, add.name.trim()], value)
}

function placeAdd(
  custom: LevelCustomData,
  reserved: readonly string[],
  add: CustomAddDraft,
): { touched: boolean; message: string | null; custom?: LevelCustomData } {
  const name = add.name.trim()
  const structured = add.kind === 'boolean' || add.kind === 'null' || add.kind === 'object' || add.kind === 'array'
  if (add.mode === 'key') {
    if (name === '' && add.raw === '' && !structured) return { touched: false, message: null }
    if (name === '') return { touched: true, message: '键名不能为空' }
    if (add.container.length === 0 && reserved.includes(name)) return { touched: true, message: '这个键已经在上面的表单里' }
  }
  if (add.kind === 'string') {
    if (add.raw === '') return { touched: true, message: add.mode === 'key' ? '新键尚未添加' : '新项尚未添加' }
    return { touched: true, message: null, custom: place(custom, add, add.raw) }
  }
  if (add.kind === 'number') {
    if (add.raw.trim() === '') return { touched: true, message: add.mode === 'key' ? '新键尚未添加' : '新项尚未添加' }
    const parsed = classifyDraftNumber(add.raw)
    if (parsed.kind === 'partial') return { touched: true, message: '数字未完成' }
    if (parsed.kind === 'invalid') return { touched: true, message: parsed.message }
    return { touched: true, message: null, custom: place(custom, add, parsed.value) }
  }
  if (add.kind === 'boolean') return { touched: true, message: null, custom: place(custom, add, add.raw === 'true') }
  if (add.kind === 'null') return { touched: true, message: null, custom: place(custom, add, null) }
  if (add.kind === 'object') return { touched: true, message: null, custom: place(custom, add, Object.create(null)) }
  return { touched: true, message: null, custom: place(custom, add, []) }
}

/**
 * Overlay in-progress text and uncommitted add rows onto one copy.
 * A blocking message leaves the invalid text out of the copy. Complete rows fold in.
 */
export function foldCustomDrafts(
  custom: LevelCustomData,
  reserved: readonly string[],
  leaves: readonly CustomLeafDraft[],
  adds: readonly CustomAddDraft[],
): { pending: boolean; message: string | null; custom: LevelCustomData } {
  let next = custom
  let pending = false
  let message: string | null = null
  for (const leaf of leaves) {
    const current = getAt(custom, leaf.path)
    const fallback = typeof current === 'number' && Number.isFinite(current) ? String(current) : typeof current === 'string' ? current : ''
    if (leaf.raw === fallback) continue
    pending = true
    if (leaf.kind === 'string') {
      next = setAt(next, leaf.path, leaf.raw)
      continue
    }
    const parsed = classifyDraftNumber(leaf.raw)
    if (parsed.kind === 'partial') { if (!message) message = '数字未完成' }
    else if (parsed.kind === 'invalid') { if (!message) message = parsed.message }
    else next = setAt(next, leaf.path, parsed.value)
  }
  for (const add of adds) {
    const placed = placeAdd(next, reserved, add)
    if (!placed.touched) continue
    pending = true
    if (placed.message) { if (!message) message = placed.message }
    else if (placed.custom) next = placed.custom
  }
  return { pending, message, custom: next }
}
