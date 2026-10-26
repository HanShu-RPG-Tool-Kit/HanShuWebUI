import { useSyncExternalStore } from 'react'

/** 查看开关轮子。各工作区用自己的 storageKey 建一份，菜单勾选直接读 get()。 */
export type ViewFlagValue = boolean | number | string

type Listener = () => void

let menuCheckRevision = 0
const menuCheckListeners = new Set<Listener>()

/** 任意查看开关变化后通知菜单重画勾选。 */
export function notifyMenuChecks() {
  menuCheckRevision += 1
  for (const listener of menuCheckListeners) listener()
}

export function subscribeMenuChecks(listener: Listener) {
  menuCheckListeners.add(listener)
  return () => {
    menuCheckListeners.delete(listener)
  }
}

export function getMenuCheckRevision() {
  return menuCheckRevision
}

export function useViewFlags<T extends Record<string, ViewFlagValue>>(store: ViewFlagStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

export type ViewFlagStore<T extends Record<string, ViewFlagValue>> = {
  get(): T
  getSnapshot(): T
  set(patch: Partial<T>): void
  toggle(key: keyof T & string): void
  reset(): void
  subscribe(listener: Listener): () => void
}

export function assignViewFlag<T extends Record<string, ViewFlagValue>, K extends keyof T>(
  store: ViewFlagStore<T>,
  key: K,
  next: T[K] | ((current: T[K]) => T[K]),
): void {
  const current = store.get()[key]
  const value = typeof next === 'function' ? (next as (current: T[K]) => T[K])(current) : next
  store.set({ [key]: value } as unknown as Partial<T>)
}

export function createViewFlags<T extends Record<string, ViewFlagValue>>(
  storageKey: string,
  defaults: T,
  options?: {
    /** 只留在内存里，刷新后回到默认值。 */
    ephemeral?: readonly (keyof T)[]
    sanitize?: (value: T) => T
  },
): ViewFlagStore<T> {
  const ephemeral = new Set(options?.ephemeral ?? [])
  const sanitize = options?.sanitize ?? ((value: T) => value)
  let current = sanitize(readStored(storageKey, defaults, ephemeral))
  const listeners = new Set<Listener>()

  const persist = (value: T) => {
    const stored: Partial<T> = {}
    for (const key of Object.keys(defaults) as (keyof T)[]) {
      if (ephemeral.has(key)) continue
      stored[key] = value[key]
    }
    try {
      localStorage.setItem(storageKey, JSON.stringify(stored))
    } catch {
      /* 无痕模式只保留内存 */
    }
  }

  const commit = (next: T) => {
    current = sanitize(next)
    persist(current)
    for (const listener of listeners) listener()
    notifyMenuChecks()
  }

  return {
    get: () => current,
    getSnapshot: () => current,
    set(patch) {
      commit({ ...current, ...patch })
    },
    toggle(key) {
      const value = current[key]
      if (typeof value !== 'boolean') return
      commit({ ...current, [key]: !value })
    },
    reset() {
      try {
        localStorage.removeItem(storageKey)
      } catch {
        /* ignore */
      }
      commit({ ...defaults })
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

function readStored<T extends Record<string, ViewFlagValue>>(
  storageKey: string,
  defaults: T,
  ephemeral: ReadonlySet<keyof T>,
): T {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as Partial<T> | null
    if (!raw || typeof raw !== 'object') return { ...defaults }
    const next = { ...defaults }
    for (const key of Object.keys(defaults) as (keyof T)[]) {
      if (ephemeral.has(key)) continue
      const value = raw[key]
      if (typeof value === typeof defaults[key]) next[key] = value as T[keyof T]
    }
    return next
  } catch {
    return { ...defaults }
  }
}
