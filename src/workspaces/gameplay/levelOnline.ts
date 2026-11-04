import { parseLevelDocument, stringifyLevelDocument, type LevelDocument } from './levelDoc'
import type { EffectResource } from './effectResources'
import type { RegionEffectSections } from './regionEffects'

/** ControlHub methods for one in-game .level editing surface. The mod never writes the file. */
export const LEVEL_EDIT_BEGIN = 'level.edit.begin'
export const LEVEL_EDIT_SYNC = 'level.edit.sync'
export const LEVEL_EDIT_END = 'level.edit.end'
export const LEVEL_EDIT_STATUS = 'level.edit.status'
export const LEVEL_EDIT_CHANGED = 'level.edit.changed'
export const LEVEL_EDIT_CANCEL = 'level.edit.cancel'
export type NativeEditorAction = 'save' | 'undo' | 'redo' | 'effect_new'

export const LEVEL_ONLINE_VERSION = 1
export const LEVEL_ONLINE_HEARTBEAT_MS = 2500
/** Author JSON cap. Matches the mod document cap, which is 64KiB under the 2MiB transport envelope. */
export const LEVEL_ONLINE_MAX_BYTES = 2 * 1024 * 1024 - 64 * 1024

export const LEVEL_ONLINE_TOOLS = ['select', 'rect', 'circle', 'polygon', 'landmark'] as const
export type LevelOnlineTool = (typeof LEVEL_ONLINE_TOOLS)[number]
export type LevelOnlineSelection =
  | null
  | { kind: 'region'; id: string; area: number }
  | { kind: 'landmark'; id: string }

export type LevelDocumentIdentity = {
  projectId: string
  clientId: string
  resourceId: string
}

export type LevelOnlineHandle = {
  id: string
  selection: LevelOnlineSelection
  screenX: number
  screenY: number
} & Record<string, unknown>

export type LevelOnlineBox = { width: number; height: number }
export type LevelOnlineViewport = { x: number; y: number; width: number; height: number }

export type LevelOnlineMeta = {
  sessionId: string
  documentId: string
  revision: number
  handles: LevelOnlineHandle[]
  window: LevelOnlineBox | null
  viewport: LevelOnlineViewport | null
}

export type LevelOnlineSnapshot = {
  identity: LevelDocumentIdentity | null
  doc: LevelDocument
  selection: LevelOnlineSelection
  tool: LevelOnlineTool
  writable: boolean
}

export type LevelOnlineTransport = {
  request(method: string, params: unknown): Promise<unknown>
  subscribe(listener: (method: string, params: unknown) => void): () => void
  connected(): boolean
  generation(): number
}

export type LevelOnlineEffects = {
  preview(doc: LevelDocument): void
  cancelPreview(): void
  commit(doc: LevelDocument): void
  select(selection: LevelOnlineSelection): void
  meta(meta: LevelOnlineMeta | null): void
  nativePending?(pending: boolean): void
  action?(action: NativeEditorAction): void
}

export type LevelOnlineController = {
  readonly revision: number
  readonly sessionId: string | null
  readonly documentId: string | null
  configure(snapshot: LevelOnlineSnapshot): void
  acquire(): Promise<void>
  openEditor(): Promise<void>
  shortcut(action: NativeEditorAction): Promise<void>
  previewEffects(previewId: string, regionId: string, effects: RegionEffectSections | null, audio: boolean, sources?: EffectResource[]): Promise<void>
  release(): Promise<void>
  cancelGesture(reason?: string): boolean
  pulse(): void
  dispose(): void
}

type Gesture = { id: string; baseRevision: number; terminal: boolean }
type OwnedSession = { sessionId: string; documentId: string; controlGeneration: number }
type EditBody = {
  v: 1
  sessionId: string
  documentId: string
  revision: number
  document: Record<string, unknown>
  selection: LevelOnlineSelection
  tool: LevelOnlineTool
  writable: boolean
}

const PHASES = new Set(['select', 'begin', 'preview', 'commit', 'cancel'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Stable project + client + resource id. A bare file name is not an identity. */
export function levelDocumentId(identity: LevelDocumentIdentity | null | undefined): string | null {
  if (!identity) return null
  const projectId = identity.projectId.trim()
  const clientId = identity.clientId.trim()
  const resourceId = identity.resourceId.trim()
  if (!projectId || !clientId || !resourceId) return null
  const path = resourceId.startsWith('source:') ? resourceId.slice('source:'.length) : resourceId
  if (!path.includes('/')) return null
  return `project:${encodeURIComponent(projectId)}/client:${encodeURIComponent(clientId)}/resource:${encodeURIComponent(resourceId)}`
}

/** Author JSON, not the editor's internal `kind` area tag. */
export function authorLevelValue(doc: LevelDocument): Record<string, unknown> {
  return JSON.parse(stringifyLevelDocument(doc)) as Record<string, unknown>
}

export function sameLevelText(a: LevelDocument, b: LevelDocument): boolean {
  return stringifyLevelDocument(a) === stringifyLevelDocument(b)
}

/** Parse a defensive copy. The caller's object is left untouched. */
export function readAuthorLevelDocument(value: unknown): LevelDocument {
  if (!isRecord(value)) throw new Error('edit_invalid')
  return parseLevelDocument(JSON.stringify(cloneJson(value)))
}

export function readOnlineSelection(value: unknown): LevelOnlineSelection | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  const keys = Object.keys(value)
  if (value.kind === 'region') {
    if (keys.some((key) => !['kind', 'id', 'area'].includes(key))) return undefined
    if (typeof value.id !== 'string' || !value.id.trim()) return undefined
    if (!safeInteger(value.area)) return undefined
    return { kind: 'region', id: value.id, area: value.area }
  }
  if (value.kind === 'landmark') {
    if (keys.some((key) => !['kind', 'id'].includes(key))) return undefined
    if (typeof value.id !== 'string' || !value.id.trim()) return undefined
    return { kind: 'landmark', id: value.id }
  }
  return undefined
}

export function sameOnlineSelection(a: LevelOnlineSelection, b: LevelOnlineSelection): boolean {
  if (a === b) return true
  if (!a || !b || a.kind !== b.kind || a.id !== b.id) return false
  return a.kind === 'landmark' || b.kind === 'landmark' || a.area === b.area
}

export function levelStreamChord(event: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing?: boolean
}): 'save' | 'undo' | 'redo' | 'effect_new' | null {
  if (event.isComposing) return null
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null
  const key = event.key.toLowerCase()
  if (key === 's' && !event.shiftKey) return 'save'
  if (key === 'y') return 'redo'
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo'
  return null
}

function readBox(value: unknown): LevelOnlineBox | null {
  if (!isRecord(value) || !finiteNumber(value.width) || !finiteNumber(value.height)) return null
  if (value.width <= 0 || value.height <= 0) return null
  return { width: value.width, height: value.height }
}

function readViewport(value: unknown): LevelOnlineViewport | null {
  if (!isRecord(value) || !finiteNumber(value.x) || !finiteNumber(value.y) || !finiteNumber(value.width) || !finiteNumber(value.height)) return null
  if (value.width <= 0 || value.height <= 0) return null
  return { x: value.x, y: value.y, width: value.width, height: value.height }
}

function readHandle(value: unknown): LevelOnlineHandle | null {
  try {
    if (!isRecord(value) || typeof value.id !== 'string' || !value.id) return null
    if (!finiteNumber(value.screenX) || !finiteNumber(value.screenY)) return null
    const selection = readOnlineSelection(value.selection)
    if (selection === undefined) return null
    const copy = cloneJson(value)
    copy.id = value.id
    copy.selection = selection
    copy.screenX = value.screenX
    copy.screenY = value.screenY
    return copy as LevelOnlineHandle
  } catch {
    return null
  }
}

/** Read-only status. A document payload on status is ignored by the caller. */
export function readLevelOnlineStatus(value: unknown): Pick<LevelOnlineMeta, 'handles' | 'window' | 'viewport'> | null {
  if (!isRecord(value)) return null
  const handleSource = Array.isArray(value.handles) ? value.handles : Array.isArray(value.visibleHandles) ? value.visibleHandles : null
  const handles = handleSource ? handleSource.map(readHandle).filter((item): item is LevelOnlineHandle => !!item) : null
  const window = readBox(value.window) ?? readBox(value.mainWindow)
    ?? (finiteNumber(value.windowWidth) && finiteNumber(value.windowHeight) ? readBox({ width: value.windowWidth, height: value.windowHeight }) : null)
  const viewport = readViewport(value.viewport) ?? readViewport(value.embeddedViewport)
  if (!handles && !window && !viewport) return null
  return { handles: handles ?? [], window, viewport }
}

function payloadBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

function copySelection(selection: LevelOnlineSelection): LevelOnlineSelection {
  if (!selection) return null
  return selection.kind === 'region'
    ? { kind: 'region', id: selection.id, area: selection.area }
    : { kind: 'landmark', id: selection.id }
}

function readAck(result: unknown, sessionId: string, documentId: string): { revision: number } | null {
  if (!isRecord(result) || result.ok !== true) return null
  if (result.sessionId !== sessionId || result.documentId !== documentId) return null
  if (!safeInteger(result.revision)) return null
  return { revision: result.revision }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createLevelOnlineSession(options: {
  transport: LevelOnlineTransport
  effects: LevelOnlineEffects
  heartbeatMs?: number
}): LevelOnlineController {
  const { transport, effects } = options
  const heartbeatMs = options.heartbeatMs ?? LEVEL_ONLINE_HEARTBEAT_MS
  let epoch = 0
  let hold = false
  let revision = 0
  let committedText = ''
  let baseline = false
  let documentId: string | null = null
  let selection: LevelOnlineSelection = null
  let previewSelection: LevelOnlineSelection | undefined
  let tool: LevelOnlineTool = 'select'
  let writable = false
  let doc: LevelDocument | null = null
  let session: OwnedSession | null = null
  let gesture: Gesture | null = null
  const finished = new Set<string>()
  const endedIds = new Set<string>()
  let meta: LevelOnlineMeta | null = null
  let metaJson = ''
  let tail: Promise<unknown> = Promise.resolve()
  let syncQueued = false
  let syncDirty = false
  let timer: ReturnType<typeof setInterval> | null = null
  let disposed = false
  let cancelGate = 0
  let cancelGateSession: string | null = null

  const unsubscribe = transport.subscribe((method, params) => {
    if (method === LEVEL_EDIT_CHANGED) onChanged(params)
    if (!session || !isRecord(params) || params.v !== 1 || params.sessionId !== session.sessionId || params.documentId !== session.documentId) return
    if (method === 'level.editor.state' && typeof params.propertiesDirty === 'boolean') effects.nativePending?.(params.propertiesDirty)
    if (method === 'level.editor.action' && params.revision === revision && writable
      && (params.action === 'save' || params.action === 'undo' || params.action === 'redo' || params.action === 'effect_new')) effects.action?.(params.action)
  })

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task, task)
    tail = run.then(() => undefined, () => undefined)
    return run
  }

  function publish(next: LevelOnlineMeta | null) {
    const json = next ? JSON.stringify(next) : ''
    if (json === metaJson) return
    metaJson = json
    meta = next
    effects.meta(next)
  }

  function publishSession() {
    if (!session || !doc) {
      publish(null)
      return
    }
    publish({
      sessionId: session.sessionId,
      documentId: session.documentId,
      revision,
      handles: meta && meta.sessionId === session.sessionId ? meta.handles : [],
      window: meta && meta.sessionId === session.sessionId ? meta.window : null,
      viewport: meta && meta.sessionId === session.sessionId ? meta.viewport : null,
    })
  }

  function absorbStatus(result: unknown) {
    if (!session) return
    const view = readLevelOnlineStatus(result)
    if (!view) return
    publish({
      sessionId: session.sessionId,
      documentId: session.documentId,
      revision,
      handles: view.handles,
      window: view.window,
      viewport: view.viewport,
    })
  }

  function rememberFinished(id: string) {
    finished.add(id)
    if (finished.size > 200) {
      const oldest = finished.values().next().value
      if (oldest) finished.delete(oldest)
    }
  }

  function retireGesture() {
    if (gesture && !gesture.terminal) {
      gesture.terminal = true
      rememberFinished(gesture.id)
    }
  }

  function adoptSelection(next: LevelOnlineSelection) {
    previewSelection = undefined
    if (sameOnlineSelection(next, selection)) return
    selection = copySelection(next)
    effects.select(selection)
  }

  function discardPreview() {
    if (previewSelection !== undefined) {
      const changed = !sameOnlineSelection(previewSelection, selection)
      previewSelection = undefined
      if (changed) effects.select(copySelection(selection))
    }
    effects.cancelPreview()
  }

  /**
   * Tombstone the open gesture, then ask the game to drop its drag. No history bump.
   * A blind cancel also tombs the next unseen gesture until that round-trip ends.
   */
  function requestCancel(blind = false) {
    const activeId = gesture && !gesture.terminal ? gesture.id : undefined
    retireGesture()
    discardPreview()
    const owned = session
    if (!owned || disposed) return
    const body: Record<string, unknown> = {
      v: LEVEL_ONLINE_VERSION,
      sessionId: owned.sessionId,
      documentId: owned.documentId,
    }
    if (activeId) body.gestureId = activeId
    if (!activeId && blind) {
      cancelGate += 1
      cancelGateSession = owned.sessionId
      void transport.request(LEVEL_EDIT_CANCEL, body).then(() => undefined, () => undefined).finally(() => {
        cancelGate = Math.max(0, cancelGate - 1)
        if (cancelGate === 0) cancelGateSession = null
      })
      return
    }
    void transport.request(LEVEL_EDIT_CANCEL, body).then(() => undefined, () => undefined)
  }

  function buildBody(owned: OwnedSession): EditBody | null {
    if (!doc) return null
    const document = authorLevelValue(doc)
    if (payloadBytes(document) > LEVEL_ONLINE_MAX_BYTES) return null
    return {
      v: LEVEL_ONLINE_VERSION,
      sessionId: owned.sessionId,
      documentId: owned.documentId,
      revision,
      document,
      selection: copySelection(selection),
      tool,
      writable,
    }
  }

  async function endOwned(owned: OwnedSession) {
    if (endedIds.has(owned.sessionId)) return
    endedIds.add(owned.sessionId)
    try {
      await transport.request(LEVEL_EDIT_END, { v: LEVEL_ONLINE_VERSION, sessionId: owned.sessionId, documentId: owned.documentId })
    } catch {
      /* The lease also expires on its own. */
    }
  }

  function dropLocal() {
    effects.nativePending?.(false)
    session = null
    retireGesture()
    discardPreview()
    publish(null)
  }

  async function beginBody(token: number) {
    if (disposed || token !== epoch || !hold || session) return
    if (!transport.connected()) throw new Error('control_not_connected')
    if (!documentId || !doc) throw new Error('edit_invalid')
    const sessionId = crypto.randomUUID()
    const owned: OwnedSession = { sessionId, documentId, controlGeneration: transport.generation() }
    const body = buildBody(owned)
    if (!body) throw new Error('edit_invalid')
    let result: unknown
    try {
      result = await transport.request(LEVEL_EDIT_BEGIN, body)
    } catch (error) {
      if (token !== epoch || !hold) return
      throw error
    }
    if (token !== epoch || !hold || disposed) {
      await endOwned(owned)
      return
    }
    if (!transport.connected() || transport.generation() !== owned.controlGeneration) {
      await endOwned(owned)
      throw new Error('edit_unavailable')
    }
    const ack = readAck(result, sessionId, documentId)
    if (!ack || ack.revision !== revision) {
      await endOwned(owned)
      throw new Error(ack ? 'edit_stale' : 'edit_invalid')
    }
    session = owned
    publishSession()
    absorbStatus(result)
    startHeartbeat()
    void pollStatus()
  }

  function schedule(force = false) {
    if (force) syncDirty = true
    if (!syncDirty || !session || disposed) return
    if (syncQueued) return
    syncQueued = true
    void enqueue(async () => {
      syncQueued = false
      if (!syncDirty || !session || disposed) return
      syncDirty = false
      const token = epoch
      const owned = session
      const sentRevision = revision
      const body = buildBody(owned)
      if (!body) return
      let result: unknown
      try {
        result = await transport.request(LEVEL_EDIT_SYNC, body)
      } catch (error) {
        if (token !== epoch || session !== owned) return
        const message = errorMessage(error)
        if (message === 'edit_stale' && sentRevision === revision) dropLocal()
        else if (message === 'edit_unavailable' || message === 'edit_busy' || message === 'control_not_connected') dropLocal()
        return
      }
      if (token !== epoch || session !== owned) return
      const ack = readAck(result, owned.sessionId, owned.documentId)
      if (!ack || ack.revision !== sentRevision) {
        dropLocal()
        return
      }
      absorbStatus(result)
      if (syncDirty) schedule()
    })
  }

  async function pollStatus() {
    if (!session || disposed) return
    const token = epoch
    const owned = session
    let result: unknown
    try {
      result = await transport.request(LEVEL_EDIT_STATUS, { v: LEVEL_ONLINE_VERSION, sessionId: owned.sessionId, documentId: owned.documentId })
    } catch {
      return
    }
    if (token !== epoch || session !== owned) return
    absorbStatus(result)
  }

  function startHeartbeat() {
    if (timer !== null || heartbeatMs <= 0) return
    timer = setInterval(() => { void pulse() }, heartbeatMs)
  }

  function stopHeartbeat() {
    if (timer === null) return
    clearInterval(timer)
    timer = null
  }

  function pulse() {
    if (!hold || disposed) return
    if (!transport.connected()) {
      if (session) dropLocal()
      return
    }
    if (session && transport.generation() !== session.controlGeneration) {
      const stale = session
      dropLocal()
      void endOwned(stale)
    }
    if (!session) {
      const token = epoch
      void enqueue(() => beginBody(token)).catch(() => undefined)
      return
    }
    schedule(true)
    void pollStatus()
  }

  function onChanged(params: unknown) {
    if (!session || !isRecord(params) || params.v !== LEVEL_ONLINE_VERSION) return
    if (params.sessionId !== session.sessionId) return
    if (typeof params.documentId !== 'string' || params.documentId !== session.documentId || params.documentId !== documentId) return
    if (typeof params.gestureId !== 'string' || !params.gestureId) return
    if (typeof params.phase !== 'string' || !PHASES.has(params.phase)) return
    if (!safeInteger(params.baseRevision) || params.baseRevision !== revision) return
    const nextSelection = readOnlineSelection(params.selection)
    if (nextSelection === undefined) return
    const phase = params.phase
    if (phase === 'select') {
      adoptSelection(nextSelection)
      return
    }
    if (cancelGate > 0 && cancelGateSession === session.sessionId) {
      rememberFinished(params.gestureId)
      if (gesture?.id === params.gestureId) gesture.terminal = true
      discardPreview()
      return
    }
    if (finished.has(params.gestureId)) return
    if (gesture?.terminal && gesture.id === params.gestureId) return
    if (gesture && !gesture.terminal && gesture.id !== params.gestureId) {
      gesture.terminal = true
      rememberFinished(gesture.id)
      discardPreview()
    }
    if (!gesture || gesture.id !== params.gestureId || gesture.terminal) {
      gesture = { id: params.gestureId, baseRevision: params.baseRevision, terminal: false }
    }
    if (phase === 'begin') return
    if (phase === 'cancel') {
      gesture.terminal = true
      rememberFinished(gesture.id)
      discardPreview()
      return
    }
    if (phase !== 'preview' && phase !== 'commit') return
    if (!writable || !('document' in params)) {
      if (phase === 'commit') {
        gesture.terminal = true
        rememberFinished(gesture.id)
        discardPreview()
      }
      return
    }
    let parsed: LevelDocument
    try {
      parsed = readAuthorLevelDocument(params.document)
    } catch {
      return
    }
    if (phase === 'preview') {
      // A new object's preview selection may not exist in the committed author document yet.
      // Display it, but keep heartbeats and the gesture baseline on the confirmed selection.
      const previousShown = previewSelection === undefined ? selection : previewSelection
      previewSelection = copySelection(nextSelection)
      if (!sameOnlineSelection(previousShown, nextSelection)) effects.select(copySelection(nextSelection))
      effects.preview(parsed)
      return
    }
    gesture.terminal = true
    rememberFinished(gesture.id)
    adoptSelection(nextSelection)
    const text = stringifyLevelDocument(parsed)
    if (text !== committedText) {
      revision += 1
      committedText = text
      doc = parsed
      effects.commit(parsed)
      publishSession()
      schedule(true)
    } else {
      discardPreview()
    }
  }

  function configure(snapshot: LevelOnlineSnapshot) {
    if (disposed) return
    const nextId = levelDocumentId(snapshot.identity)
    const nextText = stringifyLevelDocument(snapshot.doc)
    const identityChanged = baseline && nextId !== documentId
    const textChanged = baseline && nextText !== committedText
    const shownPreview = previewSelection !== undefined && sameOnlineSelection(snapshot.selection, previewSelection)
    const nextSelection = shownPreview ? selection : snapshot.selection
    const selectionChanged = baseline && !sameOnlineSelection(nextSelection, selection)
    const toolChanged = baseline && snapshot.tool !== tool
    const writableChanged = baseline && snapshot.writable !== writable
    if (identityChanged) {
      const owned = session
      requestCancel()
      epoch += 1
      session = null
      syncDirty = false
      stopHeartbeat()
      documentId = nextId
      selection = copySelection(snapshot.selection)
      previewSelection = undefined
      tool = LEVEL_ONLINE_TOOLS.includes(snapshot.tool) ? snapshot.tool : 'select'
      doc = snapshot.doc
      writable = snapshot.writable
      if (textChanged) {
        revision += 1
        committedText = nextText
      }
      publish(null)
      if (!owned && !hold) return
      const token = epoch
      void enqueue(async () => {
        if (owned) await endOwned(owned)
        if (!hold || token !== epoch || disposed || !documentId) return
        await beginBody(token)
      }).catch(() => undefined)
      return
    }
    documentId = nextId
    selection = copySelection(nextSelection)
    tool = LEVEL_ONLINE_TOOLS.includes(snapshot.tool) ? snapshot.tool : 'select'
    doc = snapshot.doc
    if (!baseline) {
      baseline = true
      committedText = nextText
      writable = snapshot.writable
      return
    }
    if (textChanged || selectionChanged || toolChanged || writableChanged) requestCancel()
    if (textChanged) {
      revision += 1
      committedText = nextText
    }
    writable = snapshot.writable
    if (session && (textChanged || selectionChanged || toolChanged || writableChanged)) schedule(true)
  }

  let lastSourceBundle = ''
  return {
    get revision() { return revision },
    get sessionId() { return session?.sessionId ?? null },
    get documentId() { return documentId },
    configure,
    openEditor() {
      return enqueue(async () => {
        if (!session) throw new Error('edit_unavailable')
        await transport.request('level.editor.open', { v: 1, sessionId: session.sessionId, documentId: session.documentId })
      })
    },
    shortcut(action) {
      return enqueue(async () => {
        if (!session) throw new Error('edit_unavailable')
        await transport.request('level.editor.shortcut', { v: 1, sessionId: session.sessionId, documentId: session.documentId, action })
      })
    },
    previewEffects(previewId, regionId, preview, audio, sources = []) {
      return enqueue(async () => {
        if (!session) { if (preview === null) return; throw new Error('请先连接游戏并开启在线视口') }
        const signature = JSON.stringify([session, sources])
        const payload = signature === lastSourceBundle ? {} : { sources }
        await transport.request('level.effects.preview', { v: 1, sessionId: session.sessionId, documentId: session.documentId, revision,
          previewId, regionId, effects: preview, stop: preview === null, audio, ...payload })
        lastSourceBundle = preview === null ? '' : signature
      })
    },
    acquire() {
      if (disposed) return Promise.reject(new Error('edit_unavailable'))
      hold = true
      const token = epoch
      return enqueue(async () => {
        await beginBody(token)
        if (token !== epoch || !session) throw new Error(transport.connected() ? 'edit_unavailable' : 'control_not_connected')
      })
    },
    release() {
      lastSourceBundle = ''
      effects.nativePending?.(false)
      hold = false
      epoch += 1
      stopHeartbeat()
      return enqueue(async () => {
        const owned = session
        session = null
        retireGesture()
        discardPreview()
        publish(null)
        if (owned) await endOwned(owned)
      })
    },
    cancelGesture() {
      const active = !!gesture && !gesture.terminal
      requestCancel(true)
      return active
    },
    pulse,
    dispose() {
      if (disposed) return
      disposed = true
      effects.nativePending?.(false)
      hold = false
      epoch += 1
      stopHeartbeat()
      unsubscribe()
      const owned = session
      session = null
      retireGesture()
      publish(null)
      if (owned) void endOwned(owned)
    },
  }
}
