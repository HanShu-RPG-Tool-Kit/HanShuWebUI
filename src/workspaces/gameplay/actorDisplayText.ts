import {
  FEEDBACK_COLOR_SWATCHES,
  stringifyFeedbackText,
  type FeedbackStyleKey,
} from '../../textComponent/model'
import type { TextSegment as ItemTextSegment } from '../../textComponent/codec'

/** Vanilla legacy color codes → named palette ids used by the rich-text editor. */
const LEGACY_COLORS: Record<string, string> = {
  '0': 'black',
  '1': 'dark_blue',
  '2': 'dark_green',
  '3': 'dark_aqua',
  '4': 'dark_red',
  '5': 'dark_purple',
  '6': 'gold',
  '7': 'gray',
  '8': 'dark_gray',
  '9': 'blue',
  a: 'green',
  b: 'aqua',
  c: 'red',
  d: 'light_purple',
  e: 'yellow',
  f: 'white',
}

const LEGACY_STYLES: Record<string, FeedbackStyleKey> = {
  k: 'obfuscated',
  l: 'bold',
  m: 'strikethrough',
  n: 'underlined',
  o: 'italic',
}

function looksLikeComponentJson(raw: string): boolean {
  return /^\s*[[{"]/.test(raw)
}

function looksLikeLegacyAmpersand(raw: string): boolean {
  return /[&§][0-9a-fk-or]/i.test(raw)
}

/**
 * Convert wand-style `&`/`§` plain text into the same stored form the rich-text editor writes
 * (plain or Component JSON). Already-JSON / plain lines without codes pass through.
 */
export function actorDisplayLineForEditor(raw: string): string {
  if (!raw || looksLikeComponentJson(raw) || !looksLikeLegacyAmpersand(raw)) return raw
  const source = raw.replace(/&/g, '§')
  const segments: ItemTextSegment[] = []
  let style: Omit<ItemTextSegment, 'text'> = {}
  let buf = ''
  const flush = () => {
    if (!buf && Object.keys(style).length === 0) return
    segments.push({ text: buf, ...style })
    buf = ''
  }
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (ch === '§' && i + 1 < source.length) {
      flush()
      const code = source[++i]!.toLowerCase()
      if (code === 'r') {
        style = {}
        continue
      }
      const color = LEGACY_COLORS[code]
      if (color) {
        const hex = FEEDBACK_COLOR_SWATCHES.find((item) => item.id === color)?.hex
        style = hex ? { color: hex } : {}
        continue
      }
      const key = LEGACY_STYLES[code]
      if (key) {
        style = { ...style, [key]: true }
      }
      continue
    }
    buf += ch
  }
  flush()
  return stringifyFeedbackText(segments.length ? segments : [{ text: '' }])
}
