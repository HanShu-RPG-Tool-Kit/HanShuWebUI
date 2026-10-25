import assert from 'node:assert/strict'
import { createProject, createSourceFile, sourcePathOf, type Workspace } from '../src/workspace'
import { ProjectClient, setProjectClient } from '../src/project/serviceClient'
import { collectProjectChanges, refreshServiceProject, type BoundProject } from '../src/project/projectFs'
import { getProjectSession, setProjectSession, sourcesToProgressDocuments } from '../src/project/projectSession'
import {
  EXPLORER_ORGANIZATION_PATH as path, documentPlacements, emptyOrganization,
  organizationFromDocuments, serializeOrganization, type ExplorerOrganization,
} from '../src/project/explorerOrganization'

const organization = (name: string): ExplorerOrganization => ({
  version: 1, folders: [{ key: 'folder', name, package: 'items', parentId: null }], placements: {},
})
const before = organization('Original'), remote = organization('Peer'), local = organization('Local draft')
const workspace = (explorer: ExplorerOrganization): Workspace => ({
  packages: [{ ...createProject('Review', []), id: 'pkg', explorer }], activeScriptId: null, activeAssetId: null,
})
function fixture() {
  const client = new ProjectClient({ url: 'http://organization.test', token: '' }, {
    role: 'editor', projectId: 'review', session: { subjectId: 'review' },
  } as never)
  client.tree = { revision: 2, entries: [{ path, kind: 'file', version: 'v2', size: 1 }] }
  client.refresh = async () => {}
  client.texts.set(path, serializeOrganization(before)); client.baseline.set(path, 'v1')
  client.originals.set(path, { version: 'v1', data: serializeOrganization(before) })
  const binding: BoundProject = { handle: client.root(), folderName: 'Review', manifest: { version: 1, id: 'pkg', name: 'Review' } }
  setProjectClient(client); setProjectSession({ workspace: workspace(before), binding })
  return { client, binding }
}
function delayedSnapshot(value = remote) {
  let start!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { start = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  globalThis.fetch = async input => {
    const url = new URL(String(input))
    start()
    assert.equal(url.searchParams.get('path'), path)
    assert.equal(url.searchParams.get('version'), 'v2', 'refresh must request the captured version')
    await gate
    return new Response(JSON.stringify({ content: btoa(serializeOrganization(value)), version: 'v2' }), { headers: { 'Content-Type': 'application/json' } })
  }
  return { started, release }
}
let checks = 0
const test = async (name: string, run: () => void | Promise<void>) => { await run(); checks++; console.log('PASS', name) }
const previousSession = getProjectSession(), previousFetch = globalThis.fetch
try {
  await test('UI-only changes during metadata reads adopt remote content and CAS version together', async () => {
    const { client, binding } = fixture(), read = delayedSnapshot()
    const refreshing = refreshServiceProject(binding, getProjectSession().workspace)
    await read.started
    setProjectSession({ workspace: workspace(structuredClone(before)) })
    assert.equal(client.transactions.hasDraft(path), false)
    assert.equal(client.baseline.get(path), 'v1')
    read.release(); const refreshed = await refreshing
    setProjectSession({ workspace: refreshed })
    assert.deepEqual(refreshed.packages[0].explorer, remote)
    assert.equal(client.baseline.get(path), 'v2')
    assert.equal(client.texts.get(path), serializeOrganization(remote))
    assert.equal(client.originals.get(path)?.version, 'v2')
    assert.equal(client.transactions.hasDraft(path), false)
    assert.equal((await collectProjectChanges(binding, refreshed)).some(edit => edit.path === path), false)
  })

  await test('real organization edits during a read keep the original version and bytes', async () => {
    const { client, binding } = fixture(), read = delayedSnapshot()
    const refreshing = refreshServiceProject(binding, getProjectSession().workspace)
    await read.started; setProjectSession({ workspace: workspace(local) }); read.release()
    setProjectSession({ workspace: await refreshing })
    assert.deepEqual(getProjectSession().workspace.packages[0].explorer, local)
    assert.equal(client.baseline.get(path), 'v1')
    assert.equal(client.texts.get(path), serializeOrganization(before))
    assert.equal(client.originals.get(path)?.version, 'v1')
    assert.equal(client.transactions.hasDraft(path), true)
  })

  await test('switching projects during a metadata read cannot install a stale cache or projection', async () => {
    const { client, binding } = fixture(), read = delayedSnapshot()
    const refreshing = refreshServiceProject(binding, getProjectSession().workspace)
    await read.started
    setProjectClient(null); setProjectSession({ binding: null, workspace: workspace(local) })
    read.release(); await refreshing
    assert.deepEqual(getProjectSession().workspace.packages[0].explorer, local)
    assert.equal(client.baseline.get(path), 'v1')
    assert.equal(client.texts.get(path), serializeOrganization(before))
  })

  await test('a late snapshot cannot roll back an already adopted newer metadata version', async () => {
    const { client, binding } = fixture(), read = delayedSnapshot()
    const refreshing = refreshServiceProject(binding, getProjectSession().workspace)
    await read.started
    // The newer bytes may describe the same organization; semantic equality alone is insufficient.
    const newerRaw = JSON.stringify(before)
    client.tree = { revision: 3, entries: [{ path, kind: 'file', version: 'v3', size: 1 }] }
    client.texts.set(path, newerRaw); client.baseline.set(path, 'v3')
    client.originals.set(path, { version: 'v3', data: newerRaw })
    setProjectSession({ workspace: workspace(structuredClone(before)) }); read.release()
    setProjectSession({ workspace: await refreshing })
    assert.deepEqual(getProjectSession().workspace.packages[0].explorer, before)
    assert.equal(client.baseline.get(path), 'v3')
    assert.equal(client.texts.get(path), newerRaw)
    assert.equal(client.transactions.hasDraft(path), false)
  })

  await test('remote metadata deletion adopts an empty tree and clears all read caches', async () => {
    const { client, binding } = fixture(); client.tree = { revision: 3, entries: [] }
    setProjectSession({ workspace: await refreshServiceProject(binding, getProjectSession().workspace) })
    assert.deepEqual(getProjectSession().workspace.packages[0].explorer, emptyOrganization())
    assert.equal(client.baseline.has(path), false); assert.equal(client.texts.has(path), false)
    assert.equal(client.originals.has(path), false); assert.equal(client.transactions.hasDraft(path), false)
  })

  await test('peer unsaved placements survive UI projection and unrelated folder edits', () => {
    const value = { ...before, placements: { 'src/items/unsaved.item': 'folder' } }
    const documents = sourcesToProgressDocuments([], documentPlacements([], value))
    const projection = { organization: value, sourcePaths: [] }
    assert.deepEqual(organizationFromDocuments(documents, value.folders, projection), value)
    const renamed = organizationFromDocuments(documents, remote.folders, projection)
    assert.deepEqual(renamed.placements, value.placements)
  })

  await test('explicit local source rename, removal and folder deletion clear only their placements', () => {
    const source = createSourceFile('local.item'), sourcePath = sourcePathOf(source)
    const value = { ...before, placements: { [sourcePath]: 'folder', 'src/items/peer.item': 'folder' } }
    const documents = sourcesToProgressDocuments([source], documentPlacements([source], value))
    const projection = { organization: value, sourcePaths: [sourcePath] }
    const renamed = organizationFromDocuments(documents.map(doc => ({ ...doc, name: 'renamed.item' })), value.folders, projection)
    assert.deepEqual(renamed.placements, { 'src/items/renamed.item': 'folder', 'src/items/peer.item': 'folder' })
    assert.deepEqual(organizationFromDocuments([], value.folders, projection).placements, { 'src/items/peer.item': 'folder' })
    assert.deepEqual(organizationFromDocuments([], [], projection).placements, {})
  })
} finally {
  globalThis.fetch = previousFetch; setProjectClient(null); setProjectSession(previousSession)
}
console.log(`${checks} resource organization concurrency checks passed`)
