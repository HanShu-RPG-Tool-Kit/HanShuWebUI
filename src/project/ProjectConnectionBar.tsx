import { useEffect, useRef, useState } from 'react'
import { request, socketUrl, type Snapshot, type Role } from '../collab/protocol'
import { ProjectClient, getProjectClient, registerProjectConnector, requestProjectConnection, setProjectClient } from './serviceClient'
import { loadServiceProject, refreshServiceProject, refreshProjectManifest } from './projectFs'
import { getProjectSession, setProjectSession, useProjectSession } from './projectSession'
import { setBoundProject } from './bindingBus'
import { emptyWorkspace } from '../workspace'
import './project-connection.css'
import { rememberProjectDraft, restoreProjectDraft } from './drafts'
import { CollaborationWidget } from './CollaborationWidget'
import { registerProjectUi, type ProjectUiAction } from './projectUi'
import { openEditJournal } from './editJournal'
import { attachReconciliation } from './reconcileEdits'
import { LocalProjectPicker } from './LocalProjectPicker'
import { discoverLocalProjectHost, type LocalProjectHost, type LocalProjectConnection } from './localProjects'
import { ProjectSharePanel } from './ProjectSharePanel'
import { ProjectShareJoin } from './ProjectShareJoin'

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
      const workspace = historyRestore || edits.some(edit => edit.op === 'progress-command') ? await refreshed : await refreshed.catch(()=>null)
      if (workspace && getProjectClient() === client) {
        setProjectSession({workspace})
        if (historyRestore) {
          await refreshProjectManifest(client)
          const current = getProjectSession()
          if (getProjectClient() !== client || current.binding?.handle.client !== client) return
          const binding = {...current.binding}
          setProjectSession({binding})
          setBoundProject(binding)
        }
      }
    }
  }
  return loaded
}

export function ProjectConnectionBar() {
  const projectSession = useProjectSession()
  const [client, setClient] = useState<ProjectClient | null>(null)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [online, setOnline] = useState(false)
  const [dialog, setDialog] = useState<'open' | 'create' | 'connect' | null>(null)
  const [shareOpen, setShareOpen] = useState(false)
  const [collabOpen, setCollabOpen] = useState(false)
  const [location, setLocation] = useState<{id:string;path:string}|null>(null)
  const [url, setUrl] = useState(() => localStorage.getItem('hanshu.serverUrl') || defaultUrl())
  const [credential, setCredential] = useState('')
  const [clientName] = useState(() => sessionStorage.getItem('hanshu.windowName') || '浏览器窗口')
  const [projectName, setProjectName] = useState('新工程')
  const [error, setError] = useState('')
  const [connectionError, setConnectionError] = useState<{ client: ProjectClient; message: string } | null>(null)
  const [refreshError, setRefreshError] = useState<{ client: ProjectClient; message: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [localHost, setLocalHost] = useState<LocalProjectHost | null | undefined>(undefined)
  const [localPicker, setLocalPicker] = useState(false)
  const [subjectName, setSubjectName] = useState('')
  const [kind, setKind] = useState('account')
  const [role, setRole] = useState<Role>('editor')
  const [issued, setIssued] = useState('')
  const projectLabel = projectSession.workspace.packages.find(pkg => pkg.id === projectSession.binding?.manifest.id)?.name ?? projectSession.binding?.manifest.name ?? ''
  const pending = useRef<{resolve: (c: ProjectClient) => void; reject: (e: Error) => void} | null>(null)
  const booted = useRef(false)
  const operation = useRef(false)

  async function run(action: () => Promise<void>) {
    if (operation.current) return
    operation.current = true; setBusy(true); setError('')
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { operation.current = false; setBusy(false) }
  }
  async function connect(base: string, key: string, name: string, initialName = projectName) {
    if (getProjectClient()?.transactions.getSnapshot().queued) throw new Error('请等待当前提交结束，再切换工程')
    const login = await request<{token: string}>({url: base,token:''}, '/api/sessions', 'POST', { credential: key.trim(), clientName: name })
    return connectSession(base, login.token, initialName)
  }
  async function connectSession(base: string, token: string, initialName = projectName) {
    const connection = {url:base.replace(/\/$/,''),token}
    let candidate: ProjectClient | null = null
    try {
      if (getProjectClient()?.transactions.getSnapshot().queued) throw new Error('请等待当前提交结束，再切换工程')
      const state = await request<Snapshot>(connection, '/api/project')
      candidate = new ProjectClient(connection,state)
      const previous = getProjectClient()
      if(previous) rememberProjectDraft(getProjectSession().workspace)
      await openClient(candidate,initialName)
      setClient(candidate); setSnapshot(state); setOnline(true)
      localStorage.setItem('hanshu.serverUrl',base); setCredential(''); setDialog(null)
      pending.current?.resolve(candidate); pending.current = null
      if (previous && previous !== candidate) { previous.setStatus(false); void request(previous.connection,'/api/sessions/current','DELETE').catch(() => undefined) }
    } catch (e) { if(candidate)candidate.setStatus(false); void request(connection,'/api/sessions/current','DELETE').catch(() => undefined); throw e }
  }
  useEffect(() => registerProjectConnector(mode => {
    if (pending.current) return Promise.reject(new Error('工程连接窗口已打开'))
    setError(''); setLocalPicker(false); setLocation(null); setDialog(mode)
    return new Promise<ProjectClient>((resolve,reject) => { pending.current = {resolve,reject} })
  }), [])
  useEffect(() => {
    if (!dialog || dialog === 'connect' || '__TAURI_INTERNALS__' in window) return
    let stopped = false
    void discoverLocalProjectHost().then(host => { if (!stopped) setLocalHost(host) })
    return () => { stopped = true }
  }, [dialog])
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
          await refreshProjectManifest(client)
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

  async function closeProject() {
    if (!client) return
    if (client.transactions.getSnapshot().queued) throw new Error('请等待当前保存结束，再关闭工程')
    rememberProjectDraft(getProjectSession().workspace)
    await request(client.connection,'/api/sessions/current','DELETE')
    client.setStatus(false); setProjectClient(null); setClient(null); setSnapshot(null); setOnline(false)
    setBoundProject(null); setProjectSession({binding:null,workspace:emptyWorkspace()})
  }
  function projectAction(action: ProjectUiAction) {
    if (action === 'share') { if (snapshot?.role === 'owner') setShareOpen(true); return }
    if (action === 'collaboration') { setCollabOpen(true); return }
    if (action === 'close') { void run(closeProject); return }
    if (action === 'connect') { setError(''); setLocalPicker(false); setDialog('connect'); return }
    void requestProjectConnection(action).catch(e => { if (!/取消/.test(String(e))) { setError(String(e)); setCollabOpen(true) } })
  }
  useEffect(() => registerProjectUi(projectAction))
  function cancel() { setDialog(null); pending.current?.reject(new Error('已取消连接')); pending.current=null }
  async function nativeOpen(name?: string) {
    if (getProjectClient()?.transactions.getSnapshot().queued) throw new Error('请等待当前保存结束，再切换工程')
    const {invoke}=await import('@tauri-apps/api/core')
    const local=await invoke<{url:string;credential:string}>('project_open_local',{name:name??null})
    setUrl(local.url); await connect(local.url,local.credential,'桌面窗口',name)
  }
  const management = snapshot && client ? (<section className="project-members" aria-label="工程主体与权限">

      <div className="project-presence">{snapshot.sessions.map(s => <span key={s.id}>{snapshot.members.find(m=>m.subject.id===s.subjectId)?.subject.name} · {s.clientName} · {s.filePresence?.activity === 'editing' ? '编辑中' : '查看中'}{s.filePresence ? ` · ${s.filePresence.entryId ? '皮肤条目' : s.filePresence.path === '.hanshu/skinmanager/library.json' ? '皮肤库' : s.filePresence.path.split('/').at(-1)}` : ''}{snapshot.leases.some(l=>l.sessionId===s.id) ? ' · 持有写权' : ''}</span>)}</div>
      {snapshot.leases.filter(l=>l.resourceId.startsWith('file:')).map(l => <div key={l.id}>{l.resourceId.slice(5)} · {snapshot.sessions.find(s=>s.id===l.sessionId)?.clientName}{snapshot.role === 'owner' && l.sessionId !== snapshot.session.id && <button onClick={() => void run(async () => {
        const leases = await request<import('../collab/protocol').Lease[]>(client.connection,'/api/files/leases','POST',{paths:[l.resourceId.slice(5)],force:true});for(const lease of leases)client.leases.set(lease.resourceId.slice(5),lease)
      })}>接管写权</button>}</div>)}
      {snapshot.role === 'owner' && <>
        <div className="project-subject-create"><input aria-label="新主体名称" placeholder="主体名称" value={subjectName} onChange={e=>setSubjectName(e.target.value)}/><input aria-label="主体类型" value={kind} onChange={e=>setKind(e.target.value)}/><select aria-label="新主体权限" value={role} onChange={e=>setRole(e.target.value as Role)}><option value="editor">编辑者</option><option value="viewer">只读</option></select><button disabled={busy || !subjectName.trim()} onClick={()=>void run(async()=>{ const result=await request<{credential:string}>(client.connection,'/api/subjects','POST',{name:subjectName,kind,role});setIssued(result.credential);setSubjectName('') })}>创建主体</button></div>
        {issued && <label>新主体凭证（仅此次显示）<input readOnly value={issued}/><button onClick={()=>setIssued('')}>隐藏</button></label>}
        {snapshot.members.filter(m=>m.role!=='owner').map(m=><div key={m.subject.id}>{m.subject.name} · {m.subject.kind}<select aria-label={`${m.subject.name}权限`} value={m.role} onChange={e=>void run(async()=>{await request(client.connection,`/api/subjects/${m.subject.id}`,'PATCH',{role:e.target.value,enabled:m.subject.enabled})})}><option value="editor">编辑者</option><option value="viewer">只读</option></select><button onClick={()=>void run(async()=>{await request(client.connection,`/api/subjects/${m.subject.id}`,'PATCH',{role:m.role,enabled:!m.subject.enabled})})}>{m.subject.enabled?'停用':'启用'}</button></div>)}
      </>}
    </section>) : null
  const title = dialog === 'create' ? '新建工程' : dialog === 'connect' ? '连接其他服务器' : '打开工程'
  return <>
    <CollaborationWidget client={client} snapshot={snapshot} projectName={projectLabel} open={collabOpen} onOpenChange={setCollabOpen}
      error={error || (connectionError?.client === client ? connectionError?.message ?? '' : '') || (refreshError?.client === client ? refreshError?.message ?? '' : '')}
      management={management} onProjectAction={projectAction} />
    {client && snapshot?.role === 'owner' && <ProjectSharePanel key={client.connection.url} connection={client.connection} online={online} open={shareOpen} onClose={() => setShareOpen(false)} />}
    {!('__TAURI_INTERNALS__' in window) && <ProjectShareJoin onConnect={connectSession} connected={!!client} />}
    {dialog && <div className="project-connect-backdrop"><form className="project-connect-dialog" aria-label={title} onKeyDown={event => {if(event.key==='Escape'&&!busy)cancel()}} onSubmit={event => {
      event.preventDefault()
      if (localPicker || busy) return
      if (dialog === 'connect') void run(() => connect(url,credential,clientName))
      if (dialog === 'create') void run(async () => {
        if (getProjectClient()?.transactions.getSnapshot().queued) throw new Error('请等待当前保存结束，再创建工程')
        if ('__TAURI_INTERNALS__' in window) return nativeOpen(projectName.trim())
        if (!localHost || !location) throw new Error('请先选择保存位置')
        const local = await request<LocalProjectConnection>(localHost.connection,'/api/local/create','POST',{directoryId:location.id,name:projectName.trim(),clientName})
        setUrl(local.url); await connectSession(local.url,local.token,projectName.trim())
      })
    }}>
      <h2>{title}</h2>
      {localPicker && localHost ? <LocalProjectPicker host={localHost} mode={dialog === 'create' ? 'location' : 'open'} opening={busy}
        onCancel={() => {setLocalPicker(false);setError('')}} onOpen={(directoryId,path) => {
          if (dialog === 'create') {setLocation({id:directoryId,path});setLocalPicker(false);return}
          void run(async () => {
            if (getProjectClient()?.transactions.getSnapshot().queued) throw new Error('请等待当前保存结束，再切换工程')
            const local=await request<LocalProjectConnection>(localHost.connection,'/api/local/open','POST',{directoryId,clientName})
            setUrl(local.url);await connectSession(local.url,local.token,local.path.split(/[\\/]/).filter(Boolean).at(-1)||projectName)
          })
        }} /> : dialog === 'create' ? <>
        <p>为工程命名，再选择保存位置。</p>
        <label>工程名称<input autoFocus required aria-label="工程名称" maxLength={100} value={projectName} onChange={event=>setProjectName(event.target.value)} /></label>
        {!('__TAURI_INTERNALS__' in window) && <label>保存位置<div className="project-location"><span>{location?.path || '尚未选择'}</span><button type="button" aria-label="选择位置…" disabled={busy || !localHost} onClick={()=>setLocalPicker(true)}>选择位置…</button></div></label>}
        <small>{'__TAURI_INTERNALS__' in window ? '下一步选择保存位置。' : localHost===undefined ? '正在准备本机目录…' : !localHost ? '请在运行 HanShu 的本机窗口新建工程。' : '会创建独立文件夹，不覆盖已有工程。'}</small>
        <footer><button type="button" disabled={busy} onClick={cancel}>取消</button><button type="submit" disabled={busy || !projectName.trim() || !('__TAURI_INTERNALS__' in window) && !location}>{busy?'正在创建…':'创建工程'}</button></footer>
      </> : dialog === 'connect' ? <>
        <p>连接另一台设备上正在运行的工程服务。有邀请链接时，直接打开链接即可加入。</p>
        <label>服务地址<input autoFocus required aria-label="服务地址" value={url} onChange={event=>setUrl(event.target.value)} placeholder="http://…" /></label>
        <label>访问凭证<input required type="password" autoComplete="off" aria-label="主体凭证" value={credential} onChange={event=>setCredential(event.target.value)} /></label>
        <footer><button type="button" disabled={busy} onClick={cancel}>取消</button><button type="submit" disabled={busy}>{busy?'正在连接…':'连接并打开工程'}</button></footer>
      </> : <>
        <p>选择一个已有的工程文件夹。</p>
        <div className="project-open-choice"><button type="button" aria-label="打开本机工程…" disabled={busy || !('__TAURI_INTERNALS__' in window) && !localHost} onClick={() => void run(async()=>{
          if ('__TAURI_INTERNALS__' in window) return nativeOpen()
          const host=await discoverLocalProjectHost();setLocalHost(host)
          if(host)setLocalPicker(true);else throw new Error('本机服务暂不可用，请启动 HanShu 后重试')
        })}>打开本机工程…<small>{localHost===undefined&&!('__TAURI_INTERNALS__' in window)?'正在准备本机目录…':'浏览并选择工程文件夹'}</small></button></div>
        <button type="button" className="project-open-remote" onClick={()=>setDialog('connect')}>连接其他服务器…</button>
        <footer><button type="button" disabled={busy} onClick={cancel}>取消</button></footer>
      </>}
      {error && <p role="alert">{error}</p>}
    </form></div>}
  </>
}
