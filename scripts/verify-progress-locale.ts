import assert from 'node:assert/strict'
import { createFlow, displayText, parseFlow } from '../src/workspaces/gameplay/model.ts'
import { createPredicateNode, createProgressNode, createObjectiveNode } from '../src/workspaces/gameplay/canvas.ts'
import {
  defaultFlowLocaleSeeds,
  defaultKitLocaleSeeds,
  defaultNavLocaleSeeds,
  ensureFlowLocaleKeys,
  ensureKitLocaleKeys,
  ensureNavLocaleKeys,
  ensureProgressLocaleKeys,
  flowNodeFieldKey,
  KIT_FEEDBACK_TITLE_KEY,
  KIT_NAME_KEY,
  NAV_LABEL_KEY,
} from '../src/workspaces/gameplay/progressLocale.ts'
import { createProgress, createProgressLocaleSeeds, stringifyProgress } from '../src/workspaces/gameplay/progressDoc.ts'
import { createKit, stringifyKit } from '../src/workspaces/gameplay/kit.ts'
import { createNavigationPoint, stringifyNavigationPoint } from '../src/workspaces/gameplay/navigationPoint.ts'
import { normalizeTextMapKey, TextMap, type TextSink } from '../src/i18n/textMap.ts'
import { textAssetPath } from '../src/i18n/localeLayout.ts'

assert.equal(textAssetPath('zh_cn', 'quest_a.quest'), 'assets/zh_cn/lang_quest/quest_a.lang')
assert.equal(textAssetPath('zh_cn', 'src/quest/main.quest'), 'assets/zh_cn/lang_quest/main.lang')
assert.equal(textAssetPath('zh_cn', 'tower.nav'), 'assets/zh_cn/lang_nav/tower.lang')
assert.equal(textAssetPath('zh_cn', 'starter.kit'), 'assets/zh_cn/lang_kit/starter.lang')
assert.equal(normalizeTextMapKey('entry.title', 'literal'), 'entry.title')
assert.equal(normalizeTextMapKey('7f3a91c2', 'hex'), '7f3a91c2')
assert.equal(normalizeTextMapKey('entry.title', 'hex'), '')
assert.equal(normalizeTextMapKey('feedback.message', 'literal'), 'feedback.message')

const memory: { text: string | null } = { text: null }
const sink: TextSink = {
  read: () => memory.text,
  write: (content) => { memory.text = content },
}
const map = new TextMap({ fileName: 't.lang', locale: 'zh_cn', sink, keyStyle: 'literal' })
map.load()
map.setMissing([['name', '驿站'], ['description', '说明']])
assert.equal(map.get('name'), '驿站')
map.setMissing([['name', '不应覆盖']])
assert.equal(map.get('name'), '驿站')
map.renameKey('name', 'name2')
assert.equal(map.get('name'), null)
assert.equal(map.get('name2'), '驿站')

const progress = createProgress('旧明文标题')
assert.equal(progress.name, 'name')
assert.deepEqual(createProgressLocaleSeeds('旧明文标题'), { name: '旧明文标题', description: '' })
const legacyProgress = {
  ...progress,
  name: '明文标题',
  description: '明文简介',
}
const migratedProgress = ensureProgressLocaleKeys(legacyProgress)
assert.equal(migratedProgress.doc.name, 'name')
assert.equal(migratedProgress.doc.description, 'description')
assert.deepEqual(migratedProgress.seeds, { name: '明文标题', description: '明文简介' })
assert.equal(JSON.parse(stringifyProgress(migratedProgress.doc)).name, 'name')

const flow = createFlow(undefined, '图标题')
const startNode = () => flow.progress[flow.start]!
assert.equal(startNode().questTitle!.text, '图标题')
assert.equal(defaultFlowLocaleSeeds('图标题')['progress.progress_start.questTitle'], '图标题')
assert.equal(defaultFlowLocaleSeeds('图标题')['progress.progress_start.runningLog'], '')
const migratedFlow = ensureFlowLocaleKeys(flow)
assert.equal(migratedFlow.flow.progress[flow.start]!.questTitle!.text, 'progress.progress_start.questTitle')
assert.equal(migratedFlow.seeds['progress.progress_start.questTitle'], '图标题')
assert.equal(migratedFlow.flow.progress[flow.start]!.identifier, 'start')
assert.equal(Object.hasOwn(migratedFlow.seeds, 'progress.progress_start.title'), false)
for (const translatedTitle of ['旅途开始', 'Journey begins']) {
  const resolve = (key: string) => key === 'progress.progress_start.questTitle' ? translatedTitle : null
  assert.equal(displayText(migratedFlow.flow.progress[flow.start]!.questTitle!, resolve), translatedTitle)
  assert.equal(migratedFlow.flow.progress[flow.start]!.identifier, 'start', 'language changes never translate the progress identifier')
}

const created = createProgressNode(flow, { x: 10, y: 20 })
assert.equal(created.flow.progress[created.id]!.identifier, 'progress_1')
assert.equal(Object.hasOwn(created.localeSeeds, flowNodeFieldKey('progress', created.id, 'title')), false)
assert.equal(ensureFlowLocaleKeys(created.flow).flow.progress[created.id]!.identifier, 'progress_1')
const sameIdentifier = ensureFlowLocaleKeys(created.flow)
assert.equal(Object.keys(sameIdentifier.seeds).some(key => key.endsWith('.identifier') || key.endsWith('.title') && key.startsWith('progress.')), false)
const renamedIdentifier = structuredClone(created.flow)
renamedIdentifier.progress[created.id]!.identifier = 'collect.apples'
assert.equal(ensureFlowLocaleKeys(renamedIdentifier).flow.progress[created.id]!.identifier, 'collect.apples', 'identifier resembling a locale key stays literal')

const predicate = createPredicateNode(created.flow, { x: 10, y: 200 })
const background=createObjectiveNode(created.flow,{x:10,y:400})
background.flow.objectives![background.id].goal={kind:'collect',params:{item:'minecraft:apple'}}
assert.deepEqual(ensureFlowLocaleKeys(background.flow).flow.objectives,background.flow.objectives)
assert.equal(Object.keys(ensureFlowLocaleKeys(background.flow).seeds).some(key=>key.startsWith('objectives.')),false,'background goals have no player-facing localization fields')
assert.equal(Object.hasOwn(predicate.flow.predicates![predicate.id]!, 'title'), false)
const migratedPredicate = ensureFlowLocaleKeys(parseFlow(JSON.stringify({
  ...predicate.flow,
  predicates: { ...predicate.flow.predicates, [predicate.id]: { ...predicate.flow.predicates![predicate.id], title: { text: '旧明文条件' } } },
})))
assert.equal(Object.hasOwn(migratedPredicate.flow.predicates![predicate.id]!, 'title'), false)
assert.equal(Object.hasOwn(migratedPredicate.seeds, flowNodeFieldKey('predicates', predicate.id, 'title')), false)

const nav = createNavigationPoint('旧塔')
assert.equal(nav.label, NAV_LABEL_KEY)
assert.deepEqual(defaultNavLocaleSeeds('旧塔'), { label: '旧塔' })
const legacyNav = { ...nav, label: '明文旧塔' }
const migratedNav = ensureNavLocaleKeys(legacyNav)
assert.equal(migratedNav.point.label, NAV_LABEL_KEY)
assert.equal(migratedNav.seeds[NAV_LABEL_KEY], '明文旧塔')
assert.equal(JSON.parse(stringifyNavigationPoint(migratedNav.point)).label, NAV_LABEL_KEY)

const kit = createKit('新手礼包')
assert.equal(kit.name, KIT_NAME_KEY)
assert.deepEqual(defaultKitLocaleSeeds('新手礼包'), { name: '新手礼包' })
const legacyKit = {
  ...kit,
  name: '明文礼包',
  feedback: { message: '', title: '欢迎', subtitle: '', sound: 'minecraft:entity.player.levelup' },
}
const migratedKit = ensureKitLocaleKeys(legacyKit)
assert.equal(migratedKit.kit.name, KIT_NAME_KEY)
assert.equal(migratedKit.kit.feedback.title, KIT_FEEDBACK_TITLE_KEY)
assert.equal(migratedKit.kit.feedback.message, '')
assert.equal(migratedKit.kit.feedback.sound, 'minecraft:entity.player.levelup')
assert.equal(migratedKit.seeds[KIT_NAME_KEY], '明文礼包')
assert.equal(migratedKit.seeds[KIT_FEEDBACK_TITLE_KEY], '欢迎')
assert.equal(JSON.parse(stringifyKit(migratedKit.kit)).feedback.title, KIT_FEEDBACK_TITLE_KEY)
assert.equal(JSON.parse(stringifyKit(migratedKit.kit)).feedback.sound, 'minecraft:entity.player.levelup')

console.log('PASS: quest/progress locale semantic keys, TextMap literal, layout paths')
