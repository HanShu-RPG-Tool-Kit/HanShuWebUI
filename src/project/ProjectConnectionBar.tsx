import { useEffect, useRef, useState } from 'react'
import { request, socketUrl, type Snapshot, type Role } from '../collab/protocol'
import { ProjectClient, getProjectClient, registerProjectConnector, requestProjectConnection, setProjectClient } from './serviceClient'
import { loadServiceProject, refreshServiceProject } from './projectFs'
import { getProjectSession, setProjectSession } from './projectSession'
import { setBoundProject } from './bindingBus'
import { emptyWorkspace } from '../workspace'
import './project-connection.css'
import { rememberProjectDraft, restoreProjectDraft } from './drafts'
import { EditTransactionPanel } from './EditTransactionPanel'
import { openEditJournal } from './editJournal'
import { attachReconciliation } from './reconcileEdits'
import { parseManifestJson } from './manifest'

const labels: Record<Role,string> = { owner: '管理者', editor: '编辑者', viewer: '只读' }
const defaultUrl = () => import.meta.env.DEV || window.location.port === '4173' ? '/__project' : window.location.origin

async function openClient(client: ProjectClient, initialName: string) {
  await client.refresh(true)
  await client.transactions.restore(openEditJournal(`${client.snapshot.projectId}:${client.snapshot.session.subjectId}`))
  if (!client.entry('project.json')) {
    if (!client.writable) throw new Error('服务端工程尚未初始化，请由管理者先打开一次。')
    await client.apply([
      { op: 'write', path: 'project.json', data: JSON.stringify({ version: 1, id: client.snapshot.projectId, name: initialName || '新工程' },null,2) },
      { op: 'write', path: 'src/hanshu/未命名剧本.hs', data: `标题：${initialName || '新工程'}\n\n第一场\n\n` },
    ])
    await client.release()
  }
  const loaded = await loadServiceProject(client.root())
  loaded.workspace = await restoreProjectDraft(client,loaded.workspace)
  setProjectClient(client)
  client.onSaved = () => { if (getProjectClient() === client) { rememberProjectDraft(getProjectSession().workspace); setProjectSession({}) } }
  setProjectSession(loaded)
  setBoundProject(loaded.binding)
  attachReconciliation(client)
  const reconcile = client.onCommitted
  client.onCommitted = async (edits,replayed) => {
    await reconcile?.(edits,replayed)
    const live = getProjectSession()
    if (replayed && getProjectClient() === client && live.binding?.handle.client === client) {
      // The immutable receipt may be older than a peer's later edit. Advance
      // only the now-clean resources; subsequent local drafts remain protected.
      const historyRestore = edits.some(edit => edit.op === 'history-restore')
      const refreshed = refreshServiceProject(live.binding,live.workspace)
      const workspace = historyRestore ? await refreshed : await refreshed.catch(()=>null)
      if (workspace && getProjectClient() === client) {
        setProjectSession({workspace})
        if (historyRestore) {
          const entry = client.entry('project.json')
          const raw = entry ? await (await client.read(entry.path, false, entry.version)).text() : null
          const current = getProjectSession()
          if (getProjectClient() !== client || current.binding?.handle.client !== client) return
          const binding = {...current.binding}
          const pkg = current.workspace.packages.find(pkg => pkg.id === binding.manifest.id)
          if (raw && entry && pkg?.name === binding.manifest.name && !client.transactions.hasDraft('project.json')) {
            const manifest = parseManifestJson(raw)
            if (manifest.id !== binding.manifest.id) throw new Error('恢复后的工程清单身份已变化，请重新打开工程')
            binding.manifest = manifest; binding.folderName = manifest.name
            client.baseline.set('project.json', entry.version); client.texts.set('project.json', raw); client.originals.set('project.json', {version: entry.version, data: raw})
            setProjectSession({binding, workspace: {...current.workspace, packages: current.workspace.packages.map(value => value.id === manifest.id ? {...value, name:manifest.name} : value)}})
          } else setProjectSession({binding})
          setBoundProject(binding)
        }
      }
    }
  }
  return loaded
}

export function ProjectConnectionBar() {
  const [client, setClient] = useState<ProjectClient | null>(null)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [online, setOnline] = useState(false)
  const [dialog, setDialog] = useState(false)
  const [manage, setManage] = useState(false)
  const [url, setUrl] = useState(() => localStorage.getItem('hanshu.serverUrl') || defaultUrl())
  const [credential, setCredential] = useState('')
  const [clientName, setClientName] = useState('浏览器窗口')
  const [projectName, setProjectName] = useState('新工程')
  const [error, setError] = useState('')
  const [connectionError, setConnectionError] = useState<{ client: ProjectClient; message: string } | null>(null)
  const [refreshError, setRefreshError] = useState<{ client: ProjectClient; message: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [subjectName, setSubjectName] = useState('')
  const [kind, setKind] = useState('account')
  const [role, setRole] = useState<Role>('editor')
  const [issued, setIssued] = useState('')
  const [projectLabel, setProjectLabel] = useState('')
  const pending = useRef<{resolve: (c: ProjectClient) => void; reject: (e: Error) => void} | null>(null)
  const booted = useRef(false)
  const operation = useRef(false)

  async function run(action: () => Promise<void>) {
    if (operation.current) return
    operation.current = true; setBusy(true); setError('')
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { operation.current = false; setBusy(false) }
  }
  async function connect(base: string, key: string, name: string) {
    if (getProjectClient()?.transactions.getSnapshot().queued) throw new Error('请等待当前提交结束，再切换工程')
    const login = await request<{token: string}>({url: base,token:''}, '/api/sessions', 'POST', { credential: key.trim(), clientName: name })
    const connection = {url:base.replace(/\/$/,''),token:login.token}
    let candidate: ProjectClient | null = null
    try {
      const state = await request<Snapshot>(connection, '/api/project')
      candidate = new ProjectClient(connection,state)
      const previous = getProjectClient()
      if(previous) rememberProjectDraft(getProjectSession().workspace)
      const loaded = await openClient(candidate,projectName)
      setClient(candidate); setSnapshot(state); setOnline(true); setProjectLabel(loaded.binding.manifest.name)
      localStorage.setItem('hanshu.serverUrl',base); setCredential(''); setDialog(false)
      pending.current?.resolve(candidate); pending.current = null
      if (previous && previous !== candidate) { previous.setStatus(false); void request(previous.connection,'/api/sessions/current','DELETE').catch(() => undefined) }
    } catch (e) { if(candidate)candidate.setStatus(false); void request(connection,'/api/sessions/current','DELETE').catch(() => undefined); throw e }
  }
  useEffect(() => registerProjectConnector(() => {
    if (pending.current) return Promise.reject(new Error('工程连接窗口已打开'))
    setError(''); setDialog(true)
    return new Promise<ProjectClient>((resolve,reject) => { pending.current = {resolve,reject} })
  }), [])
  useEffect(() => {
    if (booted.current || !('__TAURI_INTERNALS__' in window)) return
    booted.current = true
    void run(async () => {
      const {invoke} = await import('@tauri-apps/api/core')
      const local = await invoke<{url:string;credential:string}>('project_local_connection')
      setUrl(local.url); await connect(local.url,local.credential,'桌面窗口')
    })
    // The desktop bootstrap intentionally uses the initial connection form defaults once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (!client) return
    return client.transactions.subscribe(() => rememberProjectDraft(getProjectSession().workspace))
  }, [client])
  useEffect(() => {
    if (!client) return
    let stopped = false; let socket: WebSocket | null = null; let retry: ReturnType<typeof setTimeout>
    let lastSeen = performance.now(); let revision = client.tree.revision; let refreshing = false; let wanted = revision
    async function reconcile() {
      if (refreshing || stopped || getProjectClient() !== client) return
      refreshing = true
      try {
        do {
          const live = getProjectSession(); if (live.binding?.handle.client !== client) return
          const previousSkin = client.tree.entries.filter(e => e.path.startsWith('.hanshu/skinmanager/')).map(e => `${e.path}:${e.version}`).join('|')
          const next = await refreshServiceProject(live.binding, live.workspace)
          if (stopped || getProjectClient() !== client) return
          // A user may type during the request: merge remote clean files into the latest local snapshot again on the next event.
          setProjectSession({workspace:next})
          const skin = client.tree.entries.filter(e => e.path.startsWith('.hanshu/skinmanager/')).map(e => `${e.path}:${e.version}`).join('|')
          if (skin !== previousSkin && !client.leases.has('.hanshu/skinmanager/library.json')) {
            const binding = {...live.binding}; setProjectSession({binding}); setBoundProject(binding)
          }
          revision = client.tree.revision
        } while (wanted > revision && !stopped)
        setRefreshError(current => current?.client === client ? null : current)
      } catch (e) { if (!stopped) setRefreshError({ client: client!, message: `工程刷新失败：${String(e)}` }) }
      finally { refreshing = false }
    }
    function receive(state: Snapshot) {
      if (stopped) return
      const accessChanged = !client!.online || client!.snapshot.role !== state.role
      if (!client!.setStatus(true,state)) return
      lastSeen = performance.now(); setOnline(true); setSnapshot(state)
      setConnectionError(current => current?.client === client ? null : current)
      if (accessChanged) setProjectSession({})
      wanted = state.filesRevision
      if (wanted !== revision) void reconcile()
    }
    function watch() {
      if (stopped) return
      socket = new WebSocket(socketUrl(client!.connection.url))
      socket.onopen = () => socket?.send(JSON.stringify({token:client!.connection.token}))
      socket.onmessage = event => { try { const v = JSON.parse(event.data); if (v.type === 'snapshot') receive(v.data) } catch { if (!stopped) setConnectionError({ client: client!, message: '工程状态消息无效' }) } }
      socket.onclose = () => { if (stopped) return; client!.setStatus(false);setOnline(false);retry=setTimeout(watch,3000) }
      socket.onerror = () => { if (stopped) return; client!.setStatus(false);setOnline(false) }
    }
    const heartbeat = async () => {
      const seenWhenSent = lastSeen
      try { receive(await request<Snapshot>(client.connection,'/api/heartbeat','POST',{resourceId:null,fileLeases:[...client.leases.values()].map(l => l.id)})) }
      catch (e) { if (!stopped && lastSeen <= seenWhenSent) { client.setStatus(false);setOnline(false);setConnectionError({ client, message: e instanceof Error ? e.message : String(e) }) } }
    }
    watch(); void heartbeat()
    const timer = setInterval(() => { void heartbeat() },8000)
    const stale = setInterval(() => { if (performance.now()-lastSeen>16000) {client.setStatus(false);setOnline(false)} },1000)
    return () => { stopped=true; clearInterval(timer); clearInterval(stale);clearTimeout(retry);socket?.close() }
  },[client])

  const open = () => { void requestProjectConnection().catch(e => { if (!/取消/.test(String(e))) setError(String(e)) }) }
  function cancel() { setDialog(false); pending.current?.reject(new Error('已取消连接'));pending.current=null }
  return <>
    <div className="project-service-bar" aria-label="当前工程">
      <strong>{client ? projectLabel : '未打开工程'}</strong>
      <span>{client ? `${online ? '● 已连接' : '○ 已断开'} · ${labels[snapshot?.role ?? 'viewer']} · ${snapshot?.members.find(m => m.subject.id === snapshot.session.subjectId)?.subject.name ?? ''}` : '打开服务端工程，所有工作区使用同一份资源'}</span>
      <button onClick={open} disabled={busy}>打开工程…</button>
      {client && <><button onClick={() => void run(() => client.release())} disabled={!online || busy}>释放全部写权</button><button onClick={() => setManage(!manage)}>在线主体与权限 · {snapshot?.sessions.length ?? 0}</button><button onClick={() => void run(async () => {
        if (client.transactions.getSnapshot().queued) throw new Error('请等待当前提交结束，再关闭工程')
        rememberProjectDraft(getProjectSession().workspace)
        await request(client.connection,'/api/sessions/current','DELETE'); client.setStatus(false);setProjectClient(null);setClient(null);setSnapshot(null);setOnline(false);setBoundProject(null);setProjectSession({binding:null,workspace:emptyWorkspace()})
      })}>关闭工程</button></>}
      {error && <span className="project-service-error" role="alert">{error}</span>}
      {connectionError?.client === client && <span className="project-service-error" role="alert">{connectionError.message}</span>}
      {refreshError?.client === client && <span className="project-service-error" role="alert">{refreshError.message}</span>}
    </div>
    {client && <EditTransactionPanel client={client} />}
    {manage && snapshot && client && <section className="project-members" aria-label="工程主体与权限">
      <button onClick={() => setManage(false)}>收起</button>
      <div className="project-presence">{snapshot.sessions.map(s => <span key={s.id}>{snapshot.members.find(m=>m.subject.id===s.subjectId)?.subject.name} · {s.clientName} · {s.filePresence?.activity === 'editing' ? '编辑中' : '查看中'}{s.filePresence ? ` · ${s.filePresence.entryId ? '皮肤条目' : s.filePresence.path === '.hanshu/skinmanager/library.json' ? '皮肤库' : s.filePresence.path.split('/').at(-1)}` : ''}{snapshot.leases.some(l=>l.sessionId===s.id) ? ' · 持有写权' : ''}</span>)}</div>
      {snapshot.leases.filter(l=>l.resourceId.startsWith('file:')).map(l => <div key={l.id}>{l.resourceId.slice(5)} · {snapshot.sessions.find(s=>s.id===l.sessionId)?.clientName}{snapshot.role === 'owner' && l.sessionId !== snapshot.session.id && <button onClick={() => void run(async () => {
        const leases = await request<import('../collab/protocol').Lease[]>(client.connection,'/api/files/leases','POST',{paths:[l.resourceId.slice(5)],force:true});for(const lease of leases)client.leases.set(lease.resourceId.slice(5),lease)
      })}>接管写权</button>}</div>)}
      {snapshot.role === 'owner' && <>
        <div className="project-subject-create"><input aria-label="新主体名称" placeholder="主体名称" value={subjectName} onChange={e=>setSubjectName(e.target.value)}/><input aria-label="主体类型" value={kind} onChange={e=>setKind(e.target.value)}/><select aria-label="新主体权限" value={role} onChange={e=>setRole(e.target.value as Role)}><option value="editor">编辑者</option><option value="viewer">只读</option></select><button disabled={busy || !subjectName.trim()} onClick={()=>void run(async()=>{ const result=await request<{credential:string}>(client.connection,'/api/subjects','POST',{name:subjectName,kind,role});setIssued(result.credential);setSubjectName('') })}>创建主体</button></div>
        {issued && <label>新主体凭证（仅此次显示）<input readOnly value={issued}/><button onClick={()=>setIssued('')}>隐藏</button></label>}
        {snapshot.members.filter(m=>m.role!=='owner').map(m=><div key={m.subject.id}>{m.subject.name} · {m.subject.kind}<select aria-label={`${m.subject.name}权限`} value={m.role} onChange={e=>void run(async()=>{await request(client.connection,`/api/subjects/${m.subject.id}`,'PATCH',{role:e.target.value,enabled:m.subject.enabled})})}><option value="editor">编辑者</option><option value="viewer">只读</option></select><button onClick={()=>void run(async()=>{await request(client.connection,`/api/subjects/${m.subject.id}`,'PATCH',{role:m.role,enabled:!m.subject.enabled})})}>{m.subject.enabled?'停用':'启用'}</button></div>)}
      </>}
    </section>}
    {dialog && <div className="project-connect-backdrop"><form className="project-connect-dialog" aria-label="打开工程" onSubmit={e=>{e.preventDefault();void run(()=>connect(url,credential,clientName))}}>
      <h2>打开工程</h2><p>连接中心服务后，剧本、进度、资产与皮肤使用同一工程。</p>
      {'__TAURI_INTERNALS__' in window && <button type="button" disabled={busy} onClick={()=>void run(async()=>{
        const {invoke}=await import('@tauri-apps/api/core');const local=await invoke<{url:string;credential:string}>('project_open_local');setUrl(local.url);await connect(local.url,local.credential,'桌面窗口')
      })}>由本机服务打开文件夹…</button>}
      <label>服务地址<input required aria-label="服务地址" value={url} onChange={e=>setUrl(e.target.value)}/></label>
      <label>主体凭证<input required type="password" autoComplete="off" aria-label="主体凭证" value={credential} onChange={e=>setCredential(e.target.value)}/></label>
      <label>本端名称<input required aria-label="本端名称" value={clientName} onChange={e=>setClientName(e.target.value)}/></label>
      <label>新工程名称<input aria-label="新工程名称" value={projectName} onChange={e=>setProjectName(e.target.value)}/><small>仅在服务端目录尚无工程清单时使用</small></label>
      {error && <p role="alert">{error}</p>}
      <footer><button type="button" onClick={cancel} disabled={busy}>取消</button><button type="submit" disabled={busy}>{busy?'正在连接…':'连接并打开工程'}</button></footer>
    </form></div>}
  </>
}
