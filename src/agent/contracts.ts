/**
 * Agent 运行时的**共享契约**：只放类型，不放实现，也不 import 任何 PI 包。
 *
 * 分层（见 help/docs/agent-runtime.md）：
 *   ① UI（AgentPanel）        —— 只依赖 AgentRuntimeView / AgentRuntime
 *   ② 适配层（pi/facade.ts）  —— 唯一 import PI 的文件
 *   ③ 运行时支撑（runtime/）  —— 版本表 · 锁表 · Run 撤销日志
 *   ④ 存储（store/）          —— 活跃段库 / 归档段库 / windowId
 *   ⑤ 领域工具（tools.ts）    —— read / lock / write 三类语义
 *
 * 本文件的类型是这几层之间**唯一的**耦合面：改这里等于改协议。
 */

/* ───────────────────────── 版本与锁 ───────────────────────── */

/**
 * 版本标识 = **文件内容哈希**（与 S 同构）。
 * 用哈希而不是计数器：改了又改回来不算冲突。
 */
export type ContentVersion = string

/** 带版本的文件快照；`version` 是内容哈希，不是时间戳 */
export type VersionedFile = {
  content: string
  version: ContentVersion
}

/** 逻辑名（`序章.hs`），与工具参数一致；不是项目相对路径 */
export type AgentPath = string

/** lock 失败原因（见文档 §8「lock 的返回」） */
export type LockDenyReason =
  /** 最后读到的版本 ≠ 当前版本（人类继续编辑 / 别的 Run 改过都归这一类） */
  | 'version_stale'
  /** 本 Run 内没读过该文件 */
  | 'not_read'
  /** 文件不存在（且调用方没有声明 create） */
  | 'not_found'
  /** 已被其他 Run / 人类持有 */
  | 'held'
  /** creating 语义下路径**已经存在**（占名失败；改用 write_source 覆盖） */
  | 'already_exists'

export type LockGrant = {
  locked: true
  version: ContentVersion
  content: string
}

export type LockDenial = {
  locked: false
  reason: LockDenyReason
  /** 失败也回传最新内容，让模型一次往返内自愈 */
  currentVersion?: ContentVersion
  currentContent?: string
  hint: string
}

export type LockResult = LockGrant | LockDenial

/**
 * 语言锁（`lock_lang`）的一条授予记录。
 * `.lang` 的路径是**工程相对路径**（`assets/<locale>/lang_<ext>/…`），不是逻辑名；
 * 锁表按字符串路径登记，两类路径共用同一张表。
 */
export type LangLockGrant = {
  locale: string
  path: AgentPath
  /** 锁的时候文件是否已存在；false = creating 语义（首次写该语言） */
  existed: boolean
  /** 不存在时为 null */
  version: ContentVersion | null
}

export type LangLockDenial = {
  locked: false
  /** 整批原子失败：一个都不持有 */
  reason: LockDenyReason
  /** 失败的那一条（能定位时给出） */
  locale?: string
  path?: AgentPath
  currentVersion?: ContentVersion
  currentContent?: string
  hint: string
}

export type LangLockResult =
  | { locked: true; langs: LangLockGrant[] }
  | LangLockDenial

/** 多路径原子：要么全拿到，要么一个都不持有 */
export type LockRequest = {
  paths: AgentPath[]
  /** create 语义：占住一个**不存在**的名字 */
  creating?: boolean
}

/**
 * 锁/版本层看到的世界。
 * 所有读都要经过宿主（编辑器缓冲先 flush），否则人类正在打的字不进哈希。
 */
export type AgentFileWorld = {
  /** flush 编辑器缓冲 + 读当前内容；不存在返回 null */
  read: (path: AgentPath) => Promise<VersionedFile | null>
  /** 人类是否有未提交的脏编辑（派发写入时的人类缓冲） */
  isHumanDirty: (path: AgentPath) => boolean
  /** 撤销日志回放用：把内容写回工作区（null = 删除） */
  write: (path: AgentPath, content: string | null) => Promise<void>
  /**
   * 语言草稿通道：把 `.lang` 的 staged 草稿写回指定内容（null = 撤掉该草稿）。
   * 省略表示宿主不支持语言回放，回滚时语言路径会报 `unavailable` 冲突。
   */
  writeLang?: (path: AgentPath, content: string | null) => Promise<void>
}

/* ───────────────────────── 工具三语义 ───────────────────────── */

/**
 * 工具语义分类。文档 §8：read / lock / write 是**三类语义**，不是只保留 3 个工具。
 * - read：返回 content + version
 * - lock：占住路径（write 的前置条件）
 * - write：落地修改，**必须已持锁**
 */
export type AgentToolKind = 'read' | 'lock' | 'write'

/** 单个工具调用的结果：一律带 `ok`，失败带 `error`（可选 `hint` 指向正确下一步） */
export type AgentOpResult = { ok: boolean; [key: string]: unknown }

export type LangEntry = { key: string; text: string }

/**
 * 领域工具宿主：由工作区（StageplayWorkspace）实现，负责真正的读写与连带资产处理。
 *
 * 与旧版的差别：
 * 1. 版本从「最后更新时间」改成「内容哈希」（`ContentVersion`）；
 * 2. 写操作不再自己校验版本 —— 版本前置条件统一由锁协议强制；
 * 3. 读写都必须经过 `flushEditorBuffer` 之后的世界（宿主自己保证）。
 */
export type AgentHost = {
  /** 所有包与源文件（逻辑名 + 类别） */
  listSources: (packageName?: string) => AgentOpResult
  /** 分页读源文件；`version` 是内容哈希，供 lock 校验 */
  readSource: (source: string, offset?: number, limit?: number) => AgentOpResult
  /**
   * 读**完整**正文（不截断）：锁协议要用它算内容哈希、并在 lock 成功时顺带把最新内容交给模型。
   * 省略时运行时退化为 `readSource(source, 1, 2000)`（>2000 行的文件请务必实现）。
   */
  readFullSource?: (source: string) => AgentOpResult
  /**
   * 人类是否有未提交的脏编辑（编辑器缓冲）。**只给撤销预演用**（回滚要覆盖内容，
   * 人类改过就报 `human_editing` 冲突）；lock 不再看它（D8：锁只看版本）。
   */
  isHumanDirty?: (source: string) => boolean
  /**
   * 源文件派生的语言资产路径（`assets/<locale>/lang_<ext>/…`）。`lock_lang` 用它把
   * `{ source, locales }` 解析成要锁的路径；`locales` 省略 = 工程已有语言 + 当前语言。
   */
  derivedLangTargets?: (
    source: string,
    locales?: string[],
  ) => Array<{ locale: string; path: AgentPath }>
  /**
   * 读派生的语言资产正文：**本地草稿优先**（staged），没有草稿才读工程文件 / 本机缓存；
   * 不存在返回 null。供语言锁的版本判断、`write_lang` 的写前校验与 `noteWritten` 的
   * 写后版本使用 —— 必须和 agent 刚写进的草稿是同一份内容，否则版本信号会锚在旧文件上。
   */
  readAssetText?: (path: AgentPath) => Promise<string | null>
  /** 新建源文件；同名已存在时**失败**（改用 `writeSource`） */
  createSource: (source: string, content: string) => AgentOpResult
  /**
   * 只从本机工作区草稿里删掉一个文件（**不写 S**）。撤销日志回放「本 Run 新建的文件」时用。
   * 与 `deleteSource` 的区别：后者会发结构事务，agent 工具层已经不再提供删除能力（D1b）。
   */
  discardDraftSource?: (source: string) => void | Promise<void>
  /**
   * 撤销日志回放「语言草稿」用：把 `.lang` 的 staged 草稿写回指定内容
   * （`null` = 撤掉该语言草稿）。与 `readAssetText` 同一套草稿优先口径。
   */
  writeLangDraft?: (path: AgentPath, content: string | null) => void | Promise<void>
  /** 覆盖**已存在**的源文件；不存在时**失败**（改用 `createSource`）。`.lang` 交给 `writeLang` */
  writeSource: (source: string, content: string) => AgentOpResult
  /** 精确字面替换 */
  editSource: (
    source: string,
    oldText: string,
    newText: string,
    replaceAll?: boolean,
  ) => AgentOpResult
  /** 语法诊断 + `.hsc` 编译校验 */
  validateSource: (source: string) => AgentOpResult
  /** 当前打开文件的名字、类别与项目相对路径 */
  getActiveFilePath: () => AgentOpResult
  /** 工程里出现过的语言 */
  listLocales: () => AgentOpResult
  /** 源正文里出现的键 × 该语言的译文 */
  listLangKeys: (
    source: string,
    locale?: string,
    offset?: number,
    limit?: number,
  ) => Promise<AgentOpResult>
  /** 一次写入多种语言的译文；键必须已存在于正文 */
  writeLang: (
    source: string,
    translations: Record<string, LangEntry[]>,
  ) => Promise<AgentOpResult>
  /** 删除译文键；`force` 省略/false 时拒绝删除正文仍在引用的键（D10） */
  deleteLangKeys: (
    source: string,
    keys: string[],
    locale?: string,
    force?: boolean,
  ) => Promise<AgentOpResult>
  /** 对等配音是否存在、是否单声道 Vorbis ogg；分页返回（offset 1 起） */
  listVoiceStatus: (
    source: string,
    locale?: string,
    offset?: number,
    limit?: number,
  ) => Promise<AgentOpResult>
  /** 解析：把正文的可本地化文本换成键名，并把文本写进该语言的映射 */
  parseHs: (source: string, locale?: string) => Promise<AgentOpResult>
  /** 逆解析：把该语言映射里的文本换回正文（键名被替换掉） */
  unparseHs: (source: string, locale?: string) => Promise<AgentOpResult>
  /** 内存里预演两个导出，返回文件数与警告（不下载） */
  checkExport: () => Promise<AgentOpResult>
}

/**
 * 工具派发前的仲裁层：由运行时（Lead 侧的 facade/AgentRuntime）实现。
 * `tools.ts` 只认这个接口，不认 PI，也不认锁表的内部结构。
 */
export type AgentToolArbiter = {
  /** read：返回内容与版本，并把「本 Run 读过这一版」记进版本表 */
  read: (source: AgentPath, offset?: number, limit?: number) => Promise<AgentOpResult>
  /** lock：多路径原子；失败回传当前内容。只锁传入的路径，不再展开派生语言资产 */
  lock: (paths: AgentPath[], options?: { creating?: boolean }) => Promise<LockResult>
  /**
   * lock_lang：锁某源文件在指定语言下的 `.lang`。多语言原子；不传 locales =
   * 工程已有语言 + 当前语言。不存在的译文文件按 creating 允许（返回 existed:false）。
   */
  lockLang: (source: AgentPath, locales?: string[]) => Promise<LangLockResult>
  /** unlock_source：释放本 Run 持有的路径锁；返回真正释放的路径 */
  unlock: (paths: AgentPath[]) => AgentPath[]
  /** unlock_lang：释放某源文件在指定语言下的语言锁；返回真正释放的路径 */
  unlockLang: (source: AgentPath, locales?: string[]) => AgentPath[]
  /** 该路径当前是否被本 Run 持有（编辑器只读 / 自动成键抑制用） */
  isLocked: (path: AgentPath) => boolean
  /** 本 Run 当前持有的全部路径（源文件 + 语言资产；unlock 的 `held` 用） */
  heldPaths: () => AgentPath[]
  /** write 前的强制校验：未持锁 / 版本已变 → 拒绝执行 */
  assertWritable: (
    source: AgentPath,
    options?: { creating?: boolean },
  ) => Promise<
    | { ok: true; version: ContentVersion }
    | { ok: false; error: string; hint?: string; reason?: LockDenyReason }
  >
  /** write 成功后登记（供撤销日志与后续版本校验）；**不再释放锁**，返回写后版本 */
  noteWritten: (source: AgentPath) => Promise<ContentVersion | null>
  /** Run 结束：释放本 Run 仍持有的锁 */
  endRound: () => void | Promise<void>
}

/* ───────────────────────── Run 撤销日志 ───────────────────────── */

/** 写入通道：源文件（工作区草稿）或语言文本（staged 语言草稿） */
export type UndoChannel = 'source' | 'lang'

/** 写前快照：`content === null` 表示写前不存在（回放即删除） */
export type UndoBeforeImage = {
  content: string | null
  version: ContentVersion | null
}

/** 有序操作日志的一条：一个文件的「写前 → 写后」 */
export type UndoEntry = {
  kind: 'write' | 'create'
  channel: UndoChannel
  path: AgentPath
  before: UndoBeforeImage
  /** 本 Run 最后一次写出的内容版本（回滚的版本守卫基准） */
  after: ContentVersion
}

export type UndoConflictReason =
  /** 当前内容已不是本 Run 写出的那一版（人类 / 另一个 Run 改过） */
  | 'version_stale'
  /** 日志里没有写前快照（例如旧实现没记） */
  | 'no_before_image'
  /** 该文件正被人类编辑（编辑器缓冲未保存） */
  | 'human_editing'
  /** 宿主不支持该通道（例如不支持语言草稿回放） */
  | 'unavailable'

export type UndoConflict = {
  path: AgentPath
  channel: UndoChannel
  reason: UndoConflictReason
}

/** 回滚预演：安全时才允许自动回滚；有冲突则一个文件都不动 */
export type UndoPreflight =
  | { safe: true; entries: UndoEntry[] }
  | { safe: false; conflicts: UndoConflict[]; entries: UndoEntry[] }

/** 单个文件在 Run 失败时的回放结论 */
export type UndoOutcome = {
  path: AgentPath
  /** 通道；省略按 source（旧调用方兼容） */
  channel?: UndoChannel
  action: 'restored' | 'deleted' | 'skipped' | 'finished' | 'conflict'
  /** 跳过/冲突原因：被后续改动覆盖 / 已不存在等 */
  reason?: string
}

/** 失败卡片上的待处理回滚（活跃段内，封段即失效） */
export type PendingRollback = {
  status: 'pending' | 'failed'
  /** 预演发现的冲突（全部安全时不会进入待处理，直接自动回滚） */
  conflicts: UndoConflict[]
  /** 强制/重试之后的逐项结果 */
  outcomes?: UndoOutcome[]
  /** 产生它的失败 Run 在面板条目里的 id（UI 定位卡片用） */
  runItemId?: string
  createdAt: number
}

/* ───────────────────────── 会话段与归档段 ───────────────────────── */

/** 段的生命周期状态（文档 §9） */
export type SegmentState = 'active' | 'dormant' | 'sealed'

/** 会话段：窗口内的活跃会话；一个活跃段库可含 N 个段 */
export type SegmentInfo = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** 创建窗口；段只归创建窗口 */
  windowId: string
  state: SegmentState
  runCount: number
  /** 从哪个归档段「继承对话」而来；删归档段时用于级联 */
  sourceSnapshotId?: string
}

/**
 * 归档段（保存点）：不可变，存**归档段库**；同一工程 scope 的所有窗口可读。
 * 归档 ≠ 段结束：保存产出归档段后，活跃段仍可继续。
 */
export type SnapshotInfo = {
  id: string
  /** 工程 scope（分区键） */
  scope: string
  /** 产出它的段 */
  segmentId: string
  /** 跨库谱系：归档段之间的父链（自有元数据） */
  parentSnapshotId?: string
  title: string
  createdAt: number
  /** 已归档的条目数 */
  entryCount: number
  /** 最后一条条目 id（增量补写的锚点） */
  tailEntryId?: string
  /** 从该归档段 fork 出来的段（二期载入时回填） */
  sourceSnapshotId?: string
  /**
   * 归档段的**简化**改动记录（D4）：只存哈希，不存正文/资产。
   * 由保存产出归档时从活跃段的详细日志裁剪而来，不可回滚。
   */
  filesChanged?: number
  /** 这段里是否有过失败 Run 的回滚（有 = 至少一次改动被撤销） */
  rolledBack?: boolean
  rollbackLog?: Array<{
    path: string
    beforeHash: string | null
    afterHash: string | null
  }>
}

/** 归档段库的存储后端（IndexedDB 实现 + 测试用内存实现） */
export type SnapshotBackend = {
  /** 追加一条归档段记录；id 已存在时**失败**（不可变） */
  put: (record: SnapshotInfo, entries: unknown[]) => Promise<void>
  list: (scope: string) => Promise<SnapshotInfo[]>
  entries: (snapshotId: string) => Promise<unknown[]>
  remove: (snapshotId: string) => Promise<void>
  /** 本工程 scope 的占用估算（字节） */
  usage: (scope: string) => Promise<number>
}

/* ───────────────────────── 会话视图（给 UI） ───────────────────────── */

export type AgentViewItem =
  | { id: string; kind: 'user'; text: string }
  | {
      id: string
      kind: 'assistant'
      text: string
      streaming?: boolean
      /** 模型思考内容（默认不展开；为空表示这一轮没有思考或厂商不返回） */
      thinking?: string
    }
  | { id: string; kind: 'tool'; name: string; status: 'running' | 'done' | 'error'; output?: string }
  | { id: string; kind: 'error'; text: string }
  | { id: string; kind: 'notice'; text: string }

/** Run 状态：Run = 一次用户输入到最终答案的原子回合 */
export type AgentRunState = 'idle' | 'running' | 'aborted' | 'failed'

export type AgentRuntimeView = {
  /** 当前段 id；null = 还没有打开的段 */
  segmentId: string | null
  runId: string | null
  runState: AgentRunState
  /** 产物（流式逐字 + 工具状态）：按条目顺序 */
  items: AgentViewItem[]
  /** 人类可读的状态行（思考中 / 工具名） */
  status: string
  /** 当前持有的锁（逻辑名），供编辑器转只读 */
  lockedPaths: string[]
  /** 当前段是否已封存（保存后为 true；再发消息会自动开新段） */
  segmentSealed: boolean
  /** 失败 Run 留下的待处理回滚；null / 省略 = 没有 */
  pendingRollback?: PendingRollback | null
  /** 用量/成本（可选，来自 pi-durable pi.usage） */
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number }
}

/* ───────────────────────── AgentRuntime（facade 对 UI 的唯一面） ───────────────────────── */

export type AgentRuntimeOptions = {
  /** 工程 scope（共享库分区键）：远端用 S 的 projectId，本机用 project.json.id */
  scope: string
  windowId: string
  /** 领域工具宿主 */
  host: AgentHost
  /** 用户填写的厂商 API Key（只存浏览器本地，不进构建产物） */
  apiKey: string
  /** 可选：自建网关地址；省略用厂商默认 */
  baseUrl?: string
  /** 模型 id：deepseek-v4-pro / deepseek-flash */
  model: string
  /** 当前工程名 / 文件（进提示词的上下文节） */
  projectLabel?: string
  /**
   * 保存事务进行中禁止启动 Run（文档 §7「Run 与保存双向互斥」）。
   * 省略 = 不限制。
   */
  canStartRun?: () => boolean
}

/** 一次 Run 的结果（失败不抛异常，交给 UI 渲染成一条记录） */
export type AgentRunResult = {
  ok: boolean
  /** 失败原因（模型错误 / 中断 / 原子性回滚告警） */
  error?: string
  /** Run 失败时按版本守卫回放的结果 */
  undo?: UndoOutcome[]
  /** 是否因页面存活而回滚；刷新/崩溃后不回滚 */
  rolledBack?: boolean
}

/**
 * 会话段与归档段的管理面。
 * Save 路径（工作区「保存」）在文件事务确认提交后调用 `archive()`。
 */
export type AgentRuntime = {
  /** 打开（或创建）本窗口在本工程下的活跃段库，并接管未完成 Run（标记中断，不续跑） */
  open: () => Promise<void>
  /** 列出本窗口的段；以及同工程 scope 的其它窗口段（只读可见性提示用） */
  listSegments: () => Promise<SegmentInfo[]>
  /** 新建并切换到空段 */
  createSegment: (title?: string) => Promise<SegmentInfo>
  /** 切换到已有段（同窗口） */
  selectSegment: (segmentId: string) => Promise<void>
  /**
   * 删除一个活跃段（连同它的对话条目）。
   * 归档段库里的归档不受影响（那是保存点）；删当前段后会自动切到另一段或新建空段。
   */
  deleteSegment: (segmentId: string) => Promise<void>
  /** 当前视图（订阅前先拿一次） */
  view: () => AgentRuntimeView
  /** 订阅视图变化；返回取消订阅 */
  subscribe: (listener: (view: AgentRuntimeView) => void) => () => void
  /** 发起一个 Run（用户输入）；返回后 Run 可能仍在跑，进度走订阅 */
  run: (text: string) => Promise<AgentRunResult>
  /** 中止当前 Run（页面存活时按版本守卫回滚） */
  abort: () => Promise<void>
  /**
   * 强制回滚：把该 Run 涉及的所有文本恢复成 agent 工作前内容，丢弃之后的编辑。
   * 仅供失败卡片上的待处理回滚使用。
   */
  forceRollback: () => Promise<UndoOutcome[]>
  /** 放弃回滚：丢弃日志，什么都不恢复 */
  abandonRollback: () => Promise<void>
  /** 重新预演待处理回滚：全部安全则直接回滚，否则返回冲突清单 */
  retryRollback: () => Promise<{ ok: boolean; outcomes: UndoOutcome[]; conflicts: UndoConflict[] }>
  /** 保存路径调用：把段自上次归档之后的新增条目追加进归档段库，产出一条归档记录 */
  archive: (title?: string) => Promise<SnapshotInfo | null>
  /** 归档段列表 */
  listSnapshots: () => Promise<SnapshotInfo[]>
  /** 读某个归档段的对话条目（只读查看用） */
  snapshotItems: (snapshotId: string) => Promise<AgentViewItem[]>
  /** 从归档段「继承对话」：新建一个活跃段并复制该归档的条目 */
  forkSnapshot: (snapshotId: string) => Promise<SegmentInfo>
  /**
   * 删除归档段，并级联删除直接/间接继承它的段（活跃段与归档段都算）。
   * 被删段里的对话会一起消失；当前段若被级联删除，会自动切到另一段或新建空段。
   */
  deleteSnapshot: (snapshotId: string) => Promise<{ snapshots: number; segments: number }>
  /** 本工程归档段库占用（字节）；由 UI 做 50MB 黄条 / 100MB 红条 */
  storageUsage: () => Promise<number>
  /** 拿持久化配额，避免空间压力回收 */
  persistStorage: () => Promise<boolean>
  /** 关闭（切换工程 / 卸载）：关旧 Harness，活跃段库保留 */
  close: () => Promise<void>
}
