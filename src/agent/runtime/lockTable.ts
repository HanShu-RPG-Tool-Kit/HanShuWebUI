/**
 * 锁表（文档 §8「单窗口并发与三工具协议」、§11 第 10/11 条）。
 *
 * 职责只有两件：记住「本 Run 内读过哪一版」，以及登记「谁占着哪个路径」。
 * 三条硬规则都在这里兜住：
 * 1. **锁不等待**：拿不到立即返回失败，实现里没有任何 promise 排队 —— 所以系统天然无死锁（§11 第 11 条）；
 * 2. **多路径原子**：先全部读、再全部校验、最后全部登记，校验与登记之间不 await（§8「校验与写入之间不得有 await」）；
 * 3. **失败也回传当前内容**：让模型一次往返内自愈（§8「lock 的返回」）。
 *
 * 人类侧的互斥不由本表登记：human-dirty 由 `AgentFileWorld.isHumanDirty` 提供，
 * 「文件被锁 → 编辑器只读」由 UI 读 `lockedPaths()` 实现。本表只登记 Run 的持锁。
 */
import type {
  AgentFileWorld,
  AgentPath,
  ContentVersion,
  LockDenial,
  LockDenyReason,
  LockResult,
  VersionedFile,
} from '../contracts'
import { versionedFile } from './version'

/** 一条持锁记录；`version` 是加锁时校验通过的那一版，write 前要与当前版本比对 */
export type LockInfo = {
  runId: string
  version: ContentVersion
  content: string
  /** create 语义的锁占住的是「不存在的名字」，此时 version 为空串 */
  creating: boolean
  lockedAt: number
}

type Candidate = {
  path: AgentPath
  /** flush 编辑器缓冲后的当前内容；不存在为 null */
  current: VersionedFile | null
}

export class LockTable {
  private readonly world: AgentFileWorld
  private readonly now: () => number
  /** runId → (path → 本 Run 最后读到的版本) */
  private readonly reads = new Map<string, Map<AgentPath, ContentVersion>>()
  /** path → 持锁记录（key 唯一，因此同一路径不可能被两个 Run 同时持有） */
  private readonly locks = new Map<AgentPath, LockInfo>()

  constructor(world: AgentFileWorld, options?: { now?: () => number }) {
    this.world = world
    this.now = options?.now ?? Date.now
  }

  /** read 工具读完后登记「本 Run 读到的是这一版」，是 lock 前置条件 ① 的依据 */
  noteRead(runId: string, path: AgentPath, version: ContentVersion): void {
    let versions = this.reads.get(runId)
    if (versions === undefined) {
      versions = new Map()
      this.reads.set(runId, versions)
    }
    versions.set(path, version)
  }

  /** 本 Run 最后一次读到的版本（没读过返回 undefined），给 facade 的 write 校验用 */
  readVersion(runId: string, path: AgentPath): ContentVersion | undefined {
    return this.reads.get(runId)?.get(path)
  }

  /**
   * 多路径原子加锁（§8 前置条件 ①–⑤）。
   * 失败时一个锁都不登记；成功时全部登记，且在任何 await 之前完成登记。
   */
  async acquire(
    runId: string,
    paths: AgentPath[],
    options?: { creating?: boolean },
  ): Promise<LockResult> {
    const creating = options?.creating === true
    const unique = [...new Set(paths)]
    if (unique.length === 0) {
      return {
        locked: false,
        reason: 'not_found',
        hint: 'paths 为空：lock_source 需要至少一个路径。',
      }
    }

    // 第一步：把每个路径「flush 之后的当前内容」全部读出来。
    // 这时还没有登记任何东西，失败可以直接返回，不会留下半套锁。
    const candidates: Candidate[] = []
    for (const path of unique) {
      candidates.push({ path, current: await versionedFile(this.world, path) })
    }

    // 第二步：纯同步校验 —— 全部通过才继续。这里绝不能有 await（§8 TOCTOU 规则）。
    for (const candidate of candidates) {
      const denial = this.validate(runId, candidate, creating)
      if (denial !== null) return denial
    }

    // 第三步：纯同步登记 —— 与校验同处一个微任务，原子性由此成立。
    for (const candidate of candidates) {
      const current = candidate.current
      this.locks.set(candidate.path, {
        runId,
        version: current === null ? '' : current.version,
        content: current === null ? '' : current.content,
        creating,
        lockedAt: this.now(),
      })
    }

    // 契约里的 LockGrant 只有单个 version/content；多路径时以首路径为准，
    // 逐路径版本请用 lockedVersion()/lockInfo() 取。
    const first = candidates[0].current
    return {
      locked: true,
      version: first === null ? '' : first.version,
      content: first === null ? '' : first.content,
    }
  }

  isLocked(path: AgentPath): boolean {
    return this.locks.has(path)
  }

  /** 当前所有被锁路径；UI 用它把编辑器转只读（§8「人类侧」） */
  lockedPaths(): AgentPath[] {
    return [...this.locks.keys()]
  }

  ownerOf(path: AgentPath): string | null {
    return this.locks.get(path)?.runId ?? null
  }

  /** 某路径被授予的锁版本；未持锁返回 null。write 成功时把它带回给模型。 */
  lockedVersion(path: AgentPath): ContentVersion | null {
    return this.locks.get(path)?.version ?? null
  }

  /** 持锁记录归档段（给 facade 做 write 前的版本校验，避免它依赖内部结构） */
  lockInfo(path: AgentPath): LockInfo | null {
    const lock = this.locks.get(path)
    return lock === undefined ? null : { ...lock }
  }

  /** 直接透传当前内容（flush 后）；facade 写完后再读一次，用内容哈希登记「本 Run 写出的版本」 */
  async readCurrent(path: AgentPath): Promise<VersionedFile | null> {
    return await versionedFile(this.world, path)
  }

  /**
   * 生命周期 ①：锁被 write 消费 → 立即释放（§8「锁的生命周期」）。
   * 返回是否真的释放了（不是本 Run 的锁就返回 false，不误放别人的锁）。
   */
  consume(runId: string, path: AgentPath): boolean {
    const lock = this.locks.get(path)
    if (lock === undefined || lock.runId !== runId) return false
    this.locks.delete(path)
    return true
  }

  /** 生命周期 ②：本轮模型回复结束 → 释放本 Run 尚未被消费的锁 */
  releaseRound(runId: string): AgentPath[] {
    return this.releaseOwned(runId)
  }

  /** 生命周期 ③：Run 结束 / abort / 超时兜底 → 释放全部锁，并丢掉本 Run 的读版本表 */
  releaseRun(runId: string): AgentPath[] {
    const released = this.releaseOwned(runId)
    this.reads.delete(runId)
    return released
  }

  /** 兜底：清空读写两张表（切换工程 / 卸载时用） */
  releaseAll(): void {
    this.locks.clear()
    this.reads.clear()
  }

  private releaseOwned(runId: string): AgentPath[] {
    const released: AgentPath[] = []
    for (const [path, lock] of this.locks) {
      if (lock.runId !== runId) continue
      this.locks.delete(path)
      released.push(path)
    }
    return released
  }

  /** 逐条校验 §8 的前置条件；返回首个失败原因，全部通过返回 null */
  private validate(runId: string, candidate: Candidate, creating: boolean): LockDenial | null {
    const { path, current } = candidate
    const readVersion = this.readVersion(runId, path)

    if (!creating) {
      // ① 本 Run 内读过 —— 没读过就没有可锚定的版本
      if (readVersion === undefined) {
        return denial('not_read', `先 read_source({source:"${path}"}) 拿到 version，再 lock_source。`, current)
      }
      // ② 最后读到的版本 == 当前版本（文件已删时跳到 ④ 报 not_found）
      if (current !== null && readVersion !== current.version) {
        return denial('version_stale', `"${path}" 的内容已变化：重新 read_source 后再 lock_source。`, current)
      }
      // ③ 非 human-dirty —— 否则会覆盖人类刚打的字（§11 第 12 条）
      if (this.world.isHumanDirty(path)) {
        return denial('human_editing', `"${path}" 有未提交的人工编辑：稍后重试，或请用户先保存。`, current)
      }
      // ④ 非 creating 时路径必须存在
      if (current === null) {
        return denial('not_found', `"${path}" 不存在：新建请用 creating 语义。`, current)
      }
    } else {
      // create 语义反过来：要占的名字必须**不存在**，存在就说明该改用 write 覆盖
      if (current !== null) {
        return denial(
          'not_found',
          `"${path}" 已存在：不要声明 creating，改用 lock_source + write_source 覆盖。`,
          current,
        )
      }
      if (this.world.isHumanDirty(path)) {
        return denial('human_editing', `"${path}" 有未提交的人工编辑：稍后重试。`, current)
      }
    }

    // ⑤ 已被其他 Run 持有（本 Run 重复加锁按幂等处理，刷新版本记录）
    const holder = this.locks.get(path)
    if (holder !== undefined && holder.runId !== runId) {
      return denial(
        'held',
        `"${path}" 正被另一个 Run 占用：不要重试，先处理其它文件。`,
        current,
      )
    }
    return null
  }
}

/** 失败结果统一带上当前版本与当前内容，让模型一次往返自愈（§8） */
function denial(
  reason: LockDenyReason,
  hint: string,
  current: VersionedFile | null,
): LockDenial {
  const result: LockDenial = { locked: false, reason, hint }
  if (current !== null) {
    result.currentVersion = current.version
    result.currentContent = current.content
  }
  return result
}
