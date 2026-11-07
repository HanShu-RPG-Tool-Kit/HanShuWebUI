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
import syntaxDocs from '../../help/docs/hanshu-syntax.md?raw'
import { createFileWorld, RuntimeArbiter } from './arbiter'
import { buildModels, normalizeModelId } from './models'
import { buildAgentTools } from './tools'
import { buildRuntimeView, entryRecordsToItems, failureItem, statusOf } from './view'
import { LockTable } from '../runtime/lockTable'
import { RunUndoLog } from '../runtime/runUndo'
import { segmentDbName } from '../store/dbNames'
import { descendantSnapshotIds, forkEntryDrafts, type ForkSourceEntry } from '../store/archiveGraph'
import { deleteSegmentRecords } from '../store/segmentPurge'
import { IndexedDbSnapshotBackend, SnapshotStore, persistStorage } from '../store/snapshotStore'
import type {
  AgentRunResult,
  AgentRunState,
  AgentRuntime,
  AgentRuntimeOptions,
  AgentRuntimeView,
  AgentViewItem,
  SegmentInfo,
  SnapshotInfo,
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
  let opened = false
  let lastRunKey: string | null = null
  /** 每个段上次归档到哪个条目，用于增量补写（进程内即可，归档段记录里也存了 tailEntryId） */
  const archivedTail = new Map<string, { snapshotId: string; tail: number }>()

  // 锁、撤销日志、派生资产版本看到同一个世界
  const world = createFileWorld(options.host)
  const locks = new LockTable(world)
  const undo = new RunUndoLog(world)
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
    currentView = buildRuntimeView({
      segmentId,
      runId,
      runState,
      status: statusText,
      lockedPaths,
      conversationView,
      live,
      extraItems,
    })
    for (const listener of listeners) listener(currentView)
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
          state: id === segmentId ? 'active' : 'dormant',
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

    async selectSegment(id: string): Promise<void> {
      if (!opened) await open()
      if (id === segmentId) return
      const target = await harness!.conversation(Number(id) as never, ctx)
      if (!target) throw new Error(`会话段不存在：${id}`)
      extraItems = []
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

      const runKey = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      lastRunKey = runKey
      extraItems = []
      runState = 'running'
      statusText = '已提交…'
      emit()

      let failureText: string | undefined

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
        if (settled.status !== 'done') {
          failureText = runFailureText(settled.reason)
        }
      } catch (error) {
        failureText = error instanceof Error ? error.message : String(error)
      }

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

      if (!failureText) {
        undo.discard(runKey)
        runState = 'idle'
        statusText = ''
        emit()
        return { ok: true }
      }

      // 页面存活时的失败/中止：按版本守卫回滚**工程文件**（不回滚对话条目）
      let undoOutcomes: UndoOutcome[] | undefined
      try {
        undoOutcomes = undo.has(runKey) ? await undo.rollback(runKey) : []
        // 回放后只清写出记录；真正释放 before-image 要 discard（日志只存内存，不落盘）
        undo.discard(runKey)
      } catch (error) {
        undoOutcomes = []
        failureText += `\n（回滚时出错：${error instanceof Error ? error.message : String(error)}）`
      }
      extraItems = [
        ...extraItems,
        failureItem(failureText, undoOutcomes),
      ]
      runState = 'failed'
      statusText = ''
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
      await conversation.abort(ctx)
      emit()
    },

    async archive(title?: string): Promise<SnapshotInfo | null> {
      if (!opened) await open()
      if (!conversation || !snapshots || !segmentId) return null
      const entries = await collectEntries(conversation)
      if (entries.length === 0) return null

      const previous = archivedTail.get(segmentId)
      const tail = entries[entries.length - 1]!
      const fresh = previous
        ? entries.filter((entry) => Number(entry.id) > previous.tail)
        : entries
      if (fresh.length === 0) return null

      // 父归档段 = 该段最近一次归档段（跨库谱系走自有元数据，文档 §9）
      const existing = await snapshots.list()
      // 谱系：继承来的段 → 父是「被继承的归档」；否则父是该段上一次归档
      const inheritedFrom = metaStore[segmentId]?.sourceSnapshotId
      const parent =
        (inheritedFrom
          ? existing.find((item) => item.id === inheritedFrom)
          : undefined) ??
        existing
          .filter((item) => item.segmentId === segmentId)
          .sort((a, b) => b.createdAt - a.createdAt)[0]

      const info: SnapshotInfo = {
        id: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        scope: options.scope,
        segmentId,
        parentSnapshotId: parent?.id,
        title: title || (await segmentTitle(segmentId)),
        createdAt: Date.now(),
        entryCount: fresh.length,
        tailEntryId: String(tail.id),
      }
      await snapshots.append(info, fresh)
      archivedTail.set(segmentId, { snapshotId: info.id, tail: Number(tail.id) })
      return info
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
        if (isCurrent) forgetCurrentSegment()
        // 无论删除成功与否都把运行时恢复可用：删的是段，不是整个面板
        await open()
      }
    },

    async close(): Promise<void> {
      await teardownHarness()
      snapshots = null
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
