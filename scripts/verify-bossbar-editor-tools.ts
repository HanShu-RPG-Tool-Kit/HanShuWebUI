import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import type { BossbarAnimation, BossbarDocument, BossbarVariable } from '../src/workspaces/audiovisual/bossbar/protocol'
import { BOSSBAR_DEFAULT_TEXTURE } from '../src/workspaces/audiovisual/bossbar/protocol'
import { sampleAnimation, stepAnimationFrame } from '../src/workspaces/audiovisual/bossbar/rules/frames'
import { resolveValues } from '../src/workspaces/audiovisual/bossbar/rules/values'
import { animationFramesAtFps, gridAnimationFrames } from '../src/workspaces/audiovisual/bossbar/editor/animationTools'
import { buildScenarios, loadEditorViewState, parseVariableInput, saveEditorViewState, simulateVariable, variableSimulationMode } from '../src/workspaces/audiovisual/bossbar/editor/editorState'
import { BossbarVariablesPanel } from '../src/workspaces/audiovisual/bossbar/editor/BossbarVariablesPanel'
import { BossbarProgressEditor } from '../src/workspaces/audiovisual/bossbar/editor/BossbarProgressEditor'
import { BossbarInspector } from '../src/workspaces/audiovisual/bossbar/editor/BossbarInspector'

const animation: BossbarAnimation = {
  mode: 'loop', phaseMs: 0,
  frames: [100, 100, 500, 100].map((durationMs, index) => ({ uv: { x: index, y: 0, width: 1, height: 1 }, durationMs })),
}
const frameAt = (value: BossbarAnimation, time: number) => sampleAnimation(value, value.frames[0].uv, time).index
assert.equal(stepAnimationFrame(animation, 200, -1), 100, '从长帧返回前帧不能跳过短帧')
assert.equal(frameAt(animation, stepAnimationFrame(animation, 250, -1)), 1)
assert.equal(stepAnimationFrame(animation, 250, 1), 700)
assert.equal(stepAnimationFrame(animation, 700, 1), 800, '循环末帧进入下一周期')
assert.equal(stepAnimationFrame(animation, 800, -1), 700)
const phase = { ...animation, phaseMs: 150 }
assert.equal(stepAnimationFrame(phase, 50, -1), 0, '相位后的前帧不得产生负时间')
assert.equal(stepAnimationFrame(phase, 50, 1), 550)
const pingpong: BossbarAnimation = { ...animation, mode: 'pingpong' }
assert.equal(frameAt(pingpong, 800), 2)
assert.equal(stepAnimationFrame(pingpong, 800, 1), 1300)
assert.equal(frameAt(pingpong, stepAnimationFrame(pingpong, 800, -1)), 3)
assert.equal(stepAnimationFrame(pingpong, 1300, 1), 1400)
const once = { ...animation, mode: 'once' as const }
assert.equal(stepAnimationFrame(once, 200, -1), 100)
assert.equal(stepAnimationFrame(once, 1000, 1), 1000, 'once 结束后点下一帧不会倒退时钟')
assert.equal(stepAnimationFrame(once, 1000, -1), 200)
console.log('通过：不等时长、相位、循环和 pingpong 的前后帧边界')

const grid = { x: 8, y: 4, width: 16, height: 8 }
const texture = { width: 64, height: 32 }
const rows = gridAnimationFrames(grid, texture, { columns: 3, rows: 2, count: 5, order: 'rows', durationMs: 100 })!
assert.deepEqual(rows.map(({ uv }) => [uv.x, uv.y]), [[8, 4], [24, 4], [40, 4], [8, 12], [24, 12]])
const columns = gridAnimationFrames(grid, texture, { columns: 3, rows: 2, count: 5, order: 'columns', durationMs: 100 })!
assert.deepEqual(columns.map(({ uv }) => [uv.x, uv.y]), [[8, 4], [8, 12], [24, 4], [24, 12], [40, 4]])
assert.equal(gridAnimationFrames(grid, texture, { columns: 4, rows: 1, count: 4, order: 'rows', durationMs: 100 }), null, '网格不能越出图集')
assert.equal(gridAnimationFrames(grid, texture, { columns: 1, rows: 1, count: 2, order: 'rows', durationMs: 100 }), null)
const sixtyFrames = Array.from({ length: 60 }, () => animation.frames[0])
const fpsFrames = animationFramesAtFps(sixtyFrames, 60)!
assert.equal(fpsFrames.reduce((sum, frame) => sum + frame.durationMs, 0), 1000, '60 FPS 一秒总长必须恰为1000ms')
assert.ok(fpsFrames.every((frame) => frame.durationMs === 16 || frame.durationMs === 17))
assert.equal(animationFramesAtFps(sixtyFrames, 100), null)
assert.equal(animationFramesAtFps(sixtyFrames, 0), null)
console.log('通过：逐行/逐列 UV 展开、图集边界与 FPS 整数毫秒分配')

const double: BossbarVariable = { type: 'double', default: 10 }
assert.deepEqual(parseVariableInput(double, '1e20'), { type: 'double', value: 1e20 })
assert.deepEqual(parseVariableInput(double, '5e-324'), { type: 'double', value: Number.MIN_VALUE })
assert.deepEqual(parseVariableInput(double, String(Number.MAX_VALUE)), { type: 'double', value: Number.MAX_VALUE })
for (const invalid of ['Infinity', 'NaN', '1e309', '', ' ', '0x10']) assert.equal(parseVariableInput(double, invalid), null)
assert.deepEqual(parseVariableInput({ type: 'string', default: '', maxLength: 10 }, ' a '), { type: 'string', value: ' a ' })
const document: BossbarDocument = {
  format: 'hanshu.bossbar', version: 2, id: 'simulation-test', priority: 7, texture: BOSSBAR_DEFAULT_TEXTURE,
  layout: { dock: 'top-center', scale: 0.5, safeMargin: 12 }, variables: { health: double },
  components: [{ id: 'region', type: 'display_region', box: { x: 0, y: 0, width: 768, height: 72 } }],
}
const good = { health: { type: 'double' as const, value: 20 } }
const missing = simulateVariable(good, 'health', double, 'missing')
assert.equal(variableSimulationMode(double, missing.health), 'missing')
assert.equal(resolveValues(document, missing).values.health.value, 10)
assert.equal(resolveValues(document, missing).issues[0].code, 'value_missing')
const wrong = simulateVariable(good, 'health', double, 'wrong-type')
assert.equal(variableSimulationMode(double, wrong.health), 'wrong-type')
assert.equal(resolveValues(document, wrong).values.health.value, 10)
assert.equal(resolveValues(document, wrong).issues[0].code, 'value_type')
assert.deepEqual(simulateVariable(wrong, 'health', double, 'value').health, { type: 'double', value: 10 })
assert.deepEqual(good.health, { type: 'double', value: 20 }, '模拟状态切换不改写原始输入')
const html = renderToStaticMarkup(createElement(BossbarVariablesPanel, {
  document, values: good, readOnly: true, onDocumentChange() { throw new Error('viewer changed document') },
  onValuesChange() {}, onSelectComponent() {},
}))
const simulatedInput = html.match(/模拟值<\/span><span[^>]*>(<input[^>]+>)/)?.[1]
assert.ok(simulatedInput, 'viewer 可看到模拟值输入')
assert.doesNotMatch(simulatedInput, /disabled/, 'viewer 的本机模拟输入可以编辑')
assert.match(html, /缺失变量/)
assert.match(html, /类型不符/)
assert.doesNotMatch(html, /blackboard|Map 键|服务端键|putDouble/)
console.log('通过：完整有限 double、缺失/错误类型回落及 viewer 本机模拟输入')

const bound: BossbarDocument = {
  ...document,
  variables: {
    health: double,
    unrelated: { type: 'double', default: 999 },
    counter: { type: 'long', default: '9007199254740993' },
    title: { type: 'string', default: '守卫', maxLength: 64 },
    enraged: { type: 'bool', default: false },
  },
  components: [
    ...document.components,
    { id: 'health_fill', type: 'bar', box: { x: 0, y: 0, width: 200, height: 12 }, visible: true, opacity: 1,
      progress: { var: 'health' }, fill: { kind: 'solid', color: '#FF0000FF' }, direction: 'left-to-right', smoothMs: 0 },
    { id: 'title', type: 'text', box: { x: 0, y: 16, width: 200, height: 16 }, visible: true, opacity: 1,
      fontSize: 12, color: '#FFFFFFFF', align: 'left', verticalAlign: 'middle', shadow: false,
      runs: [{ text: '数值：' }, { var: 'counter' }] },
  ],
}
const scenarios = buildScenarios(bound)
assert.deepEqual(scenarios.filter((entry) => ['full', 'injured', 'low', 'empty', 'overheal', 'negative'].includes(entry.id))
  .map((entry) => entry.values.health.value), [1, 0.35, 0.08, 0, 1.4, -0.2])
assert.ok(scenarios.every((entry) => entry.values.unrelated.value === 999 && entry.values.counter.value === '9007199254740993'),
  '进度模拟不改写无关服务端变量，也不推导数值上下限')
const literal = { ...bound, components: bound.components.map((component) => component.type === 'bar' ? { ...component, progress: 0.6 } : component) }
assert.deepEqual(buildScenarios(literal).map((entry) => entry.id), ['default', 'toggle-enraged'], '固定进度不生成变量模拟')
const progressHtml = renderToStaticMarkup(createElement(BossbarProgressEditor, {
  progress: { var: 'health' }, variables: bound.variables, readOnly: false, onChange() {},
}))
assert.match(progressHtml, /health/)
assert.doesNotMatch(progressHtml, /counter|enraged|title|最大值|最小值|当前值/)
const inspectorProps = { document: bound, texture: { width: 1, height: 1 }, readOnly: false,
  onChange() {}, onMoveAll() {}, onFitRegion() {}, onFocusRegion() {} }
const settingsHtml = renderToStaticMarkup(createElement(BossbarInspector, { ...inspectorProps, selection: ['region'] }))
assert.match(settingsHtml, /优先级/)
assert.match(settingsHtml, /min="-2147483648"/)
assert.match(settingsHtml, /max="2147483647"/)
const textHtml = renderToStaticMarkup(createElement(BossbarInspector, { ...inspectorProps, selection: ['title'] }))
assert.match(textHtml, /counter/)
assert.doesNotMatch(textHtml, /小数位|百分比|紧凑数值|比例范围|>格式</)
console.log('通过：0–1 进度绑定、原始文本变量和根级优先级属性')

const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const storage = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem(key: string) { return storage.get(key) ?? null },
  setItem(key: string, value: string) { storage.set(key, value) },
} })
try {
  const key = 'hanshu.bossbarEditor.v2::prefs-project::prefs-file'
  storage.set(key, JSON.stringify({ zoom: 1.5, panX: -20, playbackSpeed: 1.3,
    previewOpen: true, previewGuiWidth: 1920, previewGuiHeight: 1080 }))
  const view = loadEditorViewState('prefs-project', 'prefs-file')
  assert.equal(view.zoom, 1.5)
  assert.equal(view.panX, -20)
  assert.equal(view.playbackSpeed, 1.3)
  assert.ok(Object.keys(view).every((name) => !name.startsWith('preview')))
  saveEditorViewState('prefs-project', 'prefs-file', view)
  assert.doesNotMatch(storage.get(key)!, /previewOpen|previewGuiWidth|previewGuiHeight/)
} finally {
  if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
  else delete (globalThis as any).localStorage
}
console.log('通过：单视口偏好保留相机与播放状态，忽略旧游戏预览尺寸')

// 为真实 hook 提供同步 React 调度器，验证正文来源切换后的行为；不复制历史实现。
const hooksKey = '__bossbarEditorToolsHooks'
let slots: any[] = []
let cursor = 0
let pendingEffects: (() => void)[] = []
let dirty = false
const hooks = {
  useState(initial: any) {
    const index = cursor++
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
    return [slots[index], (next: any) => {
      const value = typeof next === 'function' ? next(slots[index]) : next
      if (!Object.is(value, slots[index])) { slots[index] = value; dirty = true }
    }]
  },
  useRef(initial: any) {
    const index = cursor++
    if (!(index in slots)) slots[index] = { current: initial }
    return slots[index]
  },
  useCallback(callback: any) { return callback },
  useEffect(effect: () => void, deps: unknown[]) {
    const index = cursor++
    const previous = slots[index] as unknown[] | undefined
    if (!previous || deps.some((value, at) => !Object.is(value, previous[at]))) {
      slots[index] = deps
      pendingEffects.push(effect)
    }
  },
}
;(globalThis as any)[hooksKey] = hooks
try {
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL('../src/workspaces/audiovisual/bossbar/editor/editorState.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs',
    plugins: [{ name: 'history-hook-scheduler', setup(builder) {
      builder.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'history-hook-scheduler' }))
      builder.onLoad({ filter: /.*/, namespace: 'history-hook-scheduler' }, () => ({
        contents: ['useState', 'useRef', 'useCallback', 'useEffect'].map((name) =>
          `export const ${name} = (...args) => globalThis.${hooksKey}.${name}(...args);`).join('\n'), loader: 'js',
      }))
    } }],
  })
  const module = { exports: {} as any }
  new Function('module', 'exports', bundled.outputFiles[0].text)(module, module.exports)
  const renderHistory = (content: string) => {
    let result
    let passes = 0
    do {
      assert.ok(passes++ < 10, '历史 hook 不应持续重渲染')
      cursor = 0; dirty = false; pendingEffects = []
      result = module.exports.useBossbarHistory(content)
      for (const effect of pendingEffects) effect()
    } while (dirty)
    return result
  }
  let history = renderHistory('initial')
  history.commit('design edit')
  history = renderHistory('design edit')
  assert.equal(history.depth, 1, '设计回写只记一次')
  history = renderHistory('JSON edit')
  assert.equal(history.depth, 2, '外部 JSON 正文进入同一撤销栈')
  assert.equal(history.undo(), 'design edit')
  history = renderHistory('design edit')
  assert.equal(history.depth, 1)
  assert.equal(history.undo(), 'initial')
  history = renderHistory('initial')
  assert.equal(history.depth, 0)
  assert.equal(history.redo(), 'design edit')
  history = renderHistory('design edit')
  assert.equal(history.redo(), 'JSON edit')
  history = renderHistory('JSON edit')
  assert.equal(history.depth, 2, '撤销重做回写不产生额外历史')
  history = renderHistory('{broken JSON')
  assert.equal(history.undo(), 'JSON edit', '非法 JSON 仍可撤销回有效正文')
  slots = []
} finally { delete (globalThis as any)[hooksKey] }
console.log('通过：设计和 JSON 共用撤销/重做历史，内部回写不重复记步')
console.log('PASS verify-bossbar-editor-tools')
