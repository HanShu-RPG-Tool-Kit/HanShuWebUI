import { request, ServiceError, type Lease, type Snapshot } from '../collab/protocol'
import type { ProjectClient } from './serviceClient'

/** Only a UI policy for the progress editor. S independently resolves and checks authority. */
export function progressEditingPath(path: string): string | null {
  if (/^src\/progress\/.+\.progress$/.test(path)) return path
  const language = /^assets\/[^/]+\/lang_progress\/(.+)\.lang$/.exec(path)
  if (language) return `src/progress/${language[1]}.progress`
  const voice = /^assets\/[^/]+\/voice_progress\/(.+)\/[^/]+$/.exec(path)
  return voice ? `src/progress/${voice[1]}.progress` : null
}

type Editing = { leaseId: string; lost: boolean; reason: string }

/** Explicit editor intent is separate from short-lived leases used by a file transaction. */
export class FileEditing {
  private edits = new Map<string, Editing>()
  private listeners = new Set<() => void>()
  private version = 0
  private focusTail: Promise<void> = Promise.resolve()
  private focusEpoch = 0
  focus: string | null = null
  pending: string | null = null
  error = ''
  observedAt: number
  private client: ProjectClient
  constructor(client: ProjectClient) { this.client = client; this.observedAt = client.serverNow() }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getVersion = () => this.version
  changed() { this.observedAt = this.client.serverNow(); this.version++; for (const listener of this.listeners) listener() }
  state(path: string) { return this.edits.get(path) }
  canEdit(path: string): boolean {
    const edit = this.edits.get(path)
    const lease = this.client.leases.get(path)
    return !!edit && !edit.lost && this.client.writable && lease?.id === edit.leaseId && lease.expiresAt > this.client.serverNow()
  }
  retained(id: string) { return [...this.edits.values()].some(edit => !edit.lost && edit.leaseId === id) }
  reconcile(online: boolean, snapshot: Snapshot) {
    for (const [path, edit] of this.edits) {
      if (edit.lost) continue
      const lease = snapshot.leases.find(item => item.id === edit.leaseId && item.sessionId === snapshot.session.id && item.expiresAt > this.client.serverNow())
      if (!online || snapshot.role === 'viewer' || !lease) {
        edit.lost = true
        edit.reason = !online ? '连接已断开，草稿保留在本窗口' : snapshot.role === 'viewer' ? '当前主体已改为只读，草稿已保留' : '写权已被接管或已到期，草稿已保留'
        // Stop renewing a suspended editor lease. Reconnection requires explicit intent.
        if (this.client.leases.get(path)?.id === edit.leaseId) this.client.leases.delete(path)
      }
    }
    this.changed()
  }
  setFocus(path: string | null) {
    if (path === this.focus) return
    this.focus = path; this.error = ''; this.changed()
    this.publishFocus()
  }
  publishFocus() {
    const epoch = ++this.focusEpoch
    // Serialize focus updates: an old request cannot overwrite the latest tab on S.
    this.focusTail = this.focusTail.catch(() => undefined).then(async () => {
      if (epoch !== this.focusEpoch || !this.client.online) return
      try {
        const snapshot = await request<Snapshot>(this.client.connection, '/api/presence', 'POST', { path: this.focus })
        this.client.setStatus(true, snapshot)
      } catch (error) {
        if (epoch !== this.focusEpoch) return
        this.error = `协作状态更新失败：${error instanceof Error ? error.message : String(error)}`
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
      acquired = await request<Lease[]>(this.client.connection, '/api/files/leases', 'POST', { paths: [path], force })
      const lease = acquired.find(item => item.resourceId === `file:${path}`)
      if (!lease) throw new Error('服务没有返回此文档的写权')
      for (const item of acquired) this.client.leases.set(item.resourceId.slice(5), item)
      const snapshot = await request<Snapshot>(this.client.connection, '/api/project')
      this.client.setStatus(true, snapshot)
      const confirmed = this.client.snapshot.leases.find(item => item.id === lease.id && item.sessionId === this.client.snapshot.session.id && item.expiresAt > this.client.serverNow())
      if (!confirmed || !this.client.writable) throw new Error('申请期间写权发生变化，请重新申请')
      this.edits.set(path, { leaseId: lease.id, lost: false, reason: '' })
      // Reconcile may have removed a previous suspended ID; retain only this confirmed lease.
      this.client.leases.set(path, confirmed)
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
      const lease = this.client.leases.get(path)
      // Never release a lease acquired by another operation or another session.
      if (lease?.id === edit.leaseId) await this.client.releaseLeases([lease], true)
    } catch (error) {
      this.error = '释放写权尚未确认，已停止续租；草稿保留在本窗口'
      throw error
    } finally { this.pending = null; this.changed() }
  }
  clear() { this.edits.clear(); this.changed() }
}
