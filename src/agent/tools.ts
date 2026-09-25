/** DeepSeek / OpenAI 兼容的工具定义与本地执行 */

export type AgentToolCall = {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export type AgentHost = {
  listFiles: () => Array<{
    packageName: string
    fileName: string
    id: string
  }>
  readFile: (fileName: string) => {
    ok: boolean
    content?: string
    fileName?: string
    error?: string
  }
  /** 写入指定文件；不存在时可在当前包新建（需合法后缀） */
  writeFile: (
    fileName: string,
    content: string,
  ) => { ok: boolean; fileName?: string; created?: boolean; error?: string }
  writeCurrentFile: (content: string) => {
    ok: boolean
    fileName?: string
    error?: string
  }
  getCurrentFileName: () => string
}

export const AGENT_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'list_files',
      description: '列出资源管理器中所有包与剧本文件',
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
      name: 'read_file',
      description: '读取指定文件名的完整内容（如 序章.hs）',
      parameters: {
        type: 'object',
        properties: {
          fileName: {
            type: 'string',
            description: '文件名，含后缀 .hs / .md / .char / .lines / .lang / .voice',
          },
        },
        required: ['fileName'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_current_file',
      description:
        '用完整新内容覆盖当前打开的文件。改稿、续写后应调用此工具写入，而不是只在聊天里贴代码。',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: '要写入的完整文件正文',
          },
        },
        required: ['content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description:
        '写入指定文件名的完整内容。若文件不存在，会在当前包新建（后缀必须是 .hs/.md/.char/.lines/.lang/.voice）。',
      parameters: {
        type: 'object',
        properties: {
          fileName: {
            type: 'string',
            description: '目标文件名',
          },
          content: {
            type: 'string',
            description: '完整文件正文',
          },
        },
        required: ['fileName', 'content'],
        additionalProperties: false,
      },
    },
  },
]

export function executeAgentTool(
  host: AgentHost,
  call: AgentToolCall,
): string {
  let args: Record<string, unknown> = {}
  try {
    args = call.function.arguments
      ? (JSON.parse(call.function.arguments) as Record<string, unknown>)
      : {}
  } catch {
    return JSON.stringify({ ok: false, error: '工具参数不是合法 JSON' })
  }

  try {
    switch (call.function.name) {
      case 'list_files':
        return JSON.stringify({ ok: true, files: host.listFiles() })
      case 'read_file': {
        const fileName = String(args.fileName ?? '')
        return JSON.stringify(host.readFile(fileName))
      }
      case 'write_current_file': {
        const content = String(args.content ?? '')
        return JSON.stringify(host.writeCurrentFile(content))
      }
      case 'write_file': {
        const fileName = String(args.fileName ?? '')
        const content = String(args.content ?? '')
        return JSON.stringify(host.writeFile(fileName, content))
      }
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
