import {EXPLORER_ORGANIZATION_PATH,parseOrganization} from './explorerOrganization'
import { assetCacheEpoch, cacheRemoteAsset, deleteCachedAsset, getAssetBlob } from '../assets/idb'
import { isVoiceRefPath, parseVoiceRefContent } from '../i18n/voiceMap'
import { createScript, registerAsset, removeAssetMeta, sourcePathOf, srcKindFromDiskPath, type Workspace } from '../workspace'
import { setBoundProject } from './bindingBus'
import { sha256Hex } from './crypto'
import { getProjectSession, setProjectSession } from './projectSession'
import { getProjectClient, type FileEdit, type ProjectClient } from './serviceClient'

const runtime = Date.now() + Math.random()
const RUNTIME = '@runtime'
const contains = (parent: string, path: string) => parent === path || path.startsWith(`${parent}/`)
const sourcePath = (path: string) => path !== EXPLORER_ORGANIZATION_PATH && (path.startsWith('src/') || path.startsWith('meta/'))
const touched = (edit: FileEdit, path: string) => contains(edit.path, path) || (!!edit.destination && contains(edit.destination, path))

/** Freeze the projection we started from; replay must not discard later local edits. */
export function captureWorkspaceEdit(workspace: Workspace, edit: FileEdit, epoch: (packageId: string, path: string) => number = assetCacheEpoch): FileEdit {
  const localContents = edit.localContents ?? Object.fromEntries(workspace.packages.flatMap(pkg => [
    ...pkg.scripts.filter(file => touched(edit, sourcePathOf(file))).map(file => [sourcePathOf(file), file.content]),
    ...(edit.path === 'project.json' ? [['project.json', pkg.name]] : []),
  ]))
  const localEpochs = edit.localEpochs ?? Object.fromEntries([
    [RUNTIME, runtime],
    ...workspace.packages.flatMap(pkg => [
      ...pkg.assets.filter(asset => touched(edit, asset.path)).map(asset => [asset.path, epoch(pkg.id, asset.path)]),
      ...[edit.path, edit.destination].filter((path): path is string => !!path?.startsWith('assets/')).map(path => [path, epoch(pkg.id, path)]),
    ]),
  ])
  return { ...edit, localContents, localEpochs }
}

/** Rebuild only the acknowledged projection; edited-after-submit sources stay as drafts. */
export function reconcileSourceEdits(workspace: Workspace, edits: FileEdit[]): Workspace {
  const packages = workspace.packages.map(pkg => {
    let scripts = [...pkg.scripts]
    let name = pkg.name
    let explorer=pkg.explorer
    for (const edit of edits) {
      const captured = edit.localContents ?? {}
      if(edit.path===EXPLORER_ORGANIZATION_PATH){
        if(edit.op==='write'&&typeof edit.data==='string')explorer=parseOrganization(edit.data)
        if(edit.op==='remove')explorer=parseOrganization(null)
      }
      if (edit.path === 'project.json' && edit.op === 'write' && typeof edit.data === 'string' && name === captured['project.json']) {
        try { const manifest = JSON.parse(edit.data); if (typeof manifest.name === 'string') name = manifest.name } catch { /* A failed parse never replaces an existing name. */ }
      }
      if (edit.op === 'remove' || edit.op === 'move') {
        for (const file of [...scripts]) {
          const path = sourcePathOf(file)
          if (!contains(edit.path, path) || captured[path] !== file.content) continue
          const destination = edit.op === 'move' && edit.destination ? edit.destination + path.slice(edit.path.length) : null
          if (destination && scripts.some(other => other !== file && sourcePathOf(other) === destination)) continue
          scripts = scripts.filter(other => other !== file)
          if (destination && sourcePath(destination)) scripts.push({ ...file, name: destination.split('/').at(-1)!, srcKind: srcKindFromDiskPath(destination), updatedAt: Date.now() })
        }
      }
      if (edit.op === 'write' && sourcePath(edit.path) && typeof edit.data === 'string') {
        const index = scripts.findIndex(file => sourcePathOf(file) === edit.path)
        const current = scripts[index]
        // A move earlier in this batch can create the destination from the frozen
        // source; its following write belongs to that same operation.
        const movedFrom = edits.find(other => other.op === 'move' && other.destination === edit.path)
        const before = captured[edit.path] ?? (movedFrom ? movedFrom.localContents?.[movedFrom.path] : undefined)
        if (current ? current.content !== before : Object.hasOwn(captured, edit.path)) continue
        const file = { ...createScript(edit.path.split('/').at(-1)!, edit.data, srcKindFromDiskPath(edit.path)), id: current?.id ?? `source:${edit.path}` }
        if (index < 0) scripts.push(file); else scripts[index] = file
      }
    }
    return { ...pkg, name, explorer, scripts }
  })
  const activeScriptId = packages.some(pkg => pkg.scripts.some(file => file.id === workspace.activeScriptId))
    ? workspace.activeScriptId : packages.flatMap(pkg => pkg.scripts)[0]?.id ?? null
  return { ...workspace, packages, activeScriptId }
}

function dataBlob(data: FileEdit['data'], mime = 'application/octet-stream'): Blob | null {
  return data === undefined ? null : data instanceof Blob ? data : new Blob([data as BlobPart], { type: mime })
}
async function equalBlob(a: Blob | null, b: Blob | null): Promise<boolean> {
  if (!a || !b || a.size !== b.size) return a === b
  return await sha256Hex(await a.arrayBuffer()) === await sha256Hex(await b.arrayBuffer())
}
const mimeOf = (path: string) => /\.(lang|ref)$/i.test(path) ? 'text/plain' : /\.ogg$/i.test(path) ? 'audio/ogg' : /\.png$/i.test(path) ? 'image/png' : 'application/octet-stream'

/** Attach after the project's initial cache/draft restore and before restoring its outbox. */
export function attachReconciliation(client: ProjectClient) {
  client.onCapture = edit => captureWorkspaceEdit(getProjectSession().workspace, edit)
  client.onCommitted = async (edits, replayed) => {
    if(getProjectClient()!==client)return
    const metadata=edits.find(edit=>edit.path===EXPLORER_ORGANIZATION_PATH)
    if(metadata){
      const live=getProjectSession()
      const explorer=metadata.op==='write'&&typeof metadata.data==='string'?parseOrganization(metadata.data):metadata.op==='remove'?parseOrganization(null):undefined
      if(explorer)setProjectSession({workspace:{...live.workspace,packages:live.workspace.packages.map(pkg=>({...pkg,explorer}))}})
    }
    if (!replayed) return
    const stillCurrent = () => getProjectClient() === client && getProjectSession().binding?.handle.client === client
    for (const edit of edits) {
      const pkg = getProjectSession().workspace.packages.find(item => item.id === client.assetPackageId)
      if (!pkg) continue
      const paths = edit.op === 'write' ? [edit.path] : [...new Set([
        ...pkg.assets.map(asset => asset.path), ...Object.keys(edit.localEpochs ?? {}),
      ])].filter(path => contains(edit.path, path))
      for (const path of paths.filter(path => path.startsWith('assets/'))) {
        const epoch = assetCacheEpoch(pkg.id, path)
        const existing = await getAssetBlob(pkg.id, path)
        if (!stillCurrent()) return
        const expected = edit.localEpochs?.[path]
        const sameRuntime = edit.localEpochs?.[RUNTIME] === runtime
        const unchanged = sameRuntime && expected !== undefined && epoch === expected
        const base = path === edit.path ? dataBlob(edit.baseData) : null
        const proposed = edit.op === 'write' ? dataBlob(edit.data, mimeOf(path)) : null
        // Epoch counters are process-local. After reload, compare bytes with the
        // captured base/proposed value instead of trusting coincidental counters.
        const safe = unchanged || (proposed && await equalBlob(existing, proposed)) || (!sameRuntime && await equalBlob(existing, base))
        if (!stillCurrent()) return
        if (!safe || assetCacheEpoch(pkg.id, path) !== epoch) continue
        if (edit.op === 'write' && proposed) {
          if (!await cacheRemoteAsset(pkg.id, path, proposed, epoch)) continue
          if (!stillCurrent()) return
          const nextEpoch = assetCacheEpoch(pkg.id, path)
          const refTarget = isVoiceRefPath(path) ? parseVoiceRefContent(await proposed.text()) : undefined
          if (!stillCurrent()) return
          if (assetCacheEpoch(pkg.id, path) !== nextEpoch) continue
          client.assetEpochs.set(path, nextEpoch)
          if (/\.lang$/i.test(path)) client.texts.set(path, await proposed.text())
          if (!stillCurrent()) return
          const result = registerAsset(getProjectSession().workspace, pkg.id, path, mimeOf(path), proposed.size, refTarget)
          if (result) setProjectSession({ workspace: result.workspace })
        } else if (edit.op === 'remove') {
          if (!await deleteCachedAsset(pkg.id, path, epoch)) continue
          if (!stillCurrent()) return
          const live = getProjectSession().workspace
          const asset = live.packages.find(item => item.id === pkg.id)?.assets.find(item => item.path === path)
          if (asset) setProjectSession({ workspace: removeAssetMeta(live, asset.id) })
          client.assetEpochs.delete(path)
        } else if (edit.op === 'move' && edit.destination && existing) {
          const destination = edit.destination + path.slice(edit.path.length)
          const destinationEpoch = assetCacheEpoch(pkg.id, destination)
          const destinationAsset = getProjectSession().workspace.packages.find(item => item.id === pkg.id)?.assets.find(item => item.path === destination)
          // Never overwrite an independently created destination draft.
          if (destinationAsset || (sameRuntime && destinationEpoch !== (edit.localEpochs?.[destination] ?? 0))) continue
          if (!await cacheRemoteAsset(pkg.id, destination, existing, destinationEpoch)) continue
          if (!stillCurrent()) return
          if (!await deleteCachedAsset(pkg.id, path, epoch)) continue
          if (!stillCurrent()) return
          let live = getProjectSession().workspace
          const asset = live.packages.find(item => item.id === pkg.id)?.assets.find(item => item.path === path)
          if (asset) live = removeAssetMeta(live, asset.id)
          const result = registerAsset(live, pkg.id, destination, mimeOf(destination), existing.size, asset?.refTarget)
          client.assetEpochs.delete(path)
          client.assetEpochs.set(destination, assetCacheEpoch(pkg.id, destination))
          if (result) setProjectSession({ workspace: result.workspace })
        }
      }
    }
    if (!stillCurrent()) return
    const sourceEdits = await Promise.all(edits.map(async edit => edit.op === 'write' && sourcePath(edit.path) && edit.data !== undefined && typeof edit.data !== 'string'
      ? { ...edit, data: await dataBlob(edit.data)!.text() } : edit))
    if (!stillCurrent()) return
    client.remoteEpoch++
    setProjectSession({ workspace: reconcileSourceEdits(getProjectSession().workspace, sourceEdits) })
    // Reload may already have read a newer server version than this old receipt.
    // Its body must not become a spurious local draft when perform installs the
    // receipt baseline. Only exact content equality proves it is clean.
    for (const pkg of getProjectSession().workspace.packages) {
      for (const file of pkg.scripts) {
        const path = sourcePathOf(file)
        if (!edits.some(edit => touched(edit, path))) continue
        const version = client.entry(path)?.version
        if (!version || await sha256Hex(new TextEncoder().encode(file.content)) !== version) continue
        if (!stillCurrent()) return
        const current = getProjectSession().workspace.packages.find(item => item.id === pkg.id)?.scripts.find(item => item.id === file.id)
        if (current?.content !== file.content || client.entry(path)?.version !== version) continue
        client.baseline.set(path, version); client.texts.set(path, file.content)
        client.originals.set(path, { version, data: file.content })
      }
      for (const asset of pkg.assets) {
        if (!edits.some(edit => touched(edit, asset.path))) continue
        const epoch = assetCacheEpoch(pkg.id, asset.path)
        const blob = await getAssetBlob(pkg.id, asset.path)
        if (!stillCurrent()) return
        const version = client.entry(asset.path)?.version
        if (!blob || !version || await sha256Hex(await blob.arrayBuffer()) !== version) continue
        if (!stillCurrent()) return
        if (assetCacheEpoch(pkg.id, asset.path) !== epoch || client.entry(asset.path)?.version !== version) continue
        client.baseline.set(asset.path, version); client.assetEpochs.set(asset.path, epoch)
        client.originals.set(asset.path, { version, data: blob })
      }
    }
    if (!stillCurrent()) return
    setProjectSession({})
    if (edits.some(edit => edit.path === '.hanshu/skinmanager/library.json')) {
      const binding = getProjectSession().binding
      if (binding) { const next = { ...binding }; setProjectSession({ binding: next }); setBoundProject(next) }
    }
  }
}
