import { request, ServiceError, type Connection, type Lease, type Snapshot } from '../collab/protocol'
import type { FileChange, FileTransactionReceipt, ProjectFile, ProjectFileTree } from '../collab/generated'
import { EditTransactions, type SendAttempt } from './editTransactions'
import { assetCacheEpoch } from '../assets/idb'
import { FileEditing, progressEditingPath } from './fileEditing'

export type FileEdit = {
  op: 'write' | 'mkdir' | 'remove' | 'move'; path: string; data?: string | Blob | Uint8Array
  destination?: string; version?: string | null; destinationVersion?: string | null; cacheEpoch?: number
  /** C-only recovery/three-way comparison data; never sent as authority to S. */
  baseData?: string | Blob | Uint8Array; adopt?: boolean
  localContents?: Record<string, string>; localEpochs?: Record<string, number>
}
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
function validateReceipt(value: FileTransactionReceipt | null, id: string): FileTransactionReceipt {
  if (!value || value.transactionId !== id || (value.status !== 'committed' && value.status !== 'rejected') ||
    (value.status === 'committed' && (value.error != null || !value.tree || !Array.isArray(value.tree.entries) || !Number.isSafeInteger(value.tree.revision) || value.tree.revision < 0 || !value.tree.entries.every(e => e && typeof e.path === 'string' && e.path.length > 0 && (e.kind === 'file' || e.kind === 'directory') && typeof e.version === 'string' && e.version.length > 0 && Number.isSafeInteger(e.size) && e.size >= 0))) ||
    (value.status === 'rejected' && (value.tree != null || !value.error || typeof value.error.code !== 'string' || typeof value.error.message !== 'string'))) {
    throw new ServiceError('commit_uncertain', '服务返回的提交结果无效，请重新查询')
  }
  return value
}

/** A remote project capability, not an OS directory handle. It cannot open arbitrary local paths. */
export class ProjectClient {
  tree: ProjectFileTree = { revision: 0, entries: [] }
  readonly baseline = new Map<string, string>()
  readonly leases = new Map<string, Lease>()
  readonly texts = new Map<string, string>()
  readonly assetEpochs = new Map<string, number>()
  readonly originals = new Map<string, { version: string; data: Blob | string }>()
  assetPackageId = ''
  online = true
  remoteEpoch = 0
  private ownVersions = new Map<string, Map<string | null,string | null>>()
  private serverClock = 0
  private serverClockAt = 0
  serverNow = () => this.serverClock + Math.max(0, performance.now() - this.serverClockAt)
  readonly editing: FileEditing
  setStatus(online: boolean, snapshot?: Snapshot) {
    // Presence, HTTP and WebSocket responses can arrive out of order.
    if (snapshot && snapshot.statusVersion < this.snapshot.statusVersion) return false
    const reconnect = online && !this.online
    this.online = online
    if (snapshot) {
      this.snapshot = snapshot
      this.serverClock = snapshot.serverTime ?? Date.now()
      this.serverClockAt = performance.now()
      for (const [path, lease] of this.leases) {
        const current = snapshot.leases.find(item => item.id === lease.id && item.sessionId === snapshot.session.id)
        if (current && current.expiresAt > this.serverNow()) this.leases.set(path, current)
        else this.leases.delete(path)
      }
    }
    this.editing.reconcile(online, this.snapshot)
    if (reconnect) this.editing.publishFocus()
    return true
  }
  private expected(path: string, version: string | null): string | null {
    const history=this.ownVersions.get(path); const seen=new Set<string | null>()
    while(history?.has(version) && !seen.has(version)){seen.add(version);version=history.get(version)!}
    return version
  }
  readonly transactions: EditTransactions
  onSaved?: (paths: string[]) => void
  onCapture?: (edit: FileEdit) => FileEdit
  onCommitted?: (edits: FileEdit[], replayed: boolean) => Promise<void>
  readonly connection: Connection
  snapshot: Snapshot
  constructor(connection: Connection, snapshot: Snapshot) {
    this.connection = connection; this.snapshot = snapshot
    this.serverClock = snapshot.serverTime ?? Date.now(); this.serverClockAt = performance.now()
    this.editing = new FileEditing(this)
    this.transactions = new EditTransactions(edits => this.capture(edits), (edits, attempt) => this.perform(edits, attempt))
    this.transactions.onSettled = replayed => {
      // TextMap reads staged text first. Notify editors only after the exact
      // acknowledged stage has been cleared, or they reload the old draft.
      if (replayed) this.remoteEpoch++
      this.onSaved?.(this.transactions.getSnapshot().transactions.find(t=>t.phase==='submitting')?.paths ?? [])
    }
  }
  get writable() { return this.online && this.snapshot.role !== 'viewer' }
  assertEditingIntent(edits: FileEdit[], uncertain = false) {
    for (const edit of edits) {
      const path = progressEditingPath(edit.path)
      const structural = path && edits.some(item => (item.op === 'move' || item.op === 'remove') && (item.path === path || item.destination === path))
      if (path && edit.op === 'write' && !structural && !this.editing.canEdit(path)) {
        throw new ServiceError(uncertain ? 'commit_uncertain' : 'editing_required', `请先打开 ${path.split('/').at(-1)} 并申请编辑；本窗口的草稿已保留`)
      }
    }
  }
  root() { return new ProjectDirectory(this, '') }
  entry(path: string): ProjectFile | undefined { return this.tree.entries.find(e => e.path === path) }
  async refresh(initial = false): Promise<void> {
    this.tree = await request<ProjectFileTree>(this.connection, '/api/files')
    if (initial) { this.baseline.clear(); for (const e of this.tree.entries) this.baseline.set(e.path, e.version) }
  }
  async read(path: string, track = true, expected?: string): Promise<File> {
    normalizeProjectPath(path)
    const result = await request<{ content: string; version: string }>(this.connection, `/api/files/content?path=${encodeURIComponent(path)}${expected ? `&version=${encodeURIComponent(expected)}` : ''}`)
    if (track && !this.transactions.hasDraft(path)) this.baseline.set(path, result.version)
    const bytes = decode(result.content)
    const file = new File([bytes as BlobPart], path.split('/').at(-1)!, { lastModified: 0 })
    // An untracked conflict inspection must not replace the base of a local draft.
    if (track && !this.transactions.hasDraft(path)) this.originals.set(path, { version: result.version, data: file })
    return file
  }
  async text(path: string, track = true): Promise<string | null> {
    try { const text = await (await this.read(path, track)).text(); if (track && !this.transactions.hasDraft(path)) { this.texts.set(path, text); const version=this.baseline.get(path); if(version)this.originals.set(path,{version,data:text}) }; return text }
    catch (error) { if (error instanceof ServiceError && error.code === 'not_found') return null; throw error }
  }
  private capture(edits: FileEdit[]): FileEdit[] {
    return edits.map(e => {
      const version = this.expected(e.path, e.version === undefined ? this.baseline.get(e.path) ?? null : e.version)
      const original = this.originals.get(e.path)
      const captured = { ...e, data: e.data instanceof Uint8Array ? e.data.slice() : e.data, cacheEpoch: e.cacheEpoch ?? (e.path.startsWith('assets/') ? assetCacheEpoch(this.assetPackageId, e.path) : undefined), version,
        baseData: e.baseData ?? (original?.version === version ? original.data : this.baseline.get(e.path) === version ? this.texts.get(e.path) : undefined),
        destinationVersion: e.destination ? this.expected(e.destination, e.destinationVersion === undefined ? this.baseline.get(e.destination) ?? null : e.destinationVersion) : null }
      return this.onCapture?.(captured) ?? captured
    })
  }
  apply(edits: FileEdit[], label = '资源修改'): Promise<void> {
    const captured = this.capture(edits)
    return this.transactions.submit(label, () => captured)
  }
  async receipt(transactionId: string): Promise<FileTransactionReceipt | null> {
    try { return validateReceipt(await request<FileTransactionReceipt>(this.connection, `/api/files/transactions/${encodeURIComponent(transactionId)}`),transactionId) }
    catch (error) { if (error instanceof ServiceError && error.code === 'not_found') return null; throw error }
  }
  private async perform(edits: FileEdit[], attempt: SendAttempt) {
    let receipt: FileTransactionReceipt | null = null
    if (attempt.uncertain) {
      try { receipt = await this.receipt(attempt.transactionId) }
      catch { throw new ServiceError('commit_uncertain', '暂时无法查询提交结果；原提交保留，可在恢复连接后继续查询') }
      if (!receipt && attempt.queryOnly) throw new ServiceError('commit_uncertain', '服务尚无这次提交的结果。可以重试原提交，仍使用同一提交编号')
    }
    if (receipt?.status === 'rejected') throw new ServiceError(receipt.error!.code, receipt.error!.message)
    if (!receipt) {
      if (!this.writable) throw new ServiceError(attempt.uncertain ? 'commit_uncertain' : this.online ? 'forbidden' : 'offline', this.online ? '当前主体只有读取权限' : '服务已断开，草稿保留在本窗口')
      const mutations = edits
      this.assertEditingIntent(mutations, attempt.uncertain)
      const paths = [...new Set(mutations.flatMap(e => e.destination ? [e.path, e.destination] : [e.path]))]
      for (const path of paths) normalizeProjectPath(path)
      const existing = new Set([...this.leases.values()].map(lease => lease.id))
      const acquired = paths.length ? await request<Lease[]>(this.connection, '/api/files/leases', 'POST', { paths }).catch(error => { if (attempt.uncertain) throw new ServiceError('commit_uncertain', '尚未确认原提交结果，暂时无法取得写权；请继续查询结果'); throw error }) : []
      const acquiredByPath = new Map(acquired.map(lease => [lease.resourceId.slice(5), lease]))
      for (const l of acquired) this.leases.set(l.resourceId.slice(5), l)
      try {
        // An expired/taken-over editor token must not be silently replaced by this
        // transaction's acquire request, even if the resource is free again.
        this.assertEditingIntent(mutations, attempt.uncertain)
        const changes: FileChange[] = []
        for (const edit of mutations) {
          const data = edit.adopt ? undefined : edit.data
          const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data
          const lease = acquiredByPath.get(edit.path)
          if (!lease) throw new ServiceError('locked', '服务没有返回完整的文件写权，请重新申请后重试')
          changes.push({ op: edit.adopt ? 'check' : edit.op, path: edit.path, version: edit.version ?? null, leaseId: lease.id, content: bytes ? bytesToBase64(bytes) : null, destination: edit.destination ?? null, destinationVersion: edit.destinationVersion ?? null })
        }
        // No retries with a newer version: that would silently overwrite another client's work.
        try {
          receipt = validateReceipt(await request<FileTransactionReceipt>(this.connection, '/api/files/commit', 'POST', { transactionId: attempt.transactionId, changes }),attempt.transactionId)
        } catch (error) {
          // Only a definitive protocol rejection can start a new attempt. Network,
          // storage and malformed responses retain identity, even across a reload.
          if (!attempt.uncertain && error instanceof ServiceError && (['unauthorized','forbidden','invalid','busy','transaction_mismatch','transaction_limit'].includes(error.code) || [400,413,415].includes(error.status ?? 0))) throw error
          throw new ServiceError('commit_uncertain', '提交结果待确认：服务可能已经保存。请查询结果，或重试同一提交')
        }
      } finally {
        // A language/binary sidecar must not keep blocking peers after its batch.
        // Editor-owned leases and pre-existing leases belong to separate actions.
        await this.releaseLeases(acquired.filter(lease => !existing.has(lease.id) && !this.editing.retained(lease.id)))
      }
    }
    if (receipt?.status === 'rejected') throw new ServiceError(receipt.error!.code, receipt.error!.message)
    if (receipt && (receipt.status !== 'committed' || !receipt.tree)) throw new ServiceError('commit_uncertain', '服务返回的提交结果无效，请重新查询')
    // Server adoption is a version-checked no-op in the same atomic batch.
    const acknowledged = receipt?.tree ?? this.tree
    // A receipt describes the original acknowledgement, not today's project.
    // In particular its revision can precede later edits or a service restart.
    await this.refresh().catch(() => undefined)
    const paths = [...new Set(edits.flatMap(e => e.destination ? [e.path, e.destination] : [e.path]))]
    for (const edit of edits) {
      const previous=edit.version ?? null
      const current=edit.adopt ? edit.version ?? null : acknowledged.entries.find(e => e.path === edit.path)?.version ?? null
      const history=this.ownVersions.get(edit.path)??new Map<string|null,string|null>()
      if(previous!==current)history.set(previous,current)
      if(history.size>512)history.delete(history.keys().next().value!)
      this.ownVersions.set(edit.path,history)
      for (const p of [...this.baseline.keys()]) if (p === edit.path || p.startsWith(`${edit.path}/`) || (edit.destination && (p === edit.destination || p.startsWith(`${edit.destination}/`)))) this.baseline.delete(p)
      for (const e of acknowledged.entries) if (e.path === edit.path || e.path.startsWith(`${edit.path}/`) || (edit.destination && (e.path === edit.destination || e.path.startsWith(`${edit.destination}/`)))) this.baseline.set(e.path, e.version)
      if (edit.adopt && edit.version) this.baseline.set(edit.path, edit.version)
      if (typeof edit.data === 'string') this.texts.set(edit.path, edit.data)
      if (edit.op === 'remove' || edit.op === 'move') for (const p of [...this.texts.keys()]) if (p === edit.path || p.startsWith(`${edit.path}/`)) this.texts.delete(p)
      if (current && edit.data !== undefined) this.originals.set(edit.path, { version: current, data: typeof edit.data === 'string' || edit.data instanceof Blob ? edit.data : new Blob([edit.data as BlobPart]) })
      else this.originals.delete(edit.path)
    }
    // Directory versions include descendants; keep ancestor versions in step with our own writes.
    for (const e of acknowledged.entries) if (e.kind === 'directory' && paths.some(p => p.startsWith(`${e.path}/`))) this.baseline.set(e.path, e.version)
    for (const edit of edits) {
      if (edit.cacheEpoch !== undefined && edit.op === 'write') this.assetEpochs.set(edit.path, edit.cacheEpoch)
      if (edit.op === 'remove' || edit.op === 'move') this.assetEpochs.delete(edit.path)
    }
    for (const edit of edits.filter(e => e.op !== 'write')) {
      const l = this.leases.get(edit.path)
      if (l) { await request(this.connection, '/api/files/leases', 'DELETE', { path: edit.path, leaseId: l.id }).catch(() => undefined); this.leases.delete(edit.path) }
    }
    try { await this.onCommitted?.(edits, attempt.replayed) }
    catch { throw new ServiceError('commit_uncertain', '服务已保存，本地视图更新未完成；请重试以恢复本地视图') }
  }
  async releaseLeases(leases: Lease[], strict = false): Promise<void> {
    const ids = new Set(leases.map(lease => lease.id))
    for (const [path, current] of this.leases) if (ids.has(current.id)) this.leases.delete(path)
    let failure: unknown
    for (const lease of leases) {
      try { await request(this.connection, '/api/files/leases', 'DELETE', { path: lease.resourceId.slice(5), leaseId: lease.id }) }
      catch (error) { if (!(error instanceof ServiceError && ['locked', 'not_found'].includes(error.code))) failure ??= error }
    }
    if (strict && failure) throw failure
  }
  async release(): Promise<void> {
    if (this.editing.pending) throw new Error('请等待写权申请或释放结束，再释放全部写权')
    if (this.transactions.getSnapshot().queued) throw new Error('请等待当前提交结束，再释放写权')
    this.editing.clear()
    await this.releaseLeases([...this.leases.values()], true)
    this.editing.changed()
  }
  async sourceCommand(path: string, destination: string | null, content?: string): Promise<void> {
    return this.sourceCommands([{path, destination, content}])
  }
  async sourceCommands(commands: Array<{path: string; destination: string | null; content?: string}>): Promise<void> {
    for (const command of commands) this.assertSourceDraftsSaved(command.path)
    const versions = new Map(this.baseline)
    const originals = new Map(this.originals)
    // Freeze C's projection before fetching any plan: editing can continue while
    // that request is in flight, and replay must never treat later input as old.
    const assetSnapshot = this.onCapture?.({ op: 'remove', path: 'assets' })
    const captured = commands.map(command => {
      const source = this.onCapture?.({ op: command.destination ? 'move' : 'remove', path: command.path, destination: command.destination ?? undefined })
      return { ...command, localContents: source?.localContents, localEpochs: source?.localEpochs || assetSnapshot?.localEpochs
        ? { ...assetSnapshot?.localEpochs, ...source?.localEpochs } : undefined }
    })
    const edits: FileEdit[] = []
    for (const {path, destination, content, localContents, localEpochs} of captured) {
      const plan = await request<Array<{path: string; destination: string | null}>>(this.connection, `/api/files/source-plan?path=${encodeURIComponent(path)}${destination ? `&destination=${encodeURIComponent(destination)}` : ''}`)
      edits.push(...plan.filter(p => p.path !== p.destination).map((p): FileEdit => ({ op: p.destination ? 'move' : 'remove', path: p.path, destination: p.destination ?? undefined, version:versions.get(p.path) ?? null, destinationVersion:p.destination ? versions.get(p.destination) ?? null : null, baseData:originals.get(p.path)?.data, localContents, localEpochs })))
      if (destination && content !== undefined) edits.push({op:'write',path:destination,data:content,version:versions.get(destination) ?? null,baseData:originals.get(destination)?.data,localContents,localEpochs})
    }
    if (edits.length) await this.apply(edits, '修改源文件及关联资源')
  }
  /** Structural edits must not strand an unsaved language draft at its old path.
   * This is a UI precondition, not authority; S still derives the actual move plan.
   */
  assertSourceDraftsSaved(path: string) {
    const source = /^src\/[^/]+\/(.+)\.([^./]+)$/.exec(path)
    if (!source) return
    const [, stem, ext] = source
    if (this.transactions.stagedWrites().some(e => {
      const asset = /^assets\/[^/]+\/lang_([^/]+)\/(.+)\.lang$/.exec(e.path)
      return asset && asset[1] === ext && asset[2] === stem
    })) throw new Error('该资源还有未保存的语言修改，请先保存，再改名或删除；草稿保持原状')
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
