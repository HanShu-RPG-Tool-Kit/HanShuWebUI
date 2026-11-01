/**
 * BossBar 协议与规则的验证。
 *
 * 守四件事：
 * 1. schema 是唯一机器定义 —— 规范化文档必须通过它，非法输入必须被拒并定位到字段；
 * 2. TS 与 Java 共用的夹具没有漂移 —— 磁盘上的冻结结果必须与当前实现一致；
 * 3. 设计文档点名的规则（唯一显示区域、AABB 包含、单张 Base64 PNG、UV、long 精度、取帧）逐条成立；
 * 4. 新建 / 升级 / 规范化往返 / 编译器产物都不丢信息，也不产出外部图片。
 *
 * 跑：`npm run test:bossbar`
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BOSSBAR_LIMITS,
  BOSSBAR_SAMPLE_TEXTURE,
  createBossbar,
  inspectBossbar,
  parseBossbar,
  parseBossbarDocument,
  stringifyBossbar,
  toCanonicalDocument,
  upgradeBossbarV1,
  type BossbarDocument,
} from '../src/workspaces/audiovisual/bossbar'
import { BOSSBAR_V2_SCHEMA } from '../src/workspaces/audiovisual/bossbar/schema'
import { validateAgainstSchema } from '../src/workspaces/audiovisual/bossbar/schemaValidate'
import { bossbarFixtureFile, bossbarSchemaFile } from '../src/workspaces/audiovisual/bossbar/spec/generate'
import { DEMO_EMBER_GUARD } from '../src/workspaces/audiovisual/bossbar/spec/cases'
import { createAnimationState, evaluateBars } from '../src/workspaces/audiovisual/bossbar/render/animation'
import { buildScene } from '../src/workspaces/audiovisual/bossbar/render/scene'
import { resolveValues, estimateSnapshotBytes } from '../src/workspaces/audiovisual/bossbar/rules/values'
import { formatRunValue } from '../src/workspaces/audiovisual/bossbar/rules/formatRun'
import {
  addComponent,
  createComponent,
  duplicateComponent,
  moveComponent,
  removeComponent,
  removeVariable,
  renameVariable,
  setTexture,
  translateAll,
} from '../src/workspaces/audiovisual/bossbar/document'
import { base64ToBytes, decodeBase64, encodeBase64, normalizeBase64, pngInfo } from '../src/workspaces/audiovisual/bossbar/png'
import { bossbarCompiler } from '../src/export/compile/compilers/bossbar'
import { resourceTypeForExtension, AUDIOVISUAL_CATEGORIES } from '../src/resourceTypes'
import { sourcePathOf } from '../src/workspace'
import { findNewFileType } from '../src/newFileTypes'

const here = dirname(fileURLToPath(import.meta.url))
const specDir = resolve(here, '../src/workspaces/audiovisual/bossbar/spec')

// ---------------------------------------------------------------- 1. 冻结夹具

const schemaOnDisk = await readFile(resolve(specDir, 'hanshu.bossbar.v2.schema.json'), 'utf8')
assert.equal(schemaOnDisk, bossbarSchemaFile(), 'schema 文件与实现不一致：运行 npm run generate:bossbar-spec')
const fixturesOnDisk = await readFile(resolve(specDir, 'bossbar-v2.fixtures.json'), 'utf8')
assert.equal(
  fixturesOnDisk,
  bossbarFixtureFile(),
  '协议夹具与实现不一致：语义没变就重新生成并 review diff；语义变了先修实现',
)
const fixtures = JSON.parse(fixturesOnDisk) as Record<string, any>
console.log('通过：schema 与跨语言夹具和实现一致')

for (const entry of fixtures.textValues as { text: string, expect: string }[]) {
  assert.equal(entry.text, entry.expect, '变量原值文本')
}
for (const entry of fixtures.frames as { mode: string, samples: { timeMs: number, index: number, expect: number }[] }[]) {
  for (const sample of entry.samples) {
    assert.equal(sample.index, sample.expect, '取帧 ' + entry.mode + ' @' + sample.timeMs + 'ms')
  }
}
for (const entry of fixtures.progress as { result: number, expect: number }[]) {
  assert.equal(entry.result, entry.expect, 'progress 夹紧')
}
console.log('通过：变量原值文本、UV 取帧与 progress 夹紧')

// ---------------------------------------------------------------- 2. 解析与规范化

const demo = parseBossbar(JSON.stringify(DEMO_EMBER_GUARD))
assert.equal(demo.id, 'hanshu:ember_guard')
assert.equal(demo.components.filter((component) => component.type === 'display_region').length, 1, '演示文档恰好一个显示区域')
assert.equal(demo.components.filter((component) => component.type !== 'display_region').length, 7, '演示文档有 7 个可绘制组件')
assert.deepEqual(validateAgainstSchema(demo, BOSSBAR_V2_SCHEMA), [], '规范化文档必须通过 schema')
assert.equal(stringifyBossbar(demo), stringifyBossbar(parseBossbar(stringifyBossbar(demo))), '规范序列化必须幂等')
assert.equal(stringifyBossbar(demo), stringifyBossbar(toCanonicalDocument(demo)), '规范序列化只认固定字段顺序')
assert.ok(JSON.stringify(demo).includes('"texture"'), '文档必须自带图集')

for (const entry of fixtures.invalid as { name: string, expectedPath: string, expect: { ok: boolean, paths: string[] } }[]) {
  assert.equal(entry.expect.ok, false, entry.name + ' 应被拒绝')
  assert.ok(
    entry.expect.paths.some((path) => path === entry.expectedPath),
    entry.name + ' 的诊断应指到 ' + entry.expectedPath + '，实际 ' + JSON.stringify(entry.expect.paths),
  )
}
console.log('通过：非法输入定位到具体字段（' + fixtures.invalid.length + ' 例）')

const v1 = inspectBossbar('{"format":"hanshu.bossbar","version":1,"id":"legacy"}')
assert.equal(v1.status, 'v1', 'v1 只允许显式升级')
const upgraded = upgradeBossbarV1({ format: 'hanshu.bossbar', version: 1, id: 'legacy' })
assert.equal(upgraded.id, 'legacy')
assert.equal(upgraded.version, 2, '升级后版本为 2')
assert.equal(upgraded.priority, 0, '升级默认优先级为0')
assert.equal(upgraded.components.length, 1, '升级后只有一个显示区域')
assert.equal(upgraded.components[0].type, 'display_region', '升级补的是显示区域')
assert.deepEqual(upgraded.components[0].box, { x: 0, y: 0, width: 768, height: 72 })
assert.equal(pngInfo(base64ToBytes(upgraded.texture)!)?.width, 1, '升级后必须带一张透明 1×1 PNG')
assert.equal(inspectBossbar('{"format":"hanshu.bossbar","version":9,"id":"x"}').status, 'unsupported')
assert.equal(inspectBossbar('not json').status, 'invalid')
assert.equal(inspectBossbar(JSON.stringify(DEMO_EMBER_GUARD)).status, 'ok')
console.log('通过：v1 需显式升级，未知版本只给诊断')

// ---------------------------------------------------------------- 3. 显示区域与 AABB

const base = createBossbar('t')
const regionOnly = base.components[0]
assert.equal(regionOnly.type, 'display_region', '新建文档自带显示区域')
assert.equal(base.priority, 0, '新建默认优先级为0')

const touching = addComponent(base, {
  id: 'edge',
  type: 'background',
  box: { x: 0, y: 0, width: 768, height: 72 },
  visible: true,
  opacity: 1,
  paint: { kind: 'solid', color: '#00000000' },
})
assert.equal(parseBossbarDocument(stringifyBossbar(touching)).ok, true, '四边相切合法')

const outside = addComponent(base, {
  id: 'out',
  type: 'background',
  box: { x: 760, y: 0, width: 20, height: 10 },
  visible: false,
  opacity: 1,
  paint: { kind: 'solid', color: '#00000000' },
})
const outsideResult = parseBossbarDocument(stringifyBossbar(outside))
assert.equal(outsideResult.ok, false, '隐藏组件也参与几何校验')
if (!outsideResult.ok) {
  assert.ok(outsideResult.diagnostics.some((entry) => entry.code === 'outside_region'))
}

const negated = translateAll(demo, -1000, -500)
const negatedParsed = parseBossbarDocument(stringifyBossbar(negated))
assert.equal(negatedParsed.ok, true, '整体平移到负坐标后仍然合法')
if (negatedParsed.ok) {
  const before = demo.components.find((component) => component.id === 'track')!
  const after = negatedParsed.document.components.find((component) => component.id === 'track')!
  assert.equal(after.box.x - before.box.x, -1000, '整体移动保持相对位置')
}
console.log('通过：显示区域唯一、AABB 包含与整体移动')

// ---------------------------------------------------------------- 4. 单张 PNG 与 UV

const sampleBytes = base64ToBytes(BOSSBAR_SAMPLE_TEXTURE)!
const sampleInfo = pngInfo(sampleBytes)!
assert.equal(sampleInfo.width, 4, '示例图集宽 4')
assert.equal(sampleInfo.height, 2, '示例图集高 2')
assert.equal(sampleInfo.apng, false, '示例图集不是 APNG')
assert.equal(encodeBase64(sampleBytes), BOSSBAR_SAMPLE_TEXTURE, 'Base64 规范化必须往返一致')
assert.equal(normalizeBase64(' ' + BOSSBAR_SAMPLE_TEXTURE + '\n'), BOSSBAR_SAMPLE_TEXTURE)
assert.equal(decodeBase64('not-base64'), null)

const swapped = setTexture(createBossbar('t'), BOSSBAR_SAMPLE_TEXTURE)
assert.equal(swapped.texture, BOSSBAR_SAMPLE_TEXTURE, '替换图集后字节一致')
assert.equal(parseBossbarDocument(stringifyBossbar(swapped)).ok, true, '替换图集后仍合法')

const uvOut = addComponent(swapped, {
  id: 'uv',
  type: 'background',
  box: { x: 0, y: 0, width: 10, height: 10 },
  visible: true,
  opacity: 1,
  paint: { kind: 'texture', uv: { x: 3, y: 0, width: 4, height: 1 }, fit: 'stretch' },
})
const uvResult = parseBossbarDocument(stringifyBossbar(uvOut))
assert.equal(uvResult.ok, false, 'UV 越界必须拒绝')
if (!uvResult.ok) assert.ok(uvResult.diagnostics.some((entry) => entry.code === 'uv_out_of_bounds'))
console.log('通过：单张 Base64 PNG、UV 边界与 Base64 规范化')

// ---------------------------------------------------------------- 5. 文本变量与 long 精度

const maximumLong = { type: 'long' as const, value: '9223372036854775807' }
assert.equal(formatRunValue(maximumLong), '9223372036854775807')
assert.equal(formatRunValue({ type: 'long', value: '9007199254740993' }), '9007199254740993', '2^53+1 不能丢位')
assert.equal(formatRunValue({ type: 'long', value: '-9223372036854775808' }), '-9223372036854775808')
assert.equal(formatRunValue({ type: 'double', value: 0.35 }), '0.35', 'double 原样转为文本')
assert.equal(formatRunValue({ type: 'bool', value: true }), 'true')
assert.equal(formatRunValue({ type: 'string', value: '420K（35%）' }), '420K（35%）', '服务端已格式化的字符串不变')

const longDoc: BossbarDocument = {
  ...createBossbar('long-text'),
  variables: { counter: { type: 'long', default: '0' } },
}
longDoc.components.push({
  id: 'counter_text', type: 'text', box: { x: 0, y: 0, width: 500, height: 20 },
  visible: true, opacity: 1, runs: [{ text: '计数：' }, { var: 'counter' }],
  fontSize: 16, color: '#FFFFFFFF', align: 'left', verticalAlign: 'middle', shadow: false,
})
assert.equal(parseBossbarDocument(stringifyBossbar(longDoc)).ok, true)
const longScene = buildScene({
  document: longDoc, values: resolveValues(longDoc, { counter: maximumLong }).values,
  timeMs: 0, texture: { width: 1, height: 1 },
})
assert.equal(longScene.commands[0].kind, 'text')
assert.equal(longScene.commands[0].kind === 'text' && longScene.commands[0].text, '计数：9223372036854775807')
console.log('通过：字面量和变量直接拼接，long 全精度，服务端格式文本原样显示')

// ---------------------------------------------------------------- 6. 值与动画

const demoValues = resolveValues(demo, {
  healthProgress: { type: 'double', value: 0.35 },
  healthText: { type: 'string', value: '420K（35%）' },
  bossName: { type: 'string', value: '赤焰守卫' },
  targetName: { type: 'string', value: '史蒂夫' },
  enraged: { type: 'bool', value: false },
  shieldProgress: { type: 'double', value: 0.12 },
  counter: { type: 'long', value: '9007199254740993' },
})
assert.equal(demoValues.values.healthProgress.value, 0.35, 'progress 值透传')
assert.equal(demoValues.issues.length, 0, '完整输入没有诊断')

const brokenValues = resolveValues(demo, {
  healthProgress: { type: 'long', value: '5' },
  bossName: { type: 'string', value: 'x'.repeat(65) },
  enraged: { type: 'double', value: 1 },
})
assert.equal(brokenValues.values.healthProgress.type, 'double', '类型不符回落到声明默认值')
assert.equal(brokenValues.values.healthProgress.value, 0)
assert.equal(brokenValues.values.bossName.value, '首领', '超长字符串回落到默认值')
assert.equal(brokenValues.values.enraged.value, false, 'bool 类型不符回落默认值')
assert.ok(brokenValues.issues.length >= 3, '每个非法值都有诊断')

const initial = evaluateBars(null, demo, demoValues.values, 0)
assert.equal(initial.view.health_fill.value, 0.35, '首次出现直接取真实值')
// 目标变化的瞬间显示值仍等于旧值(过渡从当前比例起算)，之后才开始增长
const healedStart = evaluateBars(initial.state, demo, { ...demoValues.values, healthProgress: { type: 'double', value: 1 } }, 1000)
assert.equal(healedStart.view.health_fill.value, 0.35, '目标变化的瞬间仍从当前显示比例起算')
const healed = evaluateBars(healedStart.state, demo, { ...demoValues.values, healthProgress: { type: 'double', value: 1 } }, 1060)
assert.ok(healed.view.health_fill.value > 0.35 && healed.view.health_fill.value < 1, '回血时主条在 smoothMs 内线性增长')
const settled = evaluateBars(healed.state, demo, { ...demoValues.values, healthProgress: { type: 'double', value: 1 } }, 1300)
assert.equal(settled.view.health_fill.value, 1, 'smoothMs 之后到达真实值')
assert.equal(settled.view.health_fill.trail, 1, '回血时尾条立即对齐')

const injured = evaluateBars(settled.state, demo, demoValues.values, 2000)
const injuredLater = evaluateBars(injured.state, demo, demoValues.values, 2060)
assert.ok(
  injuredLater.view.health_fill.trail > injuredLater.view.health_fill.value,
  '掉血时主条已开始收缩，尾条仍保留旧比例',
)
const trailDone = evaluateBars(injured.state, demo, demoValues.values, 2000 + 250 + 350 + 1)
assert.equal(trailDone.view.health_fill.trail, 0.35, '尾条延迟后追平')
console.log('通过：类型化取值、平滑与尾条动画')

// ---------------------------------------------------------------- 7. 场景

const textureSize = { width: sampleInfo.width, height: sampleInfo.height }
const scene = buildScene({ document: demo, values: demoValues.values, timeMs: 250, texture: textureSize })
assert.deepEqual(scene.issues, [], '演示文档素材齐全时没有诊断')
const fills = scene.commands.filter((command) => command.kind === 'fill')
const images = scene.commands.filter((command) => command.kind === 'image')
const texts = scene.commands.filter((command) => command.kind === 'text')
assert.equal(fills.length, 0, '演示文档全部使用图集纹理，没有纯色填充')
assert.equal(images.length, 4, '槽底、徽记、生命条、护盾条四条贴图')
assert.equal(texts.length, 2, '标题与血量两个文本')
assert.ok(
  scene.commands.every((command) => command.kind !== 'image' || (command.sx >= 0 && command.sx + command.sw <= textureSize.width)),
  '所有贴图源矩形必须在图集内',
)

const rageOn = buildScene({ document: demo, values: { ...demoValues.values, enraged: { type: 'bool', value: true } }, timeMs: 250, texture: textureSize })
assert.equal(rageOn.commands.length, scene.commands.length + 1, 'enraged=true 时多绘制一层火焰')

const at0 = buildScene({ document: { ...demo, variables: demo.variables }, values: { ...demoValues.values, enraged: { type: 'bool', value: true } }, timeMs: 0, texture: textureSize })
const at100 = buildScene({ document: demo, values: { ...demoValues.values, enraged: { type: 'bool', value: true } }, timeMs: 100, texture: textureSize })
assert.notDeepEqual(
  at0.commands.filter((command) => command.kind === 'image'),
  at100.commands.filter((command) => command.kind === 'image'),
  'UV 动画在不同时间要取到不同帧',
)
console.log('通过：场景绘制、UV 动画与显隐')

// 图片位置、大小和裁剪必须在同一个输出坐标系；UV 始终使用原图像素。
const paintFits = ['stretch', 'contain', 'cover', 'nine-slice'] as const
const imageDocument: BossbarDocument = {
  ...setTexture(createBossbar('image-transform'), BOSSBAR_SAMPLE_TEXTURE),
  components: [
    { id: 'region', type: 'display_region', box: { x: 0, y: 0, width: 100, height: 72 } },
    ...paintFits.map((fit) => ({
      id: fit.replace('-', '_'),
      type: 'background' as const,
      box: { x: 10, y: 20, width: 40, height: 40 },
      visible: true,
      opacity: 1,
      paint: {
        kind: 'texture' as const,
        uv: { x: 0, y: 0, width: 4, height: 2 },
        fit,
        insets: [1, 1, 1, 1] as [number, number, number, number],
      },
    })),
    {
      id: 'quarter_bar', type: 'bar', box: { x: 10, y: 20, width: 40, height: 40 },
      visible: true, opacity: 1,
      progress: 0.25,
      direction: 'left-to-right', smoothMs: 0,
      fill: { kind: 'texture', uv: { x: 0, y: 0, width: 4, height: 2 }, fit: 'stretch' },
    },
  ],
}
const imageTransformCases = [
  {
    scale: 0.7, origin: { x: 80, y: 20 },
    stretch: [87, 34, 28, 28], contain: [87, 41, 28, 14], cover: [73, 34, 56, 28],
    quarterClip: [87, 34, 7, 28],
    slices: [
      [87, 34, 0.7, 0.7], [87.7, 34, 26.6, 0.7], [114.3, 34, 0.7, 0.7],
      [87, 61.3, 0.7, 0.7], [87.7, 61.3, 26.6, 0.7], [114.3, 61.3, 0.7, 0.7],
    ],
  },
  {
    scale: 2, origin: { x: -30, y: 12 },
    stretch: [-10, 52, 80, 80], contain: [-10, 72, 80, 40], cover: [-50, 52, 160, 80],
    quarterClip: [-10, 52, 20, 80],
    slices: [
      [-10, 52, 2, 2], [-8, 52, 76, 2], [68, 52, 2, 2],
      [-10, 130, 2, 2], [-8, 130, 76, 2], [68, 130, 2, 2],
    ],
  },
]
const sliceUvs = [
  [0, 0, 1, 1], [1, 0, 2, 1], [3, 0, 1, 1],
  [0, 1, 1, 1], [1, 1, 2, 1], [3, 1, 1, 1],
]
for (const expected of imageTransformCases) {
  const transformed = buildScene({
    document: imageDocument, values: {}, timeMs: 0, texture: textureSize,
    scale: expected.scale, origin: expected.origin,
  })
  assert.deepEqual(transformed.issues, [])
  const imageCommands = transformed.commands.filter((command) => command.kind === 'image')
  const expectedImages = [
    { uv: [0, 0, 4, 2], dst: expected.stretch, clip: expected.stretch },
    { uv: [0, 0, 4, 2], dst: expected.contain, clip: expected.contain },
    { uv: [0, 0, 4, 2], dst: expected.cover, clip: expected.stretch },
    ...expected.slices.map((dst, index) => ({ uv: sliceUvs[index], dst, clip: dst })),
    { uv: [0, 0, 4, 2], dst: expected.stretch, clip: expected.quarterClip },
  ]
  assert.equal(imageCommands.length, expectedImages.length)
  imageCommands.forEach((command, index) => {
    const target = expectedImages[index]
    const label = '图片变换 scale=' + expected.scale + ' command=' + index
    assert.deepEqual([command.sx, command.sy, command.sw, command.sh], target.uv, label + ' 保留源 UV')
    const geometry = [command.dx, command.dy, command.dw, command.dh,
      command.clip.x, command.clip.y, command.clip.width, command.clip.height]
    const wanted = [...target.dst, ...target.clip]
    geometry.forEach((value, coordinate) => assert.ok(
      Math.abs(value - wanted[coordinate]) < 1e-9,
      label + ' 坐标 ' + coordinate + ' 应为 ' + wanted[coordinate] + '，实际 ' + value,
    ))
  })
}
console.log('通过：贴图缩放、平移、九宫格与部分填充裁剪保持一致')

// ---------------------------------------------------------------- 8. 编辑操作

let edited = structuredClone(demo)
const renamed = renameVariable(edited, 'healthProgress', 'hp')
assert.equal(renamed.ok, true)
if (renamed.ok) {
  edited = renamed.document
  const bar = edited.components.find((component) => component.id === 'health_fill')
  assert.ok(bar && bar.type === 'bar')
  assert.deepEqual(bar.progress, { var: 'hp' })
}
const blockedDelete = removeVariable(edited, 'hp')
assert.equal(blockedDelete.ok, false, '仍被引用的变量不能直接删除')
const forcedDelete = removeVariable(edited, 'hp', { double: 0 })
assert.equal(forcedDelete.ok, true)

const duplicated = duplicateComponent(demo, 'track')
assert.equal(duplicated.ok, true)
if (duplicated.ok) {
  assert.equal(duplicated.document.components.length, demo.components.length + 1)
  assert.notEqual(duplicated.document.components[2].id, 'track')
}
const regionDuplicate = duplicateComponent(demo, 'region')
assert.equal(regionDuplicate.ok, false, '显示区域不能复制')
const regionDelete = removeComponent(demo, 'region')
assert.equal(regionDelete.ok, false, '显示区域不能删除')
const movedComponent = moveComponent(demo, 'track', 3)
assert.equal(movedComponent.components[3].id, 'track')
const newComponent = createComponent('text', 'label', demo.components[0].box)
assert.equal(newComponent.type, 'text')
console.log('通过：改名联动、删除引用、复制与排序约束')

// ---------------------------------------------------------------- 9. 编译器

const reports: { severity: string, code: string, message: string }[] = []
const artifacts = await bossbarCompiler.compile(
  { id: 'a', name: 'ember_guard.bossbar', content: stringifyBossbar(demo), updatedAt: 0 },
  {
    index: {
      workspace: { packages: [], activeScriptId: null, activeAssetId: null },
      package: {
        id: 'pkg',
        name: '演示',
        collapsed: false,
        assetsCollapsed: false,
        scripts: [{ id: 'a', name: 'ember_guard.bossbar', content: stringifyBossbar(demo), updatedAt: 0 }],
        assets: [],
        assetFolders: [],
      },
      scriptsByPath: new Map(),
      assetsByPath: new Map(),
    },
    report: (entry) => reports.push(entry),
  },
)
assert.deepEqual(reports, [], '合法文档不该报错')
assert.equal(artifacts.length, 1, '单文件只产出一个产物')
assert.equal(artifacts[0].path, 'bossbars/ember_guard.bossbar', '产物路径')
assert.equal(artifacts[0].plane, 'client', '模板只在客户端运行')
assert.equal(artifacts[0].bytes, stringifyBossbar(demo), '产物字节等于规范序列化')
assert.ok(!artifacts.some((artifact) => artifact.path.startsWith('assets/')), '不得产出外部图片资产')
console.log('通过：编译器产出唯一 client 文档、无外部图片')

// ---------------------------------------------------------------- 10. 资源登记与预算

assert.equal(resourceTypeForExtension('.bossbar')?.directory, 'src/bossbars')
assert.equal(sourcePathOf({ name: 'demo.bossbar' }), 'src/bossbars/demo.bossbar')
assert.equal(AUDIOVISUAL_CATEGORIES.bossbar.name, 'BOSS血条')
assert.equal(findNewFileType('bossbar')?.ext, '.bossbar')
const seed = findNewFileType('bossbar')!.seed('demo', {
  goalDefinitions: [],
  ttsPresets: [],
  firstLocale: null,
  firstServiceId: 'svc',
  firstVoiceId: null,
})
assert.equal(parseBossbar(seed).version, 2, '新建种子必须是可解析的 v2')
assert.equal(parseBossbar(seed).components[0].type, 'display_region')

const snapshot = estimateSnapshotBytes(demo)
assert.ok(snapshot.worstBytes > 0 && snapshot.worstBytes <= BOSSBAR_LIMITS.upsertBudgetBytes, '演示文档的最坏快照在预算内')
assert.ok(BOSSBAR_LIMITS.documentBytes === 6 * 1024 * 1024)
console.log('通过：资源登记、新建种子与快照预算')

assert.deepEqual(createAnimationState(0).bars, {}, '动画状态初始为空')
console.log('PASS verify-bossbar')
