/**
 * Agent 插件入口：向 shell 贡献 Agent 面板。
 *
 * 面板组件内部通过 `runtimeManager` 拿项目级运行时；工作区只传停靠信息。
 * 这个文件是插件与主体之间唯一的装配点（`src/app/pluginLoader.ts` 静态引入）。
 */
import type { Plugin } from '../../plugin-sdk'
import { AgentPanelHost } from './ui/AgentPanelHost'
import { ensureAgentRuntime } from './runtimeManager'

export const agentPlugin: Plugin = {
  id: 'agent',
  name: 'Agent',
  async activate(context) {
    context.registerPanel({
      id: 'agent',
      title: 'Agent',
      component: AgentPanelHost,
      workspaces: ['stageplay'],
      defaultOpen: false,
      placement: 'left',
      defaultSize: 360,
      minSize: 220,
      order: 10,
    })
    // 面板未打开也需要运行时：保存封段、锁状态都依赖它。
    await ensureAgentRuntime()
  },
}

export { AgentPanelHost } from './ui/AgentPanelHost'
export { AgentPanel } from './ui/AgentPanel'
export type { AgentPanelProps } from './ui/AgentPanel'
