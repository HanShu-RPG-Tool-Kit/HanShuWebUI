import assert from 'node:assert/strict'
import { EditTransactions, type SendAttempt } from '../src/project/editTransactions'
import { ServiceError } from '../src/collab/protocol'
import { createTextSink } from '../src/i18n/textSink'
import { ProjectClient } from '../src/project/serviceClient'
import type { FileEdit } from '../src/project/serviceClient'
import type { Snapshot } from '../src/collab/protocol'
import type { EditJournal, PendingSubmission } from '../src/project/editJournal'
import type { FileChange, FileTransactionReceipt, ProjectFileTree } from '../src/collab/generated'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}
const write = (path: string, data: string): FileEdit => ({ op: 'write', path, data })
function fixture(send?: (edits: FileEdit[], attempt: SendAttempt) => Promise<void>) {
  const versions = new Map<string, string>()
  const sent: FileEdit[][] = []
  const attempts: SendAttempt[] = []
  const tx = new EditTransactions(edits => edits.map(e => ({ ...e, data: e.data instanceof Uint8Array ? e.data.slice() : e.data, version: e.version === undefined ? versions.get(e.path) ?? null : e.version })), async (edits, attempt) => {
    sent.push(edits.map(e => ({ ...e })))
    attempts.push({ ...attempt })
    await send?.(edits, attempt)
  })
  return { tx, versions, sent, attempts }
}
let checks = 0
const failures: string[] = []
async function test(name: string, run: () => Promise<void>) {
  try { await run(); checks++; console.log(`通过：${name}`) }
  catch (error) { failures.push(name); console.error(`失败：${name}`, error) }
}

await test('等待异步语言镜像，源文件与语言仅发送一次批量提交', async () => {
  const { tx, sent } = fixture()
  const gate = deferred(); let mirrored = false
  tx.stageWrite(write('assets/zh_cn/lang_hs/a.lang', '{"line":"你好"}'), async () => { await gate.promise; mirrored = true })
  const saving = tx.submit('保存剧本', () => { assert.ok(mirrored); return [write('src/hanshu/a.hs', 'line')] }, true)
  await Promise.resolve(); assert.equal(sent.length, 0)
  gate.resolve(); await saving
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].map(e => e.path), ['src/hanshu/a.hs', 'assets/zh_cn/lang_hs/a.lang'])
  assert.equal(tx.stagedWrites().length, 0)
})
await test('准备资源失败阻止整批提交，重试重新准备后再提交', async () => {
  const { tx, sent } = fixture(); let attempts = 0
  tx.stageWrite(write('assets/lang.lang', 'draft'), async () => { if (++attempts === 1) throw new Error('cache unavailable') })
  await assert.rejects(tx.submit('保存', () => [write('src/a.hs', 'source')], true), /准备草稿失败/)
  assert.equal(sent.length, 0); assert.equal(tx.stagedWrites().length, 1)
  await tx.submit('不相关的皮肤修改', () => [write('.hanshu/skinmanager/library.json', '{}')])
  assert.equal(sent.length, 1)
  await tx.retry(tx.getSnapshot().transactions[0].id)
  assert.equal(attempts, 2); assert.equal(sent[1].length, 2)
})
await test('同路径缓存写入串行，最终草稿和镜像均为最新输入', async () => {
  const { tx, sent } = fixture(); const gate = deferred(); const mirrors: string[] = []
  tx.stageWrite(write('assets/a.lang', 'old'), async () => { await gate.promise; mirrors.push('old') })
  tx.stageWrite(write('assets/a.lang', 'new'), () => { mirrors.push('new') })
  const saving = tx.submit('保存', () => [], true)
  gate.resolve(); await saving
  assert.deepEqual(mirrors, ['old', 'new']); assert.equal(sent[0][0].data, 'new')
})
await test('收集期间发生编辑会重新收集，避免正文与译文混用版本', async () => {
  const { tx, sent } = fixture(); const gate = deferred(); let collects = 0; let text = 'before'
  const saving = tx.submit('保存', async () => {
    const captured = text
    if (++collects === 1) await gate.promise
    return [write('src/a.hs', captured)]
  }, true)
  await Promise.resolve(); await Promise.resolve(); text = 'after'; tx.changed(); gate.resolve()
  await saving
  assert.equal(collects, 2); assert.equal(sent[0][0].data, 'after')
})
await test('提交途中产生的新语言草稿不会被成功响应清除', async () => {
  const gate = deferred(); const { tx, sent, versions } = fixture(async () => { await gate.promise; versions.set('assets/a.lang','acknowledged-own-version') })
  tx.stageWrite(write('assets/a.lang', 'first'))
  const saving = tx.submit('保存', () => [], true)
  while (!sent.length) await Promise.resolve()
  tx.stageWrite(write('assets/a.lang', 'second'))
  gate.resolve(); await saving
  assert.equal(sent[0][0].data, 'first'); assert.equal(tx.stagedText('assets/a.lang'), 'second')
  assert.equal(tx.stagedWrites()[0].version, 'acknowledged-own-version', 'New draft must retain the acknowledged own base across reconnect')
})
await test('失败保留原内容和基线，重试不收集新草稿也不采用远端版本', async () => {
  let fail = true; const { tx, versions, sent } = fixture(async () => { if (fail) throw new ServiceError('locked', 'locked') })
  versions.set('src/a.hs', 'version-1'); let content = 'original submission'
  await assert.rejects(tx.submit('保存', () => [write('src/a.hs', content)]))
  assert.equal(tx.getSnapshot().transactions[0].phase, 'conflict')
  versions.set('src/a.hs', 'version-2'); content = 'new unsaved draft'; fail = false
  await tx.retry(1)
  assert.equal(sent[1][0].data, 'original submission'); assert.equal(sent[1][0].version, 'version-1')
})
await test('未处理失败阻止关联路径重复提交，但允许不相关资源继续保存', async () => {
  let fail = true; const { tx, sent } = fixture(async () => { if (fail) throw new Error('offline') })
  await assert.rejects(tx.submit('旧提交', () => [write('src/a.hs', 'old')]))
  fail = false
  await assert.rejects(tx.submit('新提交', () => [write('src/a.hs', 'new')]), /未处理的提交/)
  await tx.submit('独立物品修改', () => [write('src/items/item.item', 'item')])
  assert.equal(sent.length, 2)
  tx.forget(1); await tx.submit('重新组织', () => [write('src/a.hs', 'new')])
  assert.equal(sent[2][0].data, 'new')
})
await test('原提交备份包含文本、二进制和版本，不含凭证', async () => {
  const { tx } = fixture(async () => { throw new Error('failed') })
  await assert.rejects(tx.submit('保存', () => [write('src/a.hs', '你好'), {op:'write',path:'assets/audio.ogg',data:new Uint8Array([1,2,3]),version:'old'}]))
  const backup = JSON.parse(await (await tx.backup(1)).text())
  assert.equal(backup.format, 'hanshu.edit-backup')
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(backup.changes[0].content), c => c.charCodeAt(0))), '你好')
  assert.equal(backup.changes[1].content, 'AQID'); assert.equal(backup.changes[1].version, 'old')
  assert.ok(!JSON.stringify(backup).includes('token'))
})
await test('提交响应丢失与确定拒绝区分，原批次保留且不盲目覆盖', async () => {
  const { tx } = fixture(async () => { throw new ServiceError('commit_uncertain', '结果待确认') })
  await assert.rejects(tx.submit('保存', () => [write('src/a.hs', 'draft')]))
  assert.equal(tx.getSnapshot().transactions[0].phase, 'uncertain')
})
await test('真实 TextSink 只暂存语言，ProjectClient 将正文与语言一起提交', async () => {
  const previous = globalThis.fetch; const commits: {changes: {path:string;content:string}[]}[] = []
  const snapshot = { role:'editor', projectId:'test' } as Snapshot
  globalThis.fetch = async (input, init) => {
    const path = String(input)
    const body = JSON.parse(init?.body as string || '{}')
    const json = (value: unknown) => new Response(JSON.stringify(value), {status:200,headers:{'Content-Type':'application/json'}})
    if (path.includes('/api/files/content')) return json({ content:btoa('{}'),version:'old-lang' })
    if (path.endsWith('/api/files/leases')) return json(body.paths.map((p: string) => ({id:`lease:${p}`,resourceId:`file:${p}`})))
    if (path.endsWith('/api/files/commit')) { commits.push(body); return json({transactionId:body.transactionId,status:'committed',error:null,tree:{revision:2,entries:body.changes.map((e: FileEdit) => ({path:e.path,kind:'file',version:'new',size:1}))}}) }
    if (path.endsWith('/api/files')) return json({revision:2,entries:commits.flatMap(c=>c.changes.map(e=>({path:e.path,kind:'file',version:'new',size:1})))})
    throw new Error(`Unexpected request: ${path}`)
  }
  try {
    const client = new ProjectClient({url:'http://test.invalid',token:'secret'}, snapshot)
    let mirror = ''
    const sink = await createTextSink({project:{handle:client.root()} as never,fileName:'assets/zh_cn/lang_hs/a.lang',virtual:{read:()=>null,write:async content=>{await Promise.resolve();mirror=content}}})
    sink.write('{"line":"你好"}')
    assert.equal(commits.length, 0)
    await client.transactions.submit('保存', () => [write('src/hanshu/a.hs', 'line')], true)
    assert.equal(commits.length, 1); assert.equal(commits[0].changes.length, 2); assert.equal(mirror, '{"line":"你好"}')
    assert.equal(client.texts.get('src/hanshu/a.hs'), 'line')
  } finally { globalThis.fetch = previous }
})

function journalFixture() {
  let records: PendingSubmission[] = []
  let fail = false
  const journal: EditJournal = {
    async load() { return structuredClone(records) },
    async save(next) { if (fail) throw new Error('quota exceeded'); records = structuredClone(next) },
  }
  return { journal, fail(value: boolean) { fail = value }, records: () => structuredClone(records) }
}

await test('确定拒绝换新编号，未知结果重试和只查询保留原编号', async () => {
  let phase = 0
  const { tx, attempts, sent } = fixture(async () => {
    if (phase++ === 0) throw new ServiceError('locked', 'rejected')
    if (phase < 4) throw new ServiceError('commit_uncertain', 'unknown')
  })
  await assert.rejects(tx.submit('保存', () => [write('src/a.hs', 'original')]))
  await assert.rejects(tx.retry(1))
  assert.notEqual(attempts[0].transactionId, attempts[1].transactionId)
  await assert.rejects(tx.confirm(1))
  assert.equal(attempts[2].queryOnly, true)
  assert.equal(attempts[2].uncertain, true)
  assert.equal(attempts[1].transactionId, attempts[2].transactionId)
  await tx.retry(1)
  assert.equal(attempts[2].transactionId, attempts[3].transactionId)
  assert.equal(attempts[3].queryOnly, false)
  assert.equal(sent[3][0].data, 'original')
})

await test('本地日志持久化失败不发送，恢复存储后才允许重试', async () => {
  const local = journalFixture(); const { tx, sent } = fixture()
  await tx.restore(local.journal)
  local.fail(true)
  await assert.rejects(tx.submit('保存', () => [write('src/a.hs', 'draft')]), /quota/)
  assert.equal(sent.length, 0)
  assert.match(tx.getSnapshot().journalError, /保存本地提交记录失败/)
  assert.equal(tx.submission(1)[0].data, 'draft')
  local.fail(false); await tx.retry(1)
  assert.equal(sent.length, 1)
  assert.equal(local.records().length, 0)
})

await test('未知事务恢复二进制原载荷和原版本，持久化失败也不更换编号', async () => {
  const local = journalFixture()
  const first = fixture(async () => { throw new ServiceError('commit_uncertain', 'lost reply') })
  await first.tx.restore(local.journal)
  const bytes = new Uint8Array([0, 255, 1, 42])
  const blob = new Blob([new Uint8Array([9, 8, 7])], {type:'audio/ogg'})
  await assert.rejects(first.tx.submit('binary', () => [
    {op:'write',path:'assets/a.bin',data:bytes,version:'original-version'},
    {op:'write',path:'assets/voice.ogg',data:blob,version:null},
  ]))
  bytes[0] = 99
  const originalId = first.attempts[0].transactionId
  const restored = fixture()
  await restored.tx.restore(local.journal)
  local.fail(true)
  await assert.rejects(restored.tx.retry(1), /quota/)
  assert.equal(restored.sent.length, 0)
  assert.equal(restored.tx.getSnapshot().transactions[0].phase, 'uncertain')
  assert.equal(restored.tx.getSnapshot().transactions[0].requestId, originalId)
  local.fail(false); await restored.tx.retry(1)
  assert.equal(restored.attempts[0].transactionId, originalId)
  assert.equal(restored.attempts[0].uncertain, true)
  assert.deepEqual([...restored.sent[0][0].data as Uint8Array], [0, 255, 1, 42])
  assert.equal(restored.sent[0][0].version, 'original-version')
  assert.deepEqual([...new Uint8Array(await (restored.sent[0][1].data as Blob).arrayBuffer())], [9,8,7])
})

await test('排队的原事务重试仍阻止前方重叠新提交，避免未知事务被绕过', async () => {
  const gate = deferred(); let first = true
  const { tx, sent } = fixture(async edits => {
    if (edits[0].path === 'src/a.hs' && first) { first = false; throw new ServiceError('commit_uncertain', 'unknown') }
    if (edits[0].path === 'src/unrelated.hs') await gate.promise
  })
  await assert.rejects(tx.submit('原事务', () => [write('src/a.hs','original')]))
  const unrelated = tx.submit('无关事务', () => [write('src/unrelated.hs','unrelated')])
  const overlap = assert.rejects(tx.submit('重叠新事务', () => [write('src/a.hs','new')]), /未处理的提交/)
  const retry = tx.retry(1)
  gate.resolve()
  await Promise.all([unrelated, overlap, retry])
  assert.deepEqual(sent.map(edits => edits[0].data), ['original','unrelated','original'])
  assert.equal(tx.getSnapshot().transactions.some(t => t.label === '重叠新事务'), false)
})

type WireCall = {path:string; method:string; body:Record<string, unknown>}
type CommitBody = {transactionId:string;changes:FileChange[]}
const baseVersion = '1'.repeat(64)
const nextVersion = '2'.repeat(64)
const laterVersion = '3'.repeat(64)
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status, headers:{'Content-Type':'application/json'}})
const tree = (version = nextVersion, revision = 2): ProjectFileTree => ({revision,entries:[{path:'src/a.hs',kind:'file',version,size:5}]})
const committed = (id: string, snapshot = tree()): FileTransactionReceipt => ({transactionId:id,status:'committed',tree:snapshot,error:null})
type WireFixture = {
  client:ProjectClient; calls:WireCall[]
  onCommit:(body:CommitBody)=>Response|Promise<Response>
  onQuery:(id:string)=>Response|Promise<Response>
  onLease:(paths:string[])=>Response|Promise<Response>
  currentTree:ProjectFileTree
}
async function wireTest(run: (mock:WireFixture)=>Promise<void>) {
  const previous = globalThis.fetch
  const client = new ProjectClient({url:'http://unit.invalid',token:'not-persisted'}, {role:'editor',projectId:'unit-project',session:{subjectId:'unit-subject'}} as Snapshot)
  client.tree = tree(baseVersion, 1); client.baseline.set('src/a.hs',baseVersion); client.texts.set('src/a.hs','base')
  const mock:WireFixture = {
    client, calls:[], currentTree:tree(),
    onCommit: body => json(committed(body.transactionId)),
    onQuery: () => json({code:'not_found',message:'unknown'},404),
    onLease: paths => json(paths.map(path => ({id:`lease:${path}`,resourceId:`file:${path}`,sessionId:'session',expiresAt:Date.now()+30000}))),
  }
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname
    const body = JSON.parse(init?.body as string || '{}')
    const method = init?.method ?? 'GET'
    mock.calls.push({path,method,body})
    if (path === '/api/files/leases') return method === 'DELETE' ? json({ok:true}) : mock.onLease(body.paths)
    if (path === '/api/files/commit') return mock.onCommit(body)
    if (path.startsWith('/api/files/transactions/')) return mock.onQuery(decodeURIComponent(path.split('/').at(-1)!))
    if (path === '/api/files') return json(mock.currentTree)
    throw new Error(`Unexpected request ${method} ${path}`)
  }
  try { await run(mock) } finally { globalThis.fetch = previous }
}

await test('真实客户端确认结果先查回执，已提交后即使只读且无写权也不重发', async () => wireTest(async mock => {
  let id = ''; let acknowledged = 0
  mock.onCommit = body => { id=body.transactionId; throw new TypeError('lost response') }
  mock.client.onSaved = () => { acknowledged++ }
  await assert.rejects(mock.client.apply([write('src/a.hs','draft')]))
  mock.client.snapshot.role = 'viewer'
  mock.onQuery = requested => { assert.equal(requested,id); return json(committed(id)) }
  const before = mock.calls.length
  await mock.client.transactions.confirm(1)
  const calls = mock.calls.slice(before)
  assert.ok(calls[0].path.startsWith('/api/files/transactions/'))
  assert.equal(calls.some(call => call.path === '/api/files/leases' && call.method === 'POST'),false)
  assert.equal(calls.some(call => call.path === '/api/files/commit'),false)
  assert.equal(acknowledged,1)
  assert.equal(mock.client.transactions.getSnapshot().transactions[0].phase,'saved')
}))

await test('真实客户端只查询未知编号不会申请写权或发送提交', async () => wireTest(async mock => {
  mock.onCommit = () => { throw new TypeError('request was lost') }
  await assert.rejects(mock.client.apply([write('src/a.hs','draft')]))
  const initialId = mock.client.transactions.getSnapshot().transactions[0].requestId
  const before = mock.calls.length
  await assert.rejects(mock.client.transactions.confirm(1))
  assert.equal(mock.calls.length-before,1)
  assert.ok(mock.calls[before].path.endsWith(initialId))
  assert.equal(mock.client.transactions.getSnapshot().transactions[0].phase,'uncertain')
  assert.equal(mock.client.transactions.getSnapshot().transactions[0].requestId,initialId)
}))

await test('未知查询401和查询404后的写权失败均保留原提交身份', async () => wireTest(async mock => {
  mock.onCommit = () => { throw new TypeError('lost response') }
  await assert.rejects(mock.client.apply([write('src/a.hs','draft')]))
  const initialId = mock.client.transactions.getSnapshot().transactions[0].requestId
  mock.onQuery = () => json({code:'unauthorized',message:'expired'},401)
  const before = mock.calls.length
  await assert.rejects(mock.client.transactions.retry(1))
  assert.equal(mock.calls.length-before,1)
  assert.equal(mock.client.transactions.getSnapshot().transactions[0].phase,'uncertain')
  mock.onQuery = () => json({code:'not_found',message:'not received'},404)
  mock.onLease = () => json({code:'locked',message:'another session'},423)
  await assert.rejects(mock.client.transactions.retry(1))
  assert.equal(mock.client.transactions.getSnapshot().transactions[0].phase,'uncertain')
  assert.equal(mock.client.transactions.getSnapshot().transactions[0].requestId,initialId)
  assert.deepEqual(mock.calls.slice(-2).map(c=>c.path),[`/api/files/transactions/${initialId}`,'/api/files/leases'])
}))

for (const [label, invalid] of [
  ['null', () => null],
  ['缺少结果', (id:string) => ({transactionId:id})],
  ['错误编号', () => committed('different-transaction')],
  ['拒绝但没有错误内容', (id:string) => ({transactionId:id,status:'rejected',tree:null,error:null})],
  ['树结构无效', (id:string) => ({...committed(id),tree:{revision:2,entries:[null]}})],
] as const) {
  await test(`无效回执（${label}）不能清除草稿或标记成功`, async () => wireTest(async mock => {
    let saved = 0
    mock.onCommit = body => json(invalid(body.transactionId))
    mock.client.onSaved = () => { saved++ }
    await assert.rejects(mock.client.apply([write('src/a.hs','draft')]))
    assert.equal(saved,0)
    assert.equal(mock.client.transactions.getSnapshot().transactions[0].phase,'uncertain')
    assert.equal(mock.client.transactions.submission(1)[0].data,'draft')
    assert.equal(mock.client.texts.get('src/a.hs'),'base')
  }))
}

await test('未知重放保留最终已冻结版本，正文和二进制内容不因重连变化', async () => wireTest(async mock => {
  const local = journalFixture()
  await mock.client.transactions.restore(local.journal)
  let sent:CommitBody|undefined
  mock.onCommit = body => { sent=body; throw new TypeError('lost request') }
  await assert.rejects(mock.client.apply([{op:'write',path:'src/a.hs',data:new Uint8Array([1,2,3]),version:baseVersion}]))
  const before = structuredClone(sent!)
  mock.client.baseline.set('src/a.hs',laterVersion)
  mock.onCommit = body => { assert.deepEqual(body,before); return json(committed(body.transactionId)) }
  const beforeRetry = mock.calls.length
  await mock.client.transactions.retry(1)
  assert.ok(mock.calls[beforeRetry].path.startsWith('/api/files/transactions/'))
  assert.equal(mock.calls[beforeRetry+1].path,'/api/files/leases')
}))

await test('采用服务器的部分与实际写入组成同一个版本检查事务', async () => wireTest(async mock => {
  let submitted:CommitBody|undefined
  mock.onCommit = body => { submitted=body; return json(committed(body.transactionId,{revision:2,entries:[...tree().entries,{path:'assets/a.lang',kind:'file',version:baseVersion,size:3}]})) }
  await mock.client.apply([write('src/a.hs','resolved'),{op:'write',path:'assets/a.lang',version:baseVersion,data:'server',adopt:true}])
  assert.equal(submitted!.changes.length,2)
  assert.equal(submitted!.changes[1].op,'check')
  assert.equal(submitted!.changes[1].content,null)
  assert.equal(submitted!.changes[1].version,baseVersion)
  assert.equal(submitted!.changes[0].op,'write')
}))

await test('恢复冲突后直接手动合并会清除原语言暂存，不会下次保存覆盖合并结果', async () => {
  const local = journalFixture()
  const original = fixture(async () => { throw new ServiceError('conflict','remote changed') })
  await original.tx.restore(local.journal)
  original.versions.set('assets/a.lang','base')
  original.tx.stageWrite(write('assets/a.lang','original draft'))
  await assert.rejects(original.tx.submit('保存语言',()=>[],true))
  assert.deepEqual(local.records()[0].stagedPaths,['assets/a.lang'])

  const restored = fixture()
  await restored.tx.restore(local.journal)
  restored.tx.stageWrite({op:'write',path:'assets/a.lang',data:'original draft',version:'base'})
  await restored.tx.resolve(1,[{op:'write',path:'assets/a.lang',data:'manual merge',version:'remote'}])
  assert.equal(restored.sent[0][0].data,'manual merge')
  assert.equal(restored.tx.stagedText('assets/a.lang'),undefined)
  assert.equal(restored.tx.stagedWrites().length,0)
})

await test('恢复冲突后的新语言输入与合并期间新输入均保留，并前移到确认版本', async () => {
  for (const timing of ['before-resolution','during-resolution']) {
    const local = journalFixture()
    const original = fixture(async()=>{throw new ServiceError('conflict','remote changed')})
    await original.tx.restore(local.journal)
    original.tx.stageWrite({op:'write',path:'assets/a.lang',data:'original draft',version:'base'})
    await assert.rejects(original.tx.submit('保存',()=>[],true))
    const gate = deferred()
    const restored = fixture(async()=>{await gate.promise; restored.versions.set('assets/a.lang','acknowledged')})
    await restored.tx.restore(local.journal)
    restored.tx.stageWrite({op:'write',path:'assets/a.lang',data:timing==='before-resolution'?'newer draft':'original draft',version:'base'})
    const resolution = restored.tx.resolve(1,[{op:'write',path:'assets/a.lang',data:'manual merge',version:'remote'}])
    while(!restored.sent.length) await Promise.resolve()
    if(timing==='during-resolution') restored.tx.stageWrite({op:'write',path:'assets/a.lang',data:'newer draft',version:'base'})
    gate.resolve(); await resolution
    assert.equal(restored.tx.stagedText('assets/a.lang'),'newer draft',timing)
    assert.equal(restored.tx.stagedWrites()[0].version,'acknowledged',timing)
  }
})

await test('移除失败记录的持久化失败保留内存阻塞，不能趁等待绕过失败事务', async () => {
  const local = journalFixture()
  const {tx,sent} = fixture(async()=>{throw new ServiceError('locked','locked')})
  await tx.restore(local.journal)
  await assert.rejects(tx.submit('原失败',()=>[write('src/a.hs','draft')]))
  local.fail(true)
  await assert.rejects(tx.forget(1),/quota/)
  assert.equal(tx.getSnapshot().transactions[0].phase,'conflict')
  assert.equal(tx.submission(1)[0].data,'draft')
  local.fail(false)
  await assert.rejects(tx.submit('重复提交',()=>[write('src/a.hs','bypass')]),/未处理的提交/)
  assert.equal(sent.length,1)
  await tx.forget(1)
  assert.equal(tx.getSnapshot().transactions.length,0)
  assert.equal(local.records().length,0)
})

await test('移除记录持久化期间禁止重试同记录，后续独立提交不会被移除动作丢失', async () => {
  const local = journalFixture(); const gate = deferred(); let waitForRemoval=false
  const journal:EditJournal={load:()=>local.journal.load(),save:async records=>{if(waitForRemoval&&!records.length)await gate.promise;await local.journal.save(records)}}
  let fail=true; const {tx,sent}=fixture(async()=>{if(fail)throw new ServiceError('locked','locked')})
  await tx.restore(journal)
  await assert.rejects(tx.submit('失败',()=>[write('src/a.hs','draft')]))
  fail=false;waitForRemoval=true
  const removal=tx.forget(1)
  await assert.rejects(tx.retry(1),/不能重试/)
  const unrelated=tx.submit('后续提交',()=>[write('src/b.hs','kept')])
  gate.resolve();await Promise.all([removal,unrelated])
  assert.equal(tx.getSnapshot().transactions.length,1)
  assert.equal(tx.getSnapshot().transactions[0].label,'后续提交')
  assert.equal(tx.getSnapshot().transactions[0].phase,'saved')
  assert.equal(sent[1][0].data,'kept')
})

await test('视图通知发生在原暂存清除和新草稿基线更新之后，通知失败保留原事务编号', async () => {
  const gate=deferred();const {tx,versions,attempts,sent}=fixture(async()=>{await gate.promise;versions.set('assets/new.lang','ack')})
  tx.stageWrite(write('assets/old.lang','saved'))
  tx.stageWrite(write('assets/new.lang','submitted'))
  let notifications=0
  tx.onSettled = replayed => {
    notifications++
    assert.equal(tx.stagedText('assets/old.lang'),undefined)
    assert.equal(tx.stagedText('assets/new.lang'),'newer')
    assert.equal(tx.stagedWrites()[0].version,'ack')
    if(!replayed)throw new Error('view unavailable')
  }
  const save=tx.submit('保存',()=>[],true)
  while(!sent.length)await Promise.resolve()
  tx.stageWrite(write('assets/new.lang','newer'))
  gate.resolve();await assert.rejects(save,/本地视图更新未完成/)
  const originalId=attempts[0].transactionId
  assert.equal(tx.getSnapshot().transactions[0].phase,'uncertain')
  await tx.retry(1)
  assert.equal(attempts[1].transactionId,originalId)
  assert.equal(notifications,2)
  assert.equal(tx.getSnapshot().transactions[0].phase,'saved')
})

await test('语言镜像完成后重新捕获缓存epoch，原版本和三方比较基线保持不变', async () => {
  let epoch=1;let actual:FileEdit[]=[]
  const tx=new EditTransactions(edits=>edits.map(edit=>({...edit,version:edit.version??'base',baseData:edit.baseData??'original',cacheEpoch:edit.cacheEpoch??epoch,localEpochs:edit.localEpochs??{[edit.path]:epoch}})),async edits=>{actual=edits})
  tx.stageWrite(write('assets/a.lang','draft'),async()=>{await Promise.resolve();epoch=2})
  await tx.submit('保存',()=>[],true)
  assert.equal(actual[0].cacheEpoch,2)
  assert.equal(actual[0].localEpochs?.['assets/a.lang'],2)
  assert.equal(actual[0].version,'base')
  assert.equal(actual[0].baseData,'original')
})

await test('成功提交后新草稿的三方比较正文也前移到确认版本', async () => {
  const gate=deferred();let version='base';let baseData='original';let sent=false
  const tx=new EditTransactions(edits=>edits.map(edit=>({...edit,version:edit.version??version,baseData:edit.baseData??baseData})),async()=>{sent=true;await gate.promise;version='ack';baseData='first submission'})
  tx.stageWrite(write('assets/a.lang','first submission'))
  const save=tx.submit('保存',()=>[],true)
  while(!sent)await Promise.resolve()
  tx.stageWrite(write('assets/a.lang','newer local draft'))
  gate.resolve();await save
  assert.equal(tx.stagedWrites()[0].version,'ack')
  assert.equal(tx.stagedWrites()[0].baseData,'first submission')
  assert.equal(tx.stagedWrites()[0].data,'newer local draft')
})

await test('请求体被HTTP大小限制拒绝时是确定失败，允许移除记录保留草稿', async () => wireTest(async mock => {
  mock.onCommit = () => new Response('length limit exceeded', {status:413})
  mock.client.transactions.stageWrite(write('src/a.hs','draft'))
  await assert.rejects(mock.client.transactions.submit('大批次',()=>[],true), /超过服务允许的大小/)
  assert.equal(mock.client.transactions.getSnapshot().transactions[0].phase,'failed')
  assert.equal(mock.client.transactions.getSnapshot().transactions[0].code,'payload_too_large')
  await mock.client.transactions.forget(1)
  assert.equal(mock.client.transactions.stagedText('src/a.hs'),'draft')
}))

console.log(`编辑事务验证完成：${checks} 项通过，${failures.length} 项失败。`)
if (failures.length) throw new Error(`编辑事务验证失败：${failures.join('；')}`)
