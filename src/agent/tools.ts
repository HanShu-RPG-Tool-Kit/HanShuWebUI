/**
 * 领域工具定义与本地派发：按 **read / lock / write 三类语义** 组织。
 *
 * 为什么这么分（见 help/docs/agent-runtime.md §8「单窗口并发与三工具协议」）：
 * - read 类只读，读到的版本要登记进「本 Run 读过这一版」，否则拿锁会被 not_read 拒绝；
 * - lock 类是多路径原子的占位操作，拿不到立即失败 —— 锁不等待，所以系统天然无死锁；
 * - write 类动工程文件，**必须已持锁**；未持锁一律拒绝并给出可执行下一步（严格模式）。
 *
 * 工具集是**唯一的能力边界**，提示词只是行为约定（§11 不变量 7）。
 * 本文件不 import 任何 PI 包：facade（pi/tools.ts）负责把 AGENT_TOOLS 包成 defineTool。
 *
 * 写操作的调用顺序（不可调整，§8「关键规则」）：
 *   assertWritable(path) → host 真正写入 → noteWritten(path)
 * assertWritable 同时承担「撤销日志 before-image」的记录，所以每个 write 分支都必须先调它；
 * 校验与写入之间不插入额外 await，避免 TOCTOU。
 *
 * 修正草案 D2「两把锁」：
 * - `lock_source` 只锁源文件；语言译文文件用 `lock_lang` 单独锁；
 * - 锁一直持有到 `unlock_source` / `unlock_lang` / Run 结束，**写成功不释放**，
 *   所以同一 Run 里可以连续写，不需要反复 lock；
 * - 语言类写工具（write_lang / delete_lang_keys / parse_hs）需要「源文件锁 + 每个目标语言的锁」，
 *   由 guardedLangWrite 统一校验（缺语言锁时拒绝且不触达宿主）。
 */

import type {
  AgentHost,
  AgentOpResult,
  AgentPath,
  AgentToolArbiter,
  AgentToolKind,
  ContentVersion,
  LangEntry,
} from './contracts'
import { sourceNameFromLangPath } from './agentOps'

/**
 * 兼容旧引用：UI/工作区之前直接从 tools.ts 取这些类型。
 * 现在类型本体在 contracts.ts（层与层之间唯一的耦合面），这里只做再导出。
 */
export type {
  AgentHost,
  AgentOpResult,
  AgentPath,
  AgentToolArbiter,
  AgentToolKind,
  ContentVersion,
  LangEntry,
  LockResult,
} from './contracts'

/** 配音状态仍由旧领域层定义，保留旧导出名避免下游 import 断裂 */
export type { VoiceState } from './agentOps'

/** OpenAI function-calling 形状的调用；facade 把 arguments 原样透传过来 */
export type AgentToolCall = {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

/**
 * 派发目标：领域工具只管这两件事 —— 宿主（真读写）与仲裁器（锁/版本/撤销日志）。
 * 旧签名 executeAgentTool(host, call) 已删除，不保留兼容层：没有 arbiter 就无法执行严格模式。
 */
export type AgentToolTarget = {
  host: AgentHost
  arbiter: AgentToolArbiter
}

/* ───────────────────────── 工具 schema 构造 ───────────────────────── */

type ToolDefinition = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** 工具定义 + 它的语义分类；分类与定义在同一条数据里，避免 AGENT_TOOL_KINDS 和 AGENT_TOOLS 漂移 */
type ToolSpec = {
  kind: AgentToolKind
  tool: ToolDefinition
}

const str = (description: string) => ({ type: 'string', description })
const num = (description: string) => ({ type: 'number', description })
const bool = (description: string) => ({ type: 'boolean', description })

/**
 * 统一构造工具定义。
 * description 是模型唯一能看到的协议说明（提示词之外的第二处），所以每类都写清：
 * read 返回 content+version、write 必须先 lock、失败先看 hint（§8）。
 */
function defineTool(
  kind: AgentToolKind,
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): ToolSpec {
  return {
    kind,
    tool: {
      type: 'function',
      function: {
        name,
        description,
        parameters: {
          type: 'object',
          properties,
          required: [...required],
          additionalProperties: false,
        },
      },
    },
  }
}

/* ───────────────────────── 工具定义（按三类语义分组） ───────────────────────── */

const TOOL_SPECS: ToolSpec[] = [
  /* ── read 类：只读；read_source 走 arbiter.read 登记版本，其余直接问宿主 ── */
  defineTool(
    'read',
    'list_sources',
    '【read / 只读，无需锁】列出所有工程与源文件（逻辑文件名、类别、大小、更新时间）。类别 hanshu/character/script/goal/progress/story/navigator/gift 对应 src/ 下源目录，meta 对应 meta/ 下的创作资料（.md 文档、.tts 配音方案、.ttsservice 服务定义）；旧 *.voice 可能仍在包根（root）。返回里 **detached:true** 表示该资源脱离了工程目录：只能读，不能写（lock / 写会被宿主拒绝）。',
    {
      package: str('只看某个包；省略则列出全部包'),
    },
  ),
  defineTool(
    'read',
    'read_source',
    '【read / 只读但会登记版本】读取源文件内容，返回 content 与 version（内容哈希）、totalLines（总行数）与 limitClamped（limit 是否被截到上限）。大文件用 offset / limit 分页读（都必须是正整数）；offset 超过总行数会返回 ok:false 并带 totalLines。**任何写入前都必须先用本工具读过该文件**（lock 的 not_read 判据）；version 不需要手动传给 write_source —— 版本前置条件由锁强制。',
    {
      source: str('逻辑文件名，如 序章.hs（不带 src/ 前缀）'),
      offset: num('起始行号，必须是正整数（1 起）；默认 1'),
      limit: num('最多读多少行，必须是正整数；默认 400，上限 2000'),
    },
    ['source'],
  ),
  defineTool(
    'read',
    'validate_source',
    '【read / 只读，无需锁】校验 .hs 剧本：返回语法诊断（未闭合 / 终结符 / 说话人换行等）与 .hsc 编译错误。改完剧本应调用一次。',
    {
      source: str('逻辑文件名，如 序章.hs'),
    },
    ['source'],
  ),
  defineTool(
    'read',
    'get_active_file_path',
    '【read / 只读，无需锁】返回用户在编辑器里当前打开的文件：逻辑名 name、类别 kind，以及项目相对路径 path（仅供理解结构，其它工具仍只收逻辑名）。',
    {},
  ),
  defineTool(
    'read',
    'list_locales',
    '【read / 只读，无需锁】列出工程里已有的语言（含语言名与文本/配音文件数），并给出新语言的规范标签建议。写译文前先调用它，沿用工程里已有的标签。',
    {},
  ),
  defineTool(
    'read',
    'list_lang_keys',
    '【read / 只读，无需锁】列出某个源文件里的本地化键，以及它在指定语言（默认当前语言）的译文与是否已翻译。读的是**本地草稿优先、其次工程文件**，但「草稿」「本机镜像」「工程已保存版本」是三件事：localeExists / saved / hasSaved = **工程（S）里该 .lang 已保存版本**是否存在（等价于 `savedVersion !== null`；**本机镜像/缓存不算**，所以 saved:true 时 savedVersion 一定非 null，二者自洽）；hasLocalMirror = 本机有镜像/缓存但工程里还没保存过（新建工程常见）；savedVersion / version = **S 已保存版本**哈希（null = 没保存过，二者同值；有本地草稿时依然有值）；draft / hasDraft = 本次内容是否来自**未保存草稿**（与上面两个独立）；active = 是否为当前语言；localeInProject = 工程语言表里是否有该语言；total = **正文键数**（不是文件条目数）。分页：offset 1 起、limit 默认 200、上限 1000；offset 越界返回 ok:false 与 errorCode。翻译前先用它看清缺哪些键。',
    {
      source: str('逻辑文件名，如 序章.hs（键由该文件正文推导）'),
      locale: str('语言标签，如 zh_cn；省略用当前语言'),
      offset: num('起始序号，1 起；默认 1'),
      limit: num('最多返回多少条，默认 200，上限 1000'),
    },
    ['source'],
  ),
  defineTool(
    'read',
    'list_voice_status',
    '【read / 只读，无需锁】列出正文各键的对等配音状态：ok（单声道 Vorbis ogg）/ ref（该键是「引用资产」，指向包内另一份音频，refTarget 给出目标路径）/ missing（缺文件）/ not-ogg / invalid。分页：offset 1 起、limit 默认 100、上限 500；返回 total / truncated，缺失用 missingCount + 至多 10 条 missingSample 汇总。agent 不能合成语音，缺配音时请如实告知用户。',
    {
      source: str('逻辑文件名，如 序章.hs'),
      locale: str('语言标签；省略用当前语言'),
      offset: num('起始序号，1 起；默认 1'),
      limit: num('最多返回多少条，默认 100，上限 500'),
    },
    ['source'],
  ),
  defineTool(
    'read',
    'check_export',
    '【read / 只读，无需锁】预演导出：返回 combined PAK 与工程包各有几个文件、有哪些警告（不下载；分平面见帮助「导出 PAK」）。返回 truncated 表示警告列表被截断，warningTotal 是警告总数（可能大于 warnings.length）。',
    {},
  ),

  /* ── lock 类：write 的前置条件；多路径/多语言原子、不等待（§8、修正草案 D2） ── */
  defineTool(
    'lock',
    'lock_source',
    '【lock / write 源文件的前置条件】占住一个或多个**源文件**（逻辑文件名）。多路径原子：要么全部拿到，要么一个都不持有。本工具**只锁源文件**；语言译文文件用 lock_lang 单独锁。前提：本 Run 已 read 过且最后读到的版本仍是当前版本。creating:true 表示「占住一个还不存在的名字」，**只给 create_source 用**。成功返回 { locked:true, version, content }；失败返回 { locked:false, reason, currentVersion, currentContent, hint, errorCode }，reason ∈ version_stale | not_read | not_found | already_exists | held —— 按 reason 自愈，hint 就是下一步。锁不等待：拿不到立即失败；同一文件连续被拒 3 次就放弃并如实报告用户。成功后锁一直持有到 unlock_source / Run 结束，**写成功也不释放**。**锁期间编辑器不会自动成键**（避免与你的写入抢正文）；写工具仍只写本地草稿。',
    {
      paths: {
        type: 'array',
        description: '要占住的逻辑文件名列表（多文件时一次传全，保证原子）',
        items: { type: 'string' },
      },
      creating: bool(
        'true = 占住一个尚不存在的名字（仅 create_source 新建文件用）；目标已存在时 lock 失败（already_exists）',
      ),
    },
    ['paths'],
  ),
  defineTool(
    'lock',
    'unlock_source',
    '【lock / 释放源文件锁】释放本 Run 持有的源文件锁，幂等。paths 可以是数组，也可以是单个逻辑文件名。只会释放本 Run 的锁，别人的锁不受影响。返回 { unlocked:[...], held:[...] }：unlocked 是真正释放的路径，held 是**调用后本 Run 仍持有的全部路径（源文件 + 语言资产）**。需要让用户或其他 Run 编辑这些文件时先解锁；Run 结束也会自动释放。',
    {
      paths: {
        type: 'array',
        description: '要释放的逻辑文件名列表；也可直接传单个字符串',
        items: { type: 'string' },
      },
    },
    ['paths'],
  ),
  defineTool(
    'lock',
    'lock_lang',
    '【lock / 写语言的前置条件】锁住某个源文件在指定语言下的 .lang 译文文件（多语言原子：要么全拿到，要么一个都不持有）。locales 省略 = 工程已有语言 + 当前语言；语言文件不存在时按 creating 占位（首次写译文）。这些 .lang 锁独立于源文件的锁：写译文前要先 lock_source 拿源文件锁，再 lock_lang 拿每种目标语言的锁。成功返回 { locked:true, langs:[{ locale, path, existed, version }] }；失败返回 { locked:false, reason, locale?, path?, hint, errorCode }。写成功不会释放锁，可连续写多次。**返回体里的 locale 才是规范标签**（如 en→en_us 会被归一化），回执/日志以返回值为准。',
    {
      source: str('逻辑文件名，如 序章.hs（译文路径由它推导）'),
      locales: {
        type: 'array',
        description: '语言标签列表，如 ["zh_cn","en_us"]；省略 = 工程已有语言 + 当前语言',
        items: { type: 'string' },
      },
    },
    ['source'],
  ),
  defineTool(
    'lock',
    'unlock_lang',
    '【lock / 释放语言锁】释放某源文件在指定语言下的 .lang 锁，幂等。**locales 省略 = 本 Run 为该源文件持有的全部语言锁（含非工程语言）**；显式 locales = 只释放指定语言。只会释放本 Run 的锁。返回 { unlocked:[...], held:[...] }：unlocked 是真正释放的 .lang 路径，held 是**调用后本 Run 仍持有的全部路径（源文件 + 语言资产）**。',
    {
      source: str('逻辑文件名，如 序章.hs'),
      locales: {
        type: 'array',
        description: '语言标签列表；省略 = 本 Run 为该源文件持有的全部语言锁（含非工程语言）',
        items: { type: 'string' },
      },
    },
    ['source'],
  ),

  /* ── write 类：必须已持锁；未持锁的调用会被逐个拒绝（严格模式） ── */
  defineTool(
    'write',
    'create_source',
    '【write / 必须先 lock】新建一个源文件（.hs/.md/.char，也接受脚本/游戏性/meta 类资源；.lang/.voice 不能走这里）。**调用前必须** lock_source({ paths: [新文件名], creating: true }) 占住这个名字，否则会被拒绝。同名文件已存在会**失败**，绝不覆盖 —— 覆盖请用 write_source。语言文本用 write_lang；配音映射由界面维护。成功后返回 version（内容哈希），供下一轮 lock。',
    {
      source: str('逻辑文件名，如 序章.hs'),
      content: str('完整文件正文'),
    },
    ['source', 'content'],
  ),
  defineTool(
    'write',
    'write_source',
    '【write / 必须先 lock】覆盖一个**已存在**的源文件（.hs/.md/.char 等剧本可见文件）。**调用前必须** lock_source({ paths: [source] })。文件不存在会**失败** —— 新建请用 create_source。改稿优先用 edit_source 做局部替换。版本前置条件由锁强制，所以本工具**没有** expectedVersion 参数；若模型仍传 expectedVersion 会被忽略。语言文本不能走这里（用 write_lang）。成功后返回 version。',
    {
      source: str('逻辑文件名，如 序章.hs'),
      content: str('完整文件正文'),
    },
    ['source', 'content'],
  ),
  defineTool(
    'write',
    'edit_source',
    '【write / 必须先 lock】在源文件里做一次精确文本替换（oldText → newText）。**调用前必须** lock_source({ paths: [source] })。oldText 必须唯一命中，否则失败；失败就重新 read_source 再改。成功后返回 version。',
    {
      source: str('逻辑文件名，如 序章.hs'),
      oldText: str('要被替换的原文（含缩进，通常给足上下文以保证唯一）'),
      newText: str('替换后的文本；空串表示删除'),
      replaceAll: bool('true 时替换全部命中（默认 false，命中多处会失败）'),
    },
    ['source', 'oldText', 'newText'],
  ),
  defineTool(
    'write',
    'write_lang',
    '【write / 必须先 lock 源文件】一次写入多种语言的译文（多语言任务一次调用搞定）。**调用前必须两把锁都拿到**：lock_source({ paths: [source] }) 锁源文件，再 lock_lang({ source, locales: [...目标语言] }) 锁每个目标语言的 .lang；缺语言锁会被拒绝。写入只到**本地草稿**（返回 draft:true、saved:false、version:null），需要**用户保存工程**后才进文件；写完要在回复里提醒用户保存。语言标签用「语言_地区」小写下划线形式（如 zh_cn / en_us / ja_jp）；工程里已有该语言时会自动沿用它的标签，**返回体里的 locale 才是规范标签**（如 en→en_us 会被归一化），回执以返回值为准。键必须已存在于正文里（用 list_lang_keys 查）——单行语句写在行末 `narrator:7f3a91c2//`，多行块里键名单独占一行；新增台词要先 parse_hs 或 edit_source 把键写进正文。成功后返回 writtenPaths、fileTotal（**该语言文件的条目数，含正文已不再引用的孤儿键**；total 是同值兼容别名，注意 list_lang_keys.total 是正文键数，两者不同）与 warnings（"将来 unparse 无法安全还原"的风险：含 `//`、选项文案/回复里的 `:`、行首 `?`/`!`/`@`/`#`/`*`、行首 `>>`/`<<`、首尾空白；**只警告不拒绝**）。',
    {
      source: str('逻辑文件名，如 序章.hs'),
      translations: {
        type: 'object',
        description:
          '按语言分组的译文：{ "zh_cn": [{ key, text }], "en_us": [{ key, text }], "ja_jp": [...] }',
        additionalProperties: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: str('8 位十六进制键（见 list_lang_keys）'),
              text: str('译文'),
            },
            required: ['key', 'text'],
            additionalProperties: false,
          },
        },
      },
    },
    ['source', 'translations'],
  ),
  defineTool(
    'write',
    'delete_lang_keys',
    '【write / 必须先 lock 源文件】删除指定键的译文。**调用前必须** lock_source({ paths: [source] }) + lock_lang({ source, locales: [目标语言] })；缺语言锁会被拒绝。**默认拒绝删除正文仍在引用的键**（返回 reason=keys_in_use 与 inUseKeys）；确需删除时显式传 force:true。**键身份**：键名是**创建时那段文本**的哈希（跨语言共用同一键）；删除某语言条目后，若之后用另一种语言 unparse→parse，会按当前文本重新哈希、旧键变孤儿；**需要保键身份就别删该条目**。删除只写**本地草稿**（返回 draft:true、saved:false、version:null），需要用户保存工程后才进文件；成功后返回 writtenPaths 与草稿标记。',
    {
      source: str('逻辑文件名，如 序章.hs'),
      locale: str('语言标签；省略用当前语言'),
      keys: {
        type: 'array',
        description: '要删除的键',
        items: { type: 'string' },
      },
      force: bool('true = 即使正文仍在引用这些键也删除（危险，默认 false）'),
    },
    ['source', 'keys'],
  ),
  defineTool(
    'write',
    'parse_hs',
    '【write / 必须先 lock 源文件】解析（自动成键）：把正文里还不是键名的可本地化文本换成**文本哈希键**，同时把原文写进该语言的映射。**调用前必须** lock_source({ paths: [source] }) + lock_lang({ source, locales: [该语言] })；缺语言锁会被拒绝。**键名是这段文本的哈希：只有用同一种语言的文本重新 parse_hs 才能拿回原来的键**；跨语言 parse 会生成新键，并把该语言文本当作原文灌进目标语言（逆解析用的哪个 locale，就必须用同一个 locale 再 parse_hs）。译文映射只写**本地草稿**（返回 draft:true、saved:false、version:null），正文与译文都要等**用户保存工程**才进文件；成功后返回 writtenPaths 与草稿标记。**返回字段**：created = 本次去重后的**唯一键数**（实际写进映射的条目数）；replaced = 实际被换成键名的**正文语句数**——同文本重复台词共用同一个键时 replaced > created，它**不是**"覆盖了多少条旧译文"，而是"替换了多少处正文"。**返回体里的 locale 才是规范标签**（如 en→en_us 会被归一化），回执/日志以返回值为准。',
    {
      source: str('逻辑文件名，如 序章.hs'),
      locale: str('语言标签，如 zh_cn；省略用当前语言'),
    },
    ['source'],
  ),
  defineTool(
    'write',
    'unparse_hs',
    '【write / 必须先 lock 源文件】逆解析：把正文里的键名换回该语言映射里的文本（键名被替换掉），常用来把某个语言的内容还原成可读正文。**会改写正文**，动手前先跟用户确认，且**调用前必须** lock_source({ paths: [source] })。**键名是文本哈希：跨语言逆解析后原键无法恢复**（例如用 en_us 逆解析再 parse_hs(zh_cn)，会按英文文本生成新键、旧键变孤儿）；逆解析后请用**同一个 locale** 重新 parse_hs。多行译文与缺失译文不会处理，会如实报告。`#stopparse` 只影响解析成键，不拦逆解析。成功后返回 version 与英文 note。它只改正文，**只需要源文件锁（不需要 lock_lang）**。**返回体里的 locale 才是规范标签**（如 en→en_us 会被归一化），回执/日志以返回值为准。',
    {
      source: str('逻辑文件名，如 序章.hs'),
      locale: str('语言标签，如 zh_cn；省略用当前语言'),
    },
    ['source'],
  ),
]

/** OpenAI function-calling 形状的工具清单（facade 逐项包成 PI defineTool） */
export const AGENT_TOOLS: ToolDefinition[] = TOOL_SPECS.map((spec) => spec.tool)

/** 工具名 → 三语义分类。与 AGENT_TOOLS 同源生成，保证永远是同一集合（验收脚本第 1 项） */
export const AGENT_TOOL_KINDS: Record<string, AgentToolKind> = Object.fromEntries(
  TOOL_SPECS.map((spec) => [spec.tool.function.name, spec.kind] as const),
)

/** 工具名清单，供 system prompt / UI 引用 */
export const AGENT_TOOL_NAMES: string[] = TOOL_SPECS.map(
  (spec) => spec.tool.function.name,
)

/** 给 UI / 运行时查询分类用；未知工具名返回 undefined */
export function toolKindsOf(name: string): AgentToolKind | undefined {
  return AGENT_TOOL_KINDS[name]
}

/* ───────────────────────── 派发辅助 ───────────────────────── */

/* ───────────────────────── 错误载荷（B4 / 修正草案 §10） ───────────────────────── */

/** 工具失败体的统一错误码（B4）：所有 `{ok:false}` / `{locked:false}` 都必须带一个 */
export type AgentErrorCode =
  | 'not_found'
  | 'not_unique'
  | 'detached'
  | 'not_read'
  | 'version_stale'
  | 'held'
  | 'already_exists'
  | 'invalid_arguments'
  | 'invalid_keys'
  | 'keys_not_in_source'
  | 'keys_in_use'
  | 'write_failed'
  | 'local_only'
  | 'host_error'
  | 'unknown_tool'

const AGENT_ERROR_CODE_SET: ReadonlySet<string> = new Set<AgentErrorCode>([
  'not_found',
  'not_unique',
  'detached',
  'not_read',
  'version_stale',
  'held',
  'already_exists',
  'invalid_arguments',
  'invalid_keys',
  'keys_not_in_source',
  'keys_in_use',
  'write_failed',
  'local_only',
  'host_error',
  'unknown_tool',
])

export function isAgentErrorCode(value: unknown): value is AgentErrorCode {
  return typeof value === 'string' && AGENT_ERROR_CODE_SET.has(value)
}

/** 从宿主/仲裁失败体推断 errorCode：reason 优先，其次已知 error 形态，最后 host_error */
function inferErrorCode(result: { error?: unknown; reason?: unknown }): AgentErrorCode {
  if (isAgentErrorCode(result.reason)) return result.reason
  const error = typeof result.error === 'string' ? result.error : ''
  if (/not unique|duplicated? across|resource name is not unique/i.test(error)) return 'not_unique'
  if (/detached/i.test(error)) return 'detached'
  if (/keys? (?:are )?not in (?:the )?source|keys_not_in_source/i.test(error)) {
    return 'keys_not_in_source'
  }
  if (/still (?:referenced|in use)|keys_in_use/i.test(error)) return 'keys_in_use'
  if (/local[ -]only/i.test(error)) return 'local_only'
  if (/not found|does not exist|no such/i.test(error)) return 'not_found'
  if (/out of range|must be a positive integer|requires "|invalid translation keys/i.test(error)) {
    return 'invalid_arguments'
  }
  if (/write failed|failed to write/i.test(error)) return 'write_failed'
  return 'host_error'
}

/**
 * 失败体统一补 `errorCode`（B4）；成功体原样返回。
 * - `reason` 原样保留（lock / write_lang 的兼容字段），`errorCode` 与它同值；
 * - 宿主/仲裁没给 reason 时按 error 文本兜底；仍识别不了 → `host_error`。
 */
export function normalizeFailure<T extends { ok?: boolean; locked?: boolean }>(
  result: T,
): T & { errorCode?: AgentErrorCode } {
  if (result.ok !== false && result.locked !== false) {
    return result as T & { errorCode?: AgentErrorCode }
  }
  return {
    ...result,
    errorCode: inferErrorCode(result as { error?: unknown; reason?: unknown }),
  }
}

function jsonResult<T extends { ok?: boolean; locked?: boolean }>(result: T): string {
  return JSON.stringify(normalizeFailure(result))
}

function failJson(
  error: string,
  hint?: string,
  errorCode: AgentErrorCode = 'host_error',
): string {
  return JSON.stringify({
    ok: false,
    error,
    ...(hint === undefined ? {} : { hint }),
    errorCode,
  })
}

/**
 * write 被拒时的统一返回体：`{ ok:false, error, hint, errorCode }`。
 *
 * 严格模式的关键：**拒绝时绝不调用 host**，否则就是"先改了再说"。
 * B5-②：只有 `held | not_read | version_stale` 才追加 "Call lock_source…" 兜底；
 * `already_exists` 等宿主的 hint 已自洽（例如改用 write_source），不再拼锁提示。
 */
const LOCK_RECOVERY_REASONS: ReadonlySet<string> = new Set([
  'held',
  'not_read',
  'version_stale',
])

function deniedJson(
  source: AgentPath,
  denial: { error: string; hint?: string; reason?: string },
): string {
  const fallback = `Call lock_source({ "paths": ["${source}"] }) (use creating: true for a new file) to get the lock before writing.`
  let hint = denial.hint
  if (denial.reason !== undefined && LOCK_RECOVERY_REASONS.has(denial.reason)) {
    hint =
      hint === undefined
        ? fallback
        : hint.includes('lock_source')
          ? hint
          : `${hint} ${fallback}`
  }
  return jsonResult({
    ok: false,
    error: denial.error,
    ...(hint === undefined ? {} : { hint }),
    ...(denial.reason === undefined ? {} : { reason: denial.reason }),
  })
}

/**
 * 语言文件未持锁 / 版本不符时的拒绝体（修正草案 D5：工具返回的 error/hint 用英文）。
 *
 * 语言锁是独立的第二把锁：源文件锁拿到了不代表能写 `.lang`，hint 必须直接给出
 * `lock_lang({ source, locales })`，模型才知道下一步。**拒绝时不触达宿主**。
 */
function langDeniedJson(
  source: AgentPath,
  langTarget: { locale: string; path: AgentPath },
  denial: { reason?: string },
): string {
  return jsonResult({
    ok: false,
    error: `Language file is not writable: ${langTarget.path}`,
    source,
    locale: langTarget.locale,
    path: langTarget.path,
    hint: `Call lock_lang({ "source": "${source}", "locales": ["${langTarget.locale}"] }) before writing language files, then retry.`,
    ...(denial.reason === undefined ? {} : { reason: denial.reason }),
  })
}

/**
 * 草稿语义的统一提示（修正草案 D1 / D5）：
 * 所有工具写入只落**本地草稿**，用户显式保存工程后才进文件。
 * 按 D5，工具返回 JSON 内的文本用英文。
 */
const SAVE_PROJECT_HINT =
  'Draft only: ask the user to save the project to write these changes into the project files.'

/**
 * 源文件写工具成功后的收尾（草稿语义）：
 * 1. `noteWritten` 登记写后版本并**刷新锁锚点，不释放锁** —— 同一 Run 可以连续写（D2）；
 * 2. 返回 draft:true / saved:false，明确「只是草稿」；version 是**本地内容哈希**，
 *    只供下一轮 lock 参考，不代表已保存进工程文件；
 * 3. create_source 的版本由 noteWritten 提供，不再是空串（D6）；
 * 4. `changed` 以**写后版本 vs 持锁版本**为准（P7）：同内容重写为 false，避免把
 *    「写了一遍」误报成「内容变了」；没有 permit 版本时才退回宿主给的值。
 */
async function finishWrite(
  target: AgentToolTarget,
  paths: AgentPath[],
  result: AgentOpResult,
  permitVersion?: ContentVersion,
): Promise<string> {
  if (result.ok === false) {
    // 宿主写入失败：不登记；锁仍由本 Run 持有（写失败不释放，D7 第 10 条）
    return jsonResult({ ...result, ok: false })
  }
  const primary = paths[0]
  let primaryVersion: ContentVersion | null = null
  for (const path of paths) {
    const version = await target.arbiter.noteWritten(path)
    if (path === primary) primaryVersion = version
  }
  const hostVersion = typeof result.version === 'string' ? result.version : undefined
  const version = primaryVersion ?? hostVersion ?? permitVersion ?? null
  const hostChanged = typeof result.changed === 'boolean' ? result.changed : undefined
  const changed =
    permitVersion !== undefined && primaryVersion !== null
      ? primaryVersion !== permitVersion
      : hostChanged
  return JSON.stringify({
    ...result,
    ok: true,
    draft: true,
    saved: false,
    hint: SAVE_PROJECT_HINT,
    ...(version === null ? {} : { version }),
    ...(changed === undefined ? {} : { changed }),
  })
}

/**
 * 语言写工具成功后的收尾（草稿语义，修正草案 D1）：
 * - 保留宿主回报的 `writtenPaths`（哪些 `.lang` 的**草稿**被写），但宿主里任何
 *   `saved:true` / `savedToProject:true` / `version` 的「已落盘」信号一律改写成
 *   `draft:true, saved:false, version:null`；
 * - 多语言逐条结果（`locales`）也逐条改成 `draft:true, saved:false`；
 * - hint 用英文提醒用户保存工程（D5）。
 *
 * 仍然调 `noteWritten` 登记写后版本供锁表使用 —— 那是**本地草稿版本**，不出现在返回体里。
 */
async function finishLangWrite(
  target: AgentToolTarget,
  source: AgentPath,
  registered: AgentPath[],
  result: AgentOpResult,
): Promise<string> {
  if (result.ok === false) return jsonResult({ ...result, ok: false })

  const writtenPaths: AgentPath[] = []
  for (const path of [source, ...registered]) {
    await target.arbiter.noteWritten(path)
    if (path !== source) writtenPaths.push(path)
  }

  // 从宿主结果里剥掉所有「已保存」痕迹，再统一盖上草稿标记
  const rest: Record<string, unknown> = { ...result }
  delete rest.version
  delete rest.versions
  delete rest.draft
  delete rest.saved
  delete rest.hint
  const locales = Array.isArray(rest.locales)
    ? (rest.locales as unknown[]).map((entry) =>
        entry !== null && typeof entry === 'object'
          ? {
              ...(entry as Record<string, unknown>),
              draft: true,
              saved: false,
              savedToProject: false,
            }
          : entry,
      )
    : rest.locales
  return JSON.stringify({
    ...rest,
    ok: true,
    draft: true,
    saved: false,
    hint: SAVE_PROJECT_HINT,
    version: null,
    writtenPaths,
    ...(locales === undefined ? {} : { locales }),
  })
}

/**
 * write 类的标准派发：先强制校验锁（未持锁直接拒绝 → **不触达 host**），再执行、再登记。
 * `options.creating` 只给 create_source 用（占住不存在的名字）。
 */
async function guardedWrite(
  target: AgentToolTarget,
  path: AgentPath,
  options: { creating?: boolean } | undefined,
  action: () => AgentOpResult | Promise<AgentOpResult>,
): Promise<string> {
  // 注意：assertWritable 返回之前不调用 host —— 严格模式拒绝时 host 调用计数必须为 0
  const permit = await target.arbiter.assertWritable(path, options)
  if (!permit.ok) return deniedJson(path, permit)
  const result = await action()
  return finishWrite(target, [path], result, permit.version)
}

/**
 * 语言类写工具的前置（修正草案 D2「两把锁」）：
 *   源文件锁（lock_source） + 每个目标语言的 .lang 锁（lock_lang）
 *
 * 缺任一锁就拒绝，**不触达宿主**；缺少语言锁的 hint 用英文（D5）并直接给出 lock_lang 调用。
 * 目标语言来自参数（write_lang 的 translations 键 / delete_lang_keys、parse_hs 的 locale），
 * 由 host.derivedLangTargets 解析成实际 `.lang` 路径；省略语言 = 工程已有 + 当前语言。
 * 写入成功后登记源文件 + 宿主回报的实际写入路径（writtenPaths）的**草稿版本**，
 * 返回体统一盖成 draft:true / saved:false（D1：语言只写本地草稿，用户保存工程才进文件）。
 */
async function guardedLangWrite(
  target: AgentToolTarget,
  source: AgentPath,
  locales: string[] | undefined,
  action: () => Promise<AgentOpResult>,
): Promise<string> {
  const sourcePermit = await target.arbiter.assertWritable(source)
  if (!sourcePermit.ok) return deniedJson(source, sourcePermit)

  const langTargets = target.host.derivedLangTargets?.(source, locales) ?? []
  for (const langTarget of langTargets) {
    const langPermit = await target.arbiter.assertWritable(langTarget.path)
    if (!langPermit.ok) return langDeniedJson(source, langTarget, langPermit)
  }

  const result = await action()
  const rawWritten = (result as unknown as { writtenPaths?: unknown }).writtenPaths
  const written = Array.isArray(rawWritten)
    ? (rawWritten as unknown[]).filter(
        (path): path is AgentPath => typeof path === 'string' && path !== source,
      )
    : []
  // 宿主没回 writtenPaths 时按「目标语言路径都写到了」登记
  const registered = written.length > 0 ? written : langTargets.map((item) => item.path)
  return finishLangWrite(target, source, [...new Set(registered)], result)
}

/* ───────────────────────── 参数归一化 ───────────────────────── */

function text(args: Record<string, unknown>, key: string): string {
  return String(args[key] ?? '')
}

function optionalText(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return value == null || value === '' ? undefined : String(value)
}

type PositiveIntegerArg =
  | { ok: true; value: number | undefined }
  | { ok: false; error: string; hint: string }

/**
 * `read_source` 的 offset / limit：只接受缺省或正整数（6-A 参数校验）。
 * 0 / 负数 / 非整数 / 非数字都在**调用 arbiter / 宿主之前**拒绝 —— 别让模型用
 * 「offset: 0」这种写法去试探宿主行为。
 * offset 越界（> 总行数）不在这里判：由宿主返回 ok:false，工具原样透传（6-B）。
 */
function parsePositiveIntegerArg(
  args: Record<string, unknown>,
  key: 'offset' | 'limit',
): PositiveIntegerArg {
  const raw = args[key]
  if (raw === undefined || raw === null) return { ok: true, value: undefined }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    return {
      ok: false,
      error: `${key} must be a positive integer`,
      hint: `Call read_source with a positive integer ${key} (1-based), or omit ${key} to use the default.`,
    }
  }
  return { ok: true, value: raw }
}

/** 译文键的规范格式：小写 8 位十六进制（与 list_lang_keys 返回一致，D6 / 6-A） */
const LANG_KEY_PATTERN = /^[0-9a-f]{8}$/

type LangKeyIssues = { invalidKeys: string[]; duplicates: string[] }

function collectUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value)
}

/**
 * `write_lang` 的键检查。
 * 同一 key 出现在不同语言里是**正常**的（同一句台词的多语言译文），所以重复只在
 * 单个语言的列表内判；大写 / 非 8 位十六进制一律进 invalidKeys，**不再静默 toLowerCase**。
 */
function inspectTranslationKeys(value: unknown): LangKeyIssues {
  const invalidKeys: string[] = []
  const duplicates: string[] = []
  if (!value || typeof value !== 'object') return { invalidKeys, duplicates }
  for (const entries of Object.values(value as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue
    const seen = new Set<string>()
    for (const item of entries) {
      if (!item || typeof item !== 'object') continue
      const key = String((item as Record<string, unknown>).key ?? '').trim()
      if (!LANG_KEY_PATTERN.test(key)) {
        collectUnique(invalidKeys, key)
        continue
      }
      if (seen.has(key)) collectUnique(duplicates, key)
      else seen.add(key)
    }
  }
  return { invalidKeys, duplicates }
}

/** `delete_lang_keys` 的键检查：同一个 keys 数组内重复即 duplicates */
function inspectKeyList(value: unknown): LangKeyIssues {
  const invalidKeys: string[] = []
  const duplicates: string[] = []
  if (!Array.isArray(value)) return { invalidKeys, duplicates }
  const seen = new Set<string>()
  for (const item of value) {
    const key = String(item ?? '').trim()
    if (!LANG_KEY_PATTERN.test(key)) {
      collectUnique(invalidKeys, key)
      continue
    }
    if (seen.has(key)) collectUnique(duplicates, key)
    else seen.add(key)
  }
  return { invalidKeys, duplicates }
}

/** 键格式问题统一返回体：有 invalidKeys / duplicates 时拒绝且不触达锁 / 宿主 */
function invalidLangKeysJson(issues: LangKeyIssues): string {
  return JSON.stringify({
    ok: false,
    error: 'invalid translation keys',
    invalidKeys: issues.invalidKeys,
    duplicates: issues.duplicates,
    hint: 'Translation keys must be exactly 8 lowercase hex characters (for example "7f3a91c2"); call list_lang_keys to get the valid keys, then fix or remove the listed ones and retry.',
    errorCode: 'invalid_keys' satisfies AgentErrorCode,
  })
}

/** `lock_source` 的 paths 允许多种写法：数组（标准）、单个字符串（模型常犯的简化） */
function normalizePaths(value: unknown): string[] {
  if (typeof value === 'string') {
    const single = value.trim()
    return single ? [single] : []
  }
  return normalizeKeys(value)
}

/** `lock_lang` / `unlock_lang` 的 locales：省略或空 = 工程已有语言 + 当前语言 */
function normalizeLocales(value: unknown): string[] | undefined {
  if (typeof value === 'string') {
    const single = value.trim()
    return single ? [single] : undefined
  }
  const locales = normalizeKeys(value)
  return locales.length > 0 ? locales : undefined
}

function normalizeTranslations(value: unknown): Record<string, LangEntry[]> {
  if (!value || typeof value !== 'object') return {}
  const out: Record<string, LangEntry[]> = {}
  for (const [rawLocale, entries] of Object.entries(
    value as Record<string, unknown>,
  )) {
    const locale = rawLocale.trim()
    if (!locale || !Array.isArray(entries)) continue
    const list: LangEntry[] = []
    for (const item of entries) {
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      const key = String(record.key ?? '').trim()
      if (!key) continue
      list.push({ key, text: String(record.text ?? '') })
    }
    if (list.length > 0) out[locale] = list
  }
  return out
}

function normalizeKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => String(item ?? '').trim())
    .filter((item) => item.length > 0)
}

/* ───────────────────────── 派发 ───────────────────────── */

/**
 * 执行一次工具调用，返回 JSON 字符串（facade 原样作为 tool output 交给模型）。
 *
 * 失败一律返回 `{ ok:false, error }` 而不是抛异常：模型的下一步取决于错误里的 hint，
 * 抛出去只会让模型看到一条异常文本，失去可执行信息（§8「lock 的返回」）。
 */
export async function executeAgentTool(
  target: AgentToolTarget,
  call: AgentToolCall,
): Promise<string> {
  let args: Record<string, unknown> = {}
  try {
    args = call.function.arguments
      ? (JSON.parse(call.function.arguments) as Record<string, unknown>)
      : {}
  } catch {
    return failJson('tool arguments are not valid JSON', undefined, 'invalid_arguments')
  }

  const source = () => text(args, 'source')

  try {
    switch (call.function.name) {
      /* ── read 类 ── */
      case 'list_sources':
        return jsonResult(target.host.listSources(optionalText(args, 'package')))
      case 'read_source': {
        // 参数校验先于任何仲裁 / 宿主调用（6-A）：非法分页参数不该产生 read 版本登记
        const offset = parsePositiveIntegerArg(args, 'offset')
        if (!offset.ok) return failJson(offset.error, offset.hint, 'invalid_arguments')
        const limit = parsePositiveIntegerArg(args, 'limit')
        if (!limit.ok) return failJson(limit.error, limit.hint, 'invalid_arguments')
        // 必须走 arbiter.read：它按完整正文算版本并登记「本 Run 读过这一版」，
        // 直接 host.readSource 会让随后的 lock 全部以 not_read 失败（§8「read」）。
        // totalLines / limitClamped / offset 越界的 ok:false 都由仲裁层/宿主给出，原样透传。
        return jsonResult(await target.arbiter.read(source(), offset.value, limit.value))
      }
      case 'validate_source':
        return jsonResult(target.host.validateSource(source()))
      case 'get_active_file_path':
        return jsonResult(target.host.getActiveFilePath())
      case 'list_locales':
        return jsonResult(target.host.listLocales())
      case 'list_lang_keys': {
        // B2：分页参数先校验（非法 → invalid_arguments，且不调宿主）；limit 上限 1000
        const offset = parsePositiveIntegerArg(args, 'offset')
        if (!offset.ok) return failJson(offset.error, offset.hint, 'invalid_arguments')
        const limit = parsePositiveIntegerArg(args, 'limit')
        if (!limit.ok) return failJson(limit.error, limit.hint, 'invalid_arguments')
        if (limit.value !== undefined && limit.value > 1000) {
          return failJson(
            'limit must be <= 1000',
            'Call list_lang_keys with a limit between 1 and 1000, or omit it for the default (200).',
            'invalid_arguments',
          )
        }
        // 宿主 offset 越界的错误体（ok:false）原样透传，由 normalizeFailure 补 errorCode
        return jsonResult(
          await target.host.listLangKeys(
            source(),
            optionalText(args, 'locale'),
            offset.value,
            limit.value,
          ),
        )
      }
      case 'list_voice_status': {
        // B3：voice 也分页（offset 1 起、limit 默认 100、上限 500）
        const offset = parsePositiveIntegerArg(args, 'offset')
        if (!offset.ok) return failJson(offset.error, offset.hint, 'invalid_arguments')
        const limit = parsePositiveIntegerArg(args, 'limit')
        if (!limit.ok) return failJson(limit.error, limit.hint, 'invalid_arguments')
        if (limit.value !== undefined && limit.value > 500) {
          return failJson(
            'limit must be <= 500',
            'Call list_voice_status with a limit between 1 and 500, or omit it for the default (100).',
            'invalid_arguments',
          )
        }
        return jsonResult(
          await target.host.listVoiceStatus(
            source(),
            optionalText(args, 'locale'),
            offset.value,
            limit.value,
          ),
        )
      }
      case 'check_export':
        return jsonResult(await target.host.checkExport())

      /* ── lock 类 ── */
      case 'lock_source': {
        const requested = normalizePaths(args.paths)
        if (requested.length === 0) {
          return failJson(
            'lock_source requires at least one path, for example {"paths":["chapter.hs"]}',
            'Call read_source to confirm the logical file name first, then call lock_source({ "paths": ["chapter.hs"] }).',
            'invalid_arguments',
          )
        }
        // A2：占名前先用宿主校验/规范化名字（和 create_source 的落盘口径一致）。
        // 任一名字非法 → 直接拒绝，**不触达 arbiter**（绝不占住一个写不出去的名字）。
        const paths: AgentPath[] = []
        for (const name of requested) {
          const checked = target.host.validateSourceName?.(name)
          if (checked !== undefined && checked.ok === false) {
            return failJson(
              `invalid file name: ${name}`,
              checked.hint ??
                'Use a plain logical file name such as "chapter.hs"; do not pass directories, absolute paths, or reserved characters.',
              'invalid_arguments',
            )
          }
          paths.push(checked !== undefined && checked.ok ? checked.name : name)
        }
        // 成功/失败都直接透出：失败体带 reason/currentVersion/currentContent/hint，
        // normalizeFailure 另补 errorCode（reason 原样保留，兼容旧调用方）
        const locked = await target.arbiter.lock(
          paths,
          args.creating === true ? { creating: true } : undefined,
        )
        return jsonResult(locked)
      }
      case 'unlock_source': {
        const paths = normalizePaths(args.paths)
        if (paths.length === 0) {
          return failJson(
            'unlock_source requires "paths" (a logical file name or an array of them).',
            'Call get_active_file_path or list_sources to get logical file names, then retry.',
            'invalid_arguments',
          )
        }
        // 幂等：未持有的路径不报错，只出现在 unlocked 里；
        // held = 调用后本 Run 仍持有的**全部**路径（P3：含源文件与语言资产）
        const unlocked = target.arbiter.unlock(paths)
        return JSON.stringify({ unlocked, held: target.arbiter.heldPaths() })
      }
      case 'lock_lang': {
        const file = source()
        if (!file) {
          return failJson(
            'lock_lang requires "source" (the logical source file name).',
            'Call get_active_file_path or list_sources first.',
            'invalid_arguments',
          )
        }
        // 成功/失败都直接透出：失败体带 reason/locale/path/hint，另补 errorCode
        return jsonResult(await target.arbiter.lockLang(file, normalizeLocales(args.locales)))
      }
      case 'unlock_lang': {
        const file = source()
        if (!file) {
          return failJson(
            'unlock_lang requires "source" (the logical source file name).',
            'Call get_active_file_path or list_sources first.',
            'invalid_arguments',
          )
        }
        const locales = normalizeLocales(args.locales)
        if (locales === undefined) {
          // 1：省略 locales = 释放该源文件在本 Run 持有的**全部**语言锁（含非工程语言）。
          // 走 heldPaths 反查，而不是 unlockLang 的派生集合 —— 后者只覆盖工程语言表。
          const sourceName = file.trim().replace(/\\/g, '/')
          const lockedPaths = target.arbiter
            .heldPaths()
            .filter((path) => sourceNameFromLangPath(path) === sourceName)
          const unlocked = target.arbiter.unlock(lockedPaths)
          return JSON.stringify({ unlocked, held: target.arbiter.heldPaths() })
        }
        // 显式 locales：保持原语义，只释放指定语言的锁
        const unlocked = target.arbiter.unlockLang(file, locales)
        return JSON.stringify({ unlocked, held: target.arbiter.heldPaths() })
      }

      /* ── write 类：每个分支都先 assertWritable（未持锁则 host 不被调用） ── */
      case 'create_source':
        return guardedWrite(target, source(), { creating: true }, () =>
          target.host.createSource(source(), text(args, 'content')),
        )
      case 'write_source':
        // expectedVersion 已从 schema 删除；模型若仍传，这里直接忽略 —— 版本前置条件由锁强制
        return guardedWrite(target, source(), undefined, () =>
          target.host.writeSource(source(), text(args, 'content')),
        )
      case 'edit_source':
        return guardedWrite(target, source(), undefined, () =>
          target.host.editSource(
            source(),
            text(args, 'oldText'),
            text(args, 'newText'),
            args.replaceAll === true,
          ),
        )
      /* 语言类写工具：源文件锁 + 每个目标语言的 .lang 锁（修正草案 D2「两把锁」） */
      case 'write_lang': {
        // 键格式校验先于加锁 / 宿主（6-A）：非法或重复的键不能触发部分写入
        const issues = inspectTranslationKeys(args.translations)
        if (issues.invalidKeys.length > 0 || issues.duplicates.length > 0) {
          return invalidLangKeysJson(issues)
        }
        const translations = normalizeTranslations(args.translations)
        return guardedLangWrite(target, source(), Object.keys(translations), async () =>
          target.host.writeLang(source(), translations),
        )
      }
      case 'delete_lang_keys': {
        const issues = inspectKeyList(args.keys)
        if (issues.invalidKeys.length > 0 || issues.duplicates.length > 0) {
          return invalidLangKeysJson(issues)
        }
        const locale = optionalText(args, 'locale')
        return guardedLangWrite(
          target,
          source(),
          locale === undefined ? undefined : [locale],
          async () =>
            target.host.deleteLangKeys(
              source(),
              normalizeKeys(args.keys),
              locale,
              args.force === true,
            ),
        )
      }
      case 'parse_hs': {
        const locale = optionalText(args, 'locale')
        return guardedLangWrite(
          target,
          source(),
          locale === undefined ? undefined : [locale],
          async () => target.host.parseHs(source(), locale),
        )
      }
      case 'unparse_hs':
        // 逆解析只改正文：只要源文件锁，不需要 lock_lang（D2 锁前置条件表）
        return guardedWrite(target, source(), undefined, () =>
          target.host.unparseHs(source(), optionalText(args, 'locale')),
        )

      default:
        return JSON.stringify({
          ok: false,
          error: `unknown tool: ${call.function.name}`,
          errorCode: 'unknown_tool' satisfies AgentErrorCode,
        })
    }
  } catch (error) {
    // 结构化错误（6-A/B4）：宿主抛出的异常不能逃逸到模型侧（例如跨包同名
    // `resource name is not unique: X`），统一转成 {ok:false, error, hint, errorCode}。
    const message = error instanceof Error ? error.message : String(error)
    return failJson(
      message,
      'The host raised an unexpected error. Call list_sources to verify the file name, or report it to the user.',
      'host_error',
    )
  }
}
