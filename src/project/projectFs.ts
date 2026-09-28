/**
 * 文件夹工程：打开 / 新建 / 保存
 * 一个目录 = 一个 ScriptPackage；文本在根目录，二进制在 assets/
 */

import {
  deletePackageAssetBlobs,
  getAssetBlob,
  putAssetBlob,
} from '../assets/idb'
import { normalizeAssetPath, normalizeFolderPath } from '../assets/paths'
import {
  ALLOWED_EXTENSIONS,
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
  removeEntryIfExists,
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
    assets.push({
      id: uid('asset'),
      path: norm,
      mime: file.type || guessMime(norm),
      size: file.size,
      updatedAt: file.lastModified || Date.now(),
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

  // 源文件在 `src/<kind>/` 下；`.md` 与旧 `*.voice` 仍留在根目录
  const scripts = []
  const seen = new Set<string>()
  const addScript = async (name: string, path: string) => {
    if (seen.has(name.toLowerCase())) return
    const file = await readFileAtPath(root, path)
    if (!file) return
    seen.add(name.toLowerCase())
    scripts.push(createScript(name, await file.text()))
  }

  const children = await listChildren(root)
  for (const entry of children) {
    if (entry.kind !== 'file') continue
    // 写盘层的 `.new` 中间文件：万一崩溃残留，别把它当成脚本收进工作区
    if (entry.name.toLowerCase().endsWith('.new')) continue
    if (!isProjectLoadableFile(entry.name)) continue
    await addScript(entry.name, entry.name)
  }
  try {
    const srcDir = await root.getDirectoryHandle('src')
    for (const path of await listFilesRecursive(srcDir, '')) {
      const name = path.split('/').pop() ?? ''
      if (name.toLowerCase().endsWith('.new')) continue
      if (!isProjectLoadableFile(name)) continue
      await addScript(name, `src/${path}`)
    }
  } catch {
    // 没有 src/：旧平铺工程，根目录那份上面已经读过了
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
  await writeTextFile(handle, script.name, script.content)

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

  // 2) 脚本：按 `src/<kind>/` 写入；清掉多余的源文件与旧平铺副本
  const wanted = new Set(pkg.scripts.map((s) => s.name.toLowerCase()))
  for (const script of pkg.scripts) {
    await writeFileAtPath(root, sourceRelativePath(script.name), script.content)
  }
  // 旧布局把脚本平铺在根目录：同名副本已搬到 src/ 下，删掉免得重复
  for (const entry of await listChildren(root)) {
    if (entry.kind !== 'file') continue
    if (!isScriptFileName(entry.name)) continue
    if (wanted.has(entry.name.toLowerCase())) {
      await removeEntryIfExists(root, entry.name)
    }
  }
  try {
    const srcDir = await root.getDirectoryHandle('src')
    for (const path of await listFilesRecursive(srcDir, '')) {
      if (path.toLowerCase().endsWith('.new')) continue
      const name = path.split('/').pop() ?? ''
      if (!isScriptFileName(name)) continue
      if (!wanted.has(name.toLowerCase())) {
        await removeEntryIfExists(srcDir, path)
      }
    }
  } catch {
    // 尚未创建 src/
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

/** 供 UI 展示：允许的脚本后缀 */
export const PROJECT_SCRIPT_EXTENSIONS = ALLOWED_EXTENSIONS
