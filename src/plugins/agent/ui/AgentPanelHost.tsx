/**
 * Shell → Agent 插件的面板外壳（PR2）。
 *
 * 面板由 plugin loader 贡献给工作区；运行时是项目级单例，由 `runtimeManager` 管理，
 * 工作区只通过 SDK 的 `PanelHostProps` 传停靠信息，不接触 agent 内部。
 */
import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { AgentRuntime, AgentRuntimeView } from '../core/contracts'
import type { PanelHostProps } from '../../../plugin-sdk'
import { AgentPanel } from './AgentPanel'
import {
  ensureAgentRuntime,
  restartAgentRuntime,
  subscribeAgentRuntime,
} from '../runtimeManager'

export type AgentPanelHostProps = PanelHostProps & {
  /** 选区等展示上下文（可选，由工作区传入） */
  contextLabel?: string
  /** Run 活跃状态变化：外壳用它禁用保存 */
  onRunningChange?: (running: boolean) => void
}

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

  useEffect(() => {
    const unsubscribe = subscribeAgentRuntime((next, nextView) => {
      setRuntime(next)
      setView(nextView)
    })
    void ensureAgentRuntime()
    return () => {
      unsubscribe()
    }
  }, [])

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
      onConfigChanged={() => {
        void restartAgentRuntime()
      }}
    />
  )
}
