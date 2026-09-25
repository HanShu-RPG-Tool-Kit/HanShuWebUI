import { getAgentConfig } from './config'
import { AGENT_RULES } from './rules'
import syntaxDocs from '../../docs/hanshu-syntax.md?raw'
import {
  AGENT_TOOLS,
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
- 修改当前打开文件：优先 \`write_current_file\`
- 改其他文件或新建：只用 \`write_file\`（不要先 write_current_file 再新建）
- 新建文件请 \`write_file\`；不要对「当前打开的别的文件」误用 write_current_file
- 先看目录：\`list_files\`；读全文：\`read_file\`
- 写入必须是**完整文件内容**；成功写入后简短确认即可，不要再整篇重复贴出。
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

  const maxRounds = 8
  for (let round = 0; round < maxRounds; round++) {
    if (options.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }
    options.onStatus?.(`思考中… (${round + 1}/${maxRounds})`)

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
        const result = executeAgentTool(options.host, call)
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
