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
  navigation: [
    {
      id: 'old_tower',
      type: 'rpgtoolkit:pos',
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

const badArea = structuredClone(doc) as unknown as { regions: { areas: unknown[] }[] }
badArea.regions[0]!.areas = [{ x: [47, 32], z: [0, 1], y: 'all' }]
assert.throws(() => parseLevelDocument(JSON.stringify(badArea)), /min 不能大于 max/)

const template = file('hub.level', source)
const nav = createNavigationPoint('hub')
nav.param = { x: 1, y: 2, z: 3 }
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
  'levels/hub.json',
  'navigation_points/hub$old_tower.json',
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

const staticNavJson = JSON.parse(String(levelArts.find((a) => a.path === 'navigation_points/hub$old_tower.json')!.bytes)) as Record<string, unknown>
assert.equal(staticNavJson.level, 'hub')
assert.deepEqual(staticNavJson.param, { x: 40, y: 72, z: 40 })
assert.equal((staticNavJson.custom_data as Record<string, unknown>)['rpgtoolkit:display_name'], 'old_tower.display_name')

const navArts = await navigationCompiler.compile(navFile, ctx)
assert.equal(navArts.length, 1)
assert.equal(navArts[0]!.path, 'navigation_points/camp.json')
assert.equal((JSON.parse(String(navArts[0]!.bytes)) as Record<string, unknown>).level, 'hub')

const duplicateArtifacts: CompileArtifact[] = [
  { path: 'navigation_points/hub$old_tower.json', bytes: '', plane: 'shared', packageName: 'p', sourcePath: 'a' },
  { path: 'navigation_points/hub$old_tower.json', bytes: '', plane: 'shared', packageName: 'p', sourcePath: 'b' },
]
const dupDiagnostics: { severity: string; message: string }[] = []
await levelArtifactPass.run(duplicateArtifacts, {
  ...ctx,
  report: (d) => { dupDiagnostics.push(d) },
})
assert.equal(dupDiagnostics.some((d) => d.severity === 'error' && d.message.includes('导出路径重复')), true)

assert.deepEqual(validateLevelDocument(createLevelDocument()), [], '空模板应合法')

console.log('PASS: level document round-trip, validation, and one-to-many compile output')
