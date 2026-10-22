import type { LibraryEntry, PatchEntryRequest, SkinModel } from '../contracts/types'

export type EntryDraft = {
  name: string; folderId: string | null; model: SkinModel; tags: string[]
  licenseStatus: 'unspecified' | 'declared'; licenseName: string; licenseUrl: string; licenseNote: string
  author: string; sourceName: string; sourceUrl: string; sourceNote: string; note: string; customId: string
}
type Field = keyof EntryDraft
type Patch = Omit<PatchEntryRequest, 'revision' | 'resolvePending'>
type Pending = { revision: number; patch: Patch; snapshot: EntryDraft; fields: Field[] }
export type EntryDraftState = {
  base: LibraryEntry; draft: EntryDraft; remote: LibraryEntry | null; pending: Pending | null
  saving: boolean; error: string | null; storageError: string | null; saved: LibraryEntry | null
}
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const fields = (value: EntryDraft) => Object.keys(value) as Field[]
const licenseFields: Field[] = ['licenseStatus', 'licenseName', 'licenseUrl', 'licenseNote']
const provenanceFields: Field[] = ['author', 'sourceName', 'sourceUrl', 'sourceNote']

export function draftFromEntry(entry: LibraryEntry): EntryDraft {
  return {
    name: entry.name, folderId: entry.folderId, model: entry.model, tags: [...entry.tags],
    licenseStatus: entry.license.status, licenseName: entry.license.name ?? '',
    licenseUrl: entry.license.url ?? '', licenseNote: entry.license.note ?? '',
    author: entry.provenance.author ?? '', sourceName: entry.provenance.sourceName ?? '',
    sourceUrl: entry.provenance.sourceUrl ?? '', sourceNote: entry.provenance.sourceNote ?? '',
    note: entry.note, customId: entry.customId ?? '',
  }
}

export function entryDraftDirty(state: Pick<EntryDraftState, 'base' | 'draft'>) {
  return !equal(draftFromEntry(state.base), state.draft)
}

function patchFields(patch: Patch): Field[] {
  return Object.keys(patch).flatMap(key => key === 'license' ? licenseFields
    : key === 'provenance' ? provenanceFields : key in draftFromEntryShape ? [key as Field] : [])
}
const draftFromEntryShape: Record<Field, true> = {
  name: true, folderId: true, model: true, tags: true, licenseStatus: true, licenseName: true,
  licenseUrl: true, licenseNote: true, author: true, sourceName: true, sourceUrl: true,
  sourceNote: true, note: true, customId: true,
}

export function patchFromDraft(base: LibraryEntry, draft: EntryDraft, selected?: Field[]): Patch {
  const before = draftFromEntry(base)
  const changed = new Set((selected ?? fields(draft)).filter(field => !equal(before[field], draft[field])))
  const patch: Patch = {}
  if (changed.has('name')) patch.name = draft.name.trim() || base.name
  if (changed.has('folderId')) patch.folderId = draft.folderId
  if (changed.has('model')) patch.model = draft.model
  if (changed.has('tags')) patch.tags = [...draft.tags]
  if (changed.has('note')) patch.note = draft.note.trim()
  if (changed.has('customId')) patch.customId = draft.customId.trim() || null
  if (licenseFields.some(field => changed.has(field))) patch.license = {
    status: draft.licenseStatus,
    name: draft.licenseStatus === 'declared' ? draft.licenseName.trim() || null : null,
    url: draft.licenseStatus === 'declared' ? draft.licenseUrl.trim() || null : null,
    note: draft.licenseNote.trim() || null,
  }
  if (provenanceFields.some(field => changed.has(field))) patch.provenance = {
    author: draft.author.trim() || null, sourceName: draft.sourceName.trim() || null,
    sourceUrl: draft.sourceUrl.trim() || null, sourceNote: draft.sourceNote.trim() || null,
    originalCreatedAt: base.provenance.originalCreatedAt,
  }
  return patch
}

/** One window-local draft, independent of mounting and of the lifetime of a request.
 * A remote notification never advances a dirty draft's CAS baseline. */
export class EntryDraftSession {
  readonly key: string
  private storage?: Storage
  private state: EntryDraftState
  private listeners = new Set<() => void>()
  private queued = new Set<Field>()
  private send?: (body: PatchEntryRequest) => Promise<LibraryEntry>
  private running: Promise<void> | null = null
  constructor(key: string, entry: LibraryEntry, storage?: Storage) {
    this.key = key
    this.storage = storage
    this.state = { base: entry, draft: draftFromEntry(entry), remote: null, pending: null, saving: false, error: null, storageError: null, saved: null }
    try {
      const stored = JSON.parse(storage?.getItem(key) ?? 'null')
      if (stored?.base?.entryId === entry.entryId && Number.isSafeInteger(stored.base.revision) && stored.draft) {
        const shape = draftFromEntry(stored.base)
        if (fields(shape).every(field => field === 'folderId' ? stored.draft[field] === null || typeof stored.draft[field] === 'string' : Array.isArray(shape[field]) ? Array.isArray(stored.draft[field]) && stored.draft[field].every((v: unknown) => typeof v === 'string') : typeof stored.draft[field] === typeof shape[field])) {
          const pending = stored.pending && Number.isSafeInteger(stored.pending.revision) && stored.pending.patch && stored.pending.snapshot && Array.isArray(stored.pending.fields) ? stored.pending : null
          this.state = { ...this.state, base: stored.base, draft: stored.draft, pending }
        }
      }
    } catch { /* Invalid or unavailable recovery storage must not prevent editing. */ }
    this.observe(entry)
  }
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  bind(send: (body: PatchEntryRequest) => Promise<LibraryEntry>) { this.send = send }
  private publish(next: EntryDraftState) {
    this.state = next
    try {
      if (entryDraftDirty(next) || next.pending) this.storage?.setItem(this.key, JSON.stringify({ base: next.base, draft: next.draft, pending: next.pending }))
      else this.storage?.removeItem(this.key)
      this.state = { ...next, storageError: null }
    } catch { this.state = { ...next, storageError: '本窗口的草稿恢复存储不可用，请保存或复制修改后再关闭。' } }
    for (const listener of this.listeners) listener()
  }
  observe(entry: LibraryEntry) {
    if (entry.entryId !== this.state.base.entryId || entry.revision <= this.state.base.revision || entry.revision < (this.state.remote?.revision ?? 0)) return
    if (entryDraftDirty(this.state) || this.state.pending || this.state.saving) this.publish({ ...this.state, remote: entry })
    else this.publish({ ...this.state, base: entry, draft: draftFromEntry(entry), remote: null, error: null })
  }
  edit(next: Partial<EntryDraft> | ((draft: EntryDraft) => EntryDraft)) {
    this.publish({ ...this.state, draft: typeof next === 'function' ? next(this.state.draft) : { ...this.state.draft, ...next } })
  }
  setError(error: unknown) { this.publish({ ...this.state, error: error instanceof Error ? error.message : String(error) }) }
  request(patch: Patch) {
    for (const field of patchFields(patch)) this.queued.add(field)
    if (this.state.pending && !this.state.saving) return
    if (this.state.remote && !this.state.saving) return
    this.start()
  }
  private start(resolvePending = false) {
    if (this.running) return
    const run = this.flush(resolvePending)
    this.running = run
    void run.finally(() => {
      this.running = null
      if (this.state.saving) this.publish({ ...this.state, saving: false })
      if (this.queued.size && !this.state.pending && !this.state.remote) this.start()
    })
  }
  private async flush(resolvePending: boolean) {
    while (this.queued.size && this.send) {
      if (this.state.remote && !resolvePending) return
      const selected = [...this.queued]; this.queued.clear()
      const patch = patchFromDraft(this.state.base, this.state.draft, selected)
      if (!Object.keys(patch).length) continue
      const pending: Pending = { revision: this.state.base.revision, snapshot: structuredClone(this.state.draft), patch, fields: patchFields(patch) }
      this.publish({ ...this.state, pending, saving: true, error: null })
      try {
        const updated = await this.send({ ...patch, revision: pending.revision, ...(resolvePending ? { resolvePending: true } : {}) })
        this.acknowledge(pending, updated)
        resolvePending = false
      } catch (error) {
        // The durable receipt can finish before an old view's post-save refresh.
        // A disposed-view error must not turn that confirmed success into failure.
        if (this.state.pending !== pending) return
        this.publish({ ...this.state, saving: false, error: error instanceof Error ? error.message : String(error) })
        return
      }
    }
  }
  private acknowledge(pending: Pending, updated: LibraryEntry) {
    if (updated.entryId !== this.state.base.entryId || updated.revision < this.state.base.revision) return
    const before = draftFromEntry(this.state.base), acknowledged = draftFromEntry(updated)
    const draft = { ...this.state.draft }
    for (const field of fields(draft)) {
      const submitted = pending.fields.includes(field)
      if (equal(draft[field], submitted ? pending.snapshot[field] : before[field])) {
        Object.assign(draft, { [field]: acknowledged[field] })
      }
    }
    const remote = this.state.remote && this.state.remote.revision > updated.revision ? this.state.remote : null
    // A receipt describes the exact original commit, not necessarily today's
    // entry. Once it accounts for every local change, follow the newer remote
    // snapshot automatically. Extra typing still keeps its own CAS baseline.
    const followRemote = remote && !entryDraftDirty({ base: updated, draft })
    this.publish({ ...this.state, base: followRemote ? remote : updated,
      draft: followRemote ? draftFromEntry(remote) : draft,
      pending: null, error: null, saved: updated, remote: followRemote ? null : remote })
  }
  /** Called only for an authoritative successful receipt, never just matching text. */
  confirm(revision: number, patch: Patch, result: LibraryEntry) {
    const pending = this.state.pending
    if (!pending || pending.revision !== revision || !equal(pending.patch, patch)) return
    this.acknowledge(pending, result)
  }
  adoptRemote() {
    if (this.state.saving) return
    const base = this.state.remote ?? this.state.base
    this.queued.clear()
    this.publish({ ...this.state, base, draft: draftFromEntry(base), remote: null, pending: null, error: null })
  }
  /** Explicit user resolution: carry only locally edited fields onto the new base. */
  resubmit() {
    if (this.state.saving) return
    const base = this.state.remote ?? this.state.base
    const old = draftFromEntry(this.state.base), draft = draftFromEntry(base)
    for (const field of fields(draft)) if (!equal(old[field], this.state.draft[field])) Object.assign(draft, { [field]: this.state.draft[field] })
    this.publish({ ...this.state, base, draft, remote: null, pending: null, error: null })
    for (const field of fields(draft)) this.queued.add(field)
    this.start(true)
  }
}

const sessions = new Map<string, EntryDraftSession>()
export function recoverableEntryDrafts(scope: string): { entry: LibraryEntry; name: string }[] {
  const prefix = `hanshu.skinEntryDraft.v1:${scope}:`, recovered = new Map<string, { entry: LibraryEntry; name: string }>()
  try {
    const storage = globalThis.sessionStorage
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (!key?.startsWith(prefix)) continue
      try {
        const value = JSON.parse(storage.getItem(key) ?? 'null')
        if (typeof value?.base?.entryId === 'string' && typeof value?.draft?.name === 'string' && (value.pending || entryDraftDirty(value))) {
          recovered.set(value.base.entryId, { entry: value.base, name: value.draft.name })
        }
      } catch { /* Ignore malformed recovery records. */ }
    }
  } catch { /* In-memory drafts remain available when browser storage is full/disabled. */ }
  for (const [key, session] of sessions) {
    if (!key.startsWith(prefix)) continue
    const state = session.getSnapshot()
    if (state.pending || entryDraftDirty(state)) recovered.set(state.base.entryId, { entry: state.base, name: state.draft.name })
    else recovered.delete(state.base.entryId)
  }
  return [...recovered.values()]
}
/** sessionStorage isolates browser windows; the key isolates servers, projects and subjects. */
export function entryDraftSession(scope: string, entry: LibraryEntry) {
  const key = `hanshu.skinEntryDraft.v1:${scope}:${entry.entryId}`
  let session = sessions.get(key)
  if (!session) {
    let storage: Storage | undefined
    try { storage = globalThis.sessionStorage } catch { /* Surface storage failures on the first edit. */ }
    if (!storage) storage = { getItem: () => null, setItem: () => { throw new Error('Storage unavailable') }, removeItem: () => undefined }
    session = new EntryDraftSession(key, entry, storage)
    sessions.set(key, session)
  }
  return session
}
