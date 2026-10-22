import assert from 'node:assert/strict'
import { EntryDraftSession, draftFromEntry, entryDraftDirty } from '../src/skin/local/entryDraft'
import type { LibraryEntry, PatchEntryRequest } from '../src/skin/contracts/types'

function entry(patch: Partial<LibraryEntry> = {}): LibraryEntry {
  return { entryId: 'skin-a', skinId: 'content-a', name: 'Original', active: true, tags: [], folderId: null,
    favorite: false, model: 'classic', textureWidth: 64, textureHeight: 64, source: { kind: 'png-file' },
    provenance: { author: 'Original author', sourceName: null, sourceUrl: null, sourceNote: null, originalCreatedAt: null },
    license: { status: 'unspecified', name: null, url: null, note: null }, note: '', customId: null,
    createdAt: '2026-10-22', updatedAt: '2026-10-22', revision: 1, ...patch }
}
function storage() {
  const map = new Map<string, string>()
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value) }, removeItem: (key: string) => { map.delete(key) } }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
let passed = 0
async function test(name: string, run: () => void | Promise<void>) { await run(); passed++; console.log(`ok ${passed} - ${name}`) }

await test('remote notifications preserve dirty input and its old revision', () => {
  const session = new EntryDraftSession('a', entry(), storage())
  session.edit({ name: 'Typing…' })
  session.observe(entry({ name: 'Peer name', revision: 2 }))
  assert.equal(session.getSnapshot().draft.name, 'Typing…')
  assert.equal(session.getSnapshot().base.revision, 1)
  assert.equal(session.getSnapshot().remote?.name, 'Peer name')
})
await test('a clean entry follows remote updates', () => {
  const session = new EntryDraftSession('a', entry())
  session.observe(entry({ name: 'Peer name', revision: 2 }))
  assert.equal(session.getSnapshot().draft.name, 'Peer name')
  assert.equal(session.getSnapshot().base.revision, 2)
  assert.equal(session.getSnapshot().remote, null)
})
await test('unsubmitted inputs survive refresh without rebasing', () => {
  const disk = storage(), session = new EntryDraftSession('scope-a:entry-a', entry(), disk)
  session.edit({ name: 'Unsubmitted', folderId: 'folder-a' })
  const restored = new EntryDraftSession('scope-a:entry-a', entry({ revision: 5, name: 'Peer name' }), disk)
  assert.equal(restored.getSnapshot().draft.name, 'Unsubmitted')
  assert.equal(restored.getSnapshot().draft.folderId, 'folder-a')
  assert.equal(restored.getSnapshot().base.revision, 1)
  assert.equal(restored.getSnapshot().remote?.revision, 5)
  assert.equal(new EntryDraftSession('scope-b:entry-a', entry(), disk).getSnapshot().draft.name, 'Original')
})
await test('a successful old save cannot replace newer typing in the same field', async () => {
  const wait = deferred<LibraryEntry>(), session = new EntryDraftSession('a', entry())
  session.bind(() => wait.promise)
  session.edit({ name: 'First' }); session.request({ name: 'First' })
  session.edit({ name: 'Still typing' })
  wait.resolve(entry({ name: 'First', revision: 2 })); await tick()
  assert.equal(session.getSnapshot().draft.name, 'Still typing')
  assert.equal(session.getSnapshot().base.revision, 2)
  assert.equal(entryDraftDirty(session.getSnapshot()), true)
})
await test('rapid changes serialize and use the acknowledged revision', async () => {
  const wait = deferred<LibraryEntry>(), requests: PatchEntryRequest[] = [], session = new EntryDraftSession('a', entry())
  session.bind(async body => { requests.push(body); return requests.length === 1 ? wait.promise : entry({ name: 'First', note: body.note ?? '', revision: 3 }) })
  session.edit({ name: 'First' }); session.request({ name: 'First' })
  session.edit({ note: 'Second' }); session.request({ note: 'Second' })
  assert.equal(requests.length, 1)
  wait.resolve(entry({ name: 'First', revision: 2 })); await tick()
  assert.equal(requests.length, 2)
  assert.equal(requests[1].revision, 2)
  assert.equal(requests[1].note, 'Second')
  assert.equal(entryDraftDirty(session.getSnapshot()), false)
})
await test('a queued revert is not swallowed by comparison with the pre-save base', async () => {
  const wait = deferred<LibraryEntry>(), requests: PatchEntryRequest[] = [], session = new EntryDraftSession('a', entry())
  session.bind(async body => { requests.push(body); return requests.length === 1 ? wait.promise : entry({ revision: 3 }) })
  session.edit({ name: 'First' }); session.request({ name: 'First' })
  session.edit({ name: 'Original' }); session.request({ name: 'Original' })
  wait.resolve(entry({ name: 'First', revision: 2 })); await tick()
  assert.equal(requests.length, 2); assert.equal(requests[1].name, 'Original'); assert.equal(requests[1].revision, 2)
})
await test('a failure retains exact pending command and blocks accidental resubmission', async () => {
  let calls = 0
  const disk = storage(), session = new EntryDraftSession('a', entry(), disk)
  session.bind(async () => { calls++; throw new Error('locked') })
  session.edit({ name: 'First' }); session.request({ name: 'First' }); await tick()
  session.edit({ note: 'Later' }); session.request({ note: 'Later' }); await tick()
  assert.equal(calls, 1)
  assert.deepEqual(session.getSnapshot().pending?.patch, { name: 'First' })
  const restored = new EntryDraftSession('a', entry(), disk)
  assert.equal(restored.getSnapshot().draft.note, 'Later')
  assert.deepEqual(restored.getSnapshot().pending?.patch, { name: 'First' })
})
await test('receipt recovery clears only the acknowledged input and retains later changes', async () => {
  const disk = storage(), session = new EntryDraftSession('a', entry(), disk)
  session.bind(async () => { throw new Error('unknown result') })
  session.edit({ name: 'First' }); session.request({ name: 'First' }); await tick()
  session.edit({ note: 'Later' })
  const restored = new EntryDraftSession('a', entry({ revision: 2, name: 'First' }), disk)
  restored.confirm(1, { name: 'First' }, entry({ revision: 2, name: 'First' }))
  assert.equal(restored.getSnapshot().pending, null)
  assert.equal(restored.getSnapshot().remote, null)
  assert.equal(restored.getSnapshot().draft.name, 'First')
  assert.equal(restored.getSnapshot().draft.note, 'Later')
})
await test('matching text without a receipt does not acknowledge an unknown submission', async () => {
  const session = new EntryDraftSession('a', entry())
  session.bind(async () => { throw new Error('unknown result') })
  session.edit({ name: 'First' }); session.request({ name: 'First' }); await tick()
  session.observe(entry({ revision: 2, name: 'First' }))
  assert.equal(session.getSnapshot().base.revision, 1)
  assert.ok(session.getSnapshot().pending)
  session.confirm(1, { note: 'Unrelated command' }, entry({ revision: 2, name: 'First' }))
  assert.ok(session.getSnapshot().pending)
})
await test('a late disposed-view error cannot undo an authoritative successful receipt', async () => {
  const wait = deferred<LibraryEntry>(), session = new EntryDraftSession('a', entry())
  session.bind(() => wait.promise)
  session.edit({ name: 'First' }); session.request({ name: 'First' })
  session.confirm(1, { name: 'First' }, entry({ name: 'First', revision: 2 }))
  wait.reject(new Error('Old view disposed')); await tick()
  assert.equal(session.getSnapshot().error, null)
  assert.equal(session.getSnapshot().pending, null)
  assert.equal(session.getSnapshot().saving, false)
  assert.equal(session.getSnapshot().base.revision, 2)
})
await test('confirming a historical receipt follows a newer remote entry when no extra input remains', async () => {
  const session = new EntryDraftSession('a', entry())
  session.bind(async () => { throw new Error('unknown result') })
  session.edit({ name: 'First' }); session.request({ name: 'First' }); await tick()
  session.observe(entry({ revision: 3, name: 'Later peer edit' }))
  session.confirm(1, { name: 'First' }, entry({ revision: 2, name: 'First' }))
  assert.equal(session.getSnapshot().base.revision, 3)
  assert.equal(session.getSnapshot().draft.name, 'Later peer edit')
  assert.equal(session.getSnapshot().remote, null)
  assert.equal(session.getSnapshot().pending, null)
  assert.equal(entryDraftDirty(session.getSnapshot()), false)
})
await test('confirming a historical receipt preserves extra input and the newer remote conflict', async () => {
  const session = new EntryDraftSession('a', entry())
  session.bind(async () => { throw new Error('unknown result') })
  session.edit({ name: 'First' }); session.request({ name: 'First' }); await tick()
  session.edit({ note: 'Extra local input' })
  session.observe(entry({ revision: 3, name: 'Later peer edit' }))
  session.confirm(1, { name: 'First' }, entry({ revision: 2, name: 'First' }))
  assert.equal(session.getSnapshot().base.revision, 2)
  assert.equal(session.getSnapshot().draft.note, 'Extra local input')
  assert.equal(session.getSnapshot().remote?.revision, 3)
  assert.equal(session.getSnapshot().pending, null)
})
await test('explicit resolution keeps remote untouched fields, including nested provenance', async () => {
  const session = new EntryDraftSession('a', entry()), requests: PatchEntryRequest[] = []
  session.edit({ author: 'Local author' })
  const remote = entry({ revision: 2, name: 'Peer name', provenance: { ...entry().provenance, sourceUrl: 'https://peer.example/' } })
  session.observe(remote)
  session.bind(async body => { requests.push(body); return { ...remote, provenance: body.provenance!, revision: 3 } })
  session.resubmit(); await tick()
  assert.equal(requests[0].revision, 2)
  assert.equal(requests[0].resolvePending, true)
  assert.equal(requests[0].name, undefined)
  assert.equal(requests[0].provenance?.sourceUrl, 'https://peer.example/')
  assert.equal(requests[0].provenance?.author, 'Local author')
  assert.equal(entryDraftDirty(session.getSnapshot()), false)
})
await test('adopting remote clears only this draft and persisted recovery', () => {
  const disk = storage(), session = new EntryDraftSession('a', entry(), disk)
  session.edit({ name: 'Local' }); session.observe(entry({ name: 'Peer', revision: 2 })); session.adoptRemote()
  assert.equal(session.getSnapshot().draft.name, 'Peer'); assert.equal(disk.getItem('a'), null)
})
await test('storage failure remains visible and does not destroy in-memory input', () => {
  const session = new EntryDraftSession('a', entry(), { getItem: () => null, setItem: () => { throw new Error('quota') }, removeItem: () => {} })
  session.edit({ note: 'Must survive' })
  assert.equal(session.getSnapshot().draft.note, 'Must survive'); assert.ok(session.getSnapshot().storageError)
})
await test('out of order remote notifications cannot move the base backwards', () => {
  const session = new EntryDraftSession('a', entry({ revision: 3 }))
  session.observe(entry({ revision: 2, name: 'Stale' }))
  assert.deepEqual(session.getSnapshot().draft, draftFromEntry(entry({ revision: 3 })))
})
console.log(`Skin draft verification passed (${passed} scenarios).`)
