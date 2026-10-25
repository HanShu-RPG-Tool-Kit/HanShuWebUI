/** Window-local recovery. Authoritative versions stay attached to drafts across reconnects. */
import type { Workspace, SourceFile } from '../workspace'
import { sourcePathOf } from '../workspace'
import { getProjectClient, type ProjectClient } from './serviceClient'
import { putAssetBlob } from '../assets/idb'
import { registerAsset } from '../workspace'
import type { FileEdit } from './serviceClient'
type Draft = { source: SourceFile; version: string | null; original: string | null }
type Recovery = { sources: Draft[]; staged: FileEdit[] }
function key(c: ProjectClient) { return `hanshu.projectDraft:${c.snapshot.projectId}:${c.snapshot.session.subjectId}` }
export function rememberProjectDraft(workspace: Workspace): void {
  const client=getProjectClient(); if (!client) return
  const drafts: Draft[]=[]
  for (const p of workspace.packages) for(const source of p.scripts) {
    const path=sourcePathOf(source)
    if(source.detached||source.content!==client.texts.get(path)) drafts.push({source,version:client.baseline.get(path)??null,original:client.texts.get(path)??null})
  }
  const recovery: Recovery = { sources: drafts, staged: client.transactions.stagedWrites().filter(e => typeof e.data === 'string').map(e=>({...e,baseData:typeof e.baseData === 'string'?e.baseData:undefined})) }
  try { sessionStorage.setItem(key(client),JSON.stringify(recovery)) } catch { /* Existing visible editor remains the primary draft; save/download before closing. */ }
}
export async function restoreProjectDraft(client: ProjectClient, workspace: Workspace): Promise<Workspace> {
  let recovery: Recovery
  try { recovery=JSON.parse(sessionStorage.getItem(key(client))??'null') } catch { return workspace }
  if (!recovery || !Array.isArray(recovery.sources) || !workspace.packages[0]) return workspace
  const drafts = recovery.sources
  const scripts=[...workspace.packages[0].scripts]
  for(const d of drafts) {
    if(!d?.source?.name||typeof d.source.content!=='string')continue
    const path=sourcePathOf(d.source);const i=scripts.findIndex(s=>sourcePathOf(s)===path)
    const source={...d.source,id:scripts[i]?.id??d.source.id}
    if(i<0)scripts.push(source);else scripts[i]=source
    if(d.version)client.baseline.set(path,d.version);else client.baseline.delete(path)
    if(d.original!==null)client.texts.set(path,d.original);else client.texts.delete(path)
    if(d.version && d.original!==null) client.originals.set(path,{version:d.version,data:d.original})
  }
  let restored = {...workspace,packages:[{...workspace.packages[0],scripts}]}
  for (const edit of recovery.staged ?? []) {
    if (edit.op !== 'write' || typeof edit.data !== 'string' || !edit.path.startsWith('assets/')) continue
    const blob = new Blob([edit.data], { type: 'application/json' })
    // Restore old versions even though a fresh file tree was just loaded.
    if (edit.version) client.baseline.set(edit.path, edit.version); else client.baseline.delete(edit.path)
    client.transactions.stageWrite(edit)
    await putAssetBlob(restored.packages[0].id, edit.path, blob)
    restored = registerAsset(restored, restored.packages[0].id, edit.path, blob.type, blob.size)?.workspace ?? restored
  }
  return restored
}
