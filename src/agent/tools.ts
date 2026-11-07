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
    '【read / 只读，无需锁】列出所有工程与源文件（逻辑文件名、类别、大小、更新时间）。类别 hanshu/character/script/goal/progress/story/navigator/gift 对应 src/ 下源目录，meta 对应 meta/ 下的创作资料（.md 文档、.tts 配音方案、.ttsservice 服务定义）；旧 *.voice 可能仍在包根（root）。',
    {
      package: str('只看某个包；省略则列出全部包'),
    },
  ),
  defineTool(
    'read',
    'read_source',
    '【read / 只读但会登记版本】读取源文件内容，返回 content 与 version（内容哈希）。大文件用 offset / limit 分页读。**任何写入前都必须先用本工具读过该文件**（lock 的 not_read 判据）；version 不需要手动传给 write_source —— 版本前置条件由锁强制。',
    {
      source: str('逻辑文件名，如 序章.hs（不带 src/ 前缀）'),
      offset: num('起始行号，1 起；默认 1'),
      limit: num('最多读多少行，默认 400，上限 2000'),
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
    '【read / 只读，无需锁】列出某个源文件里的本地化键，以及它在指定语言（默认当前语言）的译文与是否已翻译。读的是**工程文件**（S 权威），返回 version 与 localDraft（用户还有未保存草稿时 true）。翻译前先用它看清缺哪些键。',
    {
      source: str('逻辑文件名，如 序章.hs（键由该文件正文推导）'),
      locale: str('语言标签，如 zh_cn；省略用当前语言'),
      offset: num('起始序号，1 起；默认 1'),
      limit: num('最多返回多少条，默认 200'),
    },
    ['source'],
  ),
  defineTool(
    'read',
    'list_voice_status',
    '【read / 只读，无需锁】列出正文各键的对等配音状态：ok（单声道 Vorbis ogg）/ ref（该键是「引用资产」，指向包内另一份音频，refTarget 给出目标路径）/ missing（缺文件）/ not-ogg / invalid。agent 不能合成语音，缺配音时请如实告知用户。',
    {
      source: str('逻辑文件名，如 序章.hs'),
      locale: str('语言标签；省略用当前语言'),
    },
    ['source'],
  ),
  defineTool(
    'read',
    'check_export',
    '【read / 只读，无需锁】预演导出：返回 combined PAK 与工程包各有几个文件、有哪些警告（不下载；分平面见帮助「导出 PAK」）。',
    {},
  ),

  /* ── lock 类：write 的唯一前置条件；多路径原子、不等待（§8） ── */
  defineTool(
    'lock',
    'lock_source',
    '【lock / write 的前置条件】占住一个或多个路径。多路径原子：要么全部拿到，要么一个都不持有。前提：本 Run 已 read 过且最后读到的版本仍是当前版本、人类没有未提交的脏编辑。creating:true 表示「占住一个还不存在的名字」，create_source 与 rename_source 的目标名要用它。成功返回 { locked:true, version, content }；失败返回 { locked:false, reason, currentVersion, currentContent, hint }，reason ∈ version_stale | human_editing | not_read | not_found | held —— 按 reason 自愈，hint 就是下一步。锁不等待：拿不到立即失败；同一文件连续被拒 3 次就放弃并如实报告用户。',
    {
      paths: {
        type: 'array',
        description: '要占住的逻辑文件名列表（多文件时一次传全，保证原子）',
        items: { type: 'string' },
      },
      creating: bool(
        'true = 占住一个尚不存在的名字（新建文件、改名的目标名）；目标已存在时 lock 失败',
      ),
    },
    ['paths'],
  ),

  /* ── write 类：必须已持锁；未持锁的调用会被逐个拒绝（严格模式） ── */
  defineTool(
    'write',
    'create_source',
    '【write / 必须先 lock】新建一个剧本类源文件（.hs/.md/.char）。**调用前必须** lock_source({ paths: [新文件名], creating: true }) 占住这个名字，否则会被拒绝。同名文件已存在会**失败**，绝不覆盖 —— 覆盖请用 write_source。脚本与游戏性类型请到游戏性工作区创建。语言文本不能走这里（用 write_lang）。成功后返回 version（内容哈希），供下一轮 lock。',
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
    'rename_source',
    '【write / 源与目标都要 lock】重命名源文件，并同步重命名它与**所有语言**对应的语言文本与配音目录。**源与目标都要持锁**：先 lock_source({ paths: [source] })，再 lock_source({ paths: [newSource], creating: true })；任一失败都不要调用本工具（多路径原子）。目标已存在会失败。成功后返回 version。',
    {
      source: str('当前逻辑文件名'),
      newSource: str('新逻辑文件名（后缀须与源格式一致）'),
    },
    ['source', 'newSource'],
  ),
  defineTool(
    'write',
    'delete_source',
    '【write / 必须先 lock】删除一个源文件，并连带删除它在**所有语言**下的语言文本与配音资产。**调用前必须** lock_source({ paths: [source] })。删掉无法自动恢复，删除前先跟用户确认。成功后返回 version。',
    {
      source: str('要删除的逻辑文件名，如 序章.hs'),
    },
    ['source'],
  ),
  defineTool(
    'write',
    'write_lang',
    '【write / 必须先 lock 源文件】一次写入多种语言的译文（多语言任务一次调用搞定）。**调用前必须** lock_source({ paths: [source] })；源文件的锁同时覆盖它**已存在**的派生语言资产（外部改过会以版本冲突拒绝）。译文会**立即写进工程文件**（不需要再保存工程），返回 writtenPaths 与 version。语言标签用「语言_地区」小写下划线形式（如 zh_cn / en_us / ja_jp）；工程里已有该语言时会自动沿用它的标签。键必须已存在于正文里（用 list_lang_keys 查）——单行语句写在行末 `narrator:7f3a91c2//`，多行块里键名单独占一行；新增台词要先 parse_hs 或 edit_source 把键写进正文。成功后返回 version。',
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
    '【write / 必须先 lock 源文件】删除指定键的译文（正文若仍在引用这些键，请先确认是否已废弃）。**调用前必须** lock_source({ paths: [source] })；源文件的锁覆盖派生的语言资产。删除**立即写进工程文件**，成功后返回 writtenPaths 与 version。',
    {
      source: str('逻辑文件名，如 序章.hs'),
      locale: str('语言标签；省略用当前语言'),
      keys: {
        type: 'array',
        description: '要删除的键',
        items: { type: 'string' },
      },
    },
    ['source', 'keys'],
  ),
  defineTool(
    'write',
    'parse_hs',
    '【write / 必须先 lock 源文件】解析（自动成键）：把正文里还不是键名的可本地化文本换成**文本哈希键**，同时把原文写进该语言的映射。**调用前必须** lock_source({ paths: [source] })；源文件的锁覆盖派生的语言资产。译文映射立即写进工程文件（正文仍是草稿，等保存工程），成功后返回 writtenPaths 与 version。',
    {
      source: str('逻辑文件名，如 序章.hs'),
      locale: str('语言标签，如 zh_cn；省略用当前语言'),
    },
    ['source'],
  ),
  defineTool(
    'write',
    'unparse_hs',
    '【write / 必须先 lock 源文件】逆解析：把正文里的键名换回该语言映射里的文本（键名被替换掉），常用来把某个语言的内容还原成可读正文。**会改写正文**，动手前先跟用户确认，且**调用前必须** lock_source({ paths: [source] })。多行译文与缺失译文不会处理，会如实报告。`#stopparse` 只影响解析成键，不拦逆解析。成功后返回 version。',
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

function failJson(error: string, hint?: string): string {
  return JSON.stringify(hint === undefined ? { ok: false, error } : { ok: false, error, hint })
}

/**
 * write 被拒时的统一返回体：`{ ok:false, error, hint }`。
 *
 * 严格模式的关键：**拒绝时绝不调用 host**，否则就是"先改了再说"。
 * hint 里必须能直接看到 lock_source（§8：错误里给出可执行下一步）；
 * 仲裁层给了更具体 hint 时保留它，只在它没提到 lock_source 时补上兜底提示。
 */
function deniedJson(
  source: AgentPath,
  denial: { error: string; hint?: string },
): string {
  const fallback = `请先调用 lock_source({ paths: ["${source}"] })（新建/改名目标用 creating: true），拿到锁再写。`
  const hint =
    denial.hint === undefined
      ? fallback
      : denial.hint.includes('lock_source')
        ? denial.hint
        : `${denial.hint} ${fallback}`
  return JSON.stringify({ ok: false, error: denial.error, hint })
}

/**
 * write 成功后的统一收尾：
 * 1. `noteWritten` 让仲裁层重新读内容、登记本 Run 写出的版本并消费锁（§8 锁生命周期①）；
 * 2. 把宿主返回的 `version`（内容哈希）透传给模型，模型下一轮 lock 时不必自己算。
 *
 * 宿主没给 version 时退化为 assertWritable 返回的版本；两者都没有就省略字段
 * （不伪造版本，避免模型拿错哈希去 lock）。
 */
async function finishWrite(
  target: AgentToolTarget,
  paths: AgentPath[],
  result: AgentOpResult,
  fallbackVersion?: ContentVersion,
): Promise<string> {
  if (result.ok === false) {
    // 宿主写入失败：不登记、不消费锁（锁会在本轮结束由 facade 的 endRound 释放）
    return JSON.stringify({ ...result, ok: false })
  }
  for (const path of paths) await target.arbiter.noteWritten(path)
  const version = typeof result.version === 'string' ? result.version : fallbackVersion
  return JSON.stringify({
    ...result,
    ok: true,
    ...(version === undefined ? {} : { version }),
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
 * 语言类写工具：源文件的锁 + 派生语言资产的版本守卫。
 *
 * 源文件的锁在仲裁层已经展开到「已存在的语言资产」；这里在真正写入前
 * 再核对一遍：如果某个语言文件在 lock 之后被外部改过，就拒绝本次写入并告诉模型
 * 重新 lock + 重新读。**不能**用源文件版本没变冒充"语言文件没被改过"——
 * 这正是译文被悄悄覆盖率、而 agent 毫无察觉的根因（§8 派生资产、TOCTOU）。
 */
async function guardedLangWrite(
  target: AgentToolTarget,
  source: AgentPath,
  action: () => Promise<AgentOpResult>,
): Promise<string> {
  const permit = await target.arbiter.assertWritable(source)
  if (!permit.ok) return deniedJson(source, permit)

  for (const derived of target.host.derivedLangPaths?.(source) ?? []) {
    const current = await target.host.readAssetText?.(derived)
    if (current === null || current === undefined) continue // 还不存在：本次会新建
    const sibling = await target.arbiter.assertWritable(derived)
    if (!sibling.ok) {
      return JSON.stringify({
        ok: false,
        error: `语言文件在 lock 之后被外部修改：${derived}`,
        source,
        path: derived,
        hint:
          `先 lock_source({ paths: ["${source}"] }) 重新取锁，` +
          '再用 list_lang_keys 读最新译文后重试；不要覆盖别人的改动。',
      })
    }
  }

  const result = await action()
  const rawWritten = (result as unknown as { writtenPaths?: unknown }).writtenPaths
  const written = Array.isArray(rawWritten)
    ? (rawWritten as AgentPath[]).filter((path) => path !== source)
    : []
  return finishWrite(target, [source, ...written], result, permit.version)
}

/* ───────────────────────── 参数归一化 ───────────────────────── */

function text(args: Record<string, unknown>, key: string): string {
  return String(args[key] ?? '')
}

function optionalText(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return value == null || value === '' ? undefined : String(value)
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** `lock_source` 的 paths 允许多种写法：数组（标准）、单个字符串（模型常犯的简化） */
function normalizePaths(value: unknown): string[] {
  if (typeof value === 'string') {
    const single = value.trim()
    return single ? [single] : []
  }
  return normalizeKeys(value)
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
    return failJson('工具参数不是合法 JSON')
  }

  const source = () => text(args, 'source')

  try {
    switch (call.function.name) {
      /* ── read 类 ── */
      case 'list_sources':
        return JSON.stringify(target.host.listSources(optionalText(args, 'package')))
      case 'read_source':
        // 必须走 arbiter.read：它按完整正文算版本并登记「本 Run 读过这一版」，
        // 直接 host.readSource 会让随后的 lock 全部以 not_read 失败（§8「read」）。
        return JSON.stringify(
          await target.arbiter.read(
            source(),
            optionalNumber(args, 'offset'),
            optionalNumber(args, 'limit'),
          ),
        )
      case 'validate_source':
        return JSON.stringify(target.host.validateSource(source()))
      case 'get_active_file_path':
        return JSON.stringify(target.host.getActiveFilePath())
      case 'list_locales':
        return JSON.stringify(target.host.listLocales())
      case 'list_lang_keys':
        return JSON.stringify(
          await target.host.listLangKeys(
            source(),
            optionalText(args, 'locale'),
            optionalNumber(args, 'offset'),
            optionalNumber(args, 'limit'),
          ),
        )
      case 'list_voice_status':
        return JSON.stringify(
          await target.host.listVoiceStatus(source(), optionalText(args, 'locale')),
        )
      case 'check_export':
        return JSON.stringify(await target.host.checkExport())

      /* ── lock 类 ── */
      case 'lock_source': {
        const paths = normalizePaths(args.paths)
        if (paths.length === 0) {
          return failJson(
            'lock_source 需要至少一个路径，例如 {"paths":["序章.hs"]}',
            '先 read_source 确认逻辑文件名，再调 lock_source({ paths: ["序章.hs"] })',
          )
        }
        // 成功/失败都直接透出：失败体带 currentVersion/currentContent/hint，供模型一次往返自愈
        const locked = await target.arbiter.lock(
          paths,
          args.creating === true ? { creating: true } : undefined,
        )
        return JSON.stringify(locked)
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
      case 'rename_source': {
        // 多路径原子：源 + 目标都拿到锁才允许调用宿主；任一失败都不产生任何改动（§8「特殊路径」）
        const from = source()
        const to = text(args, 'newSource')
        const fromPermit = await target.arbiter.assertWritable(from)
        if (!fromPermit.ok) return deniedJson(from, fromPermit)
        const toPermit = await target.arbiter.assertWritable(to, { creating: true })
        if (!toPermit.ok) return deniedJson(to, toPermit)
        const result = await target.host.renameSource(from, to)
        // 两个路径都变了：各自 noteWritten（撤销日志与后续版本校验都需要）
        return finishWrite(target, [from, to], result, fromPermit.version)
      }
      case 'delete_source':
        return guardedWrite(target, source(), undefined, () =>
          target.host.deleteSource(source()),
        )
      /*
       * 语言类与解析类写工具改的是「源文件 + 派生资产」（.lang / .voice / .ogg）：
       * 契约里宿主把这一次调用当作源文件的一次事务，因此这里只校验**源文件**的锁。
       * 取舍：派生资产随源文件一起提交，源文件的锁覆盖它们；不额外锁 assets 路径，
       * 否则模型要为每个语言/每个配音键 lock 一次，锁协议会退化成不可用。
       * 这与 §8「多文件先全验后全写」不矛盾 —— 它们是同一事务的产物，不是独立资源。
       */
      case 'write_lang':
        return guardedLangWrite(target, source(), async () =>
          target.host.writeLang(source(), normalizeTranslations(args.translations)),
        )
      case 'delete_lang_keys':
        return guardedLangWrite(target, source(), async () =>
          target.host.deleteLangKeys(
            source(),
            normalizeKeys(args.keys),
            optionalText(args, 'locale'),
          ),
        )
      case 'parse_hs':
        return guardedLangWrite(target, source(), async () =>
          target.host.parseHs(source(), optionalText(args, 'locale')),
        )
      case 'unparse_hs':
        return guardedWrite(target, source(), undefined, () =>
          target.host.unparseHs(source(), optionalText(args, 'locale')),
        )

      default:
        return JSON.stringify({
          ok: false,
          error: `未知工具: ${call.function.name}`,
        })
    }
  } catch (error) {
    return failJson(error instanceof Error ? error.message : String(error))
  }
}
