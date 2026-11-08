/**
 * Agent 面板的**纯视图派生**。
 *
 * 这里是「对话视图 → 可渲染行」与各种格式化（用量阈值 / Key 掩码 / 时间 / 失败行）的唯一实现，
 * 全部无副作用：不碰 DOM、不碰 localStorage、不 import React，也不会碰 `AgentRuntime` 之外的东西。
 * 这样 `scripts/verify-agent-panel.ts` 可以直接跑断言。
 *
 * 设计约束（文档 §10 / §15）：
 * - 对话状态归运行时，这里只做**派生**，不复制 Run/段状态；
 * - 失败 Run 落成对话里的一条记录（不回滚对话条目），所以失败行也走同一套行模型；
 * - 归档段载入 / 导出是二期，只读列表里必须能明说，不做假按钮。
 */

import type {
  AgentRunResult,
  AgentRunState,
  AgentViewItem,
  SegmentInfo,
  SegmentState,
  UndoOutcome,
} from '../contracts'

/* ───────────────────────── 归档段库占用（文档 §9） ───────────────────────── */

/** 50 MB 黄条提示 */
export const STORAGE_WARN_BYTES = 50 * 1024 * 1024
/** 100 MB 红条提示 */
export const STORAGE_DANGER_BYTES = 100 * 1024 * 1024

export type StorageLevel = 'ok' | 'warn' | 'danger'

/** 占用分级：阈值本身算“到线”（50MB 起黄、100MB 起红） */
export function storageUsageLevel(bytes: number): StorageLevel {
  if (!Number.isFinite(bytes) || bytes < STORAGE_WARN_BYTES) return 'ok'
  if (bytes >= STORAGE_DANGER_BYTES) return 'danger'
  return 'warn'
}

/** 进度条百分比（以 100MB 为满格，夹在 0–100） */
export function storageUsagePercent(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0
  return Math.min(100, Math.round((bytes / STORAGE_DANGER_BYTES) * 100))
}

/** 占用说明：只说「要不要管」和「能做什么」 */
export function storageUsageHint(bytes: number): string {
  const level = storageUsageLevel(bytes)
  if (level === 'danger') {
    return '已超过 100 MB，建议清理浏览器数据或换台机器（导出功能为二期）。'
  }
  if (level === 'warn') {
    return '已超过 50 MB，暂时不用处理。'
  }
  return '正常。'
}

/** 字节 → 人类可读（1024 进制，整数单位去掉 .0） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const text = unit === 0 ? String(Math.round(value)) : value >= 100 ? value.toFixed(0) : value.toFixed(1)
  return `${text.replace(/\.0$/, '')} ${units[unit]}`
}

/* ───────────────────────── Key 掩码（文档 §2 / §10） ───────────────────────── */

/** 只显示 `sk-…后四位`；**任何情况下都不返回完整 Key** */
export function maskApiKey(key: string): string {
  const trimmed = key.trim()
  if (!trimmed) return '未配置'
  const prefix = trimmed.startsWith('sk-') ? 'sk-' : ''
  // 太短就完全遮住，避免“掩码”反而暴露大半
  if (trimmed.length <= 8) return `${prefix}…`
  return `${prefix}…${trimmed.slice(-4)}`
}

/* ───────────────────────── 时间 / 文案 ───────────────────────── */

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 本地时间 `HH:mm`；非法值显示 `--:--` */
export function formatClock(ts: number): string {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return '--:--'
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 本地时间 `YYYY-MM-DD HH:mm`；非法值显示 `--` */
export function formatDateTime(ts: number): string {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return '--'
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${formatClock(ts)}`
}

export function segmentStateLabel(state: SegmentState): string {
  if (state === 'active') return '活跃'
  if (state === 'dormant') return '休眠'
  return '已封存'
}

export function runStateLabel(state: AgentRunState): string {
  if (state === 'running') return '运行中'
  if (state === 'failed') return '失败'
  if (state === 'aborted') return '已中止'
  return '空闲'
}

/** 段下拉里的一行文案（标题 + 轮数 + 封存标记，便于区分同名段） */
export function segmentOptionLabel(segment: SegmentInfo): string {
  const title = segment.title.trim() || '未命名段'
  const rounds = segment.runCount > 0 ? ` · ${segment.runCount} 轮` : ''
  const sealed = segment.state === 'sealed' ? '（已封存）' : ''
  return `${title}${rounds}${sealed}`
}

/** 工具输出可能很大，对话流里只放头尾，避免整段 JSON 撑爆滚动区 */
export function clipText(text: string, max = 1200): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max)}\n…（输出已截断，共 ${trimmed.length} 字符）`
}

/** 「引用当前文件」快捷输入追加的上下文；没有当前文件时返回空串 */
export function contextReference(label?: string): string {
  const trimmed = label?.trim()
  return trimmed ? `（当前文件：${trimmed}）` : ''
}

/** 任意异常 → 可执行的中文提示（不要只丢 `[object Object]`） */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string' && error.trim()) return error.trim()
  return String(error)
}

/* ───────────────────────── 对话行 ───────────────────────── */

export type ToolRow = {
  name: string
  status: 'running' | 'done' | 'error'
  output?: string
}

/**
 * 一条可渲染的对话行。`id` 直接来自 `AgentViewItem.id`——
 * 订阅到新视图时 React 按 id 复用节点，流式更新只改 assist 文本，不整棵重挂。
 */
export type MessageRow = {
  id: string
  kind: AgentViewItem['kind']
  roleLabel: string
  text?: string
  streaming?: boolean
  /** 模型思考内容：默认折叠展示 */
  thinking?: string
  tool?: ToolRow
}

export function deriveMessageRows(items: AgentViewItem[]): MessageRow[] {
  return items.map((item): MessageRow => {
    if (item.kind === 'tool') {
      return {
        id: item.id,
        kind: 'tool',
        roleLabel: '工具',
        tool: { name: item.name, status: item.status, output: item.output },
      }
    }
    if (item.kind === 'assistant') {
      return {
        id: item.id,
        kind: 'assistant',
        roleLabel: 'Agent',
        text: item.text,
        streaming: item.streaming === true,
        thinking: item.thinking,
      }
    }
    if (item.kind === 'notice') {
      return { id: item.id, kind: 'notice', roleLabel: '提示', text: item.text }
    }
    return {
      id: item.id,
      kind: item.kind,
      roleLabel: item.kind === 'user' ? '你' : '错误',
      text: item.text,
    }
  })
}

/* ───────────────────────── Run 失败记录（文档 §7） ───────────────────────── */

/**
 * 撤销日志摘要。**只描述结论，不重试、不隐藏被跳过的文件**：
 * 被后续改动覆盖的文件不会自动回退，必须让用户知道要手动合并。
 */
export function summarizeUndo(undo: UndoOutcome[] | undefined, rolledBack?: boolean): string {
  if (rolledBack === false) {
    return '改动已保留为草稿，请检查后再保存。'
  }
  if (!undo || undo.length === 0) return ''
  let restored = 0
  let deleted = 0
  let skipped = 0
  const skippedPaths: string[] = []
  for (const outcome of undo) {
    if (outcome.action === 'restored') restored += 1
    else if (outcome.action === 'deleted') deleted += 1
    else if (outcome.action === 'skipped') {
      skipped += 1
      if (skippedPaths.length < 3) skippedPaths.push(outcome.path)
    }
  }
  const parts: string[] = []
  if (restored > 0) parts.push(`已自动撤销 ${restored} 个文件`)
  if (deleted > 0) parts.push(`已删掉新建的 ${deleted} 个文件`)
  if (skipped > 0) {
    const shown = skippedPaths.join('、')
    const more = skipped > skippedPaths.length ? ' 等' : ''
    parts.push(`${skipped} 个文件之后又被改过，没有自动撤销（${shown}${more}），请手动检查`)
  }
  if (parts.length === 0) return ''
  return `${parts.join('；')}。`
}

/**
 * 把 `run()` 的失败结果补进对话流（文档 §7：失败 Run 留一条记录是有价值的）。
 * 运行时自己已经写了 error 条目时不重复；只补它没说的回滚结论。
 */
export function appendRunFailure(
  rows: MessageRow[],
  failure: AgentRunResult | null,
  runId: string | null,
): MessageRow[] {
  if (!failure || failure.ok) return rows
  const errorText = failure.error?.trim() || '运行失败，可重试；若反复失败，检查 API 设置与网络。'
  const undoText = summarizeUndo(failure.undo, failure.rolledBack)
  const detail = undoText ? `${errorText}\n\n${undoText}` : errorText
  const errorCovered = rows.some(
    (row) => row.kind === 'error' && (row.text ?? '').includes(errorText),
  )
  if (!errorCovered) {
    return [
      ...rows,
      {
        id: `run-failure:${runId ?? 'current'}`,
        kind: 'error',
        roleLabel: '错误',
        text: detail,
      },
    ]
  }
  // 运行时自己也写过回滚结论（措辞可能不同）：只要已经说了“撤销/回退/人工合并”，就不再补
  const undoCovered = rows.some((row) => {
    const text = row.text ?? ''
    if (!undoText) return true
    return (
      text.includes(undoText) ||
      (row.kind === 'error' && /自动撤销|没有自动撤销|手动检查|已回滚/.test(text))
    )
  })
  if (!undoText || undoCovered) return rows
  return [
    ...rows,
    {
      id: `run-undo:${runId ?? 'current'}`,
      kind: 'notice',
      roleLabel: '回滚',
      text: undoText,
    },
  ]
}
