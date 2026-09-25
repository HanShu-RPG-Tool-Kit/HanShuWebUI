import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { getAgentConfig, hasAgentApiKey, setUsePro } from './agent/config'
import {
  runAgentTurn,
  type AgentContext,
  type ChatMessage,
} from './agent/client'
import { AgentMarkdown } from './agent/AgentMarkdown'
import type { AgentHost } from './agent/tools'

type AgentPanelProps = {
  open: boolean
  getContext: () => AgentContext
  host: AgentHost
  onClose: () => void
  onBeforeTurn?: () => void
  style?: CSSProperties
}

type UiMessage = {
  id: string
  role: 'user' | 'assistant' | 'error' | 'status'
  content: string
}

export function AgentPanel({
  open,
  getContext,
  host,
  onClose,
  onBeforeTurn,
  style,
}: AgentPanelProps) {
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [usePro, setUseProState] = useState(() => getAgentConfig().usePro)
  const listRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const config = getAgentConfig()
  const model = usePro ? 'deepseek-v4-pro' : 'deepseek-flash'
  const temperature = config.temperature

  const togglePro = () => {
    const next = !usePro
    setUsePro(next)
    setUseProState(next)
  }

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, open, status])

  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  if (!open) return null

  const contextLabel = getContext().fileName

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    if (!hasAgentApiKey()) {
      setMessages((prev) => [
        ...prev,
        {
          id: `err_${Date.now()}`,
          role: 'error',
          content:
            '未配置 API。请复制 `.env.example` 为 `.env`，填写 VITE_DEEPSEEK_API_KEY 后重启 dev。',
        },
      ])
      return
    }

    const userMsg: UiMessage = {
      id: `u_${Date.now()}`,
      role: 'user',
      content: text,
    }
    const assistantId = `a_${Date.now()}`
    setMessages((prev) => [
      ...prev,
      userMsg,
      { id: assistantId, role: 'assistant', content: '' },
    ])
    setInput('')
    setBusy(true)
    setStatus('')
    onBeforeTurn?.()

    const history: ChatMessage[] = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }))

    const controller = new AbortController()
    abortRef.current = controller

    try {
      await runAgentTurn({
        history,
        userText: text,
        context: getContext(),
        host,
        signal: controller.signal,
        onStatus: setStatus,
        onDelta: (chunk) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, content: m.content + chunk } : m,
            ),
          )
        },
      })
    } catch (error) {
      if ((error as Error).name === 'AbortError') return
      const message = error instanceof Error ? error.message : String(error)
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, role: 'error', content: message }
            : m,
        ),
      )
    } finally {
      setBusy(false)
      setStatus('')
      abortRef.current = null
    }
  }

  return (
    <section className="agent-panel" style={style} aria-label="Agent">
      <header className="agent-header">
        <div className="agent-title">
          <span>Agent</span>
          <span className="agent-sub">
            {model} · t={temperature} · {contextLabel}
          </span>
        </div>
        <div className="agent-header-actions">
          <button
            type="button"
            className={`agent-pro-toggle${usePro ? ' on' : ''}`}
            title={
              usePro
                ? '当前 Pro（deepseek-v4-pro），点击切换到 Flash'
                : '当前 Flash（deepseek-flash），点击切换到 Pro'
            }
            onClick={togglePro}
            disabled={busy}
          >
            Pro
          </button>
          <button
            type="button"
            title="清空对话"
            onClick={() => {
              abortRef.current?.abort()
              setMessages([])
              setBusy(false)
              setStatus('')
            }}
          >
            清空
          </button>
          <button type="button" title="关闭" onClick={onClose}>
            ×
          </button>
        </div>
      </header>

      <div className="agent-messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="agent-hint">
            已启用写入工具（无需 git）。顶栏 Pro 可切换模型。语法文档：
            <code>docs/hanshu-syntax.md</code>
          </div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className={`agent-msg ${msg.role}`}>
            <div className="agent-msg-role">
              {msg.role === 'user'
                ? '你'
                : msg.role === 'error'
                  ? '错误'
                  : 'Agent'}
            </div>
            {msg.role === 'assistant' ? (
              <AgentMarkdown source={msg.content || (busy ? '…' : '')} />
            ) : (
              <div className="agent-msg-body">
                {msg.content || (busy ? '…' : '')}
              </div>
            )}
          </div>
        ))}
        {status && <div className="agent-status">{status}</div>}
      </div>

      <form
        className="agent-input-row"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <textarea
          className="agent-input"
          rows={3}
          value={input}
          placeholder="问 Agent…（可要求直接写入文件）"
          disabled={busy}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
        />
        <div className="agent-input-actions">
          {busy ? (
            <button type="button" onClick={() => abortRef.current?.abort()}>
              停止
            </button>
          ) : (
            <button type="submit" disabled={!input.trim()}>
              发送
            </button>
          )}
        </div>
      </form>
    </section>
  )
}
