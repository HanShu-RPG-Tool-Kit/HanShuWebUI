import { useEffect, useRef, useState } from 'react'
import { request, socketUrl, type Snapshot } from '../collab/protocol'
import { ProjectClient, getProjectClient, registerProjectConnector, requestProjectConnection, setProjectClient } from './serviceClient'
import { loadServiceProject, refreshServiceProject, refreshProjectManifest } from './projectFs'
import { getProjectSession, setProjectSession, useProjectSession } from './projectSession'
import { setBoundProject } from './bindingBus'
import { emptyWorkspace } from '../workspace'
import { defaultHsSeed } from '../hanshu/defaultSeed'
import './project-connection.css'
import { rememberProjectDraft, restoreProjectDraft } from './drafts'
import { CollaborationWidget } from './CollaborationWidget'
import { registerProjectUi, type ProjectUiAction } from './projectUi'
import { openEditJournal } from './editJournal'
import { attachReconciliation } from './reconcileEdits'
import { LocalProjectPicker } from './LocalProjectPicker'
import { discoverLocalProjectHost, resolveLocalDirectory, type LocalProjectHost, type LocalProjectConnection } from './localProjects'
import { ProjectSharePanel } from './ProjectSharePanel'
import { ProjectShareJoin } from './ProjectShareJoin'
import { AccountManager } from './AccountManager'
import { connectionUrl, recentConnections, rememberConnection, removeRecent } from './recentConnections'
import { recentLocalProjects, rememberLocalProject, removeRecentLocal } from './recentLocalProjects'
import {
  clearProjectResume,
  loadProjectResume,
  rememberLocalProjectResume,
  rememberRemoteProjectResume,
} from './projectResume'

const defaultUrl = () => import.meta.env.DEV || window.location.port === '4173' ? '/__project' : window.location.origin

async function openClient(client: ProjectClient, initialName: string) {
  await client.refresh(true)
  await client.transactions.restore(openEditJournal(`${client.snapshot.projectId}:${client.snapshot.session.subjectId}`))
  if (!client.entry('project.json')) {
    if (!client.writable) throw new Error('服务端工程尚未初始化，请由管理者先打开一次。')
    await client.apply([
      { op: 'write', path: 'project.json', data: JSON.stringify({ version: 1, id: client.snapshot.projectId, name: initialName || '新工程' },null,2) },
      { op: 'write', path: 'src/hanshu/未命名剧本.hs', data: defaultHsSeed(initialName || '新工程') },
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
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [recents, setRecents] = useState(recentConnections)
  const [recentLocals, setRecentLocals] = useState(recentLocalProjects)
  const [clientName] = useState(() => sessionStorage.getItem('hanshu.windowName') || '浏览器窗口')
  const [projectName, setProjectName] = useState('新工程')
  const [error, setError] = useState('')
  const [connectionError, setConnectionError] = useState<{ client: ProjectClient; message: string } | null>(null)
  const [refreshError, setRefreshError] = useState<{ client: ProjectClient; message: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [localHost, setLocalHost] = useState<LocalProjectHost | null | undefined>(undefined)
  const [localPicker, setLocalPicker] = useState(false)
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
  async function connectRemote() {
    const base=connectionUrl(url)
    if (getProjectClient()?.transactions.getSnapshot().queued) throw new Error('请等待当前提交结束，再切换工程')
    const login=await request<{token:string}>({url:base,token:''},'/api/sessions','POST',{username:username.trim(),password,clientName})
    setPassword(''); await connectSession(base,login.token)
    const current=getProjectClient()
    if(current){
      const projectName=getProjectSession().binding?.manifest.name??current.snapshot.projectName
      rememberConnection({url:base,username:username.trim(),projectId:current.snapshot.projectId,projectName})
      rememberRemoteProjectResume({
        url:base,
        username:username.trim(),
        projectId:current.snapshot.projectId,
        projectName,
      })
    }
    setRecents(recentConnections())
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
      localStorage.setItem('hanshu.serverUrl',base); setPassword(''); setDialog(null)
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
    if (dialog === 'open') setRecentLocals(recentLocalProjects())
  }, [dialog])
  useEffect(() => {
    if (booted.current) return
    booted.current = true
    // 桌面宿主：沿用启动时本机连接
    if ('__TAURI_INTERNALS__' in window) {
      void run(async () => {
        const {invoke} = await import('@tauri-apps/api/core')
        const local = await invoke<{url:string;token:string;path?:string}>('project_local_connection')
        await connectLocal({ url: local.url, token: local.token, path: local.path || '' })
      })
      return
    }
    // 浏览器：F5 后按上次意图恢复。本机可静默重开；远端不存令牌，只预填登录框。
    const resume = loadProjectResume()
    if (!resume) return
    if (resume.kind === 'local') {
      void run(async () => {
        try {
          await openRecentLocal(resume.path)
        } catch (e) {
          setError(
            e instanceof Error
              ? `自动重连失败：${e.message}`
              : `自动重连失败：${String(e)}`,
          )
          setDialog('open')
          setRecentLocals(recentLocalProjects())
        }
      })
      return
    }
    setUrl(resume.url)
    setUsername(resume.username)
    setPassword('')
    setRecents(recentConnections())
    setDialog('connect')
    setError('页面已刷新，会话令牌未保存在浏览器。请重新输入密码以恢复远端工程连接。')
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
    clearProjectResume()
  }
  function projectAction(action: ProjectUiAction) {
    if (action === 'share') { if (snapshot?.role === 'owner') setShareOpen(true); return }
    if (action === 'collaboration') { setCollabOpen(true); return }
    if (action === 'close') { void run(closeProject); return }
    if (action === 'connect') { setError(''); setLocalPicker(false); setRecents(recentConnections()); setPassword(''); setDialog('connect'); return }
    void requestProjectConnection(action).catch(e => { if (!/取消/.test(String(e))) { setError(String(e)); setCollabOpen(true) } })
  }
  useEffect(() => registerProjectUi(projectAction))
  function cancel() { setPassword('');setDialog(null); pending.current?.reject(new Error('已取消连接')); pending.current=null }
  function rememberOpenedLocal(path: string) {
    const current = getProjectClient()
    if (!current || !path.trim()) return
    const projectName = getProjectSession().binding?.manifest.name ?? current.snapshot.projectName
    rememberLocalProject({
      path,
      projectId: current.snapshot.projectId,
      projectName,
    })
    rememberLocalProjectResume({
      path,
      projectId: current.snapshot.projectId,
      projectName,
    })
    setRecentLocals(recentLocalProjects())
  }
  async function connectLocal(local: LocalProjectConnection, initialName?: string) {
    setUrl(local.url)
    await connectSession(local.url, local.token, initialName ?? (local.path.split(/[\\/]/).filter(Boolean).at(-1) || projectName))
    rememberOpenedLocal(local.path)
  }
  async function nativeOpen(name?: string, path?: string) {
    if (getProjectClient()?.transactions.getSnapshot().queued) throw new Error('请等待当前保存结束，再切换工程')
    const {invoke}=await import('@tauri-apps/api/core')
    const local=await invoke<{url:string;token:string;path?:string}>('project_open_local',{name:name??null,path:path??null})
    await connectLocal({ url: local.url, token: local.token, path: local.path || path || '' }, name)
  }
  async function openRecentLocal(path: string) {
    if (getProjectClient()?.transactions.getSnapshot().queued) throw new Error('请等待当前保存结束，再切换工程')
    if ('__TAURI_INTERNALS__' in window) return nativeOpen(undefined, path)
    const host = await discoverLocalProjectHost()
    setLocalHost(host)
    if (!host) throw new Error('本机服务暂不可用，请启动 HanShu 后重试')
    const directory = await resolveLocalDirectory(host, path)
    const local = await request<LocalProjectConnection>(host.connection, '/api/local/open', 'POST', { directoryId: directory.id, clientName })
    await connectLocal(local)
  }
  const management = client && snapshot?.role === 'owner' ? <AccountManager client={client} /> : null
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
      if (dialog === 'connect') void run(connectRemote)
      if (dialog === 'create') void run(async () => {
        if (getProjectClient()?.transactions.getSnapshot().queued) throw new Error('请等待当前保存结束，再创建工程')
        if ('__TAURI_INTERNALS__' in window) return nativeOpen(projectName.trim())
        if (!localHost || !location) throw new Error('请先选择保存位置')
        const local = await request<LocalProjectConnection>(localHost.connection,'/api/local/create','POST',{directoryId:location.id,name:projectName.trim(),clientName})
        await connectLocal(local, projectName.trim())
      })
    }}>
      <h2>{title}</h2>
      {localPicker && localHost ? <LocalProjectPicker host={localHost} mode={dialog === 'create' ? 'location' : 'open'} opening={busy}
        onCancel={() => {setLocalPicker(false);setError('')}} onOpen={(directoryId,path) => {
          if (dialog === 'create') {setLocation({id:directoryId,path});setLocalPicker(false);return}
          void run(async () => {
            if (getProjectClient()?.transactions.getSnapshot().queued) throw new Error('请等待当前保存结束，再切换工程')
            const local=await request<LocalProjectConnection>(localHost.connection,'/api/local/open','POST',{directoryId,clientName})
            await connectLocal(local)
          })
        }} /> : dialog === 'create' ? <>
        <p>为工程命名，再选择保存位置。</p>
        <label>工程名称<input autoFocus required aria-label="工程名称" maxLength={100} value={projectName} onChange={event=>setProjectName(event.target.value)} /></label>
        {!('__TAURI_INTERNALS__' in window) && <label>保存位置<div className="project-location"><span>{location?.path || '尚未选择'}</span><button type="button" aria-label="选择位置…" disabled={busy || !localHost} onClick={()=>setLocalPicker(true)}>选择位置…</button></div></label>}
        <small>{'__TAURI_INTERNALS__' in window ? '下一步选择保存位置。' : localHost===undefined ? '正在准备本机目录…' : !localHost ? '请在运行 HanShu 的本机窗口新建工程。' : '会创建独立文件夹，不覆盖已有工程。'}</small>
        <footer><button type="button" disabled={busy} onClick={cancel}>取消</button><button type="submit" disabled={busy || !projectName.trim() || !('__TAURI_INTERNALS__' in window) && !location}>{busy?'正在创建…':'创建工程'}</button></footer>
      </> : dialog === 'connect' ? <>
        <p>连接另一台设备上正在运行的工程服务。已有工程链接时，也可以直接打开链接登录。</p>
        {recents.length>0 && <div className="recent-connections" aria-label="最近连接">{recents.map(recent=><div key={recent.url}><button type="button" onClick={()=>{setUrl(recent.url);setUsername(recent.username);setPassword('')}}><strong>{recent.projectName}</strong><small>{recent.url}</small></button><button type="button" aria-label={`移除最近连接 ${recent.projectName}`} onClick={()=>{removeRecent(recent.url);setRecents(recentConnections())}}>×</button></div>)}</div>}
        <label>服务地址<input autoFocus required aria-label="服务地址" value={url} onChange={event=>setUrl(event.target.value)} placeholder="http://…" /></label>
        <label>用户名<input required autoComplete="username" aria-label="用户名" value={username} onChange={event=>setUsername(event.target.value)} /></label>
        <label>密码<input required type="password" autoComplete="current-password" aria-label="密码" value={password} onChange={event=>setPassword(event.target.value)} /></label>
        <footer><button type="button" disabled={busy} onClick={cancel}>取消</button><button type="submit" disabled={busy}>{busy?'正在连接…':'连接并打开工程'}</button></footer>
      </> : <>
        <p>选择一个已有的工程文件夹，或从最近打开的本机工程进入。</p>
        {recentLocals.length > 0 && <div className="recent-connections" aria-label="最近本机工程">{recentLocals.map(recent => <div key={recent.path}><button type="button" disabled={busy} onClick={() => void run(() => openRecentLocal(recent.path))}><strong>{recent.projectName}</strong><small>{recent.path}</small></button><button type="button" aria-label={`移除最近工程 ${recent.projectName}`} disabled={busy} onClick={() => { removeRecentLocal(recent.path); setRecentLocals(recentLocalProjects()) }}>×</button></div>)}</div>}
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
