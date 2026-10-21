/** Window-local recovery. Authoritative versions stay attached to drafts across reconnects. */
import type { Workspace, SourceFile } from '../workspace'
import { sourcePathOf } from '../workspace'
import { getProjectClient, type ProjectClient } from './serviceClient'
type Draft = { source: SourceFile; version: string | null; original: string | null }
function key(c: ProjectClient) { return `hanshu.projectDraft:${c.connection.url}:${c.snapshot.projectId}:${c.snapshot.session.subjectId}` }
export function rememberProjectDraft(workspace: Workspace): void {
  const client=getProjectClient(); if (!client) return
  const drafts: Draft[]=[]
  for (const p of workspace.packages) for(const source of p.scripts) {
    const path=sourcePathOf(source)
    if(source.content!==client.texts.get(path)) drafts.push({source,version:client.baseline.get(path)??null,original:client.texts.get(path)??null})
  }
  try { sessionStorage.setItem(key(client),JSON.stringify(drafts)) } catch { /* Existing visible editor remains the primary draft; save/download before closing. */ }
}
export function restoreProjectDraft(client: ProjectClient, workspace: Workspace): Workspace {
  let drafts: Draft[]
  try { drafts=JSON.parse(sessionStorage.getItem(key(client))??'[]') } catch { return workspace }
  if(!Array.isArray(drafts)||!drafts.length||!workspace.packages[0])return workspace
  const scripts=[...workspace.packages[0].scripts]
  for(const d of drafts) {
    if(!d?.source?.name||typeof d.source.content!=='string')continue
    const path=sourcePathOf(d.source);const i=scripts.findIndex(s=>sourcePathOf(s)===path)
    const source={...d.source,id:scripts[i]?.id??d.source.id}
    if(i<0)scripts.push(source);else scripts[i]=source
    if(d.version)client.baseline.set(path,d.version);else client.baseline.delete(path)
    if(d.original!==null)client.texts.set(path,d.original);else client.texts.delete(path)
  }
  return {...workspace,packages:[{...workspace.packages[0],scripts}]}
}
