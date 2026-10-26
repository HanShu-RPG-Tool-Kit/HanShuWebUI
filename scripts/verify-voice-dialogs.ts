import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { createVoiceOps, type VoiceOpsHost, type VoiceOpsPackage } from '../src/i18n/voiceOps'
import type { VoiceLibrary, VoiceUnitStatus } from '../src/i18n/voiceLibrary'
import type { ProjectDirectory, FileEdit } from '../src/project/serviceClient'

// Throwing probes detect any attempted cache/server access without deleting data
// or requiring an IndexedDB implementation in this Node verification process.
let cacheAccesses = 0
const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: {
  open() { cacheAccesses++; throw new Error('cache access probe') },
} })

function fixture(virtual = false, reference = false) {
  let resolveConfirmation!: (value: boolean) => void
  const confirmation = new Promise<boolean>(resolve => { resolveConfirmation = resolve })
  const messages: string[] = []
  const notices: string[] = []
  const submissions: FileEdit[][] = []
  let resolutions = 0
  let workspaceAccesses = 0
  let playbackChanges = 0
  const paths = new Map([['a', `assets/voice/a.${reference ? 'ref' : 'ogg'}`], ['b', 'assets/voice/b.ogg']])
  const makeLibrary = () => ({
    targetPathOf: (key: string) => `assets/voice/${key}.ogg`,
    refPathOf: (key: string) => `assets/voice/${key}.ref`,
    statusOf: (key: string): VoiceUnitStatus => ({
      state: 'playing', path: paths.get(key) ?? null, audioPath: 'assets/shared.ogg',
      source: reference && key === 'a' ? 'ref' : 'file', reason: null, info: null,
    }),
    togglePlay: () => { playbackChanges++ },
  }) as unknown as VoiceLibrary
  const makeHandle = () => ({
    resolve: (path: string) => { resolutions++; return path },
    client: {
      entry: () => ({}),
      apply: async (edits: FileEdit[]) => { submissions.push(edits); throw new Error('server submission probe') },
    },
  }) as unknown as ProjectDirectory
  const context: { library: VoiceLibrary | null; pkg: VoiceOpsPackage | null; handle: ProjectDirectory | null } = {
    library: makeLibrary(), pkg: { id: 'original-package', assets: [] }, handle: virtual ? null : makeHandle(),
  }
  const host: VoiceOpsHost = {
    library: () => context.library,
    activePackage: () => context.pkg,
    projectHandle: () => context.handle,
    confirm: message => { messages.push(message); return confirmation },
    alert: async message => { notices.push(message) },
    notify: message => { notices.push(message) },
    getWorkspace: () => { workspaceAccesses++; throw new Error('unexpected workspace read') },
    commit: () => { workspaceAccesses++; throw new Error('unexpected workspace commit') },
    refresh: () => { workspaceAccesses++; throw new Error('unexpected refresh') },
  }
  return { context, paths, makeLibrary, makeHandle, ops: createVoiceOps(host), resolveConfirmation,
    messages, notices, submissions, counts: () => ({ resolutions, workspaceAccesses, playbackChanges }) }
}

let checks = 0
try {
  for (const operation of ['single', 'batch'] as const) {
    const start = (f: ReturnType<typeof fixture>) => operation === 'single'
      ? f.ops.confirmAndDeleteVoice('a') : f.ops.deleteVoices(['a', 'b'])
    const mutations: [string, (f: ReturnType<typeof fixture>) => void][] = [
      ['project client replaced', f => { f.context.handle = f.makeHandle() }],
      ['project closed', f => { f.context.handle = null }],
      ['package switched', f => { f.context.pkg = { id: 'other-package', assets: [] } }],
      ['package closed', f => { f.context.pkg = null }],
      ['library replaced with identical paths', f => { f.context.library = f.makeLibrary() }],
      ['library closed', f => { f.context.library = null }],
      ['binding changed', f => { f.paths.set(operation === 'single' ? 'a' : 'b', 'assets/new-target.ogg') }],
      ['binding removed', f => { f.paths.delete(operation === 'single' ? 'a' : 'b') }],
    ]
    for (const [name, mutate] of mutations) {
      const f = fixture()
      const cacheBefore = cacheAccesses
      start(f)
      assert.equal(f.messages.length, 1)
      assert.equal(f.submissions.length, 0, 'confirmation must actually remain pending')
      mutate(f)
      f.resolveConfirmation(true)
      await nextTurn()
      assert.deepEqual(f.counts(), { resolutions: 0, workspaceAccesses: 0, playbackChanges: 0 }, `${operation}: ${name}`)
      assert.deepEqual(f.submissions, [])
      assert.deepEqual(f.notices, [], 'an attempted deletion would emit the probe error')
      assert.equal(cacheAccesses, cacheBefore)
      checks++
    }
    const cancelled = fixture()
    start(cancelled)
    cancelled.resolveConfirmation(false)
    await nextTurn()
    assert.deepEqual(cancelled.counts(), { resolutions: 0, workspaceAccesses: 0, playbackChanges: 0 })
    assert.deepEqual(cancelled.notices, [])
    checks++

    // Positive control proves the pending continuation and deletion probes run.
    // A new wrapper with the SAME client/package identity must remain valid.
    const accepted = fixture(false, true)
    start(accepted)
    accepted.context.handle = { ...accepted.context.handle! } as ProjectDirectory
    accepted.context.pkg = { ...accepted.context.pkg! }
    accepted.resolveConfirmation(true)
    await nextTurn()
    assert.equal(accepted.submissions.length, 1)
    assert.deepEqual(accepted.submissions[0].map(edit => edit.path), operation === 'single'
      ? ['assets/voice/a.ref'] : ['assets/voice/a.ref', 'assets/voice/b.ogg'])
    assert.match(accepted.notices[0], /server submission probe/)
    assert.equal(accepted.counts().workspaceAccesses, 0)
    checks++

    const virtual = fixture(true)
    const cacheBefore = cacheAccesses
    start(virtual)
    virtual.context.pkg = { id: 'other-virtual-package', assets: [] }
    virtual.resolveConfirmation(true)
    await nextTurn()
    assert.equal(cacheAccesses, cacheBefore, 'virtual package switch must not access IndexedDB')
    assert.deepEqual(virtual.notices, [])
    checks++

    const virtualAccepted = fixture(true)
    start(virtualAccepted)
    virtualAccepted.resolveConfirmation(true)
    await nextTurn()
    assert.equal(cacheAccesses, cacheBefore + 1, 'unchanged virtual context reaches the cache probe')
    assert.match(virtualAccepted.notices[0], /cache access probe/)
    checks++
  }
  console.log(`通过：${checks} 项真实 createVoiceOps 异步确认上下文/取消/正向提交与缓存探针回归`)
} finally {
  if (originalIndexedDB) Object.defineProperty(globalThis, 'indexedDB', originalIndexedDB)
  else Reflect.deleteProperty(globalThis, 'indexedDB')
}
