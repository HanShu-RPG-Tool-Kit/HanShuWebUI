import { DEFAULT_LOCALE_TAG, formatLocaleTag } from './locales'

/**
 * 本地化文件的**统一布局层**（按源文件后缀归类）。
 *
 * 一个源文件 `folder/cp1.<ext>` 的本地化产物：
 * - 文本：`assets/<locale>/lang_<ext>/folder/cp1.lang`
 * - 音频：`assets/<locale>/voice_<ext>/folder/cp1/<键名>.ogg`
 *
 * 例：
 * - `folder/cp1.hs`   → `assets/zh_cn/lang_hs/folder/cp1.lang`
 * - `main.char`       → `assets/zh_cn/lang_char/main.lang`
 *
 * 新增可本地化的后缀（`.char` / `.md` …）只需要继续调用这里的函数 —— **不要再写
 * 第二套路径拼装**：以前语音与语言文件各拼一套，改布局时两边必须同步改，很容易漏。
 *
 * 布局常量只有 `lang_` / `voice_` 两个前缀与 `.lang` / `.ogg` 两个目标后缀。
 */

/** 默认的源文件后缀：目前唯一可本地化的源类型是 `.hs` */
export const DEFAULT_SOURCE_EXT = 'hs'

/** 文本产物的后缀 */
export const LANG_ASSET_EXTENSION = 'lang'

/** 音频产物的后缀（是否单通道要解码后才知道） */
export const VOICE_ASSET_EXTENSION = 'ogg'

/** 规范化语言标签：认不出来时退回默认标签 */
export function localeTag(locale: string): string {
  return formatLocaleTag(locale) || DEFAULT_LOCALE_TAG
}

/** 去掉路径最后一段的后缀：`hello/cp1.hs` → `hello/cp1` */
export function dropExtension(path: string): string {
  return path.replace(/\.[^./\\]+$/, '')
}

/** 取小写后缀（不含点）；没有后缀返回空串 */
export function sourceExtension(path: string): string {
  const base = path.trim().replace(/\\/g, '/').split('/').pop() ?? ''
  return /\.([a-z0-9]+)$/i.exec(base)?.[1].toLowerCase() ?? ''
}

/** 源文件路径规范化：反斜杠转正斜杠、去掉 `./` 与首尾斜杠 */
export function normalizeSourcePath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
}

/**
 * 源文件在本地化目录下的相对基名（去后缀，逐段清洗）：
 * `hello/cp1.hs` → `hello/cp1`；`cp1.hs` → `cp1`。
 */
export function sourceStem(sourcePath: string): string {
  const stem = dropExtension(normalizeSourcePath(sourcePath))
  return stem
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/')
}

/** 源文件所属的语言文本根目录：`assets/<tag>/lang_<ext>` */
export function langRootDir(
  locale: string,
  ext: string = DEFAULT_SOURCE_EXT,
): string {
  return `assets/${localeTag(locale)}/lang_${ext}`
}

/** 源文件所属的音频根目录：`assets/<tag>/voice_<ext>` */
export function voiceRootDir(
  locale: string,
  ext: string = DEFAULT_SOURCE_EXT,
): string {
  return `assets/${localeTag(locale)}/voice_${ext}`
}

/**
 * 源文件的语言文本产物路径：
 * `folder/cp1.hs` → `assets/<tag>/lang_hs/folder/cp1.lang`。
 * `ext` 默认取源文件自己的后缀。
 */
export function langAssetPath(locale: string, sourcePath: string): string {
  const stem = sourceStem(sourcePath)
  const ext = sourceExtension(sourcePath) || DEFAULT_SOURCE_EXT
  const name = `${stem.split('/').pop() || '未命名'}.${LANG_ASSET_EXTENSION}`
  const dir = stem.split('/').slice(0, -1).join('/')
  const root = langRootDir(locale, ext)
  return dir ? `${root}/${dir}/${name}` : `${root}/${name}`
}

/** 音频根下某段相对目录（脚本目录）：`folder/cp1.hs` → `folder/cp1` */
export function voiceStemForSource(sourcePath: string): string {
  return sourceStem(sourcePath)
}

/** 某个键的音频产物路径：`assets/<tag>/voice_hs/<脚本目录>/<键名>.ogg` */
export function voiceAssetPath(
  locale: string,
  stem: string,
  ext: string = DEFAULT_SOURCE_EXT,
): string {
  return `${voiceRootDir(locale, ext)}/${stem.trim()}.${VOICE_ASSET_EXTENSION}`
}

/** 路径是否位于某个源后缀的音频根下（含子目录，大小写不敏感） */
export function isUnderVoiceRoot(
  path: string,
  locale: string,
  ext: string = DEFAULT_SOURCE_EXT,
): boolean {
  const root = `${voiceRootDir(locale, ext).toLowerCase()}/`
  return path.trim().replace(/\\/g, '/').toLowerCase().startsWith(root)
}
