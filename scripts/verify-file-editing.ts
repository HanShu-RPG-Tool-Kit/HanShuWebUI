import assert from 'node:assert/strict'
import { ProjectClient, type FileEdit } from '../src/project/serviceClient'
import { progressEditingPath } from '../src/project/fileEditing'
import { ServiceError, type Snapshot, type Lease } from '../src/collab/protocol'
import type { FileChange, FileTransactionReceipt, ProjectFileTree } from '../src/collab/generated'

const SOURCE = 'src/progress/chapter/arrival.progress'
const LANGUAGE = 'assets/zh_cn/lang_progress/chapter/arrival.lang'
const VOICE = 'assets/zh_cn/voice_progress/chapter/arrival/hello.ogg'
const OTHER = 'src/hanshu/other.hs'
const NEXT = 'src/progress/chapter/next.progress'
const SESSION = 'window-a'
const wallClock = Date.now.bind(Date)

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error('The expected asynchronous operation did not arrive')
}

type Call = { path: string; method: string; body: Record<string, unknown> }
/** Transport fixture with independently controlled authoritative leases and snapshot order. */
class Service {
  calls: Call[] = []
  leases = new Map<string, Lease>()
  receipts = new Map<string, FileTransactionReceipt>()
  versions = new Map([[SOURCE, 'source-v1'], [LANGUAGE, 'lang-v1'], [OTHER, 'other-v1']])
  role: Snapshot['role'] = 'editor'
  focus: string | null = null
  statusVersion = 1
  revision = 1
  serial = 0
  clockOffset = 0
  now() { return wallClock() + this.clockOffset }
  beforeAcquire?: () => void
  beforePresence?: () => Promise<void>
  beforeProjectResponse?: (snapshot: Snapshot) => Promise<Snapshot>
  beforeCommit?: () => Promise<void>
  failRelease = new Set<string>()
  dropCommitResponse = false
  tree(): ProjectFileTree {
    return { revision: this.revision, entries: [...this.versions].map(([path, version]) => ({ path, version, kind: 'file', size: 1 })) }
  }
  snapshot(): Snapshot {
    const session = {
      id: SESSION, subjectId: 'same-subject', clientName: 'Window A', expiresAt: this.now() + 60000,
      resourceId: null, activity: 'viewing', filePresence: this.focus ? {
        path: this.focus, authorityId: `file:${this.focus}`,
        activity: this.leases.get(this.focus)?.sessionId === SESSION ? 'editing' as const : 'viewing' as const,
      } : null,
    }
    return structuredClone({
      statusVersion: ++this.statusVersion, serverTime: this.now(), projectId: 'editing-test', projectName: 'Editing test', revision: 1,
      filesRevision: this.revision, session, role: this.role,
      members: [{ subject: { id: 'same-subject', name: 'Author', kind: 'automation', enabled: true }, role: this.role }],
      sessions: [session, { ...session, id: 'window-b', clientName: 'Window B' }], resources: [], leases: [...this.leases.values()],
    })
  }
  lease(path: string, sessionId = SESSION): Lease {
    const lease = { id: `lease-${++this.serial}`, resourceId: `file:${path}`, sessionId, expiresAt: this.now() + 30000 }
    this.leases.set(path, lease)
    return structuredClone(lease)
  }
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    this.calls.push({ path, method, body })
    const json = (data: unknown, status = 200) => Response.json(data, { status })
    if (path === '/api/presence') {
      await this.beforePresence?.()
      this.focus = body.path
      return json(this.snapshot())
    }
    if (path === '/api/project') {
      const snapshot = this.snapshot()
      return json(this.beforeProjectResponse ? await this.beforeProjectResponse(snapshot) : snapshot)
    }
    if (path === '/api/files') return json(this.tree())
    if (path === '/api/files/leases' && method === 'POST') {
      this.beforeAcquire?.()
      const requested = new Set<string>(body.paths)
      // The fake service groups these known sidecars independently of the C mapper.
      if (requested.has(LANGUAGE) || requested.has(VOICE)) requested.add(SOURCE)
      for (const resource of requested) {
        const held = this.leases.get(resource)
        if (held && held.sessionId !== SESSION && !body.force) return json({ code: 'locked', message: 'Owned by another window' }, 423)
      }
      return json([...requested].map(resource => {
        const held = this.leases.get(resource)
        return held?.sessionId === SESSION && held.expiresAt > this.now() ? held : this.lease(resource)
      }))
    }
    if (path === '/api/files/leases' && method === 'DELETE') {
      if (this.failRelease.has(body.path)) throw new Error('Injected release network failure')
      const held = this.leases.get(body.path)
      if (!held || held.id !== body.leaseId || held.sessionId !== SESSION) return json({ code: 'locked', message: 'Stale lease' }, 423)
      this.leases.delete(body.path)
      return json({ ok: true })
    }
    if (path.startsWith('/api/files/transactions/')) {
      const receipt = this.receipts.get(decodeURIComponent(path.split('/').at(-1)!))
      return receipt ? json(receipt) : json({ code: 'not_found', message: 'Unknown transaction' }, 404)
    }
    if (path === '/api/files/commit') {
      await this.beforeCommit?.()
      const changes = body.changes as FileChange[]
      for (const change of changes) {
        assert.equal(this.leases.get(change.path)?.id, change.leaseId, 'The client must submit the exact authoritative lease')
      }
      this.revision++
      for (const change of changes) {
        if (change.op === 'write') this.versions.set(change.path, `written-${this.revision}`)
        if (change.op === 'remove' || change.op === 'move') this.versions.delete(change.path)
        if (change.op === 'move') this.versions.set(change.destination!, `moved-${this.revision}`)
      }
      const receipt: FileTransactionReceipt = { transactionId: body.transactionId, status: 'committed', tree: this.tree(), error: null }
      this.receipts.set(body.transactionId, receipt)
      if (this.dropCommitResponse) throw new Error('Injected lost commit response')
      return json(receipt)
    }
    throw new Error(`Unexpected request: ${method} ${path}`)
  }
  count(path: string, method?: string) { return this.calls.filter(call => call.path === path && (!method || call.method === method)).length }
}

async function fixture(run: (client: ProjectClient, service: Service) => Promise<void>) {
  const previous = globalThis.fetch
  const service = new Service()
  globalThis.fetch = service.fetch
  const client = new ProjectClient({ url: 'http://editing.test', token: 'test-token' }, service.snapshot())
  try { await client.refresh(true); await run(client, service) }
  finally { globalThis.fetch = previous }
}
const write = (path: string, data = 'new content'): FileEdit => ({ op: 'write', path, data })
let checks = 0
const failures: string[] = []
async function test(name: string, run: () => Promise<void>) {
  try { await run(); checks++; console.log(`通过：${name}`) }
  catch (error) { failures.push(name); console.error(`失败：${name}`, error) }
}

await test('打开和清除焦点不申请写权，焦点更新按用户最后一次选择串行发送', () => fixture(async (client, service) => {
  const gate = deferred(); let first = true
  service.beforePresence = async () => { if (first) { first = false; await gate.promise } }
  client.editing.setFocus(SOURCE)
  await until(() => service.count('/api/presence') === 1)
  client.editing.setFocus(OTHER)
  client.editing.setFocus(null)
  gate.resolve()
  await until(() => service.count('/api/presence') === 2 && service.focus === null)
  assert.deepEqual(service.calls.filter(call => call.path === '/api/presence').map(call => call.body.path), [SOURCE, null])
  assert.equal(service.count('/api/files/leases'), 0)
  assert.equal(client.editing.canEdit(SOURCE), false)
}))

await test('进度、语言及配音写入都必须明确开始编辑，普通剧本不受此入口策略影响', () => fixture(async (client, service) => {
  for (const path of [SOURCE, LANGUAGE, VOICE]) {
    await assert.rejects(client.apply([write(path)]), error => error instanceof ServiceError && error.code === 'editing_required')
  }
  assert.equal(service.count('/api/files/leases', 'POST'), 0)
  assert.equal(service.count('/api/files/commit'), 0)
  await client.apply([write(OTHER)])
  assert.equal(service.count('/api/files/commit'), 1)
  assert.equal(service.leases.has(OTHER), false)
}))

await test('源文档和语言整批保存后只保留显式编辑锁，临时语言锁立即释放', () => fixture(async (client, service) => {
  await client.editing.begin(SOURCE)
  const retained = client.leases.get(SOURCE)!.id
  await client.apply([write(SOURCE), write(LANGUAGE)])
  assert.equal(service.count('/api/files/commit'), 1)
  assert.equal(client.leases.get(SOURCE)?.id, retained)
  assert.equal(service.leases.get(SOURCE)?.id, retained)
  assert.equal(service.leases.has(LANGUAGE), false)
  assert.equal(client.leases.has(LANGUAGE), false)
  assert.equal(client.editing.canEdit(SOURCE), true)
}))

await test('取得临时写权之前生成的心跳迟到时，二进制提交仍使用本批返回的准确ID', () => fixture(async (client, service) => {
  await client.editing.begin(SOURCE)
  let delayed: Snapshot | undefined
  service.beforeAcquire = () => { delayed = service.snapshot(); service.beforeAcquire = undefined }
  const gate = deferred(); let reading = false
  const data = new Blob(['voice payload'])
  const read = data.arrayBuffer.bind(data)
  data.arrayBuffer = async () => { reading = true; await gate.promise; return read() }
  const saving = client.apply([{ op: 'write', path: VOICE, data }])
  await until(() => reading)
  assert.ok(delayed)
  assert.equal(client.setStatus(true, delayed), true)
  assert.equal(client.leases.has(VOICE), false, 'This snapshot predates temporary lease acquisition')
  gate.resolve()
  await saving
  assert.equal(service.count('/api/files/commit'), 1)
  assert.equal(service.leases.has(VOICE), false)
  assert.equal(client.editing.canEdit(SOURCE), true)
}))

await test('提交期间旧编辑锁失效时拒绝自动重新取得写权，不发送commit并释放新临时锁', () => fixture(async (client, service) => {
  await client.editing.begin(SOURCE)
  const retained = client.leases.get(SOURCE)!.id
  service.beforeAcquire = () => { service.leases.delete(SOURCE); service.beforeAcquire = undefined }
  await assert.rejects(client.apply([write(SOURCE), write(LANGUAGE)]), error => error instanceof ServiceError && error.code === 'editing_required')
  assert.equal(service.count('/api/files/commit'), 0)
  assert.notEqual(service.leases.get(SOURCE)?.id, retained)
  assert.equal(service.leases.has(SOURCE), false)
  assert.equal(service.leases.has(LANGUAGE), false)
  assert.equal(client.editing.canEdit(SOURCE), false)
}))

await test('旧快照不能恢复已经被接管的写权，同主体不同窗口仍然隔离', () => fixture(async (client, service) => {
  await client.editing.begin(SOURCE)
  const before = service.snapshot()
  service.lease(SOURCE, 'window-b')
  const after = service.snapshot()
  assert.equal(client.setStatus(true, after), true)
  assert.equal(client.editing.canEdit(SOURCE), false)
  assert.equal(client.editing.state(SOURCE)?.lost, true)
  assert.equal(client.setStatus(true, before), false)
  assert.equal(client.snapshot.statusVersion, after.statusVersion)
  assert.equal(client.editing.canEdit(SOURCE), false)
  await assert.rejects(client.apply([write(SOURCE)]), error => error instanceof ServiceError && error.code === 'editing_required')
  assert.equal(service.count('/api/files/commit'), 0)
}))

await test('断线后保留草稿但停止续租，恢复连接不会自动恢复编辑，需明确重新申请', () => fixture(async (client, service) => {
  await client.editing.begin(SOURCE)
  await client.transactions.stageWrite(write(LANGUAGE, 'unsaved translation'))
  client.setStatus(false)
  assert.equal(client.leases.has(SOURCE), false)
  assert.equal(client.editing.canEdit(SOURCE), false)
  assert.equal(client.transactions.stagedText(LANGUAGE), 'unsaved translation')
  const presenceCount = service.count('/api/presence')
  client.setStatus(true, service.snapshot())
  await until(() => service.count('/api/presence') > presenceCount)
  assert.equal(client.editing.canEdit(SOURCE), false)
  await client.editing.begin(SOURCE)
  assert.equal(client.editing.canEdit(SOURCE), true)
  assert.equal(client.transactions.stagedText(LANGUAGE), 'unsaved translation')
}))

await test('申请期间收到更新的接管快照时忽略旧HTTP响应，不释放对方写权', () => fixture(async (client, service) => {
  const gate = deferred(); let waiting = false
  service.beforeProjectResponse = async snapshot => { waiting = true; await gate.promise; return snapshot }
  const beginning = client.editing.begin(SOURCE)
  await until(() => waiting)
  const takeover = service.lease(SOURCE, 'window-b')
  client.setStatus(true, service.snapshot())
  gate.resolve()
  await assert.rejects(beginning, /写权发生变化/)
  assert.equal(client.editing.canEdit(SOURCE), false)
  assert.equal(service.leases.get(SOURCE)?.id, takeover.id)
}))

await test('结束一个编辑会话只释放其准确ID，保留其它操作的锁和未提交草稿', () => fixture(async (client, service) => {
  await client.editing.begin(SOURCE)
  const other = service.lease(OTHER)
  client.leases.set(OTHER, other)
  await client.transactions.stageWrite(write(LANGUAGE, 'keep this draft'))
  await client.editing.end(SOURCE)
  assert.equal(service.leases.has(SOURCE), false)
  assert.equal(service.leases.get(OTHER)?.id, other.id)
  assert.equal(client.leases.get(OTHER)?.id, other.id)
  assert.equal(client.transactions.stagedText(LANGUAGE), 'keep this draft')
  assert.equal(client.editing.state(SOURCE), undefined)
}))

await test('释放旧ID不能删除同路径的新ID，释放全部失败时所有本地锁均停止续租', () => fixture(async (client, service) => {
  const old = service.lease(SOURCE)
  const current = service.lease(SOURCE)
  client.leases.set(SOURCE, current)
  await client.releaseLeases([old], true)
  assert.equal(client.leases.get(SOURCE)?.id, current.id)
  assert.equal(service.leases.get(SOURCE)?.id, current.id)
  const other = service.lease(OTHER)
  client.leases.set(OTHER, other)
  service.failRelease.add(SOURCE)
  await assert.rejects(client.release(), /network failure/)
  assert.equal(client.leases.size, 0, 'A failed release must not leave other requested leases renewing indefinitely')
  assert.equal(service.leases.has(OTHER), false, 'Attempt every requested release even if the first request fails')
}))

await test('保存尚在途时结束编辑被阻止，响应后才可安全释放', () => fixture(async (client, service) => {
  await client.editing.begin(SOURCE)
  const gate = deferred(); service.beforeCommit = () => gate.promise
  const saving = client.apply([write(SOURCE)])
  await until(() => service.count('/api/files/commit') === 1)
  await assert.rejects(client.editing.end(SOURCE), /当前提交结束/)
  assert.equal(client.editing.canEdit(SOURCE), true)
  gate.resolve(); await saving
  await client.editing.end(SOURCE)
  assert.equal(service.leases.has(SOURCE), false)
}))

await test('写权申请尚在途时释放全部被阻止，避免释放成功后旧请求重新持锁', () => fixture(async (client, service) => {
  const gate = deferred(); let waiting = false
  service.beforeProjectResponse = async snapshot => { waiting = true; await gate.promise; return snapshot }
  const beginning = client.editing.begin(SOURCE)
  await until(() => waiting)
  let failure: unknown
  try { await assert.rejects(client.release(), /申请|编辑操作|写权操作/) }
  catch (error) { failure = error }
  finally { gate.resolve(); await beginning.catch(() => undefined) }
  if (failure) throw failure
  assert.equal(client.editing.canEdit(SOURCE), true)
  await client.editing.end(SOURCE)
}))

await test('申请确认期间续租后保留最新快照的有效期，不被旧申请响应倒退覆盖', () => fixture(async (client, service) => {
  const renewedUntil = Date.now() + 90000
  service.beforeProjectResponse = async snapshot => {
    for (const lease of snapshot.leases) lease.expiresAt = renewedUntil
    for (const lease of service.leases.values()) lease.expiresAt = renewedUntil
    return snapshot
  }
  await client.editing.begin(SOURCE)
  assert.equal(client.leases.get(SOURCE)?.expiresAt, renewedUntil)
  assert.equal(client.editing.canEdit(SOURCE), true)
}))

await test('服务端时钟比客户端快慢数小时仍能正确编辑，过时快照不能重设时钟锚', async () => {
  for (const offset of [-6 * 3600000, 6 * 3600000]) await fixture(async (client, service) => {
    service.clockOffset = offset
    client.setStatus(true, service.snapshot())
    await client.editing.begin(SOURCE)
    assert.equal(client.editing.canEdit(SOURCE), true)
    const old = { ...service.snapshot(), statusVersion: client.snapshot.statusVersion - 1, serverTime: service.now() + 24 * 3600000 }
    assert.equal(client.setStatus(true, old), false)
    assert.equal(client.editing.canEdit(SOURCE), true)
  })
})

await test('本机系统时间跳变不会使编辑锁过期或复活，租期使用单调计时', () => fixture(async (client, service) => {
  await client.editing.begin(SOURCE)
  const previous = Date.now
  try {
    Date.now = () => wallClock() + 24 * 3600000
    assert.equal(client.editing.canEdit(SOURCE), true)
    client.setStatus(true, service.snapshot())
    assert.equal(client.editing.canEdit(SOURCE), true)
    Date.now = () => wallClock() - 24 * 3600000
    assert.equal(client.editing.canEdit(SOURCE), true)
  } finally { Date.now = previous }
}))

await test('单调时间超过租期立即暂停，之后收到仍含旧ID的快照也不会自动恢复', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(performance, 'now')
  let elapsed = 1000
  Object.defineProperty(performance, 'now', { configurable: true, value: () => elapsed })
  try {
    await fixture(async (client, service) => {
      await client.editing.begin(SOURCE)
      assert.equal(client.editing.canEdit(SOURCE), true)
      elapsed += 31000
      assert.equal(client.editing.canEdit(SOURCE), false)
      client.setStatus(true)
      assert.equal(client.editing.state(SOURCE)?.lost, true)
      assert.equal(client.leases.has(SOURCE), false)
      client.setStatus(true, service.snapshot())
      assert.equal(client.editing.canEdit(SOURCE), false)
    })
  } finally {
    if (descriptor) Object.defineProperty(performance, 'now', descriptor)
    else Reflect.deleteProperty(performance, 'now')
  }
})

await test('已提交但丢响应的结果可在失去编辑权后确认，不重新申请写权或重复commit', () => fixture(async (client, service) => {
  await client.editing.begin(SOURCE)
  service.dropCommitResponse = true
  await assert.rejects(client.apply([write(SOURCE)]), error => error instanceof ServiceError && error.code === 'commit_uncertain')
  const job = client.transactions.getSnapshot().transactions.at(-1)!
  client.setStatus(false); client.setStatus(true, service.snapshot())
  const before = service.count('/api/files/leases', 'POST')
  await client.transactions.retry(job.id)
  assert.equal(client.transactions.getSnapshot().transactions.at(-1)?.phase, 'saved')
  assert.equal(client.editing.canEdit(SOURCE), false)
  assert.equal(service.count('/api/files/leases', 'POST'), before)
  assert.equal(service.count('/api/files/commit'), 1)
}))

await test('未被服务记录的不确定提交必须重新申请编辑后才能重发，仍沿用原提交编号', () => fixture(async (client, service) => {
  await client.editing.begin(SOURCE)
  service.beforeCommit = async () => { throw new Error('Disconnected before the server recorded the operation') }
  await assert.rejects(client.apply([write(SOURCE)]))
  const job = client.transactions.getSnapshot().transactions.at(-1)!
  client.setStatus(false); client.setStatus(true, service.snapshot())
  const before = service.count('/api/files/leases', 'POST')
  await assert.rejects(client.transactions.retry(job.id), error => error instanceof ServiceError && error.code === 'commit_uncertain')
  assert.equal(service.count('/api/files/leases', 'POST'), before)
  service.beforeCommit = undefined
  await client.editing.begin(SOURCE)
  await client.transactions.retry(job.id)
  const ids = service.calls.filter(call => call.path === '/api/files/commit').map(call => call.body.transactionId)
  assert.deepEqual(ids, [job.requestId, job.requestId])
  assert.equal(client.transactions.getSnapshot().transactions.at(-1)?.phase, 'saved')
}))

await test('权限降为只读立即暂停编辑并停止续租，保留语言草稿', () => fixture(async (client, service) => {
  await client.editing.begin(SOURCE)
  await client.transactions.stageWrite(write(LANGUAGE, 'keep after downgrade'))
  service.role = 'viewer'; service.leases.clear()
  client.setStatus(true, service.snapshot())
  assert.equal(client.editing.canEdit(SOURCE), false)
  assert.equal(client.leases.has(SOURCE), false)
  assert.equal(client.editing.state(SOURCE)?.lost, true)
  assert.equal(client.transactions.stagedText(LANGUAGE), 'keep after downgrade')
  await assert.rejects(client.editing.begin(SOURCE), error => error instanceof ServiceError && error.code === 'forbidden')
}))

await test('显式移动源文档及重写目标内容可作为一个结构事务执行', () => fixture(async (client, service) => {
  await client.apply([{ op: 'move', path: SOURCE, destination: NEXT }, write(NEXT, 'renamed progress')])
  assert.equal(service.count('/api/files/commit'), 1)
  assert.equal(service.versions.has(SOURCE), false)
  assert.equal(service.versions.has(NEXT), true)
  assert.equal(client.leases.size, 0)
}))

await test('进度sidecar的UI映射保留嵌套路径并排除其它编辑器资源', async () => {
  assert.equal(progressEditingPath(SOURCE), SOURCE)
  assert.equal(progressEditingPath(LANGUAGE), SOURCE)
  assert.equal(progressEditingPath(VOICE), SOURCE)
  assert.equal(progressEditingPath('assets/zh_cn/lang_hs/chapter/arrival.lang'), null)
  assert.equal(progressEditingPath(OTHER), null)
})

if (failures.length) throw new Error(`${failures.length} 项编辑会话回归失败：${failures.join('；')}`)
console.log(`编辑会话与写权生命周期 ${checks} 项检查通过。`)
