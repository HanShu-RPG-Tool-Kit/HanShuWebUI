import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  clearControlLogs,
  disconnectGameDevControl,
  getControlHubSnapshot,
  reconnectGameDevControlNow,
  subscribeControlHub,
  updateGameDevServerPrefs,
  type ConnPhase,
  type ControlLogEntry,
} from './controlHub'
import './GameDevServerPanel.css'

function phaseLabel(phase: ConnPhase): string {
  switch (phase) {
    case 'open':
      return '已连接'
    case 'connecting':
      return '连接中…'
    case 'reconnecting':
      return '重连中…'
    case 'disabled':
      return '已停止'
    default:
      return '空闲'
  }
}

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

function LogRow({ entry }: { entry: ControlLogEntry }) {
  const [open, setOpen] = useState(false)
  return (
    <li className={`gds-log-row kind-${entry.kind}`}>
      <button
        type="button"
        className="gds-log-summary"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <time dateTime={new Date(entry.at).toISOString()}>{formatTime(entry.at)}</time>
        <span className="gds-log-kind">{entry.kind}</span>
        <span className="gds-log-text">{entry.summary}</span>
      </button>
      {open && entry.detail && <pre className="gds-log-detail">{entry.detail}</pre>}
    </li>
  )
}

export function GameDevServerPanel({ onClose }: { onClose: () => void }) {
  const snap = useSyncExternalStore(
    subscribeControlHub,
    getControlHubSnapshot,
    getControlHubSnapshot,
  )
  const dialog = useRef<HTMLDivElement>(null)
  const [host, setHost] = useState(snap.prefs.host)
  const [port, setPort] = useState(String(snap.prefs.port))
  const [password, setPassword] = useState(snap.prefs.password)
  const [autoConnect, setAutoConnect] = useState(snap.prefs.autoConnect)

  useEffect(() => {
    setHost(snap.prefs.host)
    setPort(String(snap.prefs.port))
    setPassword(snap.prefs.password)
    setAutoConnect(snap.prefs.autoConnect)
  }, [snap.prefs])

  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const first = dialog.current?.querySelector<HTMLElement>('button, input')
    first?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      previous?.focus()
    }
  }, [onClose])

  const apply = () => {
    const parsed = Number.parseInt(port, 10)
    updateGameDevServerPrefs({
      host,
      port: Number.isFinite(parsed) ? parsed : snap.prefs.port,
      password,
      autoConnect,
    })
  }

  return (
    <div className="gds-backdrop" role="presentation" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose()
    }}>
      <div
        ref={dialog}
        className="gds-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gds-title"
      >
        <header className="gds-header">
          <div>
            <h2 id="gds-title">游戏开发服务器</h2>
            <p>
              连接本机 Control 门户（<code>/ws/control</code>）。C 侧会自动轮询重连；
              mod 可通过 <code>ControlHub.request</code> 查询物品库。
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <div className="gds-layout">
          <section className="gds-config" aria-label="连接配置">
            <h3>连接</h3>
            <label>
              主机
              <input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label>
              端口
              <input
                value={port}
                onChange={(e) => setPort(e.target.value)}
                inputMode="numeric"
                autoComplete="off"
              />
            </label>
            <label>
              门户密码
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="gds-check">
              <input
                type="checkbox"
                checked={autoConnect}
                onChange={(e) => setAutoConnect(e.target.checked)}
              />
              自动连接（后台轮询）
            </label>
            <div className="gds-actions">
              <button type="button" className="primary" onClick={apply}>
                应用
              </button>
              <button type="button" onClick={() => reconnectGameDevControlNow()}>
                立即重连
              </button>
              <button type="button" onClick={() => disconnectGameDevControl()}>
                断开
              </button>
            </div>

            <div className={`gds-phase phase-${snap.phase}`}>
              <strong>{phaseLabel(snap.phase)}</strong>
              {snap.health ? (
                <span>
                  门户 HTTP 正常
                  {snap.health.services?.length
                    ? ` · ${snap.health.services.join(', ')}`
                    : ''}
                </span>
              ) : (
                <span>门户 HTTP 未通（需客户端已起且密码正确）</span>
              )}
              {snap.status && (
                <span>
                  control subscribers={snap.status.subscribers ?? '—'} · pending=
                  {snap.status.pending ?? '—'}
                </span>
              )}
              {snap.lastError && <span className="gds-err">{snap.lastError}</span>}
            </div>

            <div className="gds-stats">
              <span>已处理 {snap.handled}</span>
              <span>失败 {snap.failed}</span>
            </div>

            <h3>可用方法</h3>
            <ul className="gds-methods">
              <li>
                <code>ping</code> — 探活（入站）
              </li>
              <li>
                <code>items.list</code> / <code>get</code> / <code>query</code> — 物品库查询（入站）
              </li>
              <li>
                <code>items.renderSnapshots</code> — WebUI 出站拉展示快照（≤128）
              </li>
            </ul>
          </section>

          <section className="gds-console" aria-label="控制台">
            <div className="gds-console-bar">
              <h3>控制台</h3>
              <button type="button" onClick={() => clearControlLogs()}>
                清空
              </button>
            </div>
            {snap.logs.length === 0 ? (
              <p className="gds-console-empty">尚无请求。等待 mod 发起 ControlHub.request…</p>
            ) : (
              <ul className="gds-log-list">
                {snap.logs.map((entry) => (
                  <LogRow key={entry.id} entry={entry} />
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
