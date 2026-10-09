/**
 * DeepSeek / OpenAI 兼容的工具定义与本地执行。
 *
 * 约定：工具只接受**逻辑名**（`序章.hs`），不接受 `src/`、`assets/` 等路径前缀；
 * 语言文本按「源文件 + 语言 + 键」操作，配音只查询状态（agent 不合成音频）。
 */

import type { VoiceState } from './agentOps'

export type AgentToolCall = {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export type AgentOpResult = { ok: boolean; [key: string]: unknown }

export type LangEntry = { key: string; text: string }

export type AgentHost = {
  /** 所有包与源文件（逻辑名 + 类别） */
  listSources: (packageName?: string) => AgentOpResult
  /** 分页读源文件；`version` 供后续写入做并发校验 */
  readSource: (source: string, offset?: number, limit?: number) => AgentOpResult
  /** 新建源文件；同名已存在时**失败**（改用 `writeSource`） */
  createSource: (source: string, content: string) => AgentOpResult
  /** 覆盖**已存在**的源文件；不存在时**失败**（改用 `createSource`）。`.lang` 交给 `writeLang` */
  writeSource: (
    source: string,
    content: string,
    expectedVersion?: number,
  ) => AgentOpResult
  /** 删除源文件，并连带删除它在所有语言下的语言文本与配音 */
  deleteSource: (source: string) => Promise<AgentOpResult>
  /** 精确字面替换 */
  editSource: (
    source: string,
    oldText: string,
    newText: string,
    replaceAll?: boolean,
  ) => AgentOpResult
  /** 改名，并连带搬迁所有语言的 lang / voice */
  renameSource: (source: string, newSource: string) => Promise<AgentOpResult>
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
  /** 删除译文键 */
  deleteLangKeys: (
    source: string,
    keys: string[],
    locale?: string,
  ) => Promise<AgentOpResult>
  /** 对等配音是否存在、是否单声道 Vorbis ogg */
  listVoiceStatus: (
    source: string,
    locale?: string,
  ) => Promise<AgentOpResult>
  /** 解析：把正文的可本地化文本换成键名，并把文本写进该语言的映射 */
  parseHs: (source: string, locale?: string) => Promise<AgentOpResult>
  /** 逆解析：把该语言映射里的文本换回正文（键名被替换掉） */
  unparseHs: (source: string, locale?: string) => Promise<AgentOpResult>
  /** 内存里预演两个导出，返回文件数与警告（不下载） */
  checkExport: () => Promise<AgentOpResult>
}

export type { VoiceState }

const str = (description: string) => ({ type: 'string', description })
const num = (description: string) => ({ type: 'number', description })

export const AGENT_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'list_sources',
      description:
        '列出所有工程与源文件（逻辑文件名、类别、大小、更新时间）。类别 hanshu/character/script/goal/progress/story/navigator/gift 对应 src/ 下源目录，meta 对应 meta/ 下的创作资料（.md 文档、.tts 配音方案、.ttsservice 服务定义）；旧 *.voice 可能仍在包根（root）。',
      parameters: {
        type: 'object',
        properties: {
          package: str('只看某个包；省略则列出全部包'),
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_source',
      description:
        '读取源文件内容。大文件请用 offset / limit 分页读。返回值里的 version 传给 write_source 可防止覆盖别人的修改。',
      parameters: {
        type: 'object',
        properties: {
          source: str('逻辑文件名，如 序章.hs（不带 src/ 前缀）'),
          offset: num('起始行号，1 起；默认 1'),
          limit: num('最多读多少行，默认 400，上限 2000'),
        },
        required: ['source'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_source',
      description:
        '新建一个源文件（.hs/.md/.char/.py）。同名文件已存在会**失败**，绝不覆盖 —— 覆盖请用 write_source。语言文本不能走这里（用 write_lang）。',
      parameters: {
        type: 'object',
        properties: {
          source: str('逻辑文件名，如 序章.hs'),
          content: str('完整文件正文'),
        },
        required: ['source', 'content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_source',
      description:
        '覆盖一个**已存在**的源文件（.hs/.md/.char/.py）。文件不存在会**失败** —— 新建请用 create_source。改稿优先用 edit_source 做局部替换。语言文本不能走这里（用 write_lang）。',
      parameters: {
        type: 'object',
        properties: {
          source: str('逻辑文件名，如 序章.hs'),
          content: str('完整文件正文'),
          expectedVersion: num(
            '上次 read_source 返回的 version；不符则拒绝写入（避免覆盖用户刚改的内容）',
          ),
        },
        required: ['source', 'content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'edit_source',
      description:
        '在源文件里做一次精确文本替换（oldText → newText）。oldText 必须唯一命中，否则失败；失败就重新 read_source 再改。',
      parameters: {
        type: 'object',
        properties: {
          source: str('逻辑文件名，如 序章.hs'),
          oldText: str('要被替换的原文（含缩进，通常给足上下文以保证唯一）'),
          newText: str('替换后的文本；空串表示删除'),
          replaceAll: {
            type: 'boolean',
            description: 'true 时替换全部命中（默认 false，命中多处会失败）',
          },
        },
        required: ['source', 'oldText', 'newText'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'rename_source',
      description:
        '重命名源文件，并同步重命名它与**所有语言**对应的语言文本与配音目录。',
      parameters: {
        type: 'object',
        properties: {
          source: str('当前逻辑文件名'),
          newSource: str('新逻辑文件名（后缀须与源格式一致）'),
        },
        required: ['source', 'newSource'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'delete_source',
      description:
        '删除一个源文件，并连带删除它在**所有语言**下的语言文本与配音资产。删掉无法自动恢复，删除前先跟用户确认。',
      parameters: {
        type: 'object',
        properties: {
          source: str('要删除的逻辑文件名，如 序章.hs'),
        },
        required: ['source'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'validate_source',
      description:
        '校验 .hs 剧本：返回语法诊断（未闭合 / 终结符 / 说话人换行等）与 .hsc 编译错误。改完剧本应调用一次。',
      parameters: {
        type: 'object',
        properties: {
          source: str('逻辑文件名，如 序章.hs'),
        },
        required: ['source'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_active_file_path',
      description:
        '返回用户在编辑器里当前打开的文件：逻辑名 name、类别 kind，以及项目相对路径 path（仅供理解结构，其它工具仍只收逻辑名）。',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_locales',
      description:
        '列出工程里已有的语言（含语言名与文本/配音文件数），并给出新语言的规范标签建议。写译文前先调用它，沿用工程里已有的标签。',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_lang_keys',
      description:
        '列出某个源文件里的本地化键，以及它在指定语言（默认当前语言）的译文与是否已翻译。翻译前先用它看清缺哪些键。',
      parameters: {
        type: 'object',
        properties: {
          source: str('逻辑文件名，如 序章.hs（键由该文件正文推导）'),
          locale: str('语言标签，如 zh_cn；省略用当前语言'),
          offset: num('起始序号，1 起；默认 1'),
          limit: num('最多返回多少条，默认 200'),
        },
        required: ['source'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_lang',
      description:
        '一次写入多种语言的译文（多语言任务一次调用搞定）。语言标签用「语言_地区」小写下划线形式（如 zh_cn / en_us / ja_jp）；工程里已有该语言时会自动沿用它的标签。键必须已存在于正文里（用 list_lang_keys 查）——单行语句写在行末 `narrator:7f3a91c2//`，多行块里键名单独占一行；新增台词要先 parse_hs 或 edit_source 把键写进正文。',
      parameters: {
        type: 'object',
        properties: {
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
        required: ['source', 'translations'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'delete_lang_keys',
      description: '删除指定键的译文（正文若仍在引用这些键，请先确认是否已废弃）。',
      parameters: {
        type: 'object',
        properties: {
          source: str('逻辑文件名，如 序章.hs'),
          locale: str('语言标签；省略用当前语言'),
          keys: {
            type: 'array',
            description: '要删除的键',
            items: { type: 'string' },
          },
        },
        required: ['source', 'keys'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_voice_status',
      description:
        '列出正文各键的对等配音状态：ok（单声道 Vorbis ogg）/ ref（该键是「引用资产」，指向包内另一份音频，refTarget 给出目标路径）/ missing（缺文件）/ not-ogg / invalid。agent 不能合成语音，缺配音时请如实告知用户。',
      parameters: {
        type: 'object',
        properties: {
          source: str('逻辑文件名，如 序章.hs'),
          locale: str('语言标签；省略用当前语言'),
        },
        required: ['source'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'parse_hs',
      description:
        '解析（自动成键）：把正文里还不是键名的可本地化文本换成**文本哈希键**，同时把原文写进该语言的映射。等价于编辑器里敲下 `//` 时走的自动成键流程。',
      parameters: {
        type: 'object',
        properties: {
          source: str('逻辑文件名，如 序章.hs'),
          locale: str('语言标签，如 zh_cn；省略用当前语言'),
        },
        required: ['source'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'unparse_hs',
      description:
        '逆解析：把正文里的键名换回该语言映射里的文本（键名被替换掉），常用来把某个语言的内容还原成可读正文。**会改写正文**，动手前先跟用户确认。多行译文与缺失译文不会处理，会如实报告。`#stopparse` 只影响解析成键，不拦逆解析。',
      parameters: {
        type: 'object',
        properties: {
          source: str('逻辑文件名，如 序章.hs'),
          locale: str('语言标签，如 zh_cn；省略用当前语言'),
        },
        required: ['source'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'check_export',
      description:
        '预演导出：返回 combined PAK 与工程包各有几个文件、有哪些警告（不下载；分平面见帮助「导出 PAK」）。',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
]

/** 工具名清单，供 system prompt 引用 */
export const AGENT_TOOL_NAMES = AGENT_TOOLS.map((tool) => tool.function.name)

export async function executeAgentTool(
  host: AgentHost,
  call: AgentToolCall,
): Promise<string> {
  let args: Record<string, unknown> = {}
  try {
    args = call.function.arguments
      ? (JSON.parse(call.function.arguments) as Record<string, unknown>)
      : {}
  } catch {
    return JSON.stringify({ ok: false, error: '工具参数不是合法 JSON' })
  }

  const text = (key: string) => String(args[key] ?? '')
  const optionalText = (key: string) => {
    const value = args[key]
    return value == null || value === '' ? undefined : String(value)
  }
  const optionalNumber = (key: string) => {
    const value = args[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }

  try {
    switch (call.function.name) {
      case 'list_sources':
        return JSON.stringify(host.listSources(optionalText('package')))
      case 'read_source':
        return JSON.stringify(
          host.readSource(text('source'), optionalNumber('offset'), optionalNumber('limit')),
        )
      case 'create_source':
        return JSON.stringify(host.createSource(text('source'), text('content')))
      case 'write_source':
        return JSON.stringify(
          host.writeSource(
            text('source'),
            text('content'),
            optionalNumber('expectedVersion'),
          ),
        )
      case 'delete_source':
        return JSON.stringify(await host.deleteSource(text('source')))
      case 'edit_source': {
        return JSON.stringify(
          host.editSource(
            text('source'),
            text('oldText'),
            text('newText'),
            args.replaceAll === true,
          ),
        )
      }
      case 'rename_source':
        return JSON.stringify(
          await host.renameSource(text('source'), text('newSource')),
        )
      case 'validate_source':
        return JSON.stringify(host.validateSource(text('source')))
      case 'get_active_file_path':
        return JSON.stringify(host.getActiveFilePath())
      case 'list_locales':
        return JSON.stringify(host.listLocales())
      case 'list_lang_keys':
        return JSON.stringify(
          await host.listLangKeys(
            text('source'),
            optionalText('locale'),
            optionalNumber('offset'),
            optionalNumber('limit'),
          ),
        )
      case 'write_lang':
        return JSON.stringify(
          await host.writeLang(
            text('source'),
            normalizeTranslations(args.translations),
          ),
        )
      case 'delete_lang_keys':
        return JSON.stringify(
          await host.deleteLangKeys(
            text('source'),
            normalizeKeys(args.keys),
            optionalText('locale'),
          ),
        )
      case 'list_voice_status':
        return JSON.stringify(
          await host.listVoiceStatus(text('source'), optionalText('locale')),
        )
      case 'parse_hs':
        return JSON.stringify(
          await host.parseHs(text('source'), optionalText('locale')),
        )
      case 'unparse_hs':
        return JSON.stringify(
          await host.unparseHs(text('source'), optionalText('locale')),
        )
      case 'check_export':
        return JSON.stringify(await host.checkExport())
      default:
        return JSON.stringify({
          ok: false,
          error: `未知工具: ${call.function.name}`,
        })
    }
  } catch (error) {
    return JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
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
