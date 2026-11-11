import assert from 'node:assert/strict'
import JSZip from 'jszip'
import { createActor, parseActor, stringifyActor } from '../src/workspaces/gameplay/actor'
import { actorDisplayLineForEditor } from '../src/workspaces/gameplay/actorDisplayText'
import { stringifyFeedbackText } from '../src/textComponent/model'
import { createItem, stringifyItem } from '../src/workspaces/gameplay/itemDoc'
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
  display: { mode: 'set' as const, title: '&a卫兵', subtitle: '&7东门' },
  reputation: { mode: 'set' as const, id: 'village_guard' },
  sounds: {
    hurt: { mode: 'set' as const, id: 'minecraft:entity.ravager.hurt' },
    death: { mode: 'mute' as const },
    ambient: { mode: 'set' as const, id: 'minecraft:entity.ravager.ambient' },
    melee: { mode: 'set' as const, id: 'minecraft:entity.player.attack.strong' },
    move: {
      mode: 'set' as const,
      ground: 'minecraft:block.stone.step',
      water: 'minecraft:entity.generic.swim',
      air: 'minecraft:entity.phantom.flap',
    },
  },
  loot: {
    xp: { mode: 'giveXp' as const, amount: 25 },
    item: {
      leave: false,
      items: [
        { item: 'kit_blade', id: '', count: 1, components: {}, chance: 0.35, playerKill: true },
        { id: 'minecraft:emerald', count: 2, components: {}, chance: 1, playerKill: false },
      ],
    },
  },
  dialogue: {
    talkId: '卫兵',
    playerRole: '玩家',
    entries: [
      { when: [{ kind: 'talk' as const, op: 'unread' as const, injectId: 'village_intro' }], inject: 'village_intro' },
      { when: [], inject: 'village_idle' },
    ],
  },
  interactService: { type: 'shop' as const, param: { templates: ['village'] } },
}
assert.deepEqual(parseActor(stringifyActor(doc)), { ...doc, tags: ['guard'] })
assert.deepEqual(
  parseActor(JSON.stringify({ ...createActor(), interactService: { type: 'shop', param: { template: 'village' } } })).interactService,
  { type: 'shop', param: { templates: ['village'] } },
)
assert.deepEqual(
  JSON.parse(stringifyActor({ ...createActor(), interactService: { type: 'shop', param: { templates: ['a', 'b'] } } })).interactService,
  { type: 'shop', param: { templates: ['a', 'b'] } },
)
assert.deepEqual(
  parseActor(JSON.stringify({
    ...createActor(),
    dialogue: {
      talkId: '卫兵', playerRole: '玩家',
      entries: [{ when: [{ kind: 'talk_unread', inject: 'village_intro' }], inject: 'village_intro' }],
    },
  })).dialogue!.entries[0].when,
  [{ kind: 'talk', op: 'unread', injectId: 'village_intro' }],
)
assert.deepEqual(
  parseActor(JSON.stringify({
    ...createActor(),
    dialogue: {
      talkId: '卫兵', playerRole: '玩家',
      entries: [{ when: '!talkRead(ctx.player, "village_intro")', inject: 'village_intro' }],
    },
  })).dialogue!.entries[0].when,
  [{ kind: 'expr', source: '!talkRead(ctx.player, "village_intro")' }],
)
assert.equal(
  JSON.parse(stringifyActor(doc, { plane: 'pak' })).dialogue.entries[0].when,
  '(!talkRead(ctx.player, "village_intro"))',
)
assert.equal(JSON.parse(stringifyActor(doc, { plane: 'pak' })).dialogue.entries[1].when, '')
assert.equal(stringifyActor(createActor()).includes('display'), false)
assert.equal(stringifyActor(createActor()).includes('loot'), false)
assert.equal(stringifyActor(createActor()).includes('sounds'), false)
assert.deepEqual(parseActor(JSON.stringify({ ...createActor(), display: { mode: 'clear' } })).display, { mode: 'clear' })
assert.deepEqual(parseActor(JSON.stringify({ ...createActor(), reputation: { mode: 'leave' } })).reputation, { mode: 'leave' })
assert.deepEqual(parseActor(JSON.stringify({ ...createActor(), loot: {} })).loot, {})
assert.deepEqual(parseActor(JSON.stringify({ ...createActor(), loot: { xp: { mode: 'leave' } } })).loot, { xp: { mode: 'leave' } })
assert.deepEqual(parseActor(JSON.stringify({
  ...createActor(),
  loot: { item: { items: [{ item: 'kit_blade' }] } },
})).loot, { item: { leave: true, items: [{ item: 'kit_blade', id: '', count: 1, components: {}, chance: 1, playerKill: false }] } })
assert.deepEqual(parseActor(JSON.stringify({ ...createActor(), sounds: {} })).sounds, {})
assert.deepEqual(parseActor(JSON.stringify({ ...createActor(), sounds: { death: { mode: 'mute' } } })).sounds, { death: { mode: 'mute' } })
assert.deepEqual(parseActor(JSON.stringify({ ...createActor(), sounds: { hurt: { mode: 'leave' } } })).sounds, { hurt: { mode: 'leave' } })
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
  { interactService: { type: 'shop', param: { templates: [] } } },
  { interactService: { type: 'shop', param: { templates: ['a', 'a'] } } },
  { display: { title: '&a' } },
  { display: { mode: 'clear', title: 'x' } },
  { reputation: 'village_guard' },
  { reputation: { mode: 'set' } },
  { reputation: { mode: 'clear', id: 'x' } },
  { loot: { xp: { mode: 'giveXp' } } },
  { loot: { xp: { mode: 'leave', amount: 1 } } },
  { loot: { xp: { mode: 'dropXp', amount: -1 } } },
  { loot: { item: { leave: 'yes' } } },
  { loot: { item: { items: [{ item: 'a', id: 'minecraft:stick' }] } } },
  { loot: { item: { items: [{ id: 'minecraft:stick', chance: 2 }] } } },
  { loot: { bonus: true } },
  { sounds: { boom: { mode: 'mute' } } },
  { sounds: { hurt: { mode: 'set' } } },
  { sounds: { hurt: { mode: 'mute', id: 'minecraft:entity.ravager.hurt' } } },
  { sounds: { move: { mode: 'set', ground: 'minecraft:block.stone.step' } } },
  { sounds: { move: { mode: 'mute', ground: 'minecraft:block.stone.step', water: 'a', air: 'b' } } },
]) assert.throws(() => parseActor(JSON.stringify({ ...createActor(), ...bad })))
const richTitle = stringifyFeedbackText([{ text: '卫兵', color: '#55FF55' }])
assert.equal(richTitle.startsWith('{'), true)
assert.deepEqual(
  parseActor(JSON.stringify({
    ...createActor(),
    display: { mode: 'set', title: richTitle, subtitle: '&7东门' },
  })).display,
  { mode: 'set', title: richTitle, subtitle: '&7东门' },
)
assert.equal(actorDisplayLineForEditor('plain'), 'plain')
assert.equal(actorDisplayLineForEditor(richTitle), richTitle)
assert.equal(
  actorDisplayLineForEditor('&a卫兵'),
  stringifyFeedbackText([{ text: '卫兵', color: '#55FF55' }]),
)
assert.equal(
  actorDisplayLineForEditor('&6&l村长'),
  stringifyFeedbackText([{ text: '村长', color: '#FFAA00', bold: true }]),
)
assert.deepEqual(parseActor(JSON.stringify({ ...createActor(), display: null })).display, null)
assert.deepEqual(parseActor(JSON.stringify({ ...createActor(), reputation: null })).reputation, null)
assert.deepEqual(parseActor(JSON.stringify({ ...createActor(), loot: null })).loot, null)
assert.deepEqual(parseActor(JSON.stringify({ ...createActor(), sounds: null })).sounds, null)

const scripts = [
  { id: 'template', name: 'village.actor', content: stringifyActor(doc), updatedAt: 1 },
  { id: 'rep', name: 'village_guard.rep', content: JSON.stringify({
    format: 'rpgtoolkit:reputation-faction', version: 1,
    defaultPoints: 1000, neutralPoints: 500, friendlyPoints: 1500,
    hostile: [], hidden: false, attackedByMobs: true,
  }, null, 2), updatedAt: 1 },
  { id: 'shop', name: 'village.shop', content: JSON.stringify({
    format: 'hanshu.shop', version: 1, id: 'village-shop', name: 'name', tags: [], icon: null,
    stockSubject: 'infinite', params: [], modifiers: [], script: [], entries: [],
  }, null, 2), updatedAt: 1 },
  { id: 'blade', name: 'kit_blade.item', content: stringifyItem(createItem('minecraft:iron_sword')), updatedAt: 1 },
  { id: 'hs', name: 'town.hs', content: '@village_intro\n卫兵:你好//\n@village_idle\n卫兵:路过//\n', updatedAt: 1 },
  ...['guard', 'watch'].map(id => ({ id, name: `${id}.js`, srcKind: 'actor' as const, content: scriptTemplate('actor', 'default.js', id), updatedAt: 1 })),
]
assert.equal(sourcePathOf(scripts[0]), 'src/actors/village.actor')
assert.equal(sourcePathOf(scripts[1]), 'src/reputations/village_guard.rep')
assert.equal(sourcePathOf(scripts[3]), 'src/items/kit_blade.item')
assert.equal(sourcePathOf(scripts[5]), 'src/script/actor/guard.js')
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
assert(graph.artifacts.some(a => a.path === 'script/actor/guard.js'))
const exported = await exportPaks(workspace, { targets: ['server', 'client'] })
for (const pak of exported.packs) {
  const zip = await JSZip.loadAsync(await pak.blob.arrayBuffer())
  assert.equal(!!zip.file('actors/village.actor'), pak.target === 'server')
  assert.equal(!!zip.file('script/actor/guard.js'), pak.target === 'server')
}
workspace.packages[0].explorer = {
  version: 2,
  folders: [],
  placements: {},
  drafts: { 'src/actors/village.actor': true },
}
const drafted = await buildCompileGraph(workspace)
assert(drafted.diagnostics.some(d => d.code === 'draft_skipped' && d.message.includes('village.actor')))
assert(!drafted.artifacts.some(a => a.path === 'actors/village.actor'))
assert(drafted.artifacts.some(a => a.path === 'script/actor/guard.js'))
workspace.packages[0].explorer = undefined
workspace.packages[0].scripts = scripts.filter(s => s.id !== 'guard')
const missing = await buildCompileGraph(workspace)
assert(missing.diagnostics.some(d => d.code === 'actor_invalid' && d.message.includes('guard')))
assert(!missing.artifacts.some(a => a.path === 'actors/village.actor'))
console.log('PASS actor: extended Mod codec, refs, source/session roundtrip, server-only PAK and missing-reference rejection')
