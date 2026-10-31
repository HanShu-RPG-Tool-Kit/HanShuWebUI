import assert from 'node:assert/strict'
import JSZip from 'jszip'
import {
  createReputation,
  parseReputation,
  reputationBarRatio,
  reputationStanding,
  stringifyReputation,
} from '../src/workspaces/gameplay/reputation'
import { sourcePathOf, type Workspace } from '../src/workspace'
import { sourcesToProgressDocuments, applyProgressDocumentsToWorkspace } from '../src/project/projectSession'
import { ensurePackageSections } from '../src/workspaces/gameplay/library'
import { buildCompileGraph } from '../src/export/compile'
import { exportPaks } from '../src/export/pack/exportPaks'

const guard = {
  ...createReputation(),
  defaultPoints: 1000,
  neutralPoints: 500,
  friendlyPoints: 1500,
  hostile: ['bandit'],
  attackedByMobs: true,
}
const bandit = {
  ...createReputation(),
  defaultPoints: 0,
  neutralPoints: 500,
  friendlyPoints: 1500,
  hostile: ['village_guard'],
  hidden: true,
}
assert.deepEqual(parseReputation(stringifyReputation(guard)), { ...guard, banner: undefined })
assert.equal(reputationStanding(guard, 499), 'hostile')
assert.equal(reputationStanding(guard, 500), 'neutral')
assert.equal(reputationStanding(guard, 1500), 'friendly')
assert.equal(reputationBarRatio(guard, 500), 0.25)
assert.equal(reputationBarRatio(guard, 1500), 0.75)
assert.equal(reputationBarRatio({ neutralPoints: 10, friendlyPoints: 10 }, 10), 1)
for (const bad of [
  { neutralPoints: 2, friendlyPoints: 1 },
  { hostile: ['x', 'x'] },
  { hidden: 'true' },
  { name: '卫兵' },
  { color: '#fff' },
  { version: 2 },
]) assert.throws(() => parseReputation(JSON.stringify({ ...createReputation(), ...bad })))

const scripts = [
  { id: 'guard', name: 'village_guard.rep', content: stringifyReputation(guard), updatedAt: 1 },
  { id: 'bandit', name: 'bandit.rep', content: stringifyReputation(bandit), updatedAt: 1 },
]
assert.equal(sourcePathOf(scripts[0]), 'src/reputations/village_guard.rep')
const langPath = 'assets/zh_cn/lang_rep/village_guard.lang'
const blob = new Blob([JSON.stringify({ name: '卫兵', description: '守护村庄' })])
const workspace: Workspace = {
  packages: [{
    id: 'p', name: 'rep', collapsed: false, scripts,
    assets: [{ id: 'lang', path: langPath, mime: 'application/json', size: blob.size, updatedAt: 1 }],
    assetFolders: [],
  }],
  activeScriptId: null, activeAssetId: null,
}
const state = ensurePackageSections({ documents: sourcesToProgressDocuments(scripts), folders: [], activeKey: null })
assert.equal(state.documents.every(d => d.package === 'reputation'), true)
assert.deepEqual(
  applyProgressDocumentsToWorkspace(workspace, state.documents, state.folders).packages[0].scripts.map(sourcePathOf).sort(),
  scripts.map(sourcePathOf).sort(),
)

const priorIndexedDB = globalThis.indexedDB
globalThis.indexedDB = {
  open: () => {
    const request: any = {}
    queueMicrotask(() => {
      request.result = {
        close: () => {},
        transaction: () => ({
          objectStore: () => ({
            get: () => {
              const read: any = {}
              queueMicrotask(() => { read.result = blob; read.onsuccess?.() })
              return read
            },
          }),
        }),
      }
      request.onsuccess?.()
    })
    return request
  },
} as unknown as IDBFactory

try {
  const graph = await buildCompileGraph(workspace)
  assert(!graph.diagnostics.some(d => d.severity === 'error'), JSON.stringify(graph.diagnostics))
  assert.equal(graph.artifacts.find(a => a.path === 'reputations/village_guard.rep')?.plane, 'server')
  assert(graph.artifacts.some(a => a.path === langPath))
  const exported = await exportPaks(workspace, { targets: ['server', 'client', 'combined'] })
  for (const pak of exported.packs) {
    const zip = await JSZip.loadAsync(await pak.blob.arrayBuffer())
    assert.equal(!!zip.file('reputations/village_guard.rep'), pak.target !== 'client')
  }
  workspace.packages[0].scripts = [scripts[0]]
  const missing = await buildCompileGraph(workspace)
  assert(missing.diagnostics.some(d => d.code === 'reputation_invalid' && d.message.includes('bandit')))
} finally {
  globalThis.indexedDB = priorIndexedDB
}
console.log('PASS reputation: strict Mod codec, hostile closure, lang_rep export and server-only faction artifacts')
