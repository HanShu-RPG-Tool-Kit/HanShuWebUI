import assert from 'node:assert/strict'
import JSZip from 'jszip'
import { createActor, parseActor, stringifyActor } from '../src/workspaces/gameplay/actor'
import { SCRIPT_TYPES, scriptTemplate } from '../src/scriptResources'
import { sourcePathOf, type Workspace } from '../src/workspace'
import { sourcesToProgressDocuments, applyProgressDocumentsToWorkspace } from '../src/project/projectSession'
import { ensurePackageSections } from '../src/workspaces/gameplay/library'
import { buildCompileGraph } from '../src/export/compile'
import { exportPaks } from '../src/export/pack/exportPaks'

assert(SCRIPT_TYPES.includes('actor'))
assert(!SCRIPT_TYPES.includes('entity' as never))
const doc = {
  ...createActor(),
  scripts: ['guard', 'watch'],
  tags: ['guard', 'guard'],
  freezeAi: true,
  display: { title: '&a卫兵', subtitle: '&7东门' },
  reputation: 'village_guard',
  dialogue: {
    talkId: '卫兵',
    playerRole: '玩家',
    entries: [
      { when: [{ kind: 'talk_unread', inject: 'village_intro' }], inject: 'village_intro' },
      { when: [], inject: 'village_idle' },
    ],
  },
  interactService: { type: 'shop' as const, param: { template: 'village' } },
}
assert.deepEqual(parseActor(stringifyActor(doc)), { ...doc, tags: ['guard'] })
assert.equal(stringifyActor(createActor()).includes('display'), false)
for (const bad of [
  { scripts: ['x', 'x'] },
  { scripts: ['../x'] },
  { scripts: ['kit/x'] },
  { freezeAi: 'true' },
  { extra: true },
  { tags: [''] },
  { version: 2 },
  { bossBar: { title: 'x' } },
  { dialogue: { talkId: 'a', playerRole: 'a', entries: [] } },
  { interactService: { type: 'shop', param: {} } },
]) assert.throws(() => parseActor(JSON.stringify({ ...createActor(), ...bad })))
assert.deepEqual(parseActor(JSON.stringify({ ...createActor(), display: null })).display, null)
assert.deepEqual(parseActor(JSON.stringify({ ...createActor(), reputation: null })).reputation, null)

const scripts = [
  { id: 'template', name: 'village.actor', content: stringifyActor(doc), updatedAt: 1 },
  { id: 'rep', name: 'village_guard.rep', content: JSON.stringify({
    format: 'rpgtoolkit:reputation-faction', version: 1,
    defaultPoints: 1000, neutralPoints: 500, friendlyPoints: 1500,
    hostile: [], hidden: false, attackedByMobs: true,
  }, null, 2), updatedAt: 1 },
  { id: 'shop', name: 'village.shop', content: JSON.stringify({
    format: 'hanshu.shop', version: 1, id: 'village-shop', name: 'name', tags: [], icon: null,
    stockSubject: 'infinite', visibility: [], availability: [], params: [], modifiers: [], script: [], entries: [],
  }, null, 2), updatedAt: 1 },
  { id: 'hs', name: 'town.hs', content: '@village_intro\n卫兵:你好//\n@village_idle\n卫兵:路过//\n', updatedAt: 1 },
  ...['guard', 'watch'].map(id => ({ id, name: `${id}.py`, srcKind: 'actor' as const, content: scriptTemplate('actor', 'default.py', id), updatedAt: 1 })),
]
assert.equal(sourcePathOf(scripts[0]), 'src/actors/village.actor')
assert.equal(sourcePathOf(scripts[1]), 'src/reputations/village_guard.rep')
assert.equal(sourcePathOf(scripts[4]), 'src/script/actor/guard.py')
const workspace: Workspace = { packages: [{ id: 'p', name: 'actors', collapsed: false, scripts, assets: [], assetFolders: [] }], activeScriptId: null, activeAssetId: null }
const state = ensurePackageSections({ documents: sourcesToProgressDocuments(scripts), folders: [], activeKey: null })
assert.equal(state.documents.find(d => d.name.endsWith('.actor'))?.package, 'actor')
assert.equal(state.documents.find(d => d.name.endsWith('.rep'))?.package, 'reputation')
assert.deepEqual(
  applyProgressDocumentsToWorkspace(workspace, state.documents, state.folders).packages[0].scripts.map(sourcePathOf).sort(),
  scripts.map(sourcePathOf).sort(),
)
const graph = await buildCompileGraph(workspace)
assert(!graph.diagnostics.some(d => d.severity === 'error'), JSON.stringify(graph.diagnostics))
assert.equal(graph.artifacts.find(a => a.path === 'actors/village.actor')?.plane, 'server')
assert(graph.artifacts.some(a => a.path === 'script/actor/guard.py'))
const exported = await exportPaks(workspace, { targets: ['server', 'client'] })
for (const pak of exported.packs) {
  const zip = await JSZip.loadAsync(await pak.blob.arrayBuffer())
  assert.equal(!!zip.file('actors/village.actor'), pak.target === 'server')
  assert.equal(!!zip.file('script/actor/guard.py'), pak.target === 'server')
}
workspace.packages[0].scripts = scripts.filter(s => s.id !== 'guard')
const missing = await buildCompileGraph(workspace)
assert(missing.diagnostics.some(d => d.code === 'actor_invalid' && d.message.includes('guard')))
assert(!missing.artifacts.some(a => a.path === 'actors/village.actor'))
console.log('PASS actor: extended Mod codec, refs, source/session roundtrip, server-only PAK and missing-reference rejection')
