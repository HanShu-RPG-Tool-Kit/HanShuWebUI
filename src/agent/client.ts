import { getAgentConfig } from './config'
import { AGENT_RULES } from './rules'
import syntaxDocs from '../help/docs/hanshu-syntax.md?raw'
import {
  AGENT_TOOLS,
  AGENT_TOOL_NAMES,
  executeAgentTool,
  type AgentHost,
  type AgentToolCall,
} from './tools'

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: AgentToolCall[]
  tool_call_id?: string
  name?: string
}

export type AgentContext = {
  packageName: string
  fileName: string
  content: string
  selection?: string
}

function buildSystemPrompt(ctx: AgentContext): string {
  const clipped =
    ctx.content.length > 12000
      ? `${ctx.content.slice(0, 12000)}\n\n…(正文已截断)`
      : ctx.content

  const selectionBlock = ctx.selection?.trim()
    ? `\n\n## 当前选区\n\`\`\`\n${ctx.selection.trim()}\n\`\`\``
    : ''

  return `${AGENT_RULES}

## 正式语法文档（含正反例，必须遵守）
${syntaxDocs}

## 工具使用
你可以使用工具读写资源管理器中的文件（浏览器本地工作区，不需要 git）。
可用工具：${AGENT_TOOL_NAMES.join('、')}
- 先看有什么：\`list_sources\`（参数一律写逻辑文件名，如 序章.hs，不要带 src/ 前缀）
- 读文件：\`read_source\`（大文件用 offset / limit 分页）
- 新建文件：\`create_source\`（重名会失败）；覆盖已有文件：\`write_source\`（不存在会失败）；
  删除：\`delete_source\`（连带各语言译文与配音，删前先问用户）
- 不要靠"换个名字再新建"来试探工具；不确定就先读、先问
- 改「用户当前打开的文件」：先 \`get_active_file_path\` 拿到 source，再用 \`edit_source\` / \`write_source\`
- 改完 .hs 调一次 \`validate_source\`（语法诊断 + .hsc 编译校验）
- 语言标签用「语言_地区」小写下划线形式（zh_cn / en_us / ja_jp）；**写译文前先 list_locales**，沿用工程里已有的标签
- 译文：\`list_lang_keys\` 看缺哪些键 → \`write_lang\` 写（键来自正文：单行如 \`narrator:7f3a91c2//\`，多行块里键名单独占一行）；
  也可以让编辑器自动成键：\`parse_hs(source)\`；反向还原正文用 \`unparse_hs(source, locale)\`（会改写正文，先问用户）
- 配音：\`list_voice_status\` 查状态（你不能合成语音；缺了就如实说，不要假装已生成）
- 导出前用 \`check_export\` 预演文件数与警告
- 成功写入后简短确认即可，不要再整篇重复贴出。
- 写入前按文档末尾「自检清单」检查。
- 一次只改你需要的文件；新建 md/文档时绝不要覆盖用户当前的 .hs。

## 当前编辑上下文
- 包：${ctx.packageName}
- 文件：${ctx.fileName}

## 当前文件正文
\`\`\`
${clipped || '(空文件)'}
\`\`\`
${selectionBlock}`
}

type CompletionMessage = {
  role: string
  content: string | null
  tool_calls?: AgentToolCall[]
}

async function chatOnce(options: {
  messages: ChatMessage[]
  signal?: AbortSignal
}): Promise<{
  message: CompletionMessage
  finishReason: string
}> {
  const { apiKey, baseUrl, model, temperature } = getAgentConfig()
  if (!apiKey) {
    throw new Error(
      '未配置 API Key：请在项目根目录 `.env` 填写 VITE_DEEPSEEK_API_KEY',
    )
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: options.messages,
      stream: false,
      temperature,
      tools: AGENT_TOOLS,
      tool_choice: 'auto',
    }),
    signal: options.signal,
  })

  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    throw new Error(
      `DeepSeek 请求失败 (${response.status}): ${errText || response.statusText}`,
    )
  }

  const data = (await response.json()) as {
    choices?: Array<{
      finish_reason?: string
      message?: CompletionMessage
    }>
  }
  const choice = data.choices?.[0]
  if (!choice?.message) {
    throw new Error('DeepSeek 返回空消息')
  }
  return {
    message: choice.message,
    finishReason: choice.finish_reason ?? 'stop',
  }
}

/**
 * 带工具调用的 Agent 回合（非流式循环；最终正文一次性写出）。
 * 不需要 git：写入的是编辑器本地工作区。
 */
export async function runAgentTurn(options: {
  history: ChatMessage[]
  userText: string
  context: AgentContext
  host: AgentHost
  signal?: AbortSignal
  onStatus?: (text: string) => void
  onDelta: (chunk: string) => void
}): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(options.context) },
    ...options.history.filter((m) => m.role !== 'system'),
    { role: 'user', content: options.userText },
  ]

  const maxRounds = 32
  /** 单轮对话里允许 agent 新建的源文件数：越界要求它解释，避免 probe 式乱造 */
  const CREATE_LIMIT = 3
  const callCounts = new Map<string, number>()
  let createdCount = 0
  let hintIndex = -1

  for (let round = 0; round < maxRounds; round++) {
    if (options.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }
    options.onStatus?.(`思考中… (${round + 1}/${maxRounds})`)

    // 让模型知道还剩几轮：进入最后四分之一就提醒收尾
    const remaining = maxRounds - round
    if (remaining <= Math.ceil(maxRounds / 4)) {
      const hint = `【系统提醒】本轮只剩 ${remaining} 次工具调用机会。请尽快收尾：不要再试探性新建文件，先给用户一个明确结论。`
      if (hintIndex < 0) {
        messages.push({ role: 'system', content: hint })
        hintIndex = messages.length - 1
      } else {
        messages[hintIndex] = { role: 'system', content: hint }
      }
    }

    const { message, finishReason } = await chatOnce({
      messages,
      signal: options.signal,
    })

    const toolCalls = message.tool_calls ?? []
    if (toolCalls.length > 0 || finishReason === 'tool_calls') {
      messages.push({
        role: 'assistant',
        content: message.content ?? null,
        tool_calls: toolCalls,
      })

      for (const call of toolCalls) {
        options.onStatus?.(`工具：${call.function.name}`)
        const signature = `${call.function.name}::${call.function.arguments}`
        const repeats = (callCounts.get(signature) ?? 0) + 1
        callCounts.set(signature, repeats)

        let result: string
        if (repeats > 1) {
          result = JSON.stringify({
            ok: false,
            error: `重复调用：${call.function.name} 的参数与上一次完全相同`,
            hint: '同样的调用不会得到新结果。请换做法（改参数 / 换工具），或直接把结论告诉用户。',
          })
        } else if (
          call.function.name === 'create_source' &&
          createdCount >= CREATE_LIMIT
        ) {
          result = JSON.stringify({
            ok: false,
            error: `本轮新建文件已达上限 ${CREATE_LIMIT} 个`,
            hint: '不要为了试探工具而继续新建。请先说明为什么还需要更多文件，或改用 edit_source / write_source 修改已有文件。',
          })
        } else {
          result = await executeAgentTool(options.host, call)
          if (call.function.name === 'create_source' && toolSucceeded(result)) {
            createdCount++
          } else if (call.function.name === 'delete_source') {
            createdCount = Math.max(0, createdCount - 1)
          }
        }

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.function.name,
          content: result,
        })
      }
      continue
    }

    const text = message.content ?? ''
    if (text) options.onDelta(text)
    options.onStatus?.('')
    return text
  }

  throw new Error('工具调用轮次过多，已中止')
}

/** 工具返回是否成功（用于新建计数） */
function toolSucceeded(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as { ok?: boolean; created?: boolean }
    return parsed.ok === true && parsed.created === true
  } catch {
    return false
  }
}

/** @deprecated 使用 runAgentTurn；保留别名以免旧引用报错 */
export const streamAgentReply = async (options: {
  history: ChatMessage[]
  userText: string
  context: AgentContext
  signal?: AbortSignal
  onDelta: (chunk: string) => void
  host?: AgentHost
  onStatus?: (text: string) => void
}) => {
  if (!options.host) {
    throw new Error('缺少 AgentHost（写入工具宿主）')
  }
  return runAgentTurn({
    history: options.history,
    userText: options.userText,
    context: options.context,
    host: options.host,
    signal: options.signal,
    onDelta: options.onDelta,
    onStatus: options.onStatus,
  })
}
