import assert from 'node:assert/strict'
import type { FileOperationRequest } from '../src/collab/generated'
import { EXPLORER_ORGANIZATION_PATH, parseOrganization, serializeOrganization, type ExplorerOrganization } from '../src/project/explorerOrganization'
import { ProjectClient, type FileEdit } from '../src/project/serviceClient'
import { partitionSyncEdits } from '../src/project/syncPolicy'
import { resourcePlanFixture } from './resource-plan-fixture'

const metadata = EXPLORER_ORGANIZATION_PATH
const source = 'src/items/apple.item'
const destination = 'src/items/renamed.item'
const otherSource = 'src/items/pear.item'
const language = 'assets/zh_cn/lang_item/apple.lang'
const nextLanguage = 'assets/zh_cn/lang_item/renamed.lang'
const organization: ExplorerOrganization = {
  version: 1, folders: [{ key: 'folder', name: 'Food', package: 'items', parentId: null }],
  placements: { [source]: 'folder', [otherSource]: 'folder' },
}

function fixture() {
  const client = new ProjectClient({ url: 'http://organization-commands.invalid', token: '' }, {
    statusVersion: 1, serverTime: Date.now(), projectId: 'organization-commands', projectName: 'Commands test',
    revision: 1, filesRevision: 1, role: 'editor', members: [], resources: [], sessions: [], leases: [],
    session: { id: 'window-a', subjectId: 'author', clientName: 'Test', expiresAt: Date.now() + 60000,
      resourceId: null, activity: 'viewing', filePresence: null },
  })
  const versions = new Map([[source, 'source-v1'], [otherSource, 'other-v1'], [language, 'language-v1'], [metadata, 'organization-v1']])
  for (const [path, version] of versions) client.baseline.set(path, version)
  client.texts.set(metadata, serializeOrganization(organization))
  client.originals.set(metadata, { version: 'organization-v1', data: serializeOrganization(organization) })
  const owners = new Map([[language, source], [nextLanguage, destination]])
  let submitted: FileEdit[] = []
  let markPlanning!: () => void
  const planning = new Promise<void>(resolve => { markPlanning = resolve })
  client.planOperations = async operations => {
    markPlanning()
    const expanded: FileOperationRequest[] = operations.flatMap(operation => operation.path === source
      ? [operation, { ...operation, path: language, destination: operation.destination ? nextLanguage : null }]
      : [operation])
    // A plan may see newer versions; sourceCommands must retain C's captured CAS.
    const plan = resourcePlanFixture(expanded, {
      versions: new Map([...versions].map(([path]) => [path, 'plan-v2'])), owners,
    })
    for (const operation of plan.operations) if (operation.path === language) operation.originPath = source
    return plan
  }
  // Preserve real transaction records for sourceCommands and stub only the send.
  Object.defineProperty(client, 'perform', { value: async (edits: FileEdit[]) => { submitted = edits } })
  const split = (edits = submitted) => partitionSyncEdits(edits, {
    revision: 2,
    entries: [...versions].map(([path, version]) => ({ path, kind: 'file', size: 1,
      version: path === metadata ? 'organization-v2' : version })),
  }, path => owners.get(path) ?? path)
  return { client, batch: () => submitted, split, planning }
}

let checks = 0
async function test(name: string, run: () => Promise<void>) {
  await run(); checks++; console.log('PASS', name)
}

await test('automatic placement relocation keeps rename, destination content and owned language with stale metadata', async () => {
  const { client, batch, split } = fixture()
  await client.sourceCommands([{ path: source, destination, content: 'renamed content' }])
  const edits = batch()
  const extra = edits.find(edit => edit.path === metadata)!
  assert.deepEqual(extra.affectedPaths, [source, destination])
  assert.equal(extra.version, 'organization-v1')
  assert.equal(extra.baseData, serializeOrganization(organization))
  assert.equal(parseOrganization(String(extra.data)).placements[destination], 'folder')
  assert.equal(parseOrganization(String(extra.data)).placements[source], undefined)
  assert.equal(edits.find(edit => edit.path === source)?.version, 'source-v1')
  assert.equal(edits.find(edit => edit.path === language)?.version, 'language-v1')
  assert.equal(edits.find(edit => edit.op === 'write' && edit.path === destination)?.version, null)
  const grouped = split()
  assert.deepEqual(grouped.safe, [], 'a metadata conflict must not execute only the source rename')
  assert.equal(grouped.conflicting.length, 1)
  assert.equal(grouped.conflicting[0].length, edits.length)
  assert(grouped.conflicting[0].some(edit => edit.path === language), 'owned language follows the source authority')
})

await test('explicit metadata freezes all source command paths and preserves pre-existing recovery scope', async () => {
  const { client, batch, split, planning } = fixture()
  const priorScope = 'src/items/additional.item'
  const extra: FileEdit = { op: 'write', path: metadata, data: serializeOrganization({ ...organization, placements: {} }),
    version: 'organization-v1', affectedPaths: [priorScope, source] }
  const pending = client.sourceCommands([
    { path: source, destination }, { path: otherSource, destination: null },
  ], [extra])
  await planning
  extra.affectedPaths!.push('src/items/changed-after-capture.item')
  await pending
  const frozen = batch().find(edit => edit.path === metadata)!
  assert.deepEqual(frozen.affectedPaths, [priorScope, source, destination, otherSource])
  assert.equal(frozen.version, 'organization-v1')
  assert.equal(extra.version, 'organization-v1')
  assert.deepEqual(split().safe, [])
  assert.equal(split().conflicting.length, 1)
  assert.equal(split().conflicting[0].length, batch().length)
})

await test('automatic placement deletion cannot split source and owned language deletion from metadata conflict', async () => {
  const { client, batch, split } = fixture()
  await client.sourceCommands([{ path: source, destination: null }])
  const extra = batch().find(edit => edit.path === metadata)!
  assert.deepEqual(extra.affectedPaths, [source])
  assert.equal(parseOrganization(String(extra.data)).placements[source], undefined)
  assert(batch().some(edit => edit.op === 'remove' && edit.path === source))
  assert(batch().some(edit => edit.op === 'remove' && edit.path === language))
  assert.deepEqual(split().safe, [])
  assert.equal(split().conflicting[0].length, batch().length)
})

await test('a folder-only metadata edit does not acquire unrelated source command scope', async () => {
  const { client, batch, split } = fixture()
  await client.sourceCommands([], [{ op: 'write', path: metadata, data: serializeOrganization(organization) }])
  assert.equal(batch()[0].affectedPaths, undefined)
  const independent: FileEdit = { op: 'write', path: source, version: 'source-v1', data: 'unrelated local edit' }
  const grouped = split([...batch(), independent])
  assert.deepEqual(grouped.safe, [[independent]])
  assert.equal(grouped.conflicting.length, 1)
  assert.equal(grouped.conflicting[0].length, 1)
})

console.log(`${checks} resource organization command checks passed`)
