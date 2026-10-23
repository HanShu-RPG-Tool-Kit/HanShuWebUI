import { useEffect, useState } from 'react'
import { request } from '../collab/protocol'
import { rememberConnection } from './recentConnections'
import { rememberRemoteProjectResume } from './projectResume'
import { getProjectClient } from './serviceClient'
import { getProjectSession } from './projectSession'
/** Shared URLs are entry points, not identity or authorization credentials. */
export function ProjectShareJoin({ onConnect, connected }: { onConnect: (base: string, token: string) => Promise<unknown>; connected: boolean }) {
  const [visible, setVisible] = useState(false), [username, setUsername] = useState(''), [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => { let stopped = false; void request<{authentication:string}>({url:window.location.origin,token:''},'/api/share/info').then(info => {if(!stopped && info.authentication==='password')setVisible(true)}).catch(()=>undefined); return ()=>{stopped=true} }, [])
  if (!visible || connected) return null
  return <div className="project-connect-backdrop"><form className="project-connect-dialog" aria-label="登录共享工程" onSubmit={e => {
    e.preventDefault(); if(busy)return; setBusy(true);setError('')
    const base=window.location.origin
    void request<{token:string}>({url:base,token:''},'/api/sessions','POST',{username:username.trim(),password,clientName:sessionStorage.getItem('hanshu.windowName')||'浏览器窗口'}).then(async login=>{
      setPassword('');await onConnect(base,login.token);setVisible(false)
      const client=getProjectClient()
      if(client){
        const projectName=getProjectSession().binding?.manifest.name??client.snapshot.projectName
        const user=username.trim()
        rememberConnection({url:base,projectId:client.snapshot.projectId,projectName,username:user})
        rememberRemoteProjectResume({url:base,username:user,projectId:client.snapshot.projectId,projectName})
      }
      if(window.location.hash.startsWith('#join='))window.history.replaceState(null,'',window.location.pathname+window.location.search)
    }).catch(e=>setError(String(e))).finally(()=>setBusy(false))
  }}><h2>登录共享工程</h2><p>请使用本机管理员创建的账号。Admin 不能远程登录。</p><label>用户名<input aria-label="用户名" required maxLength={40} autoComplete="username" value={username} onChange={e=>setUsername(e.target.value)} autoFocus /></label><label>密码<input aria-label="密码" type="password" required autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} /></label>{error&&<p role="alert">{error}</p>}<footer><button type="button" disabled={busy} onClick={()=>setVisible(false)}>关闭</button><button disabled={busy}>{busy?'正在登录…':'登录工程'}</button></footer></form></div>
}
