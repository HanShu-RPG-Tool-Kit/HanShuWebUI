import { ServiceError } from '../collab/protocol'
import type { FileEdit } from './serviceClient'
import { randomId } from './crypto'
import type { EditJournal } from './editJournal'

export type SendAttempt = { transactionId: string; uncertain: boolean; queryOnly: boolean; replayed: boolean }

export type TransactionPhase = 'preparing' | 'submitting' | 'saved' | 'failed' | 'conflict' | 'uncertain'
export type TransactionInfo = {
  id: number
  requestId: string
  label: string
  phase: TransactionPhase
  paths: string[]
  message: string
  code: string
}
export type EditTransactionState = {
  pendingPaths: string[]
  preparing: number
  queued: number
  transactions: TransactionInfo[]
  journalError: string
}
type Staged = { edit: FileEdit }
type Preparation = { run: () => void | Promise<void>; promise: Promise<void>; failed?: boolean; error?: unknown }
type Job = {
  info: TransactionInfo
  collect: () => FileEdit[] | Promise<FileEdit[]>
  includeStaged: boolean
  edits?: FileEdit[]
  staged?: Map<string, Staged>
  restoredStagedPaths?: string[]
  uncertain?: boolean
  replayed?: boolean
  unresolved?: boolean
}
const pathsOf = (edits: FileEdit[]) => [...new Set(edits.flatMap(e => [e.path, ...(e.destination ? [e.destination] : []), ...(e.affectedPaths ?? [])]))]
const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
const unsuccessful = (phase: TransactionPhase) => phase === 'failed' || phase === 'conflict' || phase === 'uncertain'
function editsOverlap(a: FileEdit, b: FileEdit): boolean {
  if (a.path === b.path) {
    try {
      const targets = (edit: FileEdit): string[] | null => {
        if (typeof edit.data !== 'string') return null
        const command = JSON.parse(edit.data)
        if (edit.op === 'skin-entry-patch' && typeof command.entryId === 'string') return [command.entryId]
        if (edit.op !== 'skin-library-command') return null
        if (command.command === 'import-entry' && typeof command.entry?.entryId === 'string') return [command.entry.entryId]
        if (['batch-patch', 'delete-entries'].includes(command.command) && Array.isArray(command.expectedEntries) && command.expectedEntries.every((entry: { entryId?: string }) => typeof entry.entryId === 'string')) return command.expectedEntries.map((entry: { entryId: string }) => entry.entryId)
        return null
      }
      const left = targets(a), right = targets(b)
      if (left && right) return left.some(id => right.includes(id))
    } catch { /* Invalid commands retain the conservative path boundary. */ }
  }
  return pathsOf([a]).some(p => pathsOf([b]).some(q => overlaps(p, q)))
}

/** C-side editing boundary. Resource ownership is deliberately not inferred here.
 * Editors supply changes; this layer waits for local preparation and freezes a batch
 * before sending it. A failed batch retains its original contents AND read versions.
 */
export class EditTransactions {
  /** Notify editor views only after acknowledged staged drafts have been cleared. */
  onSettled?: (replayed: boolean) => void
  private staged = new Map<string, Staged>()
  private preparations = new Map<string, Preparation>()
  private dirty = new Set<string>()
  private editorDirty = new Map<string, Set<string>>()
  private revision = 0
  private nextId = 1
  private jobs: Job[] = []
  private tail: Promise<unknown> = Promise.resolve()
  private queued = 0
  private listeners = new Set<() => void>()
  private journal?: EditJournal
  private journalError = ''
  private state: EditTransactionState = { pendingPaths: [], preparing: 0, queued: 0, transactions: [], journalError: '' }
  private readonly capture: (edits: FileEdit[]) => FileEdit[]
  private readonly send: (edits: FileEdit[], attempt: SendAttempt) => Promise<void>
  constructor(
    capture: (edits: FileEdit[]) => FileEdit[],
    send: (edits: FileEdit[], attempt: SendAttempt) => Promise<void>,
  ) { this.capture = capture; this.send = send }
  getSnapshot = (): EditTransactionState => this.state
  getRevision() { return this.revision }
  submission(id: number): FileEdit[] { return this.jobs.find(j => j.info.id === id)?.edits?.map(e => ({ ...e })) ?? [] }
  async restore(journal: EditJournal) {
    const records = await journal.load()
    this.journal = journal
    for (const record of records) {
      const phase: TransactionPhase = record.phase === 'failed' || record.phase === 'conflict' ? record.phase : 'uncertain'
      this.jobs.push({ info: { id: record.id, requestId: record.requestId, label: record.label, phase, paths: pathsOf(record.edits), message: record.message || '已恢复本窗口的原提交，请查询结果或继续处理', code: record.code }, collect: () => [], includeStaged: true, edits: record.edits, restoredStagedPaths: record.stagedPaths, uncertain: phase === 'uncertain', replayed: true, unresolved: true })
      this.nextId = Math.max(this.nextId, record.id + 1)
    }
    this.emit()
  }
  private async persist(jobs = this.jobs) {
    if (!this.journal) return
    try {
      await this.journal.save(jobs.filter(j => j.edits?.length && j.info.phase !== 'saved').map(j => ({ id: j.info.id, requestId: j.info.requestId, label: j.info.label, phase: j.info.phase, message: j.info.message, code: j.info.code, edits: j.edits!, stagedPaths: j.staged ? [...j.staged.keys()] : j.restoredStagedPaths ?? [] })))
      this.journalError = ''
    } catch (e) { this.journalError = `保存本地提交记录失败：${String(e)}。请导出修改，并检查浏览器存储空间。`; throw e }
  }
  stagedWrites(): FileEdit[] { return [...this.staged.values()].map(s => ({ ...s.edit })) }
  async idle() { await this.tail; await this.settlePreparations(false) }
  discardDraftPaths(paths: string[]) {
    if (this.queued) throw new Error('仍有提交在途，不能清理草稿')
    for (const path of paths) { this.staged.delete(path); this.dirty.delete(path); this.preparations.delete(path) }
    this.changed()
  }
  clearSubmittedDrafts(edits: FileEdit[]) {
    for(const edit of edits) {
      const current=this.staged.get(edit.path)
      if(current?.edit.data===edit.data)this.staged.delete(edit.path)
    }
    this.changed()
  }
  editorDirtyPaths(): string[] { return [...new Set([...this.editorDirty.values()].flatMap(paths => [...paths]))] }
  private bindRestoredStaged(job: Job) {
    if (job.staged) return
    job.staged = new Map()
    // Bind against the ORIGINAL failed payload before a conflict resolution replaces
    // it. A newer draft gets a separate identity, so success advances its base but
    // cannot clear its contents. Stored paths distinguish staged edits from unrelated
    // drafts that happened to contain identical text.
    for (const path of job.restoredStagedPaths ?? []) {
      const original = job.edits?.find(edit => edit.path === path && edit.op === 'write')
      if (!original) continue
      const current = this.staged.get(path)
      const same = !!current && current.edit.version === original.version && current.edit.data === original.data
      job.staged.set(path, same ? current! : { edit: original })
    }
  }
  stagedText(path: string): string | undefined {
    const data = this.staged.get(path)?.edit.data
    return typeof data === 'string' ? data : undefined
  }
  hasDraft(path: string): boolean { return this.dirty.has(path) || this.staged.has(path) || [...this.editorDirty.values()].some(paths => paths.has(path)) }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit() {
    this.state = {
      pendingPaths: [...new Set([...this.dirty, ...this.staged.keys(), ...[...this.editorDirty.values()].flatMap(paths => [...paths])])],
      preparing: [...this.preparations.values()].filter(p => !p.failed).length,
      queued: this.queued,
      transactions: this.jobs.map(j => ({ ...j.info, paths: [...j.info.paths] })),
      journalError: this.journalError,
    }
    for (const listener of this.listeners) listener()
  }
  setDirtyPaths(paths: string[]) {
    const next = new Set(paths)
    if (next.size === this.dirty.size && paths.every(p => this.dirty.has(p))) return
    this.dirty = next; this.changed()
  }
  /** Independent semantic drafts must survive workspace refreshes and dirty scans. */
  setEditorDirty(owner: string, paths: string[]) {
    const previous = this.editorDirty.get(owner)
    const next = new Set(paths)
    if ((previous?.size ?? 0) === next.size && [...next].every(path => previous?.has(path))) return
    if (next.size) this.editorDirty.set(owner, next)
    else this.editorDirty.delete(owner)
    this.changed()
  }
  /** Restore a frozen request whose editor journal survived its outbox entry.
   * No send is implied: the original receipt must be queried or replayed by ID.
   */
  async recoverSubmission(label: string, edits: FileEdit[], requestId: string): Promise<number> {
    const existing = this.jobs.find(job => job.info.requestId === requestId)
    if (existing) return existing.info.id
    const frozen = this.capture(edits)
    const job: Job = { info: { id: this.nextId++, requestId, label, phase: 'uncertain', paths: pathsOf(frozen), message: '已恢复原提交，请查询结果', code: 'commit_uncertain' }, collect: () => [], includeStaged: false, edits: frozen, staged: new Map(), uncertain: true, replayed: true, unresolved: true }
    this.jobs.push(job)
    await this.persist()
    this.emit()
    return job.info.id
  }
  /** Preserve a remote editor result which conflicts with a local draft, without sending it. */
  async retainConflict(label: string, edits: FileEdit[], message: string): Promise<number> {
    const frozen = this.capture(edits)
    const job: Job = { info: { id: this.nextId++, requestId: randomId(), label, phase: 'conflict', paths: pathsOf(frozen), message, code: 'conflict' }, collect: () => [], includeStaged: false, edits: frozen, staged: new Map(), unresolved: true }
    this.jobs.push(job)
    await this.persist()
    this.emit()
    return job.info.id
  }
  /** Call even when the set of dirty paths stays the same: their contents may change. */
  changed() { this.revision++; this.emit() }
  /** Register asynchronous initialization before it produces a staged draft. Saves
   * must wait for this work as well as any cache mirrors it subsequently enqueues.
   */
  prepareDraft(path: string, run: () => void | Promise<void>) {
    const completion = this.prepare(path, run)
    this.emit()
    return completion
  }
  stageWrite(edit: FileEdit, prepare?: () => void | Promise<void>) {
    if (edit.op !== 'write') throw new Error('草稿暂存只接受文件内容；移动和删除请提交显式事务')
    const previous = this.staged.get(edit.path)
    const captured = this.capture([edit])[0]
    // Later keystrokes must not rebase an existing draft onto a remote version.
    if (previous) captured.version = previous.edit.version
    this.revision++
    this.staged.set(edit.path, { edit: captured })
    const completion = prepare ? this.prepare(edit.path, prepare) : Promise.resolve()
    this.emit()
    return completion
  }
  /** Serialize mirrors of the same resource so an old slow cache write cannot win. */
  private prepare(path: string, run: () => void | Promise<void>) {
    const previous = this.preparations.get(path)
    const preparation: Preparation = { run, promise: Promise.resolve() }
    preparation.promise = (previous?.promise ?? Promise.resolve()).then(run).then(() => {
      if (this.preparations.get(path) === preparation) this.preparations.delete(path)
    }, error => { preparation.failed = true; preparation.error = error }).then(() => { this.emit() })
    this.preparations.set(path, preparation)
    const completion = preparation.promise.then(() => { if (preparation.failed) throw preparation.error })
    // TextMap writes synchronously and intentionally does not await its mirror.
    // Explicit callers can await this same promise to report local preparation errors.
    void completion.catch(() => undefined)
    return completion
  }
  private async settlePreparations(retry: boolean) {
    if (retry) for (const [path, p] of this.preparations) if (p.failed) this.prepare(path, p.run)
    while (this.preparations.size) {
      const pending = [...this.preparations.values()]
      await Promise.all(pending.map(p => p.promise))
      const failed = [...this.preparations.entries()].find(([, p]) => p.failed)
      if (failed) throw new Error(`准备草稿失败（${failed[0]}）：${String(failed[1].error)}`)
    }
  }
  submit(label: string, collect: () => FileEdit[] | Promise<FileEdit[]>, includeStaged = false): Promise<void> {
    const job: Job = { info: { id: this.nextId++, requestId: randomId(), label, phase: 'preparing', paths: includeStaged ? [...this.staged.keys()] : [], message: '', code: '' }, collect, includeStaged }
    this.jobs.push(job)
    // Keep successful history bounded; unresolved failures retain their payloads.
    this.jobs = this.jobs.filter(j => j.info.phase !== 'saved' || j.info.id > job.info.id - 8)
    return this.enqueue(job, false)
  }
  private enqueue(job: Job, retry: boolean, queryOnly = false) {
    this.queued++; this.emit()
    const result = this.tail.then(() => this.execute(job, retry, queryOnly))
    this.tail = result.catch(() => undefined)
    return result.finally(() => { this.queued--; this.emit() })
  }
  private async execute(job: Job, retry: boolean, queryOnly: boolean) {
    let enteredSend = false
    job.info.phase = 'preparing'; job.info.message = ''; job.info.code = ''; this.emit()
    try {
      if (!job.edits) {
        // A collector may await IndexedDB while the user is still typing. Recollect
        // until both source content and staged mirrors belong to the same revision.
        let collected: FileEdit[]
        let revision: number
        do {
          if (job.includeStaged) await this.settlePreparations(retry)
          revision = this.revision
          collected = await job.collect()
        } while (job.includeStaged && (revision !== this.revision || [...this.preparations.values()].some(p => !p.failed)))
        job.staged = job.includeStaged ? new Map(this.staged) : new Map()
        const stagedPaths = new Set(job.staged.keys())
        job.edits = this.capture([...collected.filter(e => !stagedPaths.has(e.path)), ...[...job.staged.values()].map(s => ({ ...s.edit, cacheEpoch: undefined, localEpochs: undefined }))])
        job.info.paths = pathsOf(job.edits)
      }
      const blocking = this.jobs.find(other => other !== job && (other.unresolved || unsuccessful(other.info.phase)) &&
        (other.edits?.length ? other.edits.some(a => job.edits!.some(b => editsOverlap(a, b))) : other.info.paths.some(p => job.info.paths.some(q => overlaps(p, q)))))
      if (blocking) throw new ServiceError('pending_transaction', `相关资源有未处理的提交「${blocking.info.label}」，请先处理该记录`)
      if (job.edits.length) {
        // Recover staged identity after a browser reload. Only the exact restored
        // draft is cleared; subsequent typing remains a separate draft.
        this.bindRestoredStaged(job)
        job.info.phase = 'submitting'; this.emit()
        await this.persist() // Never send a batch which cannot survive a reload.
        enteredSend = true
        await this.send(job.edits, { transactionId: job.info.requestId, uncertain: !!job.uncertain, queryOnly, replayed: retry || !!job.replayed })
      }
      for (const [path, staged] of job.staged ?? []) {
        const current = this.staged.get(path)
        if (current === staged) this.staged.delete(path)
        else if (current) {
          // A newer draft descends from OUR successful write. Advance its base to
          // that acknowledged version, so it also remains saveable after reconnect.
          // Remote changes never take this path.
          current.edit = this.capture([{ ...current.edit, version: undefined, baseData: undefined }])[0]
        }
      }
      if (enteredSend) {
        try { this.onSettled?.(retry || !!job.replayed) }
        catch { throw new ServiceError('commit_uncertain', '服务已保存，本地视图更新未完成；请重试以恢复本地视图') }
      }
      job.info.phase = 'saved'
      job.unresolved = false; job.uncertain = false
      job.info.message = '已保存'
      // Successful jobs no longer need to retain binary payloads or collector closures.
      job.edits = []; job.staged = undefined; job.collect = () => []
    } catch (error) {
      const code = error instanceof ServiceError ? error.code : ''
      job.info.code = code
      job.info.phase = (!enteredSend && job.uncertain) || code === 'commit_uncertain' ? 'uncertain' : code === 'conflict' || code === 'locked' ? 'conflict' : 'failed'
      job.uncertain = job.info.phase === 'uncertain'
      job.unresolved = true
      job.info.message = error instanceof Error ? error.message : String(error)
      if (!job.edits && this.jobs.some(other => other !== job && unsuccessful(other.info.phase) && other.info.paths.some(p => job.info.paths.some(q => overlaps(p, q))))) {
        this.jobs = this.jobs.filter(j => j !== job)
      }
      // A blocked duplicate is not another independent failed transaction.
      if (code === 'pending_transaction') this.jobs = this.jobs.filter(j => j !== job)
      throw error
    } finally { await this.persist().catch(() => undefined); this.emit() }
  }
  retry(id: number): Promise<void> {
    const job = this.jobs.find(j => j.info.id === id)
    if (!job || !unsuccessful(job.info.phase)) return Promise.reject(new Error('该提交不能重试'))
    // A rejection is immutable. A new attempt gets a new ID; an unknown outcome
    // keeps the same ID and exact payload until S has resolved it.
    if (!job.uncertain) job.info.requestId = randomId()
    // Mark immediately to prevent double-clicking retry from enqueuing it twice.
    job.info.phase = 'preparing'
    return this.enqueue(job, true)
  }
  confirm(id: number): Promise<void> {
    const job = this.jobs.find(j => j.info.id === id && j.info.phase === 'uncertain')
    if (!job) return Promise.reject(new Error('该提交无需查询'))
    job.info.phase = 'preparing'
    return this.enqueue(job, true, true)
  }
  resolve(id: number, edits: FileEdit[]): Promise<void> {
    const job = this.jobs.find(j => j.info.id === id && (j.info.phase === 'conflict' || j.info.phase === 'failed'))
    if (!job) return Promise.reject(new Error('请先确认原提交的结果，再处理冲突'))
    this.bindRestoredStaged(job)
    job.edits = this.capture(edits); job.info.paths = pathsOf(edits)
    job.info.requestId = randomId(); job.uncertain = false; job.replayed = true
    job.info.phase = 'preparing'
    return this.enqueue(job, true)
  }
  async forget(id: number) {
    const job = this.jobs.find(j => j.info.id === id)
    if (job?.uncertain || job?.info.phase === 'uncertain') throw new Error('结果待确认的提交不能移除，请先查询结果')
    if (!job || !unsuccessful(job.info.phase)) return
    const previousPhase = job.info.phase
    // Keep the unresolved record blocking overlapping work until its removal is
    // durable. Preparing also prevents retry/resolve racing this operation.
    job.info.phase = 'preparing'; this.emit()
    const removal = this.tail.then(async () => {
      try {
        await this.persist(this.jobs.filter(other => other !== job))
        this.jobs = this.jobs.filter(other => other !== job)
      } catch (error) { job.info.phase = previousPhase; throw error }
      finally { this.emit() }
    })
    this.tail = removal.catch(() => undefined)
    await removal // Does not change draft content, staged writes, or read versions.
  }
  async backup(id?: number): Promise<Blob> {
    const jobs = this.jobs.filter(j => id === undefined ? unsuccessful(j.info.phase) : j.info.id === id)
    const edits = jobs.flatMap(j => j.edits ?? [])
    for (const staged of this.staged.values()) {
      const selected = id === undefined || jobs.some(j => !j.edits && j.info.paths.includes(staged.edit.path))
      if (selected && !edits.some(e => e.path === staged.edit.path)) edits.push(staged.edit)
    }
    const changes = await Promise.all(edits.map(async ({ data, ...edit }) => {
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data
      let content = ''
      if (bytes) for (let i = 0; i < bytes.length; i += 8192) content += String.fromCharCode(...bytes.subarray(i, i + 8192))
      return { ...edit, content: bytes ? btoa(content) : null }
    }))
    return new Blob([JSON.stringify({ format: 'hanshu.edit-backup', version: 1, changes }, null, 2)], { type: 'application/json' })
  }
}
