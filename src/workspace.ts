import { isTextAssetName } from './i18n/textMap'

const WORKSPACE_KEY = 'hanshu.workspace.v2'
const LEGACY_DRAFT_KEY = 'hanshu.draft.v1'

/** 包内允许的后缀 */
export const ALLOWED_EXTENSIONS = [
  '.hs',
  '.md',
  '.char',
  '.py',
  '.lang',
  '.voice',
] as const
export type AllowedExtension = (typeof ALLOWED_EXTENSIONS)[number]

/**
 * 源文件按后缀归入的工作目录（工程结构 `src/<kind>/`）：
 * `.hs` → `src/hanshu/`、`.char` → `src/character/`、`.py` → `src/scripts/`。
 * 未列出的后缀（`.md` 文档、旧 `*.voice` 映射）不参与该结构，留在包根。
 */
export const SOURCE_KIND_DIRS: Record<string, string> = {
  '.hs': 'hanshu',
  '.char': 'character',
  '.py': 'scripts',
}

/** `src/<kind>/` 的固定顺序：展示与导出都按它排 */
export const SOURCE_KIND_ORDER = ['hanshu', 'character', 'scripts'] as const

/** 源文件在工程结构里的相对路径：`xx.hs` → `src/hanshu/xx.hs`；非源文件原样返回 */
export function sourceRelativePath(name: string): string {
  const kind = SOURCE_KIND_DIRS[getExtension(name)]
  return kind ? `src/${kind}/${name}` : name
}

/** 给人看的后缀列表文案 */
export const ALLOWED_EXTENSIONS_LABEL = ALLOWED_EXTENSIONS.join('  ')

/**
 * 手动新建 / 改名的后缀：语言文本（`.lang`）与配音映射（`.voice`）的名字都由剧本名派生
 * （见 `localeLayout`：改名 `.hs` 会连带搬走它们），手工造这两个名字会切断派生关系，
 * 所以界面上的「新建」与「改名」都不接受它们。
 *
 * 注意：两者仍是合法的包内文件格式（`ALLOWED_EXTENSIONS`），**Agent 的写入能力不受限** ——
 * `write_source` 走的是 `normalizeResourceName`，照样能建、能改 `.lang` / `.voice`。
 */
export const MANUAL_FILE_EXTENSIONS = ALLOWED_EXTENSIONS.filter(
  (ext) => ext !== '.lang' && ext !== '.voice',
)

/** 给人看的手动新建 / 改名后缀文案 */
export const MANUAL_FILE_EXTENSIONS_LABEL = MANUAL_FILE_EXTENSIONS.join('  ')

/** 该文件名是否可手动新建 / 改名（语言文本与配音映射不可） */
export function isManualFileName(name: string): boolean {
  return (MANUAL_FILE_EXTENSIONS as readonly string[]).includes(
    getExtension(name).toLowerCase(),
  )
}

export type ScriptFile = {
  id: string
  name: string
  content: string
  updatedAt: number
}

/** 包内资产元数据（二进制在 IndexedDB） */
export type AssetFile = {
  id: string
  /** 相对包根，必须以 assets/ 开头，如 assets/voice/zh/a.wav */
  path: string
  mime: string
  size: number
  updatedAt: number
}

export type ScriptPackage = {
  id: string
  name: string
  collapsed: boolean
  /** assets 根是否折叠 */
  assetsCollapsed: boolean
  scripts: ScriptFile[]
  assets: AssetFile[]
  /** 显式文件夹（可为空），如 assets/voice/zh */
  assetFolders: string[]
}

export type Workspace = {
  packages: ScriptPackage[]
  activeScriptId: string | null
  /** 当前选中的资产（与脚本互斥展示） */
  activeAssetId: string | null
}

function uid(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

export function getExtension(name: string): string {
  const match = name.trim().toLowerCase().match(/(\.[a-z0-9]+)$/)
  return match?.[1] ?? ''
}

export function isAllowedExtension(ext: string): ext is AllowedExtension {
  return (ALLOWED_EXTENSIONS as readonly string[]).includes(ext.toLowerCase())
}

/** 校验并规范化文件名；不合法返回 null */
export function normalizeResourceName(raw: string): string | null {
  const name = raw.trim()
  if (!name) return null
  if (/[\\/:*?"<>|]/.test(name)) return null
  const ext = getExtension(name)
  if (!isAllowedExtension(ext)) return null
  return name
}

export function editorLanguageForFile(name: string): string {
  if (isTextAssetName(name)) return 'json'
  const ext = getExtension(name)
  if (ext === '.md') return 'markdown'
  if (ext === '.char' || ext === '.py') return 'python'
  if (ext === '.lang' || ext === '.voice') return 'json'
  return 'hanshu' // .hs 汉书剧本
}

export function isMarkdownFile(name: string): boolean {
  return getExtension(name) === '.md'
}

export function isHanshuFile(name: string): boolean {
  return getExtension(name) === '.hs'
}

export function isVoiceMapFile(name: string): boolean {
  return getExtension(name) === '.voice'
}

export function createScript(
  name: string,
  content = '',
): ScriptFile {
  return {
    id: uid('script'),
    name,
    content,
    updatedAt: Date.now(),
  }
}

export function createPackage(name: string, scripts: ScriptFile[] = []): ScriptPackage {
  return {
    id: uid('pkg'),
    name,
    collapsed: false,
    assetsCollapsed: false,
    scripts,
    assets: [],
    assetFolders: [],
  }
}

function defaultWorkspace(seedContent = ''): Workspace {
  const script = createScript('未命名剧本.hs', seedContent)
  const pkg = createPackage('默认包', [script])
  return {
    packages: [pkg],
    activeScriptId: script.id,
    activeAssetId: null,
  }
}

function migrateLegacyDraft(): Workspace | null {
  try {
    const raw = localStorage.getItem(LEGACY_DRAFT_KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as { script?: string }
    if (typeof data.script !== 'string') return null
    localStorage.removeItem(LEGACY_DRAFT_KEY)
    return defaultWorkspace(data.script)
  } catch {
    return null
  }
}

export function loadWorkspace(): Workspace {
  try {
    const raw = localStorage.getItem(WORKSPACE_KEY)
    if (raw) {
      const data = JSON.parse(raw) as Workspace
      if (Array.isArray(data.packages) && data.packages.length > 0) {
        return {
          packages: data.packages.map((pkg) => ({
            ...pkg,
            collapsed: Boolean(pkg.collapsed),
            assetsCollapsed: Boolean(
              (pkg as ScriptPackage).assetsCollapsed ?? false,
            ),
            scripts: Array.isArray(pkg.scripts) ? pkg.scripts : [],
            assets: Array.isArray((pkg as ScriptPackage).assets)
              ? (pkg as ScriptPackage).assets
              : [],
            assetFolders: Array.isArray((pkg as ScriptPackage).assetFolders)
              ? (pkg as ScriptPackage).assetFolders
              : [],
          })),
          activeScriptId: data.activeScriptId ?? data.packages[0]?.scripts[0]?.id ?? null,
          activeAssetId: (data as Workspace).activeAssetId ?? null,
        }
      }
    }
  } catch {
    // fall through
  }

  const migrated = migrateLegacyDraft()
  if (migrated) {
    saveWorkspace(migrated)
    return migrated
  }

  const fresh = defaultWorkspace(
    `标题：汉书

第一场 · 雨巷

【场景】黄昏，青石巷。雨丝斜斜。
`,
  )
  saveWorkspace(fresh)
  return fresh
}

export function saveWorkspace(workspace: Workspace): void {
  localStorage.setItem(
    WORKSPACE_KEY,
    JSON.stringify({
      ...workspace,
      updatedAt: Date.now(),
    }),
  )
}

export function findScript(
  workspace: Workspace,
  scriptId: string | null,
): { pkg: ScriptPackage; script: ScriptFile } | null {
  if (!scriptId) return null
  for (const pkg of workspace.packages) {
    const script = pkg.scripts.find((item) => item.id === scriptId)
    if (script) return { pkg, script }
  }
  return null
}

/** 按文件名查找（同名取先出现的） */
export function findScriptByName(
  workspace: Workspace,
  fileName: string,
): { pkg: ScriptPackage; script: ScriptFile } | null {
  const target = fileName.trim().toLowerCase()
  if (!target) return null
  for (const pkg of workspace.packages) {
    const script = pkg.scripts.find(
      (item) => item.name.toLowerCase() === target,
    )
    if (script) return { pkg, script }
  }
  return null
}

export function updateScriptContent(
  workspace: Workspace,
  scriptId: string,
  content: string,
): Workspace {
  return {
    ...workspace,
    packages: workspace.packages.map((pkg) => ({
      ...pkg,
      scripts: pkg.scripts.map((script) =>
        script.id === scriptId
          ? { ...script, content, updatedAt: Date.now() }
          : script,
      ),
    })),
  }
}

export function findAsset(
  workspace: Workspace,
  assetId: string | null,
): { pkg: ScriptPackage; asset: AssetFile } | null {
  if (!assetId) return null
  for (const pkg of workspace.packages) {
    const asset = pkg.assets.find((item) => item.id === assetId)
    if (asset) return { pkg, asset }
  }
  return null
}

export function upsertAssetMeta(
  workspace: Workspace,
  packageId: string,
  path: string,
  mime: string,
  size: number,
): { workspace: Workspace; asset: AssetFile } | null {
  const pkg = workspace.packages.find((item) => item.id === packageId)
  if (!pkg) return null

  const existing = pkg.assets.find(
    (item) => item.path.toLowerCase() === path.toLowerCase(),
  )
  const asset: AssetFile = existing
    ? { ...existing, mime, size, updatedAt: Date.now() }
    : {
        id: uid('asset'),
        path,
        mime,
        size,
        updatedAt: Date.now(),
      }

  const next: Workspace = {
    ...workspace,
    packages: workspace.packages.map((item) => {
      if (item.id !== packageId) return item
      if (existing) {
        return {
          ...item,
          assets: item.assets.map((a) => (a.id === existing.id ? asset : a)),
        }
      }
      return {
        ...item,
        assetsCollapsed: false,
        assets: [...item.assets, asset],
      }
    }),
  }
  return { workspace: next, asset }
}

export function removeAssetMeta(
  workspace: Workspace,
  assetId: string,
): Workspace {
  return {
    ...workspace,
    activeAssetId:
      workspace.activeAssetId === assetId ? null : workspace.activeAssetId,
    packages: workspace.packages.map((pkg) => ({
      ...pkg,
      assets: pkg.assets.filter((asset) => asset.id !== assetId),
    })),
  }
}

export function toggleAssetsCollapsed(
  workspace: Workspace,
  packageId: string,
): Workspace {
  return {
    ...workspace,
    packages: workspace.packages.map((pkg) =>
      pkg.id === packageId
        ? { ...pkg, assetsCollapsed: !pkg.assetsCollapsed }
        : pkg,
    ),
  }
}

/** 登记空文件夹（及中间路径） */
export function ensureAssetFolder(
  workspace: Workspace,
  packageId: string,
  folderPath: string,
): Workspace {
  const norm = folderPath.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!norm.toLowerCase().startsWith('assets')) return workspace

  // 收集祖先链 assets, assets/a, assets/a/b
  const parts = norm.split('/')
  const chain: string[] = []
  for (let i = 1; i <= parts.length; i++) {
    chain.push(parts.slice(0, i).join('/'))
  }

  return {
    ...workspace,
    packages: workspace.packages.map((pkg) => {
      if (pkg.id !== packageId) return pkg
      const set = new Set(pkg.assetFolders.map((f) => f.toLowerCase()))
      const nextFolders = [...pkg.assetFolders]
      for (const p of chain) {
        if (p.toLowerCase() === 'assets') continue
        if (!set.has(p.toLowerCase())) {
          set.add(p.toLowerCase())
          nextFolders.push(p)
        }
      }
      return {
        ...pkg,
        assetsCollapsed: false,
        assetFolders: nextFolders,
      }
    }),
  }
}

/**
 * 删除文件夹及其下所有文件元数据。
 * 返回被删资产列表，便于清 IndexedDB。
 */
export function removeAssetFolder(
  workspace: Workspace,
  packageId: string,
  folderPath: string,
): { workspace: Workspace; removed: AssetFile[] } {
  const prefix = folderPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const pkg = workspace.packages.find((p) => p.id === packageId)
  if (!pkg || prefix === 'assets') {
    return { workspace, removed: [] }
  }

  const removed = pkg.assets.filter(
    (a) =>
      a.path.toLowerCase() === prefix ||
      a.path.toLowerCase().startsWith(`${prefix}/`),
  )
  const removedIds = new Set(removed.map((a) => a.id))

  const next: Workspace = {
    ...workspace,
    activeAssetId:
      workspace.activeAssetId && removedIds.has(workspace.activeAssetId)
        ? null
        : workspace.activeAssetId,
    packages: workspace.packages.map((item) => {
      if (item.id !== packageId) return item
      return {
        ...item,
        assets: item.assets.filter((a) => !removedIds.has(a.id)),
        assetFolders: item.assetFolders.filter((f) => {
          const fl = f.toLowerCase()
          return fl !== prefix && !fl.startsWith(`${prefix}/`)
        }),
      }
    }),
  }
  return { workspace: next, removed }
}
