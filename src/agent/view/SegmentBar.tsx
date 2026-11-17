/**
 * 活跃段切换条：当前段标题 / 轮数 / 状态 + 下拉 + 新建 + 删除。
 *
 * 用原生 `<select>`：段可能很多，暗色主题下自绘下拉要处理点击外部、键盘与滚动定位；
 * 这里元素少、语义清楚，原生控件够用，也方便键盘操作。
 *
 * 删除是两步确认（不弹系统 confirm）：删除会连同该段的对话一起消失，且不可恢复。
 */

/* 同时导出可单测的标题规范化函数（与 AgentPanel 同一处理方式）。 */
/* oxlint-disable react/only-export-components */

import { useState } from 'react'
import type { SegmentInfo } from '../contracts'
import { segmentOptionLabel, segmentStateLabel } from './derive'

type Props = {
  segments: SegmentInfo[]
  currentId: string | null
  loading: boolean
  creating: boolean
  deleting: boolean
  /** 重命名请求进行中：其它段操作按钮一律禁用 */
  renaming: boolean
  /** 运行中不可删（会连带中止对话） */
  canDelete: boolean
  onSelect: (segmentId: string) => void
  onCreate: () => void
  onDelete: (segmentId: string) => void
  onRename: (segmentId: string, title: string) => void
}

/** 重命名标题的规范化：去首尾空白并限制长度；空标题返回空串（调用方据此拒绝提交） */
export function normalizeSegmentTitle(title: string): string {
  return title.trim().slice(0, 80)
}

export function SegmentBar({
  segments,
  currentId,
  loading,
  creating,
  deleting,
  renaming,
  canDelete,
  onSelect,
  onCreate,
  onDelete,
  onRename,
}: Props) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const current = segments.find((segment) => segment.id === currentId) ?? null

  const openRename = () => {
    if (!current) return
    setConfirmDelete(false)
    setTitleDraft(current.title)
    setEditingTitle(true)
  }

  const cancelRename = () => {
    setEditingTitle(false)
    setTitleDraft('')
  }

  const submitRename = () => {
    const title = normalizeSegmentTitle(titleDraft)
    if (!currentId || !title) return
    onRename(currentId, title)
    cancelRename()
  }

  return (
    <div className="agent-segbar">
      <span
        className="agent-seg-label"
        title={
          current?.state === 'sealed'
            ? '已封存段：只读查看历史；发送消息会开始新会话'
            : '活跃段：本窗口的对话，可继续聊；保存会产出一条归档段'
        }
      >
        {current?.state === 'sealed' ? '已封存段' : '活跃段'}
      </span>
      {segments.length > 0 ? (
        <select
          className="agent-seg-select"
          value={currentId ?? ''}
          aria-label="切换活跃段"
          disabled={loading || deleting || renaming}
          onChange={(event) => {
            setConfirmDelete(false)
            cancelRename()
            onSelect(event.target.value)
          }}
          title="切换活跃段"
        >
          {!currentId && (
            <option value="" disabled>
              选择…
            </option>
          )}
          {currentId && !current && <option value={currentId}>当前段（同步中…）</option>}
          {segments.map((segment) => (
            <option key={segment.id} value={segment.id}>
              {segmentOptionLabel(segment)}
            </option>
          ))}
        </select>
      ) : (
        <span className="agent-seg-empty">{loading ? '读取中…' : '暂无对话'}</span>
      )}
      <span className="agent-seg-meta">
        {current ? `${segmentStateLabel(current.state)} · ${current.runCount} 轮` : '新建后开始对话'}
      </span>
      {current && !loading && current.state !== 'sealed' && (
        editingTitle ? (
          <span className="agent-seg-rename">
            <input
              className="agent-seg-rename-input"
              value={titleDraft}
              maxLength={80}
              aria-label="段标题"
              placeholder="输入段标题"
              autoFocus
              disabled={renaming}
              onChange={(event) => setTitleDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  submitRename()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  cancelRename()
                }
              }}
            />
            <button
              type="button"
              className="agent-seg-rename-confirm"
              onClick={submitRename}
              disabled={renaming || !normalizeSegmentTitle(titleDraft)}
              title={normalizeSegmentTitle(titleDraft) ? '保存段标题' : '段标题不能为空'}
            >
              {renaming ? '重命名中…' : '确定'}
            </button>
            <button type="button" onClick={cancelRename} disabled={renaming}>
              取消
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="agent-seg-rename-toggle"
            onClick={openRename}
            disabled={renaming}
            title="修改当前段标题（不影响对话内容）"
          >
            重命名
          </button>
        )
      )}
      <button
        type="button"
        className="agent-seg-new"
        onClick={() => {
          setConfirmDelete(false)
          onCreate()
        }}
        disabled={creating || deleting || renaming}
        title="新建一个空对话；旧对话保留"
      >
        {creating ? '新建中…' : '新建'}
      </button>
      {currentId && (
        confirmDelete ? (
          <span className="agent-seg-confirm">
            <button
              type="button"
              className="agent-seg-del danger"
              disabled={deleting || renaming}
              onClick={() => {
                onDelete(currentId)
                setConfirmDelete(false)
              }}
              title="删除后不可恢复"
            >
              {deleting ? '删除中…' : '确认删除'}
            </button>
            <button type="button" onClick={() => setConfirmDelete(false)} disabled={renaming}>
              取消
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="agent-seg-del"
            onClick={() => setConfirmDelete(true)}
            disabled={!canDelete || deleting || renaming || !currentId}
            title={canDelete ? '删除当前活跃段（不可恢复）' : 'Agent 运行中，先停止再删除'}
          >
            删除
          </button>
        )
      )}
    </div>
  )
}
