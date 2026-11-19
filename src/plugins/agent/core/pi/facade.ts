/**
 * **唯一 import `@earendil-works/*` 的业务入口**（文档 §6「facade：唯一 import PI 的文件，API 收窄」）。
 *
 * 对外只给 `AgentRuntime`（见 contracts.ts）：UI 与工作区拿不到 Harness / Conversation / Storage。
 * 层级与职责：
 *   存储   IndexedDbStorage（每窗口 + 每工程一个库，对话只在本机）
 *   运行时 Harness / Conversation / Session（pi-durable，1.5.0 精确锁版本）
 *   工具   tools.ts 的三语义工具 → defineTool
 *   仲裁   版本表 · 锁表 · Run 撤销日志（runtime/）
 *
 * 与文档对应的几个硬约束：
 * - §7 Run = 原子单元：页面存活时失败/中止 → 按版本守卫回滚；刷新/崩溃不回滚
 * - §7 失败 Run 在对话里留一条记录（不回滚对话条目）
 * - §9 保存只产归档段、不封段；归档段不可变、按工程 scope 存放在归档段库
 * - §9 打开时不自动续跑：检测到未完成 Run → abort（不回滚）
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { AssistantMessage, Message, UserMessage } from '@earendil-works/pi-ai'
import {
  Harness,
  createRegistry,
  defineExtension,
  LiveDoc,
  type Conversation,
  type ConversationRecord,
  type ConversationView,
  type ConversationWatch,
  type EntryRecord,
  type Harness as HarnessType,
  type LiveState,
  type Storage,
} from '@earendil-works/pi-durable'
import { IndexedDbStorage } from '@earendil-works/pi-durable/storage/indexeddb'
import {
  clearAgentApiKey,
  getAgentApiKey,
  getAgentBaseUrl,
  getAgentModelId,
  getAgentModelIds,
  getAgentThinkingLevel,
} from '../config'
import { AGENT_RULES } from '../rules'
import syntaxDocs from '../../../../help/docs/hanshu-syntax.md?raw'
import { createFileWorld, RuntimeArbiter } from './arbiter'
import { buildModels, normalizeModelId } from './models'
import { buildAgentTools } from './tools'
import { buildRuntimeView, entryRecordsToItems, failureItem, statusOf, userTextOf } from './view'
import { LockTable } from '../runtime/lockTable'
import { RunUndoLog } from '../runtime/runUndo'
import { IndexedDbUndoJournalBackend, undoJournalKey } from '../store/undoJournal'
import {
  IndexedDbRunRollbackBackend,
  runRollbackKey,
  type RunRollbackRecord,
} from '../store/runRollbackStore'
import { segmentDbName } from '../store/dbNames'
import { descendantSnapshotIds, forkEntryDrafts, type ForkSourceEntry } from '../store/archiveGraph'
import { deleteSegmentRecords } from '../store/segmentPurge'
import { IndexedDbSnapshotBackend, SnapshotStore, persistStorage } from '../store/snapshotStore'
import type {
  AgentRollbackResult,
  AgentRunResult,
  AgentRunState,
  AgentRuntime,
  AgentRuntimeOptions,
  AgentRuntimeView,
  AgentViewItem,
  ForkSegmentOptions,
  ManualRollbackOptions,
  PendingRollback,
  SegmentInfo,
  SnapshotInfo,
  UndoConflict,
  UndoOutcome,
} from '../contracts'

/** 段元数据（活跃段库是 pi-durable 的，`ConversationRecord` 不带标题/时间，这里补最小元数据） */
type SegmentMeta = {
  createdAt: number
  updatedAt: number
  title?: string
  runCount: number
  /** 从哪个归档段「继承对话」而来（删归档段时级联用） */
  sourceSnapshotId?: string
  /** 保存后封存：不再接受 Run，下次发送会自动开新段（D4） */
  sealed?: boolean
  /** 本段是否发生过失败 Run 的回滚（归档简化日志用） */
  rolledBack?: boolean
  /** 归档简化日志：只存哈希，不存正文（D4） */
  rollbackLog?: Array<{ path: string; beforeHash: string | null; afterHash: string | null }>
}

const NORUN_KEY = 'hanshu.agent.segment'

/** 段元数据放 localStorage：只存标题/时间这类 UI 元数据，**对话正文永远不进 localStorage** */
function metaStorageKey(scope: string, windowId: string): string {
  return `${NORUN_KEY}.${windowId}.${scope}`
}

function readSegmentMeta(scope: string, windowId: string): Record<string, SegmentMeta> {
  try {
    const raw = localStorage.getItem(metaStorageKey(scope, windowId))
    return raw ? (JSON.parse(raw) as Record<string, SegmentMeta>) : {}
  } catch {
    return {}
  }
}

function writeSegmentMeta(
  scope: string,
  windowId: string,
  meta: Record<string, SegmentMeta>,
): void {
  try {
    localStorage.setItem(metaStorageKey(scope, windowId), JSON.stringify(meta))
  } catch {
    /* 隐私模式：元数据丢了也不影响对话可用性 */
  }
}

/** 段落标题的派生：第一条用户消息的首行（文档 §9「标题派生」） */
function titleFromText(text: string): string {
  const line = text.split('\n').find((item) => item.trim()) ?? ''
  return line.trim().slice(0, 30)
}

function userTextOfEntry(entry: EntryRecord): string {
  const message = entry.model?.[0] as
    | { role?: string; content?: string | Array<{ type?: string; text?: string }> }
    | undefined
  if (!message) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => (part.type === 'text' ? part.text ?? '' : '')).join('')
  }
  return ''
}

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  const ctx = BACKGROUND_CONTEXT
  const metaStore = readSegmentMeta(options.scope, options.windowId)

  let harness: HarnessType | null = null
  let storage: Storage | null = null
  let snapshots: SnapshotStore | null = null
  let conversation: Conversation | null = null
  let watch: ConversationWatch | null = null
  let conversationView: ConversationView | null = null
  let live: LiveState | undefined
  let segmentId: string | null = null
  let runState: AgentRunState = 'idle'
  let runId: string | null = null
  let statusText = ''
  let lockedPaths: string[] = []
  let extraItems: AgentViewItem[] = []
  /** 失败 Run 留下的待处理回滚；只保留最近一次 */
  let pendingRollback: PendingRollback | null = null
  /** 产生 pendingRollback 的 Run key（撤销日志按它分组） */
  let pendingRunKey: string | null = null
  /** 用户点了「停止」：本轮收尾**不自动回滚**，改动留给用户选择回滚或保留 */
  let abortRequested = false
  let opened = false
  let lastRunKey: string | null = null
  /** 每个段上次归档到哪个条目，用于增量补写（进程内即可，归档段记录里也存了 tailEntryId） */
  const archivedTail = new Map<string, { snapshotId: string; tail: number }>()

  // 锁、撤销日志、派生资产版本看到同一个世界
  const world = createFileWorld(options.host)
  const locks = new LockTable(world)
  const undo = new RunUndoLog(world)
  // 待处理回滚的持久化（刷新后仍能强制/放弃/重试）；一个实例绑定一个工程 scope
  const undoJournal = new IndexedDbUndoJournalBackend({ scope: options.scope })
  // 活跃段「历史 Run 回滚记录」：每轮改动一份撤销日志，供消息左侧/输入框旁主动回滚
  const runRollbackDb = new IndexedDbRunRollbackBackend({ scope: options.scope })
  /** 当前段可回滚的 Run（runKey → 记录）；切段时按段重新加载 */
  let runRollbacks = new Map<string, RunRollbackRecord>()
  /** runKey → 触发这一轮的 user 条目 id（停止/失败转「保留」时补建记录用） */
  const runUserEntryIds = new Map<string, string>()
  const arbiter = new RuntimeArbiter({
    host: options.host,
    locks,
    undo,
    world,
    runKey: () => lastRunKey ?? 'no-run',
    onLockChange: () => emit(),
  })

  let currentView: AgentRuntimeView = buildRuntimeView({
    segmentId: null,
    runId: null,
    runState: 'idle',
    status: '',
    lockedPaths: [],
    conversationView: null,
    live: undefined,
    extraItems: [],
  })
  const listeners = new Set<(view: AgentRuntimeView) => void>()

  function emit(): void {
    lockedPaths = locks.lockedPaths()
    const view = buildRuntimeView({
      segmentId,
      runId,
      runState,
      status: statusText,
      lockedPaths,
      conversationView,
      live,
      extraItems,
      pendingRollback,
      segmentSealed: Boolean(segmentId && metaStore[segmentId]?.sealed),
    })
    // 历史 Run 回滚入口：按 user 条目 id 挂 runKey，归档段/已回滚的按钮置灰
    currentView = { ...view, items: annotateRollbacks(view.items) }
    for (const listener of listeners) listener(currentView)
  }

  /** 丢弃待处理回滚（保存封段 / 切段 / 新一次失败 Run 覆盖时调用） */
  function clearPendingRollback(): void {
    if (pendingRunKey) undo.discard(pendingRunKey)
    pendingRunKey = null
    if (pendingRollback) pendingRollback = null
  }

  /** 当前段的撤销日志持久化 key（打开/切换段时按它恢复待处理回滚） */
  function segmentJournalKey(): string | null {
    return segmentId ? undoJournalKey(options.scope, options.windowId, segmentId) : null
  }

  /** 把待处理回滚写进活跃段库；体积/环境不支持时降级为"只在内存" */
  async function persistPendingRollback(
    runKey: string,
    reason?: 'failure' | 'stopped',
  ): Promise<void> {
    const key = segmentJournalKey()
    if (!key || !segmentId) return
    try {
      await undoJournal.save({
        scope: options.scope,
        windowId: options.windowId,
        segmentId,
        runKey,
        ...(reason ? { reason } : {}),
        createdAt: Date.now(),
        entries: undo.entriesOf(runKey),
      })
    } catch {
      /* 超过体积上限 / 没有 IndexedDB：本次不持久化，不影响当前会话内的三选项 */
    }
  }

  async function clearPendingJournal(): Promise<void> {
    const key = segmentJournalKey()
    if (!key) return
    try {
      await undoJournal.clear(key)
    } catch {
      /* 清不掉只是残留，下次打开会按预演结果处理 */
    }
  }

  /* ───────────── 历史 Run 回滚记录（活跃段手动回滚） ───────────── */

  function runRollbackSegmentKey(): string | null {
    return segmentId
      ? runRollbackKey(options.scope, options.windowId, segmentId)
      : null
  }

  /** 切段/打开时加载该段可回滚的 Run；失败只降级为"这次会话内不能回滚" */
  async function loadRunRollbacks(): Promise<void> {
    runRollbacks = new Map()
    const key = runRollbackSegmentKey()
    if (!key || !segmentId) return
    try {
      const record = await runRollbackDb.load(key)
      if (!record || record.segmentId !== segmentId) return
      for (const run of record.runs) runRollbacks.set(run.runKey, run)
    } catch {
      /* 打开失败：不影响对话，只是回滚图标不出现 */
    }
  }

  /** 整段重写回滚记录；条数/体积超限时 store 会裁掉最旧的，仍失败则只在内存 */
  async function persistRunRollbacks(): Promise<void> {
    const key = runRollbackSegmentKey()
    if (!key || !segmentId) return
    try {
      const runs = [...runRollbacks.values()]
      if (runs.length === 0) {
        await runRollbackDb.clear(key)
        return
      }
      await runRollbackDb.save({
        scope: options.scope,
        windowId: options.windowId,
        segmentId,
        runs,
      })
    } catch {
      /* 体积超限 / 没有 IndexedDB：本次不持久化，当前会话内仍可回滚 */
    }
  }

  /** 把一轮 Run 的撤销日志收进"可主动回滚"集合（成功 Run / 用户选择保留改动的停止、失败） */
  async function recordRollbackRun(runKey: string, userEntryId: string | undefined): Promise<void> {
    if (!userEntryId || !undo.has(runKey)) return
    const entries = undo.entriesOf(runKey)
    if (entries.length === 0) return
    runRollbacks.set(runKey, {
      runKey,
      userEntryId,
      createdAt: runRollbacks.get(runKey)?.createdAt ?? Date.now(),
      entries,
    })
    await persistRunRollbacks()
  }

  /** 给 user 条目标注是否可主动回滚 */
  function annotateRollbacks(items: AgentViewItem[]): AgentViewItem[] {
    if (runRollbacks.size === 0 && !items.some((item) => item.kind === 'user')) return items
    const sealed = Boolean(segmentId && metaStore[segmentId]?.sealed)
    const byUserEntry = new Map<string, RunRollbackRecord>()
    for (const record of runRollbacks.values()) byUserEntry.set(record.userEntryId, record)
    return items.map((item) => {
      if (item.kind !== 'user') return item
      const record = byUserEntry.get(item.id)
      if (!record) return item
      return {
        ...item,
        runKey: record.runKey,
        rollbackable: !sealed && record.rolledBack !== true,
        ...(record.rolledBack === true ? { rolledBack: true } : {}),
      }
    })
  }

  /**
   * 手动回滚一组 Run（消息左侧「回滚该轮及之后」/ 输入框旁「回滚全部」）。
   * 只撤销工程草稿，不动对话条目；多轮一起回滚时从新到旧模拟，冲突则一个文件都不动。
   */
  async function runManualRollback(
    runKeys: string[],
    options?: ManualRollbackOptions,
  ): Promise<AgentRollbackResult> {
    if (segmentId && metaStore[segmentId]?.sealed) {
      return {
        ok: false,
        rolledBackRuns: [],
        outcomes: [],
        conflicts: [],
        error: '归档段不可回滚',
      }
    }
    const selected = runKeys
      .map((key) => runRollbacks.get(key))
      .filter((record): record is RunRollbackRecord => record !== undefined && record.rolledBack !== true)
    if (selected.length === 0) {
      return { ok: true, rolledBackRuns: [], outcomes: [], conflicts: [] }
    }
    const ordered = [...selected].sort((a, b) => a.createdAt - b.createdAt)
    const runs = ordered.map((record) => ({ runId: record.runKey, entries: record.entries }))
    let outcomes: UndoOutcome[]
    let conflicts: UndoConflict[]
    if (options?.force === true) {
      // 强制回滚：跳过版本/人类编辑守卫，按写前快照覆盖（界面已二次确认）
      outcomes = (await undo.forceMany(runs)).outcomes
      conflicts = []
    } else {
      const result = await undo.rollbackMany(runs)
      if (!result.ok) {
        return {
          ok: false,
          rolledBackRuns: [],
          outcomes: result.outcomes,
          conflicts: result.conflicts,
          error: '部分文件已被修改，未执行回滚',
        }
      }
      outcomes = result.outcomes
      conflicts = []
    }
    for (const record of ordered) {
      const current = runRollbacks.get(record.runKey)
      if (current) runRollbacks.set(record.runKey, { ...current, rolledBack: true })
    }
    // 同一轮如果还挂着失败/停止的回滚卡片，手动回滚后一并收掉，避免重复入口
    if (pendingRunKey && ordered.some((record) => record.runKey === pendingRunKey)) {
      clearPendingRollback()
      await clearPendingJournal()
    }
    await persistRunRollbacks()
    // 通知用户与模型：这些 Run 的改动已被撤回了（归档段会连同这条通知一起带走）
    await appendRollbackNotice({
      runs: ordered.map((record) => ({
        runKey: record.runKey,
        userEntryId: record.userEntryId,
        files: record.entries.map((entry) => entry.path),
      })),
      outcomes,
      forced: options?.force === true,
    })
    emit()
    return {
      ok: true,
      rolledBackRuns: ordered.map((record) => record.runKey),
      outcomes,
      conflicts,
    }
  }

  /* ───────────── 回滚通知条目（同时告知用户与模型：这些改动已被撤回） ───────────── */

  /** 当前上下文里最后一条模型消息（判定尾部角色，决定回滚通知的交替序列） */
  function lastModelMessage(): Message | undefined {
    const entries = conversationView?.entries ?? []
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const model = entries[index]?.model
      if (model && model.length > 0) return model[model.length - 1]
    }
    return undefined
  }

  /** 当前上下文里最后一条 assistant 消息（空 assistant 占位消息的元数据模板） */
  function lastAssistantMessage(): AssistantMessage | undefined {
    const entries = conversationView?.entries ?? []
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const model = entries[index]?.model
      if (!model) continue
      for (let messageIndex = model.length - 1; messageIndex >= 0; messageIndex -= 1) {
        const message = model[messageIndex]
        if (message?.role === 'assistant') return message as AssistantMessage
      }
    }
    return undefined
  }

  /**
   * 空 assistant 消息：只为保持 pi 上下文里 user/assistant 严格交替。
   * pi-ai 的 OpenAI-compatible 适配器会在发请求时丢掉「无正文、无工具调用」的 assistant，
   * DeepSeek 实测接受相邻 user，因此这里不需要可见占位文本（用户 2026-11-17 拍板「A 字面空」）。
   */
  function emptyAssistantMessage(last: AssistantMessage | undefined): AssistantMessage {
    return {
      role: 'assistant',
      content: [],
      api: last?.api ?? 'openai-completions',
      provider: last?.provider ?? 'deepseek',
      model: last?.model ?? normalizeModelId(getAgentModelId()),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    }
  }

  /** 某条 user 条目在「用户消息序列」里的下标（与视图里的 userIndex 同口径） */
  function userIndexOfEntry(entryId: string | undefined): number {
    if (!entryId || !conversationView) return -1
    let index = -1
    for (const entry of conversationView.entries) {
      if (entry.kind === 'pi.user') index += 1
      if (String(entry.id) === entryId) return index
    }
    return -1
  }

  /** 取 user 条目的首行摘要（卡片里展示「回滚的是哪一轮」） */
  function rollbackUserTextOf(entryId: string | undefined): string | undefined {
    if (!entryId || !conversationView) return undefined
    const entry = conversationView.entries.find((item) => String(item.id) === entryId)
    if (!entry || entry.kind !== 'pi.user') return undefined
    const text = userTextOf(entry.model?.[0] as UserMessage | undefined).trim()
    if (!text) return undefined
    const firstLine = text.split('\n')[0] ?? text
    return firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine
  }

  /** 回滚通知的模型侧说明（中文；要求模型把旧工具结果当成失效内容） */
  function rollbackNoticeText(
    runs: Array<{ userText?: string; files: string[] }>,
    outcomes: UndoOutcome[],
    input: { forced?: boolean; auto?: boolean },
  ): string {
    const header = input.auto
      ? '【回滚通知】上一轮 Run 失败后，系统已自动回滚它对这些工程草稿的改动：'
      : input.forced
        ? '【回滚通知】用户执行了强制回滚，以下 Run 对工程草稿的改动已被还原（之后对这些文件的编辑被丢弃）：'
        : '【回滚通知】用户已主动回滚以下 Run 对工程草稿的改动：'
    const lines = [header]
    runs.forEach((run, index) => {
      const files = run.files.length > 0 ? run.files.join('、') : '（没有文件改动）'
      const user = run.userText ? `（用户消息：“${run.userText}”）` : ''
      lines.push(`- 第 ${index + 1} 轮${user}：${files}`)
    })
    const restored = outcomes.filter(
      (outcome) => outcome.action === 'restored' || outcome.action === 'deleted',
    )
    const skipped = outcomes.filter((outcome) => outcome.action === 'skipped')
    if (restored.length > 0) {
      lines.push(`已恢复：${[...new Set(restored.map((outcome) => outcome.path))].join('、')}`)
    }
    if (skipped.length > 0) {
      lines.push(
        `无法恢复：${[...new Set(skipped.map((outcome) => outcome.path))].join('、')}（原因：${
          skipped.find((outcome) => outcome.reason)?.reason ?? '文件已不可写'
        }）`,
      )
    }
    lines.push(
      '这些改动已还原为更早的版本；上述 Run 里的工具结果不再代表当前文件内容。' +
        '继续工作前请重新读取相关文件（read_source / list_lang_keys / read_lang 等），不要基于旧内容继续。',
    )
    return lines.join('\n')
  }

  /**
   * 把一次回滚写进对话：一条 `hanshu.rollback` 条目。
   * - `data` 供 UI 渲染回滚卡片、给整轮画红线 / 「已回滚」标注；
   * - `model` 供模型：user 说明 + 空 assistant 占位，保持严格交替（见 agent-runtime.md）。
   * 只含 kind+data 的 write 不触发 Run；带 model 的 write 在 idle 时立即追加（不产生新 Run）。
   */
  async function appendRollbackNotice(input: {
    runs: Array<{ runKey: string; userEntryId?: string; files: string[] }>
    outcomes: UndoOutcome[]
    forced?: boolean
    auto?: boolean
  }): Promise<void> {
    if (!conversation || runState === 'running') return
    const lastAssistant = lastAssistantMessage()
    const runs: Array<{ userIndex: number; userText?: string; files: string[] }> = []
    for (const run of input.runs) {
      const userIndex = userIndexOfEntry(run.userEntryId)
      if (userIndex < 0) continue
      const userText = rollbackUserTextOf(run.userEntryId)
      runs.push({
        userIndex,
        ...(userText ? { userText } : {}),
        files: [...new Set(run.files)],
      })
    }
    if (runs.length === 0) return
    const data = {
      createdAt: Date.now(),
      ...(input.forced ? { forced: true } : {}),
      ...(input.auto ? { auto: true } : {}),
      runs,
      outcomes: input.outcomes.map((outcome) => ({
        path: outcome.path,
        action: outcome.action,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
      })),
    }
    const notice: UserMessage = {
      role: 'user',
      content: rollbackNoticeText(runs, input.outcomes, input),
      timestamp: Date.now(),
    }
    // 尾部必须是 assistant：上下文以 user 结尾时先补一个空 assistant 再写通知
    const tailRole = lastModelMessage()?.role
    const sequence: Message[] =
      tailRole === 'user'
        ? [emptyAssistantMessage(lastAssistant), notice, emptyAssistantMessage(lastAssistant)]
        : [notice, emptyAssistantMessage(lastAssistant)]
    try {
      await conversation.submit(
        {
          type: 'write',
          entry: { kind: 'hanshu.rollback', model: sequence, data },
        },
        ctx,
      )
    } catch {
      /* 会话忙/存储失败：回滚本身已经生效，通知写不进去不影响草稿状态 */
    }
  }

  /** 把本 Run 的改动并进当前段的简化日志（只存哈希，归档时带走） */
  function appendSegmentLog(runKey: string): void {
    if (!segmentId) return
    const entries = undo.entriesOf(runKey)
    if (entries.length === 0) return
    const meta = metaStore[segmentId] ?? {
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runCount: 0,
    }
    const log = meta.rollbackLog ?? []
    for (const entry of entries) {
      log.push({
        path: entry.path,
        beforeHash: entry.before.version,
        afterHash: entry.after,
      })
    }
    meta.rollbackLog = log
    metaStore[segmentId] = meta
    writeSegmentMeta(options.scope, options.windowId, metaStore)
  }

  /** 归档简化日志：本段发生过回滚 */
  function markSegmentRolledBack(): void {
    if (!segmentId) return
    const meta = metaStore[segmentId]
    if (!meta) return
    meta.rolledBack = true
    writeSegmentMeta(options.scope, options.windowId, metaStore)
  }

  /** 打开/切换段时恢复持久化的待处理回滚：安全就自动回滚，否则挂回失败卡片 */
  async function restorePendingRollback(): Promise<void> {
    const key = segmentJournalKey()
    if (!key) return
    let record
    try {
      record = await undoJournal.load(key)
    } catch {
      return
    }
    if (!record) return
    undo.restore(record.runKey, record.entries)
    const preflight = await undo.preflight(record.runKey)
    // 用户停止留下的待处理回滚：恢复后**不自动回滚**，等用户选择（与本次会话内一致）
    if (record.reason === 'stopped') {
      pendingRunKey = record.runKey
      pendingRollback = {
        status: 'pending',
        reason: 'stopped',
        conflicts: preflight.safe ? [] : preflight.conflicts,
        createdAt: record.createdAt,
      }
      emit()
      return
    }
    if (preflight.safe) {
      try {
        await undo.rollback(record.runKey)
        markSegmentRolledBack()
      } catch {
        /* 回放失败：留在日志里，用户可以重试 */
      }
      undo.discard(record.runKey)
      await clearPendingJournal()
      return
    }
    pendingRunKey = record.runKey
    pendingRollback = {
      status: 'pending',
      conflicts: preflight.conflicts,
      createdAt: record.createdAt,
    }
    emit()
  }

  function onConversationView(next: ConversationView): void {
    conversationView = next
    live = next.docs['pi.live'] as LiveState | undefined
    runId = live?.run ? String(live.run.taskId) : null
    statusText = statusOf(live)
    if (live?.run) runState = 'running'
    else if (runState === 'running') runState = 'idle'
    emit()
  }

  async function saveMeta(): Promise<void> {
    if (!segmentId) return
    const meta = metaStore[segmentId] ?? {
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runCount: 0,
    }
    meta.updatedAt = Date.now()
    metaStore[segmentId] = meta
    writeSegmentMeta(options.scope, options.windowId, metaStore)
  }

  async function segmentTitle(id: string): Promise<string> {
    const cached = metaStore[id]?.title
    if (cached) return cached
    if (!storage) return `会话 ${id}`
    const page = await storage.scanEntries(
      { conversationId: Number(id) as never, order: 'ascending' },
      20,
      undefined,
      ctx,
    )
    const firstUser = page.items.find((entry) => entry.kind === 'pi.user')
    const title = firstUser ? titleFromText(userTextOfEntry(firstUser)) : ''
    if (title && metaStore[id]) {
      metaStore[id]!.title = title
      writeSegmentMeta(options.scope, options.windowId, metaStore)
    }
    return title || `会话 ${id}`
  }

  async function listOwnerlessConversations(): Promise<ConversationRecord[]> {
    if (!storage) return []
    const out: ConversationRecord[] = []
    let cursor: Parameters<Storage['scanConversations']>[2]
    for (let page = 0; page < 20; page++) {
      const result = await storage.scanConversations({}, 100, cursor, ctx)
      out.push(...result.items)
      if (!result.next) break
      cursor = result.next
    }
    // 任务子会话（owner 存在）不是段；段是 ownerless（文档 §9）
    return out.filter((record) => !record.owner)
  }

  async function attach(target: Conversation): Promise<void> {
    if (watch) {
      await watch.stop()
      watch = null
    }
    conversation = target
    segmentId = String(target.id)
    await loadRunRollbacks()

    // 打开时不自动续跑（文档 §7）：检测到未完成 Run → 主动 abort，标记失败，**不回滚**
    const liveState = (await harness!.snapshot(LiveDoc, target.id, ctx)) as
      | LiveState
      | undefined
    if (liveState?.run) {
      try {
        await target.abort(ctx)
      } catch {
        /* 已被别的标签页处理掉：继续打开 */
      }
      extraItems = [
        ...extraItems,
        {
          id: `interrupted:${Date.now()}`,
          kind: 'notice',
          text: '上次对话被中断。改动已保留为草稿，保存前请检查。',
        },
      ]
    }

    // 模型与思考强度：每次切换段都按当前配置写一次；**不设轮次上限**（用户要求长任务不被打断）
    await target.configure(
      {
        model: { provider: 'deepseek', modelId: normalizeModelId(options.model) },
        thinkingLevel: getAgentThinkingLevel(),
        maxTurns: null,
      },
      ctx,
    )

    conversationView = null
    live = undefined
    runId = null
    runState = 'idle'
    emit()

    watch = await target.watch(ctx, { min: 50, max: 100 })
    onConversationView(watch.value)
    watch.start(async (call) => {
      if (call.kind === 'value') onConversationView(call.value)
    })

    await saveMeta()
    await restorePendingRollback()
    emit()
  }

  /** 关掉 Harness 与订阅，但保留归档段库句柄：删除段后还要重新 open */
  async function teardownHarness(): Promise<void> {
    if (watch) {
      await watch.stop()
      watch = null
    }
    conversation = null
    conversationView = null
    live = undefined
    if (harness) {
      try {
        await harness.close(ctx)
      } catch {
        /* 已关闭 */
      }
      harness = null
    }
    storage = null
    opened = false
    segmentId = null
    runRollbacks = new Map()
    runUserEntryIds.clear()
  }

  function forgetCurrentSegment(): void {
    try {
      localStorage.removeItem(`${NORUN_KEY}.current.${options.windowId}.${options.scope}`)
    } catch {
      /* 忽略 */
    }
  }

  async function open(): Promise<void> {
    if (opened) return
    opened = true
    try {
      storage = await IndexedDbStorage.open(segmentDbName(options.windowId, options.scope))
      snapshots = new SnapshotStore(
        new IndexedDbSnapshotBackend({ scope: options.scope }),
        { scope: options.scope },
      )

      // Key 每次请求现读 localStorage：面板里改 Key / 清 Key 立刻生效，不回落创建时的旧值
      const models = buildModels({
        readKey: () => getAgentApiKey(),
        baseUrl: getAgentBaseUrl() || options.baseUrl,
        // 设置里填的 Pro/Flash 两个模型 id 都进目录；目录外的会按同协议克隆一份
        modelIds: [getAgentModelIds().pro, getAgentModelIds().flash, options.model],
      })
      const registry = createRegistry()
      registry.install(
        defineExtension({
          name: 'hanshu-agent',
          tools: buildAgentTools({ host: options.host, arbiter }),
          sections: [
            // 提示词分节：顺序固定、内容稳定（文档 §9「前缀稳定」：动态信息不进 system prompt）
            { key: 'hanshu_rules', render: () => AGENT_RULES },
            { key: 'hanshu_syntax', render: () => syntaxDocs },
          ],
        }),
      )

      harness = await Harness.open(
        storage,
        {
          models,
          registry,
          settings: {
            // 文档 §7：失败 Run 不无限重试；中断的模型请求不重发 / 工具不重跑（replay 保持 unsafe）
            retry: { enabled: false, maxRetries: 0 },
            restartLimit: 1,
            toolExecution: 'sequential',
            progress: { persistWithinMs: 1000 },
            afterFailedRun: 'keep',
          },
        },
        ctx,
      )

      // 文档 §9：争取持久化配额，避免空间压力下被浏览器回收（失败不阻塞）
      void runtime.persistStorage()

      const records = await listOwnerlessConversations()
      const remembered = (() => {
        try {
          return localStorage.getItem(`${NORUN_KEY}.current.${options.windowId}.${options.scope}`)
        } catch {
          return null
        }
      })()
      const existing = records.find((record) => String(record.id) === remembered)
      const newest = existing ?? records[records.length - 1]
      const target = newest
        ? (await harness.conversation(newest.id, ctx)) ?? null
        : await harness.createConversation({ ownership: { kind: 'ownerless' } }, ctx)

      if (!target) throw new Error('无法打开会话段')
      await attach(target)
    } catch (error) {
      opened = false
      throw error
    }
  }

  function rememberCurrentSegment(): void {
    if (!segmentId) return
    try {
      localStorage.setItem(
        `${NORUN_KEY}.current.${options.windowId}.${options.scope}`,
        segmentId,
      )
    } catch {
      /* 记不住就回落到"最后一个段" */
    }
  }

  async function collectEntries(target: Conversation): Promise<EntryRecord[]> {
    const out: EntryRecord[] = []
    let cursor: Parameters<Conversation['entries']>[2]
    for (let page = 0; page < 50; page++) {
      const result = await target.entries({ order: 'ascending' }, 500, cursor, ctx)
      out.push(...result.items)
      if (!result.next) break
      cursor = result.next
    }
    return out
  }

  /**
   * 保存时归档一个段：按 archivedTail 只追加新增条目，写快照、封段、清掉该段的回滚记录。
   * 当前段与其它活跃段共用；返回 null 表示这段没有新增条目可归档。
   */
  async function archiveSegment(
    targetId: string,
    target: Conversation,
    title?: string,
  ): Promise<SnapshotInfo | null> {
    const entries = await collectEntries(target)
    if (entries.length === 0) return null
    const segmentMeta = metaStore[targetId]

    // 其它段的待处理回滚只存在 journal 里；当前段的内存日志在调用前已 append 进 meta
    let journalLog: Array<{ path: string; beforeHash: string | null; afterHash: string | null }> = []
    if (targetId !== segmentId) {
      const journalKey = undoJournalKey(options.scope, options.windowId, targetId)
      try {
        const record = await undoJournal.load(journalKey)
        if (record && record.entries.length > 0) {
          journalLog = record.entries.map((entry) => ({
            path: entry.path,
            beforeHash: entry.before?.version ?? null,
            afterHash: entry.after,
          }))
        }
        await undoJournal.clear(journalKey)
      } catch {
        /* 读不到 journal 不影响归档 */
      }
    }
    const rollbackLog = [...(segmentMeta?.rollbackLog ?? []), ...journalLog]

    const previous = archivedTail.get(targetId)
    const tail = entries[entries.length - 1]!
    const fresh = previous
      ? entries.filter((entry) => Number(entry.id) > previous.tail)
      : entries
    if (fresh.length === 0) return null

    // 父归档段 = 该段最近一次归档段（跨库谱系走自有元数据，文档 §9）
    const existing = await snapshots!.list()
    // 谱系：继承来的段 → 父是「被继承的归档」；否则父是该段上一次归档
    const inheritedFrom = segmentMeta?.sourceSnapshotId
    const parent =
      (inheritedFrom
        ? existing.find((item) => item.id === inheritedFrom)
        : undefined) ??
      existing
        .filter((item) => item.segmentId === targetId)
        .sort((a, b) => b.createdAt - a.createdAt)[0]

    const info: SnapshotInfo = {
      id: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      scope: options.scope,
      segmentId: targetId,
      parentSnapshotId: parent?.id,
      title: title || (await segmentTitle(targetId)),
      createdAt: Date.now(),
      entryCount: fresh.length,
      tailEntryId: String(tail.id),
      // 归档段只留简化日志：哈希 + 汇总，不存正文/资产（D4）
      filesChanged: rollbackLog.length,
      rolledBack: segmentMeta?.rolledBack === true,
      rollbackLog: rollbackLog.length > 0 ? rollbackLog : undefined,
    }
    await snapshots!.append(info, fresh)
    archivedTail.set(targetId, { snapshotId: info.id, tail: Number(tail.id) })
    // 保存封段：活跃段置为 sealed，下次发送自动开新段（D4）
    if (segmentMeta) {
      segmentMeta.sealed = true
      delete segmentMeta.rollbackLog
      delete segmentMeta.rolledBack
      segmentMeta.updatedAt = Date.now()
    }
    // 归档段不可主动回滚：清掉该段的历史 Run 记录（刷新后也不会再出现回滚图标）
    try {
      await runRollbackDb.clear(runRollbackKey(options.scope, options.windowId, targetId))
    } catch {
      /* 清不掉只是残留，下次打开会先当作不可回滚处理 */
    }
    return info
  }

  const runtime: AgentRuntime = {
    open,

    async listSegments(): Promise<SegmentInfo[]> {
      if (!opened) await open()
      const records = await listOwnerlessConversations()
      const list: SegmentInfo[] = []
      for (const record of records) {
        const id = String(record.id)
        const meta = metaStore[id]
        const title = await segmentTitle(id)
        list.push({
          id,
          title,
          createdAt: meta?.createdAt ?? 0,
          updatedAt: meta?.updatedAt ?? 0,
          windowId: options.windowId,
          state: meta?.sealed ? 'sealed' : id === segmentId ? 'active' : 'dormant',
          runCount: meta?.runCount ?? 0,
          sourceSnapshotId: meta?.sourceSnapshotId,
        })
      }
      list.sort((a, b) => b.updatedAt - a.updatedAt)
      return list
    },

    async createSegment(title): Promise<SegmentInfo> {
      if (!opened) await open()
      const target = await harness!.createConversation(
        { ownership: { kind: 'ownerless' } },
        ctx,
      )
      metaStore[String(target.id)] = {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        title,
        runCount: 0,
      }
      writeSegmentMeta(options.scope, options.windowId, metaStore)
      clearPendingRollback()
      await attach(target)
      rememberCurrentSegment()
      const id = String(target.id)
      return {
        id,
        title: title ?? (await segmentTitle(id)),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        windowId: options.windowId,
        state: 'active',
        runCount: 0,
      }
    },

    async renameSegment(id: string, title: string): Promise<SegmentInfo> {
      if (!opened) await open()
      const trimmed = title.trim()
      if (!trimmed) throw new Error('段标题不能为空')
      if (trimmed.length > 80) throw new Error('段标题过长（最多 80 个字符）')
      const meta = metaStore[id] ?? {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        runCount: 0,
      }
      meta.title = trimmed
      meta.updatedAt = Date.now()
      metaStore[id] = meta
      writeSegmentMeta(options.scope, options.windowId, metaStore)
      emit()
      return {
        id,
        title: trimmed,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        windowId: options.windowId,
        state: meta.sealed ? 'sealed' : id === segmentId ? 'active' : 'dormant',
        runCount: meta.runCount,
        sourceSnapshotId: meta.sourceSnapshotId,
      }
    },

    async forkSegment(forkOptions?: ForkSegmentOptions): Promise<SegmentInfo> {
      if (!opened) await open()
      if (!conversation || segmentId === null) throw new Error('会话段未就绪')
      if (runState === 'running') throw new Error('运行中的会话不能分支，请先停止本轮')
      const sourceId = segmentId
      const source = conversation
      // 复制条目而不是原生 fork：新段自包含，源段（含封存段）被删也不丢历史。
      const entries = await collectEntries(source)
      let kept = entries
      if (forkOptions?.beforeEntryId) {
        const index = entries.findIndex((entry) => String(entry.id) === String(forkOptions.beforeEntryId))
        if (index < 0) throw new Error('找不到要分支的消息，可能已被删除')
        kept = entries.slice(0, index)
      }
      const drafts = forkEntryDrafts(kept as ForkSourceEntry[])
      const target = await harness!.createConversation(
        { ownership: { kind: 'ownerless' } },
        ctx,
      )
      if (drafts.length > 0) {
        // 一次性提交：分支的对话要么整段进来，要么一条都不进
        await target.commit(async (tx) => {
          for (const draft of drafts) {
            await tx.appendEntry(target.id, draft as never)
          }
        }, ctx)
      }

      const label = forkOptions?.label ?? (forkOptions?.beforeEntryId ? 'branch' : 'inherit')
      const suffix = label === 'inherit' ? '（继承）' : '（分支）'
      const base = ((await segmentTitle(sourceId)) || '对话').trim() || '对话'
      const id = String(target.id)
      const now = Date.now()
      const latestSnapshot = snapshots
        ? (await snapshots.list())
            .filter((item) => item.segmentId === sourceId)
            .sort((a, b) => b.createdAt - a.createdAt)[0]
        : undefined
      metaStore[id] = {
        createdAt: now,
        updatedAt: now,
        title: base.slice(0, Math.max(0, 80 - suffix.length)) + suffix,
        runCount: 0,
        ...(latestSnapshot ? { sourceSnapshotId: latestSnapshot.id } : {}),
      }
      writeSegmentMeta(options.scope, options.windowId, metaStore)
      clearPendingRollback()
      await attach(target)
      rememberCurrentSegment()
      return {
        id,
        title: metaStore[id]!.title!,
        createdAt: now,
        updatedAt: now,
        windowId: options.windowId,
        state: 'active',
        runCount: 0,
        sourceSnapshotId: metaStore[id]!.sourceSnapshotId,
      }
    },

    async selectSegment(id: string): Promise<void> {
      if (!opened) await open()
      if (id === segmentId) return
      const target = await harness!.conversation(Number(id) as never, ctx)
      if (!target) throw new Error(`会话段不存在：${id}`)
      extraItems = []
      clearPendingRollback()
      await attach(target)
      rememberCurrentSegment()
    },

    view: () => currentView,

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async run(text: string): Promise<AgentRunResult> {
      if (!opened) await open()
      if (!conversation) return { ok: false, error: '会话段未就绪' }
      if (runState === 'running') return { ok: false, error: '上一个 Run 还没结束' }
      // 文档 §7：保存事务进行中禁止启动 Run（写入会插在"文件已提交、归档段未产出"的两阶段之间）
      if (options.canStartRun && !options.canStartRun()) {
        return { ok: false, error: '工程正在保存，暂不可启动 Agent Run' }
      }
      // 已封存的段不再接受 Run（D4）：发送即自动开一个**继承该段**的新活跃段
      // （不是空段——用户默认预期是接着刚才的对话继续，而不是从零开始）
      if (segmentId && metaStore[segmentId]?.sealed) {
        await runtime.forkSegment({ label: 'inherit' })
      }

      abortRequested = false
      // 上一轮「停止」留下的改动：用户继续发消息 = 保留这些草稿，清掉回滚卡片与日志
      if (pendingRollback?.reason === 'stopped') {
        if (pendingRunKey) {
          appendSegmentLog(pendingRunKey)
          // 保留改动：这一轮之后仍可通过消息左侧图标回滚
          await recordRollbackRun(pendingRunKey, runUserEntryIds.get(pendingRunKey))
        }
        clearPendingRollback()
        await clearPendingJournal()
      }

      const runKey = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      lastRunKey = runKey
      extraItems = []
      runState = 'running'
      statusText = '已提交…'
      emit()

      let failureText: string | undefined
      /** 用户主动停止：不当作失败，也**不自动回滚**（改动保留为草稿，由用户选择） */
      let stopped = false

      try {
        // 模型选择是"下次 Run 生效"的：每轮前按当前配置改一次（configure 只写 pi.agent 文档，不产生对话条目）
        await conversation.configure(
          {
            model: { provider: 'deepseek', modelId: normalizeModelId(getAgentModelId()) },
            thinkingLevel: getAgentThinkingLevel(),
          },
          ctx,
        )
        const submission = await conversation.submit({ type: 'input', content: text }, ctx)
        const settled = await submission.wait(ctx)
        // 记下触发这一轮的 user 条目 id：成功/停止/失败「保留」时把撤销日志挂到这条消息上
        if ('entry' in settled && settled.entry !== undefined) {
          runUserEntryIds.set(runKey, String(settled.entry))
        }
        if (settled.status !== 'done') {
          if (settled.reason === 'aborted' || abortRequested) stopped = true
          else failureText = runFailureText(settled.reason)
        }
      } catch (error) {
        failureText = error instanceof Error ? error.message : String(error)
      }
      abortRequested = false

      // Run 收尾：未消费的锁一律释放（文档 §8 第三档兜底）
      await Promise.resolve(locks.releaseRun(runKey))
      await Promise.resolve(arbiter.endRound())
      emit()

      const meta = metaStore[segmentId ?? '']
      if (meta) {
        meta.updatedAt = Date.now()
        meta.runCount += 1
        writeSegmentMeta(options.scope, options.windowId, metaStore)
      }

      // 用户停止：不自动回滚。改动已在草稿里，保留撤销日志并挂出「回滚 / 保留」选择
      if (stopped) {
        const hasChanges = undo.has(runKey)
        if (hasChanges) {
          pendingRunKey = runKey
          pendingRollback = {
            status: 'pending',
            reason: 'stopped',
            conflicts: [],
            createdAt: Date.now(),
          }
          await persistPendingRollback(runKey, 'stopped')
        } else {
          clearPendingRollback()
        }
        extraItems = [
          ...extraItems,
          {
            id: `stopped:${Date.now()}`,
            kind: 'notice',
            text: hasChanges
              ? '已停止：本次改动保留为本地草稿，可在下方选择回滚本次改动或保留。'
              : '已停止。',
          },
        ]
        runState = 'aborted'
        statusText = ''
        emit()
        return { ok: true }
      }

      if (!failureText) {
        appendSegmentLog(runKey)
        // 成功 Run 也留一份撤销日志：用户可事后从消息左侧主动回滚
        await recordRollbackRun(runKey, runUserEntryIds.get(runKey))
        undo.discard(runKey)
        runState = 'idle'
        statusText = ''
        emit()
        return { ok: true }
      }

      // 页面存活时的失败/中止：先预演；全部安全才自动回滚，否则一个文件都不动、挂成待处理回滚
      let undoOutcomes: UndoOutcome[] | undefined
      /** 自动回滚成功后要写进对话的回滚通知（用户与模型都需要知道改动被撤回） */
      let autoRollbackNotice:
        | { runKey: string; userEntryId?: string; files: string[] }
        | undefined
      if (undo.has(runKey)) {
        const preflight = await undo.preflight(runKey)
        if (preflight.safe) {
          try {
            autoRollbackNotice = {
              runKey,
              userEntryId: runUserEntryIds.get(runKey),
              files: undo.entriesOf(runKey).map((entry) => entry.path),
            }
            undoOutcomes = await undo.rollback(runKey)
            // 回放后只清写出记录；真正释放 before-image 要 discard（日志只存内存，不落盘）
            undo.discard(runKey)
            markSegmentRolledBack()
            await clearPendingJournal()
          } catch (error) {
            undoOutcomes = []
        failureText += `\n（回滚时出错：${error instanceof Error ? error.message : String(error)}）`
          }
        } else {
          // 预演有冲突：交给失败卡片的三选项（强制 / 放弃 / 让 Agent 帮忙处理冲突）
          clearPendingRollback()
          pendingRunKey = runKey
          pendingRollback = {
            status: 'pending',
            conflicts: preflight.conflicts,
            createdAt: Date.now(),
          }
          // 刷新后还能强制/放弃/重试：把日志与冲突写进活跃段库
          await persistPendingRollback(runKey)
        }
      }
      const failedItem = failureItem(failureText, undoOutcomes)
      if (pendingRunKey === runKey && pendingRollback) pendingRollback.runItemId = failedItem.id
      extraItems = [...extraItems, failedItem]
      runState = 'failed'
      statusText = ''
      if (autoRollbackNotice) {
        await appendRollbackNotice({
          runs: [autoRollbackNotice],
          outcomes: undoOutcomes ?? [],
          auto: true,
        })
      }
      emit()
      return {
        ok: false,
        error: failureText,
        undo: undoOutcomes,
        rolledBack: (undoOutcomes ?? []).length > 0,
      }
    },

    async abort(): Promise<void> {
      if (!conversation) return
      // 标记为用户停止：收尾时跳过自动回滚（D3 修订：停止不撤销改动，由用户主动选择）
      if (runState === 'running') {
        abortRequested = true
        statusText = '正在停止…'
        emit()
      }
      await conversation.abort(ctx)
      emit()
    },

    async forceRollback(): Promise<UndoOutcome[]> {
      if (!pendingRunKey || !pendingRollback) return []
      const forcedRunKey = pendingRunKey
      const forcedUserEntryId = runUserEntryIds.get(forcedRunKey)
      const forcedFiles = undo.has(forcedRunKey)
        ? undo.entriesOf(forcedRunKey).map((entry) => entry.path)
        : []
      const outcomes = await undo.force(forcedRunKey)
      undo.discard(forcedRunKey)
      pendingRunKey = null
      pendingRollback = { ...pendingRollback, status: 'failed', conflicts: [], outcomes }
      markSegmentRolledBack()
      await clearPendingJournal()
      // 告知用户与模型：这次强制回滚撤销了哪些改动
      await appendRollbackNotice({
        runs: [{ runKey: forcedRunKey, userEntryId: forcedUserEntryId, files: forcedFiles }],
        outcomes,
        forced: true,
      })
      emit()
      return outcomes
    },

    async abandonRollback(): Promise<void> {
      if (!pendingRollback && !pendingRunKey) return
      // 放弃回滚 = 这些改动留在草稿里，归档简化日志要带上；同时保留成可主动回滚的 Run
      if (pendingRunKey) {
        appendSegmentLog(pendingRunKey)
        await recordRollbackRun(pendingRunKey, runUserEntryIds.get(pendingRunKey))
      }
      clearPendingRollback()
      await clearPendingJournal()
      emit()
    },

    async rollbackRun(runKey: string, options?: ManualRollbackOptions): Promise<AgentRollbackResult> {
      // 只允许回滚后缀轮：单轮回滚若目标之后还有记录，会留下后续轮次的改动。
      // 界面只对最后一轮提供「仅回滚这一轮」，这里做防御，避免其它入口绕过。
      const target = runRollbacks.get(runKey)
      if (target) {
        const hasNewer = [...runRollbacks.values()].some(
          (record) => record.createdAt > target.createdAt,
        )
        if (hasNewer) {
          return {
            ok: false,
            rolledBackRuns: [],
            outcomes: [],
            conflicts: [],
            error: '只能回滚最后一轮；更早的轮次请使用「回滚这一轮及之后」',
          }
        }
      }
      return runManualRollback([runKey], options)
    },

    async rollbackFromRun(runKey: string, options?: ManualRollbackOptions): Promise<AgentRollbackResult> {
      const base = runRollbacks.get(runKey)
      if (!base) return { ok: true, rolledBackRuns: [], outcomes: [], conflicts: [] }
      const keys = [...runRollbacks.values()]
        .filter((record) => record.createdAt >= base.createdAt)
        .map((record) => record.runKey)
      return runManualRollback(keys, options)
    },

    async rollbackAll(options?: ManualRollbackOptions): Promise<AgentRollbackResult> {
      return runManualRollback([...runRollbacks.keys()], options)
    },

    changedPaths(): string[] {
      if (segmentId && metaStore[segmentId]?.sealed) return []
      const paths = new Set<string>()
      for (const record of runRollbacks.values()) {
        for (const entry of record.entries) paths.add(entry.path)
      }
      if (pendingRunKey && undo.has(pendingRunKey)) {
        for (const entry of undo.entriesOf(pendingRunKey)) paths.add(entry.path)
      }
      return [...paths].sort()
    },

    async retryRollback(): Promise<{
      ok: boolean
      outcomes: UndoOutcome[]
      conflicts: UndoConflict[]
    }> {
      if (!pendingRunKey || !pendingRollback) return { ok: true, outcomes: [], conflicts: [] }
      const preflight = await undo.preflight(pendingRunKey)
      if (!preflight.safe) {
        pendingRollback = { ...pendingRollback, conflicts: preflight.conflicts }
        emit()
        return { ok: false, outcomes: [], conflicts: preflight.conflicts }
      }
      const retryRunKey = pendingRunKey
      const retryUserEntryId = runUserEntryIds.get(retryRunKey)
      const retryFiles = undo.has(retryRunKey)
        ? undo.entriesOf(retryRunKey).map((entry) => entry.path)
        : []
      const outcomes = await undo.rollback(retryRunKey)
      undo.discard(retryRunKey)
      pendingRunKey = null
      pendingRollback = { ...pendingRollback, conflicts: [], outcomes }
      markSegmentRolledBack()
      await clearPendingJournal()
      await appendRollbackNotice({
        runs: [{ runKey: retryRunKey, userEntryId: retryUserEntryId, files: retryFiles }],
        outcomes,
      })
      emit()
      return { ok: true, outcomes, conflicts: [] }
    },

    async archive(title?: string): Promise<SnapshotInfo | null> {
      if (!opened) await open()
      if (!conversation || !snapshots || !segmentId) return null
      // 当前段的待处理回滚（失败或用户停止）在保存时=放弃回滚，但改动仍要进本段简化日志
      if (pendingRunKey) appendSegmentLog(pendingRunKey)
      const currentInfo = await archiveSegment(segmentId, conversation, title)

      // 保存 = 归档**所有**活跃段，而不只是当前段：否则其它活跃段仍可继续写，
      // 下次保存/继承时会出现「一部分归档、一部分还在跑」的割裂状态。
      const records = await listOwnerlessConversations()
      for (const record of records) {
        const id = String(record.id)
        if (id === segmentId || metaStore[id]?.sealed) continue
        const target = await harness!.conversation(record.id, ctx)
        if (!target) continue
        try {
          await archiveSegment(id, target)
        } catch {
          /* 单个段归档失败不阻断保存与其它段 */
        }
      }

      // 保存封段后这次 Run 不再可回滚（D3：保存 = 放弃回滚，不弹提示）
      clearPendingRollback()
      await clearPendingJournal()
      runRollbacks = new Map()
      runUserEntryIds.clear()
      // 段元数据统一落盘一次
      writeSegmentMeta(options.scope, options.windowId, metaStore)
      emit()
      return currentInfo
    },

    async snapshotItems(snapshotId: string): Promise<AgentViewItem[]> {
      if (!snapshots) return []
      const entries = (await snapshots.readEntries(snapshotId)) as EntryRecord[]
      return entryRecordsToItems(entries)
    },

    async forkSnapshot(snapshotId: string): Promise<SegmentInfo> {
      if (!opened) await open()
      const list = await snapshots!.list()
      const source = list.find((item) => item.id === snapshotId)
      if (!source) throw new Error('归档段不存在，可能已被删除')
      const drafts = forkEntryDrafts(
        (await snapshots!.readEntries(snapshotId)) as ForkSourceEntry[],
      )

      const target = await harness!.createConversation(
        { ownership: { kind: 'ownerless' } },
        ctx,
      )
      if (drafts.length > 0) {
        // 一次性提交：继承的对话要么整段进来，要么一条都不进
        await target.commit(async (tx) => {
          for (const draft of drafts) {
            await tx.appendEntry(target.id, draft as never)
          }
        }, ctx)
      }

      const id = String(target.id)
      const now = Date.now()
      metaStore[id] = {
        createdAt: now,
        updatedAt: now,
        title: `${source.title || '对话'}（继承）`,
        runCount: 0,
        sourceSnapshotId: snapshotId,
      }
      writeSegmentMeta(options.scope, options.windowId, metaStore)
      clearPendingRollback()
      await attach(target)
      rememberCurrentSegment()
      return {
        id,
        title: metaStore[id]!.title!,
        createdAt: now,
        updatedAt: now,
        windowId: options.windowId,
        state: 'active',
        runCount: 0,
        sourceSnapshotId: snapshotId,
      }
    },

    async deleteSnapshot(snapshotId: string): Promise<{ snapshots: number; segments: number }> {
      if (!opened) await open()
      const list = await snapshots!.list()
      if (!list.some((item) => item.id === snapshotId)) return { snapshots: 0, segments: 0 }

      // 级联：该归档 + 所有直接/间接继承它的归档；再带上从这些归档继承出来的活跃段
      const doomedSnapshots = descendantSnapshotIds(list, snapshotId)
      const doomedSegments = Object.entries(metaStore)
        .filter(
          ([, meta]) =>
            meta.sourceSnapshotId !== undefined && doomedSnapshots.has(meta.sourceSnapshotId),
        )
        .map(([id]) => id)
      const affectsCurrent = segmentId !== null && doomedSegments.includes(segmentId)

      // pi-durable 要求一个库只有一个 owner：删记录前先关 Harness
      await teardownHarness()
      try {
        for (const sid of doomedSegments) {
          await deleteSegmentRecords({
            databaseName: segmentDbName(options.windowId, options.scope),
            conversationId: Number(sid),
          })
        }
        // 归档从叶子往根删：删父之前不能还有子引用它（SnapshotStore.remove 会拒绝被引用的父）
        const remaining = new Set(doomedSnapshots)
        let guard = 0
        while (remaining.size > 0 && guard++ < 10_000) {
          const referenced = new Set<string>()
          for (const item of list) {
            if (
              item.id !== undefined &&
              remaining.has(item.id) &&
              item.parentSnapshotId &&
              remaining.has(item.parentSnapshotId)
            ) {
              referenced.add(item.parentSnapshotId)
            }
          }
          const leaf = [...remaining].find((id) => !referenced.has(id))
          if (!leaf) break
          await snapshots!.remove(leaf)
          remaining.delete(leaf)
        }
      } finally {
        for (const sid of doomedSegments) {
          delete metaStore[sid]
          archivedTail.delete(sid)
        }
        writeSegmentMeta(options.scope, options.windowId, metaStore)
        if (affectsCurrent) forgetCurrentSegment()
        // 删完把运行时恢复可用（当前段若被级联删除会自动换一段）
        await open()
      }
      return { snapshots: doomedSnapshots.size, segments: doomedSegments.length }
    },

    async listSnapshots(): Promise<SnapshotInfo[]> {
      if (!snapshots) return []
      return snapshots.list()
    },

    async storageUsage(): Promise<number> {
      if (!snapshots) return 0
      return snapshots.usage()
    },

    async persistStorage(): Promise<boolean> {
      return persistStorage()
    },

    async deleteSegment(id: string): Promise<void> {
      if (!opened) await open()
      // 正在跑 Run 时删段会连带中止对话：要求先停（工作区也会禁用按钮，这里再兜一层）
      if (runState === 'running') {
        throw new Error('Agent 正在运行，先停止再删除活跃段')
      }
      const isCurrent = id === segmentId
      const conversationId = Number(id)
      if (!Number.isFinite(conversationId)) throw new Error(`活跃段 id 无效：${id}`)
      const rollbackRecordKey = runRollbackKey(options.scope, options.windowId, id)

      // pi-durable 要求一个库只有一个 owner，删除记录前必须关掉 Harness
      await teardownHarness()
      try {
        await deleteSegmentRecords({
          databaseName: segmentDbName(options.windowId, options.scope),
          conversationId,
        })
      } finally {
        delete metaStore[id]
        writeSegmentMeta(options.scope, options.windowId, metaStore)
        archivedTail.delete(id)
        void undoJournal
          .clear(undoJournalKey(options.scope, options.windowId, id))
          .catch(() => undefined)
        void runRollbackDb.clear(rollbackRecordKey).catch(() => undefined)
        if (isCurrent) {
          forgetCurrentSegment()
          clearPendingRollback()
        }
        // 无论删除成功与否都把运行时恢复可用：删的是段，不是整个面板
        await open()
      }
    },

    async close(): Promise<void> {
      await teardownHarness()
      snapshots = null
      clearPendingRollback()
      runState = 'idle'
      emit()
    },
  }

  return runtime
}

/** `unanswered` 的 reason/detail → 人话（文档 §7：失败 Run 的成因要能解释） */
function runFailureText(reason: string | undefined): string {
  const map: Record<string, string> = {
    model_error: '模型请求失败，请检查 API Key 与网络后重试',
    no_model: '没有可用模型，请检查 API 设置里的模型名',
    aborted: '已停止',
    reset: '对话已重置',
    faulted: '运行出错，可重试',
    orphaned: '页面重开后无法继续这次对话',
    interrupted: '模型请求被中断，可重试',
    restart_limit: '连续中断次数过多，可重试',
    nothing_to_answer: '没有需要回答的内容',
    turn_limit: '工具调用轮次达到上限',
  }
  const head = map[reason ?? ''] ?? (reason || '运行失败')
  return head
}

/** 供工作区/面板清空密钥时使用；避免它们各自 import config 与 PI 层 */
export { clearAgentApiKey }
