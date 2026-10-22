import { useEffect, useRef, useState } from 'react'
import { request, type Connection } from '../collab/protocol'
import './project-share.css'
type ShareStatus = { active: boolean; urls: string[]; firewall: { supported: boolean; phase: string; message: string } }
export function ProjectSharePanel({ connection, online, open, onClose }: { connection: Connection; online: boolean; open: boolean; onClose: () => void }) {
  const [status, setStatus] = useState<ShareStatus | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [copied,setCopied]=useState(false)
  const operation=useRef(false)
  async function run(action:()=>Promise<unknown>) { if(operation.current)return;operation.current=true;setBusy(true);setError('');try{await action();setStatus(await request(connection,'/api/share/status'))}catch(e){setError(String(e))}finally{operation.current=false;setBusy(false)} }
  useEffect(()=>{if(!open||!online)return;let stopped=false;const read=()=>{if(!operation.current)void request<ShareStatus>(connection,'/api/share/status').then(value=>{if(!stopped)setStatus(value)}).catch(e=>{if(!stopped)setError(String(e))})};read();const timer=setInterval(read,3000);return()=>{stopped=true;clearInterval(timer)}},[open,online,connection])
  if(!open)return null
  return <div className="project-connect-backdrop"><section className="project-share-dialog" role="dialog" aria-modal="true" aria-label="分享工程"><header><div><h2>分享工程</h2><p>发送工程地址，对方用已有账号登录。</p></div><button aria-label="关闭分享面板" onClick={onClose}>×</button></header><div className="project-share-body">
    <section className="project-share-switch"><div><strong>局域网共享</strong><p>{status?.active?'正在分享当前工程，本机可继续编辑。':'开启后提供工程登录地址。'}</p></div><button role="switch" aria-label="局域网共享" aria-checked={status?.active??false} disabled={busy||!online||!status} onClick={()=>void run(()=>request(connection,`/api/share/${status?.active?'disable':'enable'}`,'POST'))}>{status?.active?'已开启':'开启共享'}</button></section>
    {status?.active&&<><section><h3>工程地址</h3><p>账号由本机 Admin 在协作面板的「用户管理」中创建。链接本身不授予权限。</p><div className="project-share-create"><input aria-label="工程分享链接" readOnly value={status.urls[0]??''} onFocus={e=>e.target.select()}/><button onClick={()=>void navigator.clipboard.writeText(status.urls[0]).then(()=>setCopied(true)).catch(()=>setError('请选中链接并复制'))}>{copied?'已复制':'复制链接'}</button></div></section><section className="project-share-network"><h3>连接帮助</h3><p>关闭共享会断开协作者，本机仍可工作。重新开启会优先复用上次端口。</p>{status.firewall.supported&&<><button disabled={busy||status.firewall.phase==='prompting'} onClick={()=>void run(()=>request(connection,'/api/share/firewall','POST'))}>允许防火墙访问（专用网络）</button>{status.firewall.message&&<p>{status.firewall.message}</p>}</>}</section></>}
    {error&&<p role="alert">{error}</p>}</div><footer><span>Admin 不能通过远程地址登录。</span><button onClick={onClose}>完成</button></footer></section></div>
}
