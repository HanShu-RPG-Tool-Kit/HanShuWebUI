import assert from 'node:assert/strict'
import { createBossbar } from '../src/workspaces/audiovisual/bossbar/parse'
import { buildScene } from '../src/workspaces/audiovisual/bossbar/render/scene'
import { drawBossbarScene } from '../src/workspaces/audiovisual/bossbar/render/canvas'
import { collectSnapLines, movableSelection, moveBoxes, moveRegionBox } from '../src/workspaces/audiovisual/bossbar/editor/editorGeometry'
import type { BossbarBox } from '../src/workspaces/audiovisual/bossbar/protocol'

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`)
const region = { x: 0, y: 0, width: 100, height: 70 }
const first = { x: 10, y: 10, width: 20, height: 10 }
const second = { x: 60, y: 40, width: 30, height: 20 }

// A pointer delta of 38 puts the left edge at 48, within two pixels of the target.
const snapLines = collectSnapLines([{ x: 50, y: 10, width: 20, height: 10 }], region, 8, false)
const snapped = moveBoxes([first], { x: 38, y: 0 }, region, { lines: snapLines, threshold: 6 })
assert.equal(snapped.boxes[0].x, 50, '移动后的候选矩形吸附到附近组件')
assert.equal(moveBoxes([first], { x: 38, y: 0 }, region).boxes[0].x, 48, 'Alt 跳过吸附')

const together = moveBoxes([first, second], { x: 500, y: 500 }, region)
assert.deepEqual(together.boxes, [{ ...first, x: 20, y: 20 }, { ...second, x: 70, y: 50 }], '多选到边界时整组停止')
assert.equal(together.boxes[1].x - together.boxes[0].x, 50, '保持水平间距')
assert.equal(together.boxes[1].y - together.boxes[0].y, 30, '保持垂直间距')
const fractional: BossbarBox[] = [
  { x: 0.0002, y: 0, width: 10, height: 10 },
  { x: 89.9997, y: 0, width: 10, height: 10 },
]
const fractionalMoved = moveBoxes(fractional, { x: 50, y: 0 }, region).boxes
near(fractionalMoved[1].x + fractionalMoved[1].width, 100)
near(fractionalMoved[1].x - fractionalMoved[0].x, fractional[1].x - fractional[0].x)

const negativeLines = collectSnapLines([], { x: -100, y: -50, width: 200, height: 100 }, 8, true)
assert.ok([-100, -96, 0, 96, 100].every((x) => negativeLines.x.includes(x)), '负坐标区域边界、中心及网格正确')
assert.ok(negativeLines.x.every((x) => x >= -100 && x <= 100))
assert.ok(negativeLines.y.includes(-50) && negativeLines.y.includes(0) && negativeLines.y.includes(50))

const document = createBossbar('rendering-regression')
document.components.push(
  { id: 'locked', type: 'background', box: first, visible: true, opacity: 1, paint: { kind: 'solid', color: '#FF0000FF' } },
  { id: 'free', type: 'background', box: second, visible: true, opacity: 1, paint: { kind: 'solid', color: '#FF0000FF' } },
)
const movable = movableSelection(document.components, [document.components[0].id, 'locked', 'free'], ['locked'])
assert.deepEqual(movable.map((component) => component.id), ['free'], '多选移动排除锁定图层及显示区域')
assert.deepEqual(moveBoxes(movable.map((component) => component.box), { x: 5, y: 0 }, region).boxes, [{ ...second, x: 65 }])
assert.deepEqual(document.components[1].box, first, '锁定组件的位置不变')

const contents = [{ x: -80, y: -40, width: 40, height: 20 }, { x: 20, y: 10, width: 40, height: 20 }]
assert.deepEqual(
  moveRegionBox({ x: -100, y: -50, width: 200, height: 100 }, { x: 500, y: -500 }, contents),
  { x: -80, y: -70, width: 200, height: 100 },
  '显示区域只能在继续包含全部组件的范围内移动',
)
assert.deepEqual(contents, [{ x: -80, y: -40, width: 40, height: 20 }, { x: 20, y: 10, width: 40, height: 20 }], '单独移动区域不带动组件')
assert.deepEqual(moveRegionBox(region, { x: -10, y: 20 }, []), { ...region, x: -10, y: 20 }, '空区域可自由移动')

// Exercise the scene-to-Canvas path: color alpha and component opacity multiply once.
document.components = [document.components[0],
  { id: 'background', type: 'background', box: first, visible: true, opacity: 0.5, paint: { kind: 'solid', color: '#FF000080' } },
  {
    id: 'bar', type: 'bar', box: first, visible: true, opacity: 0.5,
    progress: 0.5,
    direction: 'left-to-right', smoothMs: 0, fill: { kind: 'solid', color: '#FF000080' },
  },
  {
    id: 'text', type: 'text', box: { ...first, width: 100 }, visible: true, opacity: 0.5,
    runs: [{ text: 'alpha' }], fontSize: 16, color: '#FF000080', align: 'left', verticalAlign: 'middle', shadow: false,
  },
]
const scene = buildScene({ document, values: {}, timeMs: 0, texture: { width: 1, height: 1 } })
const alphas: number[] = []
const context = {
  globalAlpha: 1,
  fillStyle: '',
  save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
  fillRect() { alphas.push(this.globalAlpha * Number(this.fillStyle.match(/,([^,]+)\)$/)?.[1])) },
  fillText() { alphas.push(this.globalAlpha * Number(this.fillStyle.match(/,([^,]+)\)$/)?.[1])) },
}
drawBossbarScene(context as unknown as CanvasRenderingContext2D, scene, { texture: null, measure: (text) => text.length * 8 })
assert.equal(alphas.length, 3)
alphas.forEach((alpha) => near(alpha, 0.5 * 128 / 255))
assert.deepEqual(scene.commands.filter((command) => command.kind === 'fill').map((command) => command.rect.width), [20, 10], '纯色条保留50%裁切')
console.log('PASS verify-bossbar-rendering：移动吸附、整组边界、锁定、负坐标、区域拖动及颜色alpha')
