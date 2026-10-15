import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react'
import { ProgressEditor } from '../workspaces/progress/ProgressEditor'
import { createProgress, readProgressSource, stringifyProgress } from '../workspaces/progress/progressDoc'
import { parseGoalDefinitionsFromSource, type GoalDefinitionCatalog } from '../workspaces/progress/goalDefinitions'
import { loadFlowWorkspace } from '../workspaces/progress/storage'
import type { ProgressWorkspaceHandle } from '../workspaces/ProgressFlowWorkspace'
import { request, socketUrl, ServiceError, type Connection, type Lease, type Resource, type ResourceInfo, type Role, type Snapshot, type Subject } from './protocol'
import './collaboration.css'

const SESSION_KEY = 'hanshu.collaboration.session.v1'
const ROLE_LABEL: Record<Role, string> = { owner: '管理者', editor: '编辑者', viewer: '只读' }
const defaultUrl = () => import.meta.env.DEV || window.location.port === '4173' ? '/__project' : window.location.origin
function storedUrl(): string { try { return sessionStorage.getItem(`${SESSION_KEY}:url`) ?? defaultUrl() } catch { return defaultUrl() } }
function download(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function CollaborationWorkspace({ active, workspaceRef }: { active: boolean; workspaceRef?: Ref<ProgressWorkspaceHandle> }) {
  // Credentials and session tokens stay in memory. Duplicate tabs must log in to distinct sessions.
  const [connection, setConnection] = useState<Connection | null>(null)
  const [url, setUrl] = useState(storedUrl)
  const [credential, setCredential] = useState('')
  const [clientName, setClientName] = useState('浏览器窗口')
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [online, setOnline] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<Resource | null>(null)
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const [parentId, setParentId] = useState('')
  const [name, setName] = useState('新建进度.progress')
  const [subjectName, setSubjectName] = useState('')
  const [subjectKind, setSubjectKind] = useState('account')
  const [subjectRole, setSubjectRole] = useState<Role>('editor')
  const [issued, setIssued] = useState('')
  const [definitions, setDefinitions] = useState<Resource[]>([])
  const [localDrafts, setLocalDrafts] = useState(() => loadFlowWorkspace().state.documents.filter(d => d.name.endsWith('.progress')))
  const input = useRef<HTMLInputElement>(null)
  const latest = useRef({ snapshot, selected, loaded, draft, dirty, active, online, connection })
  latest.current = { snapshot, selected, loaded, draft, dirty, active, online, connection }
  const lastEdit = useRef(0)
  const lastTyping = useRef(0)
  const operation = useRef(false)
  const autoConnected = useRef(false)
  const lease = snapshot?.leases.find(l => l.resourceId === selected && l.sessionId === snapshot.session.id)
  const holder = snapshot?.leases.find(l => l.resourceId === selected)
  const canWrite = !!snapshot && snapshot.role !== 'viewer'
  const canEdit = online && canWrite && !!lease && !busy
  const selectedInfo = snapshot?.resources.find(r => r.id === selected)
  const subjectLabel = (sessionId: string) => { const s = snapshot?.sessions.find(s => s.id === sessionId); return `${snapshot?.members.find(m => m.subject.id === s?.subjectId)?.subject.name ?? '其他主体'} · ${s?.clientName ?? '会话'}` }
  const draftKey = useCallback((s: Snapshot, resource: string) => `${SESSION_KEY}:draft:${connection?.url}:${s.projectId}:${s.session.subjectId}:${resource}`, [connection?.url])

  const execute = useCallback(async (action: () => Promise<void>) => {
    if (operation.current) return
    operation.current = true; setBusy(true); setError('')
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : String(e)); if (e instanceof ServiceError && e.code === 'unauthorized') setOnline(false) }
    finally { operation.current = false; setBusy(false) }
  }, [])
  const refresh = useCallback(async () => { if (connection) setSnapshot(await request<Snapshot>(connection, '/api/project')) }, [connection])
  const login = useCallback(async (base: string, key: string, client: string) => {
    const result = await request<{ token: string }>({ url: base, token: '' }, '/api/sessions', 'POST', { credential: key.trim(), clientName: client })
    const next = { url: base.replace(/\/$/, ''), token: result.token }
    sessionStorage.setItem(`${SESSION_KEY}:url`, next.url); setConnection(next); setCredential(''); setSnapshot(null); setSelected(null); setLoaded(null); setDirty(false); setDefinitions([])
  }, [])

  useEffect(() => {
    if (autoConnected.current || connection || !('__TAURI_INTERNALS__' in window)) return
    autoConnected.current = true
    void execute(async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      const local = await invoke<{ url: string; credential: string }>('project_local_connection')
      setUrl(local.url); await login(local.url, local.credential, '桌面窗口')
    })
  }, [connection, execute, login])

  useEffect(() => {
    if (!connection) return
    let stopped = false; let socket: WebSocket | null = null; let reconnect: ReturnType<typeof setTimeout>; let seen = Date.now()
    function connect() {
      if (stopped) return
      socket = new WebSocket(socketUrl(connection!.url))
      socket.onopen = () => socket?.send(JSON.stringify({ token: connection!.token }))
      socket.onmessage = event => {
        try { const value = JSON.parse(event.data); if (stopped || value.type !== 'snapshot' || !value.data?.session) return
          seen = Date.now(); setSnapshot(value.data); setOnline(true)
        } catch { setError('收到无法识别的工程状态') }
      }
      socket.onerror = () => setOnline(false)
      socket.onclose = () => { setOnline(false); if (!stopped) reconnect = setTimeout(connect, 3000) }
    }
    connect()
    const heartbeat = async () => {
      const current = latest.current; const snap = current.snapshot
      const resourceId = current.active && current.selected && snap?.resources.some(r => r.id === current.selected && r.kind !== 'folder') ? current.selected : null
      const held = resourceId ? snap?.leases.find(l => l.resourceId === resourceId && l.sessionId === snap.session.id) : undefined
      try { const next = await request<Snapshot>(connection, '/api/heartbeat', 'POST', { resourceId, leaseId: held?.id, typing: !!held && Date.now() - lastEdit.current < 4000 }); if (!stopped) { setSnapshot(next); seen = Date.now() } }
      catch (e) { if (!stopped) {
        setError(e instanceof Error ? e.message : '连接已中断，本窗口草稿保留')
        if (e instanceof ServiceError && ['locked', 'forbidden'].includes(e.code)) {
          try { const next = await request<Snapshot>(connection, '/api/project'); if (!stopped) { setSnapshot(next); seen = Date.now() } } catch { if (!stopped) setOnline(false) }
        } else setOnline(false)
      } }
    }
    void heartbeat()
    const renew = setInterval(() => { void heartbeat() }, 8000)
    const stale = setInterval(() => { if (Date.now() - seen > 15000) setOnline(false) }, 1000)
    return () => { stopped = true; clearTimeout(reconnect); clearInterval(renew); clearInterval(stale); socket?.close() }
  }, [connection])

  // Send a view/presence update immediately when selection or workspace visibility changes.
  useEffect(() => {
    if (!connection || !snapshot || !online) return
    const resourceId = active && selectedInfo?.kind !== 'folder' ? selectedInfo?.id : null
    let canceled = false
    void request<Snapshot>(connection, '/api/heartbeat', 'POST', { resourceId: resourceId ?? null, leaseId: resourceId ? lease?.id : undefined, typing: false })
      .then(value => { if (!canceled) setSnapshot(value) }).catch(() => { if (!canceled) setOnline(false) })
    return () => { canceled = true }
    // State revisions and lease renewal are handled by the live connection effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, active, selected, online, lease?.id])

  const definitionStamp = snapshot?.resources.filter(r => r.kind === 'goalDefinition').map(r => `${r.id}:${r.revision}`).join('|') ?? ''
  useEffect(() => {
    if (!connection || !snapshot) return
    let canceled = false
    Promise.all(snapshot.resources.filter(r => r.kind === 'goalDefinition').map(r => request<Resource>(connection, `/api/resources/${r.id}`)))
      .then(rows => { if (!canceled) setDefinitions(rows) }).catch(e => setError(String(e)))
    return () => { canceled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, definitionStamp])
  const goalCatalog = useMemo<GoalDefinitionCatalog>(() => {
    const byKind: GoalDefinitionCatalog['byKind'] = new Map(); const errors: GoalDefinitionCatalog['errors'] = []
    for (const resource of definitions) {
      const parsed = parseGoalDefinitionsFromSource(resource.content ?? '', { sourceKey: resource.id, sourceName: resource.name })
      if (!parsed.length) errors.push({ sourceKey: resource.id, sourceName: resource.name, message: '未找到目标定义' })
      for (const def of parsed) { if (byKind.has(def.kind)) errors.push({ sourceKey: resource.id, sourceName: resource.name, message: `目标类型重复：${def.kind}` }); byKind.set(def.kind, def) }
    }
    return { definitions: [...byKind.values()], byKind, errors }
  }, [definitions])

  useEffect(() => {
    if (!connection || !snapshot || !selectedInfo || selectedInfo.kind === 'folder') { if (!selectedInfo || selectedInfo.kind === 'folder') setLoaded(null); return }
    if (loaded?.id === selected && (dirty || loaded.revision === selectedInfo.revision)) return
    let canceled = false
    request<Resource>(connection, `/api/resources/${selected}`).then(resource => {
      if (canceled) return
      let retained: { content: string; revision: number } | null = null
      try { retained = JSON.parse(sessionStorage.getItem(draftKey(snapshot, resource.id)) ?? 'null') } catch { /* preserve malformed local data */ }
      setLoaded(retained && retained.content !== resource.content ? { ...resource, revision: retained.revision } : resource)
      setDraft(retained?.content ?? resource.content ?? ''); setDirty(!!retained && retained.content !== resource.content)
    }).catch(e => setError(String(e)))
    return () => { canceled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, selected, selectedInfo?.revision, selectedInfo?.kind, dirty, draftKey])

  function change(content: string) {
    if (!canEdit || !loaded || !snapshot) return
    setDraft(content); setDirty(content !== loaded.content); lastEdit.current = Date.now()
    try { sessionStorage.setItem(draftKey(snapshot, loaded.id), JSON.stringify({ content, revision: loaded.revision })) } catch { setError('本窗口草稿备份失败，请及时下载草稿') }
    if (connection && lease && Date.now() - lastTyping.current > 1500) {
      lastTyping.current = Date.now()
      void request<Snapshot>(connection, '/api/heartbeat', 'POST', { resourceId: loaded.id, leaseId: lease.id, typing: true })
        .then(value => { if (latest.current.connection === connection) setSnapshot(value) }).catch(() => { if (latest.current.connection === connection) void refresh().catch(() => setOnline(false)) })
    }
  }
  const save = useCallback(() => execute(async () => {
    const current = latest.current; if (!connection || !current.loaded || !current.snapshot || !current.online) return
    const held = current.snapshot.leases.find(l => l.resourceId === current.loaded!.id && l.sessionId === current.snapshot!.session.id)
    if (!held) throw new Error('请先取得写权，本地草稿已保留')
    const sent = current.draft
    const result = await request<Resource>(connection, `/api/resources/${current.loaded.id}`, 'PUT', { leaseId: held.id, revision: current.loaded.revision, content: sent })
    if (latest.current.selected === result.id) { setLoaded(result); if (latest.current.draft === sent) { setDirty(false); sessionStorage.removeItem(draftKey(current.snapshot, result.id)) } }
    setNotice('已保存到工程服务'); await refresh()
  }), [connection, draftKey, execute, refresh])
  useImperativeHandle(workspaceRef, () => ({ handleMenuAction(item) { if (item === '保存') void save(); else if (item === '打开工程…') setNotice('在上方输入服务地址和主体凭证连接工程'); else setNotice('此操作请使用共享工程内的资源工具') } }), [save])
  useEffect(() => {
    if (!active) return
    const key = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.code === 'KeyS') { event.preventDefault(); void save() } }
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('keydown', key) }
  }, [active, save])
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => { if (latest.current.dirty) event.preventDefault() }
    window.addEventListener('beforeunload', unload)
    return () => window.removeEventListener('beforeunload', unload)
  }, [])

  const parsed = useMemo(() => loaded?.kind === 'progress' ? readProgressSource(draft) : { doc: null, error: '' }, [draft, loaded?.kind])
  function select(resource: ResourceInfo) { setSelected(resource.id); setParentId(resource.kind === 'folder' ? resource.id : resource.parentId ?? ''); setName(resource.name); setLoaded(null); setDraft(''); setDirty(false) }
  async function create(kind: ResourceInfo['kind'], content?: string, filename?: string) {
    if (!connection) return
    const resource = await request<Resource>(connection, '/api/resources', 'POST', { parentId: parentId || null, name: filename ?? name, kind, content: kind === 'progress' ? content ?? stringifyProgress(createProgress()) : content })
    await refresh(); setSelected(resource.id); setLoaded(resource.kind === 'folder' ? null : resource); setDraft(resource.content ?? ''); setDirty(false); setName(resource.name)
    if (resource.kind !== 'folder') { await request<Lease>(connection, `/api/resources/${resource.id}/lease`, 'POST', { force: false }); await refresh() }
  }
  const ordered: { resource: ResourceInfo; depth: number }[] = []
  function walk(parent: string | null, depth: number) { for (const resource of (snapshot?.resources ?? []).filter(r => r.parentId === parent).sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1)) { ordered.push({ resource, depth }); if (resource.kind === 'folder') walk(resource.id, depth + 1) } }
  walk(null, 0)

  return <section className="collaboration-workspace" aria-label="共享工程">
    <form className="collab-connection" onSubmit={event => { event.preventDefault(); void execute(() => login(url, credential, clientName)) }}>
      <label>服务地址<input aria-label="服务地址" value={url} onChange={event => setUrl(event.target.value)} placeholder="http://服务器:47831" /></label>
      <label>主体凭证<input aria-label="主体凭证" type="password" value={credential} onChange={event => setCredential(event.target.value)} autoComplete="off" /></label>
      <label>本端名称<input aria-label="本端名称" value={clientName} onChange={event => setClientName(event.target.value)} /></label>
      <button disabled={busy || !credential.trim()}>以此凭证连接</button>
      {connection && <button type="button" disabled={busy} onClick={() => void execute(async () => { try { await request(connection, '/api/sessions/current', 'DELETE') } finally { sessionStorage.removeItem(SESSION_KEY); setConnection(null); setSnapshot(null); setOnline(false); setLoaded(null) } })}>断开</button>}
      <span role="status">{online ? '● 已连接' : connection ? '○ 连接中／离线' : '○ 未连接'}</span>
    </form>
    {(error || notice) && <div className={`collab-notice ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'}>{error || notice}<button onClick={() => { setError(''); setNotice('') }} aria-label="关闭提示">×</button></div>}
    {!snapshot ? <div className="collab-welcome"><h2>连接工程服务</h2><p>输入服务地址和主体凭证。每个窗口会建立独立会话，工程管理者可以创建编辑者或只读主体。</p><p>Web 调试的管理者凭证位于服务目录的 owner-key 文件；桌面版会自动连接内置服务。</p></div> : <>
      <div className="collab-project-line"><strong>{snapshot.projectName}</strong><span>{snapshot.members.find(m => m.subject.id === snapshot.session.subjectId)?.subject.name} · {ROLE_LABEL[snapshot.role]}</span><span>{snapshot.sessions.length} 个在线会话</span></div>
      <div className="collab-body">
        <aside className="collab-resources">
          <strong>工程资源</strong>
          <div className="collab-resource-list">{ordered.map(({ resource, depth }) => <button key={resource.id} disabled={busy} className={selected === resource.id ? 'is-selected' : ''} style={{ paddingLeft: 10 + depth * 14 }} onClick={() => select(resource)}>{resource.kind === 'folder' ? '▸' : resource.kind === 'progress' ? '◇' : 'ƒ'} {resource.name}</button>)}{!ordered.length && <p>导入或新建一份进度。</p>}</div>
          <div className="collab-resource-tools">
            <label>所在目录<select value={parentId} onChange={event => setParentId(event.target.value)}><option value="">工程根</option>{snapshot.resources.filter(r => r.kind === 'folder').map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
            <label>资源名称<input aria-label="资源名称" value={name} onChange={event => setName(event.target.value)} /></label>
            <div><button disabled={!online || !canWrite || busy} onClick={() => void execute(() => create('progress'))}>新建进度</button><button disabled={!online || !canWrite || busy} onClick={() => void execute(() => create('folder'))}>新建文件夹</button></div>
            <button disabled={!online || !canWrite || busy} onClick={() => input.current?.click()}>导入 .progress / 目标定义 .py</button>
            <input ref={input} hidden type="file" accept=".progress,.py" onChange={event => { const file = event.target.files?.[0]; if (file) void execute(async () => create(file.name.endsWith('.py') ? 'goalDefinition' : 'progress', await file.text(), file.name)); event.target.value = '' }} />
            <details onToggle={event => { if (event.currentTarget.open) setLocalDrafts(loadFlowWorkspace().state.documents.filter(d => d.name.endsWith('.progress'))) }}><summary>从本机草稿导入</summary>{localDrafts.map(d => <button disabled={!online || !canWrite || busy} key={d.key} onClick={() => void execute(() => create('progress', d.source, d.name))}>{d.name}</button>)}</details>
            {selectedInfo && <div><button disabled={!online || !canWrite || busy || (selectedInfo.kind !== 'folder' && !lease)} onClick={() => void execute(async () => { const r = await request<Resource>(connection!, `/api/resources/${selectedInfo.id}`, 'PATCH', { leaseId: lease?.id, revision: selectedInfo.revision, parentId: parentId || null, name }); if (loaded?.id === r.id) setLoaded(r); await refresh() })}>改名／移动</button><button disabled={!online || !canWrite || busy || (selectedInfo.kind !== 'folder' && !lease)} onClick={() => { if (window.confirm(`删除 ${selectedInfo.name}？`)) void execute(async () => { await request(connection!, `/api/resources/${selectedInfo.id}`, 'DELETE', { leaseId: lease?.id, revision: selectedInfo.revision }); setSelected(null); setDirty(false); await refresh() }) }}>删除</button></div>}
          </div>
          <details className="collab-members"><summary>主体与权限</summary>{snapshot.members.map(member => <div key={member.subject.id}><strong>{member.subject.name}</strong><small>{member.subject.kind} · {ROLE_LABEL[member.role]}{member.subject.enabled ? '' : ' · 已停用'}</small>{snapshot.role === 'owner' && member.role !== 'owner' && <><select aria-label={`${member.subject.name}的权限`} value={member.role} disabled={busy} onChange={event => void execute(async () => { await request(connection!, `/api/subjects/${member.subject.id}`, 'PATCH', { role: event.target.value, enabled: member.subject.enabled }); await refresh() })}><option value="editor">编辑者</option><option value="viewer">只读</option></select><button disabled={busy} onClick={() => void execute(async () => { await request(connection!, `/api/subjects/${member.subject.id}`, 'PATCH', { role: member.role, enabled: !member.subject.enabled }); await refresh() })}>{member.subject.enabled ? '停用' : '启用'}</button></>}</div>)}
            {snapshot.role === 'owner' && <form onSubmit={event => { event.preventDefault(); void execute(async () => { const result = await request<{ subject: Subject; credential: string }>(connection!, '/api/subjects', 'POST', { name: subjectName, kind: subjectKind, role: subjectRole }); setIssued(`${result.subject.name}：${result.credential}`); setSubjectName(''); await refresh() }) }}><label>新主体名称<input aria-label="新主体名称" required value={subjectName} onChange={event => setSubjectName(event.target.value)} /></label><label>主体种类<input value={subjectKind} onChange={event => setSubjectKind(event.target.value)} placeholder="account / agent / service" /></label><select value={subjectRole} onChange={event => setSubjectRole(event.target.value as Role)}><option value="editor">编辑者</option><option value="viewer">只读</option></select><button disabled={!online || busy}>创建主体与凭证</button></form>}
            {issued && <div className="collab-issued"><p>凭证仅在创建时返回，请交给对应主体。</p><textarea aria-label="新主体凭证" readOnly value={issued} /><button onClick={() => setIssued('')}>关闭凭证</button></div>}
          </details>
        </aside>
        <main className="collab-editor">
          {loaded && selectedInfo ? <>
            <div className="collab-document-bar"><strong>{selectedInfo.name}</strong><span>版本 {loaded.revision}{dirty ? ' · 本窗口有草稿' : ''}</span><span>{holder ? `写权：${subjectLabel(holder.sessionId)}` : '可申请写权'}</span>
              {!lease && <button disabled={!online || !canWrite || busy || !!holder} onClick={() => void execute(async () => { await request(connection!, `/api/resources/${loaded.id}/lease`, 'POST', { force: false }); await refresh() })}>申请写权</button>}
              {holder && !lease && snapshot.role === 'owner' && <button disabled={!online || busy} onClick={() => void execute(async () => { await request(connection!, `/api/resources/${loaded.id}/lease`, 'POST', { force: true }); await refresh() })}>接管写权</button>}
              {lease && <button disabled={!online || busy} onClick={() => void execute(async () => { await request(connection!, `/api/resources/${loaded.id}/lease`, 'DELETE', { leaseId: lease.id }); await refresh() })}>释放写权</button>}
              <button disabled={!canEdit || !dirty} onClick={() => void save()}>保存</button><button onClick={() => download(selectedInfo.name, draft)}>下载{dirty ? '草稿' : '文件'}</button>
              {dirty && <button disabled={!online || busy} onClick={() => void execute(async () => { const r = await request<Resource>(connection!, `/api/resources/${loaded.id}`); sessionStorage.removeItem(draftKey(snapshot, r.id)); setLoaded(r); setDraft(r.content ?? ''); setDirty(false) })}>放弃草稿并读取最新版</button>}
            </div>
            <div className="collab-presence">{snapshot.sessions.filter(s => s.resourceId === selected).map(s => <span key={s.id}>{subjectLabel(s.id)} · {s.activity === 'typing' ? '正在输入' : s.activity === 'editing' ? '持有写权' : '正在查看'}</span>)}</div>
            {dirty && selectedInfo.revision !== loaded.revision && <p className="collab-notice is-error">远端已有新版本，本窗口草稿保留。可先下载草稿，再读取最新版。</p>}
            {loaded.kind === 'progress' && parsed.doc ? <ProgressEditor key={loaded.id} doc={parsed.doc} goalCatalog={goalCatalog} disabled={!canEdit} onChange={change} /> : <div className="collab-source"><p>{parsed.error || '目标定义脚本仅作声明解析，不会在工程服务中执行。'}</p><textarea aria-label="文档源码" spellCheck={false} readOnly={!canEdit} value={draft} onChange={event => change(event.target.value)} /></div>}
          </> : <div className="collab-welcome"><h2>{selectedInfo?.kind === 'folder' ? selectedInfo.name : '共享进度工程'}</h2><p>选择一份进度查看。申请写权后可编辑，保存会更新其他客户端。</p><p>需要目标类型时，将定义脚本导入此工程，所有客户端会读取同一份定义。</p></div>}
        </main>
      </div>
    </>}
  </section>
}
