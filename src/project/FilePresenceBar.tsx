import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { ProjectClient } from './serviceClient'
import { useFileEditing } from './useFileEditing'
import { useResourcePresence } from './useResourcePresence'
import { ResourceSaveStatus } from './ResourceSaveStatus'
import { resourceDirty, resourceTransactions } from './resourceStatus'
import './file-presence.css'

const colors = ['#a397e8', '#79c9b0', '#edb67b', '#84b8e5', '#db9eb9', '#b9c785']
function color(id: string) { let value = 0; for (const c of id) value = (value * 31 + c.charCodeAt(0)) >>> 0; return colors[value % colors.length] }
function initials(name: string) { return /^[a-z]/i.test(name) ? name.split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase() : [...name].slice(0, 1).join('') }
const roleNames = { owner: '管理者', editor: '编辑者', viewer: '只读' }

export function FilePresenceBar({ client, path, entryId = null, mode = 'managed', dirty: localDirty = false, label }: { client: ProjectClient; path: string; entryId?: string | null; mode?: 'managed' | 'optimistic'; dirty?: boolean; label?: string }) {
  const editing = useFileEditing(client)!
  const transactions = useSyncExternalStore(client.transactions.subscribe, client.transactions.getSnapshot)
  const [confirm, setConfirm] = useState(false)
  const snapshot = client.snapshot
  const mine = snapshot.session.id
  const authorityId = snapshot.session.filePresence?.path === path ? snapshot.session.filePresence.authorityId : `file:${client.editingAuthority(path) ?? path}`
  const peers = snapshot.sessions.filter(session => session.expiresAt > editing.observedAt && session.filePresence?.authorityId === authorityId && (session.filePresence?.entryId ?? null) === entryId)
    .sort((a, b) => Number(b.id === mine) - Number(a.id === mine) || Number(b.filePresence?.activity === 'editing') - Number(a.filePresence?.activity === 'editing') || a.id.localeCompare(b.id))
  const lease = snapshot.leases.find(item => item.expiresAt > editing.observedAt && (item.resourceId === authorityId || authorityId.startsWith(`${item.resourceId}/`)))
  const holder = lease && snapshot.sessions.find(session => session.id === lease.sessionId)
  const holderName = holder && snapshot.members.find(member => member.subject.id === holder.subjectId)?.subject.name || '另一位协作者'
  const other = holder && holder.id !== mine
  const editable = editing.canEdit(path)
  const suspended = editing.state(path)?.lost
  const pending = !!editing.pending || transactions.queued > 0
  const draftPaths = JSON.stringify([...new Set([...transactions.pendingPaths, ...transactions.transactions.filter(item => ['failed', 'conflict', 'uncertain'].includes(item.phase)).flatMap(item => item.paths)])].sort())
  useEffect(() => {
    const paths = JSON.parse(draftPaths) as string[]
    if (!client.online || !paths.length) return
    let current = true
    // Query only when paths or the project revision change, not on every keystroke.
    void client.planOperations(paths.map(path => ({ op: 'write', path, destination: null }))).then(() => { if (current) editing.changed() }).catch(() => undefined)
    return () => { current = false }
  }, [client, editing, draftPaths, client.tree.revision, client.online])
  const scope = { path, entryId }
  const dirty = resourceDirty(client, scope, transactions, localDirty)
  const pendingHere = resourceTransactions(client, scope, transactions).some(record => record.phase !== 'saved')
  const intent = mode === 'managed' ? editable : snapshot.role !== 'viewer' && (dirty || pendingHere)
  useResourcePresence(client, path, entryId, intent ? 'editing' : 'viewing')
  async function action(run: () => Promise<void>) { try { await run() } catch { /* The editing controller exposes the recoverable error. */ } }
  function capsule(session: typeof peers[number]) {
    const member = snapshot.members.find(member => member.subject.id === session.subjectId)
    const name = member?.subject.name || '未命名主体'
    const status = session.filePresence?.activity === 'editing' ? '编辑中' : '查看中'
    const own = session.id === mine
    const label = `${name} · ${session.clientName} · ${status}${own ? ' · 自己' : ''}`
    return <details className={`file-presence-person${status === '编辑中' ? ' is-editing' : ''}`} key={session.id} style={{ '--person-color': color(session.subjectId) } as CSSProperties}>
      <summary aria-label={label} title={label}>
        <span className="file-presence-avatar" aria-hidden="true">{initials(name)}<i /></span>
        <span className="file-presence-person-name">{name}{own && <small>你</small>}</span>
        <span className="file-presence-person-state">{status}</span>
      </summary>
      <div className="file-presence-person-detail"><strong>{name}{own ? '（自己）' : ''}</strong><span>{session.clientName}</span><span>{member ? roleNames[member.role] : ''} · {status}</span></div>
    </details>
  }
  return <section className={`file-presence-bar${!client.online ? ' is-offline' : ''}`} aria-label="当前文件协作者" data-resource-path={path} data-entry-id={entryId ?? undefined} data-edit-mode={mode}>
    <div className="file-presence-main">
      <span className="file-presence-caption" title={label ?? path}><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="7" cy="6" r="2.5"/><path d="M2 16v-2a5 5 0 0 1 10 0v2M13 4a2.5 2.5 0 0 1 0 5m2 2a5 5 0 0 1 3 5"/></svg><span>{label ?? '协作'}</span></span>
      <div className="file-presence-people">
        {client.online ? <>{peers.slice(0, 5).map(capsule)}{peers.length > 5 && <details className="file-presence-overflow"><summary aria-label={`另外 ${peers.length - 5} 个窗口`}>+{peers.length - 5}</summary><div>{peers.slice(5).map(capsule)}</div></details>}{!peers.length && <span className="file-presence-muted">正在同步在线状态…</span>}</> : <span className="file-presence-muted">连接已断开 · 在线状态暂不可用</span>}
      </div>
      <div className="file-presence-actions">
        <span className={`file-presence-mode${intent ? ' is-editing' : ''}`}>{!client.online ? '连接已断开' : mode === 'optimistic' ? snapshot.role === 'viewer' ? '只读访问' : '可编辑' : editable ? '正在编辑' : snapshot.role === 'viewer' ? '只读访问' : suspended ? '编辑已暂停' : '查看模式'}</span>
        {mode === 'optimistic' && lease && <span className="file-presence-lease">{other ? `${holderName}持有临时写权` : '持有临时写权'}</span>}
        {mode === 'managed' && (editable ? <button type="button" disabled={pending} onClick={() => void action(() => editing.end(path))}>结束编辑</button>
          : snapshot.role !== 'viewer' && <button className="file-presence-start" type="button" disabled={!client.online || pending || !!other} onClick={() => void action(() => editing.begin(path))}>{editing.pending === path ? '正在申请…' : suspended ? '重新申请写权' : '开始编辑'}</button>)}
        {mode === 'managed' && other && snapshot.role === 'owner' && <button type="button" disabled={!client.online || pending} onClick={() => setConfirm(!confirm)}>接管编辑</button>}
      </div>
    </div>
    {mode === 'managed' && (other || suspended || (!editable && dirty) || editing.error) && <div className="file-presence-note" role="status">{editing.error || (other ? `${holderName}（${holder.clientName}）持有写权。${suspended || dirty ? '你的草稿已保留，申请写权后可继续。' : '你可以查看，待对方结束编辑后接续。'}` : suspended ? editing.state(path)?.reason : '未保存的草稿保留在本窗口，开始编辑后可继续保存。')}</div>}
    {editing.presenceError && <div className="file-presence-note" role="status">{editing.presenceError}<button type="button" disabled={!client.online} onClick={() => editing.publishFocus()}>重试在线状态</button></div>}
    <ResourceSaveStatus client={client} path={path} entryId={entryId} dirty={localDirty} compact />
    {mode === 'managed' && confirm && other && <div className="file-presence-confirm" role="group" aria-label="确认接管编辑"><span>接管后，{holderName}的表单将暂停编辑，对方未保存的草稿会保留。</span><button type="button" onClick={() => { setConfirm(false); void action(() => editing.begin(path, true)) }}>确认接管</button><button type="button" onClick={() => setConfirm(false)}>取消</button></div>}
  </section>
}
