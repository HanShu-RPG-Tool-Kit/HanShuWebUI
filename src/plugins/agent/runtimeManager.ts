/**
 * 项目级 Agent 运行时（PR2）。
 *
 * Agent 是「项目 + 窗口」级：工作区切换、面板开关都不重建运行时；
 * 只有工程会话变化（打开/关闭工程、切到另一个工程）才销毁重建。
 * 宿主通过平台 `getProjectHost()` 读取当前工程文本，插件不接触任何工作区实现。
 */
import { createAgentRuntime } from './core/pi/facade'
import type { AgentRuntime, AgentRuntimeView } from './core/contracts'
import { claimWindowId } from './core/store/windowId'
import { getAgentApiKey, getAgentModelId } from './core/config'
import { getProjectHost, subscribeProjectSession } from '../../platform'
import { createAgentHost } from './host/agentHost'

type RuntimeListener = (runtime: AgentRuntime | null, view: AgentRuntimeView | null) => void

let runtime: AgentRuntime | null = null
let view: AgentRuntimeView | null = null
let opening: Promise<AgentRuntime | null> | null = null
let scope: string | null = null
let unsubscribeView: (() => void) | null = null
let unsubscribeSaved: (() => void) | null = null
let unsubscribeHost: (() => void) | null = null
let disposed = false

const listeners = new Set<RuntimeListener>()

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
  if (disposed) {
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

/** 打开/复用当前工程的运行时；没有注册工程文件通道时返回 null。 */
export async function ensureAgentRuntime(): Promise<AgentRuntime | null> {
  if (disposed) return null
  const host = getProjectHost()
  if (!host) return null
  if (runtime && scope === host.scope) return runtime
  if (runtime && scope !== host.scope) {
    await closeAgentRuntime()
  }
  if (!opening) {
    opening = create().finally(() => {
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

/** 关闭运行时（工程会话变化 / 应用退出）；面板再次打开时会重新创建。 */
export async function closeAgentRuntime(): Promise<void> {
  const current = runtime
  runtime = null
  view = null
  scope = null
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

subscribeProjectSession(() => {
  if (!runtime) return
  void closeAgentRuntime()
})
