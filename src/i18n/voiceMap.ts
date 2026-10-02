import {
  DEFAULT_SOURCE_EXT,
  VOICE_ASSET_EXTENSION,
  VOICE_REF_EXTENSION,
  dropExtension,
  isUnderVoiceRoot,
  sourceDir,
  sourceFileStemName,
  voiceAssetPath,
  voiceRootDir,
} from './localeLayout'
import { isAudioAsset, normalizeAssetPath } from '../assets/paths'
import { BLANK_OGG_BYTES } from './voiceBytes'

export { dropExtension, VOICE_ASSET_EXTENSION, VOICE_REF_EXTENSION }

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

/**
 * 该键的**引用文件**路径（固定 `.ref`）：「引用资产」这种配音的写入目标。
 *
 * 与 `.ogg` 共用同一个对等基名 —— 一个键的对等位置上要么是音频、要么是引用，
 * 两个都在时 `.ogg` 优先（见 `resolveVoiceBindingFor`）。
 */
export function voiceKeyRefPath(
  locale: string,
  scriptName: string,
  key: string,
  ext: string = DEFAULT_SOURCE_EXT,
): string {
  return `${voiceAssetBase(locale, scriptName, key, ext)}.${VOICE_REF_EXTENSION}`
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

/** 是否是「引用资产」这种配音（对等位置上的 `.ref` 文本文件） */
export function isVoiceRefPath(path: string): boolean {
  return voiceAssetExtension(path) === VOICE_REF_EXTENSION
}

/**
 * 解析 `.ref` 的正文：取**第一个非空、非注释行**，按包内路径归一化。
 *
 * 内容就是一个路径（`assets/...`，也接受省略 `assets/` 前缀的写法），
 * 认不出来返回 null —— 调用方据此给出"引用读不出来"的原话，而不是编一句。
 */
export function parseVoiceRefContent(raw: string | null | undefined): string | null {
  if (!raw) return null
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim()
    if (!text || text.startsWith('#')) continue
    return normalizeAssetPath(text)
  }
  return null
}

/** `.ref` 的正文写法：一行路径（归一化后 + 换行） */
export function stringifyVoiceRefContent(targetPath: string): string {
  return `${normalizeAssetPath(targetPath) ?? targetPath.trim()}\n`
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
 * 一个键**当前绑定的配音**。
 *
 * - `file`：对等位置上的 `.ogg`（正常情况）
 * - `ref` ：对等位置上的 `.ref`（「引用资产」），音频在它引用的那份资产上
 *
 * `path` 是**绑定文件本身**（删除、改名都针对它），`audioPath` 才是拿去解码/播放的那份。
 * 引用解析不出来时 `audioPath` 为 null、`reason` 说明原因 —— 对应四态里的 `invalid`。
 */
export type VoiceBinding<A extends VoiceRefAssetLike> = {
  kind: 'file' | 'ref'
  /** 绑定文件路径（`.ogg` 或 `.ref`） */
  path: string
  /** 实际音频路径（引用时是目标资产）；解析不出来时 null */
  audioPath: string | null
  /** 对等位置上的那个资产 */
  asset: A
  /** 引用不可用的原因；`.ogg` 与可用的引用都是 null */
  reason: string | null
}

/** 解析引用要用到的资产字段（与 workspace 的 AssetFile 结构兼容） */
export type VoiceRefAssetLike = {
  path: string
  mime?: string
  /** `.ref` 正文解析出来的目标资产路径（加载 / 写入时填好，见 projectFs 与 voiceRef） */
  refTarget?: string | null
}

/** 引用目标能不能用；不能用时给出**原话原因**（界面直接显示它，不另编一句） */
function describeRefTarget<A extends VoiceRefAssetLike>(
  refPath: string,
  rawTarget: string | null,
  assets: readonly A[],
): { path: string | null; reason: string | null } {
  /*
   * 目标在这里**再归一化一次**：写入方（voiceMap 的 serialize、项目加载）本来就会归一化，
   * 但判定层不该依赖这一点 —— 元数据可能来自别处（旧工程、以后的新写入方），
   * 一个反斜杠或大小写就足以让"引用明明在"被判成"不在这个包里"。
   */
  const targetPath = rawTarget ? normalizeAssetPath(rawTarget) : null
  if (!targetPath) {
    return {
      path: null,
      reason: '引用文件里没有可用的路径（正文应为一行 assets/… 路径）',
    }
  }
  if (targetPath.toLowerCase() === refPath.trim().replace(/\\/g, '/').toLowerCase()) {
    return { path: null, reason: '引用指向自己' }
  }
  // 只认一层：引用音频是"省一份拷贝"，引用引用是"鬼打墙"
  if (isVoiceRefPath(targetPath)) {
    return { path: null, reason: '引用只能指向音频文件，不能指向另一个 .ref' }
  }
  const hit = assets.find(
    (asset) =>
      asset.path.trim().replace(/\\/g, '/').toLowerCase() === targetPath.toLowerCase(),
  )
  if (!hit) {
    return { path: null, reason: `引用指向的资产不在这个包里：${targetPath}` }
  }
  if (!isAudioAsset(hit.path, hit.mime)) {
    return { path: null, reason: `引用只能指向音频文件：${targetPath}` }
  }
  return { path: hit.path, reason: null }
}

/**
 * 按「脚本路径 + 键名」解析这个键当前绑定的配音。
 *
 * 只认**对等位置**（`assets/<locale>/voice_<ext>/<脚本目录>/<键名>`，基名比对、大小写不敏感）：
 * - `.ogg` **优先** —— 有真文件就不看引用；
 * - 没有 `.ogg` 时看 `.ref`（「引用资产」），并顺带判定它的目标能不能用；
 * - 两个都没有 → null（四态里的 `missing`）。
 *
 * 同基名命中多个时按路径排序，顺序稳定。
 */
export function resolveVoiceBindingFor<A extends VoiceRefAssetLike>(
  scriptName: string,
  key: string,
  locale: string,
  assets: readonly A[],
): VoiceBinding<A> | null {
  const normalizedKey = key.trim().toLowerCase()
  if (!normalizedKey) return null

  const targetBase = voiceAssetBase(locale, scriptName, normalizedKey).toLowerCase()
  const atPeer = assets
    .filter((asset) => isUnderVoiceRoot(asset.path, locale))
    .filter((asset) => dropExtension(asset.path).toLowerCase() === targetBase)
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
  if (atPeer.length === 0) return null

  const file = atPeer.find((asset) => isVoiceOggPath(asset.path))
  if (file) {
    return {
      kind: 'file',
      path: file.path,
      audioPath: file.path,
      asset: file,
      reason: null,
    }
  }

  const ref = atPeer.find((asset) => isVoiceRefPath(asset.path))
  if (!ref) return null

  const target = describeRefTarget(ref.path, ref.refTarget ?? null, assets)
  return {
    kind: 'ref',
    path: ref.path,
    audioPath: target.path,
    asset: ref,
    reason: target.reason,
  }
}

/**
 * 按「脚本路径 + 键名」解析配音**文件**（`.ogg`）—— 引用不算命中。
 *
 * 要回答"这个键现在实际用哪份音频"请用 `resolveVoiceBindingFor`；这个函数留给
 * 只关心"对等位置上有没有真文件"的调用方（例如 Agent 报告对等文件的存在性）。
 */
export function resolveVoiceAssetFor<A extends VoiceRefAssetLike>(
  scriptName: string,
  key: string,
  locale: string,
  assets: readonly A[],
): A | null {
  const binding = resolveVoiceBindingFor(scriptName, key, locale, assets)
  return binding?.kind === 'file' ? binding.asset : null
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
