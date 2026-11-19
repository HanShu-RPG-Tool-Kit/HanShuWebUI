/**
 * 会话视图映射：pi-durable 的 `ConversationView` + `pi.live` → 面板渲染用的 `AgentRuntimeView`。
 *
 * 为什么单独一层：面板不再拥有对话状态（文档 §6「AgentPanel 改造：从消息数组改为订阅对话视图渲染」），
 * 它只吃这个纯函数的输出。纯函数也方便验收脚本直接断言（不渲染 React）。
 */

import type {
  AssistantMessage,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from '@earendil-works/pi-ai'
import type { ConversationView, EntryRecord } from '@earendil-works/pi-durable'
import type { LiveState } from '@earendil-works/pi-durable'
import type {
  AgentRunState,
  AgentRuntimeView,
  AgentViewItem,
  PendingRollback,
  RollbackNoticeItem,
  RollbackNoticeRun,
  RunMetaItem,
  UndoOutcome,
} from '../contracts'

/** 条目 kind 常量（pi-durable 内置） */
const KIND_USER = 'pi.user'
const KIND_ASSISTANT = 'pi.assistant'
const KIND_TOOL_RESULT = 'pi.tool-result'
const KIND_RESET = 'pi.reset'
const KIND_COMPACTION = 'pi.compaction'
/** 应用自定义条目：一次回滚的通知（data 给 UI，model 给模型） */
export const KIND_ROLLBACK = 'hanshu.rollback'

/** 从 `hanshu.rollback` 条目里解析出可渲染的通知；坏数据直接忽略，不影响其它条目 */
export function rollbackNoticeOf(entry: EntryRecord): RollbackNoticeItem | null {
  const data = entry.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const record = data as Record<string, unknown>
  const rawRuns = Array.isArray(record.runs) ? record.runs : []
  const runs: RollbackNoticeRun[] = []
  for (const raw of rawRuns) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const run = raw as Record<string, unknown>
    if (typeof run.userIndex !== 'number') continue
    runs.push({
      userIndex: run.userIndex,
      ...(typeof run.userText === 'string' ? { userText: run.userText } : {}),
      files: Array.isArray(run.files)
        ? run.files.filter((file): file is string => typeof file === 'string')
        : [],
    })
  }
  const outcomes: UndoOutcome[] = []
  if (Array.isArray(record.outcomes)) {
    for (const raw of record.outcomes) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const outcome = raw as Record<string, unknown>
      if (typeof outcome.path !== 'string' || typeof outcome.action !== 'string') continue
      outcomes.push({
        path: outcome.path,
        action: outcome.action as UndoOutcome['action'],
        ...(typeof outcome.reason === 'string' ? { reason: outcome.reason } : {}),
      })
    }
  }
  return {
    id: String(entry.id),
    kind: 'rollback',
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
    ...(record.forced === true ? { forced: true } : {}),
    ...(record.auto === true ? { auto: true } : {}),
    runs,
    outcomes,
  }
}

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

/**
 * 工具调用参数：从助手消息里的 ToolCall 建 callId → 紧凑 JSON 文本的映射。
 * 工具结果条目只带 toolCallId，参数只在发出请求的那条助手消息里（`entriesToItems` 顺序扫描时收集）。
 * 没有参数（`{}`）时不返回，避免 UI 里多一个空的「输入」入口。
 */
export function toolCallInputsOf(message: AssistantMessage | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (!message) return out
  for (const part of message.content) {
    if (part.type !== 'toolCall') continue
    const call = part as ToolCall
    if (Object.keys(call.arguments ?? {}).length === 0) continue
    try {
      out.set(call.id, JSON.stringify(call.arguments))
    } catch {
      /* 参数不是可序列化值时不给输入入口，不影响工具结果渲染 */
    }
  }
  return out
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
  /** 工具调用参数：助手条目在前、结果条目在后，顺序扫描即可对上 */
  const callInputs = new Map<string, string>()
  /** 每个用户条目对应的渲染条目下标（空正文不渲染时为 -1），回滚通知按 userIndex 标整轮 */
  const userItemIndexes: number[] = []
  /** 回滚通知要标红的 userIndex 集合；等扫完再统一标，避免边遍历边改 */
  const rolledBackUserIndexes = new Set<number>()
  /**
   * 每个已完成 Run 的统计行。用户条目开启一轮，下一个用户条目到来时收尾；
   * 分支点以下一条用户条目为界（复制到这一轮为止），最后一条 Run 省略 = 复制全部。
   */
  type RunAccumulator = {
    userEntryId: string
    startTs: number
    endTs: number
    turns: number
    inputTokens: number
    cachedTokens: number
    outputTokens: number
  }
  let run: RunAccumulator | null = null
  /**
   * 被回滚/重置/压缩这类非 Run 事件提前收尾的统计行。它的分支点是「下一条用户消息」，
   * 但收尾时还没扫到，先记下来，等遇到下一条用户条目时补上 forkBeforeEntryId。
   */
  let boundaryRunMeta: RunMetaItem | null = null
  const closeRun = (nextUserEntryId?: string, atBoundary = false) => {
    if (!run) return
    const meta: RunMetaItem = {
      id: `run-meta:${run.userEntryId}`,
      kind: 'run-meta',
      durationMs: Math.max(0, run.endTs - run.startTs),
      turns: run.turns,
      inputTokens: run.inputTokens,
      cachedTokens: run.cachedTokens,
      outputTokens: run.outputTokens,
    }
    if (nextUserEntryId) meta.forkBeforeEntryId = nextUserEntryId
    items.push(meta)
    boundaryRunMeta = !nextUserEntryId && atBoundary ? meta : null
    run = null
  }
  for (const entry of entries) {
    const entryId = String(entry.id)
    switch (entry.kind) {
      case KIND_USER: {
        // 上一轮到此为止：统计行落在下一条用户消息之前
        closeRun(entryId)
        const pendingMeta = boundaryRunMeta as RunMetaItem | null
        if (pendingMeta) {
          pendingMeta.forkBeforeEntryId = entryId
          boundaryRunMeta = null
        }
        const message = firstMessageOf<UserMessage>(entry)
        const text = userTextOf(message)
        const timestamp = typeof message?.timestamp === 'number' ? message.timestamp : Date.now()
        run = {
          userEntryId: entryId,
          startTs: timestamp,
          endTs: timestamp,
          turns: 0,
          inputTokens: 0,
          cachedTokens: 0,
          outputTokens: 0,
        }
        const index = text ? items.length : -1
        if (text) items.push({ id: entryId, kind: 'user', text })
        userItemIndexes.push(index)
        break
      }
      case KIND_ASSISTANT: {
        const message = firstMessageOf<AssistantMessage>(entry)
        if (run) {
          // 轮次 = 这一 Run 里的模型回复数（含只调工具、无正文的回复）
          run.turns += 1
          if (typeof message?.timestamp === 'number') {
            run.endTs = Math.max(run.endTs, message.timestamp)
          }
          const usage = message?.usage
          if (usage) {
            run.inputTokens += usage.input || 0
            run.cachedTokens += usage.cacheRead || 0
            run.outputTokens += usage.output || 0
          }
        }
        for (const [callId, input] of toolCallInputsOf(message)) callInputs.set(callId, input)
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
        if (run && typeof message?.timestamp === 'number') {
          run.endTs = Math.max(run.endTs, message.timestamp)
        }
        const output = toolResultText(message)
        items.push({
          id: entryId,
          kind: 'tool',
          name: message?.toolName ?? 'tool',
          status: message?.isError ? 'error' : 'done',
          input: message?.toolCallId ? callInputs.get(message.toolCallId) : undefined,
          output: output || undefined,
        })
        break
      }
      case KIND_ROLLBACK: {
        // 回滚通知不属于 Run：先给当前 Run 收尾，统计行排在通知之前，
        // 这样统计行/分支按钮不会看起来像「挂在回滚卡片后面」。
        closeRun(undefined, true)
        const notice = rollbackNoticeOf(entry)
        if (!notice) break
        items.push(notice)
        // 回滚只允许后缀轮，所以通知里的 runs 就是「通知之前最近 N 轮」。
        // 正常用 data 里的 userIndex；如果条目被复制进了更短的片段（归档增量/裁剪），
        // userIndex 可能越界或指向不可渲染的 user，此时按位置回退到最后 N 轮，
        // 至少红线仍能标在正确的后缀轮上（卡片本身已在上面渲染）。
        const seenUsers = userItemIndexes.length
        const indexesValid = notice.runs.every(
          (run) =>
            run.userIndex >= 0 &&
            run.userIndex < seenUsers &&
            (userItemIndexes[run.userIndex] ?? -1) >= 0,
        )
        if (indexesValid) {
          for (const run of notice.runs) rolledBackUserIndexes.add(run.userIndex)
        } else {
          for (let index = Math.max(0, seenUsers - notice.runs.length); index < seenUsers; index += 1) {
            if ((userItemIndexes[index] ?? -1) >= 0) rolledBackUserIndexes.add(index)
          }
        }
        break
      }
      case KIND_RESET:
        closeRun(undefined, true)
        items.push({ id: entryId, kind: 'notice', text: '对话已重置' })
        break
      case KIND_COMPACTION:
        closeRun(undefined, true)
        items.push({ id: entryId, kind: 'notice', text: '较早的对话已压缩' })
        break
      default:
        break
    }
  }
  // 最后一条 Run 没有「下一条用户消息」：复制全部，所以不带 forkBeforeEntryId
  closeRun()
  // 回滚通知 → 把该轮用户消息到尾条（下一条用户消息之前）的整段打上「已回滚的 Run」
  for (const userIndex of rolledBackUserIndexes) {
    const start = userItemIndexes[userIndex]
    if (start === undefined || start < 0) continue
    const nextStart = userItemIndexes[userIndex + 1]
    const end = nextStart !== undefined && nextStart >= 0 ? nextStart : items.length
    for (let index = start; index < end; index += 1) {
      const item = items[index]
      if (!item || item.kind === 'rollback') continue
      if (
        item.kind === 'user' ||
        item.kind === 'assistant' ||
        item.kind === 'tool' ||
        item.kind === 'run-meta'
      ) {
        item.rolledBackRun = true
        if (item.kind === 'user') item.rolledBack = true
      }
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
  const callInputs = toolCallInputsOf(partial)
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
      input: callInputs.get(slot.callId),
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
