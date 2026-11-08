/**
 * 会话视图映射：pi-durable 的 `ConversationView` + `pi.live` → 面板渲染用的 `AgentRuntimeView`。
 *
 * 为什么单独一层：面板不再拥有对话状态（文档 §6「AgentPanel 改造：从消息数组改为订阅对话视图渲染」），
 * 它只吃这个纯函数的输出。纯函数也方便验收脚本直接断言（不渲染 React）。
 */

import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai'
import type { ConversationView, EntryRecord } from '@earendil-works/pi-durable'
import type { LiveState } from '@earendil-works/pi-durable'
import type {
  AgentRunState,
  AgentRuntimeView,
  AgentViewItem,
  PendingRollback,
  UndoOutcome,
} from '../contracts'

/** 条目 kind 常量（pi-durable 内置） */
const KIND_USER = 'pi.user'
const KIND_ASSISTANT = 'pi.assistant'
const KIND_TOOL_RESULT = 'pi.tool-result'
const KIND_RESET = 'pi.reset'
const KIND_COMPACTION = 'pi.compaction'

/** 取用户消息的纯文本（content 可以是字符串或分段数组） */
export function userTextOf(message: UserMessage | undefined): string {
  if (!message) return ''
  const content = message.content
  if (typeof content === 'string') return content
  return content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
}

/** 取助手消息的可见正文（thinking 单独放，默认不展开） */
export function assistantTextOf(message: AssistantMessage | undefined): string {
  if (!message) return ''
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
}

/** 取模型思考内容；厂商不返回时是空串 */
export function assistantThinkingOf(message: AssistantMessage | undefined): string {
  if (!message) return ''
  return message.content
    .map((part) => (part.type === 'thinking' ? part.thinking : ''))
    .join('\n')
    .trim()
}

function toolResultText(message: ToolResultMessage | undefined): string {
  if (!message) return ''
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
}

function firstMessageOf<T>(entry: { model?: readonly unknown[] } | undefined): T | undefined {
  return entry?.model?.[0] as T | undefined
}

/**
 * 把已提交条目映射成渲染条目。
 * 注意：**只追加、不改写**——条目一旦提交就不可变，渲染层不要基于内容猜测去重。
 */
export function entriesToItems(view: ConversationView | null): AgentViewItem[] {
  return entryRecordsToItems(view?.entries ?? [])
}

/** 条目记录 → 渲染条目（归档段只读查看与 fork 前的预览都走它） */
export function entryRecordsToItems(
  entries: readonly EntryRecord[],
): AgentViewItem[] {
  const items: AgentViewItem[] = []
  for (const entry of entries) {
    const entryId = String(entry.id)
    switch (entry.kind) {
      case KIND_USER: {
        const text = userTextOf(firstMessageOf<UserMessage>(entry))
        if (text) items.push({ id: entryId, kind: 'user', text })
        break
      }
      case KIND_ASSISTANT: {
        const message = firstMessageOf<AssistantMessage>(entry)
        const text = assistantTextOf(message)
        const thinking = assistantThinkingOf(message)
        // 只有工具调用的助手消息不产生条目：工具状态由 live.tools / 工具结果条目呈现，
        // 给用户看「模型请求调用工具」是噪音（用户只关心工具叫什么、做完没有）。
        // 有思考但没正文时仍然给一条：思考本身是可查看的信息。
        if (text || thinking) {
          items.push({ id: entryId, kind: 'assistant', text, thinking: thinking || undefined })
        }
        break
      }
      case KIND_TOOL_RESULT: {
        const message = firstMessageOf<ToolResultMessage>(entry)
        const output = toolResultText(message)
        items.push({
          id: entryId,
          kind: 'tool',
          name: message?.toolName ?? 'tool',
          status: message?.isError ? 'error' : 'done',
          output: output || undefined,
        })
        break
      }
      case KIND_RESET:
        items.push({ id: entryId, kind: 'notice', text: '对话已重置' })
        break
      case KIND_COMPACTION:
        items.push({ id: entryId, kind: 'notice', text: '较早的对话已压缩' })
        break
      default:
        break
    }
  }
  return items
}

/**
 * `pi.live` 里的**未落盘**部分：正在生成的助手正文、正在跑的工具。
 * 与已提交条目不会重复：
 * - 流式正文是「还没提交的那一条」，提交后从 live 消失、从 entries 出现；
 * - 工具槽带 `entry` 表示结果已提交，交给 entries 渲染。
 */
export function liveToItems(live: LiveState | undefined): AgentViewItem[] {
  if (!live) return []
  const items: AgentViewItem[] = []

  const partial = live.generation?.message as AssistantMessage | undefined
  const partialText = assistantTextOf(partial)
  const partialThinking = assistantThinkingOf(partial)
  if (partialText || partialThinking) {
    items.push({
      id: `live:assistant:${live.run?.taskId ?? 'run'}`,
      kind: 'assistant',
      text: partialText,
      streaming: true,
      thinking: partialThinking || undefined,
    })
  }

  for (const slot of live.tools ?? []) {
    if (slot.entry) continue
    items.push({
      id: `live:tool:${slot.callId}`,
      kind: 'tool',
      name: slot.name,
      status: slot.status === 'done' ? 'done' : 'running',
      output: slot.output || undefined,
    })
  }

  return items
}

/** `pi.live` → 状态行文案（思考中 / 工具名 / 重试） */
export function statusOf(live: LiveState | undefined): string {
  if (!live?.run) return ''
  const retry = live.generation?.retry
  if (retry) return `模型请求失败，${Math.max(0, Math.round((retry.at - Date.now()) / 1000))} 秒后重试…`
  const running = (live.tools ?? []).filter((slot) => !slot.entry && slot.status !== 'done')
  if (running.length > 0) {
    return `工具：${running.map((slot) => slot.name).join('、')}`
  }
  if (live.generation?.deferred) return '等待模型返回…'
  return `思考中…（第 ${live.run.turns + 1} 轮）`
}

/** Run 失败时写进对话流的那一条（文档 §7：失败 Run 在对话里留记录是有价值的） */
export function failureItem(
  error: string | undefined,
  undo?: UndoOutcome[],
): AgentViewItem {
  const lines = [error || 'Run 失败']
  if (undo && undo.length > 0) {
    const restored = undo.filter((item) => item.action === 'restored' || item.action === 'deleted')
    const skipped = undo.filter((item) => item.action === 'skipped')
    if (restored.length > 0) {
      lines.push(`已自动撤销：${restored.map((item) => item.path).join('、')}`)
    }
    if (skipped.length > 0) {
      lines.push(`这些文件之后又被改过，没有自动撤销，请手动检查：${skipped
        .map((item) => item.path)
        .join('、')}`)
    }
  }
  return {
    id: `error:${Date.now()}`,
    kind: 'error',
    text: lines.join('\n'),
  }
}

export type BuildViewInput = {
  segmentId: string | null
  runId: string | null
  runState: AgentRunState
  status: string
  lockedPaths: string[]
  conversationView: ConversationView | null
  live: LiveState | undefined
  /** Run 收尾后追加的本地条目（失败记录 / 中断说明） */
  extraItems: AgentViewItem[]
  /** 失败 Run 留下的待处理回滚（失败卡片三选项用） */
  pendingRollback?: PendingRollback | null
  /** 当前段是否已封存（保存后不可再写入/Run） */
  segmentSealed?: boolean
}

export function buildRuntimeView(input: BuildViewInput): AgentRuntimeView {
  return {
    segmentId: input.segmentId,
    runId: input.runId,
    runState: input.runState,
    status: input.runState === 'running' ? input.status : '',
    items: [
      ...entriesToItems(input.conversationView),
      ...liveToItems(input.live),
      ...input.extraItems,
    ],
    lockedPaths: input.lockedPaths,
    pendingRollback: input.pendingRollback ?? null,
    segmentSealed: input.segmentSealed === true,
  }
}
