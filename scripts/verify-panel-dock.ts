import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { defaultRecord, emptyLanes, layoutFrame, layoutFromSaved, orderTab, resizeCell, setCellPixels, type DockLayout } from '../src/ui/panelDockModel'

function fixture(): DockLayout {
  return { version: 3, agentSized: true, panels: Object.fromEntries(['a', 'hidden', 'b'].map(id => [id, defaultRecord({ id })])), lanes: { ...emptyLanes(), left: [{ size: 280, cells: ['a', 'hidden', 'b'].map(id => ({ id, weight: 1 })) }] }, floatGroups: [] }
}
const layout = fixture()
const before = JSON.stringify(layout)
assert.deepEqual(Object.keys(layoutFrame(layout, { width: 1200, height: 600 }, new Set(['a', 'b'])).bands), ['a', 'b'])
assert.equal(JSON.stringify(layout), before, 'hiding panels must not mutate the persisted layout')
setCellPixels(layout, 'left', 0, 0, 200, 394, 600, new Set(['a', 'b']))
const cells = layout.lanes.left[0].cells
assert.equal(cells[1].weight, 1)
assert.ok(Math.abs(cells[0].weight + cells[2].weight - 2) < 1e-9)
const restored = layoutFrame(layout, { width: 1200, height: 600 }, new Set(['a', 'hidden', 'b']))
assert.equal(restored.bands.hidden.h, 196, 'restored hidden cell retains its share')
resizeCell(layout, 'left', 0, 0, 40, 600)
assert.ok(Math.abs(cells.reduce((sum, cell) => sum + cell.weight, 0) - 3) < 1e-9)
resizeCell(layout, 'left', 0, 0, 1000, 20)
assert.ok(cells.every(cell => cell.weight > 0), 'tiny containers never produce negative cell weights')

for (const floating of [false, true]) {
  const tabs = fixture()
  if (floating) {
    for (const panel of Object.values(tabs.panels)) panel.placement = 'float'
    tabs.lanes = emptyLanes()
    tabs.floatGroups = [{ tabs: ['a', 'hidden', 'b'], active: 'a' }]
  } else tabs.lanes.left[0].cells = [{ id: 'a', tabs: ['a', 'hidden', 'b'], weight: 1 }]
  orderTab(tabs, 'a', 1, new Set(['a', 'b']))
  assert.deepEqual(floating ? tabs.floatGroups![0].tabs : tabs.lanes.left[0].cells[0].tabs, ['b', 'hidden', 'a'])
  assert.deepEqual(layoutFromSaved(JSON.parse(JSON.stringify(tabs))), tabs)
}
// 面板声明住在工作区之外：面板是「要什么」（host 传入依赖），不是工作区组件里的闭包。
// 守的是已经拿到的结构——声明 / 能力 / 布局数据三层分开，换面板或换视图都不用回头改工作区。
// 与是否做混合布局无关，所以这条守卫长期有效。
const stageplayWorkspace = await readFile(new URL('../src/workspaces/StageplayWorkspace.tsx', import.meta.url), 'utf8')
const stageplayPanels = await readFile(new URL('../src/workspaces/stageplay/dockPanels.tsx', import.meta.url), 'utf8')
assert.ok(
  !/DockPanelSpec\[\]\s*=/.test(stageplayWorkspace),
  '剧本工作区不再内联面板声明：面板改由 stageplay/dockPanels.tsx 的 stageplayDockPanels(host) 生成',
)
assert.match(
  stageplayPanels,
  /export function stageplayDockPanels\(host: StageplayDockHost\): DockPanelSpec\[\]/,
  '面板生成函数与 host 类型必须显式导出',
)
assert.ok(
  !/workspaceRef|useState|useRef/.test(stageplayPanels),
  '面板声明不持有工作区状态：依赖只能从 host 传进来',
)
for (const id of ['explorer', 'asset-manager', 'agent', 'roles', 'studio']) {
  assert.ok(stageplayPanels.includes(`id: '${id}'`), `面板 ${id} 仍在声明表里`)
}
// 一个视图一份布局：每个 PanelDock 都必须显式传自己的键，且各视图的键互不相同。
// 少了这条，某个视图会悄悄落回默认键、和别的视图共用一份布局。
const mounts = [
  '../src/workspaces/StageplayWorkspace.tsx',
  '../src/workspaces/GameplayWorkspace.tsx',
  '../src/workspaces/AudiovisualWorkspace.tsx',
  '../src/skin/SkinWorkspace.tsx',
  '../src/workspaces/audiovisual/bossbar/editor/BossbarDesignView.tsx',
]
const dockKeys: { file: string; name: string; value: string }[] = []
for (const file of mounts) {
  const source = await readFile(new URL(file, import.meta.url), 'utf8')
  const mounted = /<PanelDock[^>]*storageKey=\{(\w+)\}/.exec(source)
  assert.ok(mounted, `${file} 的 PanelDock 必须显式传 storageKey（各视图布局独立）`)
  const name = mounted![1]
  const declared = new RegExp(`const ${name} = ['\"]([^'\"]+)['\"]`).exec(source)
  assert.ok(declared, `${file} 里 ${name} 必须是字符串常量，不能就地写死或从别处借用`)
  dockKeys.push({ file, name, value: declared![1] })
}
const values = dockKeys.map((entry) => entry.value)
assert.equal(new Set(values).size, values.length, `各视图的布局键必须互不相同：${values.join(', ')}`)
const sharedAssets = await readFile(new URL('../src/workspaces/assetManager/assetActions.ts', import.meta.url), 'utf8')
assert.match(
  sharedAssets,
  /export function createAssetActions\(deps: AssetActionDeps\): AssetActions/,
  'assets 写操作以能力对象导出，依赖由宿主注入',
)
assert.ok(
  !/useState|useRef/.test(sharedAssets),
  'assets 能力不持有状态：工作区投影从 deps 进来',
)
assert.ok(
  !/from '..\/i18n/.test(sharedAssets),
  'assets 能力不认识配音模块：它是三个工作区共用的，删除时的刷新由宿主用 onAssetsChanged 提供',
)
// 资产管理器在三个视图里共用：外观必须自带令牌，不能借资源管理器壳上的 --xs-*。
// 借令牌的代价已经付过一次——面板挂在停靠栏里（不在 .explorer-shell 内）时 --xs-icon 没有定义，
// width: var(--xs-icon) 整条失效，svg 退回 100% 宽，一行被图标撑满。
const assetPanel = await readFile(new URL('../src/workspaces/assetManager/AssetManagerPanel.tsx', import.meta.url), 'utf8')
const assetCss = await readFile(new URL('../src/workspaces/assetManager/assetManager.css', import.meta.url), 'utf8')
assert.match(assetPanel, /import "\.\/assetManager\.css"/, '资产管理器自己带样式表')
const assetRules = assetCss.replace(/\/\*[\s\S]*?\*\//g, '')
assert.ok(!/var\(--xs-/.test(assetRules), '资产管理器样式不借资源管理器壳的 --xs-* 令牌（别的视图里没定义）')
for (const token of ['--am-icon', '--am-row-h', '--am-font-sm']) {
  assert.ok(assetCss.includes(`${token}:`), `资产管理器令牌 ${token} 自己定义`)
}
// 三个带编辑器的视图都能呼出同一份资产管理器（面板来自 sharedAssets 所在模块）
for (const file of ['../src/workspaces/StageplayWorkspace.tsx', '../src/workspaces/GameplayWorkspace.tsx', '../src/workspaces/AudiovisualWorkspace.tsx']) {
  const source = await readFile(new URL(file, import.meta.url), 'utf8')
  assert.match(source, /assetManager\/assetActions/, `${file} 用共享的 assets 能力模块`)
}
for (const handler of ['handleImportAssets', 'handleDeleteAsset', 'handleNewAssetFolder', 'handleDeleteAssetFolder', 'applyAssetMove']) {
  assert.ok(
    !stageplayWorkspace.includes(`const ${handler} `) && !stageplayWorkspace.includes(`const ${handler} =`),
    `资产写操作 ${handler} 不再内联在剧本工作区里`,
  )
}
for (const handler of ['handleImportAssets', 'handleDeleteAsset', 'handleNewAssetFolder', 'handleDeleteAssetFolder', 'applyAssetMove']) {
  assert.ok(
    !stageplayWorkspace.includes(`const ${handler} `) && !stageplayWorkspace.includes(`const ${handler} =`),
    `资产写操作 ${handler} 不再内联在剧本工作区里`,
  )
}
console.log('通过：隐藏面板布局保持、分隔条权重、极小容器、隐藏 tab 排序与持久化、面板声明与工作区解耦、每个视图一份独立布局键、assets 能力三视图共用')
