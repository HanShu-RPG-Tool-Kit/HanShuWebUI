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
export const TEXT_ASSET_EXTENSION = 'lang'

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
 * 去掉工程结构前缀，取「逻辑名」：`src/hanshu/xx.hs` → `xx.hs`。
 *
 * 本地化身份只看逻辑名 —— 源文件写在 `src/hanshu/` 还是裸写 `xx.hs` 都一样，于是
 * `hanshu/xx.hs` 与 `xx.hs` 都映射到 `assets/<locale>/lang_hs/xx.lang`。
 */
export function sourceLogicalPath(sourcePath: string): string {
  return normalizeSourcePath(sourcePath).replace(/^src\/(?:[^/]+\/)*/i, '')
}

/** 逐段清洗源路径：去掉空段、`.` 与 `..`（去后缀后按 `/` 切分） */
function sanitizedSourceParts(sourcePath: string): string[] {
  return dropExtension(sourceLogicalPath(sourcePath))
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part && part !== '.' && part !== '..')
}

/** 源文件的文件名（去后缀）：`folder/a/cp1.hs` → `cp1` */
export function sourceFileStemName(sourcePath: string): string {
  return sanitizedSourceParts(sourcePath).pop() ?? ''
}

/** 源文件所在目录（无首尾斜杠）：`folder/a/cp1.hs` → `folder/a`；`cp1.hs` → `''` */
export function sourceDir(sourcePath: string): string {
  return sanitizedSourceParts(sourcePath).slice(0, -1).join('/')
}

/** 源文件所属的语言文本根目录：`assets/<tag>/lang_<ext>` */
export function textRootDir(
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
export function textAssetPath(locale: string, sourcePath: string): string {
  const dir = sourceDir(sourcePath)
  const stem = sourceFileStemName(sourcePath) || '未命名'
  const ext = sourceExtension(sourcePath) || DEFAULT_SOURCE_EXT
  const root = textRootDir(locale, ext)
  const name = `${stem}.${TEXT_ASSET_EXTENSION}`
  return dir ? `${root}/${dir}/${name}` : `${root}/${name}`
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

/** 一条本地化产物路径拆开之后的样子 */
export type LocaleAssetPath = {
  /** 语言标签（原样，未规范化） */
  locale: string
  /** 产物类别 */
  kind: 'text' | 'voice'
  /** 根目录里标明的**源后缀**（小写）：`hs`、`char`… */
  sourceExt: string
  /** 根目录之后的相对路径：文本 `目录/cp1.lang`、音频 `目录/cp1/键名.ogg` */
  rest: string
}

const LOCALE_ASSET_RE = /^assets\/([^/]+)\/(lang|voice)_([a-z0-9]+)\/(.+)$/i

/**
 * 把一条资产路径**反解**成"哪个语言、哪种产物、哪个源后缀、根目录之后是什么"。
 *
 * 布局在这里只认一次（上面那几个函数负责拼，这里负责拆）。需要反解的地方 —— 目前是
 * 改名时连带搬迁 —— 拿结构化结果，而不是再写一遍 `lang_` / `voice_` 的字符串匹配：
 * 少写一处，就少一处"只比对了文件名、忘了比对后缀"的机会（那正是改名会把别的文件的
 * 产物一起搬走的原因）。
 */
export function parseLocaleAssetPath(path: string): LocaleAssetPath | null {
  const match = LOCALE_ASSET_RE.exec(normalizeSourcePath(path))
  if (!match) return null
  const [, locale, kind, sourceExt, rest] = match
  return {
    locale,
    kind: kind.toLowerCase() === 'lang' ? 'text' : 'voice',
    sourceExt: sourceExt.toLowerCase(),
    rest,
  }
}

/** 同一份产物换成一个新的源后缀之后的根目录：`assets/zh_cn/lang_hs` → `assets/zh_cn/lang_md` */
export function localeAssetRootWithExt(
  asset: LocaleAssetPath,
  ext: string,
): string {
  return asset.kind === 'text'
    ? textRootDir(asset.locale, ext)
    : voiceRootDir(asset.locale, ext)
}
