/** 临时 SSR 冒烟（跑完即删）：锁状态驱动资源树按钮 + AssetPreview 只读。 */
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { StageplayAssetsAddon } from '../src/workspaces/stageplay/StageplayAssetsAddon'
import { AssetPreview } from '../src/AssetPreview'
import type { Project } from '../src/workspace'

const LANG = 'assets/zh_cn/lang_hs/序章.lang'
const EN = 'assets/en_us/lang_hs/序章.lang'
const project = {
  id: 'p1',
  name: 'P',
  collapsed: false,
  assetsCollapsed: false,
  scripts: [],
  assetFolders: [],
  assets: [
    { id: 'a1', path: LANG, mime: 'application/json', size: 10, updatedAt: 0 },
    { id: 'a2', path: EN, mime: 'application/json', size: 10, updatedAt: 0 },
  ],
} as unknown as Project

const noop = () => {}
const html = renderToStaticMarkup(
  createElement(StageplayAssetsAddon, {
    project,
    activeAssetId: null,
    lockedAssetPaths: new Set([LANG]),
    onToggleRoot: noop,
    onOpenAsset: noop,
    onDeleteAsset: noop,
    onNewAssetFolder: noop,
    onDeleteAssetFolder: noop,
    onImportAssets: noop,
    onDropIntoFolder: noop,
    onRequestImport: noop,
    showContext: noop,
  }),
)
assert.ok(html.includes('is-agent-locked'), '被锁资产行有锁标记')
assert.ok(html.includes('该资产正被 Agent 使用（锁未释放），暂不能删除'), '删除入口给出原因')
assert.ok(html.includes('disabled'), '被锁资产的删除按钮禁用')
// 只锁 zh_cn：全树只能有一行带锁标记、只应有一处资产删除提示（en_us 同名资产不受影响）
assert.equal((html.match(/is-agent-locked/g) ?? []).length, 1, '只有被锁资产行带锁标记')
assert.equal(
  (html.match(/该资产正被 Agent 使用（锁未释放），暂不能删除；等解锁后再试/g) ?? []).length,
  1,
  '只有被锁资产的删除入口给出原因',
)
// 含被锁资产的目录删除按钮禁用
assert.ok(html.includes('文件夹内有 Agent 正锁定的资产'), '目录删除按钮给出锁原因')

const preview = renderToStaticMarkup(
  createElement(AssetPreview, {
    packageId: 'p1',
    asset: { id: 'a1', path: LANG, mime: 'application/json', size: 10, updatedAt: 0 },
    onSaveText: noop,
    readOnly: true,
  }),
)
assert.ok(preview.includes('只读：Agent 使用中'), '锁期间显示只读说明')
assert.ok(!preview.includes('asset-preview-save'), '锁期间不显示保存入口')

console.log('通过：锁状态驱动资源树按钮（资产删除/目录删除禁用、未锁资产不受影响）+ AssetPreview 只读')
