import { getSkinApi } from '../api'
import { entryDraftSession, recoverableEntryDrafts } from './entryDraft'
import { discardEntrySubmission } from './entrySubmission'
import type { ProjectClient } from '../../project/serviceClient'
import type { LibraryEntry } from '../contracts/types'
import { SKIN_INDEX_PATH } from './entrySubmission'
/** Also handles persisted entry drafts before their details view is opened. */
export async function synchronizeSkinDrafts(client: ProjectClient) {
  const scope=JSON.stringify([client.connection.url,client.snapshot.projectId,client.snapshot.session.subjectId])
  const recovered=recoverableEntryDrafts(scope)
  if(!recovered.length)return
  await client.refresh()
  const version=client.entry(SKIN_INDEX_PATH)?.version
  const index=version?JSON.parse(await(await client.readSnapshot(SKIN_INDEX_PATH,false,version)).file.text()):{entries:[]}
  if(!Array.isArray(index.entries))throw new Error('服务器皮肤索引无效，草稿保留')
  const api=await getSkinApi()
  for(const item of recovered) {
    const session=entryDraftSession(scope,item.entry)
    const latest=index.entries.find((entry:LibraryEntry)=>entry.entryId===item.entry.entryId) as LibraryEntry|undefined
    if(!latest){await discardEntrySubmission(client,item.entry.entryId);session.adoptRemote();continue}
    await discardEntrySubmission(client,latest.entryId)
    session.bind(body=>api.patchEntry(latest.entryId,body))
    await session.synchronize(latest)
  }
}
