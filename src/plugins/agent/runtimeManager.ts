/**
 * 项目级 Agent 运行时（PR2）。
 *
 * Agent 是「项目 + 窗口」级：工作区切换、面板开关都不重建运行时；
 * 只有「工程绑定/切换/关闭」才创建或销毁运行时——由平台的
 * `subscribeProjectHost()` 驱动，而不是由插件激活或面板挂载驱动。
 *
 * 宿主通过平台 `getProjectHost()` 读取当前工程文本，插件不接触任何工作区实现。
 */
import { createAgentRuntime } from './core/pi/facade'
import type { AgentRuntime, AgentRuntimeView } from './core/contracts'
import { claimWindowId } from './core/store/windowId'
import { getAgentApiKey, getAgentModelId } from './core/config'
import { getProjectHost, getProjectSession, subscribeProjectHost } from '../../platform'
import { createAgentHost } from './host/agentHost'

type RuntimeListener = (runtime: AgentRuntime | null, view: AgentRuntimeView | null) => void
type StartupListener = (error: string | null) => void

let runtime: AgentRuntime | null = null
let view: AgentRuntimeView | null = null
let opening: Promise<AgentRuntime | null> | null = null
let scope: string | null = null
let unsubscribeView: (() => void) | null = null
let unsubscribeSaved: (() => void) | null = null
let unsubscribeHost: (() => void) | null = null
let disposed = false
let startupError: string | null = null
let syncQueued = false

const listeners = new Set<RuntimeListener>()
const startupListeners = new Set<StartupListener>()

function emit(): void {
  for (const listener of listeners) listener(runtime, view)
}

function publish(next: AgentRuntimeView): void {
  view = next
  // 锁是运行时事实：把锁定路径推给当前工作区，由它负责只读渲染。
  getProjectHost()?.setReadOnlyPaths?.(next.lockedPaths)
  getProjectHost()?.setRunActive?.(next.runState === 'running')
  emit()
}

function setStartupError(next: string | null): void {
  if (startupError === next) return
  startupError = next
  for (const listener of startupListeners) listener(next)
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 是否已打开工程：没有工程绑定时不启动 Agent（缓存工作区只算临时宿主）。 */
function hasBoundProject(): boolean {
  return Boolean(getProjectSession().binding)
}

function canStart(): boolean {
  return !disposed && Boolean(getProjectHost()) && hasBoundProject()
}

async function create(): Promise<AgentRuntime | null> {
  const host = getProjectHost()
  if (!host) return null
  const nextScope = host.scope
  const windowId = await claimWindowId()
  const next = createAgentRuntime({
    scope: nextScope,
    windowId,
    host: createAgentHost({ locale: host.getLocale() }),
    apiKey: getAgentApiKey(),
    model: getAgentModelId(),
    canStartRun: () => !getProjectHost()?.isSaveBusy?.(),
  })
  await next.open()
  // 打开期间工程可能已被关闭/切换：不要把一个过期运行时挂上去。
  if (disposed || !hasBoundProject() || getProjectHost()?.scope !== nextScope) {
    await next.close()
    return null
  }
  runtime = next
  scope = nextScope
  unsubscribeView = next.subscribe(publish)
  // 保存后归档所有活跃段（保存 = 封段 + 放弃回滚）；由插件订阅，不依赖工作区。
  unsubscribeSaved = getProjectHost()?.onSaved(() => {
    void next.archive().catch((error) => {
      console.warn('[hanshu] Agent 存档失败', error)
    })
  }) ?? null
  view = next.view()
  // 工作区切换时重新把锁与运行态推给新的当前工作区（锁是项目级事实）。
  unsubscribeHost = host.subscribe(() => {
    if (!view) return
    getProjectHost()?.setReadOnlyPaths?.(view.lockedPaths)
    getProjectHost()?.setRunActive?.(view.runState === 'running')
  })
  getProjectHost()?.setReadOnlyPaths?.(view.lockedPaths)
  getProjectHost()?.setRunActive?.(view.runState === 'running')
  emit()
  return next
}

/**
 * 打开/复用当前工程的运行时。
 *
 * - 没有注册工程文件通道、或还没有绑定工程时返回 null（面板显示「请先打开工程」）；
 * - 创建失败会记录 `startupError` 并返回 null（面板显示错误与重试）；
 * - 并发调用共享同一个 opening promise。
 */
export async function ensureAgentRuntime(): Promise<AgentRuntime | null> {
  if (!canStart()) return null
  const host = getProjectHost()
  if (!host) return null
  if (runtime && scope === host.scope) return runtime
  if (runtime) await closeAgentRuntime()
  if (!opening) {
    opening = create()
      .then((next) => {
        if (next) setStartupError(null)
        return next
      })
      .catch((error: unknown) => {
        setStartupError(formatError(error))
        console.warn('[hanshu] Agent 运行时启动失败', error)
        return null
      })
      .finally(() => {
        opening = null
      })
  }
  return opening
}

export function getAgentRuntime(): AgentRuntime | null {
  return runtime
}

/** 订阅运行时与视图；`view === null` 表示还没有运行时。 */
export function subscribeAgentRuntime(listener: RuntimeListener): () => void {
  listeners.add(listener)
  listener(runtime, view)
  return () => {
    listeners.delete(listener)
  }
}

/** 订阅启动错误（真失败：数据库/运行时创建异常）；首次订阅立即回调当前值。 */
export function subscribeAgentStartup(listener: StartupListener): () => void {
  startupListeners.add(listener)
  listener(startupError)
  return () => {
    startupListeners.delete(listener)
  }
}

export function getAgentStartupError(): string | null {
  return startupError
}

/** 关闭运行时（工程关闭/切换）；工程重新绑定后由宿主订阅自动重建。 */
export async function closeAgentRuntime(): Promise<void> {
  const current = runtime
  runtime = null
  view = null
  scope = null
  setStartupError(null)
  unsubscribeView?.()
  unsubscribeView = null
  unsubscribeSaved?.()
  unsubscribeSaved = null
  unsubscribeHost?.()
  unsubscribeHost = null
  getProjectHost()?.setReadOnlyPaths?.([])
  getProjectHost()?.setRunActive?.(false)
  emit()
  if (current) await current.close()
}

export async function disposeAgentRuntime(): Promise<void> {
  disposed = true
  await closeAgentRuntime()
}

/** Key 配置变化后重建运行时（新配置在下次创建时读取）。 */
export async function restartAgentRuntime(): Promise<AgentRuntime | null> {
  await closeAgentRuntime()
  return ensureAgentRuntime()
}

/**
 * 让运行时跟随「当前工程宿主」：宿主出现后创建，工程关闭后销毁，工程切换后
 * 以新 scope 重建。启动早期缓存工作区没有绑定工程时不会创建运行时。
 */
async function syncWithHost(): Promise<void> {
  if (disposed) return
  const host = getProjectHost()
  if (!host || !hasBoundProject()) {
    if (runtime) await closeAgentRuntime()
    return
  }
  if (runtime && scope === host.scope) return
  if (runtime) await closeAgentRuntime()
  await ensureAgentRuntime()
}

function scheduleHostSync(): void {
  if (disposed || syncQueued) return
  syncQueued = true
  queueMicrotask(() => {
    syncQueued = false
    void syncWithHost()
  })
}

subscribeProjectHost(scheduleHostSync)
