import { useEffect, useState } from 'react'
import { request, type Role } from '../collab/protocol'
import type { ProjectClient } from './serviceClient'
type User = { id: string; username: string; nickname: string; enabled: boolean; role: Role | null }
export function AccountManager({ client }: { client: ProjectClient }) {
  const [users, setUsers] = useState<User[]>([])
  const [username, setUsername] = useState(''), [nickname, setNickname] = useState(''), [password, setPassword] = useState('')
  const [role, setRole] = useState<'editor' | 'viewer'>('editor'), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [reset, setReset] = useState<User | null>(null), [resetPassword, setResetPassword] = useState('')
  const refresh = async () => setUsers((await request<{ users: User[] }>(client.connection, '/api/accounts')).users)
  useEffect(() => { let stopped=false;void request<{users:User[]}>(client.connection,'/api/accounts').then(value=>{if(!stopped)setUsers(value.users)}).catch(e=>{if(!stopped)setError(String(e))});return()=>{stopped=true} }, [client])
  async function run(action: () => Promise<unknown>) { if (busy) return; setBusy(true); setError(''); try { await action(); await refresh() } catch (e) { setError(String(e)) } finally { setBusy(false) } }
  return <section className="account-manager" aria-label="账号管理">
    <p>只有本机 Admin 可以创建账号。权限针对当前工程。</p>
    <div className="account-row"><strong>Admin</strong><small>本机专用 · 内置超管</small></div>
    {users.map(user => <article key={user.id} className="account-row"><div><strong>{user.nickname}</strong><small>@{user.username}{!user.enabled ? ' · 已停用' : ''}</small></div>
      <select aria-label={`${user.username}工程权限`} disabled={busy} value={user.role ?? ''} onChange={e => void run(() => request(client.connection, `/api/accounts/${user.id}`, 'PATCH', { role: e.target.value }))}><option value="" disabled>未授权</option><option value="editor">可编辑</option><option value="viewer">只读</option></select>
      <button disabled={busy} onClick={() => { setReset(user); setResetPassword('') }}>重置密码</button><button disabled={busy} onClick={() => void run(() => request(client.connection, `/api/accounts/${user.id}`, 'PATCH', { enabled: !user.enabled }))}>{user.enabled ? '停用' : '启用'}</button>
    </article>)}
    <form aria-label="创建用户" onSubmit={e => { e.preventDefault(); void run(async () => { await request(client.connection, '/api/accounts', 'POST', { username, nickname, password, role }); setUsername(''); setNickname(''); setPassword('') }) }}>
      <h4>新建用户</h4><label>用户名<input aria-label="新用户用户名" required minLength={3} maxLength={40} autoComplete="off" value={username} onChange={e => setUsername(e.target.value)} /></label>
      <label>昵称<input aria-label="新用户昵称" required maxLength={120} value={nickname} onChange={e => setNickname(e.target.value)} /></label>
      <label>初始密码<input aria-label="新用户密码" type="password" required minLength={10} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} /></label>
      <label>工程权限<select aria-label="新用户工程权限" value={role} onChange={e => setRole(e.target.value as 'editor' | 'viewer')}><option value="editor">可编辑</option><option value="viewer">只读</option></select></label><button type="submit" disabled={busy}>创建用户</button>
    </form>
    {reset && <form aria-label="重置密码" onSubmit={e => { e.preventDefault(); void run(async () => { await request(client.connection, `/api/accounts/${reset.id}`, 'PATCH', { password: resetPassword }); setReset(null); setResetPassword('') }) }}><h4>重置 @{reset.username} 的密码</h4><p>会使这个账号的现有登录失效。</p><input aria-label="重置后的密码" autoFocus autoComplete="new-password" type="password" required minLength={10} value={resetPassword} onChange={e => setResetPassword(e.target.value)} /><button disabled={busy}>确认重置</button><button type="button" onClick={() => setReset(null)}>取消</button></form>}
    {error && <p role="alert">{error}</p>}
  </section>
}
