/**
 * 工具仲裁层：把 `src/agent/tools.ts` 的三语义协议接到「版本表 + 锁表 + Run 撤销日志」上。
 *
 * 这是文档 §8 的落地位置，也是修正草案 D2「两把锁」的落地位置：
 * - read    → 读完整正文、算内容哈希、登记「本 Run 读过这一版」
 * - lock    → `LockTable.acquire`：**只锁传入的源文件**，不再展开派生语言资产
 * - lockLang→ `LockTable.acquireEach`：把 `{source, locales}` 解析成 `.lang` 路径，
 *             已存在的按「隐式读 + 版本校验」、不存在按 creating，整批原子
 * - write   → `assertWritable` 做严格模式拦截 + **写前记录 before-image**
 * - 写成功  → `noteWritten` 登记写后版本并**刷新锁版本**（D2：写不释放锁）
 * - 释放    → `unlock` / `unlockLang`（显式）或 `endRound`（Run 结束兜底）
 *
 * 撤销日志的 before-image 在 `assertWritable` 里落：那是「写之前」唯一必然经过的点，
 * 由协议保证（tools.ts 对每个 write 工具都先调它）。
 */

import { paginateSource, sourceOffsetError } from '../agentOps'
import { contentVersion } from '../runtime/version'
import type { AcquireEntry, LockTable } from '../runtime/lockTable'
import type { RunUndoLog } from '../runtime/runUndo'
import type {
  AgentFileWorld,
  AgentHost,
  AgentOpResult,
  AgentPath,
  AgentToolArbiter,
  ContentVersion,
  LangLockDenial,
  LangLockGrant,
  LockDenial,
  LockGrant,
  UndoChannel,
  VersionedFile,
} from '../contracts'

/** 宿主读完整正文：优先用 `readFullSource`（>2000 行的文件必须实现它，否则锁版本会被截断） */
async function readFull(host: AgentHost, path: AgentPath): Promise<
  { ok: true; content: string } | { ok: false; error: string; reason: 'not_found' }
> {
  const raw = host.readFullSource
    ? host.readFullSource(path)
    : host.readSource(path, 1, 2000)
  if (raw?.ok === false) {
    // 兜底串必须是英文（D5）；宿主自己的 error 文案由宿主侧负责，
    // reason 按上下文给最具体的一个：读不到命名的源文件几乎都是「不存在」。
    return { ok: false, error: String(raw.error ?? `cannot read ${path}`), reason: 'not_found' }
  }
  return { ok: true, content: String(raw.content ?? '') }
}

/**
 * `AgentFileWorld`：锁表与撤销日志看到的世界，全部经过宿主（编辑器缓冲已 flush）。
 * 派生语言资产（`.lang`）也在这里可读 —— `lock_lang` 的存在性/版本判断、
 * `noteWritten` 的写后版本、撤销日志的语言回放都走它，保证同一份内容哈希与同一套草稿通道。
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
        // 回滚「本 Run 新建的文件」= 从本机草稿里删掉，**绝不写 S**（D1b）。
        if (host.discardDraftSource) await host.discardDraftSource(path)
        return
      }
      // 回放只发生在「本 Run 刚写过、随后失败」的场景：文件一定存在，用 writeSource
      host.writeSource(path, content)
    },
    // 语言草稿回放：宿主提供 writeLangDraft 时才开放（D3 / 阶段 2 的 staged 草稿通道）。
    // 不提供时撤销日志的语言条目会在预演里报 `unavailable`，而不是假装回滚成功。
    writeLang:
      host.writeLangDraft === undefined
        ? undefined
        : async (path, content) => {
            await host.writeLangDraft?.(path, content)
          },
  }
}

/**
 * 回放通道：派生语言资产是工程相对路径（`assets/<locale>/lang_<ext>/…`），
 * 其余按源文件逻辑名处理。源文件的锁不再展开派生资产（D2），所以这里只按路径判别。
 */
function channelOf(path: AgentPath): UndoChannel {
  return path.startsWith('assets/') ? 'lang' : 'source'
}

type ArbiterOptions = {
  host: AgentHost
  locks: LockTable
  undo: RunUndoLog
  /**
   * 锁层看到的世界（源文件 + 派生语言资产）；省略时以 `createFileWorld(host)` 建一个。
   * facade 传同一个 world 给 LockTable 与撤销日志，保证版本口径一致。
   */
  world?: AgentFileWorld
  /** 当前 Run 的标识（撤销日志/锁归属都按它分组） */
  runKey: () => string
  /** 锁集合变化（拿到/释放）：UI 靠它把文件即时转只读/解除只读 */
  onLockChange?: () => void
}

/**
 * 写前拒绝：契约 `AgentToolArbiter.assertWritable` 的 `{ok:false,error,hint?}` 之外再带 `reason`，
 * 供 tools 的 `deniedJson` 判断是否追加「先 lock_source」兜底、并统一映射 `errorCode`（B4/B5）。
 * 返回类型比契约更具体（多一个字段），结构上仍满足契约 —— 契约补 `reason?` 后本别名可删。
 */
export type WriteDenial = {
  ok: false
  error: string
  hint?: string
  reason: 'held' | 'already_exists' | 'version_stale'
}

/**
 * lock 失败的返回体（B10）：契约 `LockDenial` 之上允许 `contentOmitted` 标记。
 *
 * 为什么只对 `already_exists` 省内容：create 占名撞上已存在时，模型下一步是「改用 write_source」，
 * 不需要整篇正文（长文件 payload 膨胀）；而 `version_stale` / `held` 需要回内容才能一次往返自愈。
 */
export type LockDenialBody = LockDenial & { contentOmitted?: true }

/** lock_lang 的失败体：与 `LockDenialBody` 同口径（语言路径极少走到 already_exists，但保持一致） */
export type LangLockDenialBody = LangLockDenial & { contentOmitted?: true }

/** lock_lang 的返回体（契约结果 + B10 标记） */
export type LangLockResultBody = { locked: true; langs: LangLockGrant[] } | LangLockDenialBody

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
    if (!full.ok) return { ok: false, error: full.error, reason: full.reason }
    // offset 越界不静默 clamp：报错并回传总行数，模型才知道文件到底多长（D6）
    const totalLines = full.content.split('\n').length
    const offsetError = sourceOffsetError(totalLines, offset)
    if (offsetError) {
      return {
        ...offsetError,
        reason: 'invalid_arguments',
        hint: 'use offset <= totalLines; the file is shorter than requested',
      }
    }
    const version = await contentVersion(full.content)
    this.options.locks.noteRead(this.options.runKey(), source, version)
    const page = paginateSource(full.content, offset, limit)
    return { ok: true, source, version, ...page }
  }

  /**
   * lock：多路径原子；失败回传当前内容让模型一次往返自愈。
   *
   * 修正草案 D2：**只锁传入的路径**。以前顺带展开「已存在的派生语言资产」是为了让
   * `write_lang` 的版本守卫能察觉外部改动；现在语言有自己的 `lock_lang`，
   * 源文件锁不再替语言锁兜底（避免锁徽标暴露 `.lang` 内部路径，也避免误锁一堆文件）。
   *
   * B10：`already_exists` 只回 `currentVersion` + `contentOmitted:true`（不给整篇正文）。
   */
  async lock(
    paths: AgentPath[],
    options?: { creating?: boolean },
  ): Promise<LockGrant | LockDenialBody> {
    const result = await this.options.locks.acquire(this.options.runKey(), paths, options)
    if (result.locked) {
      this.options.onLockChange?.()
      return result
    }
    if (result.reason === 'already_exists') {
      const denied: LockDenialBody = {
        locked: false,
        reason: result.reason,
        hint: result.hint,
        contentOmitted: true,
      }
      if (result.currentVersion !== undefined) denied.currentVersion = result.currentVersion
      return denied
    }
    return result
  }

  /**
   * lock_lang：锁某源文件在指定语言下的 `.lang`。
   *
   * - 已存在的 `.lang`：先**隐式登记**「本 Run 读过这一版」（与源文件的 ① 前置条件同口径，
   *   语言侧对应的 read 是 `list_lang_keys`，但锁本身不该强迫模型先调它），再按非 creating 校验；
   * - 不存在的 `.lang`：按 creating 占名（译文文件常常还没建）；
   * - 整批原子：任一条失败，一个都不持有（`acquireEach` 保证）。
   */
  async lockLang(source: AgentPath, locales?: string[]): Promise<LangLockResultBody> {
    const resolve = this.options.host.derivedLangTargets
    if (resolve === undefined) {
      return {
        locked: false,
        reason: 'not_found',
        hint: 'Host does not expose derivedLangTargets; language locks are unavailable.',
      }
    }
    const targets = resolve(source, locales) ?? []
    if (targets.length === 0) {
      return {
        locked: false,
        reason: 'not_found',
        hint: `No language asset path resolved for "${source}". Check the source name and the locale list.`,
      }
    }

    const runKey = this.options.runKey()
    const entries: AcquireEntry[] = []
    const grants: LangLockGrant[] = []
    for (const target of targets) {
      // 与锁表同一份世界：存在性/版本必须和 acquireEach 里读到的一致
      const current = await this.options.locks.readCurrent(target.path)
      if (current !== null) {
        this.options.locks.noteRead(runKey, target.path, current.version)
      }
      entries.push({ path: target.path, creating: current === null })
      grants.push({
        locale: target.locale,
        path: target.path,
        existed: current !== null,
        version: current === null ? null : current.version,
      })
    }

    const result = await this.options.locks.acquireEach(runKey, entries)
    if (!result.locked) {
      const failed = grants[result.index]
      const omitContent = result.denial.reason === 'already_exists'
      const denied: LangLockDenialBody = {
        locked: false,
        reason: result.denial.reason,
        hint: result.denial.hint,
      }
      if (omitContent) denied.contentOmitted = true
      if (failed !== undefined) {
        denied.locale = failed.locale
        denied.path = failed.path
      }
      if (result.denial.currentVersion !== undefined) {
        denied.currentVersion = result.denial.currentVersion
      }
      // B10：already_exists 省略整篇正文，其它 reason 仍回内容供模型自愈
      if (!omitContent && result.denial.currentContent !== undefined) {
        denied.currentContent = result.denial.currentContent
      }
      return denied
    }
    this.options.onLockChange?.()
    return { locked: true, langs: grants }
  }

  /** unlock_source：释放本 Run 持有的路径锁；返回真正释放的路径（幂等，不放别人的锁） */
  unlock(paths: AgentPath[]): AgentPath[] {
    const released = this.options.locks.release(this.options.runKey(), paths)
    if (released.length > 0) this.options.onLockChange?.()
    return released
  }

  /** unlock_lang：按 `{source, locales}` 解析出 `.lang` 路径后释放；locales 省略 = 全部派生语言 */
  unlockLang(source: AgentPath, locales?: string[]): AgentPath[] {
    const targets = this.options.host.derivedLangTargets?.(source, locales) ?? []
    if (targets.length === 0) return []
    return this.unlock(targets.map(target => target.path))
  }

  /** 该路径当前是否被**本 Run** 持有（编辑器逐文件只读 / 自动成键抑制用） */
  isLocked(path: AgentPath): boolean {
    return this.options.locks.ownerOf(path) === this.options.runKey()
  }

  /**
   * 本 Run 当前持有的全部路径（源文件 + 语言资产）。
   * `unlock_source` 的失败提示用它告诉模型「你现在握着哪些锁」，UI 也可用来标锁徽标。
   */
  heldPaths(): AgentPath[] {
    const runKey = this.options.runKey()
    return this.options.locks
      .lockedPaths()
      .filter(path => this.options.locks.ownerOf(path) === runKey)
  }

  /**
   * write 前置：严格模式。
   * - 未持锁 → 拒绝，hint 直接给出可执行的 lock_source 调用；
   * - 持锁 → 记录 before-image（撤销日志的唯一入口）。
   *
   * 版本守卫在这里**不做二次读**：锁在 acquire 时校验过版本，而人类在 agent 持锁期间
   * 改不了该文件（编辑器转只读），所以中间不存在写窗口。见文档 §8「校验与写入之间不得有 await」。
   * D8：这里不再有 human-dirty 前置 —— 人类未保存的编辑已被 `world.read` flush，
   * 内容若真的变了，下面的版本比对会拒绝。
   */
  async assertWritable(
    source: AgentPath,
    options?: { creating?: boolean },
  ): Promise<{ ok: true; version: ContentVersion } | WriteDenial> {
    const runKey = this.options.runKey()
    const owner = this.options.locks.ownerOf(source)

    if (options?.creating) {
      if (owner !== runKey) {
        return {
          ok: false,
          error: 'lock is not held for this path',
          reason: 'held',
          hint: `Call lock_source({ "paths": ["${source}"] }) to hold the name before creating it.`,
        }
      }
      // create 语义：锁在 acquire 时确认过「路径不存在」；这里再确认一次（占名期间别人可能建了同名文件）
      const existing = await this.options.locks.readCurrent(source)
      if (!existing) {
        await this.options.undo.recordBefore(runKey, source, channelOf(source))
        return { ok: true, version: '' }
      }
      // B5：已存在只指向 write_source，不再拼 lock 提示（否则中英混排 + 指引自相矛盾）
      return {
        ok: false,
        error: `path already exists: ${source}`,
        reason: 'already_exists',
        hint: 'Use write_source to overwrite the existing file.',
      }
    }

    if (owner !== runKey) {
      return {
        ok: false,
        error: 'write without holding the lock',
        reason: 'held',
        hint: `Call lock_source({ "paths": ["${source}"] }) first.`,
      }
    }

    const lockedVersion = this.options.locks.lockedVersion(source)
    const current = await this.options.locks.readCurrent(source)
    // 锁在 acquire / noteWritten 时校验过版本；这里兜一层：持锁期间版本变了
    //（人类仍可能在只读生效前输入）就拒绝。
    // C4：同 Run 内写成功时 noteWritten 会刷新「本 Run 读到的版本」与锁版本，
    // 所以这里命中 version_stale 只可能来自**外部改动**（人类 / 别的 Run / 外部工具），不会自伤。
    if (current && lockedVersion && current.version !== lockedVersion) {
      return {
        ok: false,
        error: 'file changed after it was locked',
        reason: 'version_stale',
        hint: 'Call read_source again, then lock_source, and retry.',
      }
    }
    await this.options.undo.recordBefore(runKey, source, channelOf(source))
    return { ok: true, version: lockedVersion ?? '' }
  }

  /**
   * write 成功后：
   * 1. 登记撤销日志的写出记录（版本守卫的判据）；
   * 2. 把「本 Run 读到的版本」更新成刚写出的版本 —— 同一 Run 里再写 / 再 lock 不该被判
   *    `version_stale`、也不该被迫重新读一遍；
   * 3. **刷新锁的锚定版本，但不释放锁**（修正草案 D2「写不释放锁」）。锁一直持有到
   *    `unlock_source` / Run 结束 / Run 回滚。
   * C4：写成功即刷新「本 Run 读到的版本」与锁版本，所以 version_stale 只会由外部改动产生
   *（同 Run 内写完再写 / 再锁不会自己把自己判 stale）。
   * 返回写后版本（D6：写工具返回写后版本，create 不再返回空串）。
   */
  async noteWritten(source: AgentPath): Promise<ContentVersion | null> {
    const runKey = this.options.runKey()
    const file: VersionedFile | null = await this.options.locks.readCurrent(source)
    if (file === null) return null
    this.options.undo.recordWrite(runKey, source, channelOf(source), file)
    this.options.locks.noteRead(runKey, source, file.version)
    this.options.locks.refreshLocked(runKey, source, file)
    return file.version
  }

  /** Run 结束：释放本 Run 仍持有的全部锁（D2 持锁上限 = Run 结束；读版本表一并清空） */
  endRound(): void {
    this.options.locks.releaseRun(this.options.runKey())
    this.options.onLockChange?.()
  }
}
