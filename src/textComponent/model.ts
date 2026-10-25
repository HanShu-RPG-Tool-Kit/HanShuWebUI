/**
 * 礼包反馈文案：与 Minecraft 文本组件对齐的编解码。
 * 本地化值可为纯字符串，或 JSON 文本组件（支持 hex / 命名色）。
 * 分段由编辑器按选区自动拆合，作者不必手维分段。
 */

import type { TextSegment as ItemTextSegment } from './codec'
import { decodeTextComponent } from './codec'

/** 编辑器色板：命名色 → hex（与原版 16 色一致） */
export const FEEDBACK_COLOR_SWATCHES: { id: string; hex: string; label: string }[] = [
  { id: 'white', hex: '#FFFFFF', label: '白' },
  { id: 'gray', hex: '#AAAAAA', label: '灰' },
  { id: 'dark_gray', hex: '#555555', label: '深灰' },
  { id: 'black', hex: '#000000', label: '黑' },
  { id: 'red', hex: '#FF5555', label: '红' },
  { id: 'dark_red', hex: '#AA0000', label: '深红' },
  { id: 'gold', hex: '#FFAA00', label: '金' },
  { id: 'yellow', hex: '#FFFF55', label: '黄' },
  { id: 'green', hex: '#55FF55', label: '绿' },
  { id: 'dark_green', hex: '#00AA00', label: '深绿' },
  { id: 'aqua', hex: '#55FFFF', label: '青' },
  { id: 'dark_aqua', hex: '#00AAAA', label: '深青' },
  { id: 'blue', hex: '#5555FF', label: '蓝' },
  { id: 'dark_blue', hex: '#0000AA', label: '深蓝' },
  { id: 'light_purple', hex: '#FF55FF', label: '粉' },
  { id: 'dark_purple', hex: '#AA00AA', label: '紫' },
]

export const FEEDBACK_STYLE_KEYS = [
  'bold',
  'italic',
  'underlined',
  'strikethrough',
  'obfuscated',
] as const

export type FeedbackStyleKey = (typeof FEEDBACK_STYLE_KEYS)[number]

export type FeedbackStylePatch = {
  color?: string | null
} & Partial<Record<FeedbackStyleKey, boolean | null>>

type CharStyle = {
  color?: string
} & Partial<Record<FeedbackStyleKey, boolean>>

function normalizeHex(color: string | undefined): string | undefined {
  if (!color) return undefined
  const named = FEEDBACK_COLOR_SWATCHES.find(
    (item) => item.id === color || item.hex.toLowerCase() === color.toLowerCase(),
  )
  if (named) return named.hex
  if (/^#[0-9a-fA-F]{6}$/.test(color)) return color.toUpperCase()
  return undefined
}

function hasStyle(segment: ItemTextSegment): boolean {
  if (segment.color) return true
  return FEEDBACK_STYLE_KEYS.some((key) => segment[key] !== undefined)
}

function styleSignature(style: CharStyle): string {
  return [
    style.color ?? '',
    ...FEEDBACK_STYLE_KEYS.map((key) => (style[key] === undefined ? '' : `${key}:${style[key]}`)),
  ].join('|')
}

function styleFromSegment(segment: ItemTextSegment): CharStyle {
  const style: CharStyle = {}
  const color = normalizeHex(segment.color)
  if (color) style.color = color
  for (const key of FEEDBACK_STYLE_KEYS) {
    if (segment[key] !== undefined) style[key] = segment[key]
  }
  return style
}

function segmentFromRun(text: string, style: CharStyle): ItemTextSegment {
  const segment: ItemTextSegment = { text }
  if (style.color) segment.color = style.color
  for (const key of FEEDBACK_STYLE_KEYS) {
    if (style[key] !== undefined) segment[key] = style[key]
  }
  return segment
}

function segmentObject(segment: ItemTextSegment): Record<string, unknown> {
  const out: Record<string, unknown> = { text: segment.text }
  const color = normalizeHex(segment.color)
  if (color) out.color = color
  for (const key of FEEDBACK_STYLE_KEYS) {
    if (segment[key] !== undefined) out[key] = segment[key]
  }
  return out
}

/** 相邻同款样式合并为标准分段 */
export function mergeFeedbackSegments(
  segments: ItemTextSegment[],
): ItemTextSegment[] {
  const out: ItemTextSegment[] = []
  for (const segment of segments) {
    if (!segment.text) continue
    const prev = out[out.length - 1]
    if (
      prev &&
      styleSignature(styleFromSegment(prev)) ===
        styleSignature(styleFromSegment(segment))
    ) {
      prev.text += segment.text
      continue
    }
    out.push({ ...segment })
  }
  return out.length > 0 ? out : [{ ...(segments[0] ?? {}), text: '' }]
}

export function flatFeedbackText(segments: ItemTextSegment[]): string {
  return segments.map((segment) => segment.text).join('')
}

/** 本地化原文 → 编辑用分段；空串给一段空文本 */
export function parseFeedbackText(raw: string): ItemTextSegment[] {
  if (!raw) return [{ text: '' }]
  let component: unknown = raw
  if (/^\s*[[{"]/.test(raw)) {
    try { component = JSON.parse(raw) } catch { /* plain text */ }
  }
  const decoded = decodeTextComponent(component)
  if (!decoded.editable) return [{ text: raw }]
  const segments = decoded.segments.map((segment) => {
    const color = normalizeHex(segment.color)
    if (!color) {
      const { color: _drop, ...rest } = segment
      void _drop
      return rest
    }
    return { ...segment, color }
  })
  return mergeFeedbackSegments(segments.length > 0 ? segments : [{ text: '' }])
}

/**
 * 分段 → 写入本地化的字符串。
 * 无样式单段存纯文本；有样式或有多段存文本组件 JSON（引擎用 Serializer.fromJson）。
 */
export function stringifyFeedbackText(segments: ItemTextSegment[]): string {
  const list = mergeFeedbackSegments(
    segments.length > 0 ? segments : [{ text: '' }],
  )
  const trimmedEmpty =
    list.length === 1 && !list[0].text && !hasStyle(list[0])
  if (trimmedEmpty) return ''

  if (list.length === 1 && !hasStyle(list[0])) {
    const text = list[0].text
    if (/^[\s]*[[{"]/.test(text)) return JSON.stringify({ text })
    return text
  }

  if (list.length === 1) return JSON.stringify(segmentObject(list[0]))
  return JSON.stringify({
    text: '',
    extra: list.map(segmentObject),
  })
}

/**
 * 对 [start, end) 字符区间应用样式；无选区时由调用方传整段。
 * 自动拆分 / 合并为标准分段。
 */
export function applyFeedbackStyleRange(
  segments: ItemTextSegment[],
  start: number,
  end: number,
  patch: FeedbackStylePatch,
): ItemTextSegment[] {
  const flat = flatFeedbackText(segments)
  if (!flat) {
    const style = styleFromSegment(segments[0] ?? { text: '' })
    applyPatchToStyle(style, patch)
    return [segmentFromRun('', style)]
  }

  const from = Math.max(0, Math.min(start, end, flat.length))
  const to = Math.min(flat.length, Math.max(start, end))
  if (from === to) return mergeFeedbackSegments(segments)

  // 按 UTF-16 码元展开，与 Selection#toString().length 对齐
  type Cell = { ch: string; style: CharStyle }
  const cells: Cell[] = []
  for (const segment of segments) {
    const style = styleFromSegment(segment)
    for (let i = 0; i < segment.text.length; i++) {
      cells.push({ ch: segment.text[i], style: { ...style } })
    }
  }

  for (let i = from; i < to; i++) {
    applyPatchToStyle(cells[i].style, patch)
  }

  const next: ItemTextSegment[] = []
  let runText = cells[0].ch
  let runStyle = cells[0].style
  for (let i = 1; i < cells.length; i++) {
    if (styleSignature(cells[i].style) === styleSignature(runStyle)) {
      runText += cells[i].ch
      continue
    }
    next.push(segmentFromRun(runText, runStyle))
    runText = cells[i].ch
    runStyle = cells[i].style
  }
  next.push(segmentFromRun(runText, runStyle))
  return mergeFeedbackSegments(next)
}

function applyPatchToStyle(
  style: CharStyle,
  patch: FeedbackStylePatch,
): void {
  if ('color' in patch) {
    if (patch.color === null || patch.color === '') delete style.color
    else {
      const hex = normalizeHex(patch.color)
      if (hex) style.color = hex
      else delete style.color
    }
  }
  for (const key of FEEDBACK_STYLE_KEYS) {
    if (!(key in patch)) continue
    const value = patch[key]
    if (value === null || value === undefined) delete style[key]
    else style[key] = value
  }
}

/** 去掉选区（或全文）上的颜色与字形样式，保留正文 */
export function clearFeedbackStyles(
  segments: ItemTextSegment[],
  start: number,
  end: number,
): ItemTextSegment[] {
  return applyFeedbackStyleRange(segments, start, end, {
    color: null,
    bold: null,
    italic: null,
    underlined: null,
    strikethrough: null,
    obfuscated: null,
  })
}

/** Keep unchanged prefix/suffix styles; inserted text inherits its adjacent editing style. */
export function replaceFeedbackPlainText(
  segments: ItemTextSegment[],
  text: string,
): ItemTextSegment[] {
  if (!text) return [segmentFromRun('', styleFromSegment(segments[0] ?? { text: '' }))]
  const old = flatFeedbackText(segments)
  if (text === old) return mergeFeedbackSegments(segments)

  type Cell = { ch: string; style: CharStyle }
  const oldCells: Cell[] = []
  for (const segment of segments) {
    const style = styleFromSegment(segment)
    for (let i = 0; i < segment.text.length; i++) {
      oldCells.push({ ch: segment.text[i], style: { ...style } })
    }
  }
  let prefix = 0
  while (prefix < old.length && prefix < text.length && old[prefix] === text[prefix]) prefix++
  let suffix = 0
  while (suffix < old.length - prefix && suffix < text.length - prefix && old[old.length - suffix - 1] === text[text.length - suffix - 1]) suffix++
  const oldEnd = old.length - suffix
  const newEnd = text.length - suffix
  const reference = prefix > 0 ? prefix - 1 : oldEnd < old.length ? oldEnd : 0
  const fallback = oldCells[reference]?.style ?? styleFromSegment(segments[0] ?? { text: '' })
  const styleAt = (index: number): CharStyle => {
    if (index < prefix) return oldCells[index].style
    if (index < newEnd) return fallback
    return oldCells[index + oldEnd - newEnd]?.style ?? fallback
  }

  const next: ItemTextSegment[] = []
  let runText = ''
  let runStyle: CharStyle = styleAt(0)
  for (let i = 0; i < text.length; i++) {
    const style = styleAt(i)
    const ch = text[i]
    if (!runText) {
      runText = ch
      runStyle = { ...style }
      continue
    }
    if (styleSignature(style) === styleSignature(runStyle)) {
      runText += ch
      continue
    }
    next.push(segmentFromRun(runText, runStyle))
    runText = ch
    runStyle = { ...style }
  }
  if (runText) next.push(segmentFromRun(runText, runStyle))
  return mergeFeedbackSegments(next)
}
