/**
 * 对话流：只渲染 `derive.ts` 派生出的行（**不持有对话状态**）。
 *
 * 增量渲染要点：
 * - `key` 用 `MessageRow.id`（来自 `AgentViewItem.id`），流式只更新最后一条 assistant 的文本；
 * - 不在渲染期重组数据、不按内容做 key；
 * - 滚动只在“本来就贴着底部”时跟随，用户往上翻历史时不会被拽下来。
 */

import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { AgentMarkdown } from '../AgentMarkdown'
import { clipText, type MessageRow } from './derive'

const TOOL_STATUS_LABEL = {
  running: '运行中',
  done: '完成',
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

function MessageRowView({ row }: { row: MessageRow }) {
  if (row.kind === 'tool') {
    const tool = row.tool
    if (!tool) return null
    return (
      <div className="agent-msg tool">
        <div className="agent-msg-role">工具</div>
        <div className="agent-tool">
          <div className="agent-tool-head">
            <span className="agent-tool-name">{tool.name}</span>
            <span className={`agent-tool-status ${tool.status}`}>
              {TOOL_STATUS_LABEL[tool.status]}
            </span>
          </div>
          {tool.output ? (
            <details className="agent-tool-output">
              <summary>输出</summary>
              <pre>{clipText(tool.output)}</pre>
            </details>
          ) : null}
        </div>
      </div>
    )
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
