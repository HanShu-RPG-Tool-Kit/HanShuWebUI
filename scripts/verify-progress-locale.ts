import assert from 'node:assert/strict'
import { createFlow, displayText, parseFlow } from '../src/workspaces/progress/model.ts'
import { createCheckpoint } from '../src/workspaces/progress/canvas.ts'
import {
  defaultFlowLocaleSeeds,
  defaultKitLocaleSeeds,
  defaultNavLocaleSeeds,
  ensureFlowLocaleKeys,
  ensureKitLocaleKeys,
  ensureNavLocaleKeys,
  ensureProgressLocaleKeys,
  flowEntryTitleKey,
  flowNodeFieldKey,
  KIT_FEEDBACK_TITLE_KEY,
  KIT_NAME_KEY,
  NAV_LABEL_KEY,
} from '../src/workspaces/progress/progressLocale.ts'
import { createProgress, createProgressLocaleSeeds, stringifyProgress } from '../src/workspaces/progress/progressDoc.ts'
import { createKit, stringifyKit } from '../src/workspaces/progress/kit.ts'
import { createNavigationPoint, stringifyNavigationPoint } from '../src/workspaces/progress/navigationPoint.ts'
import { normalizeTextMapKey, TextMap, type TextSink } from '../src/i18n/textMap.ts'
import { textAssetPath } from '../src/i18n/localeLayout.ts'

assert.equal(textAssetPath('zh_cn', 'quest_a.progress'), 'assets/zh_cn/lang_progress/quest_a.lang')
assert.equal(textAssetPath('zh_cn', 'story/main.hflow'), 'assets/zh_cn/lang_hflow/story/main.lang')
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
assert.equal(flow.entry.title.text, flowEntryTitleKey())
assert.deepEqual(defaultFlowLocaleSeeds('图标题')[flowEntryTitleKey()], '图标题')
const legacyFlow = parseFlow(JSON.stringify({
  ...flow,
  entry: { ...flow.entry, title: { text: '旧流程名' }, description: { text: '旧说明' } },
}))
const migratedFlow = ensureFlowLocaleKeys(legacyFlow)
assert.equal(migratedFlow.flow.entry.title.text, 'entry.title')
assert.equal(migratedFlow.seeds['entry.title'], '旧流程名')
assert.equal(migratedFlow.seeds['entry.description'], '旧说明')

const created = createCheckpoint(flow, { x: 10, y: 20 })
assert.equal(created.flow.nodes[created.id]!.title.text, flowNodeFieldKey('nodes', created.id, 'title'))
assert.equal(created.localeSeeds[flowNodeFieldKey('nodes', created.id, 'title')], '新 checkpoint')
assert.equal(displayText(created.flow.nodes[created.id]!.title, (key) => created.localeSeeds[key] ?? null), '新 checkpoint')
assert.equal(displayText(created.flow.nodes[created.id]!.title), flowNodeFieldKey('nodes', created.id, 'title'))

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

console.log('PASS: progress locale semantic keys, TextMap literal, layout paths')
