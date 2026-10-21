import { request, ServiceError, type Connection, type Lease, type Snapshot } from '../collab/protocol'
import type { FileChange, ProjectFile, ProjectFileTree } from '../collab/generated'

export type FileEdit = { op: 'write' | 'mkdir' | 'remove' | 'move'; path: string; data?: string | Blob | Uint8Array; destination?: string; version?: string | null; destinationVersion?: string | null }
export function normalizeProjectPath(path: string): string {
  const parts = path.split('/')
  if (!path || parts.some(p => !p || p === '.' || p === '..' || (/[\\:]/.test(p) || [...p].some(c => c.charCodeAt(0) < 32)))) throw new Error('工程路径无效')
  return path
}
function bytesToBase64(bytes: Uint8Array): string {
  let value = ''; for (let i = 0; i < bytes.length; i += 8192) value += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(value)
}
function decode(content: string): Uint8Array { return Uint8Array.from(atob(content), c => c.charCodeAt(0)) }

/** A remote project capability, not an OS directory handle. It cannot open arbitrary local paths. */
export class ProjectClient {
  tree: ProjectFileTree = { revision: 0, entries: [] }
  readonly baseline = new Map<string, string>()
  readonly leases = new Map<string, Lease>()
  readonly texts = new Map<string, string>()
  online = true
  remoteEpoch = 0
  private ownVersions = new Map<string, Map<string | null,string | null>>()
  setStatus(online: boolean, snapshot?: Snapshot) { this.online = online; if(snapshot)this.snapshot=snapshot }
  private expected(path: string, version: string | null): string | null {
    const history=this.ownVersions.get(path); const seen=new Set<string | null>()
    while(history?.has(version) && !seen.has(version)){seen.add(version);version=history.get(version)!}
    return version
  }
  private queue: Promise<unknown> = Promise.resolve()
  onSaved?: (paths: string[]) => void
  readonly connection: Connection
  snapshot: Snapshot
  constructor(connection: Connection, snapshot: Snapshot) { this.connection = connection; this.snapshot = snapshot }
  get writable() { return this.online && this.snapshot.role !== 'viewer' }
  root() { return new ProjectDirectory(this, '') }
  entry(path: string): ProjectFile | undefined { return this.tree.entries.find(e => e.path === path) }
  async refresh(initial = false): Promise<void> {
    this.tree = await request<ProjectFileTree>(this.connection, '/api/files')
    if (initial) { this.baseline.clear(); for (const e of this.tree.entries) this.baseline.set(e.path, e.version) }
  }
  async read(path: string, track = true, expected?: string): Promise<File> {
    normalizeProjectPath(path)
    const result = await request<{ content: string; version: string }>(this.connection, `/api/files/content?path=${encodeURIComponent(path)}${expected ? `&version=${encodeURIComponent(expected)}` : ''}`)
    if (track) this.baseline.set(path, result.version)
    const bytes = decode(result.content)
    return new File([bytes as BlobPart], path.split('/').at(-1)!, { lastModified: 0 })
  }
  async text(path: string, track = true): Promise<string | null> {
    try { const text = await (await this.read(path, track)).text(); if (track) this.texts.set(path, text); return text }
    catch (error) { if (error instanceof ServiceError && error.code === 'not_found') return null; throw error }
  }
  apply(edits: FileEdit[]): Promise<void> {
    const captured=edits.map(e=>({...e,version:e.version===undefined?this.baseline.get(e.path)??null:e.version,destinationVersion:e.destinationVersion===undefined?(e.destination?this.baseline.get(e.destination)??null:null):e.destinationVersion}))
    const run = this.queue.then(() => this.perform(captured))
    this.queue = run.catch(() => undefined)
    return run
  }
  private async perform(edits: FileEdit[]) {
    if (!this.writable) throw new ServiceError(this.online ? 'forbidden' : 'offline', this.online ? '当前主体只有读取权限' : '服务已断开，草稿保留在本窗口')
    const paths = [...new Set(edits.flatMap(e => e.destination ? [e.path, e.destination] : [e.path]))]
    for (const path of paths) normalizeProjectPath(path)
    const acquired = await request<Lease[]>(this.connection, '/api/files/leases', 'POST', { paths })
    for (const l of acquired) this.leases.set(l.resourceId.slice(5), l)
    const changes: FileChange[] = []
    for (const edit of edits) {
      const data = edit.data
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data
      changes.push({ op: edit.op, path: edit.path, version: this.expected(edit.path,edit.version ?? null), leaseId: this.leases.get(edit.path)!.id, content: bytes ? bytesToBase64(bytes) : null, destination: edit.destination ?? null, destinationVersion: edit.destination ? this.expected(edit.destination,edit.destinationVersion ?? null) : null })
    }
    // No retries with a newer version: that would silently overwrite another client's work.
    this.tree = await request<ProjectFileTree>(this.connection, '/api/files/commit', 'POST', { changes })
    for (const edit of edits) {
      const previous=changes.find(c=>c.path===edit.path)!.version
      const current=this.entry(edit.path)?.version??null
      const history=this.ownVersions.get(edit.path)??new Map<string|null,string|null>()
      if(previous!==current)history.set(previous,current)
      if(history.size>512)history.delete(history.keys().next().value!)
      this.ownVersions.set(edit.path,history)
      for (const p of [...this.baseline.keys()]) if (p === edit.path || p.startsWith(`${edit.path}/`) || (edit.destination && (p === edit.destination || p.startsWith(`${edit.destination}/`)))) this.baseline.delete(p)
      for (const e of this.tree.entries) if (e.path === edit.path || e.path.startsWith(`${edit.path}/`) || (edit.destination && (e.path === edit.destination || e.path.startsWith(`${edit.destination}/`)))) this.baseline.set(e.path, e.version)
      if (typeof edit.data === 'string') this.texts.set(edit.path, edit.data)
      if (edit.op === 'remove' || edit.op === 'move') for (const p of [...this.texts.keys()]) if (p === edit.path || p.startsWith(`${edit.path}/`)) this.texts.delete(p)
    }
    // Directory versions include descendants; keep ancestor versions in step with our own writes.
    for (const e of this.tree.entries) if (e.kind === 'directory' && paths.some(p => p.startsWith(`${e.path}/`))) this.baseline.set(e.path, e.version)
    for (const edit of edits.filter(e => e.op !== 'write')) {
      const l = this.leases.get(edit.path)
      if (l) { await request(this.connection, '/api/files/leases', 'DELETE', { path: edit.path, leaseId: l.id }).catch(() => undefined); this.leases.delete(edit.path) }
    }
    this.onSaved?.(paths)
  }
  async release(): Promise<void> {
    const leases = [...this.leases.entries()]
    for (const [path,l] of leases) {
      try { await request(this.connection, '/api/files/leases', 'DELETE', { path, leaseId: l.id }); this.leases.delete(path) }
      catch (e) { if (!(e instanceof ServiceError && e.code === 'locked')) throw e; this.leases.delete(path) }
    }
  }
  async sourceCommand(path: string, destination: string | null, content?: string): Promise<void> {
    const plan = await request<Array<{path: string; destination: string | null}>>(this.connection, `/api/files/source-plan?path=${encodeURIComponent(path)}${destination ? `&destination=${encodeURIComponent(destination)}` : ''}`)
    const edits: FileEdit[] = plan.filter(p => p.path !== p.destination).map(p => ({ op: p.destination ? 'move' : 'remove', path: p.path, destination: p.destination ?? undefined }))
    if (destination && content !== undefined) edits.push({ op: 'write', path: destination, data: content })
    if (edits.length) await this.apply(edits)
  }
}

/** Read-only directory navigation retained by editor adapters. All mutations are explicit S commands. */
export class ProjectDirectory {
  readonly kind = 'directory' as const
  readonly client: ProjectClient
  readonly path: string
  constructor(client: ProjectClient, path: string) { this.client = client; this.path = path }
  get name() { return this.path.split('/').at(-1) || this.client.snapshot.projectName }
  resolve(path: string) { return normalizeProjectPath(this.path ? `${this.path}/${path}` : path) }
  async getDirectoryHandle(name: string): Promise<ProjectDirectory> {
    const path = this.resolve(name)
    if (path !== '.hanshu' && this.client.entry(path)?.kind !== 'directory') throw new ServiceError('not_found', `目录不存在：${path}`)
    return new ProjectDirectory(this.client, path)
  }
  async getFileHandle(name: string) {
    const path = this.resolve(name)
    return { kind: 'file' as const, name: path.split('/').at(-1)!, getFile: () => this.client.read(path) }
  }
  async *entries(): AsyncGenerator<[string, ProjectDirectory | { kind: 'file'; name: string; getFile: () => Promise<File> }]> {
    const prefix = this.path ? `${this.path}/` : ''
    for (const e of this.client.tree.entries) {
      if (!e.path.startsWith(prefix)) continue
      const name = e.path.slice(prefix.length); if (name.includes('/')) continue
      yield [name, e.kind === 'directory' ? new ProjectDirectory(this.client, e.path) : { kind: 'file', name, getFile: () => this.client.read(e.path) }]
    }
    if (!this.path && this.client.tree.entries.some(e => e.path.startsWith('.hanshu/'))) yield ['.hanshu', new ProjectDirectory(this.client, '.hanshu')]
  }
}

let connected: ProjectClient | null = null
let connector: (() => Promise<ProjectClient>) | null = null
export function getProjectClient() { return connected }
export function setProjectClient(client: ProjectClient | null) { connected = client }
export function registerProjectConnector(fn: () => Promise<ProjectClient>) { connector = fn; return () => { if (connector === fn) connector = null } }
export function requestProjectConnection(): Promise<ProjectClient> {
  if (!connector) return Promise.reject(new Error('工程连接窗口尚未就绪'))
  return connector()
}
