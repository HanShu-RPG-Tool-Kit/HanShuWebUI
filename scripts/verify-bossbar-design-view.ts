import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BossbarDesignView } from '../src/workspaces/audiovisual/bossbar/editor/BossbarDesignView'
import { BossbarSimulationControls } from '../src/workspaces/audiovisual/bossbar/editor/BossbarSimulationControls'
import { updatePaintUv } from '../src/workspaces/audiovisual/bossbar/editor/editorPaint'
import { createBossbar, type BossbarTexturePaint } from '../src/workspaces/audiovisual/bossbar/index'

const render = (content: string, readOnly = false) => renderToStaticMarkup(createElement(BossbarDesignView, {
  content, readOnly, fileId: 'review', fileName: 'review.bossbar', projectId: 'review', packageId: null,
  assets: [], active: false, onChange: () => assert.fail('渲染不能反向修改源码'),
}))
const legacy = JSON.stringify({ format: 'hanshu.bossbar', version: 1, id: 'legacy' })
const legacyHtml = render(legacy)
assert.match(legacyHtml, /升级为可视化血条/)
assert.doesNotMatch(legacyHtml, /无法显示设计视图/)
assert.match(render(legacy, true), /<button[^>]*disabled[^>]*>升级为可视化血条<\/button>/)
assert.match(render('{broken json'), /无法显示设计视图/)
assert.match(render(JSON.stringify({ format: 'hanshu.bossbar', version: 99 })), /不支持 version 99/)
const validHtml = render(JSON.stringify(createBossbar('review')))
assert.match(validHtml, /aria-label="BossBar 编辑视口"/)
assert.match(validHtml, /aria-label="画布模拟"/)
assert.equal((validHtml.match(/<canvas\b/g) ?? []).length, 1, '编辑画布是唯一的渲染视口')
assert.doesNotMatch(validHtml, /游戏输出预览|GUI 宽度|常用分辨率|显示游戏预览|展开游戏预览/)
const viewerHtml = render(JSON.stringify(createBossbar('viewer')), true)
const viewerPlayback = viewerHtml.match(/<button[^>]*>暂停<\/button>/)?.[0]
assert.ok(viewerPlayback, '只读成员保留模拟播放控制')
assert.doesNotMatch(viewerPlayback, /disabled/)
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: () => JSON.stringify({ previewOpen: false, previewGuiWidth: 64, previewGuiHeight: 400, zoom: 2, panX: 15, panY: 25 }) },
})
try {
  const previousPreferencesHtml = render(JSON.stringify(createBossbar('previous-preferences')))
  assert.match(previousPreferencesHtml, /aria-label="画布模拟"/, '旧版关闭独立预览的偏好不会隐藏画布模拟')
  assert.match(previousPreferencesHtml, /200%/, '保留原有编辑相机偏好')
  assert.equal((previousPreferencesHtml.match(/<canvas\b/g) ?? []).length, 1)
} finally {
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor)
  else Reflect.deleteProperty(globalThis, 'localStorage')
}
console.log('通过：首次打开 v1 显示升级入口，只读升级禁用，非法和未知版本保留原文')

const controlsHtml = renderToStaticMarkup(createElement(BossbarSimulationControls, {
  document: createBossbar('controls'), timeMs: 250, playing: false, speed: 1.3,
  issues: ['health：缺少值，使用默认值'], scenarios: [{ id: 'full', label: '满血', values: {} }],
  onPlayingChange() {}, onTimeChange() {}, onSpeedChange() {}, onScenario() {},
}))
assert.doesNotMatch(controlsHtml, /<canvas\b/)
assert.match(controlsHtml, /时间轴/)
assert.match(controlsHtml, /上一帧/)
assert.match(controlsHtml, /下一帧/)
assert.match(controlsHtml, /aria-label="模拟场景"/)
assert.match(controlsHtml, /<option value="full">满血<\/option>/)
assert.match(controlsHtml, /<option value="1.3" selected="">1.3×<\/option>/, '保留已有会话的播放速度')
assert.match(controlsHtml, /health：缺少值，使用默认值/, '模拟回退原因仍然可见')
console.log('通过：单编辑视口内保留模拟控制、旧播放速度及回退原因，无独立输出画布')

const uv = { x: 0, y: 0, width: 8, height: 8 }
const second = { ...uv, x: 8 }
const moved = { ...uv, x: 24 }
const paint: BossbarTexturePaint = {
  kind: 'texture', fit: 'stretch', uv,
  animation: { mode: 'loop', phaseMs: 0, frames: [{ uv, durationMs: 100 }, { uv: second, durationMs: 200 }] },
}
const next = updatePaintUv(paint, moved, 1)
assert.equal(next.kind, 'texture')
if (next.kind === 'texture') {
  assert.deepEqual(next.uv, uv)
  assert.deepEqual(next.animation?.frames[0].uv, uv)
  assert.deepEqual(next.animation?.frames[1].uv, moved)
  assert.equal(next.animation?.frames[1].durationMs, 200)
}
const first = updatePaintUv(paint, moved, 0)
if (first.kind === 'texture') {
  assert.deepEqual(first.uv, moved)
  assert.deepEqual(first.animation?.frames[0].uv, moved)
  assert.deepEqual(first.animation?.frames[1].uv, second)
}
assert.deepEqual(paint.animation?.frames[1].uv, second, 'UV 编辑不修改旧草稿')
assert.equal(updatePaintUv(paint, moved, 9), paint)
console.log('通过：图集框选精确更新指定帧，第一帧与静态 UV 同步，旧草稿保持不变')
console.log('PASS verify-bossbar-design-view')
