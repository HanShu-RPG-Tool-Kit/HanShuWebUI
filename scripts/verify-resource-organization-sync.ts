import assert from 'node:assert/strict'
import { createProject, createSourceFile, emptyWorkspace, sourcePathOf, type Workspace } from '../src/workspace'
import { setBoundProject } from '../src/project/bindingBus'
import { collectProjectChanges, type BoundProject } from '../src/project/projectFs'
import {
  EXPLORER_ORGANIZATION_PATH, documentPlacements, emptyOrganization,
  parseOrganization, serializeOrganization, type ExplorerOrganization,
} from '../src/project/explorerOrganization'
import { getProjectSession, setProjectSession, subscribeProjectSession } from '../src/project/projectSession'
import { ProjectClient, setProjectClient, type FileEdit } from '../src/project/serviceClient'
import { synchronizeProject } from '../src/project/syncProject'

const path = EXPLORER_ORGANIZATION_PATH
const sourcePath = 'src/items/apple.item'
const organization = (name: string): ExplorerOrganization => ({
  version: 1,
  folders: [{ key: 'folder', name, package: 'items', parentId: null }],
  placements: { [sourcePath]: 'folder' },
})
const original = organization('Original')
const remote = organization('Remote')

/** Real session/transaction synchronization, with only the authoritative I/O replaced. */
async function fixture(remoteText: string | null, local = original) {
  const client = new ProjectClient({ url: 'http://organization-sync.invalid', token: '' }, {
    statusVersion: 1, serverTime: Date.now(), projectId: 'organization-sync', projectName: 'Sync test',
    revision: 1, filesRevision: 2, role: 'editor', members: [], resources: [], sessions: [], leases: [],
    session: { id: 'window-a', subjectId: 'author', clientName: 'Test', expiresAt: Date.now() + 60000,
      resourceId: null, activity: 'viewing', filePresence: null },
  })
  const source = createSourceFile('apple.item', '{}')
  const workspace: Workspace = {
    packages: [{ ...createProject('Sync test', [source]), id: 'pkg', explorer: structuredClone(local) }],
    activeScriptId: source.id, activeAssetId: null,
  }
  const binding: BoundProject = {
    handle: client.root(), folderName: 'Sync test', manifest: { version: 1, id: 'pkg', name: 'Sync test' },
  }
  client.tree = { revision: 2, entries: [
    { path: 'project.json', kind: 'file', version: 'manifest-v1', size: 1 },
    { path: sourcePath, kind: 'file', version: 'source-v1', size: 2 },
    ...(remoteText === null ? [] : [{ path, kind: 'file', version: 'organization-v2', size: remoteText.length }]),
  ] }
  client.baseline.set('project.json', 'manifest-v1')
  client.baseline.set(sourcePath, 'source-v1')
  client.texts.set(sourcePath, source.content)
  client.baseline.set(path, 'organization-v1')
  client.texts.set(path, serializeOrganization(original))
  client.originals.set(path, { version: 'organization-v1', data: serializeOrganization(original) })
  client.refresh = async () => {}
  client.planOperations = async operations => ({
    revision: client.tree.revision, leasePaths: [], authorities: [], relations: [],
    operations: operations.map(operation => ({ ...operation, originPath: operation.path,
      version: client.entry(operation.path)?.version ?? null, destinationVersion: null })),
  })
  client.readSnapshot = async (requestedPath, track, expected) => {
    assert.equal(track, false, 'conflict inspection must not advance the draft baseline')
    if (requestedPath === sourcePath) {
      assert.equal(expected, 'source-v1')
      return { file: new File([source.content], source.name), version: 'source-v1' }
    }
    assert.equal(requestedPath, path)
    assert.equal(expected, 'organization-v2')
    assert.notEqual(remoteText, null, 'a deleted organization must not be read')
    return { file: new File([remoteText!], 'explorer.json'), version: 'organization-v2' }
  }
  setProjectClient(client)
  setProjectSession({ workspace, binding })
  // A rejected optimistic folder operation may have restored the old UI while
  // retaining its captured request; both that case and a live draft must sync.
  const conflictId = await client.transactions.retainConflict('修改共享文件夹', [
    { op: 'write', path, data: serializeOrganization(organization('Local attempted folder')) },
  ], '另一窗口已修改共享组织')
  return { client, binding, source, conflictId }
}

let checks = 0
async function test(name: string, run: () => Promise<void>) {
  try { await run(); checks++; console.log('PASS', name) }
  finally {
    setProjectClient(null)
    setProjectSession({ binding: null, workspace: emptyWorkspace() })
    setBoundProject(null)
  }
}

await test('discarding an organization conflict adopts the remote folders and placements before dirty scanning', async () => {
  const { client, binding, source } = await fixture(serializeOrganization(remote))
  const observed: ExplorerOrganization[] = []
  const unsubscribe = subscribeProjectSession(() => {
    if (client.baseline.get(path) === 'organization-v2') {
      observed.push(getProjectSession().workspace.packages[0].explorer!)
      assert.equal(client.transactions.hasDraft(path), false)
    }
  })
  try {
    assert.match(await synchronizeProject(client), /已放弃冲突修改/)
    const final = getProjectSession().workspace
    assert.deepEqual(final.packages[0].explorer, remote)
    assert.equal(documentPlacements(final.packages[0].scripts, final.packages[0].explorer!)[source.id], 'folder')
    assert(observed.length > 0)
    for (const adopted of observed) assert.deepEqual(adopted, remote)
    assert.equal(client.baseline.get(path), 'organization-v2')
    assert.deepEqual(parseOrganization(client.texts.get(path)!), remote)
    assert.equal(client.transactions.hasDraft(path), false)
    assert.equal(client.transactions.getSnapshot().transactions.length, 0)
    assert.deepEqual(await collectProjectChanges(binding, final), [], 'the next save must not rewrite the old organization')
  } finally { unsubscribe() }
})

await test('remote organization deletion clears the local tree and cache without creating a replacement draft', async () => {
  const { client, binding, source } = await fixture(null, organization('Local draft'))
  assert.equal(client.transactions.hasDraft(path), true)
  await synchronizeProject(client)
  const final = getProjectSession().workspace
  assert.deepEqual(final.packages[0].explorer, emptyOrganization())
  assert.equal(documentPlacements(final.packages[0].scripts, final.packages[0].explorer!)[source.id], null)
  assert.equal(final.packages[0].scripts[0].content, '{}')
  assert.equal(client.baseline.has(path), false)
  assert.equal(client.texts.has(path), false)
  assert.equal(client.originals.has(path), false)
  assert.equal(client.transactions.hasDraft(path), false)
  assert.equal(client.transactions.getSnapshot().transactions.length, 0)
  assert.deepEqual(await collectProjectChanges(binding, final), [])
})

await test('invalid remote organization preserves the original baseline, projection and conflict recovery request', async () => {
  const invalid = { ...remote, placements: { [sourcePath]: 'missing-folder' } }
  const { client, conflictId } = await fixture(JSON.stringify(invalid))
  const captured = client.transactions.submission(conflictId)
  await assert.rejects(synchronizeProject(client), /文件夹父级无效/)
  assert.deepEqual(getProjectSession().workspace.packages[0].explorer, original)
  assert.equal(client.baseline.get(path), 'organization-v1')
  assert.equal(client.texts.get(path), serializeOrganization(original))
  assert.equal(client.originals.get(path)?.version, 'organization-v1')
  assert.deepEqual(client.transactions.submission(conflictId), captured)
  assert.equal(client.transactions.getSnapshot().transactions.find(record => record.id === conflictId)?.phase, 'conflict')
})

await test('a later metadata draft preserves the failed source command scope when synchronizing conflicts', async () => {
  const { client, binding, source, conflictId } = await fixture(serializeOrganization(remote), organization('Later local draft'))
  const destination = 'src/items/renamed.item'
  await client.transactions.forget(conflictId)
  await client.transactions.retainConflict('源文件改名及共享归属', [
    { op: 'move', path: sourcePath, destination, version: 'source-v1', destinationVersion: null },
    { op: 'write', path, version: 'organization-v1',
      data: serializeOrganization({ ...original, placements: { [destination]: 'folder' } }),
      affectedPaths: [sourcePath, destination] },
  ], '另一窗口已修改共享组织')
  const collected = await collectProjectChanges(binding, getProjectSession().workspace)
  assert.equal(collected.length, 1)
  assert.equal(collected[0].path, path)
  assert.equal(collected[0].affectedPaths, undefined, 'the later projection has no recovery scope of its own')
  const submitted: FileEdit[][] = []
  client.transactions.submit = async (_label, collect) => { submitted.push(await collect()) }

  await synchronizeProject(client)

  assert.deepEqual(submitted, [], 'stale organization must discard the entire rename, not submit the source half')
  const final = getProjectSession().workspace
  assert.deepEqual(final.packages[0].scripts.map(sourcePathOf), [sourcePath])
  assert.equal(final.packages[0].scripts[0].id, source.id)
  assert.equal(final.packages[0].scripts[0].content, '{}')
  assert.deepEqual(final.packages[0].explorer, remote)
  assert.equal(client.baseline.get(sourcePath), 'source-v1')
  assert.equal(client.baseline.get(path), 'organization-v2')
  assert.equal(client.transactions.hasDraft(path), false)
  assert.equal(client.transactions.getSnapshot().transactions.length, 0)
  assert.deepEqual(await collectProjectChanges(binding, final), [])
})

console.log(`${checks} resource organization synchronization checks passed`)
