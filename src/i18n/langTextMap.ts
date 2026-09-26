import { DEFAULT_LOCALE_TAG, formatLocaleTag } from './locales'

/**
 * 语言文本映射（键名 → 本地化文本）。
 *
 * 设计要点：
 * - 键名固定为 8 位小写十六进制
 * - `<文件名>.lang.<语言标签>`：`cp1.hs` + `zh_cn` → `cp1.lang.zh_cn`
 * - `LangTextMap` 是「抽象的语言文本映射实例」：内部持有内存缓存（权威），
 *   通过 `LangTextSink` 抽象出落盘方式（包内虚拟文件 / 真实磁盘 / 内存），
 *   写键时先写缓存再写穿 sink。
 */

/** 键名：8 位十六进制 */
export const LOCALE_KEY_RE = /^[0-9a-f]{8}$/

/** 文本是否是键名（大小写不敏感，前后空白忽略） */
export function isLocaleKey(text: string): boolean {
  return LOCALE_KEY_RE.test(text.trim().toLowerCase())
}

/** 规范化键名（不是键名时返回空串） */
export function normalizeLocaleKey(text: string): string {
  const key = text.trim().toLowerCase()
  return LOCALE_KEY_RE.test(key) ? key : ''
}

/** 随机 8 位十六进制（crypto 优先，退化到 Math.random） */
function randomKey(): string {
  const c = globalThis.crypto
  if (c && typeof c.getRandomValues === 'function') {
    const buf = new Uint32Array(1)
    c.getRandomValues(buf)
    return buf[0].toString(16).padStart(8, '0')
  }
  return Math.floor(Math.random() * 0x100000000)
    .toString(16)
    .padStart(8, '0')
}

/** 生成不与 `taken` 冲突的键名 */
export function createLocaleKey(taken: (key: string) => boolean): string {
  for (let i = 0; i < 4096; i++) {
    const key = randomKey()
    if (!taken(key)) return key
  }
  // 极端情况下线性兜底
  for (let n = 0; n < 0x100000000; n++) {
    const key = (n >>> 0).toString(16).padStart(8, '0')
    if (!taken(key)) return key
  }
  return randomKey()
}

/** `cp1.hs` + `zh_cn` → `cp1.lang.zh_cn`（去掉最后一个后缀再加） */
export function langFileNameFor(scriptName: string, locale: string): string {
  const base = scriptName.trim().replace(/\.[^.\\/]+$/, '')
  const tag = formatLocaleTag(locale) || DEFAULT_LOCALE_TAG
  return `${base || '未命名'}.lang.${tag}`
}

/** 是否形如 `*.lang.<locale>` */
export const LANG_FILE_RE = /\.lang\.[a-z0-9_]+$/i

export function isLangTextFileName(name: string): boolean {
  return LANG_FILE_RE.test(name.trim())
}

export type LangTextFile = Record<string, string>

/** 解析 lang 文件；非法 JSON / 非对象返回空表，非字符串值丢弃 */
export function parseLangFile(text: string | null | undefined): LangTextFile {
  if (!text) return {}
  try {
    const data = JSON.parse(text) as unknown
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
    const out: LangTextFile = {}
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

/** 序列化：键名排序 + 两空格缩进 + 末尾换行 */
export function stringifyLangFile(data: LangTextFile): string {
  const keys = Object.keys(data).sort((a, b) => a.localeCompare(b))
  const ordered: LangTextFile = {}
  for (const key of keys) ordered[key] = data[key]
  return `${JSON.stringify(ordered, null, 2)}\n`
}

/**
 * 落盘抽象：读得到就返回文本，写穿整份文本。
 * 实现可以是包内虚拟文件、真实磁盘文件、或纯内存。
 */
export type LangTextSink = {
  read(): string | null
  write(content: string): void
}

export type LangTextMapOptions = {
  /** 对应的 `<文件名>.lang.<语言标签>` */
  fileName: string
  locale: string
  sink: LangTextSink
}

/** 内存 + 写穿的抽象语言文本映射实例 */
export class LangTextMap {
  readonly fileName: string
  readonly locale: string

  private readonly sink: LangTextSink
  private readonly cache = new Map<string, string>()
  private readonly listeners = new Set<() => void>()
  private loaded = false

  constructor(options: LangTextMapOptions) {
    this.fileName = options.fileName
    this.locale = options.locale
    this.sink = options.sink
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
    this.replaceAll(parseLangFile(this.sink.read()))
  }

  /** 用已知内容替换缓存（例如已从磁盘读到） */
  replaceAll(data: LangTextFile): void {
    this.cache.clear()
    for (const [key, value] of Object.entries(data)) this.cache.set(key, value)
    this.emit()
  }

  has(key: string): boolean {
    return this.cache.has(normalizeLocaleKey(key))
  }

  /** 读取某个键；不存在返回 null */
  get(key: string): string | null {
    const k = normalizeLocaleKey(key)
    return this.cache.get(k) ?? null
  }

  entries(): Array<[string, string]> {
    return [...this.cache.entries()]
  }

  snapshot(): LangTextFile {
    return Object.fromEntries(this.cache)
  }

  toFileContent(): string {
    return stringifyLangFile(this.snapshot())
  }

  /** 写一个键：先写缓存，再写穿 sink */
  set(key: string, value: string): void {
    const k = normalizeLocaleKey(key)
    if (!k) return
    this.cache.set(k, value)
    this.emit()
    this.flush()
  }

  /** 批量写（迁移时用，只落盘一次） */
  setMany(pairs: Array<[string, string]>): void {
    let changed = false
    for (const [key, value] of pairs) {
      const k = normalizeLocaleKey(key)
      if (!k) continue
      this.cache.set(k, value)
      changed = true
    }
    if (!changed) return
    this.emit()
    this.flush()
  }

  delete(key: string): void {
    const k = normalizeLocaleKey(key)
    if (!k || !this.cache.delete(k)) return
    this.emit()
    this.flush()
  }

  /** 批量删（撤销自动成键时回收条目用，只落盘一次） */
  deleteMany(keys: Iterable<string>): void {
    let changed = false
    for (const key of keys) {
      const k = normalizeLocaleKey(key)
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
