import { ServiceError } from '../collab/protocol'
import { cacheRemoteAsset, deleteCachedAsset, assetCacheEpoch, getAssetBlob, putAssetBlob } from '../assets/idb'
import { sourcePathOf } from '../workspace'
import { getProgressEditor } from '../workspaces/gameplay/progressEditRegistry'
import { getProjectClient, type FileEdit, type ProjectClient } from './serviceClient'
import { collectProjectChanges, refreshServiceProject, refreshProjectManifest } from './projectFs'
import { getProjectSession, setProjectSession } from './projectSession'
import { setBoundProject } from './bindingBus'
import { rememberProjectDraft } from './drafts'
import { EXPLORER_ORGANIZATION_PATH, parseOrganization } from './explorerOrganization'

import { partitionSyncEdits } from './syncPolicy'
const touches = (edit: FileEdit) => [edit.path, ...(edit.destination ? [edit.destination] : []), ...(edit.affectedPaths ?? [])]

export async function synchronizeProject(client: ProjectClient): Promise<string> {
  if (!client.writable) throw new Error('请先恢复连接并确认编辑权限；草稿未改变')
  const current = () => { const live=getProjectSession(); if(getProjectClient()!==client || live.binding?.handle.client!==client)throw new Error('工程已切换，同步已停止');return live }
  const errors: string[] = []
  await client.transactions.idle(); current()
  // Unknown outcomes are never discarded or replayed by a new transaction ID.
  for (const record of client.transactions.getSnapshot().transactions.filter(t=>t.phase==='uncertain')) {
    try { await client.transactions.confirm(record.id) } catch { /* Check the resulting authoritative phase below. */ }
    if (client.transactions.getSnapshot().transactions.some(t=>t.id===record.id&&t.phase==='uncertain')) throw new Error('仍有结果待确认的提交。原修改已保留，请恢复连接后再同步。')
  }
  current()
  for (const record of client.transactions.getSnapshot().transactions.filter(t=>['failed','conflict'].includes(t.phase))) {
    for (const edit of client.transactions.submission(record.id).filter(e=>e.op==='progress-command')) {
      if (client.syncParticipants.has(`progress:${edit.path}`)) continue
      const file=current().workspace.packages.flatMap(p=>p.scripts).find(s=>sourcePathOf(s)===edit.path)
      if (!file) { errors.push(`进度 ${edit.path} 尚未加载，原操作保留`); continue }
      const editor=getProgressEditor(client,edit.path,file.name,file.content,'zh_cn');await editor.start()
    }
  }
  for (const synchronize of [...client.syncParticipants.values()]) { try { await synchronize() } catch(e) { errors.push(String(e)) } current() }
  try {const {synchronizeSkinDrafts}=await import('../skin/local/synchronizeDrafts');await synchronizeSkinDrafts(client)}catch(e){errors.push(String(e))}current()
  await client.transactions.idle(); await client.refresh(); current()

  // Frozen failed business commands retain their atomic scope. A stale command
  // cannot be split into arbitrary file writes; lock-only failures can retry.
  const records=client.transactions.getSnapshot().transactions.filter(t=>['failed','conflict'].includes(t.phase))
  const ordinary: FileEdit[]=[]
  for(const record of records) {
    const edits=client.transactions.submission(record.id)
    if(edits.some(e=>e.op==='progress-command'))continue
    if(edits.some(e=>['skin-entry-patch','skin-library-command','history-restore'].includes(e.op))) {
      if(record.phase==='conflict'&&record.code!=='locked')await client.transactions.forget(record.id)
      else {try{await client.transactions.retry(record.id)}catch(e){errors.push(String(e))}}
      continue
    }
    ordinary.push(...edits)
  }
  const live=current(), binding=live.binding!
  const collected=(await collectProjectChanges(binding,live.workspace)).filter(e=>!client.syncParticipants.has(`progress:${e.path}`));current()
  const staged=client.transactions.stagedWrites()
  const latest=new Map<string,FileEdit>()
  for(const edit of [...ordinary,...collected,...staged]) {
    const key=`${edit.op}:${edit.path}:${edit.destination??''}`
    // Newer draft contents cannot erase a failed operation's atomic recovery scope.
    const affectedPaths=[...new Set([...(latest.get(key)?.affectedPaths??[]),...(edit.affectedPaths??[])])]
    latest.set(key,affectedPaths.length?{...edit,affectedPaths}:edit)
  }
  const edits=client.captureEdits([...latest.values()])
  const draftRevision=client.transactions.getRevision()
  if(edits.length)await client.planOperations(edits.map(e=>({op:e.op as 'write'|'move'|'mkdir'|'remove',path:e.path,destination:e.destination??null})))
  await client.refresh(); current()
  const split=partitionSyncEdits(edits,client.tree,path=>client.editingAuthority(path)??path)
  const discarded=[...new Set(split.conflicting.flatMap(group=>group.flatMap(touches)))]
  // Read everything to be adopted before removing any corresponding recovery data.
  const remote=new Map<string,{version:string|null;blob:File|null}>()
  const revision=client.tree.revision
  for(const path of discarded) {
    const entry=client.entry(path)
    const blob=entry?.kind==='file'?(await client.readSnapshot(path,false,entry.version)).file:null
    remote.set(path,{version:entry?.version??null,blob})
  }
  await client.refresh();current()
  if(client.tree.revision!==revision)throw new Error('同步检查期间工程又有修改；草稿仍保留，请再次同步')
  if(client.transactions.getRevision()!==draftRevision)throw new Error('检查期间本机草稿发生变化，尚未清理，请再次同步')
  const manifestBlob=remote.get('project.json')?.blob
  const manifestName=manifestBlob?JSON.parse(await manifestBlob.text()).name:undefined
  if(manifestBlob&&typeof manifestName!=='string')throw new Error('服务器工程清单无效，原修改保留')
  // Validate shared metadata before removing recovery requests. A missing file
  // adopts the empty organization, including when the local tree is still dirty.
  const organization=remote.get(EXPLORER_ORGANIZATION_PATH)
  const adoptedOrganization=organization?parseOrganization(organization.blob?await organization.blob.text():null):undefined
  const priorAssets=new Map<string,Blob|null>()
  const installedAssets=new Map<string,number>()
  try {
    for(const [path,value] of remote)if(path.startsWith('assets/')) {
      const epoch=assetCacheEpoch(client.assetPackageId,path)
      priorAssets.set(path,await getAssetBlob(client.assetPackageId,path))
      if(assetCacheEpoch(client.assetPackageId,path)!==epoch)throw new Error(`本机资源在同步期间改变：${path}`)
      const installed=value.blob?await cacheRemoteAsset(client.assetPackageId,path,value.blob,epoch):await deleteCachedAsset(client.assetPackageId,path,epoch)
      if(!installed)throw new Error(`本机资源在同步期间改变：${path}`)
      installedAssets.set(path,assetCacheEpoch(client.assetPackageId,path))
    }
    if(client.transactions.getRevision()!==draftRevision)throw new Error('检查期间本机草稿发生变化，尚未清理，请再次同步')
  } catch(error) {
    for(const [path,epoch] of installedAssets)if(assetCacheEpoch(client.assetPackageId,path)===epoch) {
      const blob=priorAssets.get(path)
      if(blob)await putAssetBlob(client.assetPackageId,path,blob)
      else await deleteCachedAsset(client.assetPackageId,path,epoch)
    }
    throw error
  }
  for(const record of records.filter(r=>!client.transactions.submission(r.id).some(e=>['progress-command','skin-entry-patch','skin-library-command','history-restore'].includes(e.op)))) await client.transactions.forget(record.id)
  const paths=[...remote.keys()]
  for(const [path,value] of remote) {
    if(value.version)client.baseline.set(path,value.version);else client.baseline.delete(path)
    if(value.blob) {client.originals.set(path,{version:value.version!,data:value.blob});if(/\.(hs|py|md|json|lang|ref|voice|char|item|kit|progress|hflow|nav|tts|ttsservice)$/i.test(path))client.texts.set(path,await value.blob.text())}
    else {client.originals.delete(path);client.texts.delete(path)}
    if(path.startsWith('assets/')) {
      client.assetEpochs.set(path,assetCacheEpoch(client.assetPackageId,path))
    }
  }
  const active=current()
  const workspace={...active.workspace,packages:active.workspace.packages.map(pkg=>({...pkg,scripts:pkg.scripts.flatMap(source=>{
    const path=sourcePathOf(source),adopted=remote.get(path)
    if(!adopted)return[source]
    return adopted.blob?[{...source,content:client.texts.get(path)??source.content}]:[]
  }),name:manifestName??pkg.name,
    ...(adoptedOrganization&&pkg.id===binding.manifest.id?{explorer:adoptedOrganization}:{}),
  }))}
  client.transactions.discardDraftPaths(paths)
  if(paths.length){client.discardEpoch++;for(const path of paths)client.discardVersions.set(path,client.discardEpoch)}
  client.remoteEpoch++
  setProjectSession({workspace})
  for(const group of split.safe) {
    try {await client.transactions.submit('同步可提交修改',()=>group);client.transactions.clearSubmittedDrafts(group)}catch(e){errors.push(String(e))}
    current()
  }
  const before=current();const refreshed=await refreshServiceProject(before.binding!,before.workspace);current()
  setProjectSession({workspace:refreshed});await refreshProjectManifest(client);current()
  const fresh={...getProjectSession().binding!};setProjectSession({binding:fresh});setBoundProject(fresh)
  rememberProjectDraft(getProjectSession().workspace)
  const unresolved=client.transactions.getSnapshot().transactions.filter(t=>['failed','conflict','uncertain'].includes(t.phase))
  if(errors.length||unresolved.length)throw new ServiceError('sync_incomplete',`已同步可完成的修改；仍有修改未完成，原请求与草稿保留。${errors[0]??''}`)
  return '已放弃冲突修改，提交其余可提交修改并同步服务器状态。'
}
