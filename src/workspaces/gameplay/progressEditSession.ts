import { applyProgressEffects, coalesceProgressEffects, progressDocumentEffects, progressSlot, sameProgressValue, normalProgressSource, type ProgressAcknowledgement, type ProgressCommand, type ProgressEffect, type ProgressState } from './progressOperations'

export type ProgressReadState = ProgressState & { revision: number }
export type ProgressAttempt = { id: number; requestId: string; command: ProgressCommand; mode: 'edit' | 'undo' | 'redo' }
export type ProgressSessionRecovery = { base: ProgressReadState; pending: ProgressEffect[]; active: ProgressAttempt | null; undo: string[]; redo: string[] }
export type ProgressSessionAdapter = {
  read(): Promise<ProgressReadState>
  submit(command: ProgressCommand, label: string): { id: number; requestId: string; completion: Promise<ProgressAcknowledgement> }
  record(id: number): { requestId: string; phase: string; message: string } | undefined
  acknowledgement(requestId: string): ProgressAcknowledgement | undefined
  recover(requestId: string): Promise<ProgressAcknowledgement | null>
  reinstate(attempt: ProgressAttempt): Promise<number>
  forget(id: number): Promise<void>
  dirty(dirty: boolean, locales: string[]): void
  persist(recovery: ProgressSessionRecovery | null): void
}
export type ProgressEditState = {
  view: ProgressState; server: ProgressState; ready: boolean; dirty: boolean; saving: boolean; error: string; active: ProgressAttempt | null
  canUndo: boolean; canRedo: boolean; conflicts: ProgressEffect[]
  replaced: boolean
  resolving: boolean
  location: 'ready'|'changing'|'missing'
}

/** One document's local intent queue. Server acknowledgements are the only undo records. */
export class ProgressEditSession {
  private base: ProgressReadState
  private pending: ProgressEffect[] = []
  private active: ProgressAttempt | null = null
  private undoStack: string[] = []
  private redoStack: string[] = []
  private ready = false
  private saving = false
  private error = ''
  private timer: ReturnType<typeof setTimeout> | null = null
  private current: Promise<void> | null = null
  private recovering = false
  private refreshing = 0
  private composing = false
  private documentId: string
  private replaced = false
  private resolving = false
  private location:'ready'|'changing'|'missing'='ready'
  private listeners = new Set<() => void>()
  private snapshot: ProgressEditState
  private readonly adapter: ProgressSessionAdapter
  constructor(initial: ProgressReadState, adapter: ProgressSessionAdapter, recovery?: ProgressSessionRecovery | null) {
    this.adapter = adapter
    this.base = recovery?.base ?? initial
    this.documentId = JSON.parse(this.base.source).id
    if (recovery) {
      this.pending = recovery.pending; this.active = recovery.active
      // Local queue numbers can be reused after reload; durable request identity cannot.
      if (this.active && adapter.record(this.active.id)?.requestId !== this.active.requestId) this.active = { ...this.active, id: -1 }
      this.undoStack = recovery.undo; this.redoStack = recovery.redo
    }
    this.snapshot = this.makeSnapshot()
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getSnapshot = () => this.snapshot
  backup() {
    return structuredClone({ format: 'hanshu.progress-edit-backup', version: 1, documentId: this.documentId,
      source: this.snapshot.view.source, languages: this.snapshot.view.languages,
      base: this.base, pending: this.pending, active: this.active, undo: this.undoStack, redo: this.redoStack })
  }
  private effects() { return [...(this.active?.command.command === 'apply' ? this.active.command.changes : []), ...this.pending] }
  private makeSnapshot(): ProgressEditState {
    const effects = this.effects(), view = applyProgressEffects(this.base, effects)
    return { view, server: this.base, ready: this.ready, dirty: !!(this.pending.length || this.active), saving: this.saving, error: this.error, active: this.active,
      canUndo: !!(this.pending.length || this.undoStack.length), canRedo: !!this.redoStack.length && !this.pending.length,
      replaced: this.replaced,
      resolving: this.resolving, location:this.location,
      conflicts: coalesceProgressEffects(effects).filter(effect => !sameProgressValue(progressSlot(this.base, effect.target), effect.expected)) }
  }
  private changed() {
    this.snapshot = this.makeSnapshot()
    this.adapter.dirty(this.snapshot.dirty, [...new Set(this.effects().flatMap(effect => effect.target.kind === 'locale' ? [effect.target.locale] : []))])
    try {
      this.adapter.persist(this.pending.length || this.active || this.undoStack.length || this.redoStack.length
        ? { base: this.base, pending: this.pending, active: this.active, undo: this.undoStack.slice(-100), redo: this.redoStack.slice(-100) } : null)
    } catch (error) { this.error = `草稿恢复记录保存失败：${String(error)}；请在关闭前导出修改。`; this.snapshot = this.makeSnapshot() }
    for (const listener of this.listeners) listener()
  }
  async initialize() {
    await this.refresh()
    this.ready = true; this.changed()
    if (this.active) await this.reconcile()
    else if (this.pending.length) this.schedule()
  }
  async refresh() {
    if(this.location==='missing')return
    const ticket = ++this.refreshing
    const latest = await this.adapter.read()
    if (ticket !== this.refreshing || latest.revision < this.base.revision) return
    if (JSON.parse(latest.source).id !== this.documentId) {
      this.replaced = true; this.pauseText(); this.error = '此路径的进度已被替换。原草稿已保留，不会应用到新的进度文档。'; this.changed()
      throw new Error(this.error)
    }
    this.base = latest; this.changed()
  }
  editSource(source: string, immediate = false) {
    const view = this.getSnapshot().view
    const effects = progressDocumentEffects(normalProgressSource(view.source), source).map(effect => ({ ...effect, expected: progressSlot(view, effect.target) }))
    this.edit(effects, immediate)
  }
  editText(locale: string, key: string, value: string, immediate = false) {
    const target = { kind: 'locale' as const, locale, key }
    this.edit([{ target, expected: progressSlot(this.snapshot.view, target), value: { present: true, value } }], immediate)
  }
  private edit(effects: ProgressEffect[], immediate: boolean) {
    if (this.resolving||this.location!=='ready') return
    this.pending = coalesceProgressEffects([...this.pending, ...effects])
    this.changed()
    if (immediate) void this.flush().catch(() => undefined)
    else this.schedule()
  }
  private schedule() {
    if (this.timer) clearTimeout(this.timer)
    if (this.composing||this.location!=='ready') return
    this.timer = setTimeout(() => { this.timer = null; void this.flush().catch(() => undefined) }, 500)
  }
  pauseText() { if (this.timer) clearTimeout(this.timer); this.timer = null }
  composition(active: boolean) { this.composing = active; this.pauseText(); if (!active) this.finishText() }
  finishText() { if (this.pending.length) void this.flush().catch(() => undefined) }
  async flush(): Promise<void> {
    this.pauseText()
    if(this.location==='missing')return
    if (this.replaced) throw new Error(this.error || '进度身份已变化，原草稿已保留')
    if (this.composing) return
    if (this.current) { await this.current; return this.flush() }
    if (this.active) {
      await this.reconcile()
      if (this.active) throw new Error(this.error || '原提交尚未完成；后续输入已保留')
    }
    if (!this.pending.length) return
    if (!this.ready) throw new Error('进度文档尚未加载完成')
    const changes = this.pending; this.pending = []
    const command: ProgressCommand = { command: 'apply', documentId: this.documentId, changes }
    await this.send(command, 'edit')
    if (this.pending.length) await this.flush()
  }
  private send(command: ProgressCommand, mode: ProgressAttempt['mode']): Promise<void> {
    const submitted = this.adapter.submit(command, mode === 'edit' ? '编辑进度' : mode === 'undo' ? '撤销进度操作' : '重做进度操作')
    this.active = { id: submitted.id, requestId: submitted.requestId, command, mode }
    this.saving = true; this.error = ''; this.changed()
    const operation = submitted.completion.then(ack => this.accept(ack)).catch(error => {
      this.error = error instanceof Error ? error.message : String(error)
      throw error
    }).finally(() => { this.saving = false; this.current = null; this.changed() })
    this.current = operation
    return operation
  }
  private async accept(ack: ProgressAcknowledgement) {
    const active = this.active
    if (!active) return
    // Fetch a fresh pinned state; a delayed receipt may precede a peer's newer edit.
    await this.refresh()
    if (this.active !== active) return
    if (active.mode === 'edit') { if (ack.result.effects.length) this.undoStack.push(ack.transactionId); this.redoStack = [] }
    else if (active.mode === 'undo') { this.undoStack.pop(); if (ack.result.effects.length) this.redoStack.push(ack.transactionId) }
    else { this.redoStack.pop(); if (ack.result.effects.length) this.undoStack.push(ack.transactionId) }
    this.active = null; this.error = ''; this.changed()
  }
  /** A recovered outbox retry settles the same session even after the first Promise rejected. */
  async reconcile() {
    if (this.location!=='ready'||!this.active || this.current || this.recovering || this.resolving) return
    this.recovering = true
    try {
      const record = this.adapter.record(this.active.id)
      if (record) this.active.requestId = record.requestId
      if (record && record.phase !== 'saved') {
        if (['failed', 'conflict', 'uncertain'].includes(record.phase)) { this.error = record.message; this.changed() }
        return
      }
      let ack = this.adapter.acknowledgement(this.active.requestId) ?? null
      if (!ack && (!record || record.phase === 'saved')) {
        try { ack = await this.adapter.recover(this.active.requestId) }
        catch (error) {
          if (!record) this.active.id = await this.adapter.reinstate(this.active)
          throw error
        }
      }
      if (ack) { await this.accept(ack); if (this.pending.length) this.schedule() }
      else if (record && ['failed', 'conflict', 'uncertain'].includes(record.phase)) { this.error = record.message; this.changed() }
      else if (!record) { this.active.id = await this.adapter.reinstate(this.active); this.error = '原提交结果待确认，请先查询结果。后续输入已保留。'; this.changed() }
    } catch (error) { this.error = String(error); this.changed() }
    finally { this.recovering = false }
  }
  async prepareLocationChange():Promise<string> {
    if(this.location!=='ready')throw new Error('资源结构操作尚未完成')
    this.location='changing';this.pauseText();this.changed()
    try {await this.flush();await this.refresh();return this.snapshot.server.source}
    catch(error){this.cancelLocationChange();throw error}
  }
  cancelLocationChange(){
    if(this.location!=='changing')return
    this.location='ready';this.changed();if(this.pending.length)this.schedule()
  }
  async relocate(){
    this.pauseText();++this.refreshing
    this.location='ready';this.ready=false
    // Archived undo receipts refer to the previous source path.
    this.undoStack=[];this.redoStack=[];this.error='';this.changed()
    await this.initialize()
  }
  markMissing(){
    this.location='missing';this.pauseText();++this.refreshing
    this.error='资源已被移除或移动，自动保存已停止。未完成修改已保留，可导出草稿。'
    this.changed()
  }
  async undo(redo = false) {
    if (this.resolving) return
    if (!redo && this.pending.length && !this.active) { this.pauseText(); this.pending = []; this.error = ''; this.changed(); return }
    await this.flush()
    const transactionId = (redo ? this.redoStack : this.undoStack).at(-1)
    if (transactionId) await this.send({ command: 'revert', transactionId }, redo ? 'redo' : 'undo')
  }
  async resolveFailure(keepMine: boolean) {
    if (this.resolving) return
    this.resolving = true; this.pauseText(); this.changed()
    try { await this.resolveKnownFailure(keepMine) }
    finally { this.resolving = false; this.changed() }
  }
  /** Explicit bulk policy: drop only incompatible fields, submit the rest with their original expectations. */
  async synchronize() {
    if(this.location!=='ready')return
    this.pauseText()
    if (!this.snapshot.dirty) { try{await this.refresh()}catch(error){if(this.replaced)await this.openReplacement();else throw error}return }
    if (this.current) await this.current.catch(() => undefined)
    await this.reconcile()
    const active = this.active
    const record = active && this.adapter.record(active.id)
    if (active && (!record || !['failed', 'conflict'].includes(record.phase))) throw new Error('进度操作结果尚未确认，不能放弃')
    this.resolving = true; this.changed()
    try {
      const effects = coalesceProgressEffects(this.effects())
      try { await this.refresh() } catch(error) { if(this.replaced) {await this.openReplacement();return} throw error }
      const safe = effects.filter(effect => sameProgressValue(progressSlot(this.base, effect.target), effect.expected) && !sameProgressValue(effect.expected, effect.value))
      if (active) await this.adapter.forget(active.id)
      this.active = null; this.pending = safe; this.error = ''; this.undoStack = []; this.redoStack = []; this.changed()
    } finally { this.resolving = false; this.changed() }
    await this.flush()
  }
  private async resolveKnownFailure(keepMine: boolean) {
    if (!this.active || this.current) return
    const record = this.adapter.record(this.active.id)
    if (!record || !['failed', 'conflict'].includes(record.phase)) throw new Error('请先确认原提交的结果')
    if (this.active.mode !== 'edit' && keepMine) throw new Error('撤销冲突不能覆盖协作者修改，请取消这次撤销后重新检查')
    const effects = coalesceProgressEffects(this.effects())
    await this.refresh()
    if (record) await this.adapter.forget(this.active.id)
    if (this.active.mode !== 'edit') {
      this.active = null; this.error = ''; this.changed()
      if (this.pending.length) this.schedule()
      return
    }
    this.active = null
    this.pending = keepMine ? effects.map(effect => ({ ...effect, expected: progressSlot(this.base, effect.target) })).filter(effect => !sameProgressValue(effect.expected, effect.value)) : []
    this.error = ''; this.changed()
    if (keepMine) await this.flush()
  }
  async openReplacement() {
    if (!this.replaced || this.current) return
    const record = this.active && this.adapter.record(this.active.id)
    if (this.active && (!record || !['saved', 'failed', 'conflict'].includes(record.phase))) throw new Error('请先确认原提交结果，再打开替换后的进度')
    const latest = await this.adapter.read()
    if (record && ['failed', 'conflict'].includes(record.phase)) await this.adapter.forget(this.active!.id)
    this.pauseText(); this.active = null; this.pending = []; this.undoStack = []; this.redoStack = []
    this.base = latest; this.documentId = JSON.parse(latest.source).id; this.replaced = false; this.error = ''; this.ready = true; this.changed()
  }
}
