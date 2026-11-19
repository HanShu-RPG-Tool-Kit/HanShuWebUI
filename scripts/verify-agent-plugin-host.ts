/**
 * Agent 插件宿主（ProjectHost → AgentHost）验收脚本。
 *
 * 用一个纯内存的假 `WorkspaceFileBridge`（注册到真实 `projectHost` 单例）验证：
 * - 源文件存在性 / 路径以 `ProjectHost.listFiles` 为准，package 元数据来自工程会话；
 * - 读写源码一律经 `readCurrentText` / `writeDraft`（编辑器缓冲 + 本地草稿同一世界）；
 * - 语言资产走 `stagedAssetText` / `stageAssetText`，草稿优先于已保存版本；
 * - parse_hs / unparse_hs / write_lang / delete_lang_keys 的组合行为；
 * - `writeLangDraft(null)` 走 `discardAssetText`，`isHumanDirty` 直接转发宿主；
 * - 不依赖 DOM / IndexedDB，Node 下可直接跑。
 *
 * 跑法：node scripts/run-verification.mjs scripts/verify-agent-plugin-host.ts
 */
import assert from 'node:assert/strict'
import { createAgentHost } from '../src/plugins/agent/host/agentHost'
import {
  registerWorkspaceFileBridge,
  type WorkspaceFileBridge,
} from '../src/project/projectHost'
import { setProjectSession } from '../src/project/projectSession'
import { emptyWorkspace, type Workspace } from '../src/workspace'
import { collectSourceKeys } from '../src/plugins/agent/core/agentOps'
import { stringifyTextFile } from '../src/i18n/textMap'
import type { ProjectFileInfo } from '../src/plugin-sdk/types'

const SOURCE = 'chapter.hs'
const LANG = 'assets/zh_cn/lang_hs/chapter.lang'
const LOCALE = 'zh_cn'

/** 假的工作区文件通道：只实现插件宿主真正会用到的那部分语义 */
class FakeBridge implements WorkspaceFileBridge {
  readonly workspaceId = 'test-workspace'
  files: ProjectFileInfo[] = []
  current = new Map<string, string>()
  saved = new Map<string, string>()
  drafts = new Set<string>()
  staged = new Map<string, string>()
  dirty = new Set<string>()
  discarded: string[] = []
  stageCalls: string[] = []
  flushes = 0
  active: string | null = null
  /** 界面语言：宿主应当每次现取，而不是创建时快照 */
  locale = 'zh_cn'
  private listeners = new Set<() => void>()
  private savedListeners = new Set<(paths: string[]) => void>()

  getLocale(): string {
    return this.locale
  }

  listFiles(): ProjectFileInfo[] {
    return this.files
  }
  readCurrentText(path: string): string | null {
    return this.current.get(path) ?? null
  }
  async readSavedText(path: string): Promise<string | null> {
    return this.saved.get(path) ?? null
  }
  hasDraft(path: string): boolean {
    return this.drafts.has(path)
  }
  listDraftPaths(): string[] {
    return [...this.drafts]
  }
  writeDraft(path: string, text: string): void {
    this.current.set(path, text)
    this.drafts.add(path)
    this.emit()
  }
  discardDraft(path: string): void {
    this.drafts.delete(path)
    this.current.delete(path)
    this.emit()
  }
  async stageAssetText(path: string, text: string): Promise<void> {
    this.staged.set(path, text)
    this.stageCalls.push(path)
    this.emit()
  }
  stagedAssetText(path: string): string | undefined {
    return this.staged.get(path)
  }
  discardAssetText(path: string): void {
    this.staged.delete(path)
    this.discarded.push(path)
  }
  isHumanDirty(path: string): boolean {
    return this.dirty.has(path)
  }
  getActivePath(): string | null {
    return this.active
  }
  flushEditors(): void {
    this.flushes += 1
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  onSaved(listener: (paths: string[]) => void): () => void {
    this.savedListeners.add(listener)
    return () => {
      this.savedListeners.delete(listener)
    }
  }
  notifySaved(paths?: string[]): void {
    for (const listener of this.savedListeners) listener(paths ?? [])
  }
  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

const makeWorkspace = (sourceContent: string): Workspace => ({
  packages: [
    {
      id: 'pkg1',
      name: 'main',
      collapsed: false,
      assetsCollapsed: false,
      scripts: [
        {
          id: 'script1',
          name: SOURCE,
          content: sourceContent,
          updatedAt: 1700000000000,
        },
      ],
      assets: [
        {
          id: 'asset1',
          path: LANG,
          mime: 'text/plain',
          size: 0,
          updatedAt: 1700000000000,
        },
      ],
      assetFolders: [],
    },
  ],
  activeScriptId: 'script1',
  activeAssetId: null,
} as unknown as Workspace)

type World = {
  bridge: FakeBridge
  host: ReturnType<typeof createAgentHost>
  workspace: Workspace
  dispose: () => void
}

const setup = (options?: { sourceContent?: string; files?: ProjectFileInfo[] }): World => {
  const sourceContent = options?.sourceContent ?? 'Alice:Hello//\n'
  const workspace = makeWorkspace(sourceContent)
  const bridge = new FakeBridge()
  bridge.files = options?.files ?? [
    { path: SOURCE, kind: 'source' },
    { path: 'nested/extra.hs', kind: 'source' },
    { path: LANG, kind: 'asset' },
  ]
  bridge.current.set(SOURCE, sourceContent)
  bridge.saved.set(SOURCE, sourceContent)
  const dispose = registerWorkspaceFileBridge(bridge, 'test-workspace')
  setProjectSession({ workspace, binding: null })
  const host = createAgentHost({ locale: LOCALE })
  return {
    bridge,
    host,
    workspace,
    dispose: () => {
      dispose()
      setProjectSession({ workspace: emptyWorkspace(), binding: null })
    },
  }
}

const tests: Array<[string, () => Promise<void> | void]> = []

tests.push([
  'list_sources：存在性以 ProjectHost.listFiles 为准，package 元数据来自工程会话',
  () => {
    const world = setup()
    try {
      const result = world.host.listSources() as {
        ok: true
        count: number
        files: Array<{ package: string; source: string; kind: string; bytes: number }>
      }
      assert.equal(result.ok, true)
      assert.equal(result.count, 2)
      assert.deepEqual(
        result.files.map((file) => file.source).sort(),
        ['chapter.hs', 'nested/extra.hs'],
      )
      const chapter = result.files.find((file) => file.source === SOURCE)!
      assert.equal(chapter.package, 'main')
      assert.equal(chapter.kind, 'hanshu')
      assert.equal(chapter.bytes, 'Alice:Hello//\n'.length)
      const hostOnly = result.files.find((file) => file.source === 'nested/extra.hs')!
      assert.equal(hostOnly.package, '')
      // package 过滤只透出工程内已知文件
      const filtered = world.host.listSources('main') as { count: number }
      assert.equal(filtered.count, 1)
    } finally {
      world.dispose()
    }
  },
])

tests.push([
  'read_source：正文来自 readCurrentText，分页与越界错误与旧宿主一致',
  () => {
    const world = setup({ sourceContent: 'line1\nline2\nline3\n' })
    try {
      world.bridge.current.set(SOURCE, 'line1\nline2\nline3\n')
      const page = world.host.readSource(SOURCE, 2, 1) as {
        ok: true
        content: string
        totalLines: number
        offset: number
      }
      assert.equal(page.ok, true)
      assert.equal(page.content, 'line2')
      assert.equal(page.totalLines, 4)
      assert.equal(page.offset, 2)
      const bad = world.host.readSource(SOURCE, 99, 1) as { ok: false; reason: string }
      assert.equal(bad.ok, false)
      assert.equal(bad.reason, 'invalid_arguments')
      const missing = world.host.readSource('nope.hs') as { ok: false; reason: string }
      assert.equal(missing.reason, 'not_found')
    } finally {
      world.dispose()
    }
  },
])

tests.push([
  'read_full_source / write_source / edit_source：写走 writeDraft 且 changed 准确',
  () => {
    const world = setup()
    try {
      const full = world.host.readFullSource!(SOURCE) as { ok: true; content: string }
      assert.equal(full.content, 'Alice:Hello//\n')

      const written = world.host.writeSource(SOURCE, 'Alice:Hello//\nBob:Bye//\n') as {
        ok: true
        changed: boolean
        created: boolean
        source: string
      }
      assert.equal(written.ok, true)
      assert.equal(written.created, false)
      assert.equal(written.changed, true)
      assert.equal(world.bridge.current.get(SOURCE), 'Alice:Hello//\nBob:Bye//\n')
      assert.equal(world.bridge.drafts.has(SOURCE), true)

      const same = world.host.writeSource(SOURCE, 'Alice:Hello//\nBob:Bye//\n') as {
        ok: true
        changed: boolean
      }
      assert.equal(same.changed, false)

      const edited = world.host.editSource(SOURCE, 'Bye', 'Ciao') as {
        ok: true
        replaced: number
        changed: boolean
      }
      assert.equal(edited.replaced, 1)
      assert.equal(edited.changed, true)
      assert.match(world.bridge.current.get(SOURCE) ?? '', /Ciao/)
    } finally {
      world.dispose()
    }
  },
])

tests.push([
  'create_source：新文件写草稿；重名 already_exists；非法名 invalid_arguments',
  () => {
    const world = setup()
    try {
      const created = world.host.createSource('new.hs', 'Alice:Hi//\n') as {
        ok: true
        source: string
        created: boolean
      }
      assert.equal(created.ok, true)
      assert.equal(created.source, 'new.hs')
      assert.equal(created.created, true)
      assert.equal(world.bridge.current.get('new.hs'), 'Alice:Hi//\n')

      const duplicate = world.host.createSource(SOURCE, 'x') as { ok: false; reason: string }
      assert.equal(duplicate.reason, 'already_exists')

      const invalid = world.host.createSource('../escape.hs', 'x') as {
        ok: false
        reason: string
      }
      assert.equal(invalid.reason, 'invalid_arguments')

      const voice = world.host.createSource('a.voice', 'x') as { ok: false; error: string }
      assert.match(voice.error, /voice mapping/)
    } finally {
      world.dispose()
    }
  },
])

tests.push([
  'get_active_path / validate_source_name / is_human_dirty 转发宿主',
  () => {
    const world = setup()
    try {
      world.bridge.active = 'nested/extra.hs'
      const active = world.host.getActiveFilePath() as {
        ok: true
        source: string
        kind: string
        path: string
      }
      assert.equal(active.ok, true)
      assert.equal(active.source, 'extra.hs')
      assert.equal(active.kind, 'hanshu')
      assert.equal(active.path, 'nested/extra.hs')

      assert.deepEqual(world.host.validateSourceName!('ok.hs'), { ok: true, name: 'ok.hs' })
      assert.equal(world.host.validateSourceName!('../bad.hs').ok, false)

      assert.equal(world.host.isHumanDirty!(SOURCE), false)
      world.bridge.dirty.add(SOURCE)
      assert.equal(world.host.isHumanDirty!(SOURCE), true)
    } finally {
      world.dispose()
    }
  },
])

tests.push([
  'list_lang_keys：staged 草稿优先，键来自源文本哈希',
  async () => {
    const world = setup()
    try {
      // 先成键：collectSourceKeys 只认正文里已经出现的键，未成键文本不算
      await world.host.parseHs(SOURCE, LOCALE)
      const content = world.bridge.current.get(SOURCE) ?? ''
      const keys = collectSourceKeys(content, SOURCE)
      assert.equal(keys.length, 1)
      const result = (await world.host.listLangKeys(SOURCE, LOCALE)) as {
        ok: true
        locale: string
        path: string
        total: number
        missing: number
        entries: Array<{ key: string; text: string | null; translated: boolean }>
      }
      assert.equal(result.ok, true)
      assert.equal(result.locale, LOCALE)
      assert.equal(result.path, LANG)
      assert.equal(result.total, 1)
      assert.equal(result.missing, 0)
      assert.equal(result.entries[0].key, keys[0].key)
      assert.equal(result.entries[0].text, 'Hello')
      assert.equal(result.entries[0].translated, true)
      // 界面语言不是创建时快照：切换后 active 随宿主现取的语言变化
      world.bridge.locale = 'en_us'
      const switched = (await world.host.listLangKeys(SOURCE, LOCALE)) as {
        ok: true
        active: boolean
      }
      assert.equal(switched.active, false)
      world.bridge.locale = LOCALE
    } finally {
      world.dispose()
    }
  },
])

tests.push([
  'write_lang：只写资产 staged 草稿，返回 draft/saved/version 口径',
  async () => {
    const world = setup()
    try {
      await world.host.parseHs(SOURCE, LOCALE)
      const keys = collectSourceKeys(world.bridge.current.get(SOURCE) ?? '', SOURCE)
      world.bridge.stageCalls.length = 0
      const result = (await world.host.writeLang(SOURCE, {
        [LOCALE]: [{ key: keys[0].key, text: '你好' }],
      })) as { ok: true; draft: boolean; saved: boolean; version: null; writtenPaths: string[] }
      assert.equal(result.ok, true)
      assert.equal(result.draft, true)
      assert.equal(result.saved, false)
      assert.equal(result.version, null)
      assert.deepEqual(result.writtenPaths, [LANG])
      assert.deepEqual(world.bridge.stageCalls, [LANG])
      assert.match(world.bridge.staged.get(LANG) ?? '', /你好/)
    } finally {
      world.dispose()
    }
  },
])

tests.push([
  'parse_hs → unparse_hs：源文件与语言草稿在同一轮里往返',
  async () => {
    const world = setup({ sourceContent: 'Alice:Hello//\n' })
    try {
      const parsed = (await world.host.parseHs(SOURCE, LOCALE)) as {
        ok: true
        created: number
        replaced: number
        writtenPaths: string[]
      }
      assert.equal(parsed.ok, true)
      assert.equal(parsed.created, 1)
      assert.equal(parsed.replaced, 1)
      assert.deepEqual(parsed.writtenPaths, [LANG])
      assert.match(world.bridge.current.get(SOURCE) ?? '', /^Alice:[0-9a-f]{8}\/\//)
      assert.match(world.bridge.staged.get(LANG) ?? '', /Hello/)

      const unparsed = (await world.host.unparseHs(SOURCE, LOCALE)) as {
        ok: true
        replaced: number
      }
      assert.equal(unparsed.ok, true)
      assert.equal(unparsed.replaced, 1)
      assert.equal(world.bridge.current.get(SOURCE), 'Alice:Hello//\n')
    } finally {
      world.dispose()
    }
  },
])

tests.push([
  'delete_lang_keys：force 删键；语言草稿走 stageAssetText',
  async () => {
    const world = setup()
    try {
      await world.host.parseHs(SOURCE, LOCALE)
      const keys = collectSourceKeys(world.bridge.current.get(SOURCE) ?? '', SOURCE)
      const blocked = (await world.host.deleteLangKeys(SOURCE, [keys[0].key], LOCALE)) as {
        ok: false
        reason: string
      }
      assert.equal(blocked.reason, 'keys_in_use')
      const removed = (await world.host.deleteLangKeys(SOURCE, [keys[0].key], LOCALE, true)) as {
        ok: true
        removed: string[]
      }
      assert.equal(removed.ok, true)
      assert.deepEqual(removed.removed, [keys[0].key])
    } finally {
      world.dispose()
    }
  },
])

tests.push([
  'write_lang_draft：null 走 discardAssetText，非空走 stageAssetText',
  async () => {
    const world = setup()
    try {
      await world.host.writeLangDraft!(LANG, stringifyTextFile({}))
      assert.deepEqual(world.bridge.stageCalls, [LANG])
      await world.host.writeLangDraft!(LANG, null)
      assert.deepEqual(world.bridge.discarded, [LANG])
      assert.equal(world.bridge.staged.has(LANG), false)
    } finally {
      world.dispose()
    }
  },
])

tests.push([
  'read_asset_text：staged 优先于 saved 文本',
  async () => {
    const world = setup()
    try {
      world.bridge.saved.set(LANG, 'saved text')
      assert.equal(await world.host.readAssetText!(LANG), 'saved text')
      world.bridge.staged.set(LANG, 'staged text')
      assert.equal(await world.host.readAssetText!(LANG), 'staged text')
    } finally {
      world.dispose()
    }
  },
])

tests.push([
  'validate_source：诊断来自源草稿正文；foreignInjects 由工程文件索引',
  () => {
    const world = setup({ sourceContent: 'Alice:Hello//\n' })
    try {
      const result = world.host.validateSource(SOURCE) as {
        ok: boolean
        source: string
        diagnostics: unknown[]
        agentLint: Array<{ kind: string }>
      }
      assert.equal(result.source, SOURCE)
      assert.equal(result.ok, true)
      assert.equal(result.diagnostics.length, 0)
      // 未成键正文会产生一条 agent-lint 摘要提示，它不属于编辑器诊断
      assert.ok(result.agentLint.every(item => item.kind === 'agent-lint'))
    } finally {
      world.dispose()
    }
  },
])

tests.push([
  'discard_draft_source：撤掉写草稿文件',
  () => {
    const world = setup()
    try {
      world.host.writeSource(SOURCE, 'Alice:Changed//\n')
      assert.equal(world.bridge.drafts.has(SOURCE), true)
      world.host.discardDraftSource!(SOURCE)
      assert.equal(world.bridge.drafts.has(SOURCE), false)
    } finally {
      world.dispose()
    }
  },
])

tests.push([
  'check_export：预检前先 flush 编辑器',
  async () => {
    const world = setup()
    try {
      const result = (await world.host.checkExport()) as { ok: boolean }
      assert.equal(world.bridge.flushes, 1)
      assert.equal(typeof result.ok, 'boolean')
    } finally {
      world.dispose()
    }
  },
])

let passed = 0
let failed = 0
for (const [name, run] of tests) {
  try {
    await run()
    passed += 1
    console.log(`ok - ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL - ${name}`)
    console.error(error)
  }
}

console.log(`\n通过 ${passed} 项，失败 ${failed} 项。`)
if (failed > 0) process.exit(1)
