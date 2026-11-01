/**
 * 组装演示工程：把演示图集内嵌进 .bossbar，并写出工程清单与参考底图。
 *
 * 文档是单文件自包含的，所以这里读 PNG → Base64 → 写进正文；
 * 生成的文档必须能通过 parseBossbarDocument，否则直接失败。
 */
import { mkdir, readFile, writeFile, copyFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeBase64 } from '../src/workspaces/audiovisual/bossbar/png'
import {
  parseBossbarDocument,
  stringifyBossbar,
} from '../src/workspaces/audiovisual/bossbar/parse'
import type { BossbarDocument } from '../src/workspaces/audiovisual/bossbar/protocol'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const demoRoot = resolve(repo, 'demo-projects/bossbar-demo')

const UV = {
  track: { x: 0, y: 0, width: 64, height: 16 },
  fill: { x: 64, y: 0, width: 192, height: 16 },
  trail: { x: 256, y: 0, width: 192, height: 16 },
  shield: { x: 448, y: 0, width: 64, height: 16 },
  emblem: { x: 0, y: 16, width: 64, height: 64 },
  frame: { x: 64, y: 16, width: 64, height: 32 },
  flame: [
    { x: 0, y: 80, width: 128, height: 48 },
    { x: 128, y: 80, width: 128, height: 48 },
    { x: 256, y: 80, width: 128, height: 48 },
    { x: 384, y: 80, width: 128, height: 48 },
  ],
}

function emberGuard(texture: string): BossbarDocument {
  return {
    format: 'hanshu.bossbar',
    version: 2,
    id: 'hanshu:ember_guard',
    priority: 10,
    texture,
    layout: { dock: 'top-center', scale: 0.7, safeMargin: 12 },
    variables: {
      healthProgress: { type: 'double', default: 1 },
      shieldProgress: { type: 'double', default: 0.4 },
      healthText: { type: 'string', default: '1200000 / 1200000（100%）', maxLength: 64 },
      bossName: { type: 'string', default: '赤焰守卫', maxLength: 64 },
      targetName: { type: 'string', default: '无', maxLength: 64 },
      enraged: { type: 'bool', default: false },
    },
    components: [
      { id: 'region', type: 'display_region', box: { x: 0, y: 0, width: 768, height: 72 } },
      {
        id: 'track',
        type: 'background',
        box: { x: 72, y: 26, width: 624, height: 20 },
        visible: true,
        opacity: 1,
        paint: { kind: 'texture', uv: UV.track, fit: 'stretch' },
      },
      {
        id: 'emblem',
        type: 'background',
        box: { x: 2, y: 4, width: 64, height: 64 },
        visible: true,
        opacity: 1,
        paint: { kind: 'texture', uv: UV.emblem, fit: 'contain' },
      },
      {
        id: 'border',
        type: 'background',
        box: { x: 68, y: 22, width: 632, height: 28 },
        visible: true,
        opacity: 1,
        paint: { kind: 'texture', uv: UV.frame, fit: 'nine-slice', insets: [8, 8, 8, 8] },
      },
      {
        id: 'health_fill',
        type: 'bar',
        box: { x: 76, y: 30, width: 616, height: 12 },
        visible: true,
        opacity: 1,
        progress: { var: 'healthProgress' },
        direction: 'left-to-right',
        fill: { kind: 'texture', uv: UV.fill, fit: 'stretch' },
        trail: {
          paint: { kind: 'texture', uv: UV.trail, fit: 'stretch' },
          delayMs: 220,
          durationMs: 320,
        },
        smoothMs: 140,
      },
      {
        id: 'shield_fill',
        type: 'bar',
        box: { x: 76, y: 44, width: 616, height: 4 },
        visible: true,
        opacity: 1,
        progress: { var: 'shieldProgress' },
        direction: 'left-to-right',
        fill: { kind: 'texture', uv: UV.shield, fit: 'stretch' },
        smoothMs: 120,
      },
      {
        id: 'rage_flame',
        type: 'background',
        box: { x: 84, y: 48, width: 600, height: 10 },
        visible: { var: 'enraged' },
        opacity: 0.9,
        paint: {
          kind: 'texture',
          uv: UV.flame[0],
          fit: 'stretch',
          animation: {
            mode: 'loop',
            phaseMs: 0,
            frames: UV.flame.map((uv) => ({ uv, durationMs: 90 })),
          },
        },
      },
      {
        id: 'title',
        type: 'text',
        box: { x: 76, y: 0, width: 616, height: 22 },
        visible: true,
        opacity: 1,
        runs: [
          { var: 'bossName', color: '#FF5B4DFF' },
          { text: '  目标：', color: '#C8C8C8FF' },
          { var: 'targetName', color: '#FFFFFFFF' },
        ],
        fontSize: 18,
        color: '#FFE1C0FF',
        align: 'center',
        verticalAlign: 'middle',
        shadow: true,
      },
      {
        id: 'health_text',
        type: 'text',
        box: { x: 76, y: 26, width: 616, height: 20 },
        visible: true,
        opacity: 1,
        runs: [{ var: 'healthText' }],
        fontSize: 14,
        color: '#FFFFFFFF',
        align: 'center',
        verticalAlign: 'middle',
        shadow: true,
      },
    ],
  }
}

function simpleBar(texture: string): BossbarDocument {
  return {
    format: 'hanshu.bossbar',
    version: 2,
    id: 'hanshu:simple_bar',
    priority: 0,
    texture,
    layout: { dock: 'top-center', scale: 1, safeMargin: 12 },
    variables: {
      healthProgress: { type: 'double', default: 0.65 },
      healthText: { type: 'string', default: '65 / 100', maxLength: 64 },
    },
    components: [
      { id: 'region', type: 'display_region', box: { x: 0, y: 0, width: 320, height: 24 } },
      {
        id: 'track',
        type: 'background',
        box: { x: 0, y: 0, width: 320, height: 24 },
        visible: true,
        opacity: 1,
        paint: { kind: 'texture', uv: UV.track, fit: 'stretch' },
      },
      {
        id: 'fill',
        type: 'bar',
        box: { x: 2, y: 2, width: 316, height: 20 },
        visible: true,
        opacity: 1,
        progress: { var: 'healthProgress' },
        direction: 'left-to-right',
        fill: { kind: 'texture', uv: UV.fill, fit: 'stretch' },
        smoothMs: 120,
      },
      {
        id: 'label',
        type: 'text',
        box: { x: 0, y: 0, width: 320, height: 24 },
        visible: true,
        opacity: 1,
        runs: [{ var: 'healthText' }],
        fontSize: 14,
        color: '#FFFFFFFF',
        align: 'center',
        verticalAlign: 'middle',
        shadow: true,
      },
    ],
  }
}

const atlasPath = resolve(demoRoot, 'assets/ui/bossbar/atlas.png')
try {
  await stat(atlasPath)
} catch {
  console.error('缺少演示图集：' + atlasPath + '\n先运行 python3 scripts/make-bossbar-demo-atlas.py')
  process.exit(1)
}

const atlasBytes = await readFile(atlasPath)
const texture = encodeBase64(new Uint8Array(atlasBytes))

const documents: [string, BossbarDocument][] = [
  ['src/bossbars/ember_guard.bossbar', emberGuard(texture)],
  ['src/bossbars/simple_bar.bossbar', simpleBar(texture)],
]

for (const [relative, document] of documents) {
  const target = resolve(demoRoot, relative)
  await mkdir(dirname(target), { recursive: true })
  const text = stringifyBossbar(document)
  const check = parseBossbarDocument(text)
  if (!check.ok) {
    console.error('生成的文档不合法：' + relative)
    for (const diagnostic of check.diagnostics) console.error('  ' + diagnostic.path + ': ' + diagnostic.message)
    process.exit(1)
  }
  await writeFile(target, text)
  console.log('写入 ' + relative + '（' + text.length + ' 字节）')
}

await mkdir(resolve(demoRoot, 'meta/docs'), { recursive: true })
await writeFile(
  resolve(demoRoot, 'project.json'),
  JSON.stringify(
    {
      version: 1,
      name: '演示 BossBar',
      id: 'demo-bossbar',
      activeScript: 'ember_guard.bossbar',
      collapsed: false,
      assetsCollapsed: false,
    },
    null,
    2,
  ) + '\n',
)

const referenceSource = resolve(repo, 'src/help/docs/images/bossbar-reference.png')
try {
  await copyFile(referenceSource, resolve(demoRoot, 'assets/ui/bossbar/reference.png'))
} catch {
  console.warn('没有找到参考截图，跳过 assets/ui/bossbar/reference.png')
}
await copyFile(atlasPath, resolve(demoRoot, 'meta/docs/atlas.png'))

console.log('演示工程已生成：' + demoRoot)
