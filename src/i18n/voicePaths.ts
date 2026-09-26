import { DEFAULT_LOCALE_TAG, formatLocaleTag } from './locales'

/**
 * 配音的「对等文件」路径约定。
 *
 * **没有映射文件**：键名直接对应一个按脚本路径推导出来的对等文件 ——
 *   脚本 `hello/cp1.hs` 的键 `abcd1234`
 *   → `assets/<语言标签>/voice/hello/cp1/abcd1234.ogg`
 * 也就是：脚本相对包根的路径（去后缀）当目录，键名当文件名，扩展名固定 `.ogg`。
 *
 * 查找仍保留「去后缀同名」的缺省处理（同目录下 wav/mp3/ogg 任意格式都能被找到，
 * 同名前缀优先 `.ogg`），但只有**单通道 ogg** 才算可用 —— 合法性由解码结果判定。
 */

/** 对等文件的目标扩展名：只认 ogg（是否单通道要解码后才知道） */
export const VOICE_ASSET_EXTENSION = 'ogg'

/** 当前语言的音频根目录：`assets/<语言标签>/voice` */
export function voiceRootDir(locale: string): string {
  const tag = formatLocaleTag(locale) || DEFAULT_LOCALE_TAG
  return `assets/${tag}/voice`
}

/** 脚本名规范化：反斜杠转正斜杠、去掉 `./` 与首尾斜杠 */
export function normalizeScriptPath(scriptName: string): string {
  return scriptName
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
}

/** 去掉最后一个后缀：`hello/cp1.hs` → `hello/cp1` */
export function dropExtension(path: string): string {
  return path.replace(/\.[^./\\]+$/, '')
}

/**
 * 脚本在音频根下的目录名：`hello/cp1.hs` → `hello/cp1`；`cp1.hs` → `cp1`。
 * 逐段清洗，去掉空段与 `..`（脚本名本来就不允许斜杠，这里只是防御性处理）。
 */
export function scriptAssetDir(scriptName: string): string {
  const stem = dropExtension(normalizeScriptPath(scriptName))
  const safe = stem
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part && part !== '.' && part !== '..')
  return safe.join('/')
}

/** 该键的对等目录：`assets/<tag>/voice/<脚本目录>` */
export function voiceTargetDir(locale: string, scriptName: string): string {
  const dir = scriptAssetDir(scriptName)
  return dir ? `${voiceRootDir(locale)}/${dir}` : voiceRootDir(locale)
}

/** 该键的**对等基名**（去扩展名）：缺省查找与「同目标」判定都用它 */
export function voiceTargetBase(
  locale: string,
  scriptName: string,
  key: string,
): string {
  return `${voiceTargetDir(locale, scriptName)}/${key.trim().toLowerCase()}`
}

/** 该键的对等文件路径（固定 `.ogg`）：导入的写入目标 */
export function voiceTargetPath(
  locale: string,
  scriptName: string,
  key: string,
): string {
  return `${voiceTargetBase(locale, scriptName, key)}.${VOICE_ASSET_EXTENSION}`
}

/** 取文件名（含后缀） */
export function voiceBaseName(path: string): string {
  const parts = path.trim().replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] ?? ''
}

/** 取文件名（去后缀） */
export function voiceStem(path: string): string {
  return dropExtension(voiceBaseName(path))
}

/** 取小写扩展名（不含点）；没有后缀返回空串 */
export function voiceAssetExtension(path: string): string {
  return /\.([a-z0-9]+)$/i.exec(voiceBaseName(path))?.[1].toLowerCase() ?? ''
}

/** 是否是本项目的合法配音容器格式：只看后缀，单通道与否要解码后判定 */
export function isVoiceOggPath(path: string): boolean {
  return voiceAssetExtension(path) === VOICE_ASSET_EXTENSION
}

/** 该路径是否位于当前语言的音频根下（含子目录，大小写不敏感） */
export function isUnderVoiceRoot(path: string, locale: string): boolean {
  const root = `${voiceRootDir(locale).toLowerCase()}/`
  return path.trim().replace(/\\/g, '/').toLowerCase().startsWith(root)
}

/** 路径是否就是某个键的对等文件（大小写不敏感、可比去扩展名形式） */
export function isSameVoiceTarget(
  candidate: string,
  locale: string,
  scriptName: string,
  key: string,
): boolean {
  const norm = (value: string) =>
    dropExtension(value.trim().replace(/\\/g, '/')).toLowerCase()
  return norm(candidate) === norm(voiceTargetBase(locale, scriptName, key))
}

/** 解析结果：命中的资产 + 它是怎么被找到的 */
export type VoiceResolved<T> = {
  asset: T
  /** `target` = 就是对等文件（含换了扩展名的同名文件）；`name` = 音频根下同名兜底 */
  via: 'target' | 'name'
}

/**
 * 按「脚本路径 + 键名」解析配音资产。
 * 第一轮：对等位置（同目录、去扩展名同名）—— 优先 `.ogg`；
 * 第二轮：整个音频根下按「去后缀文件名」兜底（早期约定的缺省处理）。
 * 多命中时顺序稳定（ogg 优先，其次按路径排序）。
 */
export function resolveVoiceAssetFor<T extends { path: string }>(
  scriptName: string,
  key: string,
  locale: string,
  assets: readonly T[],
): VoiceResolved<T> | null {
  const normalizedKey = key.trim().toLowerCase()
  if (!normalizedKey) return null

  const inside = assets
    .filter((asset) => isUnderVoiceRoot(asset.path, locale))
    .slice()
    .sort(
      (a, b) =>
        Number(!isVoiceOggPath(a.path)) - Number(!isVoiceOggPath(b.path)) ||
        a.path.localeCompare(b.path),
    )
  if (inside.length === 0) return null

  const targetBase = voiceTargetBase(locale, scriptName, normalizedKey).toLowerCase()
  const exact = inside.filter(
    (asset) => dropExtension(asset.path).toLowerCase() === targetBase,
  )
  if (exact.length > 0) return { asset: exact[0], via: 'target' }

  const byName = inside.filter(
    (asset) => voiceStem(asset.path).toLowerCase() === normalizedKey,
  )
  if (byName.length > 0) return { asset: byName[0], via: 'name' }

  return null
}
