/** The visual editor only rewrites literal components. Unknown structure stays intact. */
export const TEXT_STYLE_KEYS = ['bold', 'italic', 'underlined', 'strikethrough', 'obfuscated'] as const
export type TextStyleKey = (typeof TEXT_STYLE_KEYS)[number]
export type TextSegment = { text: string; color?: string } & Partial<Record<TextStyleKey, boolean>>
export type DecodedTextComponent = { editable: boolean; segments: TextSegment[]; original: unknown }
const allowed = new Set(['text', 'extra', 'color', ...TEXT_STYLE_KEYS])
const namedColors = new Set(['black', 'dark_blue', 'dark_green', 'dark_aqua', 'dark_red', 'dark_purple', 'gold', 'gray', 'dark_gray', 'blue', 'green', 'aqua', 'red', 'light_purple', 'yellow', 'white'])
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }

export function decodeTextComponent(original: unknown): DecodedTextComponent {
  const segments: TextSegment[] = []
  function walk(value: unknown, base: Omit<TextSegment, 'text'>): boolean {
    if (typeof value === 'string') { segments.push({ ...base, text: value }); return true }
    if (Array.isArray(value)) {
      if (!value.length) return false
      if (!walk(value[0], base)) return false
      const first = rootStyle(value[0], base)
      return value.slice(1).every(child => walk(child, first))
    }
    if (!object(value) || Object.keys(value).some(key => !allowed.has(key))) return false
    if ('text' in value && typeof value.text !== 'string') return false
    if (!('text' in value) && !('extra' in value)) return false
    if ('color' in value && (typeof value.color !== 'string' || !(namedColors.has(value.color) || /^#[\da-f]{6}$/i.test(value.color)))) return false
    if (TEXT_STYLE_KEYS.some(key => key in value && typeof value[key] !== 'boolean')) return false
    if ('extra' in value && !Array.isArray(value.extra)) return false
    const own = style(value, base)
    segments.push({ ...own, text: typeof value.text === 'string' ? value.text : '' })
    return !Array.isArray(value.extra) || value.extra.every(child => walk(child, own))
  }
  const editable = walk(original, {})
  return { editable, segments: editable ? segments : [], original }
}
/** Nested arrays retain the style of their first Component root, just like ordinary siblings. */
function rootStyle(value: unknown, base: Omit<TextSegment, 'text'>): Omit<TextSegment, 'text'> {
  if (Array.isArray(value)) return value.length ? rootStyle(value[0], base) : base
  return object(value) ? style(value, base) : base
}

function style(value: Record<string, unknown>, base: Omit<TextSegment, 'text'>): Omit<TextSegment, 'text'> {
  const out = { ...base }
  if (typeof value.color === 'string') out.color = value.color
  for (const key of TEXT_STYLE_KEYS) if (typeof value[key] === 'boolean') out[key] = value[key]
  return out
}
/** Locale values use Kit's plain-string or serialized Component convention. */
export function decodeTextValue(raw: string): DecodedTextComponent {
  let value: unknown = raw
  if (/^\s*[[{"]/.test(raw)) { try { value = JSON.parse(raw) } catch { /* ordinary text */ } }
  return decodeTextComponent(value)
}
export function isTranslateComponent(value: unknown): value is Record<string, unknown> & { translate: string } {
  return object(value) && typeof value.translate === 'string'
}
