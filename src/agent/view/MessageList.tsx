/**
 * 对话流：只渲染 `derive.ts` 派生出的行（**不持有对话状态**）。
 *
 * 增量渲染要点：
 * - `key` 用 `MessageRow.id`（来自 `AgentViewItem.id`），流式只更新最后一条 assistant 的文本；
 * - 不在渲染期重组数据、不按内容做 key；
 * - 滚动只在“本来就贴着底部”时跟随，用户往上翻历史时不会被拽下来。
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { AgentMarkdown } from '../AgentMarkdown'
import { clipText, prettyToolText, type MessageRow, type ToolRow } from './derive'

const TOOL_STATUS_LABEL = {
  running: '运行中',
  done: '成功',
  error: '失败',
} as const

type Props = {
  rows: MessageRow[]
  /** 人类可读状态行（思考中 / 工具名），来自 `view.status` */
  status: string
  /** 段切换时重置滚动位置（用 view.segmentId） */
  resetKey: string | null
  /** 空状态；由面板决定文案，组件只负责摆位置 */
  empty?: ReactNode
}

export function MessageList({ rows, status, resetKey, empty }: Props) {
  const listRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)

  useEffect(() => {
    stickToBottomRef.current = true
    const element = listRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [resetKey])

  useEffect(() => {
    const element = listRef.current
    if (element && stickToBottomRef.current) element.scrollTop = element.scrollHeight
  }, [rows, status])

  return (
    <div
      className="agent-messages"
      ref={listRef}
      onScroll={() => {
        const element = listRef.current
        if (!element) return
        stickToBottomRef.current =
          element.scrollHeight - element.scrollTop - element.clientHeight < 48
      }}
    >
      {rows.length === 0 && empty}
      {rows.map((row) => (
        <MessageRowView key={row.id} row={row} />
      ))}
      {status && <div className="agent-status">{status}</div>}
    </div>
  )
}

/**
 * 工具调用压成一行：`工具 | 名称 … 输入 输出  状态`。
 * 输入/输出按钮固定在右侧、状态左边，带三角符号表示展开状态；
 * 展开内容限制高度并单独滚动，JSON 按两空格缩进，避免撑爆对话流。
 */
function ToolLine({ tool }: { tool: ToolRow }) {
  const [inputOpen, setInputOpen] = useState(false)
  const [outputOpen, setOutputOpen] = useState(false)
  const inputText = prettyToolText(tool.input)
  const outputText = prettyToolText(tool.output)
  return (
    <div className="agent-msg tool">
      <div className="agent-tool">
        <div className="agent-tool-row">
          <span className="agent-tool-tag">工具</span>
          <span className="agent-tool-name" title={tool.name}>
            {tool.name}
          </span>
          {inputText || outputText ? (
            <span className="agent-tool-actions">
              {inputText ? (
                <button
                  type="button"
                  className={`agent-tool-toggle${inputOpen ? ' on' : ''}`}
                  aria-expanded={inputOpen}
                  title={inputOpen ? '收起调用参数' : '查看调用参数'}
                  onClick={() => setInputOpen((open) => !open)}
                >
                  <span className="agent-tool-caret" aria-hidden="true">
                    {inputOpen ? '▾' : '▸'}
                  </span>
                  输入
                </button>
              ) : null}
              {outputText ? (
                <button
                  type="button"
                  className={`agent-tool-toggle${outputOpen ? ' on' : ''}`}
                  aria-expanded={outputOpen}
                  title={outputOpen ? '收起输出' : '查看输出'}
                  onClick={() => setOutputOpen((open) => !open)}
                >
                  <span className="agent-tool-caret" aria-hidden="true">
                    {outputOpen ? '▾' : '▸'}
                  </span>
                  输出
                </button>
              ) : null}
            </span>
          ) : null}
          <span className={`agent-tool-status ${tool.status}`}>
            {TOOL_STATUS_LABEL[tool.status]}
          </span>
        </div>
        {inputOpen && inputText ? (
          <pre className="agent-tool-pane">{clipText(inputText)}</pre>
        ) : null}
        {outputOpen && outputText ? (
          <pre className="agent-tool-pane">{clipText(outputText)}</pre>
        ) : null}
      </div>
    </div>
  )
}

function MessageRowView({ row }: { row: MessageRow }) {
  if (row.kind === 'tool') {
    const tool = row.tool
    if (!tool) return null
    return <ToolLine tool={tool} />
  }

  if (row.kind === 'assistant') {
    const text = row.text ?? ''
    return (
      <div className="agent-msg assistant">
        <div className="agent-msg-role">{row.roleLabel}</div>
        {row.thinking ? (
          // 思考默认不展开：只给想看过程的用户一个入口
          <details className="agent-thinking">
            <summary>思考</summary>
            <div className="agent-thinking-body">{row.thinking}</div>
          </details>
        ) : null}
        {text ? <AgentMarkdown source={text} /> : null}
        {row.streaming && text.length > 0 && (
          <span className="agent-cursor" aria-hidden="true">
            …
          </span>
        )}
      </div>
    )
  }

  return (
    <div className={`agent-msg ${row.kind}`}>
      <div className="agent-msg-role">{row.roleLabel}</div>
      <div className="agent-msg-body">{row.text ?? ''}</div>
    </div>
  )
}
