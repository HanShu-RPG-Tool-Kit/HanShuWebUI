/**
 * Run 撤销日志（文档 §7 + 修正草案 D3「有序操作日志 + 预演 + 三选项」）。
 *
 * 三条边界：
 * 1. **只回滚工程草稿，不回滚对话条目**（§7 首段）；agent 没有结构操作（D1b），
 *    所以不存在反向 S 事务，回放只是把文本草稿写回工作区。
 * 2. **只在页面存活、且活跃段内可用**；日志只存内存，刷新／崩溃后不存在回放（§7）。
 * 3. **预演先于动手**：回滚前逐条判断，任一冲突就一个文件都不动（D3 all-or-nothing）；
 *    冲突交给失败卡片处理（强制回滚 / 让 agent 处理冲突 / 放弃）。
 *
 * 为什么用「有序操作日志」而不是「路径 → before-image 表」：同一路径可能被写多次，
 * 路径表无法表达组合语义；而且语言草稿与源文件各有各的回放通道（`write` / `writeLang`），
 * 必须逐条记录通道（D3）。
 *
 * 数据结构：`entries` 按**首次写入**顺序排列，同一 path 只有一条（after 取最后一次写入）；
 * 写前快照在 `recordBefore` 时暂存，`recordWrite` 才升级成条目 —— 只有真正写过的文件
 * 才需要回滚，失败在写之前的占位不该出现在日志里。
 */
import type {
  AgentFileWorld,
  AgentPath,
  UndoBeforeImage,
  UndoChannel,
  UndoConflict,
  UndoConflictReason,
  UndoEntry,
  UndoOutcome,
  UndoPreflight,
  VersionedFile,
} from '../contracts'
import { versionedFile } from './version'

/** 暂存的写前快照；通道在 `recordBefore` 时确定（回放要选对通道） */
type PendingBefore = {
  channel: UndoChannel
  before: UndoBeforeImage
}

type RunLog = {
  /** 有序操作日志：按首次写入顺序；同一 path 只保留一条（after 更新为最后一次） */
  entries: UndoEntry[]
  /** path → entries 下标（同一路径去重） */
  byPath: Map<AgentPath, number>
  /** 记了写前、但还没写出（没 `recordWrite`）的路径；只有写过才升级成条目 */
  pending: Map<AgentPath, PendingBefore>
  /** 先写后记（缺写前快照）的路径：预演报 `no_before_image` */
  missingBefore: Set<AgentPath>
  /** 已经回放过一轮：再回放只报 finished，不重复写盘 */
  replayed: boolean
}

export class RunUndoLog {
  private readonly world: AgentFileWorld
  private readonly runs = new Map<string, RunLog>()

  constructor(world: AgentFileWorld) {
    this.world = world
  }

  /** 该 Run 是否有可回放的条目（facade 据此决定要不要预演／挂失败卡片） */
  has(runId: string): boolean {
    const log = this.runs.get(runId)
    return log !== undefined && log.entries.length > 0
  }

  /**
   * 写前记 before-image（同 Run 同 path 只记第一次）。
   * 源文件与语言草稿都走 `world.read`：阶段 2 的宿主已经草稿优先，
   * 所以 `.lang` 读到的就是 staged 内容哈希，不需要另开版本通道。
   */
  async recordBefore(
    runId: string,
    path: AgentPath,
    channel: UndoChannel,
  ): Promise<void> {
    const log = this.logOf(runId)
    if (log.replayed) return
    // 已经有条目（本 Run 已写过该路径）或已暂存：写前快照只记第一次
    if (log.byPath.has(path) || log.pending.has(path)) return
    const current = await versionedFile(this.world, path)
    log.pending.set(path, {
      channel,
      before: {
        content: current === null ? null : current.content,
        version: current === null ? null : current.version,
      },
    })
  }

  /**
   * 记本 Run 写出时的版本：统一对同一 path 更新 `after`（最后一次写出的那一版才是守卫基准）。
   * 如果没记过写前快照，补一条 `no_before_image` 条目 —— 预演会报冲突，不会假装能回滚。
   */
  recordWrite(
    runId: string,
    path: AgentPath,
    channel: UndoChannel,
    written: VersionedFile,
  ): void {
    const log = this.logOf(runId)
    const index = log.byPath.get(path)
    if (index !== undefined) {
      log.entries[index].after = written.version
      return
    }
    const pending = log.pending.get(path)
    log.pending.delete(path)
    const before: UndoBeforeImage = pending?.before ?? { content: null, version: null }
    if (pending === undefined) log.missingBefore.add(path)
    log.entries.push({
      // 缺写前快照时当成普通 write（不是 create）：预演会以 no_before_image 冲突拦下，
      // 绝不能把它误判成「本 Run 新建的文件」而在 force 里删掉别人已有的内容。
      kind: pending !== undefined && before.content === null ? 'create' : 'write',
      channel: pending?.channel ?? channel,
      path,
      before,
      after: written.version,
    })
    log.byPath.set(path, log.entries.length - 1)
  }

  /** 日志条目快照（facade 做活跃段持久化 / 视图用；返回副本，外部改不到内部状态） */
  entriesOf(runId: string): UndoEntry[] {
    const log = this.runs.get(runId)
    if (log === undefined) return []
    return log.entries.map(cloneEntry)
  }

  /**
   * 回滚预演（D3）：逐条判断能否安全恢复。
   * - 当前内容 == 写前内容 → 无需动作（safe）；
   * - 当前版本 == 本 Run 写出版本 → 可恢复（safe）；
   * - 人类正在编辑 → `human_editing`；
   * - 语言通道但宿主没提供 `writeLang` → `unavailable`；
   * - 其它 → `version_stale`。
   * 任一不安全 → `{safe:false, conflicts}`，调用方**不得**动任何文件。
   */
  async preflight(runId: string): Promise<UndoPreflight> {
    const log = this.runs.get(runId)
    if (log === undefined) return { safe: true, entries: [] }
    const entries = log.entries.map(cloneEntry)
    const conflicts: UndoConflict[] = []
    for (const entry of log.entries) {
      const reason = await this.conflictOf(log, entry)
      if (reason !== null) {
        conflicts.push({ path: entry.path, channel: entry.channel, reason })
      }
    }
    if (conflicts.length > 0) return { safe: false, conflicts, entries }
    return { safe: true, entries }
  }

  /**
   * Run 失败 → 预演通过后**逆序**回放；预演有冲突则一个文件都不动，
   * 返回逐条的 `conflict` 结论供失败卡片展示（D3）。
   */
  async rollback(runId: string): Promise<UndoOutcome[]> {
    const log = this.runs.get(runId)
    if (log === undefined) return []

    const preflight = await this.preflight(runId)
    if (!preflight.safe) {
      // 冲突时保留日志（用户可能选择强制/重试/让 agent 处理），不能标记 replayed
      return preflight.conflicts.map(conflict => ({
        path: conflict.path,
        channel: conflict.channel,
        action: 'conflict',
        reason: conflict.reason,
      }))
    }

    const outcomes: UndoOutcome[] = []
    for (const entry of [...log.entries].reverse()) {
      const current = await versionedFile(this.world, entry.path)
      if ((current === null ? null : current.content) === entry.before.content) {
        outcomes.push({ path: entry.path, channel: entry.channel, action: 'finished' })
        continue
      }
      await this.apply(entry)
      outcomes.push({
        path: entry.path,
        channel: entry.channel,
        action: entry.before.content === null ? 'deleted' : 'restored',
      })
    }
    log.replayed = true
    return outcomes
  }

  /**
   * 强制回滚（D3 失败卡片的第二个选项）：跳过版本守卫与人类脏编辑判断，逐条写回写前内容。
   * 仍跳过两类无法恢复的条目：没有写前快照（`no_before_image`）、语言通道不可用（`unavailable`）。
   * 调用方应先给用户明确警告。
   */
  async force(runId: string): Promise<UndoOutcome[]> {
    const log = this.runs.get(runId)
    if (log === undefined) return []

    const outcomes: UndoOutcome[] = []
    for (const entry of [...log.entries].reverse()) {
      if (log.missingBefore.has(entry.path)) {
        outcomes.push({
          path: entry.path,
          channel: entry.channel,
          action: 'skipped',
          reason: 'no_before_image',
        })
        continue
      }
      if (entry.channel === 'lang' && this.world.writeLang === undefined) {
        outcomes.push({
          path: entry.path,
          channel: entry.channel,
          action: 'skipped',
          reason: 'unavailable',
        })
        continue
      }
      const current = await versionedFile(this.world, entry.path)
      if ((current === null ? null : current.content) === entry.before.content) {
        outcomes.push({ path: entry.path, channel: entry.channel, action: 'finished' })
        continue
      }
      await this.apply(entry)
      outcomes.push({
        path: entry.path,
        channel: entry.channel,
        action: entry.before.content === null ? 'deleted' : 'restored',
      })
    }
    log.replayed = true
    return outcomes
  }

  /** Run 成功 / 放弃回滚 → 丢弃日志（§7「成功 → 丢弃日志」，D3「放弃回滚」） */
  discard(runId: string): void {
    this.runs.delete(runId)
  }

  /**
   * 活跃段持久化用：可直接 JSON 序列化的条目副本（等价于 `entriesOf`，名字更贴近持久化用途）。
   * 条目只含 `{kind, channel, path, before{content,version}, after}`，纯数据、无 Map/Set。
   */
  serialize(runId: string): UndoEntry[] {
    return this.entriesOf(runId)
  }

  /**
   * 刷新后把持久化的条目装回日志（D4：活跃段日志落 IndexedDB，刷新后回滚入口仍可用）。
   *
   * - 覆盖该 run 现有日志，`replayed` 复位为 false（刷新后仍允许回滚）；
   * - 持久化数据里 `kind:'write'` 且 before 全 null 的条目，重新标记成 `no_before_image`
   *   （旧实现没记写前快照的遗留数据；预演会报冲突，绝不误删别人的内容）；
   * - 同 path 只保留先出现的一条，非法条目直接跳过 —— 回放逻辑不依赖数据可信。
   */
  restore(runId: string, entries: UndoEntry[]): void {
    const log = this.logOf(runId)
    log.entries.length = 0
    log.byPath.clear()
    log.pending.clear()
    log.missingBefore.clear()
    for (const source of entries) {
      if (source === null || typeof source !== 'object') continue
      if (typeof source.path !== 'string' || source.path.length === 0) continue
      if (source.channel !== 'source' && source.channel !== 'lang') continue
      if (source.kind !== 'write' && source.kind !== 'create') continue
      const before: UndoBeforeImage = {
        content: source.before?.content ?? null,
        version: source.before?.version ?? null,
      }
      const entry: UndoEntry = {
        kind: source.kind,
        channel: source.channel,
        path: source.path,
        before,
        after: typeof source.after === 'string' ? source.after : '',
      }
      if (entry.kind === 'write' && before.content === null && before.version === null) {
        log.missingBefore.add(entry.path)
      }
      if (log.byPath.has(entry.path)) continue
      log.byPath.set(entry.path, log.entries.length)
      log.entries.push(entry)
    }
    log.replayed = false
  }

  /** 一条条目的冲突判定；null = 可以安全回放（或无需动作） */
  private async conflictOf(log: RunLog, entry: UndoEntry): Promise<UndoConflictReason | null> {
    if (log.missingBefore.has(entry.path)) return 'no_before_image'
    // 通道不可用要**先于「可恢复」判断**：版本对得上也写不回去，
    // 否则预演会放行一次注定失败的自动回滚（任务描述的顺序里把它排在 version_stale 前）。
    if (entry.channel === 'lang' && this.world.writeLang === undefined) return 'unavailable'
    const current = await versionedFile(this.world, entry.path)
    const content = current === null ? null : current.content
    // 已经等于写前内容（含重复回放）：无需动作
    if (content === entry.before.content) return null
    // 仍是本 Run 写出的那一版：可恢复
    if (current !== null && current.version === entry.after) return null
    if (this.world.isHumanDirty(entry.path)) return 'human_editing'
    return 'version_stale'
  }

  /** 实际回放一条：源文件走工作区草稿通道，语言走 staged 草稿通道 */
  private async apply(entry: UndoEntry): Promise<void> {
    const content = entry.before.content
    if (entry.channel === 'lang') {
      const writeLang = this.world.writeLang
      if (writeLang === undefined) {
        // preflight / force 已经拦过；走到这里说明调用方绕过了检查
        throw new Error(`语言草稿回放不可用：${entry.path}`)
      }
      await writeLang(entry.path, content)
      return
    }
    await this.world.write(entry.path, content)
  }

  private logOf(runId: string): RunLog {
    let log = this.runs.get(runId)
    if (log === undefined) {
      log = {
        entries: [],
        byPath: new Map(),
        pending: new Map(),
        missingBefore: new Set(),
        replayed: false,
      }
      this.runs.set(runId, log)
    }
    return log
  }
}

function cloneEntry(entry: UndoEntry): UndoEntry {
  return { ...entry, before: { ...entry.before } }
}
