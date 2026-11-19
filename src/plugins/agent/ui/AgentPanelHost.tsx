/**
 * Shell → Agent 插件的面板外壳（PR2）。
 *
 * 面板由 plugin loader 贡献给工作区；运行时是项目级单例，由 `runtimeManager` 管理，
 * 工作区只通过 SDK 的 `PanelHostProps` 传停靠信息，不接触 agent 内部。
 */
import { useCallback, useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { AgentRuntime, AgentRuntimeView } from '../core/contracts'
import type { PanelHostProps } from '../../../plugin-sdk'
import { getProjectSession } from '../../../platform'
import { AgentPanel } from './AgentPanel'
import {
  ensureAgentRuntime,
  getAgentStartupError,
  restartAgentRuntime,
  subscribeAgentRuntime,
  subscribeAgentStartup,
} from '../runtimeManager'

export type AgentPanelHostProps = PanelHostProps & {
  /** 选区等展示上下文（可选，由工作区传入） */
  contextLabel?: string
  /** Run 活跃状态变化：外壳用它禁用保存 */
  onRunningChange?: (running: boolean) => void
}

const STARTUP_TIMEOUT_MS = 8000

export function AgentPanelHost({
  open,
  onClose,
  contextLabel,
  onRunningChange,
  style,
  placement,
  onTitlePointerDown,
  onRedock,
}: AgentPanelHostProps) {
  const [runtime, setRuntime] = useState<AgentRuntime | null>(null)
  const [view, setView] = useState<AgentRuntimeView | null>(null)
  const [startupError, setStartupError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const unsubscribeRuntime = subscribeAgentRuntime((next, nextView) => {
      setRuntime(next)
      setView(nextView)
      if (next) setStartupError(null)
    })
    const unsubscribeError = subscribeAgentStartup((error) => {
      setStartupError(error)
    })
    return () => {
      unsubscribeRuntime()
      unsubscribeError()
    }
  }, [])

  const retry = useCallback(() => {
    setStartupError(null)
    setAttempt((value) => value + 1)
  }, [])

  // 运行时生命周期由 runtimeManager 跟随工程绑定；这里只负责「打开时确保可用」，
  // 并在没有工程 / 启动失败 / 超时时给用户可操作的提示（而不是永远“正在启动…”）。
  useEffect(() => {
    if (!open) return
    let cancelled = false
    if (!getProjectSession().binding) {
      setStartupError('请先在工程目录中打开或新建工程，再使用 Agent。')
      return
    }
    setStartupError(null)
    void ensureAgentRuntime().then((next) => {
      if (cancelled || next) return
      setStartupError((current) => current ?? getAgentStartupError() ?? '未能启动 Agent 运行时，请重试。')
    })
    return () => {
      cancelled = true
    }
  }, [open, attempt])

  useEffect(() => {
    if (!open || runtime || startupError) return
    const timer = window.setTimeout(() => {
      setStartupError((current) => current ?? '启动超时，请重试。')
    }, STARTUP_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [open, runtime, startupError, attempt])

  const running = view?.runState === 'running'

  useEffect(() => {
    onRunningChange?.(running)
  }, [onRunningChange, running])

  return (
    <AgentPanel
      open={open}
      runtime={runtime}
      onClose={onClose}
      saveBlockedByRun={running}
      contextLabel={contextLabel}
      style={style}
      placement={placement}
      onTitlePointerDown={onTitlePointerDown as ((event: ReactPointerEvent<HTMLElement>) => void) | undefined}
      onRedock={onRedock}
      startupError={startupError}
      onRetryStart={retry}
      onConfigChanged={() => {
        void restartAgentRuntime()
      }}
    />
  )
}
