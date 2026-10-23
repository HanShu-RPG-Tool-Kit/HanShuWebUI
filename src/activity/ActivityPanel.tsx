import { useEffect, useRef, useSyncExternalStore } from 'react'
import {
  clearActivities,
  dismissActivity,
  getActivitySnapshot,
  setActivityPanelOpen,
  subscribeActivity,
  toggleActivityPanel,
  type ActivityEntry,
  type ActivityKind,
} from './activityStore'
import './ActivityPanel.css'

function kindLabel(kind: ActivityKind): string {
  switch (kind) {
    case 'success': return '成功'
    case 'warning': return '警告'
    case 'error': return '错误'
    case 'progress': return '进行中'
    default: return '提示'
  }
}

function formatTime(at: number): string {
  try {
    return new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return ''
  }
}

function progressText(entry: ActivityEntry): string | null {
  if (entry.kind !== 'progress' && !entry.progress) return null
  if (entry.progress === 'indeterminate') return entry.done ? '已完成' : '进行中…'
  if (entry.progress && typeof entry.progress === 'object') {
    return `${entry.progress.current} / ${entry.progress.total}`
  }
  if (entry.kind === 'progress') return entry.done ? '已完成' : '进行中…'
  return null
}

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const progress = progressText(entry)
  return (
    <li className={`activity-row is-${entry.kind}${entry.unread ? ' is-unread' : ''}${entry.done ? ' is-done' : ''}`}>
      <div className="activity-row-main">
        <span className="activity-row-kind">{kindLabel(entry.kind)}</span>
        <span className="activity-row-title">{entry.title}</span>
        <button
          type="button"
          className="activity-row-dismiss"
          aria-label="移除此条"
          onClick={() => dismissActivity(entry.id)}
        >
          ×
        </button>
      </div>
      {(entry.detail || progress || entry.source) && (
        <div className="activity-row-meta">
          {entry.detail && <span>{entry.detail}</span>}
          {progress && <span className="activity-row-progress">{progress}</span>}
          {entry.source && <span className="activity-row-source">{entry.source}</span>}
          <span className="activity-row-time">{formatTime(entry.at)}</span>
        </div>
      )}
      {entry.progress && entry.progress !== 'indeterminate' && !entry.done && (
        <div className="activity-row-bar" aria-hidden>
          <i style={{
            width: `${Math.min(100, Math.round((entry.progress.current / Math.max(1, entry.progress.total)) * 100))}%`,
          }}
          />
        </div>
      )}
      {entry.progress === 'indeterminate' && !entry.done && (
        <div className="activity-row-bar is-indeterminate" aria-hidden><i /></div>
      )}
    </li>
  )
}

/** 挂在各工作区已有状态栏最右侧（剧本 `.statusbar` / 进度 `.flow-statusbar`）。 */
export function ActivityPanel() {
  const snap = useSyncExternalStore(
    subscribeActivity,
    getActivitySnapshot,
    getActivitySnapshot,
  )
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!snap.open) return
    const onPointer = (event: PointerEvent) => {
      const root = panelRef.current
      if (!root) return
      if (root.contains(event.target as Node)) return
      setActivityPanelOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActivityPanelOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [snap.open])

  return (
    <div className="activity-dock" ref={panelRef}>
      {snap.open && (
        <section className="activity-panel" aria-label="活动列表">
          <header className="activity-panel-head">
            <h2>活动</h2>
            <div className="activity-panel-actions">
              <button type="button" disabled={snap.entries.length === 0} onClick={() => clearActivities()}>
                清空
              </button>
              <button type="button" aria-label="关闭活动列表" onClick={() => setActivityPanelOpen(false)}>
                ×
              </button>
            </div>
          </header>
          {snap.entries.length === 0 ? (
            <p className="activity-empty">暂无活动。保存、导入、刷新快照等会显示在这里。</p>
          ) : (
            <ul className="activity-list">
              {snap.entries.map((entry) => (
                <ActivityRow key={entry.id} entry={entry} />
              ))}
            </ul>
          )}
        </section>
      )}
      <button
        type="button"
        className={`activity-bell${snap.open ? ' is-open' : ''}${snap.unreadCount > 0 ? ' has-unread' : ''}`}
        aria-label={snap.unreadCount > 0 ? `活动列表，${snap.unreadCount} 条未读` : '活动列表'}
        aria-expanded={snap.open}
        title="活动"
        onClick={() => toggleActivityPanel()}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
          <path
            fill="currentColor"
            d="M8 14.5a1.5 1.5 0 0 0 1.5-1.5h-3A1.5 1.5 0 0 0 8 14.5ZM13 10.5V7a5 5 0 1 0-10 0v3.5L1.5 12V13h13v-1l-1.5-1.5Z"
          />
        </svg>
        {snap.unreadCount > 0 && (
          <span className="activity-bell-badge">{snap.unreadCount > 99 ? '99+' : snap.unreadCount}</span>
        )}
      </button>
    </div>
  )
}
