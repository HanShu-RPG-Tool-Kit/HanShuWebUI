/**
 * 归档段库：保存时产出的不可变对话副本。
 *
 * 能做的三件事：
 * - **打开**：只读查看归档时的对话（含思考折叠）；
 * - **继承对话**：以该归档为起点新建一个活跃段，接着聊；
 * - **删除**：连同直接/间接继承它的段一起删（由运行时级联，UI 只负责确认）。
 *
 * 组件不碰 localStorage / IndexedDB，列表、只读内容与占用都由面板通过 props 传入。
 */

import { useState } from 'react'
import type { AgentViewItem, SnapshotInfo } from '../contracts'
import {
  deriveMessageRows,
  formatBytes,
  formatDateTime,
  storageUsageHint,
  storageUsageLevel,
  storageUsagePercent,
  type StorageLevel,
} from './derive'
import { MessageList } from './MessageList'

export type PersistState = 'idle' | 'pending' | 'granted' | 'denied'

export type OpenedArchive = {
  id: string
  title: string
  items: AgentViewItem[]
}

type Props = {
  snapshots: SnapshotInfo[]
  loading: boolean
  error?: string
  /** 本工程归档段库占用（字节）；null = 还没拿到 */
  usageBytes: number | null
  persistState: PersistState
  /** 正在只读查看的归档段 */
  opened: OpenedArchive | null
  openedLoading: boolean
  /** 正在继承/删除的归档 id（按钮转圈用） */
  busyId: string | null
  onRefresh: () => void
  onPersist: () => void
  onClose: () => void
  onOpen: (snapshotId: string) => void
  onCloseOpened: () => void
  onFork: (snapshotId: string) => void
  onDelete: (snapshotId: string) => void
}

const LEVEL_TEXT: Record<StorageLevel, string> = {
  ok: '正常',
  warn: '偏多',
  danger: '过多',
}

export function SnapshotList({
  snapshots,
  loading,
  error,
  usageBytes,
  persistState,
  opened,
  openedLoading,
  busyId,
  onRefresh,
  onPersist,
  onClose,
  onOpen,
  onCloseOpened,
  onFork,
  onDelete,
}: Props) {
  if (opened) {
    return (
      <div className="agent-snapshots" aria-label="归档段（只读）">
        <div className="agent-snapshots-header">
          <div className="agent-snapshots-title">
            归档段
            <span className="agent-phase2">只读</span>
          </div>
          <div className="agent-snapshots-actions">
            <button type="button" onClick={() => onFork(opened.id)} disabled={busyId === opened.id}>
              {busyId === opened.id ? '继承中…' : '继承对话'}
            </button>
            <button type="button" onClick={onCloseOpened}>
              返回列表
            </button>
          </div>
        </div>
        <div className="agent-snapshot-view-title">{opened.title}</div>
        {openedLoading ? (
          <div className="agent-empty">
            <div className="agent-empty-title">读取中…</div>
          </div>
        ) : (
          <MessageList
            rows={deriveMessageRows(opened.items)}
            status=""
            resetKey={opened.id}
            empty={
              <div className="agent-empty">
                <div className="agent-empty-title">这段没有对话内容</div>
              </div>
            }
          />
        )}
      </div>
    )
  }

  return (
    <div className="agent-snapshots" aria-label="归档段库">
      <div className="agent-snapshots-header">
        <div className="agent-snapshots-title">归档段库</div>
        <div className="agent-snapshots-actions">
          <button type="button" onClick={onRefresh} disabled={loading} title="刷新">
            {loading ? '刷新中…' : '刷新'}
          </button>
          <button type="button" onClick={onClose} title="返回对话">
            返回对话
          </button>
        </div>
      </div>

      {usageBytes !== null && <UsageBar usageBytes={usageBytes} />}

      <div className="agent-snapshots-note">
        保存工程时自动归档。可以打开查看、继承出新对话，或删除。
      </div>

      {error && <div className="agent-banner error">{error}</div>}

      {snapshots.length === 0 ? (
        <div className="agent-empty">
          <div className="agent-empty-title">{loading ? '读取中…' : '还没有归档段'}</div>
          <p>保存工程后才会产生归档段。</p>
        </div>
      ) : (
        snapshots.map((snapshot) => (
          <SnapshotRow
            key={snapshot.id}
            snapshot={snapshot}
            busy={busyId === snapshot.id}
            onOpen={onOpen}
            onFork={onFork}
            onDelete={onDelete}
          />
        ))
      )}

      <div className="agent-persist">
        <button
          type="button"
          onClick={onPersist}
          disabled={persistState === 'pending' || persistState === 'granted'}
          title="向浏览器申请持久化存储，降低空间紧张时被清理的概率"
        >
          {persistState === 'pending'
            ? '申请中…'
            : persistState === 'granted'
              ? '已申请'
              : persistState === 'denied'
                ? '未获批准，可重试'
                : '申请持久化存储'}
        </button>
        <span className="agent-persist-hint">
          {persistState === 'granted' ? '浏览器已同意，清理风险降低。' : '数据只在本机。'}
        </span>
      </div>
    </div>
  )
}

function SnapshotRow({
  snapshot,
  busy,
  onOpen,
  onFork,
  onDelete,
}: {
  snapshot: SnapshotInfo
  busy: boolean
  onOpen: (snapshotId: string) => void
  onFork: (snapshotId: string) => void
  onDelete: (snapshotId: string) => void
}) {
  const [confirm, setConfirm] = useState(false)
  return (
    <div className="agent-snapshot">
      <div className="agent-snapshot-title">{snapshot.title || '未命名归档段'}</div>
      <div className="agent-snapshot-meta">
        <span>{formatDateTime(snapshot.createdAt)}</span>
        <span>{snapshot.entryCount} 条对话</span>
      </div>
      <div className="agent-snapshot-actions">
        <button type="button" onClick={() => onOpen(snapshot.id)} disabled={busy}>
          打开
        </button>
        <button type="button" onClick={() => onFork(snapshot.id)} disabled={busy}>
          {busy ? '处理中…' : '继承对话'}
        </button>
        {confirm ? (
          <>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => {
                setConfirm(false)
                onDelete(snapshot.id)
              }}
              title="会连同继承自它的对话一起删除"
            >
              确认删除
            </button>
            <button type="button" onClick={() => setConfirm(false)}>
              取消
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setConfirm(true)} disabled={busy}>
            删除
          </button>
        )}
      </div>
    </div>
  )
}

function UsageBar({ usageBytes }: { usageBytes: number }) {
  const level = storageUsageLevel(usageBytes)
  return (
    <div className={`agent-usage ${level}`}>
      <div className="agent-usage-line">
        <span>归档段库占用：{formatBytes(usageBytes)}</span>
        <span className={`agent-usage-level ${level}`}>{LEVEL_TEXT[level]}</span>
      </div>
      <div className="agent-usage-bar">
        <div
          className={`agent-usage-fill ${level}`}
          style={{ width: `${storageUsagePercent(usageBytes)}%` }}
        />
      </div>
      <div className="agent-usage-hint">{storageUsageHint(usageBytes)}</div>
    </div>
  )
}
