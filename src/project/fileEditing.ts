import { request, ServiceError, type Lease, type Snapshot } from '../collab/protocol'
import type { ProjectClient } from './serviceClient'

type Editing = { leaseId: string; leases: Lease[]; lost: boolean; reason: string }

/** Explicit editor intent is separate from short-lived leases used by a file transaction. */
export class FileEditing {
  private edits = new Map<string, Editing>()
  private listeners = new Set<() => void>()
  private version = 0
  private focusTail: Promise<void> = Promise.resolve()
  private focusEpoch = 0
  focus: string | null = null
  focusEntryId: string | null = null
  focusActivity: 'viewing' | 'editing' = 'viewing'
  private focusOwner: symbol | null = null
  pending: string | null = null
  error = ''
  presenceError = ''
  observedAt: number
  private client: ProjectClient
  constructor(client: ProjectClient) { this.client = client; this.observedAt = client.serverNow() }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getVersion = () => this.version
  changed() { this.observedAt = this.client.serverNow(); this.version++; for (const listener of this.listeners) listener() }
  state(path: string) { return this.edits.get(path) }
  canEdit(path: string): boolean {
    const edit = this.edits.get(path)
    return !!edit && !edit.lost && this.client.writable && edit.leases.every(item => {
      const lease = this.client.leases.get(item.resourceId.slice(5))
      return lease?.id === item.id && lease.expiresAt > this.client.serverNow()
    })
  }
  retained(id: string) { return [...this.edits.values()].some(edit => !edit.lost && edit.leases.some(lease => lease.id === id)) }
  reconcile(online: boolean, snapshot: Snapshot) {
    for (const edit of this.edits.values()) {
      if (edit.lost) continue
      const complete = edit.leases.every(lease => snapshot.leases.some(item => item.id === lease.id && item.sessionId === snapshot.session.id && item.expiresAt > this.client.serverNow()))
      if (!online || snapshot.role === 'viewer' || !complete) {
        edit.lost = true
        edit.reason = !online ? '连接已断开，草稿保留在本窗口' : snapshot.role === 'viewer' ? '当前主体已改为只读，草稿已保留' : '写权已被接管或已到期，草稿已保留'
        // Stop renewing a suspended editor lease. Reconnection requires explicit intent.
        for (const lease of edit.leases) {
          const path = lease.resourceId.slice(5)
          if (this.client.leases.get(path)?.id === lease.id && !this.retained(lease.id)) this.client.leases.delete(path)
        }
      }
    }
    this.changed()
  }
  setFocus(path: string | null, details: { entryId?: string | null; activity?: 'viewing' | 'editing' } = {}) {
    this.focusOwner = null
    this.updatePresence(path, details)
  }
  claimFocus(path: string, details: { entryId?: string | null; activity?: 'viewing' | 'editing' } = {}) {
    const owner = Symbol('resource view')
    this.focusOwner = owner
    this.updatePresence(path, details)
    return owner
  }
  updateFocus(owner: symbol, activity: 'viewing' | 'editing') {
    if (this.focusOwner === owner) this.updatePresence(this.focus, { entryId: this.focusEntryId, activity })
  }
  releaseFocus(owner: symbol) {
    // An old, hidden editor must never clear the newly active editor's focus.
    if (this.focusOwner !== owner) return
    this.focusOwner = null
    this.updatePresence(null)
  }
  private updatePresence(path: string | null, details: { entryId?: string | null; activity?: 'viewing' | 'editing' } = {}) {
    const entryId = path ? details.entryId ?? null : null
    const activity = path ? details.activity ?? 'viewing' : 'viewing'
    if (path === this.focus && entryId === this.focusEntryId && activity === this.focusActivity) return
    const moved = path !== this.focus || entryId !== this.focusEntryId
    this.focus = path; this.focusEntryId = entryId; this.focusActivity = activity
    if (moved) this.error = ''
    this.presenceError = ''; this.changed()
    this.publishFocus()
  }
  publishFocus() {
    const epoch = ++this.focusEpoch
    // Serialize focus updates: an old request cannot overwrite the latest tab on S.
    this.focusTail = this.focusTail.catch(() => undefined).then(async () => {
      if (epoch !== this.focusEpoch || !this.client.online) return
      try {
        const snapshot = await request<Snapshot>(this.client.connection, '/api/presence', 'POST', { path: this.focus, entryId: this.focusEntryId, activity: this.focusActivity })
        if (epoch !== this.focusEpoch || !this.client.online) return
        this.presenceError = ''
        this.client.setStatus(true, snapshot)
      } catch (error) {
        if (epoch !== this.focusEpoch) return
        this.presenceError = `在线状态更新失败：${error instanceof Error ? error.message : String(error)}`
        this.changed()
      }
    })
  }
  async begin(path: string, force = false) {
    if (this.pending) return
    if (!this.client.writable) throw new ServiceError('forbidden', '当前连接不能申请编辑')
    if (this.client.transactions.getSnapshot().queued) throw new Error('请等待当前提交结束，再申请编辑')
    this.pending = path; this.error = ''; this.changed()
    let acquired: Lease[] = []
    try {
      const plan = await this.client.planOperations([{ op: 'write', path, destination: null }])
      acquired = await request<Lease[]>(this.client.connection, '/api/files/leases', 'POST', { paths: plan.leasePaths, force })
      const lease = acquired.find(item => item.resourceId === `file:${path}`)
      if (!lease) throw new Error('服务没有返回此文档的写权')
      for (const item of acquired) this.client.leases.set(item.resourceId.slice(5), item)
      const snapshot = await request<Snapshot>(this.client.connection, '/api/project')
      this.client.setStatus(true, snapshot)
      const confirmed = acquired.map(lease => this.client.snapshot.leases.find(item => item.id === lease.id && item.sessionId === this.client.snapshot.session.id && item.expiresAt > this.client.serverNow())).filter((item): item is Lease => !!item)
      if (plan.leasePaths.some(path => !confirmed.some(item => item.resourceId === `file:${path}`)) || !this.client.writable) throw new Error('申请期间写权发生变化，请重新申请')
      this.edits.set(path, { leaseId: lease.id, leases: confirmed, lost: false, reason: '' })
      // Reconcile may have removed a previous suspended ID; retain only this confirmed lease.
      for (const item of confirmed) this.client.leases.set(item.resourceId.slice(5), item)
    } catch (error) {
      await this.client.releaseLeases(acquired.filter(item => !this.retained(item.id)))
      this.error = error instanceof Error ? error.message : String(error)
      throw error
    } finally { this.pending = null; this.changed() }
  }
  async end(path: string) {
    if (this.pending) return
    if (this.client.transactions.getSnapshot().queued) throw new Error('请等待当前提交结束，再结束编辑')
    const edit = this.edits.get(path)
    if (!edit) return
    this.pending = path; this.error = ''; this.edits.delete(path); this.changed()
    try {
      // Never release a lease acquired by another operation or another session.
      const leases = edit.leases.filter(lease => this.client.leases.get(lease.resourceId.slice(5))?.id === lease.id && !this.retained(lease.id))
      await this.client.releaseLeases(leases, true)
    } catch (error) {
      this.error = '释放写权尚未确认，已停止续租；草稿保留在本窗口'
      throw error
    } finally { this.pending = null; this.changed() }
  }
  clear() { this.edits.clear(); this.changed() }
}
