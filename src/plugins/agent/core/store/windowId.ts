/**
 * windowId 与窗口认领（文档 §9「windowId 与窗口认领」）。
 *
 * windowId 存在 sessionStorage 里，因此**跨刷新稳定**；刷新后仍用同一个 id 打开同一个活跃段库。
 * 标签页复制会把 sessionStorage 一起复制过去 —— 认领用的 Web Lock 抢不到，就说明这是复制出来的
 * 新窗口，换一个 UUID 并开新空库，原窗口的段不受影响。
 *
 * 这不是「共享单库的 owner 协调」（那种协调已被每窗口一库的结构消除），
 * 只是**标签页复制的去重**（§9）。所以抢不到锁时的动作永远是「换新 id」，而不是等待。
 *
 * 浏览器 API 全部可注入，Node 下可用假 storage / 假 locks 测试。
 */

const WINDOW_ID_KEY = 'hanshu.agent.windowId'
/** Web Locks 不允许挂自定义持有者数据，用 query() 给出的 clientId 当「自己」的指纹 */
const OWNER_TOKEN_KEY = 'hanshu.agent.windowId.owner'
const LOCK_PREFIX = 'agent-window:'

export type WindowIdEnv = {
  /** 默认 window.sessionStorage */
  storage?: Storage
  /** 默认 navigator.locks */
  locks?: Navigator['locks']
}

/**
 * 同一 document 内重复认领（React StrictMode 双调用、Harness 重开）直接复用，
 * 否则第二次 ifAvailable 会抢不到自己手里的锁，把自己误判成复制标签页。
 */
const claimed = new WeakMap<object, string>()

/**
 * 认领本窗口的 windowId。规则（§9）：
 * 1. sessionStorage 有 id 且能抢到它的 Web Lock → 沿用；
 * 2. 抢不到 → 生成新 UUID、写入 sessionStorage、再抢新 id 的锁；
 * 3. 没有 Web Locks（旧浏览器 / 非安全上下文）→ 退化为单标签页策略，沿用 sessionStorage 里的 id。
 */
export async function claimWindowId(env: WindowIdEnv = {}): Promise<string> {
  const storage = env.storage ?? browserStorage()
  const locks = env.locks ?? browserLocks()
  const cacheKey: object | null = storage ?? locks ?? null
  const cached = cacheKey === null ? undefined : claimed.get(cacheKey)
  if (cached !== undefined) return cached

  const saved = readSavedId(storage)
  if (saved !== null) {
    if (await holdLock(locks, saved, storage)) return remember(cacheKey, saved)
    // 锁已在别的 document 手里；若持有者 clientId 就是本 document（模块重载 / 重复 init），
    // 仍然沿用。复制标签页拿到的 clientId 不同，会落到下面的新 UUID 分支。
    if (await heldByThisDocument(locks, saved, storage)) return remember(cacheKey, saved)
  }

  const fresh = randomUuid()
  await holdLock(locks, fresh, storage)
  writeSavedId(storage, fresh)
  return remember(cacheKey, fresh)
}

/**
 * 用 `ifAvailable` 抢锁；抢到后**一直持有到页面卸载**（回调返回的 promise 不主动 settle），
 * 这样复制出来的标签页在整个会话期间都抢不到同一个 id。拿不到立即返回 false，不排队等待。
 */
function holdLock(
  locks: LockManager | undefined,
  windowId: string,
  storage: Storage | undefined,
): Promise<boolean> {
  const name = lockName(windowId)
  const manager = locks
  if (manager === undefined || typeof manager.request !== 'function') return Promise.resolve(true)

  return new Promise<boolean>(resolve => {
    const request = manager.request(name, { ifAvailable: true }, async lock => {
      if (lock === null) {
        resolve(false)
        return
      }
      resolve(true)
      void rememberOwner(manager, name, storage)
      // 永不 resolve：锁的生命周期跟着 document 走（§9 只做复制去重，不做跨窗口协调）
      await new Promise<void>(() => {})
    })
    // 权限策略 / 环境不支持时 request 会 reject；按「没有 Web Locks」降级，不阻塞启动
    request.then(undefined, () => resolve(false))
  })
}

/** 判断某个 id 的锁是否正被本 document 持有（靠上一次写进 sessionStorage 的 clientId） */
async function heldByThisDocument(
  locks: LockManager | undefined,
  windowId: string,
  storage: Storage | undefined,
): Promise<boolean> {
  if (locks === undefined || typeof locks.query !== 'function' || storage === undefined) return false
  const token = storage.getItem(OWNER_TOKEN_KEY)
  if (!token) return false
  try {
    const snapshot = await locks.query()
    const held = snapshot.held ?? []
    return held.some(entry => entry.name === lockName(windowId) && entry.clientId === token)
  } catch {
    return false
  }
}

/** 抢到锁之后把本 document 的 clientId 记下来，供 `heldByThisDocument` 识别「自己」 */
async function rememberOwner(
  locks: LockManager,
  name: string,
  storage: Storage | undefined,
): Promise<void> {
  if (storage === undefined || typeof locks.query !== 'function') return
  try {
    const snapshot = await locks.query()
    const own = (snapshot.held ?? []).find(entry => entry.name === name)
    if (own !== undefined && own.clientId) storage.setItem(OWNER_TOKEN_KEY, own.clientId)
  } catch {
    // 查询不可用：同 document 复用由 claimed 缓存兜底，不影响正确性
  }
}

function remember(cacheKey: object | null, windowId: string): string {
  if (cacheKey !== null) claimed.set(cacheKey, windowId)
  return windowId
}

function readSavedId(storage: Storage | undefined): string | null {
  if (storage === undefined) return null
  const saved = storage.getItem(WINDOW_ID_KEY)?.trim()
  return saved ? saved : null
}

function writeSavedId(storage: Storage | undefined, windowId: string): void {
  if (storage === undefined) return
  storage.setItem(WINDOW_ID_KEY, windowId)
}

function lockName(windowId: string): string {
  return `${LOCK_PREFIX}${windowId}`
}

function randomUuid(): string {
  return globalThis.crypto.randomUUID()
}

function browserStorage(): Storage | undefined {
  try {
    // 隐私模式下访问 sessionStorage 会抛，此时退化为「不持久化 windowId」（每次认领新 id）
    return typeof window === 'undefined' ? undefined : window.sessionStorage
  } catch {
    return undefined
  }
}

function browserLocks(): LockManager | undefined {
  if (typeof navigator === 'undefined') return undefined
  return navigator.locks
}
