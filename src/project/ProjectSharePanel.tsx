import { useEffect, useRef, useState } from 'react'
import { request, type Connection } from '../collab/protocol'
import './project-share.css'

type GuestRole = 'viewer' | 'editor'
type Invitation = { id: string; role: GuestRole; expiresAt: number; uses: number; url: string | null }
type ShareStatus = {
  active: boolean; urls: string[]; invitations: Invitation[]; serverTime: number
  guests: { id: string; name: string; role: GuestRole; enabled: boolean; sessions: number }[]
  firewall: { supported: boolean; phase: string; message: string }
}
const roleName = { viewer: '只读', editor: '可编辑' }

export function ProjectSharePanel({ connection, online, open, onClose }: { connection: Connection; online: boolean; open: boolean; onClose: () => void }) {
  const [status, setStatus] = useState<ShareStatus | null>(null)
  const [role, setRole] = useState<GuestRole>('editor')
  const [ttl, setTtl] = useState(3600)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState('')
  const operation = useRef(false)
  const read = () => request<ShareStatus>(connection, '/api/share/status')
  async function run(action: () => Promise<unknown>) {
    if (operation.current) return
    operation.current = true; setBusy(true); setError(''); setCopied('')
    try { await action(); setStatus(await read()) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { operation.current = false; setBusy(false) }
  }
  useEffect(() => {
    if (!open || !online) return
    let stopped = false
    const refresh = () => {
      if (operation.current) return
      void request<ShareStatus>(connection, '/api/share/status').then(value => { if (!stopped && !operation.current) setStatus(value) })
        .catch(e => { if (!stopped) setError(String(e)) })
    }
    refresh(); const timer = setInterval(refresh, 3000)
    return () => { stopped = true; clearInterval(timer) }
  }, [open, online, connection])
  async function copy(invitation: Invitation) {
    if (!invitation.url) return
    try { await navigator.clipboard.writeText(invitation.url); setCopied(invitation.id) }
    catch { setError('浏览器不允许复制，请选中下方链接后复制。') }
  }
  return <>
    {open && <div className="project-connect-backdrop"><section className="project-share-dialog" role="dialog" aria-modal="true" aria-label="分享工程">
      <header><div><h2>分享工程</h2><p>同一局域网内，打开邀请链接即可一起工作。</p></div><button aria-label="关闭分享面板" onClick={onClose}>×</button></header>
      <div className="project-share-body">
        <section className="project-share-switch"><div><strong>局域网共享</strong><p>{status?.active ? '正在分享当前工程，本机窗口可继续编辑。' : '开启后自动选择地址和端口。'}</p></div><button role="switch" aria-label="局域网共享" aria-checked={status?.active ?? false} disabled={busy || !online || !status} onClick={() => void run(() => request(connection, `/api/share/${status?.active ? 'disable' : 'enable'}`, 'POST'))}><span />{status?.active ? '已开启' : '开启共享'}</button></section>
        {!status && !error && <p>正在读取共享状态…</p>}
        {status?.active && <>
          <section><h3>邀请加入</h3><p>收到链接的人可以加入。有效期只限制新加入，撤销链接不会移除已加入的人。</p>
            <div className="project-share-create"><label>权限<select aria-label="邀请权限" value={role} onChange={e => setRole(e.target.value as GuestRole)}><option value="editor">可编辑</option><option value="viewer">只读</option></select></label><label>有效期<select aria-label="邀请有效期" value={ttl} onChange={e => setTtl(Number(e.target.value))}><option value={600}>10 分钟</option><option value={3600}>1 小时</option><option value={86400}>24 小时</option></select></label><button className="is-primary" disabled={busy || !online} onClick={() => void run(() => request(connection, '/api/share/invitations', 'POST', { role, ttlSeconds: ttl }))}>生成邀请链接</button></div>
            <div className="project-share-invitations">{status.invitations.length === 0 && <p>还没有邀请链接。</p>}{status.invitations.map(invitation => <article key={invitation.id}><div><strong>{roleName[invitation.role]}</strong><span>{invitation.expiresAt > status.serverTime ? `${new Date(invitation.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} 到期` : '已过期'} · 已加入 {invitation.uses} 人</span><button disabled={busy || !online} onClick={() => void run(() => request(connection, `/api/share/invitations/${invitation.id}`, 'DELETE'))}>撤销</button></div><div><input aria-label={`${roleName[invitation.role]}邀请链接`} readOnly value={invitation.url ?? ''} onFocus={e => e.target.select()} /><button disabled={invitation.expiresAt <= status.serverTime} onClick={() => void copy(invitation)}>{copied === invitation.id ? '已复制' : '复制链接'}</button></div></article>)}</div>
          </section>
          <section><h3>加入者 <span>{status.guests.filter(guest => guest.enabled).length}</span></h3><p>每位加入者都有独立身份。移除会立即收回其写权；阻止继续加入还需撤销邀请链接。</p><div className="project-share-guests">{status.guests.length === 0 && <p>暂时没有人加入。</p>}{status.guests.map(guest => <div key={guest.id}><span className="project-share-avatar">{Array.from(guest.name)[0]}</span><div><strong>{guest.name}</strong><small>{guest.enabled ? guest.sessions ? `${guest.sessions} 个窗口在线` : '离线' : '已移除'}</small></div><select aria-label={`${guest.name}共享权限`} value={guest.role} disabled={busy || !online || !guest.enabled} onChange={e => void run(() => request(connection, `/api/subjects/${guest.id}`, 'PATCH', { role: e.target.value, enabled: true }))}><option value="editor">可编辑</option><option value="viewer">只读</option></select><button disabled={busy || !online || !guest.enabled} onClick={() => void run(() => request(connection, `/api/share/guests/${guest.id}/remove`, 'POST'))}>移除</button></div>)}</div></section>
          <section className="project-share-network"><h3>连接帮助</h3><p>对方需能访问 {status.urls[0]}。关闭共享会断开加入者，本机工程仍保持打开。</p>{status.firewall.supported && <><button disabled={busy || !online || status.firewall.phase === 'prompting'} onClick={() => void run(() => request(connection, '/api/share/firewall', 'POST'))}>{status.firewall.phase === 'prompting' ? '等待系统授权…' : '允许防火墙访问（专用网络）'}</button><p>连接被防火墙阻止时，在本机点击上方按钮并确认 Windows 系统授权。</p>{status.firewall.phase === 'allowed' && <p>防火墙规则已允许 HanShu 在专用网络中共享。</p>}{status.firewall.message && <p role="alert">{status.firewall.message}</p>}</>}</section>
        </>}
        {error && <p role="alert">{error}</p>}
      </div>
      <footer><span>{!online ? '本机连接已断开，请先恢复连接。' : '共享随本机服务运行；关闭后所有邀请失效。'}</span><button onClick={onClose}>完成</button></footer>
    </section></div>}
  </>
}
