import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent, type ReactNode } from 'react'
import type { Snapshot } from '../collab/protocol'
import type { ProjectClient } from './serviceClient'
import { EditTransactionPanel } from './EditTransactionPanel'
import './collaboration-widget.css'

type Position = { x: number; y: number }
type Snap = { x: 'left' | 'right' | null; y: 'top' | 'bottom' | null }
const positionKey = 'hanshu.collaborationPosition.v1'
const ORB = { w: 87, h: 69 }
const TITLEBAR_H = 40
const STATUSBAR_H = 28
const colors = ['#ac9bda', '#7cbba7', '#d7ac79', '#85afd1', '#c990ac']
function color(id: string) { let value = 0; for (const ch of id) value = (value * 31 + ch.charCodeAt(0)) >>> 0; return colors[value % colors.length] }
const fileName = (path: string) => path === '.hanshu/skinmanager/library.json' ? '皮肤库' : path.split('/').at(-1) ?? path
function loadPosition(): Position {
  let pos = fitOrb({ x: window.innerWidth - ORB.w - 24, y: window.innerHeight - ORB.h - 48 })
  try {
    const value = JSON.parse(localStorage.getItem(positionKey) ?? 'null')
    if (Number.isFinite(value?.x) && Number.isFinite(value?.y)) pos = fitOrb(value)
  } catch { /* Optional preference. */ }
  return applySnap(pos, detectSnap(pos))
}
function orbBounds() {
  return {
    left: 0,
    top: TITLEBAR_H,
    right: Math.max(0, window.innerWidth - ORB.w),
    bottom: Math.max(TITLEBAR_H, window.innerHeight - ORB.h - STATUSBAR_H),
  }
}
function fitOrb(next: Position): Position {
  const box = orbBounds()
  return {
    x: Math.max(box.left, Math.min(next.x, box.right)),
    y: Math.max(box.top, Math.min(next.y, box.bottom)),
  }
}
function detectSnap(pos: Position): Snap {
  return { x: pos.x + ORB.w / 2 <= window.innerWidth / 2 ? 'left' : 'right', y: null }
}
function applySnap(pos: Position, snap: Snap): Position {
  const box = orbBounds()
  return {
    x: snap.x === 'right' ? box.right : box.left,
    y: Math.max(box.top, Math.min(pos.y, box.bottom)),
  }
}
function readTranslateX(el: HTMLElement): number {
  const value = getComputedStyle(el).transform
  if (!value || value === 'none') return 0
  return new DOMMatrix(value).m41
}
function fitPanel(next: Position, width: number, height: number): Position {
  return {
    x: Math.max(12, Math.min(next.x, window.innerWidth - width - 12)),
    y: Math.max(48, Math.min(next.y, window.innerHeight - height - 40)),
  }
}
/** 展开时从浮球右下角向上向左展开；仅改显示坐标，不改写浮球锚点。 */
function panelFromOrb(orb: Position, width: number, height: number): Position {
  return fitPanel({ x: orb.x + ORB.w - width, y: orb.y + ORB.h - height }, width, height)
}
function orbFromPanel(panel: Position, width: number, height: number): Position {
  return fitOrb({ x: panel.x + width - ORB.w, y: panel.y + height - ORB.h })
}
const subscribeNothing = () => () => undefined
const emptyState = { pendingPaths: [], queued: 0, preparing: 0, transactions: [], journalError: '' }

export function CollaborationWidget({ client, snapshot, projectName, open, onOpenChange, error, management, onProjectAction }: {
  client: ProjectClient | null; snapshot: Snapshot | null; projectName: string; open: boolean; onOpenChange: (open: boolean) => void
  error: string; management: ReactNode; onProjectAction: (action: 'open' | 'create' | 'share' | 'connect') => void
}) {
  const state = useSyncExternalStore(client?.transactions.subscribe ?? subscribeNothing, client?.transactions.getSnapshot ?? (() => emptyState))
  /** 收起时浮球左上角；展开/收起不改写，避免回位漂移 */
  const [orbPos, setOrbPos] = useState(loadPosition)
  const [dragging, setDragging] = useState(false)
  const [peeking, setPeeking] = useState(false)
  const [docked, setDocked] = useState(true)
  const snapRef = useRef<Snap>(detectSnap(orbPos))
  const [edge, setEdge] = useState<'left' | 'right' | null>(snapRef.current.x)
  const dockReady = useRef(true)
  const hideTimer = useRef<number | null>(null)
  const [panelSize, setPanelSize] = useState({ w: 492, h: 420 })
  const [tab, setTab] = useState<'people' | 'changes' | 'manage'>('people')
  const root = useRef<HTMLDivElement>(null)
  const drag = useRef<{ start: Position; originOrb: Position; originDisplay: Position; moved: boolean } | null>(null)
  const suppressClick = useRef(false)
  const anchor = fitOrb(orbPos)
  const display = open
    ? panelFromOrb(anchor, panelSize.w, panelSize.h)
    : dragging
      ? orbPos
      : anchor

  useEffect(() => {
    const onResize = () => setOrbPos(value => applySnap(value, snapRef.current.x ? snapRef.current : detectSnap(value)))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    if (!open || !root.current) return
    const observer = new ResizeObserver(() => {
      const el = root.current
      if (!el) return
      const w = el.offsetWidth
      const h = el.offsetHeight
      if (w > 0 && h > 0) setPanelSize({ w, h })
    })
    observer.observe(root.current)
    return () => observer.disconnect()
  }, [open])

  useEffect(() => {
    try { localStorage.setItem(positionKey, JSON.stringify(orbPos)) } catch { /* Optional preference. */ }
  }, [orbPos])

  useEffect(() => {
    if (open || dragging || !edge) {
      setDocked(false)
      dockReady.current = false
      return
    }
    if (dockReady.current) {
      setDocked(true)
      return
    }
    const timer = window.setTimeout(() => {
      dockReady.current = true
      setDocked(true)
    }, 200)
    return () => window.clearTimeout(timer)
  }, [orbPos, open, dragging, edge])

  useEffect(() => () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current)
  }, [])

  function showOrb() {
    if (hideTimer.current) window.clearTimeout(hideTimer.current)
    hideTimer.current = null
    setPeeking(true)
  }
  function scheduleHide() {
    if (hideTimer.current) window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = null
      setPeeking(false)
    }, 280)
  }

  function start(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest('[data-no-drag]')) return
    drag.current = {
      start: { x: event.clientX, y: event.clientY },
      originOrb: orbPos,
      originDisplay: display,
      moved: false,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  function move(event: PointerEvent<HTMLElement>) {
    const value = drag.current
    if (!value) return
    const dx = event.clientX - value.start.x
    const dy = event.clientY - value.start.y
    if (Math.hypot(dx, dy) > 4) {
      if (!value.moved) {
        setDragging(true)
        if (!open && root.current) {
          const shift = readTranslateX(root.current)
          if (shift) value.originOrb = { x: value.originOrb.x + shift, y: value.originOrb.y }
        }
      }
      value.moved = true
    }
    if (!value.moved) return
    if (!open) {
      const box = orbBounds()
      setOrbPos({
        x: value.originOrb.x + dx,
        y: Math.max(box.top, Math.min(value.originOrb.y + dy, box.bottom)),
      })
      return
    }
    snapRef.current = { x: null, y: null }
    setEdge(null)
    const nextPanel = fitPanel(
      { x: value.originDisplay.x + dx, y: value.originDisplay.y + dy },
      panelSize.w,
      panelSize.h,
    )
    setOrbPos(orbFromPanel(nextPanel, panelSize.w, panelSize.h))
  }
  function end(event: PointerEvent<HTMLElement>) {
    const value = drag.current
    suppressClick.current = value?.moved ?? false
    drag.current = null
    setDragging(false)
    if (!value?.moved || open) return
    const next = {
      x: value.originOrb.x + event.clientX - value.start.x,
      y: value.originOrb.y + event.clientY - value.start.y,
    }
    const snap = detectSnap(next)
    snapRef.current = snap
    setEdge(snap.x)
    const snapped = applySnap(next, snap)
    requestAnimationFrame(() => setOrbPos(snapped))
  }

  const failures = state.transactions.filter(item => ['failed', 'conflict', 'uncertain'].includes(item.phase))
  const attention = !!error || failures.length > 0 || !!state.journalError
  const status = !client ? '未打开工程' : !client.online ? '连接已断开' : attention ? '修改需要处理' : state.queued ? '正在保存…' : state.pendingPaths.length ? `${state.pendingPaths.length} 个文件待保存` : '所有修改已保存'
  const members = snapshot?.members.filter(member => snapshot.sessions.some(session => session.subjectId === member.subject.id)) ?? []
  const currentPath = snapshot?.session.filePresence?.path

  const tucked = !open && docked && !dragging && !peeking && !!edge
  return <div ref={root} className={`collab-widget${open ? ' is-open' : ''}${dragging ? ' is-dragging' : ''}${tucked ? ` is-docked is-docked-${edge}` : ''}${peeking ? ' is-peeking' : ''}${attention ? ' needs-attention' : ''}`} data-project-name={projectName} data-online={!!client?.online} style={{ left: display.x, top: display.y }} onPointerEnter={showOrb} onPointerLeave={scheduleHide}>
    {!open ? <button className="collab-orb" aria-label="打开协作面板" title={`${status} · 松手贴到左右边缘，平时缩进边缘，鼠标移上去展开`} onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onClick={() => { if (!suppressClick.current) onOpenChange(true); suppressClick.current = false }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="9" cy="8" r="3" /><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v2" /></svg><i className={!client?.online ? 'is-offline' : attention ? 'is-warning' : ''} /><span>{attention ? '!' : members.length || '＋'}</span>
    </button> : <section className="collab-panel" aria-label="协作面板">
      <header className="collab-drag-handle" onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
        <div><strong>协作</strong><span title={projectName}>{projectName || 'HanShu'}</span></div><button data-no-drag aria-label="收起协作面板" onClick={() => onOpenChange(false)}>−</button>
      </header>
      <div className={`collab-status${attention ? ' is-warning' : ''}`} role="status"><i className={!client?.online ? 'is-offline' : ''} />{status}<small>{snapshot ? ({owner:'管理者',editor:'可编辑',viewer:'只读'}[snapshot.role]) : ''}</small></div>
      {client && snapshot ? <>
        <nav className="collab-tabs" aria-label="协作视图"><button aria-pressed={tab === 'people'} onClick={() => setTab('people')}>成员 <span>{members.length}</span></button><button aria-pressed={tab === 'changes'} onClick={() => setTab('changes')}>修改 {state.pendingPaths.length + failures.length > 0 && <span>{failures.length || state.pendingPaths.length}</span>}</button>{snapshot.role === 'owner' && <button aria-pressed={tab === 'manage'} onClick={() => setTab('manage')}>用户管理</button>}</nav>
        <div className="collab-body">
          {error && <p className="collab-error" role="alert">{error}</p>}
          {tab === 'people' && <><div className="collab-section-heading">整个工程 <small>各窗口的当前焦点</small></div><div className="collab-members">{members.map(member => <article key={member.subject.id}>
            <span className="collab-avatar" style={{ background: color(member.subject.id) }}>{Array.from(member.subject.name)[0]}</span><div><strong>{member.subject.name}{member.subject.id === snapshot.session.subjectId && <small>你</small>}</strong>{snapshot.sessions.filter(session => session.subjectId === member.subject.id).map(session => <div className={`collab-session${session.id === snapshot.session.id ? ' is-mine' : ''}`} key={session.id} title={`${session.clientName} · ${session.filePresence?.path ?? '未查看文件'}${session.filePresence?.entryId ? ` · ${session.filePresence.entryId}` : ''}`}  aria-label={`${member.subject.name} · ${session.clientName}${session.id === snapshot.session.id ? ' · 自己' : ''} · ${session.filePresence?.activity === 'editing' ? '编辑中' : '查看中'}`}><i /><span>{session.filePresence ? fileName(session.filePresence.path) + (session.filePresence.entryId ? ' · 条目' : '') : '未查看文件'}</span><small>{session.filePresence?.activity === 'editing' ? '编辑中' : '查看中'}</small></div>)}</div>
          </article>)}</div>{currentPath && <div className="collab-current-file"><span>当前文件</span><strong title={currentPath}>{fileName(currentPath)}</strong></div>}<button className="collab-draft-link" onClick={() => setTab('changes')}>{state.pendingPaths.length ? `${state.pendingPaths.length} 个文件有本机修改` : '本机没有待保存修改'}<span>→</span></button></>}
          {tab === 'changes' && <><div className="collab-section-heading">本机修改 <small>包含其他文件的草稿</small></div>{state.pendingPaths.length > 0 && <ul className="collab-draft-files">{state.pendingPaths.map(path => <li key={path} title={path}><span>◦</span><strong>{fileName(path)}</strong><small>{path.startsWith('assets/') ? '资源' : '文档'}</small></li>)}</ul>}<EditTransactionPanel client={client} /></>}
          {tab === 'manage' && snapshot.role === 'owner' && <div className="collab-management">{management}</div>}
        </div>
        <footer>{snapshot.role === 'owner' && <button onClick={() => onProjectAction('share')}>分享工程</button>}<span>{snapshot.sessions.length} 个窗口在线</span></footer>
      </> : <div className="collab-body collab-welcome"><p>打开一个工程，开始创作。</p><button onClick={() => onProjectAction('open')}>打开工程…</button><button onClick={() => onProjectAction('create')}>新建工程…</button><button onClick={() => onProjectAction('connect')}>连接其他服务器…</button>{error && <p role="alert">{error}</p>}</div>}
    </section>}
    {!open && attention && <span className="collab-attention-label" role="status">有修改需要处理</span>}
  </div>
}
