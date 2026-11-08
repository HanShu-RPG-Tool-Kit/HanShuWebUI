import assert from 'node:assert/strict'
import { createLevelDocument, parseLevelDocument, stringifyLevelDocument, validateLevelDocument, type LevelDocument } from '../src/workspaces/gameplay/levelDoc.ts'
import { createNavigationPoint, stringifyNavigationPoint } from '../src/workspaces/gameplay/navigationPoint.ts'
import { levelArtifactPass, levelCompiler, navigationCompiler } from '../src/export/compile/compilers/level.ts'
import type { CompileArtifact, CompileContext, CompileIndex } from '../src/export/compile/types.ts'
import { createProject, type SourceFile } from '../src/workspace.ts'

function file(name: string, content: string): SourceFile {
  return { id: name, name, content, updatedAt: 0 }
}

function ctxFor(files: SourceFile[]) {
  const pkg = createProject('level-compile')
  pkg.scripts = files
  const index: CompileIndex = {
    workspace: { packages: [pkg], activeScriptId: null, activeAssetId: null },
    package: pkg,
    scriptsByPath: new Map(files.map((item) => [item.name, item])),
    assetsByPath: new Map(),
  }
  const diagnostics: { severity: string; code?: string; message: string }[] = []
  const ctx: CompileContext = { index, report: (d) => { diagnostics.push(d) } }
  return { ctx, diagnostics, pkg }
}

const doc: LevelDocument = {
  tags: ['demo:hub'],
  regions: [
    { id: 'spawn', areas: [{ kind: 'rect', x: [32, 47], z: [32, 47], y: [60, 90] }], custom_data: {} },
    { id: 'grove', areas: [{ kind: 'circle', center: [40, 40], radius: 8, y: 'all' }], custom_data: {} },
  ],
  landmarks: [
    {
      id: 'old_tower',
      kind: 'rpgtoolkit:pos',
      param: { x: 40, y: 72, z: 40 },
      custom_data: { 'rpgtoolkit:display_name': 'old_tower.display_name', 'rpgtoolkit:display_icon': 'minecraft:compass' },
    },
  ],
  custom_data: {},
}

const source = stringifyLevelDocument(doc)
assert.deepEqual(parseLevelDocument(source), doc, '.level 应原样往返')

const duplicate = structuredClone(doc)
duplicate.regions.push({ id: 'spawn', areas: duplicate.regions[0]!.areas, custom_data: {} })
assert.throws(() => parseLevelDocument(stringifyLevelDocument(duplicate)), /重复/)

const reversedArea = JSON.parse(source) as { regions: { areas: unknown[] }[] }
reversedArea.regions[0]!.areas = [{ x: [47, 32], z: [1, 0], y: 'all' }]
assert.deepEqual(parseLevelDocument(JSON.stringify(reversedArea)).regions[0]!.areas[0], {
  kind: 'rect', x: [32, 47], z: [0, 1], y: 'all',
}, '矩形的 X/Z 端点按协议归一化')

const badArea = JSON.parse(source) as { regions: { areas: unknown[] }[] }
badArea.regions[0]!.areas = [{ x: [0, 1], z: [0, 1], y: [90, 60] }]
assert.throws(() => parseLevelDocument(JSON.stringify(badArea)), /min 不能大于 max/)
badArea.regions[0]!.areas = [{ x: [0, 1], z: [0, 1] }]
assert.throws(() => parseLevelDocument(JSON.stringify(badArea)), /\.y/)
badArea.regions[0]!.areas = [{ x: [0, 1], z: [0, 1], y: 'all', shape: 1 }]
assert.throws(() => parseLevelDocument(JSON.stringify(badArea)), /\.shape/)
badArea.regions[0]!.areas = [{ x: [0, 1], z: [0, 1], y: 'all', raduis: 5 }]
assert.throws(() => parseLevelDocument(JSON.stringify(badArea)), /未知字段/)

const invalidGeometry = structuredClone(doc)
invalidGeometry.regions[0]!.areas[0]!.y = [90, 60]
assert.ok(validateLevelDocument(invalidGeometry).some((issue) => issue.includes('.y')))
const invalidLandmark = structuredClone(doc)
invalidLandmark.landmarks[0]!.param.y = Number.NaN
assert.ok(validateLevelDocument(invalidLandmark).some((issue) => issue.includes('.param.y')))

const normalizedTags = parseLevelDocument('{"tags":["  Demo:Hub  ","demo:hub","é","é"]}')
assert.deepEqual(normalizedTags.tags, ['Demo:Hub', 'é'], '标签 trim、NFC 并忽略大小写去重')

const template = file('hub.level', source)
const nav = createNavigationPoint('hub', 'camp')
nav.track.ref = 'hub$old_tower'
const navFile = file('camp.nav', stringifyNavigationPoint(nav))
const { ctx, diagnostics, pkg } = ctxFor([template, navFile])
pkg.scripts = [template, navFile]

assert.equal(levelCompiler.match(template, ctx.index), true)
assert.equal(levelCompiler.match(navFile, ctx.index), false)
assert.equal(navigationCompiler.match(navFile, ctx.index), true)

const levelArts = await levelCompiler.compile(template, ctx)
assert.equal(diagnostics.filter((d) => d.severity === 'error').length, 0)
const paths = levelArts.map((a) => a.path).sort()
assert.deepEqual(paths, [
  'landmarks/hub$old_tower.json',
  'levels/hub.json',
  'regions/hub$grove.json',
  'regions/hub$spawn.json',
].sort())
assert.equal(levelArts.every((a) => a.plane === 'shared' && a.sourcePath === 'hub.level'), true)

const levelJson = JSON.parse(String(levelArts.find((a) => a.path === 'levels/hub.json')!.bytes)) as Record<string, unknown>
assert.deepEqual(Object.keys(levelJson).sort(), ['custom_data', 'tags'])
assert.deepEqual(levelJson.tags, ['demo:hub'])

const regionJson = JSON.parse(String(levelArts.find((a) => a.path === 'regions/hub$spawn.json')!.bytes)) as Record<string, unknown>
assert.equal(regionJson.level, 'hub')
assert.equal('id' in regionJson, false)

const landmarkJson = JSON.parse(String(levelArts.find((a) => a.path === 'landmarks/hub$old_tower.json')!.bytes)) as Record<string, unknown>
assert.equal(landmarkJson.level, 'hub')
assert.equal(landmarkJson.kind, 'rpgtoolkit:pos')
assert.equal('type' in landmarkJson, false)
assert.deepEqual(landmarkJson.param, { x: 40, y: 72, z: 40 })
assert.equal((landmarkJson.custom_data as Record<string, unknown>)['rpgtoolkit:display_name'], 'old_tower.display_name')
assert.throws(() => parseLevelDocument(JSON.stringify({ tags: [], regions: [], navigation: [], custom_data: {} })), /navigation 已废弃/)

const navArts = await navigationCompiler.compile(navFile, ctx)
assert.equal(navArts.length, 0, '合法 .nav 不写出运行时文件')
assert.equal(diagnostics.filter((d) => d.severity === 'error').length, 0)

for (const invalidName of ['.level', '..level', '...level', '   .level', `${'a'.repeat(65)}.level`]) {
  const badFile = file(invalidName, source)
  const invalid = ctxFor([badFile])
  assert.deepEqual(await levelCompiler.compile(badFile, invalid.ctx), [], `非法模板文件名：${invalidName}`)
  assert.ok(invalid.diagnostics.some((d) => d.severity === 'error'))
}

const unknownTemplate = ctxFor([navFile])
await navigationCompiler.compile(navFile, unknownTemplate.ctx)
assert.ok(unknownTemplate.diagnostics.some((d) => d.message.includes('地图模板不存在')))
const unknownRef = createNavigationPoint('hub', 'missing')
unknownRef.track.ref = 'hub$missing'
const unknownRefFile = file('missing.nav', stringifyNavigationPoint(unknownRef))
const unknownLandmark = ctxFor([template, unknownRefFile])
await navigationCompiler.compile(unknownRefFile, unknownLandmark.ctx)
assert.ok(unknownLandmark.diagnostics.some((d) => d.message.includes('地标不存在')))

const coordFile = file('coord.nav', '{"level":"hub","type":"rpgtoolkit:pos","param":{"x":1,"y":2,"z":3}}\n')
const { ctx: coordCtx, diagnostics: coordDiagnostics } = ctxFor([coordFile])
assert.equal((await navigationCompiler.compile(coordFile, coordCtx)).length, 0)
assert.ok(coordDiagnostics.some((d) => d.severity === 'error' && d.message.includes('不能保存坐标')))

const mismatch = createNavigationPoint('hub', 'not-camp')
mismatch.track.ref = 'hub$old_tower'
const mismatchFile = file('camp.nav', stringifyNavigationPoint(mismatch))
const { ctx: mismatchCtx, diagnostics: mismatchDiagnostics } = ctxFor([mismatchFile])
await navigationCompiler.compile(mismatchFile, mismatchCtx)
assert.ok(mismatchDiagnostics.some((d) => d.message.includes('不一致')))

const duplicateArtifacts: CompileArtifact[] = [
  { path: 'landmarks/hub$old_tower.json', bytes: '', plane: 'shared', packageName: 'p', sourcePath: 'a' },
  { path: 'landmarks/hub$old_tower.json', bytes: '', plane: 'shared', packageName: 'p', sourcePath: 'b' },
]
const dupDiagnostics: { severity: string; message: string }[] = []
await levelArtifactPass.run(duplicateArtifacts, {
  ...ctx,
  report: (d) => { dupDiagnostics.push(d) },
})
assert.equal(dupDiagnostics.some((d) => d.severity === 'error' && d.message.includes('导出路径重复')), true)

const removedDiagnostics: { severity: string; code?: string; message: string }[] = []
await levelArtifactPass.run([
  { path: 'navigation_points/camp.json', bytes: '', plane: 'shared', packageName: 'p', sourcePath: 'camp.nav' },
], {
  ...ctx,
  report: (d) => { removedDiagnostics.push(d) },
})
assert.equal(removedDiagnostics.some((d) => d.code === 'navigation_points_removed' && d.message.includes('已废弃')), true)

assert.deepEqual(validateLevelDocument(createLevelDocument()), [], '空模板应合法')

console.log('PASS: level document round-trip, validation, and one-to-many compile output')
