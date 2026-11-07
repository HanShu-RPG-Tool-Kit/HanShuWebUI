/**
 * Run 撤销日志（文档 §7「Run 生命周期与原子性」）。
 *
 * 承诺的边界：**页面存活时** Run 失败，未被后续修改覆盖的工程改动被回退；
 * 刷新／崩溃后不存在回放（日志只在内存，不落盘 —— §7 明说「日志只存在内存」）。
 * 只回滚工程文件，不回滚对话条目：失败 Run 在对话里留痕是有价值的（§7 首段）。
 *
 * 为什么回放前要做版本守卫：锁在每次 write 后立即释放，人类或其他 Run 可能随后改了同一文件。
 * 无条件回放会把那些后来的改动一起冲掉，比不回滚更糟 —— 所以原子性是**有条件的**，
 * 被覆盖过的文件跳过并标记「需人工合并」（§7「撤销日志与版本守卫」）。
 */
import type {
  AgentFileWorld,
  AgentPath,
  ContentVersion,
  UndoOutcome,
  VersionedFile,
} from '../contracts'
import { versionedFile } from './version'

type BeforeImage = {
  path: AgentPath
  /** 写前内容；null = 写前文件不存在（回放即删除） */
  content: string | null
  /** 写前版本；null 仅在与 content 同为 null 时出现 */
  version: ContentVersion | null
}

type RunLog = {
  /** 同一 Run 同一 path 只记第一次写前状态，所以这里是「回放目标」而非历史栈 */
  before: Map<AgentPath, BeforeImage>
  /** path → 本 Run 最后一次写出时的内容版本（版本守卫的比对基准） */
  written: Map<AgentPath, ContentVersion>
  /** 首次记录顺序；回放按它的逆序进行 */
  order: AgentPath[]
  /** 已经回放过一轮：再回放只报 finished / version_stale，不重复写盘 */
  replayed: boolean
}

export class RunUndoLog {
  private readonly world: AgentFileWorld
  private readonly runs = new Map<string, RunLog>()

  constructor(world: AgentFileWorld) {
    this.world = world
  }

  /** 该 Run 是否还有未丢弃的 before-image（Run 收尾时据此决定要不要 rollback） */
  has(runId: string): boolean {
    const log = this.runs.get(runId)
    return log !== undefined && log.before.size > 0
  }

  /**
   * 写前记 before-image。同一 Run 同一 path 只记第一次：
   * 一个 Run 内对同一文件多次写入，回放目标始终是「这个 Run 开始动手之前」的内容。
   */
  async recordBefore(runId: string, path: AgentPath): Promise<void> {
    const log = this.logOf(runId)
    if (log.replayed) return
    if (log.before.has(path)) return
    const current = await versionedFile(this.world, path)
    log.before.set(path, {
      path,
      content: current === null ? null : current.content,
      version: current === null ? null : current.version,
    })
    this.noteOrder(log, path)
  }

  /** 记本 Run 写出时的版本；后续写入覆盖前值，守卫比对的是「最后一次写出的那一版」 */
  recordWrite(runId: string, path: AgentPath, written: VersionedFile): void {
    const log = this.logOf(runId)
    log.written.set(path, written.version)
    // 正常路径上 recordBefore 已经排过序；这里兜住「有人漏记 before」的情况，
    // 回放时该 path 会以 no_before_image 跳过，而不是悄悄不动。
    this.noteOrder(log, path)
  }

  /** Run 成功 → 丢弃日志（§7「成功 → 丢弃日志」） */
  discard(runId: string): void {
    this.runs.delete(runId)
  }

  /**
   * Run 失败 → **逆序**回放，每个 path 先过版本守卫。
   * 回放完成后再调用一次会得到 finished（已在目标内容上）或 version_stale（需人工合并），
   * 因此本方法是幂等的；真正释放内存靠 `discard`。
   */
  async rollback(runId: string): Promise<UndoOutcome[]> {
    const log = this.runs.get(runId)
    if (log === undefined) return []

    const outcomes: UndoOutcome[] = []
    for (const path of [...log.order].reverse()) {
      const before = log.before.get(path)
      if (before === undefined) {
        outcomes.push({ path, action: 'skipped', reason: 'no_before_image' })
        continue
      }
      const current = await versionedFile(this.world, path)
      const currentContent = current === null ? null : current.content
      // 已经等于回放目标（含重复回放）→ 不写盘，报 finished
      if (currentContent === before.content) {
        outcomes.push({ path, action: 'finished' })
        continue
      }
      const writtenVersion = log.written.get(path)
      // 版本守卫：当前内容必须仍是本 Run 写出的那一版，否则是别人（人类 / 另一个 Run）的改动
      if (
        writtenVersion === undefined ||
        current === null ||
        current.version !== writtenVersion
      ) {
        outcomes.push({ path, action: 'skipped', reason: 'version_stale' })
        continue
      }
      await this.world.write(path, before.content)
      outcomes.push({
        path,
        action: before.content === null ? 'deleted' : 'restored',
      })
    }

    // 写出记录只对「本轮回放」有意义；清掉后重复回放会走内容比较分支，得到 finished
    log.written.clear()
    log.replayed = true
    return outcomes
  }

  private logOf(runId: string): RunLog {
    let log = this.runs.get(runId)
    if (log === undefined) {
      log = { before: new Map(), written: new Map(), order: [], replayed: false }
      this.runs.set(runId, log)
    }
    return log
  }

  private noteOrder(log: RunLog, path: AgentPath): void {
    if (log.order.includes(path)) return
    log.order.push(path)
  }
}
