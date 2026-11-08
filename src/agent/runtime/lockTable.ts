/**
 * 锁表（文档 §8「单窗口并发与三工具协议」、§11 第 10/11 条）。
 *
 * 职责只有两件：记住「本 Run 内读过哪一版」，以及登记「谁占着哪个路径」。
 * 三条硬规则都在这里兜住：
 * 1. **锁不等待**：拿不到立即返回失败，实现里没有任何 promise 排队 —— 所以系统天然无死锁（§11 第 11 条）；
 * 2. **多路径原子**：先全部读、再全部校验、最后全部登记，校验与登记之间不 await（§8「校验与写入之间不得有 await」）；
 * 3. **失败也回传当前内容**：让模型一次往返内自愈（§8「lock 的返回」）。
 *
 * 锁的粒度分两把（修正草案 D2）：`lock_source` 只锁源文件，派生语言资产用 `lock_lang`
 * 单独锁；两类路径共用本表（key 都是字符串路径）。
 *
 * **持锁期到 unlock / Run 结束 / Run 回滚**：write 成功不再释放锁（D2「写不释放锁」），
 * 因此本表不再提供 `consume`。`releaseRound` 只是旧档位的兼容入口，Run 结束时由
 * `releaseRun`（arbiter.endRound 调用）一次清空。
 *
 * 校验顺序（D8）：非 creating 时 **not_found → not_read → version_stale → held**；
 * creating 命中已存在 → `already_exists`。
 *
 * **锁只看版本，不看人类脏编辑（D8 修订）**：人类在编辑器里的未保存内容会被
 * `world.read` flush 进当前内容，所以「人类正在编辑」不再拒绝加锁 ——
 * 版本没变就允许；人类继续输入确实改变了内容，才由 `version_stale` 拦下。
 * 人类侧的互斥靠「文件被锁 → 编辑器只读」保证（UI 读 `lockedPaths()`）；
 * 人类未保存编辑只作为**撤销预演**的 `human_editing` 冲突（runUndo，不在本表）。
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

/** 一条持锁记录；`version` 是加锁（或写后刷新）时校验通过的那一版，write 前要与当前版本比对 */
export type LockInfo = {
  runId: string
  version: ContentVersion
  content: string
  /** create 语义的锁占住的是「不存在的名字」，此时 version 为空串；写成功后刷新为普通锁 */
  creating: boolean
  lockedAt: number
}

/** 混合加锁的一条请求：每一条可以有自己的 create 语义（`lock_lang` 里「已存在 / 不存在」混杂） */
export type AcquireEntry = {
  path: AgentPath
  creating: boolean
}

/**
 * `acquireEach` 的结果。
 * 失败时带 `index`（失败条目在入参里的下标），让 `lockLang` 能定位到 locale/path。
 */
export type AcquireEachResult =
  | { locked: true }
  | { locked: false; index: number; denial: LockDenial }

/** D6：creating 命中已存在要单独给 `already_exists`（与「文件不存在」区分开，模型下一步不同） */
const ALREADY_EXISTS_REASON: LockDenyReason = 'already_exists'

type Candidate = {
  path: AgentPath
  creating: boolean
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
   * 单 creating 标志的多路径加锁（`lock_source` 用）。
   * 语义与 `acquireEach` 完全一致，只是所有路径共享一个 create 标志。
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
        hint: 'lock_source needs at least one path.',
      }
    }

    const result = await this.acquireEach(
      runId,
      unique.map(path => ({ path, creating })),
    )
    if (!result.locked) return result.denial

    const first = this.locks.get(unique[0])
    return {
      locked: true,
      version: first?.version ?? '',
      content: first?.content ?? '',
    }
  }

  /**
   * 混合创建语义的原子加锁（`lock_lang` 用）：每条路径各自声明 creating。
   *
   * 三步固定顺序，任一失败一个都不登记：
   * 1. 全部读出当前内容（允许 await，此时还没有登记）；
   * 2. 纯同步逐条校验（D6 顺序）；
   * 3. 纯同步全部登记。
   */
  async acquireEach(
    runId: string,
    entries: AcquireEntry[],
  ): Promise<AcquireEachResult> {
    if (entries.length === 0) return { locked: true }

    // 第一步：读。派生语言资产也走同一个 world（宿主已 flush 编辑器缓冲）。
    const candidates: Candidate[] = []
    for (const entry of entries) {
      candidates.push({
        path: entry.path,
        creating: entry.creating,
        current: await versionedFile(this.world, entry.path),
      })
    }

    // 第二步：纯同步校验 —— 这里绝不能有 await（§8 TOCTOU 规则）。
    for (let index = 0; index < candidates.length; index += 1) {
      const denial = this.validate(runId, candidates[index])
      if (denial !== null) return { locked: false, index, denial }
    }

    // 第三步：纯同步登记 —— 与校验同处一个微任务，原子性由此成立。
    for (const candidate of candidates) {
      const current = candidate.current
      this.locks.set(candidate.path, {
        runId,
        version: current === null ? '' : current.version,
        content: current === null ? '' : current.content,
        creating: candidate.creating,
        lockedAt: this.now(),
      })
    }
    return { locked: true }
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

  /** 持锁记录快照（给 facade 做 write 前的版本校验，避免它依赖内部结构） */
  lockInfo(path: AgentPath): LockInfo | null {
    const lock = this.locks.get(path)
    return lock === undefined ? null : { ...lock }
  }

  /** 直接透传当前内容（flush 后）；facade 写完后再读一次，用内容哈希登记「本 Run 写出的版本」 */
  async readCurrent(path: AgentPath): Promise<VersionedFile | null> {
    return await versionedFile(this.world, path)
  }

  /**
   * 写成功后刷新持锁版本（D2「写不释放锁」）：
   * 锁仍在，但锚定版本要更新成刚写出的那一版，否则同一 Run 的第二次写会被
   * `assertWritable` 误判成「持锁期间被改动」。create 锁写成功后转为普通锁。
   */
  refreshLocked(runId: string, path: AgentPath, written: VersionedFile): boolean {
    const lock = this.locks.get(path)
    if (lock === undefined || lock.runId !== runId) return false
    this.locks.set(path, {
      ...lock,
      version: written.version,
      content: written.content,
      creating: false,
    })
    return true
  }

  /**
   * 显式释放（`unlock_source` / `unlock_lang`）：只释放本 Run 持有的路径，
   * 返回真正释放的路径；别人的锁不会被误放（幂等）。
   */
  release(runId: string, paths: AgentPath[]): AgentPath[] {
    const released: AgentPath[] = []
    for (const path of new Set(paths)) {
      const lock = this.locks.get(path)
      if (lock === undefined || lock.runId !== runId) continue
      this.locks.delete(path)
      released.push(path)
    }
    return released
  }

  /**
   * 本轮结束档位（旧语义：锁的持有上限是「一次模型回复」）。
   * 修正草案 D2 把上限改成 **Run 结束**，新代码不再调用它；保留是为了不让旧调用点
   * 悄悄变成"释放 Run 全部锁"，也方便将来需要时回退。
   */
  releaseRound(runId: string): AgentPath[] {
    return this.releaseOwned(runId)
  }

  /** Run 结束 / abort / 超时兜底 → 释放全部锁，并丢掉本 Run 的读版本表 */
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

  /** 逐条校验 §8 的前置条件（D8 顺序）；返回首个失败原因，全部通过返回 null */
  private validate(runId: string, candidate: Candidate): LockDenial | null {
    const { path, creating, current } = candidate

    if (!creating) {
      // D6：先判存在性，再判「本 Run 内读过」——文件已删时 not_found 才是对的
      if (current === null) {
        return denial(
          'not_found',
          `"${path}" does not exist. Pass creating: true to reserve a new name.`,
          current,
        )
      }
      const readVersion = this.readVersion(runId, path)
      // ① 本 Run 内读过 —— 没读过就没有可锚定的版本
      if (readVersion === undefined) {
        return denial(
          'not_read',
          `Read "${path}" first (read_source or list_lang_keys) so the lock can anchor its version.`,
          current,
        )
      }
      // ② 最后读到的版本 == 当前版本（D8：这是唯一的内容判据）
      //    人类在编辑器里的未保存内容已被 world.read flush 进 current，
      //    所以 human-dirty 不单独拒绝；版本变了才说明人类真的改了内容。
      if (readVersion !== current.version) {
        return denial(
          'version_stale',
          `"${path}" changed since it was last read. Read it again, then lock.`,
          current,
        )
      }
    } else {
      // create 语义反过来：要占的名字必须**不存在**，存在就说明该改用 write 覆盖
      if (current !== null) {
        return denial(
          ALREADY_EXISTS_REASON,
          `"${path}" already exists. Do not pass creating: true; lock it and write over it instead.`,
          current,
        )
      }
    }

    // ④ 已被其他 Run 持有（本 Run 重复加锁按幂等处理，刷新版本记录）
    const holder = this.locks.get(path)
    if (holder !== undefined && holder.runId !== runId) {
      return denial(
        'held',
        `"${path}" is locked by another run. Do not retry; work on other files or end this run.`,
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
