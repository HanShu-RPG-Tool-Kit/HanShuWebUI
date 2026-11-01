import {resourceNameKey} from '../resourceTypes'
import {EXPLORER_ORGANIZATION_PATH,emptyOrganization,parseOrganization,serializeOrganization} from './explorerOrganization'
import {assertCanonicalSourcePath} from '../workspace'
import { sha256Hex } from './crypto'
import { ServiceError } from '../collab/protocol'
import { parseBossbar } from '../workspaces/audiovisual/bossbar/parse'
import { getProjectSession, setProjectSession } from './projectSession'
import type { ProjectClient, ProjectDirectory } from './serviceClient'
import { setBoundProject } from './bindingBus'
/**
 * 文件夹工程：打开 / 新建 / 保存
 * 一个目录 = 一个 Project；文本在 `src/`（源）与 `meta/`（创作资料），二进制在 `assets/`
 * 不再兼容包根平铺的旧布局。
 */

import {
  getAssetBlob,
  assetCacheEpoch,
  cacheRemoteAsset,
  putAssetBlob,
} from '../assets/idb'
import { normalizeAssetPath, normalizeFolderPath } from '../assets/paths'
import { isVoiceRefPath, parseVoiceRefContent } from '../i18n/voiceMap'
import {
  ALLOWED_EXTENSIONS,
  FILE_DIRS,
  createScript,
  normalizeResourceName,
  sourcePathOf,
  sourceRelativePath,
  srcKindFromDiskPath,
  type SourceFile,
  type ScriptPackage,
  type Workspace,
} from '../workspace'
import {
  guessMime,
  listFilesRecursive,
  pickProjectDirectory,
  readFileAtPath,
  readTextFile,
  supportsDirectoryPicker,
} from './directoryIo'
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
  handle: ProjectDirectory
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

/**
 * 加载时可以进工作区的文件：白名单后缀，或语言文本文件 `<名>.lang.<语言标签>`
 * —— 后者结尾是语言标签、不在后缀白名单里，靠 `normalizeResourceName` 的例外放行。
 * 只给加载用：保存时的"清理多余文件"仍走 `isScriptFileName`，
 * 这样磁盘上的语言文件不会被当成多余脚本删掉。
 */
function isProjectLoadableFile(name: string): boolean {
  if (name === PROJECT_FILE) return false
  if (name.startsWith('.')) return false
  if (name.trim().toLowerCase() === 'load.json') return true
  return normalizeResourceName(name) !== null
}

async function loadAssetsFromDisk(
  root: ProjectDirectory,
  packageId: string,
): Promise<{
  assets: ScriptPackage['assets']
  assetFolders: string[]
}> {
  let assetsDir: ProjectDirectory
  try {
    assetsDir = await root.getDirectoryHandle('assets')
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'not_found') return { assets: [], assetFolders: [] }
    throw e
  }

  const filePaths = await listFilesRecursive(assetsDir, 'assets')
  const folderSet = new Set<string>(['assets'])
  const assets: ScriptPackage['assets'] = []

  for (const path of filePaths) {
    const norm = normalizeAssetPath(path)
    if (!norm) continue
    // 配音导入的 `.new` 中间文件：万一崩溃残留，别把它当成资产收进 IndexedDB
    // 中间文件不是作者资源；保存不再通过重写目录清理它们。
    if (norm.toLowerCase().endsWith('.new')) continue
    const parent = norm.includes('/')
      ? norm.slice(0, norm.lastIndexOf('/'))
      : 'assets'
    const folder = normalizeFolderPath(parent)
    if (folder) folderSet.add(folder)

    const file = await (async () => {
      const parts = norm.split('/')
      let cur: ProjectDirectory = root
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
    dir: ProjectDirectory,
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
  root: ProjectDirectory,
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


  // 源文件只认 `src/<kind>/` 与 `meta/`，不再兼容包根平铺。
  const scripts: SourceFile[] = []
  const seen = new Set<string>()
  const addScript = async (name: string, path: string) => {
    assertCanonicalSourcePath(path)
    if(/^src\/script\/[^/]+\/load\.json$/i.test(path)){
      if(!/^src\/script\/(common|player)\/load\.json$/i.test(path))throw new Error(`启动列表仅允许 src/script/common/load.json 或 src/script/player/load.json，收到：${path}`)
    } else if(name.toLowerCase().endsWith('.py')&&!/^src\/script\/(common|goal|kit|shop|actor|player)\/[^/]+\.py$/i.test(path)){
      throw new Error(`脚本目录需要调整：${path}。请放入 src/script/<common|goal|kit|shop|actor|player>/。`)
    }
    if (seen.has(resourceNameKey(path))) throw new Error(`存在重名资源路径：${path}`)
    const file = await readFileAtPath(root, path)
    if (!file) return
    seen.add(resourceNameKey(path))
    const text = await file.text()
    const srcKind = srcKindFromDiskPath(path)
    root.client.texts.set(path, text)
    scripts.push({ ...createScript(name, text, srcKind), id: `source:${path}` })
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
    } catch (e) {
      if (!(e instanceof ServiceError && e.code === 'not_found')) throw e
    }
  }

  const { assets, assetFolders } = await loadAssetsFromDisk(root, manifest.id)
  root.client.assetPackageId = manifest.id
  for (const asset of assets) root.client.assetEpochs.set(asset.path, assetCacheEpoch(manifest.id, asset.path))

  const pkg: ScriptPackage = {
    id: manifest.id,
    name: manifest.name || folderName,
    collapsed: Boolean(manifest.collapsed),
    assetsCollapsed: Boolean(manifest.assetsCollapsed),
    scripts,
    explorer: parseOrganization(await root.client.text(EXPLORER_ORGANIZATION_PATH)),
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

export async function loadServiceProject(handle: ProjectDirectory): Promise<LoadProjectResult> {
  await handle.client.refresh()
  const { pkg, manifest, activeScriptId } = await readPackageFromDirectory(handle, handle.name)
  return { binding: { handle, folderName: manifest.name, manifest }, workspace: workspaceFromPackage(pkg, activeScriptId) }
}
/** Adopt remote metadata only while both the manifest and its editor projection are clean. */
export async function refreshProjectManifest(client: ProjectClient): Promise<void> {
  const before = getProjectSession()
  const binding = before.binding
  if (binding?.handle.client !== client) return
  const pkg = before.workspace.packages.find(pkg => pkg.id === binding.manifest.id)
  const entry = client.entry(PROJECT_FILE)
  if (!entry) throw new Error('工程清单已不存在，请重新打开工程')
  if (!pkg || pkg.name !== binding.manifest.name || client.transactions.hasDraft(PROJECT_FILE) || client.baseline.get(PROJECT_FILE) === entry.version) return
  const raw = await (await client.read(PROJECT_FILE, false, entry.version)).text()
  const manifest = parseManifestJson(raw)
  if (manifest.id !== binding.manifest.id) throw new Error('工程清单身份已变化，请重新打开工程')
  const live = getProjectSession()
  const current = live.binding
  const currentPkg = live.workspace.packages.find(pkg => pkg.id === manifest.id)
  if (current?.handle.client !== client || !currentPkg || currentPkg.name !== current.manifest.name || client.transactions.hasDraft(PROJECT_FILE)) return
  if (client.entry(PROJECT_FILE)?.version !== entry.version) throw new ServiceError('conflict', '读取期间工程清单发生变化，请重试')
  const nextBinding = { ...current, manifest, folderName: manifest.name }
  client.baseline.set(PROJECT_FILE, entry.version)
  client.texts.set(PROJECT_FILE, raw)
  client.originals.set(PROJECT_FILE, { version: entry.version, data: raw })
  setProjectSession({ binding: nextBinding, workspace: { ...live.workspace, packages: live.workspace.packages.map(pkg => pkg.id === manifest.id ? { ...pkg, name: manifest.name } : pkg) } })
  setBoundProject(nextBinding)
}
/** Merge remote changes only into clean resources; dirty text/binary drafts retain their read versions. */
export async function refreshServiceProject(binding: BoundProject, current: Workspace): Promise<Workspace> {
  const client = binding.handle.client
  await client.refresh()
  const pkg = current.packages.find(p => p.id === binding.manifest.id)
  if (!pkg) return current
  const scripts = [...pkg.scripts]
  const staged: Array<{path:string;content:string;version:string}> = []
  const remote = client.tree.entries.filter(e => e.kind === 'file' && TEXT_ROOT_DIRS.some(root => e.path.startsWith(`${root}/`)) && isProjectLoadableFile(e.path.split('/').at(-1)!))
  for (const entry of remote) {
    assertCanonicalSourcePath(entry.path)
    const index = scripts.findIndex(s => sourcePathOf(s) === entry.path)
    const local = scripts[index]
    if (local && (local.detached||client.texts.get(entry.path) !== local.content)) continue
    if (local && client.baseline.get(entry.path) === entry.version) continue
    const content = await (await client.read(entry.path, false, entry.version)).text()
    if (content === null) continue
    const source = { ...createScript(entry.path.split('/').at(-1)!, content, srcKindFromDiskPath(entry.path)), id: local?.id ?? `source:${entry.path}` }
    if (index >= 0) scripts[index] = source; else scripts.push(source)
    staged.push({path:entry.path,content,version:entry.version})
  }
  const semanticDrafts=new Set(client.transactions.editorDirtyPaths())
  client.resourceLifecycle.observe(new Set(remote.map(entry=>entry.path)))
  const kept = scripts.map(source=>{
    const path=sourcePathOf(source)
    return !remote.some(entry=>entry.path===path)&&client.baseline.has(path)&&(source.content!==client.texts.get(path)||semanticDrafts.has(path))?{...source,detached:true}:source
  }).filter(s => {
    const path = sourcePathOf(s)
    return s.detached || remote.some(e => e.path === path) || !client.baseline.has(path) || client.texts.get(path) !== s.content
  })
  let assets = [...pkg.assets]
  let assetChanges = 0
  for (const entry of client.tree.entries.filter(e => e.kind === 'file' && e.path.startsWith('assets/'))) {
    const epoch = assetCacheEpoch(pkg.id,entry.path)
    const index = assets.findIndex(a => a.path === entry.path)
    if (index >= 0 && client.baseline.get(entry.path) === entry.version) continue
    if (index >= 0) {
      const local = await getAssetBlob(pkg.id, entry.path)
      if (local) { const hash = await sha256Hex(await local.arrayBuffer()); if (hash !== client.baseline.get(entry.path)) continue }
    }
    const blob = await client.read(entry.path, false, entry.version)
    if(!await cacheRemoteAsset(pkg.id,entry.path,blob,epoch))continue
    client.baseline.set(entry.path,entry.version)
    client.originals.set(entry.path,{version:entry.version,data:blob})
    client.assetEpochs.set(entry.path, assetCacheEpoch(pkg.id, entry.path))
    assetChanges++
    const asset = { id: assets[index]?.id ?? `asset:${entry.path}`, path: entry.path, mime: guessMime(entry.path), size: entry.size, updatedAt: Date.now() }
    if (index >= 0) assets[index] = asset; else assets.push(asset)
  }
  for(const asset of [...assets]) {
    if(client.entry(asset.path) || !client.baseline.has(asset.path))continue
    const epoch=assetCacheEpoch(pkg.id,asset.path)
    const blob=await getAssetBlob(pkg.id,asset.path)
    if(blob){const hash=await sha256Hex(await blob.arrayBuffer());if(hash!==client.baseline.get(asset.path))continue}
    if(assetCacheEpoch(pkg.id,asset.path)!==epoch)continue
    assets=assets.filter(a=>a.path!==asset.path);client.baseline.delete(asset.path);assetChanges++
  }
  const organizationEntry = client.entry(EXPLORER_ORGANIZATION_PATH)
  const organizationVersion = organizationEntry?.version ?? null
  const organizationBaseline = client.baseline.get(EXPLORER_ORGANIZATION_PATH) ?? null
  const organizationBefore = serializeOrganization(pkg.explorer ?? emptyOrganization())
  const organizationDirty = client.transactions.hasDraft(EXPLORER_ORGANIZATION_PATH)
  // Stage the exact snapshot without advancing the base of a draft created during this read.
  const organizationRaw = organizationDirty || !organizationEntry ? null
    : await (await client.readSnapshot(EXPLORER_ORGANIZATION_PATH, false, organizationEntry.version)).file.text()
  const explorer = organizationDirty ? undefined : parseOrganization(organizationRaw)
  const live = getProjectSession()
  if (live.binding?.handle.client !== client) return current
  const latest = live.workspace
  const latestPkg = latest.packages.find(p => p.id === pkg.id)
  if (!latestPkg) return latest
  const adoptOrganization = explorer !== undefined && !client.transactions.hasDraft(EXPLORER_ORGANIZATION_PATH)
    && serializeOrganization(latestPkg.explorer ?? emptyOrganization()) === organizationBefore
    && (client.entry(EXPLORER_ORGANIZATION_PATH)?.version ?? null) === organizationVersion
    && (client.baseline.get(EXPLORER_ORGANIZATION_PATH) ?? null) === organizationBaseline
  const mergedExplorer = adoptOrganization ? explorer : latestPkg.explorer
  if (adoptOrganization) {
    // The projection, original bytes and CAS version are accepted together, after all awaits.
    if (organizationVersion !== null && organizationRaw !== null) {
      client.texts.set(EXPLORER_ORGANIZATION_PATH, organizationRaw)
      client.baseline.set(EXPLORER_ORGANIZATION_PATH, organizationVersion)
      client.originals.set(EXPLORER_ORGANIZATION_PATH, { version: organizationVersion, data: organizationRaw })
    } else {
      client.texts.delete(EXPLORER_ORGANIZATION_PATH)
      client.baseline.delete(EXPLORER_ORGANIZATION_PATH)
      client.originals.delete(EXPLORER_ORGANIZATION_PATH)
    }
  }
  const merged = [...latestPkg.scripts]
  for (const stage of staged) {
    const i = merged.findIndex(s => sourcePathOf(s) === stage.path)
    const before = pkg.scripts.find(s => sourcePathOf(s) === stage.path)
    if (merged[i] && merged[i].content !== before?.content) continue
    const next = kept.find(s => sourcePathOf(s) === stage.path)!
    if (i >= 0) merged[i] = next; else merged.push(next)
    client.texts.set(stage.path,stage.content); client.baseline.set(stage.path,stage.version);client.originals.set(stage.path,{version:stage.version,data:stage.content})
  }
  for(const before of pkg.scripts)if(!kept.some(s=>s.id===before.id) && merged.find(s=>s.id===before.id)?.content===before.content){client.baseline.delete(sourcePathOf(before));client.texts.delete(sourcePathOf(before))}
  for(const draft of kept.filter(source=>source.detached)){
    const index=merged.findIndex(source=>source.id===draft.id)
    if(index>=0)merged[index]={...merged[index],detached:true}
  }
  const result = merged.filter(s => kept.some(k => k.id === s.id) || !pkg.scripts.some(p => p.id === s.id && p.content === s.content))
  if (staged.length || assetChanges || result.length !== pkg.scripts.length) client.remoteEpoch++
  const packages = latest.packages.map(p => p.id === pkg.id ? { ...p, explorer:mergedExplorer, scripts: result, assets: latestPkg.assets === pkg.assets ? assets : latestPkg.assets } : p)
  const activeScriptId = latest.activeScriptId === null
    ? null
    : result.some(s => s.id === latest.activeScriptId) ? latest.activeScriptId : result[0]?.id ?? null
  return { ...latest, packages, activeScriptId }
}
export async function openProjectFromPicker(): Promise<LoadProjectResult> { return loadServiceProject(await pickProjectDirectory()) }
export async function createProjectFromPicker(): Promise<LoadProjectResult> { return loadServiceProject(await pickProjectDirectory('create')) }

/** Save only changed, previously read resources. Omission from a client snapshot never deletes a file. */
export async function saveProjectToDirectory(binding: BoundProject, workspace: Workspace): Promise<BoundProject> {
  const client = binding.handle.client
  // A blocked editor gesture is not a failed submission. Check before creating
  // an outbox entry; perform checks again after lease acquisition for races.
  if (!client.writable) throw new Error(client.online ? '当前主体只有读取权限，草稿已保留' : '服务已断开，草稿保留在本窗口')
  await client.flushProgressEdits()
  await client.assertEditingIntent(client.transactions.getSnapshot().pendingPaths.map(path => ({ op: 'write', path })))
  let savedName = binding.manifest.name
  await client.transactions.submit('保存工程修改', async () => {
    // Preparation can update the workspace asynchronously. Read it AFTER the barrier,
    // rather than using the snapshot that the Save button captured before IndexedDB.
    const live = getProjectSession()
    const current = live.binding?.handle.client === client ? live.workspace : workspace
    const pkg = current.packages.find(p => p.id === binding.manifest.id)
    savedName = pkg?.name ?? binding.manifest.name
    return collectProjectChanges(binding,current)
  }, true)
  return { ...binding, manifest: { ...binding.manifest, name: savedName } }
}
export async function collectProjectChanges(binding: BoundProject, current: Workspace): Promise<import('./serviceClient').FileEdit[]> {
  const client = binding.handle.client
    const pkg = current.packages.find(p => p.id === binding.manifest.id)
    if (!pkg) throw new Error('没有可保存的工程')
    const edits: import('./serviceClient').FileEdit[] = []
    if(pkg.explorer){
      const raw=serializeOrganization(pkg.explorer)
      if(raw!==serializeOrganization(parseOrganization(client.texts.get(EXPLORER_ORGANIZATION_PATH)??null)))edits.push({op:'write',path:EXPLORER_ORGANIZATION_PATH,data:raw})
    }
    if (pkg.name !== binding.manifest.name) edits.push({ op: 'write', path: PROJECT_FILE, data: serializeManifest({ ...binding.manifest, name: pkg.name }) })
    for (const source of pkg.scripts) {
      if(source.detached)continue
      const path = sourcePathOf(source)
      if (client.texts.get(path) !== source.content) {
        if (path.toLowerCase().endsWith('.bossbar')) {
          try {
            parseBossbar(source.content)
          } catch (error) {
            throw new Error(`${source.name} 无法保存：${error instanceof Error ? error.message : String(error)}`)
          }
        }
        edits.push({ op: 'write', path, data: source.content })
      }
    }
    // Asset content comparison avoids replacing another client's unchanged binary resources.
    for (const asset of pkg.assets) {
      const epoch = assetCacheEpoch(pkg.id, asset.path)
      const blob = await getAssetBlob(pkg.id, asset.path)
      if (!blob) throw new Error(`资产缓存缺失，未提交：${asset.path}`)
      const bytes = await blob.arrayBuffer()
      const hash = await sha256Hex(bytes)
      if (hash !== client.baseline.get(asset.path)) edits.push({ op: 'write', path: asset.path, data: blob, cacheEpoch: epoch })
      else if (assetCacheEpoch(pkg.id, asset.path) === epoch) client.assetEpochs.set(asset.path, epoch)
    }
    return edits
}
export async function removeSourceFromDisk(handle: ProjectDirectory, sourceName: string, srcKind?: string | null): Promise<void> {
  await handle.client.sourceCommand(sourceRelativePath(sourceName, srcKind), null)
}

/**
 * 服务端是否见过这条路径。
 * entry 是当前树里的文件；baseline 是本窗口曾经从服务端拿到过版本的路径。
 * 两者都没有，说明这是本窗口刚创建、还没保存过的新文件。
 */
export function sourcePathKnownToServer(client: ProjectClient, path: string): boolean {
  return Boolean(client.entry(path)) || client.baseline.has(path)
}

export async function renameSourceOnDisk(handle: ProjectDirectory, oldName: string, newName: string, content: string, _assetMoves: Array<{fromPath: string; toPath: string}> = [], oldSrcKind?: string | null, newSrcKind?: string | null): Promise<void> {
  const oldPath = sourceRelativePath(oldName, oldSrcKind)
  // 服务端从未见过的新文件不要发 sourceCommand。下一轮保存会按最终路径 write。
  if (!sourcePathKnownToServer(handle.client, oldPath)) return
  await handle.client.sourceCommand(oldPath, sourceRelativePath(newName, newSrcKind ?? oldSrcKind), content)
}

/** 供 UI 展示：允许的脚本后缀 */
export const PROJECT_SCRIPT_EXTENSIONS = ALLOWED_EXTENSIONS
