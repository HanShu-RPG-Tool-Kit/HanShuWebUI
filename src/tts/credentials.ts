/**
 * 本地缓存 —— `auth` 里那些 `env:` / `app:` 引用在这里落成 API KEY 真值。
 *
 * **它不进工程。** 引用随工程走、真值留在本机,这是规范 §1 四层里"凭据"那一层的落地。
 *
 * 为什么非要有这一层:工程会给人、会上传、会备份,而 `.ttsservice` 会被
 * `projectPack` 原样带走、会被 Agent 读、会进 git 历史。**密钥一旦写进文本就收不回来**,
 * 而"把密钥写进文件"并不能省掉"填一份"这件事,只是把"自己填"换成"把这份复制过去"。
 *
 * 存储后端是**注入的**:默认 `localStorage`(与仓库既有的应用级设置一致),
 * 将来换成系统钥匙串只换一个实现 —— 引用语法、凭据体检、适配器都不用动。
 */

import { createAppStorage, stringEntries, type StorageLike } from './appStore'
import { CREDENTIAL_REF_RE } from './spec'

export type CredentialScheme = 'env' | 'app'

export type CredentialRef = {
  scheme: CredentialScheme
  name: string
}

/** 应用级凭据库在 `localStorage` 里的键（沿用 `hanshu.*` 命名） */
export const CREDENTIAL_STORAGE_KEY = 'hanshu.tts.credentials.v1'

/** 把 `env:NAME` / `app:NAME` 拆开；格式不对返回 null */
export function parseCredentialRef(ref: string): CredentialRef | null {
  const value = ref.trim()
  if (!CREDENTIAL_REF_RE.test(value)) return null
  const index = value.indexOf(':')
  return {
    scheme: value.slice(0, index) as CredentialScheme,
    name: value.slice(index + 1),
  }
}

// ===== 存储后端 =====

/**
 * 只认"名字 → 真值"的映射,**不知道引用长什么样**。
 * 引用与存储的这一层隔离,是将来能换钥匙串的原因。
 */
export type CredentialBackend = {
  get(name: string): string | null
  set(name: string, value: string): void
  remove(name: string): void
  names(): string[]
}

export function createMemoryBackend(seed: Record<string, string> = {}): CredentialBackend {
  const map = new Map<string, string>(Object.entries(seed))
  return {
    get: (name) => map.get(name) ?? null,
    set: (name, value) => {
      map.set(name, value)
    },
    remove: (name) => {
      map.delete(name)
    },
    names: () => [...map.keys()],
  }
}

/** 应用级存储。拿不到存储（隐私模式等）时由 `appStore` 统一退回内存 */
export function createLocalBackend(storage?: StorageLike): CredentialBackend {
  const store = createAppStorage(CREDENTIAL_STORAGE_KEY, storage)
  const read = (): Record<string, string> => stringEntries(store.read())

  return {
    get: (name) => read()[name] ?? null,
    set: (name, value) => {
      const map = read()
      map[name] = value
      store.write(map)
    },
    remove: (name) => {
      const map = read()
      delete map[name]
      store.write(map)
    },
    names: () => Object.keys(read()),
  }
}

/** 环境变量读取。浏览器里没有这个概念，所以默认一律取不到 */
export type EnvLookup = (name: string) => string | null

export const NO_ENV: EnvLookup = () => null

// ===== 解析引用 =====

export type CredentialResolver = {
  /** 引用 → 真值；解析不到返回 null */
  resolve(ref: string): string | null
  /**
   * 只回答"配没配",**不吐真值**。凭据体检用它 —— 免得密钥溜进 UI 状态或日志。
   */
  has(ref: string): boolean
}

export function createCredentialResolver(options: {
  backend: CredentialBackend
  /**
   * `env:` 走哪里。
   *
   * 浏览器与 Tauri 的 webview **都读不到进程环境变量**,所以默认是 `NO_ENV` ——
   * 也就是说桌面版里要用真实 `env:` 引用,得由 Rust 侧把它递过来。
   * 在那之前,想让密钥存在应用里就用 `app:`。
   */
  env?: EnvLookup
}): CredentialResolver {
  const { backend, env = NO_ENV } = options

  const resolve = (ref: string): string | null => {
    const parsed = parseCredentialRef(ref)
    if (!parsed) return null
    const value =
      parsed.scheme === 'env' ? env(parsed.name) : backend.get(parsed.name)
    return value && value.trim() ? value : null
  }

  return { resolve, has: (ref) => resolve(ref) !== null }
}

// ===== 凭据体检（规范 §10.3 第 5 条）=====

export type CredentialAudit = {
  /** 已配好 */
  present: string[]
  /** 本机缺的 —— 列出待填清单，不报错 */
  missing: string[]
  /** 格式就不是凭据引用的 */
  invalid: string[]
}

/**
 * 打开工程时比对"这个工程用到哪些引用 / 本机缺哪几个"。
 *
 * **缺凭据不是错误**(规范 §7.2):协作者打开工程时必然缺,那不是文件的问题。
 * 所以这里只分类,不判断对错。
 */
export function auditCredentials(
  refs: readonly string[],
  resolver: CredentialResolver,
): CredentialAudit {
  const audit: CredentialAudit = { present: [], missing: [], invalid: [] }
  const seen = new Set<string>()

  for (const ref of refs) {
    const value = ref.trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    if (!parseCredentialRef(value)) {
      audit.invalid.push(value)
      continue
    }
    if (resolver.has(value)) audit.present.push(value)
    else audit.missing.push(value)
  }

  return audit
}

/** 只留头尾，给界面显示"已配置"用 —— 诊断时看得出是哪个，又不会整串露出来 */
export function maskSecret(secret: string): string {
  const value = secret.trim()
  if (value.length <= 8) return '••••'
  return `${value.slice(0, 4)}••••${value.slice(-4)}`
}
