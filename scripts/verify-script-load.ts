import assert from 'node:assert/strict'
import JSZip from 'jszip'
import {
  createScriptLoad,
  parseScriptLoad,
  stringifyScriptLoad,
  scriptLoadDocumentKey,
  scriptLoadPath,
  withScriptLoadViews,
  isScriptLoadDocumentKey,
  isBuiltinScriptDocumentKey,
  ensurePackageSections,
  SCRIPT_LOAD_TYPES,
} from '../src/workspaces/gameplay/library'
import {
  sourcesToProgressDocuments,
  applyProgressDocumentsToWorkspace,
  progressDocumentMatchesSource,
  progressSourceIdForDocument,
} from '../src/project/projectSession'
import { withBuiltinScripts, stripBuiltinScripts } from '../src/workspaces/gameplay/scriptResources'
import { sourcePathOf, type Workspace } from '../src/workspace'
import { buildCompileGraph } from '../src/export/compile'
import { exportPaks } from '../src/export/pack/exportPaks'

const empty = createScriptLoad()
assert.deepEqual(parseScriptLoad(stringifyScriptLoad(empty)), empty)
assert.deepEqual(parseScriptLoad('{"format":"rpgtoolkit:script-load","version":1,"scripts":["a","b"]}').scripts, ['a', 'b'])
for (const bad of [
  { scripts: ['x', 'x'] },
  { scripts: ['../x'] },
  { scripts: ['kit/x'] },
  { version: 2 },
  { extra: true },
  { scripts: [1] },
]) assert.throws(() => parseScriptLoad(JSON.stringify({ ...empty, ...bad })))

assert(isScriptLoadDocumentKey(scriptLoadDocumentKey('common')))
assert(!isBuiltinScriptDocumentKey(scriptLoadDocumentKey('common')))
assert(isBuiltinScriptDocumentKey('builtin:script:common:foo.js'))
assert(!isBuiltinScriptDocumentKey('builtin:script-load:player'))

const sources = [
  { id: 'js-common', name: 'economy.js', content: '// economy\n', srcKind: 'common' as const, updatedAt: 1 },
  { id: 'js-player', name: 'motd.js', content: '// motd\n', srcKind: 'player' as const, updatedAt: 2 },
  {
    id: 'source:src/script/common/load.json',
    name: 'load.json',
    content: stringifyScriptLoad({ ...empty, scripts: ['economy', 'missing_common'] }),
    srcKind: 'common' as const,
    updatedAt: 3,
  },
  {
    id: 'source:src/script/player/load.json',
    name: 'load.json',
    content: stringifyScriptLoad({ ...empty, scripts: ['motd'] }),
    srcKind: 'player' as const,
    updatedAt: 4,
  },
]
const docs = sourcesToProgressDocuments(sources)
assert.equal(docs.filter(d => isScriptLoadDocumentKey(d.key)).length, 2)
assert.equal(docs.find(d => d.key === scriptLoadDocumentKey('common'))?.name, '通用启动列表')
assert.equal(docs.find(d => d.key === scriptLoadDocumentKey('player'))?.name, '玩家启动列表')
assert.equal(docs.find(d => d.key === scriptLoadDocumentKey('common'))?.source.includes('economy'), true)
const commonDoc = docs.find(d => d.key === scriptLoadDocumentKey('common'))!
assert.equal(progressSourceIdForDocument(commonDoc), 'source:src/script/common/load.json')
assert(progressDocumentMatchesSource(commonDoc, sources[2]!))
assert(!progressDocumentMatchesSource(commonDoc, sources[0]!))
assert(!docs.some(doc => doc.key === sources[2]!.id), '虚入口键不得等于 source id，否则 setState 会误删 load.json')
assert(
  !sources.filter(s => s.name === 'load.json').some(script => !docs.some(doc => progressDocumentMatchesSource(doc, script))),
  '启动列表源文件必须能匹配到对应虚文档，否则每次保存都会当成 removed',
)

const workspace = {
  packages: [{ id: 'p', name: 'test', scripts: sources, assets: [], assetFolders: [] }],
  activePackageId: 'p',
  activeScriptId: null,
} as unknown as Workspace
const roundtrip = applyProgressDocumentsToWorkspace(workspace, docs, [])
const nextLoads = roundtrip.packages[0]!.scripts.filter(s => s.name === 'load.json')
assert.equal(nextLoads.length, 2)
assert.equal(sourcePathOf(nextLoads.find(s => s.srcKind === 'common')!), scriptLoadPath('common'))
assert.equal(sourcePathOf(nextLoads.find(s => s.srcKind === 'player')!), scriptLoadPath('player'))

const base = ensurePackageSections({ documents: docs.filter(d => !isScriptLoadDocumentKey(d.key)), folders: [], activeKey: null })
const view = withScriptLoadViews(withBuiltinScripts(base))
for (const type of SCRIPT_LOAD_TYPES) {
  assert(view.documents.some(d => d.key === scriptLoadDocumentKey(type)))
}
const stripped = stripBuiltinScripts(view)
assert(stripped.documents.some(d => isScriptLoadDocumentKey(d.key)), 'stripBuiltinScripts must keep script-load docs')

const graph = await buildCompileGraph(workspace)
const loadArts = graph.artifacts.filter(a => a.path === 'script/common/load.json' || a.path === 'script/player/load.json')
assert.equal(loadArts.length, 2)
assert(graph.diagnostics.some(d => d.code === 'script_load_missing' && d.severity === 'warning' && d.message.includes('missing_common')))
assert(!graph.diagnostics.some(d => d.code === 'script_load_missing' && d.message.includes('motd')))

const exported = await exportPaks(workspace, { targets: ['server'] })
const zip = await JSZip.loadAsync(await exported.packs[0]!.blob.arrayBuffer())
assert(zip.file('script/common/load.json'))
assert(zip.file('script/player/load.json'))
assert.equal(await zip.file('script/common/load.json')!.async('string'), sources[2]!.content)

console.log('PASS script-load: model, key collision, session roundtrip, virtual views, compile warning, PAK export')
