import {
  DEFAULT_SOURCE_EXT,
  VOICE_ASSET_EXTENSION,
  dropExtension,
  isUnderVoiceRoot,
  sourceDir,
  sourceFileStemName,
  voiceAssetPath,
  voiceRootDir,
} from './localeLayout'
import { BLANK_OGG_BYTES } from './voiceBytes'

export { dropExtension, VOICE_ASSET_EXTENSION }

/**
 * 配音的「对等文件」路径约定 —— 路径拼装统一走 `localeLayout`，这里只保留
 * 配音特有的解析逻辑（对等位置解析、同目标判定等）。
 *
 * **没有映射文件**：键名直接对应一个按脚本路径推导出来的对等文件：
 *   脚本 `hello/cp1.hs` 的键 `abcd1234`
 *   → `assets/<语言标签>/voice_hs/hello/cp1/abcd1234.ogg`
 * 也就是：脚本相对包根的路径（去后缀）当目录，键名当文件名，扩展名固定 `.ogg`。
 * `voice_<ext>` 里的 `<ext>` 取源文件后缀（默认 `hs`）；`main.char` 就是
 * `assets/<tag>/voice_char/main/<键名>.ogg`。
 *
 * 对等文件**只认对等位置上的 `.ogg`**：导入时可以拿 wav / mp3 / flac 等任意格式当源，
 * 导入完成后落地的必须是对等位置上的单通道 ogg。`.ogg` 之外的扩展名、以及放在别的目录
 * 的同名文件都不算对等文件（旧约定「换扩展名也算命中」「整根同名兜底」均已废弃）。
 * 「单通道」由解码结果判定，见 `voiceRuntime`（`mode: 'asset'`）与
 * `voiceLibrary.isAcceptedVoice`。
 */

/** 该键的对等目录：`assets/<tag>/voice_<ext>/<脚本目录>` */
export function voiceAssetDir(
  locale: string,
  scriptName: string,
  ext: string = DEFAULT_SOURCE_EXT,
): string {
  const dir = [sourceDir(scriptName), sourceFileStemName(scriptName)]
    .filter(Boolean)
    .join('/')
  const root = voiceRootDir(locale, ext)
  return dir ? `${root}/${dir}` : root
}

/** 该键的**对等基名**（去扩展名）：缺省查找与「同目标」判定都用它 */
export function voiceAssetBase(
  locale: string,
  scriptName: string,
  key: string,
  ext: string = DEFAULT_SOURCE_EXT,
): string {
  return `${voiceAssetDir(locale, scriptName, ext)}/${key.trim().toLowerCase()}`
}

/** 该键的对等文件路径（固定 `.ogg`）：导入的写入目标 */
export function voiceKeyAssetPath(
  locale: string,
  scriptName: string,
  key: string,
  ext: string = DEFAULT_SOURCE_EXT,
): string {
  return `${voiceAssetBase(locale, scriptName, key, ext)}.${VOICE_ASSET_EXTENSION}`
}

/** 取文件名（含后缀） */
export function voiceFileName(path: string): string {
  const parts = path.trim().replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] ?? ''
}

/** 取小写扩展名（不含点）；没有后缀返回空串 */
export function voiceAssetExtension(path: string): string {
  return /\.([a-z0-9]+)$/i.exec(voiceFileName(path))?.[1].toLowerCase() ?? ''
}

/** 是否是本项目的合法配音容器格式：只看后缀，单通道与否要解码后判定 */
export function isVoiceOggPath(path: string): boolean {
  return voiceAssetExtension(path) === VOICE_ASSET_EXTENSION
}

/** 路径是否就是某个键的对等文件（大小写不敏感、可比去扩展名形式） */
export function isSameVoiceAsset(
  candidate: string,
  locale: string,
  scriptName: string,
  key: string,
): boolean {
  const norm = (value: string) =>
    dropExtension(value.trim().replace(/\\/g, '/')).toLowerCase()
  return norm(candidate) === norm(voiceAssetBase(locale, scriptName, key))
}

/**
 * 按「脚本路径 + 键名」解析配音资产 —— 只认**对等位置上的 `.ogg`**：
 * `assets/<locale>/voice_<ext>/<脚本目录>/<键名>.ogg`。
 * 没有第二轮兜底：同名文件放在别的目录不算命中（早期约定已删）。非 `.ogg` 一律忽略；
 * 「单通道」由解码结果判定（见 `voiceRuntime` 的 `mode: 'asset'`）。
 * 命中多个时按路径排序，顺序稳定。
 */
export function resolveVoiceAssetFor<T extends { path: string }>(
  scriptName: string,
  key: string,
  locale: string,
  assets: readonly T[],
): T | null {
  const normalizedKey = key.trim().toLowerCase()
  if (!normalizedKey) return null

  const inside = assets
    .filter(
      (asset) => isUnderVoiceRoot(asset.path, locale) && isVoiceOggPath(asset.path),
    )
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
  if (inside.length === 0) return null

  const targetBase = voiceAssetBase(locale, scriptName, normalizedKey).toLowerCase()
  const exact = inside.filter(
    (asset) => dropExtension(asset.path).toLowerCase() === targetBase,
  )
  return exact[0] ?? null
}

// ===== 自 src/hanshu/voice.ts 并入 =====

export type VoiceMap = Record<string, string>

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

/** stem 是否像可用文件名（非源文、无路径分隔） */
export function isVoiceFileStemName(value: string): boolean {
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
    if (!stem || !isVoiceFileStemName(stem)) continue
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
