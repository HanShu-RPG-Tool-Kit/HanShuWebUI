/**
 * 活跃段切换条：当前段标题 / 轮数 / 状态 + 下拉 + 新建 + 删除。
 *
 * 用原生 `<select>`：段可能很多，暗色主题下自绘下拉要处理点击外部、键盘与滚动定位；
 * 这里元素少、语义清楚，原生控件够用，也方便键盘操作。
 *
 * 删除是两步确认（不弹系统 confirm）：删除会连同该段的对话一起消失，且不可恢复。
 */

import { useState } from 'react'
import type { SegmentInfo } from '../contracts'
import { segmentOptionLabel, segmentStateLabel } from './derive'

type Props = {
  segments: SegmentInfo[]
  currentId: string | null
  loading: boolean
  creating: boolean
  deleting: boolean
  /** 运行中不可删（会连带中止对话） */
  canDelete: boolean
  onSelect: (segmentId: string) => void
  onCreate: () => void
  onDelete: (segmentId: string) => void
}

export function SegmentBar({
  segments,
  currentId,
  loading,
  creating,
  deleting,
  canDelete,
  onSelect,
  onCreate,
  onDelete,
}: Props) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const current = segments.find((segment) => segment.id === currentId) ?? null

  return (
    <div className="agent-segbar">
      <span className="agent-seg-label" title="活跃段：本窗口的对话，可继续聊；保存会产出一条归档段">
        活跃段
      </span>
      {segments.length > 0 ? (
        <select
          className="agent-seg-select"
          value={currentId ?? ''}
          aria-label="切换活跃段"
          disabled={loading || deleting}
          onChange={(event) => {
            setConfirmDelete(false)
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
      <button
        type="button"
        className="agent-seg-new"
        onClick={() => {
          setConfirmDelete(false)
          onCreate()
        }}
        disabled={creating || deleting}
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
              disabled={deleting}
              onClick={() => {
                onDelete(currentId)
                setConfirmDelete(false)
              }}
              title="删除后不可恢复"
            >
              {deleting ? '删除中…' : '确认删除'}
            </button>
            <button type="button" onClick={() => setConfirmDelete(false)}>
              取消
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="agent-seg-del"
            onClick={() => setConfirmDelete(true)}
            disabled={!canDelete || deleting || !currentId}
            title={canDelete ? '删除当前活跃段（不可恢复）' : 'Agent 运行中，先停止再删除'}
          >
            删除
          </button>
        )
      )}
    </div>
  )
}
