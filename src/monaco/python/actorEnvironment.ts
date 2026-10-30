import { actorContext } from './actorContext'

export type ActorHook = { id: string; cancellable: boolean }
export type ActorEnvironment = { schemaVersion: 1; runtimeId: string; revision: number; hooks: ActorHook[] }
export function readActorEnvironment(value: unknown): ActorEnvironment {
  const env = value as ActorEnvironment
  if (!env || env.schemaVersion !== 1 || typeof env.runtimeId !== 'string' || !Number.isSafeInteger(env.revision) || env.revision < 0 || !Array.isArray(env.hooks) || env.hooks.length > 10000 || env.hooks.some(h => !h || typeof h.id !== 'string' || !h.id.trim() || h.id.length > 128 || typeof h.cancellable !== 'boolean') || new Set(env.hooks.map(h => h.id)).size !== env.hooks.length) throw new Error('不兼容的演员 hook 注册表')
  return env
}

/** One ordered refresh stream per language worker; late replies cannot resurrect a disposed environment. */
export class ActorEnvironmentLoader {
  private queue: Promise<void> = Promise.resolve()
  private disposed = false
  private current?: ActorEnvironment
  hooks: readonly ActorHook[] = []
  private fetch: () => Promise<unknown>
  private publish: (source: string) => Promise<unknown>
  constructor(fetch: () => Promise<unknown>, publish: (source: string) => Promise<unknown>) { this.fetch = fetch; this.publish = publish }
  refresh() {
    this.queue = this.queue.catch(() => {}).then(async () => {
      if (this.disposed) return
      let env: ActorEnvironment
      try { env = readActorEnvironment(await this.fetch()) }
      catch (error) {
        if (!this.disposed) { this.hooks = []; this.current = undefined; await this.publish(actorContext()) }
        throw error
      }
      if (this.disposed) return
      if (this.current?.runtimeId === env.runtimeId && this.current.revision >= env.revision) return
      await this.publish(actorContext(env.hooks.map(h => h.id)))
      if (!this.disposed) { this.current = env; this.hooks = env.hooks }
    })
    return this.queue
  }
  dispose() { this.disposed = true; this.hooks = [] }
}
