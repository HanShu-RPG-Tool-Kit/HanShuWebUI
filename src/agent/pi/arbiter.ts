/**
 * 工具仲裁层：把 `src/agent/tools.ts` 的三语义协议接到「版本表 + 锁表 + Run 撤销日志」上。
 *
 * 这是文档 §8 的落地位置：
 * - read  → 读完整正文、算内容哈希、登记「本 Run 读过这一版」
 * - lock  → LockTable.acquire（多路径原子、不等待、human-dirty 判据）
 * - write → assertWritable 做严格模式拦截 + **写前记录 before-image**；write 成功后 consume 锁
 *
 * 撤销日志的 before-image 在 `assertWritable` 里落：那是「写之前」唯一必然经过的点，
 * 由协议保证（tools.ts 对每个 write 工具都先调它）。
 */

import { paginateSource } from '../agentOps'
import { contentVersion } from '../runtime/version'
import type { LockTable } from '../runtime/lockTable'
import type { RunUndoLog } from '../runtime/runUndo'
import type {
  AgentFileWorld,
  AgentHost,
  AgentOpResult,
  AgentPath,
  AgentToolArbiter,
  ContentVersion,
  LockResult,
  VersionedFile,
} from '../contracts'

/** 宿主读完整正文：优先用 `readFullSource`（>2000 行的文件必须实现它，否则锁版本会被截断） */
async function readFull(host: AgentHost, path: AgentPath): Promise<
  { ok: true; content: string } | { ok: false; error: string }
> {
  const raw = host.readFullSource
    ? host.readFullSource(path)
    : host.readSource(path, 1, 2000)
  if (raw?.ok === false) {
    return { ok: false, error: String(raw.error ?? `无法读取 ${path}`) }
  }
  return { ok: true, content: String(raw.content ?? '') }
}

/**
 * `AgentFileWorld`：锁表与撤销日志看到的世界，全部经过宿主（编辑器缓冲已 flush）。
 * 源文件之外的派生语言资产也在这里可读 —— 锁要覆盖它们（§8 派生资产），
 * 所以 `read` 先按源文件读，读不到再问宿主要语言资产正文。
 */
export function createFileWorld(host: AgentHost): AgentFileWorld {
  return {
    read: async (path) => {
      const full = await readFull(host, path)
      if (full.ok) {
        return { content: full.content, version: await contentVersion(full.content) }
      }
      const asset = await host.readAssetText?.(path)
      if (asset === null || asset === undefined) return null
      return { content: asset, version: await contentVersion(asset) }
    },
    isHumanDirty: (path) => host.isHumanDirty?.(path) === true,
    write: async (path, content) => {
      if (content === null) {
        await host.deleteSource(path)
        return
      }
      // 回放只发生在「本 Run 刚写过、随后失败」的场景：文件一定存在，用 writeSource
      host.writeSource(path, content)
    },
  }
}

type ArbiterOptions = {
  host: AgentHost
  locks: LockTable
  undo: RunUndoLog
  /** 锁层看到的世界；用于判断派生语言资产是否已存在（不存在的不加锁） */
  world?: AgentFileWorld
  /** 当前 Run 的标识（撤销日志/锁归属都按它分组） */
  runKey: () => string
  /** 锁集合变化（拿到/释放）：UI 靠它把文件即时转只读/解除只读 */
  onLockChange?: () => void
}

export class RuntimeArbiter implements AgentToolArbiter {
  private readonly options: ArbiterOptions

  constructor(options: ArbiterOptions) {
    this.options = options
  }

  /**
   * read：返回 content + version，并登记本 Run 读到的版本。
   * 分页在 facade 侧做，但**版本永远按完整正文算**——否则大文件的分页读会让锁校验错位。
   */
  async read(
    source: AgentPath,
    offset?: number,
    limit?: number,
  ): Promise<AgentOpResult> {
    const full = await readFull(this.options.host, source)
    if (!full.ok) return { ok: false, error: full.error }
    const version = await contentVersion(full.content)
    this.options.locks.noteRead(this.options.runKey(), source, version)
    const page = paginateSource(full.content, offset, limit)
    return { ok: true, source, version, ...page }
  }

  /**
   * lock：多路径原子；失败回传当前内容让模型一次往返自愈。
   *
   * 源文件的锁顺带覆盖它**已经存在**的派生语言资产（`assets/<locale>/lang_<ext>/…`）。
   * 新文件还没有语言资产，等 `write_lang` 新建，所以 creating 时不展开。
   * 这样外部改了 `.lang` 却没有改 `.hs` 时，`write_lang` 的写前版本检查能察觉，
   * 而不是"源文件版本没变 → 以为没人动过 → 覆盖别人的译文"（§8 TOCTOU）。
   */
  async lock(
    paths: AgentPath[],
    options?: { creating?: boolean },
  ): Promise<LockResult> {
    const expanded = [...paths]
    if (options?.creating !== true && this.options.host.derivedLangPaths) {
      for (const path of paths) {
        for (const derived of this.options.host.derivedLangPaths(path) ?? []) {
          if (expanded.includes(derived)) continue
          // 派生资产不存在时 `acquire` 会以 not_found 拒绝整批锁：先探一下。
          // 探到内容就把它的版本登记成「本 Run 读过」—— 锁展开是隐式读，
          // 不登记的话 acquire 会以 not_read 拒绝整批。
          const current = this.options.world ? await this.options.world.read(derived) : null
          if (current !== null) {
            this.options.locks.noteRead(this.options.runKey(), derived, current.version)
            expanded.push(derived)
          }
        }
      }
    }
    const result = await this.options.locks.acquire(this.options.runKey(), expanded, options)
    this.options.onLockChange?.()
    return result
  }

  /**
   * write 前置：严格模式。
   * - 未持锁 → 拒绝，hint 直接给出可执行的 lock_source 调用；
   * - 持锁 → 记录 before-image（撤销日志的唯一入口）。
   *
   * 版本守卫在这里**不做二次读**：锁在 acquire 时校验过版本，而人类在 agent 持锁期间
   * 改不了该文件（编辑器转只读），所以中间不存在写窗口。见文档 §8「校验与写入之间不得有 await」。
   */
  async assertWritable(
    source: AgentPath,
    options?: { creating?: boolean },
  ): Promise<
    { ok: true; version: ContentVersion } | { ok: false; error: string; hint?: string }
  > {
    const runKey = this.options.runKey()
    const owner = this.options.locks.ownerOf(source)

    if (options?.creating) {
      if (owner !== runKey) {
        return {
          ok: false,
          error: `路径未占住：${source}`,
          hint: `先 lock_source({paths:["${source}"]}) 占住这个名字；已存在的文件请改用 write_source`,
        }
      }
      // create 语义：锁在 acquire 时确认过「路径不存在」；这里再确认一次（占名期间别人可能建了同名文件）
      const existing = await this.options.locks.readCurrent(source)
      if (existing) {
        return {
          ok: false,
          error: `路径已存在：${source}`,
          hint: '改用 write_source 覆盖已有文件',
        }
      }
      await this.options.undo.recordBefore(runKey, source)
      return { ok: true, version: '' }
    }

    if (owner !== runKey) {
      return {
        ok: false,
        error: `未持锁就写入：${source}`,
        hint: `严格模式：先 lock_source({paths:["${source}"]})，拿到锁再写`,
      }
    }

    const lockedVersion = this.options.locks.lockedVersion(source)
    const current = await this.options.locks.readCurrent(source)
    // 锁在 acquire 时校验过版本；这里兜一层：持锁期间版本变了（人类仍可能在只读前输入）就拒绝
    if (current && lockedVersion && current.version !== lockedVersion) {
      return {
        ok: false,
        error: '文件在持锁期间被改动，写入被拒绝',
        hint: '重新 read_source 拿到新的 version，再 lock_source 一次',
      }
    }
    await this.options.undo.recordBefore(runKey, source)
    return { ok: true, version: lockedVersion ?? '' }
  }

  /**
   * write 成功后：
   * 1. 把「本 Run 读到的版本」更新成刚写出的版本 —— agent 当然知道自己改完的文件长什么样，
   *    同一 Run 里再 lock 同一个文件不该被判 `version_stale`、也不该被迫重新读一遍；
   * 2. 登记撤销日志的写出记录（版本守卫的判据）；
   * 3. 消费锁。
   */
  async noteWritten(source: AgentPath): Promise<void> {
    const runKey = this.options.runKey()
    const file: VersionedFile | null = await this.options.locks.readCurrent(source)
    if (file) {
      this.options.undo.recordWrite(runKey, source, file)
      this.options.locks.noteRead(runKey, source, file.version)
    }
    this.options.locks.consume(runKey, source)
    this.options.onLockChange?.()
  }

  /** 本轮模型回复结束：释放没被 write 消费的锁（锁的持有上限是「一次模型回复」） */
  endRound(): void {
    this.options.locks.releaseRound(this.options.runKey())
    this.options.onLockChange?.()
  }
}
