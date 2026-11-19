/**
 * PR3 平台层验收：多工作区文件桥（`src/project/projectHost.ts`）与通用工程文件桥
 * （`src/project/projectFileBridge.ts`）。
 *
 * 覆盖：
 * 1. 多 bridge 注册表：默认取第一个注册的、按工作区激活、null 回退、注销只移除同一
 *    对象、工程会话变化后 host 重建、scope 跟随当前 bridge。
 * 2. `createProjectFileBridge`：用假 `ProjectClient`（tree.entries / root().resolve /
 *    transactions / texts / text(abs) 计时）注入，断言文本文件过滤、来源/资产分类、
 *    保存文本缓存、staged 优先级、草稿写入绝对路径、资产 staged 草稿、保存通知清空
 *    草稿、人类未保存编辑判断、无工程时的降级行为。
 *
 * 为什么用假 ProjectClient：真实 client 需要打开本地工程目录（Node 下不可用），而
 * 这两个模块只依赖 client 的一小组文件读写方法，用 `setProjectClient` 注入即可覆盖
 * 平台层契约，不需要起服务端。
 */

import assert from 'node:assert/strict'
import type { ProjectFileInfo } from '../src/plugin-sdk/types'
import { registerProjectEditorFlush } from '../src/project/editorFlush'
import { createProjectFileBridge } from '../src/project/projectFileBridge'
import {
  getProjectHost,
  getWorkspaceFileBridge,
  notifyProjectFiles,
  projectScopeOf,
  registerWorkspaceFileBridge,
  setProjectHostWorkspace,
  subscribeProjectHost,
  type WorkspaceFileBridge,
} from '../src/project/projectHost'
import { setProjectSession } from '../src/project/projectSession'
import { setProjectClient } from '../src/project/serviceClient'
import type { ProjectClient } from '../src/project/serviceClient'

let checks = 0
const failures: string[] = []

async function test(name: string, run: () => Promise<void>) {
  try {
    await run()
    checks += 1
    console.log(`通过：${name}`)
  } catch (error) {
    failures.push(name)
    console.error(`失败：${name}`, error)
  }
}

/* ───────────────────────── 假工作区 bridge ───────────────────────── */

/** 最小可用的 WorkspaceFileBridge：只实现平台层会调用的字段，其余用空操作兜底。 */
function makeBridge(
  workspaceId: string,
  overrides: Partial<WorkspaceFileBridge> = {},
): WorkspaceFileBridge {
  return {
    workspaceId,
    listFiles: () => [],
    readCurrentText: () => null,
    readSavedText: async () => null,
    hasDraft: () => false,
    listDraftPaths: () => [],
    writeDraft: () => {},
    discardDraft: () => {},
    stageAssetText: async () => {},
    stagedAssetText: () => undefined,
    getActivePath: () => null,
    getLocale: () => 'zh',
    flushEditors: () => {},
    subscribe: () => () => {},
    onSaved: () => () => {},
    notifySaved: () => {},
    ...overrides,
  }
}

/* ───────────────────────── 假 ProjectClient ───────────────────────── */

type FakeEntry = { kind: 'file' | 'directory'; path: string }
type FakeWrite = { op: 'write'; path: string; data: string }

/** 只用 bridge 真正调用到的那几个方法；整体再 `as unknown as ProjectClient` 注入。 */
class FakeTransactions {
  readonly writes: FakeWrite[] = []
  readonly staged = new Map<string, string>()
  readonly discarded: string[][] = []
  dirty: string[] = []
  readonly listeners = new Set<() => void>()

  stageWrite(edit: FakeWrite): void {
    this.writes.push(edit)
    this.staged.set(edit.path, edit.data)
    this.changed()
  }

  stagedText(absolute: string): string | undefined {
    return this.staged.get(absolute)
  }

  discardDraftPaths(paths: string[]): void {
    this.discarded.push(paths)
    for (const path of paths) this.staged.delete(path)
  }

  editorDirtyPaths(): string[] {
    return this.dirty
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  hasDraft(absolute: string): boolean {
    return this.staged.has(absolute)
  }

  changed(): void {
    for (const listener of this.listeners) listener()
  }
}

/** 工程里的文本都按绝对路径存（与真实 client 的 `texts` 一致）。 */
function makeFakeClient() {
  const texts = new Map<string, string>()
  const transactions = new FakeTransactions()
  const counter = { textCalls: 0 }
  const entries: FakeEntry[] = [
    { kind: 'file', path: 'src/故事/序章.hs' },
    { kind: 'file', path: 'src/配置.json' },
    { kind: 'file', path: 'notes.md' },
    { kind: 'file', path: 'assets/lang_zh/序章.lang' },
    { kind: 'file', path: 'assets/图像.svg' },
    { kind: 'file', path: 'assets/voice/序章.ogg' },
    { kind: 'file', path: 'src/画像.png' },
    { kind: 'file', path: '.hanshu/cache.json' },
    { kind: 'directory', path: 'src' },
    { kind: 'directory', path: 'assets' },
  ]
  texts.set('/proj/src/故事/序章.hs', '第一版正文')
  texts.set('/proj/src/配置.json', '{"a":1}')
  texts.set('/proj/assets/lang_zh/序章.lang', '旧译文')

  const client = {
    tree: { entries },
    // 真实 client 的 root().resolve 把工程相对路径拼成绝对路径；这里固定前缀即可
    root: () => ({ resolve: (path: string) => `/proj/${path.replace(/^\/+/, '')}` }),
    texts,
    transactions,
    text: async (absolute: string): Promise<string | null> => {
      counter.textCalls += 1
      return texts.get(absolute) ?? null
    },
  }
  return { client: client as unknown as ProjectClient, transactions, texts, counter, entries }
}

/** 这些测试共享模块级注册表，收尾必须把已注册的 bridge 与注入的 client 清干净。 */
function cleanupHost() {
  setProjectHostWorkspace(null)
  for (const id of ['gameplay', 'audiovisual', 'missing-workspace']) {
    // 注销函数只认同一个 bridge；直接按 id 覆盖注册一个空 bridge 再注销即可清空
    const placeholder = makeBridge(id)
    const off = registerWorkspaceFileBridge(placeholder, 'cleanup')
    off()
  }
  setProjectSession({})
}

/* ───────────────────── 1. projectHost：多 bridge 注册表 ───────────────────── */

await test('多 bridge：默认取第一个注册的工作区，激活切换后取对应 bridge，null 回退', async () => {
  const gameplay = makeBridge('gameplay', {
    listFiles: () => [{ path: 'src/故事/序章.hs', kind: 'source' }],
  })
  const audiovisual = makeBridge('audiovisual', {
    listFiles: () => [{ path: 'assets/voice/序章.ogg', kind: 'asset' }],
  })
  const offGameplay = registerWorkspaceFileBridge(gameplay, 'scope-gameplay')
  const offAudiovisual = registerWorkspaceFileBridge(audiovisual, 'scope-audiovisual')
  try {
    // 没有激活记录时，插件看到的是「第一个注册的」工作区
    assert.equal(getWorkspaceFileBridge(), gameplay, '未激活时默认用第一个注册的 bridge')
    assert.equal(getProjectHost()?.scope, 'scope-gameplay')
    assert.deepEqual(getProjectHost()?.listFiles(), [
      { path: 'src/故事/序章.hs', kind: 'source' },
    ])

    // 激活视听工作区：同样的插件代码读写落到另一个 bridge
    setProjectHostWorkspace('audiovisual')
    assert.equal(getWorkspaceFileBridge(), audiovisual)
    assert.equal(getProjectHost()?.scope, 'scope-audiovisual')
    assert.equal(projectScopeOf(), 'scope-audiovisual', 'scope 跟随当前 bridge 切换')
    assert.deepEqual(getProjectHost()?.listFiles(), [
      { path: 'assets/voice/序章.ogg', kind: 'asset' },
    ])

    // null 回退到第一个注册的
    setProjectHostWorkspace(null)
    assert.equal(getWorkspaceFileBridge(), gameplay)
    assert.equal(getProjectHost()?.scope, 'scope-gameplay')

    // 激活一个没注册的工作区也要回退，不能返回 null
    setProjectHostWorkspace('missing-workspace')
    assert.equal(getWorkspaceFileBridge(), gameplay, '激活的 id 不存在时回退第一个 bridge')
    assert.equal(getProjectHost()?.scope, 'scope-gameplay')
  } finally {
    offGameplay()
    offAudiovisual()
    setProjectHostWorkspace(null)
  }
})

await test('多 bridge：注销函数只移除它注册的那一个，重复调用安全', async () => {
  const first = makeBridge('gameplay')
  const offFirst = registerWorkspaceFileBridge(first, 'scope-first')
  const second = makeBridge('gameplay')
  const offSecond = registerWorkspaceFileBridge(second, 'scope-second')
  try {
    assert.equal(getWorkspaceFileBridge(), second, '同 id 再注册会替换旧 bridge')
    // 旧 bridge 的清理函数不能把新 bridge 摘掉（隐藏工作区卸载时的经典竞态）
    offFirst()
    assert.equal(getWorkspaceFileBridge(), second, '旧注销函数不得移除新 bridge')
    assert.equal(projectScopeOf(), 'scope-second')
    offFirst()
    assert.equal(getWorkspaceFileBridge(), second, '重复注销是安全空操作')

    // 注销非激活工作区只影响它自己
    const other = makeBridge('audiovisual')
    const offOther = registerWorkspaceFileBridge(other, 'scope-other')
    offOther()
    assert.equal(getWorkspaceFileBridge(), second)
  } finally {
    offSecond()
    offFirst()
  }
})

await test('多 bridge：全部注销后 host 为 null，scope 回退工程会话（无工程时 local）', async () => {
  assert.equal(getWorkspaceFileBridge(), null, '没有注册 bridge 时不该有宿主')
  assert.equal(getProjectHost(), null)
  assert.equal(projectScopeOf(), 'local', '未打开工程时 scope 回退 local')
})

await test('多 bridge：工程会话变化后 host 清空重建，转发字段与可选回调都生效', async () => {
  let readOnlyCalls: readonly string[] | null = null
  let runActiveCalls: boolean | null = null
  const written: Array<[string, string]> = []
  let flushed = 0
  const bridge = makeBridge('gameplay', {
    listFiles: () => [{ path: 'src/故事/序章.hs', kind: 'source' }],
    readSavedText: async () => '保存内容',
    writeDraft: (path, text) => {
      written.push([path, text])
    },
    discardDraft: () => {},
    isHumanDirty: (path) => path === 'src/故事/序章.hs',
    isSaveBusy: () => true,
    getActivePath: () => 'src/故事/序章.hs',
    getLocale: () => 'ja',
    flushEditors: () => {
      flushed += 1
    },
    setReadOnlyPaths: (paths) => {
      readOnlyCalls = paths
    },
    setRunActive: (active) => {
      runActiveCalls = active
    },
  })
  const off = registerWorkspaceFileBridge(bridge, 'scope-session')
  try {
    const before = getProjectHost()
    assert.ok(before, '注册后必须有宿主')
    assert.equal(before.scope, 'scope-session')
    assert.equal(await before.readSavedText('src/故事/序章.hs'), '保存内容')
    before.writeDraft('src/故事/序章.hs', '草稿')
    assert.deepEqual(written, [['src/故事/序章.hs', '草稿']])
    assert.equal(before.isHumanDirty('src/故事/序章.hs'), true, '转发人类未保存编辑判断')
    assert.equal(before.isHumanDirty('src/别的.hs'), false)
    assert.equal(before.isSaveBusy(), true)
    assert.equal(before.getActivePath(), 'src/故事/序章.hs')
    assert.equal(before.getLocale(), 'ja')
    before.flushEditors()
    assert.equal(flushed, 1, 'flushEditors 必须转发到工作区')
    before.setReadOnlyPaths(['src/故事/序章.hs'])
    assert.deepEqual(readOnlyCalls, ['src/故事/序章.hs'])
    before.setRunActive(true)
    assert.equal(runActiveCalls, true)

    // 订阅：工作区内部通知（notifyProjectFiles）会传给插件订阅者
    let fired = 0
    const offSubscribe = before.subscribe(() => {
      fired += 1
    })
    notifyProjectFiles()
    assert.equal(fired, 1)
    offSubscribe()
    notifyProjectFiles()
    assert.equal(fired, 1, '取消订阅后不再收到通知')

    // 工程会话变化（打开/关闭工程、切工作区）必须重建宿主，避免闭包抓住旧 bridge
    setProjectSession({})
    const after = getProjectHost()
    assert.ok(after, '会话变化后仍应能取到宿主')
    assert.notEqual(after, before, '工程会话变化后 host 必须重建')
    assert.equal(after.scope, 'scope-session')
    assert.deepEqual(after.listFiles(), [{ path: 'src/故事/序章.hs', kind: 'source' }])
  } finally {
    off()
    setProjectSession({})
  }
})

await test('多 bridge：可选能力缺失时宿主给出安全默认值', async () => {
  const minimal = makeBridge('gameplay')
  const off = registerWorkspaceFileBridge(minimal, 'scope-minimal')
  try {
    const host = getProjectHost()
    assert.ok(host)
    assert.equal(host.isHumanDirty('src/任意.hs'), false, '没实现 isHumanDirty 时按未编辑处理')
    assert.equal(host.isSaveBusy(), false, '没实现 isSaveBusy 时按空闲处理')
    host.setReadOnlyPaths(['src/任意.hs'])
    host.setRunActive(true)
    assert.equal(host.getActivePath(), null)
    assert.equal(host.listDraftPaths().length, 0)
  } finally {
    off()
  }
})

/* ───────────────────── 2. projectFileBridge：通用文件桥 ───────────────────── */

await test('listFiles：只列文本扩展名，排除 .hanshu/，lang 与 assets/ 归 asset', async () => {
  const fake = makeFakeClient()
  const bridge = createProjectFileBridge({ workspaceId: 'gameplay', getLocale: () => 'zh' })
  try {
    assert.equal(fake.counter.textCalls, 0, '注册时没有工程，不应预热读文件')
    setProjectClient(fake.client)

    const files = bridge.listFiles()
    const paths = files.map((file) => file.path)
    assert.ok(paths.includes('src/故事/序章.hs'))
    assert.ok(paths.includes('src/配置.json'))
    assert.ok(paths.includes('notes.md'))
    assert.ok(paths.includes('assets/lang_zh/序章.lang'))
    assert.ok(paths.includes('assets/图像.svg'))
    assert.ok(!paths.includes('assets/voice/序章.ogg'), '二进制资产不算文本文件')
    assert.ok(!paths.includes('src/画像.png'))
    assert.ok(!paths.includes('.hanshu/cache.json'), '平台缓存不进插件文件列表')

    const kindOf = (path: string) =>
      files.find((file) => file.path === path)?.kind satisfies ProjectFileInfo['kind'] | undefined
    assert.equal(kindOf('src/故事/序章.hs'), 'source')
    assert.equal(kindOf('src/配置.json'), 'source')
    assert.equal(kindOf('assets/lang_zh/序章.lang'), 'asset', '语言文件属于资产')
    assert.equal(kindOf('assets/图像.svg'), 'asset')
  } finally {
    setProjectClient(null)
  }
})

await test('readSavedText：首次读 client 并缓存，第二次不再读；缺失文件返回 null', async () => {
  const fake = makeFakeClient()
  const bridge = createProjectFileBridge({ workspaceId: 'gameplay', getLocale: () => 'zh' })
  try {
    setProjectClient(fake.client)
    assert.equal(await bridge.readSavedText('src/故事/序章.hs'), '第一版正文')
    assert.equal(fake.counter.textCalls, 1, '第一次读取要落到工程文本')
    assert.equal(await bridge.readSavedText('src/故事/序章.hs'), '第一版正文')
    assert.equal(fake.counter.textCalls, 1, '保存文本缓存后第二次不能重复读盘')
    assert.equal(await bridge.readSavedText('src/缺失.hs'), null)
    assert.equal(fake.counter.textCalls, 2, '缺失文件仍是一次尝试，但不能抛错')
  } finally {
    setProjectClient(null)
  }
})

await test('readCurrentText：staged 草稿优先，其次保存缓存，最后工程内存文本', async () => {
  const fake = makeFakeClient()
  const bridge = createProjectFileBridge({ workspaceId: 'gameplay', getLocale: () => 'zh' })
  try {
    setProjectClient(fake.client)
    fake.texts.set('/proj/src/配置.json', '{"a":2}')
    // 没缓存、没草稿：直接取工程内存文本
    assert.equal(bridge.readCurrentText('src/配置.json'), '{"a":2}')
    // 先读保存文本填充缓存，再验证 staged 优先于缓存
    assert.equal(await bridge.readSavedText('src/故事/序章.hs'), '第一版正文')
    fake.transactions.staged.set('/proj/src/故事/序章.hs', '未保存草稿')
    assert.equal(bridge.readCurrentText('src/故事/序章.hs'), '未保存草稿', '草稿必须优先于保存内容')
    fake.transactions.staged.delete('/proj/src/故事/序章.hs')
    assert.equal(bridge.readCurrentText('src/故事/序章.hs'), '第一版正文', '没有草稿时回落到缓存')
  } finally {
    setProjectClient(null)
  }
})

await test('writeDraft / discardDraft：写入绝对路径、缓存失效、草稿列表可回滚', async () => {
  const fake = makeFakeClient()
  const bridge = createProjectFileBridge({ workspaceId: 'gameplay', getLocale: () => 'zh' })
  try {
    setProjectClient(fake.client)
    assert.equal(await bridge.readSavedText('src/故事/序章.hs'), '第一版正文')
    assert.equal(fake.counter.textCalls, 1)

    bridge.writeDraft('src/新场景.hs', '新正文')
    assert.equal(fake.transactions.writes.length, 1)
    assert.equal(fake.transactions.writes[0]?.path, '/proj/src/新场景.hs', '必须写绝对路径')
    assert.equal(fake.transactions.writes[0]?.data, '新正文')
    assert.equal(bridge.hasDraft('src/新场景.hs'), true)
    assert.deepEqual(bridge.listDraftPaths(), ['src/新场景.hs'])
    assert.ok(
      bridge.listFiles().some((file) => file.path === 'src/新场景.hs'),
      '草稿新建的文件也要出现在文件列表里（Agent 才能继续编辑它）',
    )
    assert.equal(bridge.readCurrentText('src/新场景.hs'), '新正文', '刚写的草稿立刻可读')

    // 写草稿后同一路径的保存缓存必须失效，否则 Agent 会拿旧文本当基线
    await bridge.readSavedText('src/故事/序章.hs')
    bridge.writeDraft('src/故事/序章.hs', '第二版草稿')
    const before = fake.counter.textCalls
    await bridge.readSavedText('src/故事/序章.hs')
    assert.equal(fake.counter.textCalls, before + 1, '写草稿要清掉该路径的保存缓存')

    bridge.discardDraft('src/新场景.hs')
    assert.equal(bridge.hasDraft('src/新场景.hs'), false)
    assert.deepEqual(bridge.listDraftPaths(), ['src/故事/序章.hs'])
    assert.deepEqual(fake.transactions.discarded[0], ['/proj/src/新场景.hs'])
    assert.ok(
      !bridge.listFiles().some((file) => file.path === 'src/新场景.hs'),
      '撤销草稿后新建的文件要从列表消失',
    )
  } finally {
    setProjectClient(null)
  }
})

await test('stageAssetText / stagedAssetText / discardAssetText：语言草稿独立于文档草稿', async () => {
  const fake = makeFakeClient()
  const bridge = createProjectFileBridge({ workspaceId: 'gameplay', getLocale: () => 'zh' })
  try {
    setProjectClient(fake.client)
    await bridge.stageAssetText('assets/lang_zh/序章.lang', '新译文')
    assert.equal(fake.transactions.writes.at(-1)?.path, '/proj/assets/lang_zh/序章.lang')
    assert.equal(bridge.stagedAssetText('assets/lang_zh/序章.lang'), '新译文')
    assert.equal(bridge.hasDraft('assets/lang_zh/序章.lang'), true)
    assert.deepEqual(bridge.listDraftPaths(), [], '资产 staged 草稿不算文档草稿')

    // 内存里没记时回落到 client 的 staged 文本（例如别处已经 stage 过）
    fake.transactions.staged.set('/proj/assets/lang_ja/序章.lang', '外部草稿')
    assert.equal(bridge.stagedAssetText('assets/lang_ja/序章.lang'), '外部草稿')
    assert.equal(bridge.stagedAssetText('assets/lang_fr/缺失.lang'), undefined)

    bridge.discardAssetText('assets/lang_zh/序章.lang')
    assert.equal(bridge.hasDraft('assets/lang_zh/序章.lang'), false)
    assert.equal(bridge.stagedAssetText('assets/lang_zh/序章.lang'), undefined)
    assert.deepEqual(fake.transactions.discarded.at(-1), ['/proj/assets/lang_zh/序章.lang'])
  } finally {
    setProjectClient(null)
  }
})

await test('notifySaved：按路径清草稿并回调，省略参数时清全部；订阅者收到通知', async () => {
  const fake = makeFakeClient()
  const bridge = createProjectFileBridge({ workspaceId: 'gameplay', getLocale: () => 'zh' })
  const savedCalls: Array<string[]> = []
  const offSaved = bridge.onSaved((paths) => {
    savedCalls.push(paths)
  })
  let emitted = 0
  const offListen = bridge.subscribe(() => {
    emitted += 1
  })
  try {
    setProjectClient(fake.client)
    bridge.writeDraft('src/甲.hs', '甲')
    bridge.writeDraft('src/乙.hs', '乙')
    bridge.stageAssetText('assets/lang_zh/序章.lang', '译文')

    bridge.notifySaved(['src/甲.hs'])
    assert.deepEqual(savedCalls[0], ['src/甲.hs'], 'onSaved 必须带上用户保存的路径')
    assert.equal(bridge.hasDraft('src/甲.hs'), false, '已保存的草稿要清掉')
    assert.equal(bridge.hasDraft('assets/lang_zh/序章.lang'), true, '没保存的资产草稿保留')
    assert.deepEqual(bridge.listDraftPaths(), ['src/乙.hs'])
    assert.ok(emitted > 0, '保存后要通知订阅者（界面刷新草稿标记）')

    const emittedBefore = emitted
    bridge.notifySaved()
    assert.deepEqual(savedCalls[1], ['src/乙.hs'], '省略参数时回调收到的就是当前全部草稿')
    assert.deepEqual(bridge.listDraftPaths(), [])
    assert.equal(bridge.hasDraft('src/乙.hs'), false)
    assert.ok(emitted > emittedBefore)

    offSaved()
    offListen()
    bridge.writeDraft('src/丙.hs', '丙')
    bridge.notifySaved()
    assert.equal(savedCalls.length, 2, '取消订阅后不再回调')
  } finally {
    offSaved()
    offListen()
    setProjectClient(null)
  }
})

await test('isHumanDirty / subscribe：用编辑器脏路径判断，订阅转发到 transactions', async () => {
  const fake = makeFakeClient()
  const bridge = createProjectFileBridge({ workspaceId: 'gameplay', getLocale: () => 'zh' })
  try {
    setProjectClient(fake.client)
    fake.transactions.dirty = ['/proj/src/故事/序章.hs']
    assert.equal(bridge.isHumanDirty('src/故事/序章.hs'), true)
    assert.equal(bridge.isHumanDirty('src/配置.json'), false)
    fake.transactions.dirty = []
    assert.equal(bridge.isHumanDirty('src/故事/序章.hs'), false)

    let fired = 0
    const off = bridge.subscribe(() => {
      fired += 1
    })
    fake.transactions.changed()
    assert.equal(fired, 1, '工程事务变化要传给插件订阅者')
    off()
    fake.transactions.changed()
    assert.equal(fired, 1, '取消订阅后不再收到事务通知')
  } finally {
    setProjectClient(null)
  }
})

await test('无工程（client 为 null）：列表空、读取 null、写入明确报错', async () => {
  const bridge = createProjectFileBridge({ workspaceId: 'gameplay', getLocale: () => 'zh' })
  try {
    setProjectClient(null)
    assert.deepEqual(bridge.listFiles(), [])
    assert.equal(bridge.readCurrentText('src/故事/序章.hs'), null)
    assert.equal(await bridge.readSavedText('src/故事/序章.hs'), null)
    assert.equal(bridge.hasDraft('src/故事/序章.hs'), false)
    assert.deepEqual(bridge.listDraftPaths(), [])
    assert.equal(bridge.stagedAssetText('assets/lang_zh/序章.lang'), undefined)
    assert.equal(bridge.isHumanDirty('src/故事/序章.hs'), false)
    assert.throws(
      () => bridge.writeDraft('src/故事/序章.hs', 'x'),
      /尚未打开工程/,
      '没有工程时写草稿必须抛错（Agent 据此提示用户先打开工程）',
    )
    await assert.rejects(
      bridge.stageAssetText('assets/lang_zh/序章.lang', 'x'),
      /尚未打开工程/,
      '没有工程时写资产草稿也要明确报错',
    )
  } finally {
    setProjectClient(null)
  }
})

await test('deps 转发：语言标签 / 当前文档 / 保存忙碌 / 只读与运行态 / flush', async () => {
  const calls: { readOnly: Array<readonly string[]>; runActive: boolean[] } = {
    readOnly: [],
    runActive: [],
  }
  let flushed = 0
  const offFlush = registerProjectEditorFlush(() => {
    flushed += 1
  })
  const bridge = createProjectFileBridge({
    workspaceId: 'audiovisual',
    getLocale: () => 'ja',
    getActivePath: () => 'assets/voice/序章.ogg',
    isSaveBusy: () => true,
    setReadOnlyPaths: (paths) => {
      calls.readOnly.push(paths)
    },
    setRunActive: (active) => {
      calls.runActive.push(active)
    },
  })
  try {
    assert.equal(bridge.workspaceId, 'audiovisual')
    assert.equal(bridge.getLocale(), 'ja')
    assert.equal(bridge.getActivePath(), 'assets/voice/序章.ogg')
    assert.equal(bridge.isSaveBusy?.(), true)
    bridge.setReadOnlyPaths?.(['assets/voice/序章.ogg'])
    assert.deepEqual(calls.readOnly, [['assets/voice/序章.ogg']])
    bridge.setRunActive?.(true)
    assert.deepEqual(calls.runActive, [true])
    bridge.flushEditors()
    assert.equal(flushed, 1, 'flushEditors 必须冲刷所有注册的编辑器缓冲')
    // 没有注入时给出中立默认值（平台层不允许因为工作区少实现一个可选回调而崩）
    const minimal = createProjectFileBridge({ workspaceId: 'gameplay', getLocale: () => 'zh' })
    assert.equal(minimal.getActivePath(), null)
    assert.equal(minimal.isSaveBusy?.(), undefined)
  } finally {
    offFlush()
    setProjectClient(null)
  }
})

/* ───────────────────────── 宿主变化订阅 ───────────────────────── */

await test('subscribeProjectHost：首次订阅立即回调；注册/激活切换/注销触发，文件内容变化不触发', async () => {
  cleanupHost()
  const events: string[] = []
  const off = subscribeProjectHost(() => events.push('host'))
  assert.equal(events.length, 1, '订阅时立即回调一次，用于启动早期同步运行时')
  try {
    const gameplay = makeBridge('gameplay')
    const offBridge = registerWorkspaceFileBridge(gameplay, 'scope-a')
    assert.equal(events.length, 2, '工作区注册 bridge = 宿主可用')
    setProjectHostWorkspace('gameplay')
    assert.equal(events.length, 3, '切换激活工作区 = 宿主变化')
    notifyProjectFiles()
    assert.equal(events.length, 3, '文件内容变化不应该触发宿主重建')
    setProjectHostWorkspace(null)
    assert.equal(events.length, 4)
    offBridge()
    assert.equal(events.length, 5, '注销 bridge 后宿主失效')
  } finally {
    off()
    cleanupHost()
  }
})

/* ───────────────────────── 收尾 ───────────────────────── */

try {
  cleanupHost()
} catch (error) {
  console.error('清理测试现场失败', error)
}

if (failures.length > 0) {
  console.error(`失败项：${failures.join('、')}`)
  process.exitCode = 1
} else {
  console.log(`通过 ${checks} 项，失败 0 项。`)
}
