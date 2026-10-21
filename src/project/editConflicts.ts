import { request } from '../collab/protocol'
import type { ProjectFileTree } from '../collab/generated'
import type { FileEdit, ProjectClient } from './serviceClient'

export type ConflictChoice = 'server' | 'local' | 'manual'
export type ConflictVersion = { path: string; version: string | null; kind: 'file' | 'directory' | null; data?: Blob; text?: string }
export type ConflictRow = { edit: FileEdit; baseText?: string; localText?: string; remote: ConflictVersion; destination?: ConflictVersion; choice: ConflictChoice; merged: string; group: number }
export type ConflictInspection = { id: number; rows: ConflictRow[]; revision: number }
const textPath = /\.(hs|py|md|json|lang|ref|voice|char|item|kit|progress|hflow|nav|tts|ttsservice|txt)$/i
async function textOf(path: string, data: FileEdit['data']): Promise<string | undefined> {
  if (typeof data === 'string') return data
  if (data === undefined || !textPath.test(path)) return undefined
  return data instanceof Blob ? data.text() : new TextDecoder().decode(data)
}
/** Fetch a version-pinned view without rebasing any existing draft. A concurrent
 * change during these reads makes the inspection fail instead of mixing versions. */
export async function inspectConflict(client: ProjectClient, id: number): Promise<ConflictInspection> {
  const edits = client.transactions.submission(id)
  if (!edits.length) throw new Error('原提交还未准备完成，请先重试准备或导出草稿')
  const tree = await request<ProjectFileTree>(client.connection, '/api/files')
  const versions = new Map<string, ConflictVersion>()
  for (const path of [...new Set(edits.flatMap(e => e.destination ? [e.path, e.destination] : [e.path]))]) {
    const entry = tree.entries.find(e => e.path === path)
    const data = entry?.kind === 'file' ? await client.read(path, false, entry.version) : undefined
    versions.set(path, {path, version:entry?.version ?? null, kind:entry?.kind === 'directory' ? 'directory' : entry ? 'file' : null, data, text:await textOf(path,data)})
  }
  const rows: ConflictRow[] = []
  for (const edit of edits) rows.push({edit, baseText:await textOf(edit.path,edit.baseData), localText:await textOf(edit.path,edit.data), remote:versions.get(edit.path)!, destination:edit.destination ? versions.get(edit.destination) : undefined, choice:'local', merged:await textOf(edit.path,edit.data) ?? '', group:rows.length})
  // A move and the following destination write are one decision. Otherwise a
  // per-row server/local mix could accidentally resurrect the old source.
  let changed = true
  while (changed) {
    changed = false
    for (const a of rows) for (const b of rows) {
      const pa = [a.edit.path, a.edit.destination].filter(Boolean) as string[]
      const pb = [b.edit.path, b.edit.destination].filter(Boolean) as string[]
      if (a.group !== b.group && pa.some(p => pb.some(q => p === q || p.startsWith(`${q}/`) || q.startsWith(`${p}/`)))) {
        const group = Math.min(a.group,b.group); const previous = Math.max(a.group,b.group)
        for (const row of rows) if (row.group === previous) row.group = group
        changed = true
      }
    }
  }
  return {id,rows,revision:client.transactions.getRevision()}
}
export function conflictEdits(inspection: ConflictInspection): FileEdit[] {
  const edits: FileEdit[] = []
  const adopted = new Set<string>()
  for (const row of inspection.rows) {
    // Capture the current local view for recovery; the submitted original stays
    // available in the dialog until the user explicitly submits this resolution.
    const edit = {...row.edit}
    if (row.choice === 'server') {
      for (const remote of [row.remote,row.destination].filter(Boolean) as ConflictVersion[]) {
        if (adopted.has(remote.path)) continue
        adopted.add(remote.path)
        edits.push({...edit,op:remote.kind === 'directory' ? 'mkdir' : remote.kind ? 'write' : 'remove',path:remote.path,destination:undefined,destinationVersion:null,data:remote.text ?? remote.data,version:remote.version,adopt:true})
      }
    } else {
      if (row.choice === 'manual' && (edit.op !== 'write' || row.localText === undefined)) throw new Error('只有文本写入支持手动合并')
      edits.push({...edit,adopt:false,version:row.remote.version,destinationVersion:row.destination?.version ?? null,baseData:row.remote.data,data:row.choice === 'manual' ? row.merged : edit.data})
    }
  }
  return edits
}
