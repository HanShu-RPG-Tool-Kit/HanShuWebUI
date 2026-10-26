import {ResourceLifecycle} from './resourceLifecycle'
import {EXPLORER_ORGANIZATION_PATH,parseOrganization,serializeOrganization,relocateOrganization} from './explorerOrganization'
import { request, ServiceError, type Connection, type Lease, type Snapshot } from '../collab/protocol'
import type { FileChange, FileEditAuthority, FileOperationRequest, FileTransactionReceipt, ProjectFile, ProjectFileTree, ResourceOperationPlan, ResourceRelations, HistoryRestorePlan, ProgressCommand, ProgressCommandResult } from '../collab/generated'
import { EditTransactions, type SendAttempt } from './editTransactions'
import { assetCacheEpoch } from '../assets/idb'
import { FileEditing } from './fileEditing'
export type { ProgressCommand, ProgressCommandResult } from '../collab/generated'
export type ProgressAcknowledgement = { transactionId: string; result: ProgressCommandResult }

export type FileEdit = {
  op: 'write' | 'mkdir' | 'remove' | 'move' | 'skin-entry-patch' | 'skin-library-command' | 'history-restore' | 'progress-command'; path: string; data?: string | Blob | Uint8Array
  destination?: string; version?: string | null; destinationVersion?: string | null; cacheEpoch?: number
  /** C-only recovery/three-way comparison data; never sent as authority to S. */
  baseData?: string | Blob | Uint8Array; adopt?: boolean
  localContents?: Record<string, string>; localEpochs?: Record<string, number>
  /** Frozen preview scope, used for C draft/recovery boundaries; S derives it independently. */
  affectedPaths?: string[]
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

// Quarantine is evidence of an unresolved original outcome, never permission to
// retry with a new identity. Preserve the administrator's actionable diagnosis.
function uncertainResult(error: unknown, fallback: string): ServiceError {
  return new ServiceError('commit_uncertain', error instanceof ServiceError && error.code === 'receipt_quarantined'
    ? `${error.message}；原提交与草稿已保留，请联系本机管理员检查事务归档。不要换编号重新提交。`
    : fallback)
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
  discardEpoch = 0
  readonly discardVersions = new Map<string, number>()
  readonly syncParticipants = new Map<string, () => Promise<void>>()
  registerSyncParticipant(key: string, sync: () => Promise<void>) {
    this.syncParticipants.set(key, sync)
    return () => { if (this.syncParticipants.get(key) === sync) this.syncParticipants.delete(key) }
  }
  private ownVersions = new Map<string, Map<string | null,string | null>>()
  private entryResults = new Map<string, unknown>()
  private libraryResults = new Map<string, Record<string, unknown>>()
  private importResults = new Map<string, unknown>()
  private progressResults = new Map<string, ProgressAcknowledgement>()
  readonly resourceLifecycle=new ResourceLifecycle()
  private progressEditors = new Map<string, Set<() => Promise<void>>>()
  skinLibraryResult(command: string) { return this.libraryResults.get(command) }
  skinImportResult(entryId: string): unknown { return this.importResults.get(entryId) }
  private entryAcknowledgements = new Map<string, { command: string; requestId: string; entry: unknown }>()
  /** Exact acknowledged command result, including when the original response was lost. */
  skinEntryResult(command: string): unknown { return this.entryResults.get(command) }
  skinEntryAcknowledgement(entryId: string) { return this.entryAcknowledgements.get(entryId) }
  private authorities = new Map<string, FileEditAuthority>()
  private authorityRevision = -1
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
    this.transactions.subscribe(()=>this.resourceLifecycle.settle(this.transactions.getSnapshot().transactions))
    this.transactions.onSettled = replayed => {
      // TextMap reads staged text first. Notify editors only after the exact
      // acknowledged stage has been cleared, or they reload the old draft.
      if (replayed) this.remoteEpoch++
      this.onSaved?.(this.transactions.getSnapshot().transactions.find(t=>t.phase==='submitting')?.paths ?? [])
    }
  }
  get writable() { return this.online && this.snapshot.role !== 'viewer' }
  /** This cache only decorates C's view. Every submission obtains a fresh S plan. */
  editingAuthority(path: string) { return this.authorities.get(path)?.authorityPath }
  async planOperations(operations: FileOperationRequest[]): Promise<ResourceOperationPlan> {
    if (!operations.length) return { revision: this.tree.revision, operations: [], leasePaths: [], authorities: [], relations: [] }
    const plan = await request<ResourceOperationPlan>(this.connection, '/api/files/plan', 'POST', { operations })
    if (plan.revision >= this.authorityRevision) {
      if (plan.revision > this.authorityRevision) this.authorities.clear()
      this.authorityRevision = plan.revision
      for (const authority of plan.authorities) this.authorities.set(authority.path, authority)
    }
    return plan
  }
  resourceRelations(path: string): Promise<ResourceRelations> {
    return request(this.connection, `/api/files/relations?path=${encodeURIComponent(path)}`)
  }
  async assertEditingIntent(edits: FileEdit[], _uncertain = false) {
    if (edits.length === 1 && ['history-restore', 'progress-command'].includes(edits[0].op)) return { revision: this.tree.revision, operations: [], leasePaths: [], authorities: [], relations: [] }
    const plan = await this.planOperations(edits.map(edit => ({ op: edit.adopt ? 'check' : edit.op, path: edit.path, destination: edit.destination ?? null })))
    return plan
  }
  root() { return new ProjectDirectory(this, '') }
  entry(path: string): ProjectFile | undefined { return this.tree.entries.find(e => e.path === path) }
  async refresh(initial = false): Promise<void> {
    this.tree = await request<ProjectFileTree>(this.connection, '/api/files')
    if (initial) { this.baseline.clear(); for (const e of this.tree.entries) this.baseline.set(e.path, e.version) }
  }
  async read(path: string, track = true, expected?: string): Promise<File> {
    return (await this.readSnapshot(path, track, expected)).file
  }
  /** Return content together with its version; consumers must bind both to the same snapshot. */
  async readSnapshot(path: string, track = true, expected?: string): Promise<{ file: File; version: string }> {
    normalizeProjectPath(path)
    const result = await request<{ content: string; version: string }>(this.connection, `/api/files/content?path=${encodeURIComponent(path)}${expected ? `&version=${encodeURIComponent(expected)}` : ''}`)
    if (track && !this.transactions.hasDraft(path)) this.baseline.set(path, result.version)
    const bytes = decode(result.content)
    const file = new File([bytes as BlobPart], path.split('/').at(-1)!, { lastModified: 0 })
    // An untracked conflict inspection must not replace the base of a local draft.
    if (track && !this.transactions.hasDraft(path)) this.originals.set(path, { version: result.version, data: file })
    return { file, version: result.version }
  }
  async text(path: string, track = true): Promise<string | null> {
    try { const text = await (await this.read(path, track)).text(); if (track && !this.transactions.hasDraft(path)) { this.texts.set(path, text); const version=this.baseline.get(path); if(version)this.originals.set(path,{version,data:text}) }; return text }
    catch (error) { if (error instanceof ServiceError && error.code === 'not_found') return null; throw error }
  }
  private capture(edits: FileEdit[]): FileEdit[] {
    return edits.map(e => {
      if (e.op === 'history-restore' || e.op === 'progress-command') return { ...e, affectedPaths: [...(e.affectedPaths ?? [])] }
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
  captureEdits(edits: FileEdit[]): FileEdit[] { return this.capture(edits) }
  private progressEdit(path: string, command: ProgressCommand): FileEdit {
    normalizeProjectPath(path)
    // C's conservative recovery scope only. S independently derives the exact
    // resources from the command and its archived receipt.
    const stem = path.replace(/^src\/quest\//, '').replace(/\.quest$/i, '')
    const languages = command.command === 'apply'
      ? command.changes.flatMap(effect => effect.target.kind === 'locale' ? [`assets/${effect.target.locale}/lang_quest/${stem}.lang`] : [])
      : this.tree.entries.filter(entry => entry.path.startsWith('assets/') && entry.path.endsWith(`/lang_quest/${stem}.lang`)).map(entry => entry.path)
    return { op: 'progress-command', path, data: JSON.stringify(command), version: null, affectedPaths: [...new Set([path, ...languages])] }
  }
  async submitProgress(path: string, command: ProgressCommand, label: string): Promise<ProgressAcknowledgement> {
    const edit = this.progressEdit(path, command)
    // submit publishes its local ID synchronously, before the first await.
    const completion = this.transactions.submit(label, () => [edit])
    const requestId = this.transactions.getSnapshot().transactions.at(-1)!.requestId
    await completion
    const ack = this.progressAcknowledgement(requestId)
    if (!ack) throw new ServiceError('commit_uncertain', '服务没有返回进度操作结果，请查询原提交')
    return ack
  }
  progressAcknowledgement(requestId: string): ProgressAcknowledgement | undefined { return this.progressResults.get(requestId) }
  private rememberProgress(receipt: FileTransactionReceipt, path?: string): ProgressAcknowledgement {
    const result = receipt.progressResult
    if (receipt.status === 'rejected') throw new ServiceError(receipt.error!.code, receipt.error!.message)
    if (!result || (path && result.path !== path) || typeof result.path !== 'string' || typeof result.documentId !== 'string' || typeof result.source !== 'string' || !Array.isArray(result.effects) || !Array.isArray(result.languages) || !result.languages.every(language => typeof language.path === 'string' && (language.content === null || typeof language.content === 'string'))) {
      throw new ServiceError('commit_uncertain', '服务返回的进度操作结果不完整，请查询原提交')
    }
    const ack = { transactionId: receipt.transactionId, result }
    this.progressResults.set(receipt.transactionId, ack)
    if (this.progressResults.size > 512) this.progressResults.delete(this.progressResults.keys().next().value!)
    return ack
  }
  async loadProgressAcknowledgement(requestId: string): Promise<ProgressAcknowledgement | null> {
    const receipt = await this.receipt(requestId)
    return receipt ? this.rememberProgress(receipt) : null
  }
  recoverProgress(path: string, command: ProgressCommand, requestId: string, label: string): Promise<number> {
    return this.transactions.recoverSubmission(label, [this.progressEdit(path, command)], requestId)
  }
  registerProgressEditor(path: string, flush: () => Promise<void>): () => void {
    const editors = this.progressEditors.get(path) ?? new Set()
    editors.add(flush); this.progressEditors.set(path, editors)
    return () => { editors.delete(flush); if (!editors.size) this.progressEditors.delete(path) }
  }
  async flushProgressEdits(path?: string): Promise<void> {
    const editors = path ? [...(this.progressEditors.get(path) ?? [])] : [...this.progressEditors.values()].flatMap(set => [...set])
    for (const flush of editors) await flush()
  }
  async readProgressState(path: string, languagePaths: string[]): Promise<{ source: string; languages: Record<string, string | null>; versions: Record<string, string | null>; revision: number }> {
    const paths = [...new Set([path, ...languagePaths])]
    paths.forEach(normalizeProjectPath)
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await request<ProjectFileTree>(this.connection, '/api/files')
      const versions = Object.fromEntries(paths.map(path => [path, before.entries.find(entry => entry.path === path && entry.kind === 'file')?.version ?? null]))
      if (!versions[path]) throw new ServiceError('not_found', '进度文档已不存在；本地输入仍保留')
      let contents: Array<readonly [string, string | null]>
      try { contents = await Promise.all(paths.map(async path => [path, versions[path] ? await (await this.readSnapshot(path, false, versions[path]!)).file.text() : null] as const)) }
      catch (error) { if (error instanceof ServiceError && ['conflict', 'not_found'].includes(error.code)) continue; throw error }
      const after = await request<ProjectFileTree>(this.connection, '/api/files')
      if (paths.some(path => (after.entries.find(entry => entry.path === path && entry.kind === 'file')?.version ?? null) !== versions[path])) continue
      const content = Object.fromEntries(contents)
      return { source: content[path]!, languages: Object.fromEntries(languagePaths.map(path => [path, content[path]])), versions, revision: after.revision }
    }
    throw new ServiceError('conflict', '读取期间进度持续变化，请稍后重试；本地输入保留')
  }
  private async performProgress(edits: FileEdit[], attempt: SendAttempt): Promise<void> {
    const edit = edits[0]
    if (edits.length !== 1 || edit.op !== 'progress-command' || typeof edit.data !== 'string') throw new ServiceError('invalid', '进度操作不能和其他文件操作混合')
    let receipt: FileTransactionReceipt | null = null
    if (attempt.uncertain) {
      try { receipt = await this.receipt(attempt.transactionId) }
      catch (error) { throw uncertainResult(error, '暂时无法查询进度操作结果；原请求已保留') }
      if (!receipt && attempt.queryOnly) throw new ServiceError('commit_uncertain', '服务暂无进度回执，可重试原请求')
    }
    if (!receipt) {
      if (!this.writable) throw new ServiceError(attempt.uncertain ? 'commit_uncertain' : this.online ? 'forbidden' : 'offline', '当前不能提交进度修改；输入与原请求已保留')
      try {
        receipt = validateReceipt(await request<FileTransactionReceipt>(this.connection, '/api/files/commit', 'POST', { transactionId: attempt.transactionId, changes: [{ op: edit.op, path: edit.path, version: null, leaseId: '', content: bytesToBase64(new TextEncoder().encode(edit.data)), destination: null, destinationVersion: null }] }), attempt.transactionId)
      } catch (error) {
        if (error instanceof ServiceError && error.code === 'receipt_quarantined') throw uncertainResult(error, '')
        if (!attempt.uncertain && error instanceof ServiceError && (['unauthorized', 'forbidden', 'invalid', 'busy', 'transaction_mismatch', 'transaction_limit'].includes(error.code) || [400, 413, 415].includes(error.status ?? 0))) throw error
        throw uncertainResult(error, '进度操作结果待确认。请查询原提交；后续输入已保留。')
      }
    }
    this.rememberProgress(receipt, edit.path)
    // Exact receipts supply inverse effects. Current views come from fresh reads,
    // never from a delayed receipt that may precede another subject's edits.
    try {
      await this.refresh()
      this.remoteEpoch++
      await this.onCommitted?.(edits, true)
    } catch { throw new ServiceError('commit_uncertain', '进度已保存，本地视图尚未刷新；请查询原提交继续') }
  }
  restoreHistory(plan: HistoryRestorePlan): Promise<void> {
    const edit: FileEdit = { op: 'history-restore', path: 'project.json', version: null, data: JSON.stringify(plan.request), affectedPaths: plan.changes.map(change => change.path) }
    return this.transactions.submit(`恢复历史版本 #${plan.request.sequence}`, () => {
      this.assertRestoreDrafts(edit)
      return [edit]
    })
  }
  private assertRestoreDrafts(edit: FileEdit) {
    const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
    const path = this.transactions.getSnapshot().pendingPaths.find(path => edit.affectedPaths?.some(target => overlaps(path, target)))
    if (path) throw new ServiceError('drafts_pending', `${path} 有本地未保存修改。请先保存或另存草稿，再恢复历史；当前输入不会被清除。`)
  }
  private async performHistoryRestore(edits: FileEdit[], attempt: SendAttempt): Promise<void> {
    const edit = edits[0]
    if (edits.length !== 1 || edit.op !== 'history-restore' || typeof edit.data !== 'string') throw new ServiceError('invalid', '历史恢复不能和其他编辑混合')
    let receipt: FileTransactionReceipt | null = null
    if (attempt.uncertain) {
      try { receipt = await this.receipt(attempt.transactionId) }
      catch (error) { throw uncertainResult(error, '暂时无法查询恢复结果；原恢复请求已保留') }
      if (!receipt && attempt.queryOnly) throw new ServiceError('commit_uncertain', '服务暂无恢复回执，可重试原恢复请求')
    }
    if (!receipt) {
      if (!this.writable) throw new ServiceError(attempt.uncertain ? 'commit_uncertain' : 'forbidden', '当前不能提交恢复，原请求已保留')
      if (!attempt.uncertain) this.assertRestoreDrafts(edit)
      try {
        receipt = validateReceipt(await request<FileTransactionReceipt>(this.connection, '/api/files/commit', 'POST', { transactionId: attempt.transactionId, changes: [{ op: edit.op, path: 'project.json', version: null, leaseId: '', content: bytesToBase64(new TextEncoder().encode(edit.data)), destination: null, destinationVersion: null }] }), attempt.transactionId)
      } catch (error) {
        if (error instanceof ServiceError && error.code === 'receipt_quarantined') throw uncertainResult(error, '')
        if (!attempt.uncertain && error instanceof ServiceError && ['unauthorized', 'forbidden', 'invalid'].includes(error.code)) throw error
        throw uncertainResult(error, '恢复结果待确认。请查询原回执，不要重新创建恢复操作。')
      }
    }
    if (receipt.status === 'rejected') throw new ServiceError(receipt.error!.code, receipt.error!.message)
    // Treat a restore like a remote update: never advance a newer local draft's
    // baseline to the restored content or interpret command JSON as project.json.
    try {
      await this.refresh()
      this.remoteEpoch++
      await this.onCommitted?.(edits, true)
    } catch { throw new ServiceError('commit_uncertain', '服务已恢复，本地视图尚未刷新；请查询原回执继续恢复视图') }
  }
  async receipt(transactionId: string): Promise<FileTransactionReceipt | null> {
    try { return validateReceipt(await request<FileTransactionReceipt>(this.connection, `/api/files/transactions/${encodeURIComponent(transactionId)}`),transactionId) }
    catch (error) { if (error instanceof ServiceError && error.code === 'not_found') return null; throw error }
  }
  private async perform(edits: FileEdit[], attempt: SendAttempt) {
    if (edits.some(edit => edit.op === 'progress-command')) return this.performProgress(edits, attempt)
    if (edits.some(edit => edit.op === 'history-restore')) return this.performHistoryRestore(edits, attempt)
    let receipt: FileTransactionReceipt | null = null
    if (attempt.uncertain) {
      try { receipt = await this.receipt(attempt.transactionId) }
      catch (error) { throw uncertainResult(error, '暂时无法查询提交结果；原提交保留，可在恢复连接后继续查询') }
      if (!receipt && attempt.queryOnly) throw new ServiceError('commit_uncertain', '服务尚无这次提交的结果。可以重试原提交，仍使用同一提交编号')
    }
    if (receipt?.status === 'rejected') throw new ServiceError(receipt.error!.code, receipt.error!.message)
    if (!receipt) {
      try {
        if (!this.writable) throw new ServiceError(attempt.uncertain ? 'commit_uncertain' : this.online ? 'forbidden' : 'offline', this.online ? '当前主体只有读取权限' : '服务已断开，草稿保留在本窗口')
        const mutations = edits
        const plan = await this.assertEditingIntent(mutations, attempt.uncertain)
        const paths = plan.leasePaths
        for (const path of paths) normalizeProjectPath(path)
        const existing = new Set([...this.leases.values()].map(lease => lease.id))
        const acquired = paths.length ? await request<Lease[]>(this.connection, '/api/files/leases', 'POST', { paths }).catch(error => { if (attempt.uncertain) throw new ServiceError('commit_uncertain', '尚未确认原提交结果，暂时无法取得写权；请继续查询结果'); throw error }) : []
        const acquiredByPath = new Map(acquired.map(lease => [lease.resourceId.slice(5), lease]))
        for (const l of acquired) this.leases.set(l.resourceId.slice(5), l)
        try {
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
            if (error instanceof ServiceError && error.code === 'receipt_quarantined') throw uncertainResult(error, '')
            if (!attempt.uncertain && error instanceof ServiceError && (['unauthorized','forbidden','invalid','busy','transaction_mismatch','transaction_limit'].includes(error.code) || [400,413,415].includes(error.status ?? 0))) throw error
            throw uncertainResult(error, '提交结果待确认：服务可能已经保存。请查询结果，或重试同一提交')
          }
        } finally {
          // A language/binary sidecar must not keep blocking peers after its batch.
          // Editor-owned leases and pre-existing leases belong to separate actions.
          await this.releaseLeases(acquired.filter(lease => !existing.has(lease.id) && !this.editing.retained(lease.id)))
        }
      } catch (error) {
        // A missing receipt is not proof that the original send failed. Planning,
        // permission and lease failures cannot authorize a new transaction identity.
        if (attempt.uncertain && !receipt) throw new ServiceError('commit_uncertain', `原提交结果仍待确认：${error instanceof Error ? error.message : String(error)}`)
        throw error
      }
    }
    if (receipt?.status === 'rejected') throw new ServiceError(receipt.error!.code, receipt.error!.message)
    if (receipt && (receipt.status !== 'committed' || !receipt.tree)) throw new ServiceError('commit_uncertain', '服务返回的提交结果无效，请重新查询')
    for (const edit of edits.filter(edit => edit.op === 'skin-entry-patch')) {
      const command = typeof edit.data === 'string' ? JSON.parse(edit.data) : null
      const entries = receipt?.skinEntries
      const entry = Array.isArray(entries) ? entries.find(value => value && typeof value === 'object' && 'entryId' in value && value.entryId === command?.entryId) : null
      if (!command || !entry || !('revision' in entry) || entry.revision !== command.expectedRevision + 1) {
        throw new ServiceError('commit_uncertain', '服务没有返回完整的皮肤修改结果，请查询原提交')
      }
      this.entryResults.set(edit.data as string, entry)
      this.entryAcknowledgements.set(command.entryId, { command: edit.data as string, requestId: attempt.transactionId, entry })
      if (this.entryResults.size > 64) this.entryResults.delete(this.entryResults.keys().next().value!)
      if (this.entryAcknowledgements.size > 64) this.entryAcknowledgements.delete(this.entryAcknowledgements.keys().next().value!)
    }
    for (const edit of edits.filter(edit => edit.op === 'skin-library-command')) {
      const command = typeof edit.data === 'string' ? JSON.parse(edit.data) : null
      const result = receipt?.skinCommandResult
      if (!command || !result || result.command !== command.command || !result.result || typeof result.result !== 'object' || Array.isArray(result.result) || !Number.isSafeInteger(result.result.revision) || Number(result.result.revision) < 1) {
        throw new ServiceError('commit_uncertain', '服务没有返回完整的皮肤操作结果，请查询原提交')
      }
      const value = result.result
      const count = (key: string) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0
      const folder = value.folder as { folderId?: string; name?: string } | undefined
      const valid = command.command === 'ensure-library' ? typeof value.created === 'boolean'
        : command.command === 'create-folder' || command.command === 'patch-folder' ? folder?.folderId === (command.folderId ?? command.expectedFolder?.folderId) && typeof folder?.name === 'string'
          : command.command === 'delete-folder' ? value.deleted === true
            : command.command === 'delete-entries' || command.command === 'delete-folder-entries' ? count('deleted')
              : command.command === 'batch-patch' ? count('updated') && Array.isArray(value.entries)
                : command.command === 'rename-tag' || command.command === 'delete-tag' ? count('affectedEntries')
                  : command.command === 'import-entry'
      if (!valid) throw new ServiceError('commit_uncertain', '服务返回的皮肤操作明细不完整，请查询原提交')
      if (command.command === 'import-entry') {
        const entry = result.result.entry as { entryId?: string; skinId?: string; revision?: number } | undefined
        if (!entry || entry.entryId !== command.entry?.entryId || entry.skinId !== command.entry?.skinId || entry.revision !== 1) throw new ServiceError('commit_uncertain', '导入结果与原提交不匹配，请查询原提交')
        this.importResults.set(entry.entryId!, entry)
        if (this.importResults.size > 64) this.importResults.delete(this.importResults.keys().next().value!)
      }
      this.libraryResults.set(edit.data as string, result.result)
      if (this.libraryResults.size > 64) this.libraryResults.delete(this.libraryResults.keys().next().value!)
    }
    // Server adoption is a version-checked no-op in the same atomic batch.
    const acknowledged = receipt?.tree ?? this.tree
    // A receipt describes the original acknowledgement, not today's project.
    // In particular its revision can precede later edits or a service restart.
    await this.refresh().catch(() => undefined)
    const paths = [...new Set(edits.flatMap(e => e.destination ? [e.path, e.destination] : [e.path]))]
    for (const edit of edits) {
      if (edit.op === 'skin-entry-patch' || edit.op === 'skin-library-command') {
        // A semantic command is not the new file body. In particular, never let
        // its acknowledgement advance a stale whole-index draft onto a new hash.
        this.texts.delete(edit.path)
        this.originals.delete(edit.path)
        continue
      }
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
    try { await this.resourceLifecycle.committed(edits); await this.onCommitted?.(edits, attempt.replayed) }
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
  async sourceCommands(commands: Array<{path: string; destination: string | null; content?: string}>, extraEdits:FileEdit[]=[]): Promise<void> {
    const originalContents=new Map(commands.map(command=>[command.path,this.texts.get(command.path)]))
    const transition=await this.resourceLifecycle.prepare(commands)
    let submitted=false
    try {
    commands=commands.map(command=>{
      const prepared=transition.contents.find(item=>item.path===command.path)
      if(prepared&&typeof prepared.content==='string'&&command.content!==undefined&&command.content!==originalContents.get(command.path)&&command.content!==prepared.content)throw new Error('源文件还有未保存的文本草稿，请先保存，再改名或移动')
      return prepared&&typeof prepared.content==='string'&&command.destination?{...command,content:prepared.content}:command
    })
    // Preserve shared virtual placement for callers outside the gameplay explorer too.
    if(!extraEdits.some(edit=>edit.path===EXPLORER_ORGANIZATION_PATH)){
      const raw=this.texts.get(EXPLORER_ORGANIZATION_PATH)
      if(raw){const before=parseOrganization(raw),after=relocateOrganization(before,commands)
        if(serializeOrganization(before)!==serializeOrganization(after))extraEdits=[...extraEdits,{op:'write',path:EXPLORER_ORGANIZATION_PATH,data:serializeOrganization(after)}]
      }
    }
    // Recovery must keep a source command and its placement update together.
    // This C-only scope lets synchronization discard the whole operation when
    // metadata is stale; S still derives the actual source/owned-resource plan.
    const sourcePaths=commands.flatMap(command=>command.destination?[command.path,command.destination]:[command.path])
    const frozenExtras=this.captureEdits(extraEdits.map(edit=>edit.path===EXPLORER_ORGANIZATION_PATH&&sourcePaths.length
      ?{...edit,affectedPaths:[...new Set([...(edit.affectedPaths??[]),...sourcePaths])]}
      :edit))
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
    await this.assertSourceDraftsSaved(...captured.map(command => command.path))
    const plan = await this.planOperations(captured.map(command => ({ op: command.destination ? 'move' : 'remove', path: command.path, destination: command.destination })))
    // Editing can continue while planning. Check newly staged dependent drafts as well.
    await this.assertSourceDraftsSaved(...captured.map(command => command.path))
    const edits: FileEdit[] = []
    for (const operation of plan.operations) {
      const capturedSource = captured.find(command => command.path === operation.originPath)
      if (!capturedSource || (operation.op !== 'move' && operation.op !== 'remove')) throw new Error('服务返回了无效的资源操作计划')
      if (operation.path === operation.destination) continue
      edits.push({ op: operation.op, path: operation.path, destination: operation.destination ?? undefined,
        // A plan observes today's versions; it must never rebase an older C draft.
        version: versions.get(operation.path) ?? null, destinationVersion: operation.destination ? versions.get(operation.destination) ?? null : null,
        baseData: originals.get(operation.path)?.data, localContents: capturedSource.localContents, localEpochs: capturedSource.localEpochs })
    }
    for (const {destination, content, localContents, localEpochs} of captured) {
      if (destination && content !== undefined) edits.push({op:'write',path:destination,data:content,version:versions.get(destination) ?? null,baseData:originals.get(destination)?.data,localContents,localEpochs})
    }
    for(const edit of frozenExtras){
      if(edit.path===EXPLORER_ORGANIZATION_PATH&&(this.baseline.get(edit.path)??null)!==(edit.version??null)){
        throw new ServiceError('conflict','资源组织已变化，请刷新后重试；原请求未提交')
      }
    }
    edits.push(...frozenExtras)
    if (edits.length) {
      const completion=this.apply(edits, '修改源文件及关联资源')
      const record=this.transactions.getSnapshot().transactions.at(-1)!
      transition.submitted(record.id);submitted=true
      await completion
    }else transition.cancel()
    }catch(error){
      if(!submitted)transition.cancel()
      // Known rejections resume through settle(); uncertain requests stay paused.
      throw error
    }
  }
  /** Structural edits must not strand an unsaved owned-resource draft at its old path.
   * This is a UI precondition, not authority; S still derives the actual move plan.
   */
  async assertSourceDraftsSaved(...paths: string[]) {
    if (this.transactions.editorDirtyPaths().some(draft => paths.some(path => draft === path || draft.startsWith(`${path}/`)))) {
      throw new Error('该资源还有未完成的自动提交，请先处理，再改名或删除；输入保持原状')
    }
    const drafts = this.transactions.stagedWrites()
    if (!drafts.length || !paths.length) return
    const plan = await this.planOperations(drafts.map(edit => ({ op: 'write', path: edit.path, destination: null })))
    if (plan.relations.some(relation => relation.kind === 'ownership' && paths.some(path => relation.from === path || relation.from.startsWith(`${path}/`))
      && this.transactions.stagedWrites().some(edit => edit.path === relation.to || edit.path.startsWith(`${relation.to}/`)))) {
      throw new Error('该资源还有未保存的关联修改，请先保存，再改名或删除；草稿保持原状')
    }
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
let connector: ((mode: 'open' | 'create') => Promise<ProjectClient>) | null = null
export function getProjectClient() { return connected }
export function setProjectClient(client: ProjectClient | null) { connected = client }
export function registerProjectConnector(fn: (mode: 'open' | 'create') => Promise<ProjectClient>) { connector = fn; return () => { if (connector === fn) connector = null } }
export function requestProjectConnection(mode: 'open' | 'create' = 'open'): Promise<ProjectClient> {
  if (!connector) return Promise.reject(new Error('工程连接窗口尚未就绪'))
  return connector(mode)
}
