/**
 * 文件夹工程：打开 / 新建 / 保存
 * 一个目录 = 一个 Project；文本在 `src/`（源）与 `meta/`（创作资料），二进制在 `assets/`
 * 不再兼容包根平铺的旧布局。
 */

import {
  deletePackageAssetBlobs,
  getAssetBlob,
  putAssetBlob,
} from '../assets/idb'
import { normalizeAssetPath, normalizeFolderPath } from '../assets/paths'
import { isVoiceRefPath, parseVoiceRefContent, voiceAssetDir } from '../i18n/voiceMap'
import { sourceExtension, textAssetPath } from '../i18n/localeLayout'
import {
  ALLOWED_EXTENSIONS,
  FILE_DIRS,
  createPackage,
  createScript,
  findScript,
  getExtension,
  isAllowedExtension,
  normalizeResourceName,
  sourceRelativePath,
  type ScriptPackage,
  type Workspace,
} from '../workspace'
import {
  ensureReadWritePermission,
  guessMime,
  listChildren,
  listFilesRecursive,
  pickProjectDirectory,
  readFileAtPath,
  readTextFile,
  removeDirectoryAtPath,
  removeEntryIfExists,
  removeFileAtPath,
  supportsDirectoryPicker,
  writeFileAtPath,
  writeTextFile,
} from './directoryIo'
import {
  clearLastDirectoryHandle,
  loadLastDirectoryHandle,
  saveLastDirectoryHandle,
} from './handleStore'
import {
  PROJECT_FILE,
  createManifest,
  parseManifestJson,
  serializeManifest,
  type ProjectManifest,
} from './manifest'

export { supportsDirectoryPicker, PROJECT_FILE }
export type { ProjectManifest }

export type BoundProject = {
  handle: FileSystemDirectoryHandle
  /** 文件夹名 */
  folderName: string
  manifest: ProjectManifest
}

export type LoadProjectResult = {
  binding: BoundProject
  workspace: Workspace
}

function uid(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

/**
 * 根目录之外存放文本文件的固定目录（`src` 与 `meta`）。
 * 由 `FILE_DIRS` 推导 —— 以后新增归位目录不用再来改这里。
 */
const TEXT_ROOT_DIRS = [
  ...new Set(Object.values(FILE_DIRS).map((dir) => dir.split('/')[0] ?? '')),
]

function isScriptFileName(name: string): boolean {
  if (name === PROJECT_FILE) return false
  if (name.startsWith('.')) return false
  return isAllowedExtension(getExtension(name))
}

/**
 * 加载时可以进工作区的文件：白名单后缀，或语言文本文件 `<名>.lang.<语言标签>`
 * —— 后者结尾是语言标签、不在后缀白名单里，靠 `normalizeResourceName` 的例外放行。
 * 只给加载用：保存时的"清理多余文件"仍走 `isScriptFileName`，
 * 这样磁盘上的语言文件不会被当成多余脚本删掉。
 */
function isProjectLoadableFile(name: string): boolean {
  if (name === PROJECT_FILE) return false
  if (name.startsWith('.')) return false
  return normalizeResourceName(name) !== null
}

async function directoryLooksInitialized(
  dir: FileSystemDirectoryHandle,
): Promise<{ hasManifest: boolean; hasOtherFiles: boolean }> {
  let hasManifest = false
  let hasOtherFiles = false
  for await (const [name] of dir.entries()) {
    if (name === PROJECT_FILE) hasManifest = true
    else hasOtherFiles = true
  }
  return { hasManifest, hasOtherFiles }
}

async function loadAssetsFromDisk(
  root: FileSystemDirectoryHandle,
  packageId: string,
): Promise<{
  assets: ScriptPackage['assets']
  assetFolders: string[]
}> {
  let assetsDir: FileSystemDirectoryHandle
  try {
    assetsDir = await root.getDirectoryHandle('assets')
  } catch {
    return { assets: [], assetFolders: [] }
  }

  const filePaths = await listFilesRecursive(assetsDir, 'assets')
  const folderSet = new Set<string>(['assets'])
  const assets: ScriptPackage['assets'] = []

  for (const path of filePaths) {
    const norm = normalizeAssetPath(path)
    if (!norm) continue
    // 配音导入的 `.new` 中间文件：万一崩溃残留，别把它当成资产收进 IndexedDB
    // （下次「保存工程」会整树重写 assets/，残留自然被清掉）
    if (norm.toLowerCase().endsWith('.new')) continue
    const parent = norm.includes('/')
      ? norm.slice(0, norm.lastIndexOf('/'))
      : 'assets'
    const folder = normalizeFolderPath(parent)
    if (folder) folderSet.add(folder)

    const file = await (async () => {
      const parts = norm.split('/')
      let cur: FileSystemDirectoryHandle = root
      for (let i = 0; i < parts.length - 1; i++) {
        cur = await cur.getDirectoryHandle(parts[i]!)
      }
      const fh = await cur.getFileHandle(parts[parts.length - 1]!)
      return fh.getFile()
    })()

    await putAssetBlob(packageId, norm, file)
    /*
     * 「引用资产」配音（`.ref`）：正文指向的资产路径在**这里**解出来。
     * 配音四态是同步判定的（编辑器渲染期就问），而 `.ref` 的正文要异步读 ——
     * 读盘这一步本来就是逐文件 await，顺手解掉最省事：之后解析层只比字符串。
     */
    const refTarget = isVoiceRefPath(norm)
      ? parseVoiceRefContent(await file.text())
      : undefined
    assets.push({
      id: uid('asset'),
      path: norm,
      mime: file.type || guessMime(norm),
      size: file.size,
      updatedAt: file.lastModified || Date.now(),
      ...(refTarget !== undefined ? { refTarget } : {}),
    })
  }

  // 空文件夹：扫目录树
  const walkDirs = async (
    dir: FileSystemDirectoryHandle,
    prefix: string,
  ): Promise<void> => {
    folderSet.add(prefix)
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'directory') {
        await walkDirs(handle, `${prefix}/${name}`)
      }
    }
  }
  await walkDirs(assetsDir, 'assets')

  return {
    assets,
    assetFolders: [...folderSet].sort((a, b) => a.localeCompare(b)),
  }
}

async function readPackageFromDirectory(
  root: FileSystemDirectoryHandle,
  folderName: string,
  existingManifest?: ProjectManifest | null,
): Promise<{ pkg: ScriptPackage; manifest: ProjectManifest; activeScriptId: string | null }> {
  const raw = await readTextFile(root, PROJECT_FILE)
  let manifest: ProjectManifest
  if (raw) {
    manifest = parseManifestJson(raw)
  } else if (existingManifest) {
    manifest = existingManifest
  } else {
    manifest = createManifest({
      name: folderName,
      id: uid('pkg'),
    })
  }

  // 换工程前清掉同 id 的旧 blob，避免脏数据（id 稳定时是覆盖写入）
  await deletePackageAssetBlobs(manifest.id)

  // 源文件只认 `src/<kind>/` 与 `meta/`，不再兼容包根平铺。
  const scripts = []
  const seen = new Set<string>()
  const addScript = async (name: string, path: string) => {
    if (seen.has(name.toLowerCase())) return
    const file = await readFileAtPath(root, path)
    if (!file) return
    seen.add(name.toLowerCase())
    scripts.push(createScript(name, await file.text()))
  }

  for (const dirName of TEXT_ROOT_DIRS) {
    try {
      const dir = await root.getDirectoryHandle(dirName)
      for (const path of await listFilesRecursive(dir, '')) {
        const name = path.split('/').pop() ?? ''
        if (name.toLowerCase().endsWith('.new')) continue
        if (!isProjectLoadableFile(name)) continue
        await addScript(name, `${dirName}/${path}`)
      }
    } catch {
      // 还没有这个目录
    }
  }

  if (scripts.length === 0) {
    scripts.push(
      createScript(
        '未命名剧本.hs',
        `标题：${manifest.name}\n\n第一场\n\n`,
      ),
    )
  }

  const { assets, assetFolders } = await loadAssetsFromDisk(root, manifest.id)

  const pkg: ScriptPackage = {
    id: manifest.id,
    name: manifest.name || folderName,
    collapsed: Boolean(manifest.collapsed),
    assetsCollapsed: Boolean(manifest.assetsCollapsed),
    scripts,
    assets,
    assetFolders,
  }

  let activeScriptId: string | null = scripts[0]?.id ?? null
  if (manifest.activeScript) {
    const hit = scripts.find(
      (s) => s.name.toLowerCase() === manifest.activeScript!.toLowerCase(),
    )
    if (hit) activeScriptId = hit.id
  }

  return { pkg, manifest, activeScriptId }
}

function workspaceFromPackage(
  pkg: ScriptPackage,
  activeScriptId: string | null,
): Workspace {
  return {
    packages: [pkg],
    activeScriptId,
    activeAssetId: null,
  }
}

export async function openProjectFromPicker(): Promise<LoadProjectResult> {
  const handle = await pickProjectDirectory()
  const ok = await ensureReadWritePermission(handle)
  if (!ok) throw new Error('未获得文件夹读写权限')

  const { hasManifest } = await directoryLooksInitialized(handle)
  if (!hasManifest) {
    const init = window.confirm(
      `文件夹「${handle.name}」没有 project.json。\n\n是否在此初始化为汉书工程？`,
    )
    if (!init) throw new Error('已取消打开工程')
  }

  const { pkg, manifest, activeScriptId } = await readPackageFromDirectory(
    handle,
    handle.name,
  )

  // 若刚初始化，立刻写一份 manifest + 默认剧本
  if (!hasManifest) {
    await writeTextFile(handle, PROJECT_FILE, serializeManifest(manifest))
    for (const script of pkg.scripts) {
      await writeFileAtPath(
        handle,
        sourceRelativePath(script.name),
        script.content,
      )
    }
  }

  const binding: BoundProject = {
    handle,
    folderName: handle.name,
    manifest: { ...manifest, name: pkg.name },
  }
  await saveLastDirectoryHandle(handle)

  return {
    binding,
    workspace: workspaceFromPackage(pkg, activeScriptId),
  }
}

export async function createProjectFromPicker(): Promise<LoadProjectResult> {
  const handle = await pickProjectDirectory()
  const ok = await ensureReadWritePermission(handle)
  if (!ok) throw new Error('未获得文件夹读写权限')

  const { hasManifest, hasOtherFiles } = await directoryLooksInitialized(handle)
  if (hasManifest) {
    const reuse = window.confirm(
      `「${handle.name}」已是汉书工程。\n\n打开它，而不是覆盖？`,
    )
    if (reuse) {
      return openProjectWithHandle(handle)
    }
    throw new Error('已取消新建工程')
  }
  if (hasOtherFiles) {
    const go = window.confirm(
      `「${handle.name}」不是空文件夹。\n\n仍要在此创建 project.json 并写入默认剧本吗？`,
    )
    if (!go) throw new Error('已取消新建工程')
  }

  const script = createScript(
    '未命名剧本.hs',
    `标题：${handle.name}\n\n第一场 · \n\n【场景】\n`,
  )
  const pkg = createPackage(handle.name, [script])
  const manifest = createManifest({
    name: handle.name,
    id: pkg.id,
    activeScript: script.name,
  })
  // createPackage 生成了新 id，与 manifest 对齐
  pkg.id = manifest.id
  pkg.name = manifest.name

  await writeTextFile(handle, PROJECT_FILE, serializeManifest(manifest))
  await writeFileAtPath(handle, sourceRelativePath(script.name), script.content)

  const binding: BoundProject = {
    handle,
    folderName: handle.name,
    manifest,
  }
  await saveLastDirectoryHandle(handle)

  return {
    binding,
    workspace: workspaceFromPackage(pkg, script.id),
  }
}

async function openProjectWithHandle(
  handle: FileSystemDirectoryHandle,
): Promise<LoadProjectResult> {
  const ok = await ensureReadWritePermission(handle)
  if (!ok) throw new Error('未获得文件夹读写权限')

  const { pkg, manifest, activeScriptId } = await readPackageFromDirectory(
    handle,
    handle.name,
  )
  const binding: BoundProject = {
    handle,
    folderName: handle.name,
    manifest: { ...manifest, name: pkg.name },
  }
  await saveLastDirectoryHandle(handle)
  return {
    binding,
    workspace: workspaceFromPackage(pkg, activeScriptId),
  }
}

/** 尝试恢复上次工程（需用户曾授权；失败返回 null） */
export async function tryRestoreLastProject(): Promise<LoadProjectResult | null> {
  if (!supportsDirectoryPicker()) return null
  const handle = await loadLastDirectoryHandle()
  if (!handle) return null
  try {
    const ok = await ensureReadWritePermission(handle)
    if (!ok) return null
    const raw = await readTextFile(handle, PROJECT_FILE)
    if (!raw) return null
    return await openProjectWithHandle(handle)
  } catch {
    return null
  }
}

export async function saveProjectToDirectory(
  binding: BoundProject,
  workspace: Workspace,
): Promise<BoundProject> {
  const ok = await ensureReadWritePermission(binding.handle)
  if (!ok) throw new Error('未获得文件夹读写权限')

  const pkg =
    workspace.packages.find((p) => p.id === binding.manifest.id) ??
    workspace.packages[0]
  if (!pkg) throw new Error('工作区没有可保存的包')

  const active = findScript(workspace, workspace.activeScriptId)
  const manifest = createManifest({
    name: pkg.name,
    id: pkg.id,
    activeScript: active?.script.name ?? null,
    collapsed: pkg.collapsed,
    assetsCollapsed: pkg.assetsCollapsed,
  })

  const root = binding.handle

  // 1) project.json
  await writeTextFile(root, PROJECT_FILE, serializeManifest(manifest))

  // 2) 文本文件：按规范写入 `src/<kind>/` 与 `meta/`；清理目录内多余/错位文件
  const wanted = new Set(pkg.scripts.map((s) => s.name.toLowerCase()))
  for (const script of pkg.scripts) {
    await writeFileAtPath(root, sourceRelativePath(script.name), script.content)
  }
  for (const dirName of TEXT_ROOT_DIRS) {
    try {
      const dir = await root.getDirectoryHandle(dirName)
      for (const path of await listFilesRecursive(dir, '')) {
        if (path.toLowerCase().endsWith('.new')) continue
        const name = path.split('/').pop() ?? ''
        if (!isScriptFileName(name)) continue
        const misplaced = `${dirName}/${path}` !== sourceRelativePath(name)
        if (misplaced || !wanted.has(name.toLowerCase())) {
          await removeEntryIfExists(dir, path)
        }
      }
    } catch {
      // 尚未创建该目录
    }
  }

  // 3) assets：整树重写（先删再写，逻辑简单可靠）
  // 注意：绝不触碰 `.hanshu/`（皮肤库等工程附属数据）
  await removeEntryIfExists(root, 'assets', { recursive: true })
  if (pkg.assetFolders.length > 0 || pkg.assets.length > 0) {
    await root.getDirectoryHandle('assets', { create: true })
  }
  for (const folder of pkg.assetFolders) {
    const norm = normalizeFolderPath(folder)
    if (!norm || norm === 'assets') continue
    const parts = norm.split('/')
    let cur = root
    for (const part of parts) {
      cur = await cur.getDirectoryHandle(part, { create: true })
    }
  }
  for (const asset of pkg.assets) {
    const blob = await getAssetBlob(pkg.id, asset.path)
    if (!blob) continue
    await writeFileAtPath(root, asset.path, blob)
  }

  const next: BoundProject = {
    handle: root,
    folderName: root.name,
    manifest,
  }
  await saveLastDirectoryHandle(root)
  return next
}

/** 另存为：选新目录写入并切换绑定 */
export async function saveProjectAsToPicker(
  workspace: Workspace,
  preferredPackageId?: string | null,
): Promise<LoadProjectResult> {
  const handle = await pickProjectDirectory()
  const ok = await ensureReadWritePermission(handle)
  if (!ok) throw new Error('未获得文件夹读写权限')

  const { hasManifest, hasOtherFiles } = await directoryLooksInitialized(handle)
  if (hasManifest || hasOtherFiles) {
    const go = window.confirm(
      `「${handle.name}」非空。\n\n继续写入将覆盖同名剧本文件与 assets，是否继续？`,
    )
    if (!go) throw new Error('已取消另存为')
  }

  const pkg =
    workspace.packages.find((p) => p.id === preferredPackageId) ??
    workspace.packages[0]
  if (!pkg) throw new Error('没有可保存的包')

  // 另存为使用新目录名，但保留包 id（资产 IDB 键不变）
  const renamed: ScriptPackage = {
    ...pkg,
    name: pkg.name || handle.name,
  }
  const ws: Workspace = {
    packages: [renamed],
    activeScriptId: workspace.activeScriptId,
    activeAssetId: null,
  }

  const binding: BoundProject = {
    handle,
    folderName: handle.name,
    manifest: createManifest({
      name: renamed.name,
      id: renamed.id,
    }),
  }

  const saved = await saveProjectToDirectory(binding, ws)
  return {
    binding: saved,
    workspace: ws,
  }
}

export async function unbindProject(): Promise<void> {
  await clearLastDirectoryHandle()
}

/** `assets/` 下已有的语言标签目录名 */
async function listDiskLocales(
  root: FileSystemDirectoryHandle,
): Promise<string[]> {
  try {
    const assets = await root.getDirectoryHandle('assets')
    const locales: string[] = []
    for (const entry of await listChildren(assets)) {
      if (entry.kind === 'directory') locales.push(entry.name)
    }
    return locales
  } catch {
    return []
  }
}

/**
 * 立刻从工程目录删掉某个源文件及其各语言 lang / voice 产物。
 * 改名、删除不应只改内存、等整包保存才清磁盘 —— 否则重开工程旧文件会回来。
 */
export async function removeSourceFromDisk(
  handle: FileSystemDirectoryHandle,
  sourceName: string,
): Promise<void> {
  const ok = await ensureReadWritePermission(handle)
  if (!ok) throw new Error('未获得文件夹读写权限')

  await removeFileAtPath(handle, sourceRelativePath(sourceName))
  const ext = sourceExtension(sourceName)
  for (const locale of await listDiskLocales(handle)) {
    await removeFileAtPath(handle, textAssetPath(locale, sourceName))
    if (ext) {
      await removeDirectoryAtPath(handle, voiceAssetDir(locale, sourceName, ext))
    }
  }
}

/**
 * 立刻在工程目录完成源文件改名：写新路径、删旧路径，并搬迁已登记的语言资产。
 */
export async function renameSourceOnDisk(
  handle: FileSystemDirectoryHandle,
  oldName: string,
  newName: string,
  content: string,
  assetMoves: Array<{ fromPath: string; toPath: string }> = [],
): Promise<void> {
  const ok = await ensureReadWritePermission(handle)
  if (!ok) throw new Error('未获得文件夹读写权限')

  const oldSource = sourceRelativePath(oldName)
  const newSource = sourceRelativePath(newName)
  await writeFileAtPath(handle, newSource, content)
  if (oldSource.toLowerCase() !== newSource.toLowerCase()) {
    await removeFileAtPath(handle, oldSource)
  }

  const kept = new Set(
    assetMoves.map((move) => move.toPath.replace(/\\/g, '/').toLowerCase()),
  )
  kept.add(newSource.toLowerCase())

  for (const move of assetMoves) {
    if (move.fromPath.toLowerCase() === move.toPath.toLowerCase()) continue
    const data = await readFileAtPath(handle, move.fromPath)
    if (data) {
      await writeFileAtPath(handle, move.toPath, data)
    }
    if (!kept.has(move.fromPath.replace(/\\/g, '/').toLowerCase())) {
      await removeFileAtPath(handle, move.fromPath)
    }
  }

  // 旧名下可能还有未进工作区元数据的语音目录 / lang，一并清掉（避开新路径）
  const oldExt = sourceExtension(oldName)
  for (const locale of await listDiskLocales(handle)) {
    const oldLang = textAssetPath(locale, oldName)
    if (!kept.has(oldLang.toLowerCase())) {
      await removeFileAtPath(handle, oldLang)
    }
    if (oldExt) {
      const oldVoice = voiceAssetDir(locale, oldName, oldExt)
      const newVoice = voiceAssetDir(locale, newName, sourceExtension(newName) || oldExt)
      if (oldVoice.toLowerCase() !== newVoice.toLowerCase()) {
        await removeDirectoryAtPath(handle, oldVoice)
      }
    }
  }
}

/** 供 UI 展示：允许的脚本后缀 */
export const PROJECT_SCRIPT_EXTENSIONS = ALLOWED_EXTENSIONS
