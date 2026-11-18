/**
 * 对话流：只渲染 `derive.ts` 派生出的行（**不持有对话状态**）。
 *
 * 增量渲染要点：
 * - `key` 用 `MessageRow.id`（来自 `AgentViewItem.id`），流式只更新最后一条 assistant 的文本；
 * - 不在渲染期重组数据、不按内容做 key；
 * - 滚动只在“本来就贴着底部”时跟随，用户往上翻历史时不会被拽下来。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { AgentMarkdown } from '../AgentMarkdown'
import {
  clipText,
  formatRunDuration,
  formatTokenCount,
  prettyToolText,
  type MessageRow,
  type ToolRow,
} from './derive'

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
  /** 用户消息左侧的回滚入口：只把 runKey 交给面板，选择与执行都在面板 */
  onRollbackRun?: (runKey: string) => void
  /** Run 统计行左侧的分支入口：undefined = 从当前会话末尾分支 */
  onForkRun?: (beforeEntryId?: string) => void
}

/**
 * 把连续的「已回滚 Run」行包进同一段容器，画一条左侧红线。
 * 不改变行顺序与 id；分组 key 取首行 id，视图增量更新时仍能复用节点。
 */
type RowGroup =
  | { kind: 'rolled'; rows: MessageRow[] }
  | { kind: 'single'; row: MessageRow }

function groupRolledRunRows(rows: MessageRow[]): RowGroup[] {
  const groups: RowGroup[] = []
  for (const row of rows) {
    if (row.rolledBackRun === true && row.kind !== 'rollback') {
      const last = groups[groups.length - 1]
      if (last?.kind === 'rolled') last.rows.push(row)
      else groups.push({ kind: 'rolled', rows: [row] })
    } else {
      groups.push({ kind: 'single', row })
    }
  }
  return groups
}

export function MessageList({
  rows,
  status,
  resetKey,
  empty,
  onRollbackRun,
  onForkRun,
}: Props) {
  const listRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)
  const groups = useMemo(() => groupRolledRunRows(rows), [rows])

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
      {groups.map((group) =>
        group.kind === 'rolled' ? (
          <div
            className="agent-run-rolled"
            key={`rolled:${group.rows[0]?.id ?? ''}`}
            aria-label="已回滚的对话轮次"
          >
            <div className="agent-run-rolled-label">已回滚</div>
            {group.rows.map((row) => (
              <MessageRowView
                key={row.id}
                row={row}
                onRollbackRun={onRollbackRun}
                onForkRun={onForkRun}
              />
            ))}          </div>
        ) : (
          <MessageRowView
            key={group.row.id}
            row={group.row}
            onRollbackRun={onRollbackRun}
            onForkRun={onForkRun}
          />
        ),
      )}
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

/**
 * 思考块：默认收起，只给想查看推理过程的用户一个入口。
 *
 * 按钮本身无边框；图标三态由 CSS 切换：
 * - 收起且未悬停：科学图标
 * - 收起且悬停：右向三角
 * - 展开：下向三角
 */
function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="agent-thinking">
      <button
        type="button"
        className="agent-thinking-toggle"
        aria-expanded={open}
        title={open ? '收起思考' : '展开思考'}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="agent-thinking-icon" aria-hidden="true">
          <svg
            className="agent-thinking-science"
            viewBox="0 0 16 16"
            width="12"
            height="12"
            focusable="false"
          >
            <circle cx="8" cy="8" r="1.45" fill="currentColor" />
            <ellipse
              cx="8"
              cy="8"
              rx="6.3"
              ry="2.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.1"
              transform="rotate(45 8 8)"
            />
            <ellipse
              cx="8"
              cy="8"
              rx="6.3"
              ry="2.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.1"
              transform="rotate(-45 8 8)"
            />
          </svg>
          <span className="agent-thinking-caret right">▸</span>
          <span className="agent-thinking-caret down">▾</span>
        </span>
        思考
      </button>
      {open ? <div className="agent-thinking-body">{text}</div> : null}
    </div>
  )
}

type RollbackInfo = NonNullable<MessageRow['rollback']>
const ROLLBACK_OUTCOME_LABEL: Record<
  RollbackInfo['outcomes'][number]['action'],
  string
> = {
  restored: '已恢复',
  deleted: '已删除',
  skipped: '已跳过',
  finished: '已处理',
  conflict: '冲突',
}

/**
 * 回滚通知：交互与思考块相同（默认收起、无边框按钮）。
 * 展开后列出生效的轮次（用户消息摘要 + 涉及文件）与逐文件恢复/跳过结果。
 */
function RollbackNoticeBlock({ rollback }: { rollback: RollbackInfo }) {
  const [open, setOpen] = useState(false)
  const roundCount = rollback.runs.length
  return (
    <div className="agent-msg rollback">
      <div className="agent-rollback-entry">
        <button
          type="button"
          className="agent-rollback-notice-toggle"
          aria-expanded={open}
          title={open ? '收起回滚详情' : '展开回滚详情'}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="agent-rollback-notice-caret" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <span>已回滚 {roundCount} 轮改动</span>
          {rollback.forced ? (
            <span className="agent-rollback-notice-tag forced">强制</span>
          ) : null}
          {rollback.auto ? (
            <span className="agent-rollback-notice-tag auto">自动</span>
          ) : null}
        </button>
        {open ? <RollbackNoticeDetails rollback={rollback} /> : null}
      </div>
    </div>
  )
}

/** 回滚详情单独导出，便于 SSR 测试直接断言轮次/文件/恢复结果（不依赖点击展开）。 */
export function RollbackNoticeDetails({
  rollback,
}: {
  rollback: NonNullable<MessageRow['rollback']>
}) {
  const roundCount = rollback.runs.length
  return (
    <div className="agent-rollback-notice-body">
      <div className="agent-rollback-notice-section">
        <div className="agent-rollback-notice-heading">回滚轮次</div>
        {roundCount === 0 ? (
          <div className="agent-rollback-notice-empty">没有轮次记录</div>
        ) : (
          <ul className="agent-rollback-notice-runs">
            {rollback.runs.map((run, index) => {
              const firstLine = run.userText?.trim().split(/\r?\n/)[0] ?? ''
              const summary = firstLine.length > 64 ? `${firstLine.slice(0, 64)}…` : firstLine
              return (
                <li key={`${run.userIndex}:${index}`}>
                  <div className="agent-rollback-notice-run">
                    <span className="agent-rollback-notice-run-index">
                      第 {run.userIndex + 1} 轮
                    </span>
                    {summary ? (
                      <span className="agent-rollback-notice-run-text" title={run.userText}>
                        {summary}
                      </span>
                    ) : null}
                  </div>
                  {run.files.length > 0 ? (
                    <ul className="agent-rollback-notice-files">
                      {run.files.map((file) => (
                        <li key={file}>{file}</li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </div>
      <div className="agent-rollback-notice-section">
        <div className="agent-rollback-notice-heading">恢复与跳过</div>
        {rollback.outcomes.length === 0 ? (
          <div className="agent-rollback-notice-empty">没有文件结果记录</div>
        ) : (
          <ul className="agent-rollback-notice-outcomes">
            {rollback.outcomes.map((outcome, index) => (
              <li key={`${outcome.path}:${index}`}>
                <span className={`agent-rollback-notice-outcome ${outcome.action}`}>
                  {ROLLBACK_OUTCOME_LABEL[outcome.action]}
                </span>
                <code>{outcome.path}</code>
                {outcome.reason ? (
                  <span className="agent-rollback-notice-reason">（{outcome.reason}）</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/** 回滚入口：16px 图标，紧凑无边框；已回滚显示禁用对勾。 */
function RollbackIcon({ rolledBack }: { rolledBack: boolean }) {
  return rolledBack ? (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="m3.2 8.4 3.1 3.1 6.5-6.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M5.6 3.4 2.7 6.3l2.9 2.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M2.9 6.3h6.5a3.2 3.2 0 0 1 0 6.4H6.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** 分支入口：16px 图标，表示复制到这一轮为止、从之后分出一条新会话。 */
function ForkIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <circle cx="4" cy="3.1" r="1.55" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="4" cy="12.9" r="1.55" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="12" cy="5" r="1.55" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M4 4.65v6.7M12 6.55c0 2.9-2.8 3.25-6.15 3.85"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

type RunMeta = NonNullable<MessageRow['runMeta']>

/**
 * 一轮结束后的统计行：左侧是「从此轮之后分支」图标，右侧单行显示用时/轮次/token。
 * 导出便于 SSR 测试直接断言左侧按钮与回调参数（不依赖点击展开）。
 */
export function RunMetaLine({
  runMeta,
  onForkRun,
  rolledBack = false,
}: {
  runMeta: RunMeta
  onForkRun?: (beforeEntryId?: string) => void
  /** 该轮已被回滚：整轮内容已作废，禁止从这里分支（只能从末尾全局分支） */
  rolledBack?: boolean
}) {
  return (
    <div className="agent-run-meta">
      <button
        type="button"
        className="agent-run-fork"
        aria-label={rolledBack ? '该轮已回滚，不能从此轮分支' : '从此轮之后分支会话'}
        title={
          rolledBack
            ? '该轮已回滚，不能从此轮分支'
            : '从此轮之后分支会话（复制到这一轮为止）'
        }
        disabled={rolledBack}
        onClick={() => {
          // 已回滚的轮次内容已作废，只允许从对话末尾全局分支；disabled 之外再兜底一次，
          // 避免测试或合成事件绕过浏览器的 disabled 行为。
          if (!rolledBack) onForkRun?.(runMeta.forkBeforeEntryId)
        }}
      >
        <ForkIcon />
      </button>
      <span className="agent-run-meta-stats">
        {`用时 ${formatRunDuration(runMeta.durationMs)} · ${runMeta.turns} 轮 · 输入${formatTokenCount(
          runMeta.inputTokens,
        )} · 缓存${formatTokenCount(runMeta.cachedTokens)} · 输出${formatTokenCount(
          runMeta.outputTokens,
        )}`}
      </span>
    </div>
  )
}

/**
 * 用户消息：气泡靠右，回滚图标放在整行左侧（与气泡顶部对齐）。
 * 只有 `rollbackable` 的轮次可点；`rolledBack` 显示置灰对勾，避免误以为还能再回滚。
 */
export function UserLine({
  row,
  onRollbackRun,
}: {
  row: MessageRow
  onRollbackRun?: (runKey: string) => void
}) {
  const rolledBack = row.rolledBack === true
  const canRollback = row.rollbackable === true && Boolean(row.runKey) && !rolledBack
  const showRollbackIcon = canRollback || rolledBack
  return (
    <div className={`agent-msg user${rolledBack ? ' rolled-back' : ''}`}>
      {showRollbackIcon ? (
        <button
          type="button"
          className={`agent-msg-rollback${rolledBack ? ' rolled' : ''}`}
          disabled={!canRollback}
          aria-label={rolledBack ? '这一轮已回滚' : '回滚这一轮的改动'}
          title={
            rolledBack
              ? '这一轮的改动已回滚'
              : '回滚这一轮或这一轮及之后的工程草稿改动；不会删除对话消息'
          }
          onClick={() => {
            if (canRollback && row.runKey) onRollbackRun?.(row.runKey)
          }}
        >
          <RollbackIcon rolledBack={rolledBack} />
        </button>
      ) : null}
      <div className="agent-msg-user-main">
        <div className="agent-msg-role">{row.roleLabel}</div>
        <div className="agent-msg-body">{row.text ?? ''}</div>
      </div>
    </div>
  )
}

function MessageRowView({
  row,
  onRollbackRun,
  onForkRun,
}: {
  row: MessageRow
  onRollbackRun?: (runKey: string) => void
  onForkRun?: (beforeEntryId?: string) => void
}) {
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
        {row.thinking ? <ThinkingBlock text={row.thinking} /> : null}
        {text ? <AgentMarkdown source={text} /> : null}
        {row.streaming && text.length > 0 && (
          <span className="agent-cursor" aria-hidden="true">
            …
          </span>
        )}
      </div>
    )
  }

  if (row.kind === 'user') {
    return <UserLine row={row} onRollbackRun={onRollbackRun} />
  }

  if (row.kind === 'run-meta') {
    if (!row.runMeta) return null
    return (
      <RunMetaLine
        runMeta={row.runMeta}
        onForkRun={onForkRun}
        rolledBack={row.rolledBackRun === true}
      />
    )
  }

  if (row.kind === 'rollback') {
    if (!row.rollback) return null
    return <RollbackNoticeBlock rollback={row.rollback} />
  }

  return (
    <div className={`agent-msg ${row.kind}`}>
      <div className="agent-msg-role">{row.roleLabel}</div>
      <div className="agent-msg-body">{row.text ?? ''}</div>
    </div>
  )
}
