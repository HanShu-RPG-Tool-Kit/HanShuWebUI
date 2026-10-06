export { textAssetPath } from './localeLayout'

/**
 * 语言文本映射（键名 → 本地化文本）。
 *
 * 设计要点：
 * - `.hs` 默认键名固定为 8 位小写十六进制（`keyStyle: 'hex'`）
 * - 进度等结构化文档可用语义键（`keyStyle: 'literal'`，如 `name` / `entry.title`）
 * - 产物路径由 `localeLayout` 统一给出：`assets/<语言标签>/lang_<后缀>/…`
 * - `TextMap` 是「抽象的语言文本映射实例」：内部持有内存缓存（权威），
 *   通过 `TextSink` 抽象出落盘方式（包内虚拟文件 / 真实磁盘 / 内存），
 *   写键时先写缓存再写穿 sink。
 */

/** 键名本体：8 位十六进制。下面两处正则共用它 —— 「是不是键」只有一个定义 */
const KEY_BODY = '[0-9a-f]{8}'

/** 键名（整串匹配） */
export const LOCALE_KEY_RE = new RegExp(`^${KEY_BODY}$`)

/**
 * 行内版本的键名形态：**不做锚定**，给语法着色用（Monarch 在行内逐个匹配）。
 * 与 `LOCALE_KEY_RE` 同一份 `KEY_BODY`，大小写不敏感。
 */
export const LOCALE_KEY_TEXT_RE = new RegExp(KEY_BODY, 'i')

/** 文本是否是键名（大小写不敏感，前后空白忽略） */
export function isLocaleKey(text: string): boolean {
  return LOCALE_KEY_RE.test(text.trim().toLowerCase())
}

/** 规范化键名（不是键名时返回空串） */
export function normalizeLocaleKey(text: string): string {
  const key = text.trim().toLowerCase()
  return LOCALE_KEY_RE.test(key) ? key : ''
}

/**
 * 文本哈希：FNV-1a 32 位 → 8 位小写十六进制（正好是键名长度）。
 * `round` 是冲突后的重试轮次（0 = 原文，1 = 原文 + 盐，……），因此**可复现**：
 * 同一段文本永远得到同一个键，冲突时也只按固定次序换下一个候选。
 */
export function hashLocaleKey(text: string, round = 0): string {
  const seed = round === 0 ? text : `${text}\u0000${round}`
  let hash = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * 由**文本**生成键名：先取文本哈希；若已占用则二次哈希、三次哈希……直到不冲突。
 * 与随机键的区别是确定性 —— 删掉键再解析一次，还会得到同一个键，
 * 因此「逆解析 → 再解析」不会把已有译文丢掉。
 */
export function createLocaleKeyFromText(
  text: string,
  taken: (key: string) => boolean,
): string {
  for (let round = 0; round < 4096; round++) {
    const key = hashLocaleKey(text, round)
    if (!taken(key)) return key
  }
  // 极端情况下线性兜底（同一个文本撞满 4096 轮基本不可能）
  for (let n = 0; n < 0x100000000; n++) {
    const key = (n >>> 0).toString(16).padStart(8, '0')
    if (!taken(key)) return key
  }
  return hashLocaleKey(text, 4096)
}

/**
 * 语言文本产物路径（布局统一走 `localeLayout`）：
 * `folder/cp1.hs` + `zh_cn` → `assets/zh_cn/lang_hs/folder/cp1.lang`。
 * 后缀决定子目录：`main.char` → `assets/zh_cn/lang_char/main.lang`。
 */
/** 是否形如 `assets/<locale>/lang_<ext>/…/名.lang` */
export const TEXT_FILE_RE = /^assets\/[^/]+\/lang_[a-z0-9]+\/.+\.lang$/i

export function isTextAssetName(name: string): boolean {
  return TEXT_FILE_RE.test(name.trim())
}

export type TextFile = Record<string, string>

/** 语言文本资产在 IndexedDB 里的 MIME（内容固定是 JSON） */
export const TEXT_ASSET_MIME = 'application/json'

/** 解析 lang 文件；非法 JSON / 非对象返回空表，非字符串值丢弃 */
export function parseTextFile(text: string | null | undefined): TextFile {
  if (!text) return {}
  try {
    const data = JSON.parse(text) as unknown
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
    const out: TextFile = {}
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

/** 序列化：键名排序 + 两空格缩进 + 末尾换行 */
export function stringifyTextFile(data: TextFile): string {
  const keys = Object.keys(data).sort((a, b) => a.localeCompare(b))
  const ordered: TextFile = {}
  for (const key of keys) ordered[key] = data[key]
  return `${JSON.stringify(ordered, null, 2)}\n`
}

/**
 * 落盘抽象：读得到就返回文本，写穿整份文本。
 * 实现可以是包内虚拟文件、真实磁盘文件、或纯内存。
 */
export type TextSink = {
  read(): string | null
  write(content: string): void
}

/** 键规范化策略：剧本 hex / 进度等语义字面键 */
export type TextKeyStyle = 'hex' | 'literal'

export type TextMapOptions = {
  /** 对应的 `assets/<locale>/lang_<ext>/….lang` */
  fileName: string
  locale: string
  sink: TextSink
  /** 默认 `hex`（`.hs`）；进度文档用 `literal` */
  keyStyle?: TextKeyStyle
}

/** 按策略规范化键；非法时返回空串 */
export function normalizeTextMapKey(
  text: string,
  style: TextKeyStyle = 'hex',
): string {
  if (style === 'literal') {
    const key = text.trim()
    return key ? key : ''
  }
  return normalizeLocaleKey(text)
}

/** 内存 + 写穿的抽象语言文本映射实例 */
export class TextMap {
  readonly fileName: string
  readonly locale: string
  readonly keyStyle: TextKeyStyle

  private readonly sink: TextSink
  private readonly cache = new Map<string, string>()
  private readonly listeners = new Set<() => void>()
  private loaded = false

  constructor(options: TextMapOptions) {
    this.fileName = options.fileName
    this.locale = options.locale
    this.keyStyle = options.keyStyle ?? 'hex'
    this.sink = options.sink
  }

  private normalize(key: string): string {
    return normalizeTextMapKey(key, this.keyStyle)
  }

  /** 已是否从 sink 读过（用于状态展示） */
  get isLoaded(): boolean {
    return this.loaded
  }

  get size(): number {
    return this.cache.size
  }

  /** 从 sink 读取并灌入缓存；文件不存在时缓存为空 Map */
  load(): void {
    this.loaded = true
    this.replaceAll(parseTextFile(this.sink.read()))
  }

  /** 用已知内容替换缓存（例如已从磁盘读到） */
  replaceAll(data: TextFile): void {
    this.cache.clear()
    for (const [key, value] of Object.entries(data)) this.cache.set(key, value)
    this.emit()
  }

  has(key: string): boolean {
    const k = this.normalize(key)
    return Boolean(k) && this.cache.has(k)
  }

  /** 读取某个键；不存在返回 null */
  get(key: string): string | null {
    const k = this.normalize(key)
    return k ? this.cache.get(k) ?? null : null
  }

  entries(): Array<[string, string]> {
    return [...this.cache.entries()]
  }

  snapshot(): TextFile {
    return Object.fromEntries(this.cache)
  }

  toFileContent(): string {
    return stringifyTextFile(this.snapshot())
  }

  /** 写一个键：先写缓存，再写穿 sink */
  set(key: string, value: string): void {
    const k = this.normalize(key)
    if (!k) return
    this.cache.set(k, value)
    this.emit()
    this.flush()
  }

  /** 批量写（迁移时用，只落盘一次） */
  setMany(pairs: Array<[string, string]>): void {
    let changed = false
    for (const [key, value] of pairs) {
      const k = this.normalize(key)
      if (!k) continue
      this.cache.set(k, value)
      changed = true
    }
    if (!changed) return
    this.emit()
    this.flush()
  }

  /** 仅写入尚不存在的键（创建/迁移灌默认语时用） */
  setMissing(pairs: Array<[string, string]>): void {
    const next = pairs.filter(([key]) => {
      const k = this.normalize(key)
      return Boolean(k) && !this.cache.has(k)
    })
    if (!next.length) return
    this.setMany(next)
  }

  /** 改键名（节点 ID 重命名时搬译文） */
  renameKey(from: string, to: string): void {
    const src = this.normalize(from)
    const dest = this.normalize(to)
    if (!src || !dest || src === dest || !this.cache.has(src)) return
    if (this.cache.has(dest)) return
    const value = this.cache.get(src)!
    this.cache.delete(src)
    this.cache.set(dest, value)
    this.emit()
    this.flush()
  }

  delete(key: string): void {
    const k = this.normalize(key)
    if (!k || !this.cache.delete(k)) return
    this.emit()
    this.flush()
  }

  /** 批量删（撤销自动成键时回收条目用，只落盘一次） */
  deleteMany(keys: Iterable<string>): void {
    let changed = false
    for (const key of keys) {
      const k = this.normalize(key)
      if (!k) continue
      if (this.cache.delete(k)) changed = true
    }
    if (!changed) return
    this.emit()
    this.flush()
  }

  /** 强制把缓存写穿一次 */
  flush(): void {
    this.sink.write(this.toFileContent())
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
