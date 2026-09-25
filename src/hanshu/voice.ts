import { type LinesFile } from './lines'
import { BLANK_OGG_BYTES } from './blankVoiceOgg'

export type VoiceMap = Record<string, string>

const LOCALE_FILE_RE = /\.lines\.([a-z][a-z0-9_]*)\.(lang|voice)$/i

export function parseVoiceLocaleFile(
  fileName: string,
): { locale: string } | null {
  const m = fileName.trim().match(LOCALE_FILE_RE)
  if (!m || m[2].toLowerCase() !== 'voice') return null
  return { locale: m[1].toLowerCase() }
}

/** `cp1.lines.zh_cn.voice` → `cp1.lines` */
export function linesFileNameForVoice(voiceName: string): string | null {
  if (!parseVoiceLocaleFile(voiceName)) return null
  const base = voiceName.replace(/\.lines\.[a-z][a-z0-9_]*\.voice$/i, '.lines')
  return /\.lines$/i.test(base) ? base : null
}

export function parseVoiceMap(raw: string): VoiceMap {
  if (!raw.trim()) return {}
  try {
    const data = JSON.parse(raw) as unknown
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
    const out: VoiceMap = {}
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

export function stringifyVoiceMap(map: VoiceMap): string {
  return `${JSON.stringify(map, null, 2)}\n`
}

export function parseLinesMap(raw: string): LinesFile {
  if (!raw.trim()) return {}
  try {
    const data = JSON.parse(raw) as unknown
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
    const out: LinesFile = {}
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/** stem 是否像可用文件名（非源文、无路径分隔） */
export function isVoiceStemId(value: string): boolean {
  const s = value.trim()
  if (!s) return false
  if (s.includes('/') || s.includes('\\') || s.includes('..')) return false
  if (/\s/.test(s)) return false
  if (s.length > 64) return false
  if (/[\u4e00-\u9fff]/.test(s)) return false
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(s)
}

function detectIndent(raw: string): string {
  const m = raw.match(/\n([ \t]+)"/)
  return m?.[1] ?? '  '
}

function detectNewline(raw: string): string {
  return raw.includes('\r\n') ? '\r\n' : '\n'
}

/**
 * 在 JSON 对象文本末尾插入新键值，**不重排、不重写**已有正文。
 */
export function appendJsonObjectEntries(
  raw: string,
  entries: Array<[string, string]>,
): string {
  if (entries.length === 0) return raw

  const nl = detectNewline(raw)
  const indent = detectIndent(raw)
  const block = entries
    .map(
      ([k, v]) =>
        `${indent}${JSON.stringify(k)}: ${JSON.stringify(v)}`,
    )
    .join(`,${nl}`)

  const trimmed = raw.replace(/\s+$/, '')
  if (!trimmed || /^\{\s*\}$/.test(trimmed)) {
    return `{${nl}${block}${nl}}${nl}`
  }

  const closeIdx = trimmed.lastIndexOf('}')
  if (closeIdx < 0) {
    const map: VoiceMap = {}
    for (const [k, v] of entries) map[k] = v
    return stringifyVoiceMap(map)
  }

  let head = trimmed.slice(0, closeIdx).replace(/[ \t]+$/, '')
  // 去掉头尾空白后若只剩 `{`，直接写入
  if (/^\{\s*$/.test(head)) {
    return `{${nl}${block}${nl}}${nl}`
  }

  // 去掉 `}` 前多余空行，保证逗号接在上一条 property 后
  head = head.replace(/[\r\n]+$/, '')
  if (!head.endsWith(',')) {
    head += ','
  }

  return `${head}${nl}${block}${nl}}${nl}`
}

export type PullVoiceResult = {
  content: string
  added: number
  idified: number
  total: number
}

/**
 * 相对同名 `.lines` 拉取缺失 hash：
 * - 原文一字不动，只在 `}` 前追加新行
 * - 新条目 value = `.lines` 原文（便于核对；之后再 id 化）
 * - 不改已有 key/value，不整表 stringify
 */
export function pullVoiceFromLines(
  voiceRaw: string,
  linesRaw: string,
): PullVoiceResult {
  const existing = parseVoiceMap(voiceRaw)
  const lines = parseLinesMap(linesRaw)

  const additions: Array<[string, string]> = []
  for (const hash of Object.keys(lines)) {
    if (hash in existing) continue
    const source = lines[hash]?.trim() ?? ''
    if (!source) continue
    additions.push([hash, source])
  }

  const content =
    additions.length === 0
      ? voiceRaw
      : appendJsonObjectEntries(
          voiceRaw.trim() ? voiceRaw : '{}\n',
          additions,
        )

  return {
    content,
    added: additions.length,
    idified: 0,
    total: Object.keys(existing).length + additions.length,
  }
}

/** `assets/<locale>/voice/<stem>.ogg` */
export function voiceAssetPath(locale: string, stem: string): string {
  return `assets/${locale}/voice/${stem.trim()}.ogg`
}

export function listMissingVoiceOggs(
  voiceRaw: string,
  locale: string,
  existingPaths: Iterable<string>,
): { stem: string; path: string }[] {
  const voice = parseVoiceMap(voiceRaw)
  const have = new Set(
    [...existingPaths].map((p) => p.replace(/\\/g, '/').toLowerCase()),
  )
  const missing: { stem: string; path: string }[] = []
  const seenStem = new Set<string>()

  for (const stemRaw of Object.values(voice)) {
    const stem = stemRaw.trim()
    if (!stem || !isVoiceStemId(stem)) continue
    const key = stem.toLowerCase()
    if (seenStem.has(key)) continue
    seenStem.add(key)
    const path = voiceAssetPath(locale, stem)
    if (!have.has(path.toLowerCase())) missing.push({ stem, path })
  }

  return missing.sort((a, b) => a.path.localeCompare(b.path))
}

/** 占位空白 ogg（可被真配音覆盖） */
export function createBlankOggBlob(): Blob {
  return new Blob([BLANK_OGG_BYTES], { type: 'audio/ogg' })
}
