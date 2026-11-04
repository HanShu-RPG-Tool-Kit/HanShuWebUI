import assert from 'node:assert/strict'
import { createLevelDocument, stringifyLevelDocument, type LevelDocument } from '../src/workspaces/gameplay/levelDoc.ts'
import { levelHistory, levelHistoryCommit } from '../src/workspaces/gameplay/levelEdit.ts'
import {
  LEVEL_EDIT_BEGIN,
  LEVEL_EDIT_CANCEL,
  LEVEL_EDIT_END,
  LEVEL_EDIT_STATUS,
  LEVEL_EDIT_SYNC,
  LEVEL_ONLINE_MAX_BYTES,
  authorLevelValue,
  createLevelOnlineSession,
  levelDocumentId,
  levelStreamChord,
  readAuthorLevelDocument,
  readLevelOnlineStatus,
  type LevelDocumentIdentity,
  type LevelOnlineController,
  type LevelOnlineEffects,
  type LevelOnlineSnapshot,
} from '../src/workspaces/gameplay/levelOnline.ts'

const identity: LevelDocumentIdentity = {
  projectId: 'project-A',
  clientId: 'client-A',
  resourceId: 'source:src/level/test.level',
}

function sample(): LevelDocument {
  return {
    tags: ['night'],
    regions: [{
      id: 'room',
      areas: [
        { kind: 'rect', x: [0, 4], z: [1, 5], y: [60.5, 70.25] },
        { kind: 'circle', center: [1.5, 2.5], radius: 3.5, y: 'all' },
        { kind: 'polygon', points: [[0, 0], [2.5, 0], [1, 2]], y: 'all' },
      ],
      custom_data: { note: 'keep' },
    }],
    landmarks: [{
      id: 'tower',
      kind: 'rpgtoolkit:pos',
      param: { x: 1.25, y: 70.5, z: 3 },
      custom_data: { nest: { ok: true } },
    }],
    custom_data: { owner: 'web' },
  }
}

function moved(doc: LevelDocument, x1: number): LevelDocument {
  const next = structuredClone(doc)
  const area = next.regions[0]!.areas[0]
  if (area?.kind === 'rect') area.x = [area.x[0], x1]
  return next
}

assert.equal(levelDocumentId(null), null)
assert.equal(levelDocumentId({ projectId: '', clientId: 'c', resourceId: 'source:src/level/a.level' }), null)
assert.equal(levelDocumentId({ projectId: 'p', clientId: 'c', resourceId: 'hub.level' }), null)
assert.equal(levelDocumentId({ projectId: 'p', clientId: 'c', resourceId: 'source:hub.level' }), null)
assert.equal(
  levelDocumentId(identity),
  'project:project-A/client:client-A/resource:source%3Asrc%2Flevel%2Ftest.level',
)

const authored = authorLevelValue(sample())
assert.equal('kind' in (authored.regions as { areas: Record<string, unknown>[] }[])[0]!.areas[0]!, false)
assert.equal(((authored.regions as { areas: { shape?: string }[] }[])[0]!.areas[1]!.shape), 'circle')
assert.equal('kind' in (authored.regions as { areas: object[] }[])[0]!.areas[1]!, false)
assert.equal(((authored.landmarks as { kind: string }[])[0]!.kind), 'rpgtoolkit:pos')
assert.equal(((authored.regions as { areas: { y: number[] }[] }[])[0]!.areas[0]!.y[0]), 60.5)
assert.equal(((authored.landmarks as { custom_data: { nest: { ok: boolean } } }[])[0]!.custom_data.nest.ok), true)
assert.deepEqual(authored.tags, ['night'])

const wire = structuredClone(authored) as Record<string, unknown>
const nested = (((wire.landmarks as { custom_data: { nest: { ok: boolean } } }[])[0]!.custom_data.nest))
const parsed = readAuthorLevelDocument(wire)
parsed.landmarks[0]!.custom_data.nest = { ok: false }
assert.equal(nested.ok, true)
wire.extra = true
assert.equal('extra' in parsed, false)

assert.equal(levelStreamChord({ key: 's', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }), 'save')
assert.equal(levelStreamChord({ key: 'z', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }), 'undo')
assert.equal(levelStreamChord({ key: 'z', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true }), 'redo')
assert.equal(levelStreamChord({ key: 'y', ctrlKey: false, metaKey: true, altKey: false, shiftKey: false }), 'redo')
assert.equal(levelStreamChord({ key: 's', ctrlKey: true, metaKey: false, altKey: true, shiftKey: false }), null)
assert.equal(levelStreamChord({ key: 's', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, isComposing: true }), null)
assert.equal(readLevelOnlineStatus({
  document: { regions: [] },
  visibleHandles: [{ id: 'h', selection: null, screenX: 3, screenY: 4, extra: 1 }],
  mainWindow: { width: 800, height: 600 },
  embeddedViewport: { x: 1, y: 2, width: 30, height: 40 },
})?.handles[0]?.screenX, 3)

type Call = { method: string; params: Record<string, unknown> }
type Gate = { resolve: (value: unknown) => void; reject: (error: unknown) => void; params: Record<string, unknown> }

function harness(doc = sample()) {
  const requests: Call[] = []
  const previews: LevelDocument[] = []
  const commits: LevelDocument[] = []
  const cancels: number[] = []
  const selections: unknown[] = []
  const metas: unknown[] = []
  const nativePending: boolean[] = []
  const nativeActions: string[] = []
  let receive: (method: string, params: unknown) => void = () => {}
  let connected = true
  let generation = 1
  let blockSync = false
  let blockCancel = false
  let failSync: string | null = null
  const syncGates: Gate[] = []
  const cancelGates: Gate[] = []
  const beginGates: Gate[] = []
  let blockBegin = false
  const effects: LevelOnlineEffects = {
    preview: (next) => previews.push(next),
    cancelPreview: () => cancels.push(cancels.length + 1),
    commit: (next) => commits.push(next),
    select: (next) => selections.push(next),
    meta: (next) => metas.push(next),
    nativePending: value => nativePending.push(value),
    action: action => nativeActions.push(action),
  }
  const controller = createLevelOnlineSession({
    heartbeatMs: 0,
    transport: {
      connected: () => connected,
      generation: () => generation,
      subscribe(listener) {
        receive = listener
        return () => { receive = () => {} }
      },
      request(method, params) {
        const body = (params ?? {}) as Record<string, unknown>
        requests.push({ method, params: body })
        if (method === LEVEL_EDIT_SYNC && failSync) return Promise.reject(new Error(failSync))
        if (method === LEVEL_EDIT_SYNC && blockSync) {
          return new Promise((resolve, reject) => syncGates.push({ resolve, reject, params: body }))
        }
        if (method === LEVEL_EDIT_CANCEL && blockCancel) {
          return new Promise((resolve, reject) => cancelGates.push({ resolve, reject, params: body }))
        }
        if (method === LEVEL_EDIT_BEGIN && blockBegin) {
          return new Promise((resolve, reject) => beginGates.push({ resolve, reject, params: body }))
        }
        if (method === LEVEL_EDIT_STATUS) {
          return Promise.resolve({
            ok: true,
            sessionId: body.sessionId,
            documentId: body.documentId,
            revision: body.revision ?? 0,
            document: moved(doc, 99),
            visibleHandles: [{ id: 'status-handle', selection: null, screenX: 11, screenY: 22 }],
            mainWindow: { width: 640, height: 480 },
            embeddedViewport: { x: 4, y: 5, width: 100, height: 80 },
          })
        }
        return Promise.resolve({
          ok: true,
          sessionId: body.sessionId,
          documentId: body.documentId,
          revision: body.revision ?? 0,
          handles: [{ id: 'begin-handle', selection: body.selection ?? null, screenX: 7, screenY: 8 }],
          window: { width: 1920, height: 1080 },
          viewport: { x: 1, y: 2, width: 1280, height: 720 },
        })
      },
    },
    effects,
  })
  const snapshot = (): LevelOnlineSnapshot => ({
    identity,
    doc,
    selection: null,
    tool: 'select',
    writable: true,
  })
  controller.configure(snapshot())
  return {
    controller, requests, previews, commits, cancels, selections, metas, nativePending, nativeActions, snapshot, doc,
    event(method: string, params: unknown) { receive(method, params) },
    setConnected(next: boolean) { connected = next },
    setGeneration(next: number) { generation = next },
    holdSync() { blockSync = true },
    holdCancel() { blockCancel = true },
    holdBegin() { blockBegin = true },
    failSyncWith(message: string | null) { failSync = message },
    releaseSync() {
      blockSync = false
      const gate = syncGates.shift()
      gate?.resolve({ ok: true, sessionId: gate.params.sessionId, documentId: gate.params.documentId, revision: gate.params.revision })
    },
    rejectSync(message: string) {
      blockSync = false
      const gate = syncGates.shift()
      gate?.reject(new Error(message))
    },
    releaseCancel() {
      blockCancel = false
      const gate = cancelGates.shift()
      gate?.resolve({ ok: true, sessionId: gate.params.sessionId, documentId: gate.params.documentId, revision: 0 })
    },
    releaseBegin(ok = true) {
      blockBegin = false
      const gate = beginGates.shift()
      if (!gate) return
      gate.resolve(ok ? {
        ok: true,
        sessionId: gate.params.sessionId,
        documentId: gate.params.documentId,
        revision: gate.params.revision,
      } : { ok: false, error: 'edit_invalid' })
    },
    notify(params: Record<string, unknown>) { receive('level.edit.changed', params) },
    async settle() {
      for (let index = 0; index < 12; index += 1) await Promise.resolve()
    },
  }
}

function changed(controller: LevelOnlineController, doc: LevelDocument, extra: Record<string, unknown>) {
  return {
    v: 1,
    sessionId: controller.sessionId,
    documentId: controller.documentId,
    baseRevision: extra.baseRevision ?? controller.revision,
    gestureId: extra.gestureId ?? 'gesture-1',
    phase: extra.phase ?? 'preview',
    selection: extra.selection ?? null,
    ...(extra.document === undefined && extra.phase !== 'select' && extra.phase !== 'begin' && extra.phase !== 'cancel'
      ? { document: authorLevelValue(doc) }
      : {}),
    ...extra,
  }
}

async function waitUntil(predicate: () => boolean) {
  for (let index = 0; index < 40 && !predicate(); index += 1) {
    await Promise.resolve()
  }
  assert.equal(predicate(), true)
}

const bare = createLevelOnlineSession({
  heartbeatMs: 0,
  transport: {
    connected: () => true,
    generation: () => 1,
    subscribe: () => () => {},
    request: async () => ({ ok: true }),
  },
  effects: { preview() {}, cancelPreview() {}, commit() {}, select() {}, meta() {} },
})
bare.configure({ identity: null, doc: createLevelDocument(), selection: null, tool: 'select', writable: true })
await assert.rejects(bare.acquire(), /edit_invalid/)
bare.dispose()

{
  const box = harness()
  await box.controller.acquire()
  assert.equal(box.requests[0]?.method, LEVEL_EDIT_BEGIN)
  assert.equal(box.requests[0]?.params.writable, true)
  assert.equal(box.controller.revision, 0)
  const started = box.requests.length
  const next = moved(box.doc, 8)
  box.controller.configure({ ...box.snapshot(), doc: next })
  await box.settle()
  assert.ok(box.requests.slice(started).some((item) => item.method === LEVEL_EDIT_SYNC), '文档改动要立刻同步')
  assert.equal(box.controller.revision, 1)
  box.controller.dispose()
}

{
  const box = harness()
  await box.controller.acquire()
  box.controller.configure({ ...box.snapshot(), doc: moved(box.doc, 8) })
  box.notify(changed(box.controller, box.doc, {
    phase: 'select',
    baseRevision: 0,
    gestureId: 'old-selection',
    selection: { kind: 'region', id: 'room', area: 0 },
    document: undefined,
  }))
  assert.equal(box.selections.length, 0, '过期选择不能替换当前选择')
  box.controller.dispose()
}

{
  const box = harness()
  await box.controller.acquire()
  const oldId = box.controller.documentId
  const oldSession = box.controller.sessionId
  box.holdSync()
  box.controller.pulse()
  await waitUntil(() => box.requests.some((item) => item.method === LEVEL_EDIT_SYNC))
  box.controller.configure({ ...box.snapshot(), identity: { ...identity, projectId: 'project-B' } })
  box.notify({
    v: 1,
    sessionId: oldSession,
    documentId: oldId,
    baseRevision: 0,
    gestureId: 'late-project-A',
    phase: 'commit',
    selection: { kind: 'region', id: 'room', area: 0 },
    document: authorLevelValue(moved(box.doc, 99)),
  })
  assert.equal(box.commits.length, 0, '旧工程的手势不能写进新工程')
  assert.notEqual(box.controller.documentId, oldId)
  box.releaseSync()
  box.controller.dispose()
}

{
  const box = harness()
  await box.controller.acquire()
  const before = box.cancels.length
  box.notify(changed(box.controller, moved(box.doc, 6), { phase: 'preview', gestureId: 'drag' }))
  assert.equal(box.previews.length, 1)
  box.controller.configure(box.snapshot())
  box.controller.pulse()
  await box.settle()
  assert.equal(box.cancels.length, before, '同一修订和同一选择的同步不能清掉拖动预览')
  box.notify(changed(box.controller, box.doc, { phase: 'select', gestureId: 'drag', selection: null, document: undefined }))
  assert.equal(box.selections.length, 0)
  assert.equal(box.cancels.length, before)
  box.controller.configure({ ...box.snapshot(), doc: moved(box.doc, 9) })
  box.notify(changed(box.controller, moved(box.doc, 6), { phase: 'preview', gestureId: 'drag', baseRevision: 0 }))
  assert.equal(box.previews.length, 1, '更高修订之后的迟到预览要丢掉')
  box.controller.dispose()
}

{
  const box = harness()
  await box.controller.acquire()
  let history = levelHistory(box.doc)
  const originalCommit = box.controller
  box.notify(changed(originalCommit, moved(box.doc, 8), { phase: 'commit', gestureId: 'once' }))
  history = levelHistoryCommit(history, box.commits[0]!)
  box.notify(changed(originalCommit, moved(box.doc, 8), { phase: 'commit', gestureId: 'once' }))
  box.notify(changed(originalCommit, moved(box.doc, 8), { phase: 'preview', gestureId: 'once' }))
  assert.equal(box.commits.length, 1)
  assert.equal(box.previews.length, 0)
  assert.equal(history.undo.length, 1)
  assert.equal(box.controller.revision, 1)
  const again = levelHistoryCommit(history, box.commits[0]!)
  assert.equal(again, history)
  box.controller.dispose()
}

{
  const box = harness()
  await box.controller.acquire()
  box.notify(changed(box.controller, moved(box.doc, 3), { phase: 'commit', gestureId: 'early' }))
  box.notify(changed(box.controller, moved(box.doc, 4), { phase: 'preview', gestureId: 'early' }))
  box.notify(changed(box.controller, moved(box.doc, 5), { phase: 'begin', gestureId: 'early', document: undefined }))
  assert.equal(box.commits.length, 1)
  assert.equal(box.previews.length, 0)
  box.controller.dispose()
}

{
  const box = harness()
  box.controller.configure({ ...box.snapshot(), writable: false })
  await box.controller.acquire()
  assert.equal(box.requests.find((item) => item.method === LEVEL_EDIT_BEGIN)?.params.writable, false)
  const beforeCancel = box.cancels.length
  box.notify(changed(box.controller, moved(box.doc, 8), { phase: 'preview', gestureId: 'ro' }))
  box.notify(changed(box.controller, moved(box.doc, 8), { phase: 'commit', gestureId: 'ro' }))
  assert.equal(box.previews.length, 0)
  assert.equal(box.commits.length, 0)
  assert.ok(box.cancels.length > beforeCancel)
  assert.equal(box.controller.revision, 0)
  box.controller.dispose()
}

{
  const box = harness()
  box.holdBegin()
  const first = box.controller.acquire()
  await waitUntil(() => box.requests.some((item) => item.method === LEVEL_EDIT_BEGIN))
  const staleId = String(box.requests[0]?.params.sessionId)
  box.controller.release()
  const second = box.controller.acquire()
  box.releaseBegin()
  await assert.rejects(first, /edit_unavailable/)
  await second
  const currentId = box.controller.sessionId
  assert.ok(box.requests.some((item) => item.method === LEVEL_EDIT_END && item.params.sessionId === staleId))
  assert.notEqual(currentId, staleId)
  assert.equal(box.requests.some((item) => item.method === LEVEL_EDIT_END && item.params.sessionId === currentId), false)
  await box.controller.release()
  const endedCurrent = box.requests.filter((item) => item.method === LEVEL_EDIT_END && item.params.sessionId === currentId)
  assert.equal(endedCurrent.length, 1)
  box.controller.dispose()
}

{
  const box = harness()
  await box.controller.acquire()
  const first = box.controller.sessionId
  box.notify(changed(box.controller, moved(box.doc, 6), { phase: 'preview', gestureId: 'live' }))
  box.setConnected(false)
  box.controller.pulse()
  assert.equal(box.controller.sessionId, null)
  assert.equal(box.commits.length, 0)
  assert.ok(box.cancels.length > 0)
  assert.equal(box.requests.some((item) => item.method === LEVEL_EDIT_END && item.params.sessionId === first), false)
  box.setConnected(true)
  box.controller.pulse()
  await box.settle()
  assert.ok(box.controller.sessionId)
  assert.notEqual(box.controller.sessionId, first)
  assert.equal(box.requests.filter((item) => item.method === LEVEL_EDIT_BEGIN).length, 2)
  box.controller.dispose()
}

{
  const box = harness()
  await box.controller.acquire()
  const first = box.controller.sessionId
  box.setGeneration(2)
  box.controller.pulse()
  await box.settle()
  assert.ok(box.requests.some((item) => item.method === LEVEL_EDIT_END && item.params.sessionId === first))
  assert.notEqual(box.controller.sessionId, first)
  box.controller.dispose()
}

{
  const box = harness()
  await box.controller.acquire()
  box.failSyncWith('edit_stale')
  box.controller.configure({ ...box.snapshot(), doc: moved(box.doc, 8) })
  await box.settle()
  assert.equal(box.controller.sessionId, null)
  assert.equal(box.commits.length, 0)
  box.controller.dispose()
}

{
  const box = harness()
  await box.controller.acquire()
  box.holdSync()
  box.controller.configure({ ...box.snapshot(), doc: moved(box.doc, 5) })
  await waitUntil(() => box.requests.filter((item) => item.method === LEVEL_EDIT_SYNC).length === 1)
  box.controller.configure({ ...box.snapshot(), doc: moved(box.doc, 6) })
  box.controller.configure({ ...box.snapshot(), doc: moved(box.doc, 7) })
  box.releaseSync()
  await waitUntil(() => box.requests.filter((item) => item.method === LEVEL_EDIT_SYNC).length >= 2)
  const syncs = box.requests.filter((item) => item.method === LEVEL_EDIT_SYNC)
  assert.equal(syncs.length, 2)
  const follow = syncs[1]!.params.document as { regions: { areas: { x: number[] }[] }[] }
  assert.equal(follow.regions[0]!.areas[0]!.x[1], 7)
  box.controller.dispose()
}

{
  const box = harness()
  await box.controller.acquire()
  const incoming = authorLevelValue(moved(box.doc, 6))
  const frozen = JSON.stringify(incoming)
  box.notify(changed(box.controller, box.doc, { phase: 'preview', gestureId: 'copy', document: incoming }))
  assert.equal(JSON.stringify(incoming), frozen)
  const preview = box.previews[0]!
  const nest = preview.landmarks[0]!.custom_data.nest as { ok: boolean }
  nest.ok = false
  assert.equal((incoming.landmarks as { custom_data: { nest: { ok: boolean } } }[])[0]!.custom_data.nest.ok, true)
  box.controller.dispose()
}

{
  const box = harness()
  await box.controller.acquire()
  box.notify(changed(box.controller, box.doc, {
    phase: 'preview',
    gestureId: 'bad',
    document: { tags: [], regions: [{ id: 'room', areas: [{ x: [0, 1], z: [0, 1], y: [5, 1] }] }], landmarks: [] },
  }))
  box.notify(changed(box.controller, box.doc, {
    phase: 'preview',
    gestureId: 'bad',
    document: { tags: [], regions: [{ id: 'room', areas: [{ x: [0, Number.NaN], z: [0, 1], y: 'all' }] }], landmarks: [] },
  }))
  assert.equal(box.previews.length, 0)
  box.notify(changed(box.controller, moved(box.doc, 6), { phase: 'preview', gestureId: 'bad' }))
  assert.equal(box.previews.length, 1)
  box.controller.dispose()
}

{
  const box = harness()
  await box.controller.acquire()
  box.notify(changed(box.controller, box.doc, { phase: 'begin', gestureId: 'g-cancel', document: undefined }))
  const before = box.controller.revision
  box.controller.cancelGesture()
  assert.equal(box.controller.revision, before)
  assert.equal(box.requests.at(-1)?.method, LEVEL_EDIT_CANCEL)
  assert.equal(box.requests.at(-1)?.params.gestureId, 'g-cancel')
  box.notify(changed(box.controller, moved(box.doc, 8), { phase: 'commit', gestureId: 'g-cancel' }))
  assert.equal(box.commits.length, 0)
  box.controller.dispose()
}

{
  const box = harness()
  await box.controller.acquire()
  box.holdCancel()
  box.controller.cancelGesture()
  box.notify(changed(box.controller, moved(box.doc, 8), { phase: 'commit', gestureId: 'unseen' }))
  assert.equal(box.commits.length, 0)
  box.releaseCancel()
  await box.settle()
  box.notify(changed(box.controller, moved(box.doc, 8), { phase: 'commit', gestureId: 'unseen' }))
  assert.equal(box.commits.length, 0)
  box.controller.dispose()
}

{
  const huge = sample()
  huge.custom_data = { blob: 'x'.repeat(LEVEL_ONLINE_MAX_BYTES) }
  const box = harness(huge)
  await assert.rejects(box.controller.acquire(), /edit_invalid/)
  assert.equal(box.requests.some((item) => item.method === LEVEL_EDIT_BEGIN), false)
  box.controller.dispose()
}

{
  const box = harness()
  await box.controller.acquire()
  await waitUntil(() => box.requests.some((item) => item.method === LEVEL_EDIT_STATUS))
  assert.equal(box.commits.length, 0, 'status 里的文档不能提交')
  const last = box.metas.at(-1) as { handles?: { id: string }[]; window?: { width: number }; viewport?: { width: number } } | null
  assert.equal(last?.handles?.[0]?.id, 'status-handle')
  assert.equal(last?.window?.width, 640)
  assert.equal(last?.viewport?.width, 100)
  box.controller.dispose()
}

{
  const box = harness()
  await box.controller.acquire()
  const endsBefore = box.requests.filter((item) => item.method === LEVEL_EDIT_END).length
  await box.controller.release()
  assert.equal(box.requests.filter((item) => item.method === LEVEL_EDIT_END).length, endsBefore + 1)
  await box.controller.release()
  assert.equal(box.requests.filter((item) => item.method === LEVEL_EDIT_END).length, endsBefore + 1)
  box.controller.dispose()
}

{
  const box = harness()
  await box.controller.acquire()
  const region = { kind: 'region' as const, id: 'room', area: 0 }
  box.notify(changed(box.controller, moved(box.doc, 8), { phase: 'commit', gestureId: 'created', selection: region }))
  assert.equal(box.commits.length, 1)
  assert.deepEqual(box.selections.at(-1), region)
  box.controller.dispose()
}

{
  const box = harness()
  await box.controller.acquire()
  box.holdSync()
  box.controller.pulse()
  await waitUntil(() => box.requests.some((item) => item.method === LEVEL_EDIT_SYNC))
  const kept = box.controller.sessionId
  box.notify(changed(box.controller, moved(box.doc, 8), { phase: 'commit', gestureId: 'ack-later' }))
  assert.equal(box.controller.revision, 1)
  box.rejectSync('edit_stale')
  await box.settle()
  assert.equal(box.controller.sessionId, kept, '旧心跳的 edit_stale 不能拆掉已经前进的会话')
  await waitUntil(() => box.requests.filter((item) => item.method === LEVEL_EDIT_SYNC).some((item) => item.params.revision === 1))
  box.controller.dispose()
}

{
  const box = harness()
  await box.controller.acquire()
  await box.controller.openEditor()
  assert.equal(box.requests.at(-1)?.method, 'level.editor.open')
  await box.controller.shortcut('save')
  assert.equal(box.requests.at(-1)?.params.action, 'save')
  const owner = { v: 1, sessionId: box.controller.sessionId, documentId: box.controller.documentId, revision: box.controller.revision }
  box.event('level.editor.state', { ...owner, propertiesDirty: true })
  assert.equal(box.nativePending.at(-1), true)
  box.event('level.editor.state', { ...owner, sessionId: 'other', propertiesDirty: false })
  assert.equal(box.nativePending.at(-1), true, 'another editor cannot release the native form guard')
  box.event('level.editor.action', { ...owner, action: 'save' })
  box.event('level.editor.action', { ...owner, revision: -1, action: 'undo' })
  box.event('level.editor.action', { ...owner, documentId: 'other', action: 'redo' })
  assert.deepEqual(box.nativeActions, ['save'])
  box.controller.configure({ ...box.snapshot(), writable: false })
  box.event('level.editor.action', { ...owner, action: 'save' })
  assert.deepEqual(box.nativeActions, ['save'], 'read-only native action cannot save')
  await box.controller.release()
  assert.equal(box.nativePending.at(-1), false)
  box.controller.dispose()
}

assert.equal(stringifyLevelDocument(sample()).includes('"kind": "rect"'), false)
{
  const box = harness()
  await box.controller.acquire()
  const draft = structuredClone(box.doc)
  draft.regions[0]!.areas.push({ kind: 'rect', x: [10, 15], z: [12, 17], y: [80, 83] })
  const temporary = { kind: 'region' as const, id: 'room', area: 3 }
  box.notify(changed(box.controller, draft, { phase: 'preview', gestureId: 'new-volume', selection: temporary }))
  assert.deepEqual(box.selections.at(-1), temporary)
  // React echoes the displayed preview selection while the committed document still has three areas.
  box.controller.configure({ ...box.snapshot(), selection: temporary })
  box.controller.pulse(); await box.settle()
  await waitUntil(() => box.requests.some(r => r.method === LEVEL_EDIT_SYNC))
  const heartbeat = box.requests.filter(r => r.method === LEVEL_EDIT_SYNC).at(-1)!
  assert.equal(heartbeat.params.selection, null, 'heartbeat retains the confirmed selection')
  assert.equal((heartbeat.params.document as { regions: { areas: unknown[] }[] }).regions[0]!.areas.length, 3)
  assert.equal(box.requests.filter(r => r.method === LEVEL_EDIT_CANCEL).length, 0, 'preview echo cannot cancel creation')
  box.notify(changed(box.controller, draft, { phase: 'commit', gestureId: 'new-volume', selection: temporary }))
  assert.equal(box.commits.length, 1)
  assert.equal(box.controller.revision, 1)
  box.controller.dispose()
}
{
  const box = harness()
  await box.controller.acquire()
  const target = { kind: 'region' as const, id: 'room', area: 0 }
  box.notify(changed(box.controller, moved(box.doc, 9), { phase: 'preview', gestureId: 'cancel-preview', selection: target }))
  box.controller.configure({ ...box.snapshot(), selection: target })
  assert.equal(box.controller.cancelGesture('history'), true, 'undo can distinguish a live preview from committed history')
  assert.equal(box.controller.cancelGesture('history'), false, 'the preview is cancelled exactly once')
  box.notify(changed(box.controller, box.doc, { phase: 'cancel', gestureId: 'cancel-preview' }))
  assert.equal(box.selections.at(-1), null, 'cancel restores the confirmed selection')
  assert.equal(box.commits.length, 0)
  box.controller.dispose()
}
console.log('PASS: level online session, history, stale, reorder, readonly, switch, recovery, preview selection isolation')
