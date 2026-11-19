/**
 * 插件 SDK / 装配点（纯逻辑）验收。
 *
 * 跑法：`node scripts/run-verification.mjs scripts/verify-plugin-sdk.ts`
 *
 * 只测 `src/plugin-sdk` 的注册表与 `src/app/pluginLoader` 的委托，不渲染 React：
 * 贡献点过滤、排序、重复命令、激活失败回滚、dispose 清空。
 */

import assert from 'node:assert/strict'
import { PluginRegistry } from '../src/plugin-sdk'
import type { Plugin, ProjectHost, UiServices } from '../src/plugin-sdk'
import { PluginLoader } from '../src/app/pluginLoader'

const host = {} as ProjectHost
const ui = {} as UiServices

/* ── 面板按工作区过滤并排序，贡献点不把 pluginId 泄漏给调用方 ── */
{
  const registry = new PluginRegistry()
  const plugin: Plugin = {
    id: 'demo',
    name: 'Demo',
    activate(ctx) {
      ctx.registerPanel({ id: 'second', title: 'Second', component: () => null, workspaces: ['stageplay'], order: 2 })
      ctx.registerPanel({ id: 'first', title: 'First', component: () => null, workspaces: ['stageplay', 'gameplay'], order: 1 })
      ctx.registerPanel({ id: 'everywhere', title: 'Everywhere', component: () => null })
      ctx.registerMenu({ id: 'menu', menu: 'view', label: 'Menu', command: 'demo.menu' })
      ctx.registerStatusbarItem({ id: 'status', label: 'Status', command: 'demo.menu', order: 3 })
      ctx.registerHelp({ id: 'help', title: 'Help', body: '# help' })
      ctx.registerCommand({ id: 'demo.menu', title: 'Menu', run: () => undefined })
    },
  }
  await registry.activate(plugin, host, ui)
  assert.deepEqual(registry.activeIds, ['demo'])
  // order 缺省为 0，所以默认面板排在最前；同 order 保持注册顺序。
  assert.deepEqual(
    registry.panelsFor('stageplay').map((panel) => panel.id),
    ['everywhere', 'first', 'second'],
  )
  assert.deepEqual(
    registry.panelsFor('gameplay').map((panel) => panel.id),
    ['everywhere', 'first'],
  )
  assert.equal(registry.panelsFor('stageplay')[0].pluginId, undefined, '贡献点不应泄漏 pluginId')
  assert.equal(registry.menusFor('view').length, 1)
  assert.equal(registry.statusbarItems().length, 1)
  assert.equal(registry.helpTopics().length, 1)
  assert.equal(registry.command('demo.menu')?.title, 'Menu')
  assert.equal(registry.command('missing'), null)
}

/* ── 同一插件不能重复激活，重复命令拒绝且不留下半激活状态 ── */
{
  const registry = new PluginRegistry()
  const plugin: Plugin = {
    id: 'dup',
    name: 'Dup',
    activate(ctx) {
      ctx.registerCommand({ id: 'same', title: 'Same', run: () => undefined })
      ctx.registerCommand({ id: 'same', title: 'Same again', run: () => undefined })
    },
  }
  await assert.rejects(() => registry.activate(plugin, host, ui), /duplicate command: same/)
  assert.deepEqual(registry.activeIds, [], '激活失败后插件不能留在注册表')
  assert.equal(registry.command('same'), null, '半激活的贡献点应一并回滚')
}

/* ── 激活抛错也要回滚，且 dispose 清空 ── */
{
  const loader = new PluginLoader()
  const broken: Plugin = {
    id: 'broken',
    name: 'Broken',
    activate() {
      throw new Error('boom')
    },
  }
  await assert.rejects(() => loader.activate(broken, host, ui), /boom/)
  assert.deepEqual(loader.activePluginIds, [])

  const ok: Plugin = {
    id: 'ok',
    name: 'Ok',
    activate(ctx) {
      ctx.registerPanel({ id: 'panel', title: 'Panel', component: () => null })
    },
  }
  await loader.activate(ok, host, ui)
  assert.deepEqual(loader.activePluginIds, ['ok'])
  assert.equal(loader.panelsFor('stageplay').length, 1)
  await loader.dispose()
  assert.deepEqual(loader.activePluginIds, [])
  assert.equal(loader.panelsFor('stageplay').length, 0)
  await assert.rejects(() => loader.activate(ok, host, ui), /disposed/)
}

/* ── 命令运行回调直达插件，不经过主体分支 ── */
{
  const calls: string[] = []
  const registry = new PluginRegistry()
  await registry.activate(
    {
      id: 'commands',
      name: 'Commands',
      activate(ctx) {
        ctx.registerCommand({ id: 'open', title: 'Open', run: () => calls.push('open') })
      },
    },
    host,
    ui,
  )
  await registry.command('open')?.run()
  assert.deepEqual(calls, ['open'])
}

console.log('verify-plugin-sdk: ok')
