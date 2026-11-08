import {
  deleteArea,
  levelIssues,
  renameLandmark,
  renameRegion,
  replaceArea,
  setLandmarkParam,
} from './levelEdit'
import type { LevelArea, LevelCustomData, LevelDocument, LevelY } from './levelDoc'
import type { LevelSelection } from './levelVolumeEdit'
import {
  NAV_COORD_ABS_MAX,
  NAV_DISPLAY_ICON,
  NAV_DISPLAY_MAX_DISTANCE,
  NAV_DISPLAY_MIN_DISTANCE,
  NAV_DISPLAY_NAME,
  NAV_LABEL_MAX,
} from './navigationPoint'

/** Landmark display keys edited by dedicated fields. They stay out of the raw scalar list. */
export const LANDMARK_FORM_KEYS = [
  NAV_DISPLAY_NAME,
  NAV_DISPLAY_ICON,
  NAV_DISPLAY_MIN_DISTANCE,
  NAV_DISPLAY_MAX_DISTANCE,
] as const

const IDENTIFIER_RE = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/i
const COMPLETE_NUMBER = /^-?(?:\d+(?:\.\d+)?|\.\d+)$/
const PARTIAL_NUMBER = /^(?:|-?|-?\d+\.|-?\.\d*|\.\d*)$/

export type LevelViewKind = 'focus' | 'perspective' | 'top' | 'front' | 'side'

export type LevelViewCommand = {
  sequence: number
  kind: LevelViewKind
}

export type LevelSaveGuard = () => { ok: boolean; message?: string }

export type LevelDraftRecord = {
  order: number
  pending: boolean
  message: string | null
  reduce: ((doc: LevelDocument, shown: LevelDocument) => LevelDocument | { blocked: string }) | null
}

export type NumberDraft =
  | { kind: 'value'; value: number }
  | { kind: 'partial' }
  | { kind: 'invalid'; message: string }

export type CustomScalar = {
  key: string
  kind: 'string' | 'number' | 'boolean'
  value: string | number | boolean
}

export type RenamePlan =
  | { ok: true; unchanged: true }
  | { ok: true; unchanged: false; id: string; doc: LevelDocument }
  | { ok: false; message: string }

export type DeletePlan =
  | { mode: 'single'; label: string; count: 1 }
  | { mode: 'split'; volumeLabel: string; regionLabel: string; count: number }

export function areaShapeLabel(kind: LevelArea['kind']): string {
  if (kind === 'rect') return '矩形'
  if (kind === 'circle') return '圆'
  return '多边形'
}

export function classifyDraftNumber(raw: string): NumberDraft {
  const text = raw.trim()
  if (COMPLETE_NUMBER.test(text)) {
    const value = Number(text)
    if (!Number.isFinite(value)) return { kind: 'invalid', message: '不是有限数字' }
    return { kind: 'value', value }
  }
  if (PARTIAL_NUMBER.test(text)) return { kind: 'partial' }
  return { kind: 'invalid', message: '需要数字' }
}

export function canonicalCustomText(custom: LevelCustomData): string {
  return JSON.stringify(custom, null, 2)
}

export function readCustomObject(text: string): { ok: true; value: LevelCustomData } | { ok: false; message: string } {
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, message: 'custom_data 须为 JSON 对象' }
    }
    return { ok: true, value: parsed as LevelCustomData }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'JSON 无法解析' }
  }
}

export function customTextStatus(text: string, custom: LevelCustomData):
  | { state: 'clean' }
  | { state: 'invalid'; message: string }
  | { state: 'unapplied' } {
  if (text === canonicalCustomText(custom)) return { state: 'clean' }
  const parsed = readCustomObject(text)
  if (!parsed.ok) return { state: 'invalid', message: parsed.message }
  return { state: 'unapplied' }
}

export function isAdvancedCustomValue(value: unknown): boolean {
  return value === null || typeof value === 'object'
}

function ownEntries(custom: LevelCustomData): [string, unknown][] {
  return Object.keys(custom).map((key) => [key, Object.getOwnPropertyDescriptor(custom, key)?.value])
}

export function customScalars(custom: LevelCustomData, reserved: readonly string[] = []): CustomScalar[] {
  const skip = new Set(reserved)
  const rows: CustomScalar[] = []
  for (const [key, value] of ownEntries(custom)) {
    if (skip.has(key) || isAdvancedCustomValue(value)) continue
    if (typeof value === 'string') rows.push({ key, kind: 'string', value })
    else if (typeof value === 'number' && Number.isFinite(value)) rows.push({ key, kind: 'number', value })
    else if (typeof value === 'boolean') rows.push({ key, kind: 'boolean', value })
  }
  return rows
}

export function customNestedKeys(custom: LevelCustomData, reserved: readonly string[] = []): string[] {
  const skip = new Set(reserved)
  return ownEntries(custom)
    .filter(([key, value]) => !skip.has(key) && isAdvancedCustomValue(value))
    .map(([key]) => key)
}

/** Copy through own data properties so a key named __proto__ never hits the prototype setter. */
function cloneCustom(custom: LevelCustomData): LevelCustomData {
  const next = Object.create(null) as LevelCustomData
  for (const [key, value] of ownEntries(custom)) {
    Object.defineProperty(next, key, { value, enumerable: true, writable: true, configurable: true })
  }
  return next
}

export function writeCustomKey(custom: LevelCustomData, key: string, value: unknown): LevelCustomData {
  const next = cloneCustom(custom)
  if (value === undefined) delete next[key]
  else Object.defineProperty(next, key, { value, enumerable: true, writable: true, configurable: true })
  return next
}

export type PendingAddKey = {
  name: string
  kind: 'string' | 'number' | 'boolean'
  raw: string
}

/** A filled add-key row is pending until it is written or cleared. Incomplete rows block; complete rows fold into the same draft. */
export function applyPendingAddKey(
  custom: LevelCustomData,
  reserved: readonly string[],
  form: PendingAddKey,
): { pending: boolean; message: string | null; custom: LevelCustomData } {
  const name = form.name.trim()
  const valueTouched = form.raw !== ''
  if (name === '' && !valueTouched) return { pending: false, message: null, custom }
  if (name === '') return { pending: true, message: '键名不能为空', custom }
  if (reserved.includes(name)) return { pending: true, message: '这个键已经在上面的表单里', custom }
  if (form.kind === 'boolean') {
    return { pending: true, message: null, custom: writeCustomKey(custom, name, (form.raw || 'false') === 'true') }
  }
  if (form.kind === 'string') {
    if (form.raw === '') return { pending: true, message: '新键尚未添加', custom }
    return { pending: true, message: null, custom: writeCustomKey(custom, name, form.raw) }
  }
  if (form.raw.trim() === '') return { pending: true, message: '新键尚未添加', custom }
  const parsed = classifyDraftNumber(form.raw)
  if (parsed.kind === 'partial') return { pending: true, message: '数字未完成', custom }
  if (parsed.kind === 'invalid') return { pending: true, message: parsed.message, custom }
  return { pending: true, message: null, custom: writeCustomKey(custom, name, parsed.value) }
}

export function overlayScalarEdits(
  custom: LevelCustomData,
  edits: readonly { key: string; kind: 'string' | 'number'; raw: string }[],
): { pending: boolean; message: string | null; custom: LevelCustomData } {
  let next = custom
  let pending = false
  const messages: string[] = []
  for (const edit of edits) {
    const current = custom[edit.key]
    const fallback = typeof current === 'number' ? String(current) : typeof current === 'string' ? current : ''
    if (edit.raw === fallback) continue
    pending = true
    if (edit.kind === 'string') {
      next = writeCustomKey(next, edit.key, edit.raw)
      continue
    }
    const parsed = classifyDraftNumber(edit.raw)
    if (parsed.kind === 'partial') messages.push('数字未完成')
    else if (parsed.kind === 'invalid') messages.push(parsed.message)
    else next = writeCustomKey(next, edit.key, parsed.value)
  }
  return { pending, message: messages[0] ?? null, custom: next }
}

export function planRename(doc: LevelDocument, kind: 'region' | 'landmark', currentId: string, raw: string): RenamePlan {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, message: 'id 不能为空' }
  if (trimmed === currentId) return { ok: true, unchanged: true }
  const next = kind === 'region' ? renameRegion(doc, currentId, trimmed) : renameLandmark(doc, currentId, trimmed)
  if (next === doc) {
    return { ok: false, message: kind === 'region' ? `已有区域「${trimmed}」` : `已有地标「${trimmed}」` }
  }
  const issues = levelIssues(next)
  if (issues.length) return { ok: false, message: issues[0]! }
  return { ok: true, unchanged: false, id: trimmed, doc: next }
}

export function firstSelection(doc: LevelDocument): LevelSelection {
  const region = doc.regions[0]
  if (region && region.areas.length) return { kind: 'region', id: region.id, area: 0 }
  const landmark = doc.landmarks[0]
  if (landmark) return { kind: 'landmark', id: landmark.id }
  return null
}

/** Keep a still-valid selection. A removed volume falls on its neighbor, then another object. */
export function coerceSelection(doc: LevelDocument, selection: LevelSelection): LevelSelection {
  if (!selection) return null
  if (selection.kind === 'landmark') {
    return doc.landmarks.some((item) => item.id === selection.id) ? selection : firstSelection(doc)
  }
  const region = doc.regions.find((item) => item.id === selection.id)
  if (!region || region.areas.length === 0) return firstSelection(doc)
  if (selection.area >= 0 && selection.area < region.areas.length) return selection
  return { kind: 'region', id: region.id, area: region.areas.length - 1 }
}

export function selectionAfterAreaDelete(doc: LevelDocument, regionId: string, index: number): LevelSelection {
  return coerceSelection(deleteArea(doc, regionId, index), { kind: 'region', id: regionId, area: index })
}

export function deletePlan(regionId: string, index: number, kind: LevelArea['kind'], count: number): DeletePlan {
  if (count <= 1) return { mode: 'single', label: `删除区域「${regionId}」`, count: 1 }
  return {
    mode: 'split',
    volumeLabel: `删除体积 ${index + 1}（${areaShapeLabel(kind)}）`,
    regionLabel: `删除区域「${regionId}」的全部 ${count} 个体积`,
    count,
  }
}

function readSlot(texts: Readonly<Record<string, string>>, key: string, fallback: number): {
  value: number
  message: string | null
  pending: boolean
} {
  if (!Object.prototype.hasOwnProperty.call(texts, key)) {
    return { value: fallback, message: null, pending: false }
  }
  const raw = texts[key] ?? ''
  if (raw.trim() === String(fallback)) return { value: fallback, message: null, pending: false }
  const parsed = classifyDraftNumber(raw)
  if (parsed.kind === 'value') {
    return { value: parsed.value, message: null, pending: parsed.value !== fallback }
  }
  if (parsed.kind === 'partial') return { value: fallback, message: '数字未完成', pending: true }
  return { value: fallback, message: parsed.message, pending: true }
}

function boundsMessage(min: number, max: number, label: string): string | null {
  return min > max ? `${label} 下限不能大于上限` : null
}

export function buildAreaDraft(area: LevelArea, texts: Readonly<Record<string, string>>): {
  pending: boolean
  message: string | null
  area: LevelArea
} {
  const messages: string[] = []
  let pending = false
  const take = (key: string, fallback: number) => {
    const slot = readSlot(texts, key, fallback)
    if (slot.message) messages.push(slot.message)
    if (slot.pending) pending = true
    return slot.value
  }
  if (area.kind === 'rect') {
    const x0 = take('x0', area.x[0])
    const x1 = take('x1', area.x[1])
    const z0 = take('z0', area.z[0])
    const z1 = take('z1', area.z[1])
    const xMessage = boundsMessage(x0, x1, 'X')
    const zMessage = boundsMessage(z0, z1, 'Z')
    if (xMessage) messages.push(xMessage)
    if (zMessage) messages.push(zMessage)
    const next: LevelArea = { ...area, x: [x0, x1], z: [z0, z1] }
    return finishArea(next, area, texts, messages, pending)
  }
  if (area.kind === 'circle') {
    const cx = take('cx', area.center[0])
    const cz = take('cz', area.center[1])
    const radius = take('r', area.radius)
    if (!(radius > 0)) messages.push('半径必须大于 0')
    const next: LevelArea = { ...area, center: [cx, cz], radius }
    return finishArea(next, area, texts, messages, pending)
  }
  const points = area.points.map((point, index) => {
    const x = take(`p${index}x`, point[0])
    const z = take(`p${index}z`, point[1])
    return [x, z] as [number, number]
  })
  return finishArea({ ...area, points }, area, texts, messages, pending)
}

function finishArea(
  next: LevelArea,
  area: LevelArea,
  texts: Readonly<Record<string, string>>,
  messages: string[],
  pending: boolean,
): { pending: boolean; message: string | null; area: LevelArea } {
  if (area.y !== 'all') {
    const y0 = readSlot(texts, 'y0', area.y[0])
    const y1 = readSlot(texts, 'y1', area.y[1])
    if (y0.message) messages.push(y0.message)
    if (y1.message) messages.push(y1.message)
    if (y0.pending || y1.pending) pending = true
    const yMessage = boundsMessage(y0.value, y1.value, 'Y')
    if (yMessage) messages.push(yMessage)
    next = { ...next, y: [y0.value, y1.value] }
  }
  const message = messages[0] ?? null
  const changed = JSON.stringify(next) !== JSON.stringify(area)
  return { pending: pending || changed, message, area: next }
}

export function buildPointDraft(
  param: { x: number; y: number; z: number },
  texts: Readonly<Record<string, string>>,
): { pending: boolean; message: string | null; param: { x: number; y: number; z: number } } {
  const messages: string[] = []
  let pending = false
  const next = { ...param }
  for (const axis of ['x', 'y', 'z'] as const) {
    const slot = readSlot(texts, axis, param[axis])
    if (slot.message) messages.push(slot.message)
    if (slot.pending) pending = true
    if (Math.abs(slot.value) > NAV_COORD_ABS_MAX) messages.push('坐标超出范围')
    next[axis] = slot.value
  }
  const message = messages[0] ?? null
  const changed = next.x !== param.x || next.y !== param.y || next.z !== param.z
  return { pending: pending || changed, message, param: next }
}

export function buildDisplayDraft(
  custom: LevelCustomData,
  texts: Readonly<Record<string, string>>,
): { pending: boolean; message: string | null; custom: LevelCustomData } {
  let next = custom
  let pending = false
  const messages: string[] = []
  const assign = (key: string, value: unknown, fallback: string) => {
    if (!Object.prototype.hasOwnProperty.call(texts, key)) return
    const raw = texts[key] ?? ''
    if (raw === fallback) return
    pending = true
    next = writeCustomKey(next, key, value)
  }
  if (Object.prototype.hasOwnProperty.call(texts, NAV_DISPLAY_NAME)) {
    const raw = texts[NAV_DISPLAY_NAME] ?? ''
    const fallback = typeof custom[NAV_DISPLAY_NAME] === 'string' ? String(custom[NAV_DISPLAY_NAME]) : ''
    if (raw !== fallback) {
      pending = true
      if (raw.length > NAV_LABEL_MAX) messages.push(`显示名不能超过 ${NAV_LABEL_MAX} 个字符`)
      else next = writeCustomKey(next, NAV_DISPLAY_NAME, raw === '' ? undefined : raw)
    }
  }
  if (Object.prototype.hasOwnProperty.call(texts, NAV_DISPLAY_ICON)) {
    const raw = texts[NAV_DISPLAY_ICON] ?? ''
    const fallback = typeof custom[NAV_DISPLAY_ICON] === 'string' ? String(custom[NAV_DISPLAY_ICON]) : ''
    if (raw !== fallback) {
      pending = true
      if (raw.trim() !== '' && !IDENTIFIER_RE.test(raw.trim())) messages.push('图标须为 namespace:path')
      else assign(NAV_DISPLAY_ICON, raw.trim() === '' ? undefined : raw.trim(), fallback)
    }
  }
  for (const key of [NAV_DISPLAY_MIN_DISTANCE, NAV_DISPLAY_MAX_DISTANCE] as const) {
    if (!Object.prototype.hasOwnProperty.call(texts, key)) continue
    const fallback = typeof custom[key] === 'number' ? String(custom[key]) : ''
    const raw = texts[key] ?? ''
    if (raw === fallback) continue
    pending = true
    if (raw.trim() === '') {
      next = writeCustomKey(next, key, undefined)
      continue
    }
    const parsed = classifyDraftNumber(raw)
    if (parsed.kind === 'partial') messages.push('数字未完成')
    else if (parsed.kind === 'invalid') messages.push(parsed.message)
    else if (parsed.value < 0) messages.push('距离须 ≥ 0')
    else next = writeCustomKey(next, key, parsed.value)
  }
  const min = next[NAV_DISPLAY_MIN_DISTANCE]
  const max = next[NAV_DISPLAY_MAX_DISTANCE]
  if (typeof min === 'number' && typeof max === 'number' && max > 0 && min > max) {
    messages.push('最小距离不能大于最大距离')
  }
  return { pending, message: messages[0] ?? null, custom: next }
}

function pickAxis(edited: number, shown: number, base: number): number {
  return edited !== shown ? edited : base
}

export function sameY(a: LevelY, b: LevelY): boolean {
  if (a === 'all' || b === 'all') return a === b
  return a[0] === b[0] && a[1] === b[1]
}

/** Copy only fields the form changed relative to the live preview onto the committed area. */
export function mergeShownArea(baseArea: LevelArea, shownArea: LevelArea, edited: LevelArea): LevelArea {
  if (baseArea.kind !== shownArea.kind || shownArea.kind !== edited.kind) return edited
  if (baseArea.kind === 'rect' && shownArea.kind === 'rect' && edited.kind === 'rect') {
    return {
      kind: 'rect',
      x: [pickAxis(edited.x[0], shownArea.x[0], baseArea.x[0]), pickAxis(edited.x[1], shownArea.x[1], baseArea.x[1])],
      z: [pickAxis(edited.z[0], shownArea.z[0], baseArea.z[0]), pickAxis(edited.z[1], shownArea.z[1], baseArea.z[1])],
      y: baseArea.y,
    }
  }
  if (baseArea.kind === 'circle' && shownArea.kind === 'circle' && edited.kind === 'circle') {
    return {
      kind: 'circle',
      center: [
        pickAxis(edited.center[0], shownArea.center[0], baseArea.center[0]),
        pickAxis(edited.center[1], shownArea.center[1], baseArea.center[1]),
      ],
      radius: pickAxis(edited.radius, shownArea.radius, baseArea.radius),
      y: baseArea.y,
    }
  }
  if (baseArea.kind === 'polygon' && shownArea.kind === 'polygon' && edited.kind === 'polygon') {
    if (edited.points.length !== baseArea.points.length || edited.points.length !== shownArea.points.length) {
      return { kind: 'polygon', points: edited.points, y: baseArea.y }
    }
    return {
      kind: 'polygon',
      points: edited.points.map((point, index) => [
        pickAxis(point[0], shownArea.points[index]![0], baseArea.points[index]![0]),
        pickAxis(point[1], shownArea.points[index]![1], baseArea.points[index]![1]),
      ]),
      y: baseArea.y,
    }
  }
  return edited
}

export function mergeLandmarkParam(
  base: { x: number; y: number; z: number },
  shown: { x: number; y: number; z: number },
  edited: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  return {
    x: pickAxis(edited.x, shown.x, base.x),
    y: pickAxis(edited.y, shown.y, base.y),
    z: pickAxis(edited.z, shown.z, base.z),
  }
}

export function applyAreaDraft(
  doc: LevelDocument,
  shown: LevelDocument,
  regionId: string,
  index: number,
  edited: LevelArea,
): LevelDocument | { blocked: string } {
  const baseArea = doc.regions.find((region) => region.id === regionId)?.areas[index]
  const shownArea = shown.regions.find((region) => region.id === regionId)?.areas[index]
  if (!baseArea || !shownArea) return { blocked: '体积已不存在' }
  const merged = mergeShownArea(baseArea, shownArea, edited)
  const y = sameY(shownArea.y, edited.y) ? baseArea.y : edited.y
  return replaceArea(doc, regionId, index, { ...merged, y })
}

export function applyPointDraft(
  doc: LevelDocument,
  shown: LevelDocument,
  landmarkId: string,
  edited: { x: number; y: number; z: number },
): LevelDocument | { blocked: string } {
  const basePoint = doc.landmarks.find((item) => item.id === landmarkId)
  const shownPoint = shown.landmarks.find((item) => item.id === landmarkId)
  if (!basePoint || !shownPoint) return { blocked: '地标已不存在' }
  return setLandmarkParam(doc, landmarkId, mergeLandmarkParam(basePoint.param, shownPoint.param, edited))
}

function isLevelDocument(value: LevelDocument | { blocked: string }): value is LevelDocument {
  return 'regions' in value
}

/**
 * Combine field drafts into one document. Invalid or unapplied text blocks.
 * Read-only never applies reduces, so a downgrade cannot write author JSON.
 */
export function evaluateLevelDrafts(
  doc: LevelDocument,
  shown: LevelDocument,
  drafts: Iterable<LevelDraftRecord>,
  options: { readOnly: boolean },
): { ok: true; doc: LevelDocument } | { ok: false; message: string } {
  const items = [...drafts].sort((a, b) => a.order - b.order)
  for (const item of items) {
    if (item.message) return { ok: false, message: item.message }
    if (item.pending && !item.reduce) return { ok: false, message: '有未应用的编辑' }
  }
  if (options.readOnly) {
    if (items.some((item) => item.pending)) return { ok: false, message: '只读，未写入字段草稿' }
    return { ok: true, doc }
  }
  let next = doc
  for (const item of items) {
    if (!item.reduce || !item.pending) continue
    const reduced = item.reduce(next, shown)
    if (!isLevelDocument(reduced)) return { ok: false, message: reduced.blocked }
    next = reduced
  }
  return { ok: true, doc: next }
}

export function levelModeStatus(input: {
  readOnly: boolean
  mode: 'offline' | 'game'
  connected: boolean
  hasPicture: boolean
  issue: string | null
  hover: [number, number, number] | null
  hint: string | null
}): string {
  if (input.readOnly) {
    const base = input.mode === 'game'
      ? (input.connected ? '游戏内只读' : '只读 · 游戏开发服务器未连接')
      : '只读'
    return input.issue ? `${base} · ${input.issue}` : base
  }
  if (input.mode === 'game') {
    if (!input.connected) return '游戏开发服务器未连接'
    if (!input.hasPicture) return '正在等待游戏画面'
    return input.hint || '游戏内编辑 · Alt 精细 0.1'
  }
  if (input.issue) return input.issue
  if (input.hover) return `X ${input.hover[0]}  Y ${input.hover[1]}  Z ${input.hover[2]}`
  return input.hint || '右键环绕 · 中键平移 · 滚轮推拉 · F 对准选中'
}
