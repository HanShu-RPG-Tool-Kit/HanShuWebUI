/**
 * Agent 插件展示层入口：仅供下一步 plugin loader 使用，暂未接入现有代码。
 *
 * 行为与导出名保持不变；样式由 `./ui/AgentPanel` 顶部 `import './agent.css'` 带入。
 */
export { AgentPanel } from './ui/AgentPanel'
export type { AgentPanelProps } from './ui/AgentPanel'
export { AgentDiffModal } from './ui/AgentDiffModal'
export type { AgentDiffSnapshot } from './ui/AgentDiffModal'
