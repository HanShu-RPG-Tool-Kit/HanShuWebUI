import assert from 'node:assert/strict'
import JSZip from 'jszip'
import {
  createQuestCatalog,
  createQuestCatalogDirectory,
  parseQuestCatalog,
  stringifyQuestCatalog,
  QUEST_CATALOG_DOCUMENT_KEY,
  QUEST_CATALOG_LABEL,
  QUEST_CATALOG_PATH,
  QUEST_CATALOG_LOCALE_NAME,
  isQuestCatalogDocumentKey,
  withQuestCatalogView,
  isBuiltinScriptDocumentKey,
  isQuestDocument,
  isSimpleQuestDocument,
} from '../src/workspaces/gameplay/library'
import {
  sourcesToProgressDocuments,
  applyProgressDocumentsToWorkspace,
  progressDocumentMatchesSource,
  progressSourceIdForDocument,
} from '../src/project/projectSession'
import { sourcePathOf, type Workspace } from '../src/workspace'
import { textAssetPath } from '../src/i18n/localeLayout'
import { buildCompileGraph } from '../src/export/compile'
import { exportPaks } from '../src/export/pack/exportPaks'
import { createProgress, stringifyProgress } from '../src/workspaces/gameplay/progressDoc'

const empty = createQuestCatalog()
assert.deepEqual(parseQuestCatalog(stringifyQuestCatalog(empty)), empty)

const { directory, localeSeeds } = createQuestCatalogDirectory('主线')
assert.equal(directory.title, `directories.${directory.id}.title`)
assert.equal(localeSeeds[directory.title], '主线')

assert.throws(() => parseQuestCatalog(JSON.stringify({
  format: 'hanshu.quest-catalog',
  version: 1,
  directories: [{ id: directory.id, title: directory.title, quests: ['a', 'a'] }],
})))

const parsed = parseQuestCatalog(stringifyQuestCatalog({
  ...empty,
  directories: [{ ...directory, quests: ['b', 'a'] }],
}))
assert.deepEqual(parsed.directories[0]!.quests, ['a', 'b'])
assert.equal(parsed.directories[0]!.icon, null)

const withIcon = parseQuestCatalog(stringifyQuestCatalog({
  ...empty,
  directories: [{
    ...directory,
    icon: { item: '', id: 'minecraft:writable_book', count: 1, components: {} },
    quests: ['intro'],
  }],
}))
assert.equal(withIcon.directories[0]!.icon?.id, 'minecraft:writable_book')
assert.equal(withIcon.directories[0]!.icon?.count, 1)

for (const bad of [
  { version: 2 },
  { extra: true },
  { directories: [{ id: 'x', title: 'wrong', quests: [] }] },
]) {
  assert.throws(() => parseQuestCatalog(JSON.stringify({
    format: 'hanshu.quest-catalog',
    version: 1,
    directories: [],
    ...bad,
  })))
}

assert(isQuestCatalogDocumentKey(QUEST_CATALOG_DOCUMENT_KEY))
assert(!isBuiltinScriptDocumentKey(QUEST_CATALOG_DOCUMENT_KEY))
assert.equal(textAssetPath('zh_cn', QUEST_CATALOG_LOCALE_NAME), 'assets/zh_cn/lang_quest/catalog.lang')

const questSource = stringifyProgress(createProgress('intro'))
const catalogSource = stringifyQuestCatalog({
  ...empty,
  directories: [{ ...directory, quests: ['intro', 'missing_quest'] }],
})
const sources = [
  { id: 'q1', name: 'intro.quest', content: questSource, updatedAt: 1 },
  {
    id: `source:${QUEST_CATALOG_PATH}`,
    name: 'catalog.json',
    content: catalogSource,
    updatedAt: 2,
  },
]
const docs = sourcesToProgressDocuments(sources)
assert.equal(docs.filter(d => isQuestCatalogDocumentKey(d.key)).length, 1)
const catalogDoc = docs.find(d => d.key === QUEST_CATALOG_DOCUMENT_KEY)!
assert.equal(catalogDoc.name, QUEST_CATALOG_LABEL)
assert.equal(progressSourceIdForDocument(catalogDoc), `source:${QUEST_CATALOG_PATH}`)
assert(progressDocumentMatchesSource(catalogDoc, sources[1]!))
assert(!progressDocumentMatchesSource(catalogDoc, sources[0]!))
assert(!docs.some(doc => doc.key === sources[1]!.id), '虚入口键不得等于 source id')
assert(!isQuestDocument(catalogDoc))
assert(!isSimpleQuestDocument(catalogDoc))

const workspace = {
  packages: [{ id: 'p', name: 'test', scripts: sources, assets: [], assetFolders: [] }],
  activePackageId: 'p',
  activeScriptId: null,
} as unknown as Workspace
const roundtrip = applyProgressDocumentsToWorkspace(workspace, docs, [])
const nextCatalog = roundtrip.packages[0]!.scripts.find(s => s.name === 'catalog.json')
assert(nextCatalog)
assert.equal(sourcePathOf(nextCatalog!), QUEST_CATALOG_PATH)

const view = withQuestCatalogView({
  documents: docs.filter(d => !isQuestCatalogDocumentKey(d.key)),
  folders: [],
  activeKey: null,
})
assert(view.documents.some(d => d.key === QUEST_CATALOG_DOCUMENT_KEY))

const graph = await buildCompileGraph(workspace)
assert(graph.artifacts.find(a => a.path === 'quest/catalog.json'))
assert(graph.diagnostics.some(d => d.code === 'quest_catalog_missing' && d.message.includes('missing_quest')))
assert(!graph.diagnostics.some(d => d.code === 'quest_catalog_missing' && d.message.includes('intro')))

// 导出只带 catalog，避免空目标 .quest 在 exportPaks 里升为硬错误
const exportWorkspace = {
  ...workspace,
  packages: [{
    ...workspace.packages[0]!,
    scripts: sources.filter(s => s.name === 'catalog.json'),
  }],
} as unknown as Workspace
const exported = await exportPaks(exportWorkspace, { targets: ['shared'] })
const zip = await JSZip.loadAsync(await exported.packs[0]!.blob.arrayBuffer())
assert(zip.file('quest/catalog.json'))
assert.equal(await zip.file('quest/catalog.json')!.async('string'), catalogSource)

console.log('PASS quest-catalog: model, session roundtrip, virtual view, compile warning, PAK export')
