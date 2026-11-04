import assert from 'node:assert/strict'
import { createLevelDocument, parseLevelDocument, stringifyLevelDocument, validateLevelDocument } from '../src/workspaces/gameplay/levelDoc.ts'
import { REGION_EFFECT_CONTROLS, effectColor, colorWithAlpha, toggleChannel, readRegionEffects, withRegionEffects } from '../src/workspaces/gameplay/regionEffects.ts'
import { replaceArea, levelHistory, levelHistoryCommit, levelHistoryUndo } from '../src/workspaces/gameplay/levelEdit.ts'
import { levelCompiler } from '../src/export/compile/compilers/level.ts'
import { createProject } from '../src/workspace.ts'
import { createEffectResource, validateEffectResource, effectResourcePaths, effectResourceChoice, readEffectPresets, referencedEffects } from '../src/workspaces/gameplay/effectResources.ts'

const doc = createLevelDocument()
doc.regions.push({ id: '院子', areas: [{ kind: 'rect', x: [.25, 15], z: [0, 15], y: [64, 80.5] }], custom_data: { nested: { keep: ['a', 2] } },
  music: { sound: 'minecraft:music.overworld.forest', priority: 8 }, environment: { priority: 3, transition_ticks: 40, on_exit: 'restore', effects: {
    fog: { scope: 'player', parameters: { color: [100, 140, 180, .37], start: 2, end: 64 } },
    sky: { parameters: { layers: ['rpgtoolkit:vanilla', { shader: 'rpgtoolkit:aurora', params: { color_a: '#3dffa8' } }], clouds: { opacity: .7 } } },
    post: { parameters: { filters: [{ shader: 'rpgtoolkit:color_grade', params: { exposure: -.5 } }], transition: { shader: 'rpgtoolkit:dissolve', ticks: 30 } } },
  } } })
const region = doc.regions[0]
assert.deepEqual(parseLevelDocument(stringifyLevelDocument(doc)), doc)
assert.deepEqual(validateLevelDocument(doc), [])
const changed = replaceArea(doc, region.id, 0, { ...region.areas[0], kind: 'rect', x: [1.25, 20], z: [0, 15], y: [64, 80.5] })
assert.deepEqual(changed.regions[0].environment, region.environment)
assert.deepEqual(changed.regions[0].music, region.music)
const history = levelHistoryCommit(levelHistory(doc), changed)
assert.deepEqual(levelHistoryUndo(history).current, doc)
const files: any[] = [], diagnostics: any[] = [], pkg = createProject('region-effects')
const artifacts = await levelCompiler.compile({ id: 'hub.level', name: 'hub.level', content: stringifyLevelDocument(doc), updatedAt: 0 }, { index: { package: pkg, workspace: { packages: [pkg] }, scriptsByPath: new Map(), assetsByPath: new Map() }, report: (d: any) => diagnostics.push(d) } as any)
files.push(...artifacts); assert.equal(diagnostics.length, 0)
const exported = JSON.parse(files.find(f => f.path === 'regions/hub$院子.json').bytes)
assert.deepEqual(exported.environment, region.environment); assert.deepEqual(exported.music, region.music); assert.deepEqual(exported.custom_data, region.custom_data)
assert.deepEqual(effectColor('rgba(100,140,180,0.37)'), { hex: '#648cb4', alpha: .37 })
assert.deepEqual(effectColor(colorWithAlpha('#648cb4', .37)), { hex: '#648cb4', alpha: .37 })
assert.equal(effectColor([1.5, 0, 0]), null); assert.equal(effectColor('rgb(,0,0)'), null)
for (const malformed of [
  { music: { sound: 'INVALID' } }, { music: { sound: region.music!.sound, volume: .4 } },
  { environment: { effects: {} } },
  { environment: { effects: { fog: { parameters: { start: 20, end: 1 } } } } },
  { environment: { effects: { fog: { parameters: { extinction: .1, mean_free_path: 20 } } } } },
  { environment: { effects: { sky: { scope: 'volume', parameters: {} } } } },
  { environment: { effects: { sky: { parameters: { layers: ['gradient', 'vanilla'] } } } } },
]) assert.throws(() => readRegionEffects(malformed, region.areas, 'test'))
let spatial = toggleChannel({}, 'fog', true)
spatial.environment!.effects.fog!.scope = 'volume'; spatial.environment!.effects.fog!.parameters.volumetric = true
assert.doesNotThrow(() => readRegionEffects(spatial as any, region.areas, 'spatial'))
assert.throws(() => readRegionEffects(spatial as any, [{ ...region.areas[0], y: 'all' }], 'spatial'))
for (const shader of REGION_EFFECT_CONTROLS.shaders) {
  const params = Object.fromEntries(shader.params.map(p => [p.key, p.default]))
  assert.ok(shader.params.every(p => p.key !== p.label), `Chinese labels: ${shader.id}`)
  const env = shader.kind === 'transition' ? { effects: { post: { parameters: { transition: { shader: shader.id, params } } } } } : { effects: { [shader.kind]: { parameters: { [shader.kind === 'sky' ? 'layers' : 'filters']: [{ shader: shader.id, params }] } } } }
  assert.doesNotThrow(() => readRegionEffects({ environment: env }, region.areas, shader.id))
}
const disabled = withRegionEffects(region, toggleChannel(toggleChannel(toggleChannel(toggleChannel(region, 'fog', false), 'sky', false), 'post', false), 'music', false))
assert.equal(disabled.environment, undefined); assert.equal(disabled.music, undefined); assert.deepEqual(disabled.custom_data, region.custom_data)
console.log('PASS region effect author roundtrip, production export, geometry/history preservation, colors, runtime constraints and all built-in controls')

for (const kind of ['post', 'sky', 'transition'] as const) {
  const source = createEffectResource(kind)
  assert.doesNotThrow(() => validateEffectResource(source))
  assert.ok(effectResourcePaths(kind, source.id)[1].endsWith('.glsl'))
  assert.ok(effectResourceChoice(source).params.every(p => p.key !== p.label))
  const invalid = structuredClone(source); invalid.manifest.params = { test: { type: 'float', label: '强度', default: 2, min: 0, max: 1 } }
  assert.throws(() => validateEffectResource(invalid))
}
for (const id of ['project:../secret','project:a//b','project:con','rpgtoolkit_editor:alias','rpgtoolkit:vanilla']) assert.throws(() => effectResourcePaths('post', id))
const recipe = { id: 'forest', title: '林地夜雨', effects: { environment: region.environment, music: region.music } }
assert.deepEqual(readEffectPresets(JSON.stringify({ v: 1, presets: [recipe] })), [recipe])
assert.throws(() => readEffectPresets(JSON.stringify({ v: 1, presets: [recipe, recipe] })))
assert.throws(() => readEffectPresets(' '.repeat(262145)))
assert.ok(referencedEffects(recipe.effects).has('post/rpgtoolkit:color_grade'))
assert.throws(() => readRegionEffects({ environment: { effects: { post: { parameters: { filters: ['rpgtoolkit_editor:alias'] } } } } }, region.areas, 'author aliases'))
console.log('PASS custom GLSL templates, typed Chinese parameter metadata, bounded project recipes, safe resource paths and private alias isolation')
