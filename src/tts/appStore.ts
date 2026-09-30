/**
 * 应用级存储的读写 —— 凭据库、克隆登记、用户预设都住在这里,沿用 `hanshu.*` 键命名。
 *
 * 抽出来只为一件事:**"拿不到存储"必须表现一致**。隐私模式、配额满、存储被策略禁用
 * 都会让 `localStorage` 抛异常,各处自己 try/catch 迟早会漏掉一处,于是"某块设置在
 * 隐私模式下崩掉、另一块静默失效"。这里统一:读失败当空表,写失败静默退回内存 ——
 * 本次会话仍然可用,重启即失,而不是把错误抛到界面上。
 *
 * 它**不判断内容**。解析与形状校验是调用方的事 —— 一条坏数据不该让整个列表打不开,
 * 但"什么算坏"由各自的模块决定。
 */

export type StorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** 拿不到 `localStorage` 时的兜底 —— 内存版,保证签名不变 */
const memoryFallback = new Map<string, string>()

function resolveStorage(storage?: StorageLike): StorageLike {
  if (storage) return storage
  if (typeof localStorage !== 'undefined') return localStorage
  return {
    getItem: (key) => memoryFallback.get(key) ?? null,
    setItem: (key, value) => {
      memoryFallback.set(key, value)
    },
  }
}

export type AppStorage = {
  /** 读整张表；坏数据 / 无数据都返回空对象 */
  read(): Record<string, unknown>
  /** 整表覆盖写；失败静默（见文件头说明） */
  write(value: Record<string, unknown>): void
}

export function createAppStorage(key: string, storage?: StorageLike): AppStorage {
  const store = resolveStorage(storage)

  return {
    read: () => {
      try {
        const raw = store.getItem(key)
        if (!raw) return {}
        const parsed: unknown = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
        return parsed as Record<string, unknown>
      } catch {
        return {}
      }
    },
    write: (value) => {
      try {
        store.setItem(key, JSON.stringify(value))
      } catch {
        /* 见文件头：静默退回内存，不把存储故障抛给界面 */
      }
    },
  }
}

/** 从整表里取一个对象值 —— 形状不对当没有 */
export function objectAt(
  table: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = table[key]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** 只保留字符串值，其余丢掉 —— 存储里的垃圾不该污染类型 */
export function stringEntries(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') out[key] = item
  }
  return out
}
