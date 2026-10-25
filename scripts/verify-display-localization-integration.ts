import {prepareTextEditing,applyTextEditing,rowValue,DISPLAY_TEXT_PROTOCOL} from '../src/gameDevServer/displayTextEditing'
import { ProjectClient, setProjectClient } from '../src/project/serviceClient'
import { loadServiceProject } from '../src/project/projectFs'
import { getProjectSession, setProjectSession } from '../src/project/projectSession'
import { attachReconciliation } from '../src/project/reconcileEdits'
import { openEditJournal } from '../src/project/editJournal'
import { saveLocale } from '../src/storage'
import { parseItem, stringifyItem } from '../src/workspaces/quest/itemDoc'
import { parseEntity, stringifyEntity } from '../src/workspaces/quest/entityDoc'
import {
  LOCALIZATION_PROTOCOL, commitLocalizedResult, localizedResultEdits,
  prepareDisplayLocalization, type LocalizationSession,
} from '../src/gameDevServer/displayLocalization'
import type { DisplayTextKind } from '../src/workspaces/quest/displayTextLocale'
import type { Snapshot } from '../src/collab/protocol'

type Credentials = { token: string; snapshot: Snapshot }
type Bootstrap = { runId: string; owner: Credentials; peer: Credentials; viewer: Credentials; other: Credentials; revocable: Credentials }
type Evidence = { ok: boolean; checks: string[]; error?: string; transport?: unknown }
declare global { interface Window { integrationResult?: Evidence; integrationPeerReady?: boolean } }
const bootstrap: Bootstrap = await (await fetch('/integration-bootstrap')).json()
const actor = new URL(location.href).searchParams.get('actor') ?? 'main'
const channel = new BroadcastChannel(`hanshu.display-integration.${bootstrap.runId}`)
const checks: string[] = []
const equal = (actual: unknown, expected: unknown, message: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error(`${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
}
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw Error(message) }
async function rejects(run: () => Promise<unknown>, pattern: RegExp, message: string) {
  try { await run() } catch (error) { assert(pattern.test(String(error)), `${message}: ${String(error)}`); return error }
  throw Error(`${message}: operation unexpectedly succeeded`)
}
const sourcePath = (kind: DisplayTextKind, name: string) => `src/${kind === 'item' ? 'items' : 'entities'}/${name}.${kind}`
const languagePath = (kind: DisplayTextKind, name: string, locale: string) => `assets/${locale}/lang_${kind}/${name}.lang`
const journal = (role: string) => openEditJournal(`display-integration:${bootstrap.runId}:${role}`)

async function createClient(credentials: Credentials, role: string, other = false) {
  const client = new ProjectClient({ url: other ? '/integration-other' : '/integration-service', token: credentials.token }, structuredClone(credentials.snapshot))
  const loaded = await loadServiceProject(client.root())
  setProjectClient(client)
  setProjectSession(loaded)
  attachReconciliation(client)
  await client.transactions.restore(journal(role))
  return client
}
async function readBatch(client: ProjectClient, kind: DisplayTextKind, name: string) {
  const paths = [sourcePath(kind, name), ...['zh_cn', 'en_us'].map(locale => languagePath(kind, name, locale))]
  return Object.fromEntries(await Promise.all(paths.map(async path => [path, await client.text(path, false)])))
}
function row(kind: DisplayTextKind, name: string) {
  const source = getProjectSession().workspace.packages.flatMap(pkg => pkg.scripts).find(source => source.name === `${name}.${kind}`)
  assert(source, `Missing source ${name}.${kind}`)
  return source
}
async function prepare(kind: DisplayTextKind, name: string) {
  const source = row(kind, name)
  const document = kind === 'item' ? parseItem(source.content) : parseEntity(source.content)
  const session = await prepareDisplayLocalization(source.id, kind, document)
  const candidate = { ...document, tags: ['game-result'] }
  const sourceResult = kind === 'item' ? stringifyItem(candidate as ReturnType<typeof parseItem>) : stringifyEntity(candidate as ReturnType<typeof parseEntity>)
  const operations = (session.localization.bindings.length?['zh_cn', 'en_us']:[]).map(locale => ({
    op: 'translation.set', bindingId: session.localization.bindings[0].bindingId,
    locale, expected: session.localization.bindings[0].translations[locale], value: locale === 'zh_cn' ? '游戏修改名称' : 'Edited in game',
  }))
  return { session, candidate, sourceResult, operations }
}
function localized(frozen: Awaited<ReturnType<typeof prepare>>, operations = frozen.operations) {
  return localizedResultEdits(frozen.session, frozen.candidate, { protocol: LOCALIZATION_PROTOCOL, operations })
}
function frozenTransaction(client: ProjectClient, session: LocalizationSession, phase: string) {
  const transaction = client.transactions.getSnapshot().transactions.find(transaction => transaction.phase === phase && transaction.paths.includes(session.sourcePath))
  assert(transaction, `Missing ${phase} transaction for ${session.sourcePath}`)
  const submission = client.transactions.submission(transaction.id)
  equal(submission.find(edit => edit.path === session.sourcePath)?.version, session.sourceVersion, 'Frozen source version changed')
  for (const table of session.tables.values()) equal(submission.find(edit => edit.path === table.path)?.version, table.version, `Frozen locale version changed ${table.path}`)
  return transaction
}
async function transport(drop = false) {
  return (await fetch('/integration-fault', { method: 'POST', body: drop ? 'drop' : '' })).json()
}
async function test(name: string, run: () => Promise<void>) {
  await run(); checks.push(name)
  document.getElementById('results')!.textContent = checks.map(check => `PASS ${check}`).join('\n')
}

if (actor === 'peer') {
  const client = await createClient(bootstrap.peer, 'peer')
  channel.onmessage = async event => {
    const { id, op, path, data } = event.data ?? {}
    if (event.data?.response || typeof id !== 'string') return
    try {
      if (op === 'write') {
        const snapshot = await client.readSnapshot(path)
        await client.apply([{ op: 'write', path, data, version: snapshot.version }], '另一个窗口的编辑')
      } else if (op !== 'ping') return
      channel.postMessage({ id, response: true, ok: true, sessionId: client.snapshot.session.id })
    } catch (error) { channel.postMessage({ id, response: true, ok: false, error: String(error) }) }
  }
  document.getElementById('results')!.textContent = 'Peer browsing context ready with independent ProjectClient and session'
  window.integrationPeerReady = true
} else {
  const rpc = (op: string, path?: string, data?: string): Promise<{ sessionId: string }> => new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    const timeout = setTimeout(() => { channel.removeEventListener('message', listener); reject(Error(`Peer operation timed out: ${op}`)) }, 15000)
    function listener(event: MessageEvent) {
      if (!event.data?.response || event.data.id !== id) return
      clearTimeout(timeout); channel.removeEventListener('message', listener)
      if (event.data.ok) resolve(event.data); else reject(Error(event.data.error))
    }
    channel.addEventListener('message', listener)
    channel.postMessage({ id, op, path, data })
  })
  try {
    saveLocale('zh_cn')
    let client = await createClient(bootstrap.owner, 'main')
    const peer = await rpc('ping')
    assert(peer.sessionId !== client.snapshot.session.id, 'The two browser windows must use distinct S sessions')
    for (const kind of ['item', 'entity'] as const) {
      await test(`${kind}: 源文档和双语译文通过一个真实事务保存`, async () => {
        const frozen = await prepare(kind, 'happy')
        const before = await transport()
        await commitLocalizedResult(frozen.session, frozen.sourceResult, localized(frozen))
        const after = await transport()
        equal(after.commits.length, before.commits.length + 1, 'Business operation was split into multiple commits')
        equal(after.commits.at(-1).changes.map((change: { path: string }) => change.path).sort(), [sourcePath(kind, 'happy'), languagePath(kind, 'happy', 'en_us'), languagePath(kind, 'happy', 'zh_cn')].sort(), 'Commit did not contain source and both locales')
        const saved = await readBatch(client, kind, 'happy')
        equal(JSON.parse(saved[sourcePath(kind, 'happy')]!).tags, ['game-result'], 'Source was not updated')
        for (const locale of ['zh_cn', 'en_us']) {
          const table = JSON.parse(saved[languagePath(kind, 'happy', locale)]!)
          equal(table['display.custom_name'], locale === 'zh_cn' ? '游戏修改名称' : 'Edited in game', 'Translation did not save')
          equal(table.unrelated, 'Keep unrelated key', 'Unrelated translation was removed')
        }
      })
      await test(`${kind}: 另一窗口只修改源文档，旧源与全部译文整批冲突`, async () => {
        const frozen = await prepare(kind, 'source-conflict')
        const before = await readBatch(client, kind, 'source-conflict')
        const concurrent = JSON.stringify({ ...JSON.parse(before[sourcePath(kind, 'source-conflict')]!), tags: ['concurrent-window-source'] }, null, 2)
        await rpc('write', sourcePath(kind, 'source-conflict'), concurrent)
        await rejects(() => commitLocalizedResult(frozen.session, frozen.sourceResult, localized(frozen)), /版本|改变|冲突|一致|conflict/i, 'Stale source accepted')
        const after = await readBatch(client, kind, 'source-conflict')
        equal(after[sourcePath(kind, 'source-conflict')], concurrent, 'Concurrent source was overwritten')
        for (const locale of ['zh_cn', 'en_us']) equal(after[languagePath(kind, 'source-conflict', locale)], before[languagePath(kind, 'source-conflict', locale)], 'Rejected source transaction partly wrote a translation')
        frozenTransaction(client, frozen.session, 'conflict')
      })
      await test(`${kind}: 另一窗口修改未编辑语言，源文档和当前语言也整批冲突`, async () => {
        const frozen = await prepare(kind, 'locale-conflict')
        const before = await readBatch(client, kind, 'locale-conflict')
        const enPath = languagePath(kind, 'locale-conflict', 'en_us')
        const concurrent = JSON.stringify({ ...JSON.parse(before[enPath]!), 'display.custom_name': 'Concurrent English edit' }, null, 2)
        await rpc('write', enPath, concurrent)
        // The game only changed Chinese. English must remain an atomic check, not disappear from the batch.
        const edits = localized(frozen, frozen.operations.filter(operation => operation.locale === 'zh_cn'))
        assert(edits.find(edit => edit.path === enPath)?.adopt, 'Untouched authorized English was not a CAS check')
        await rejects(() => commitLocalizedResult(frozen.session, frozen.sourceResult, edits), /版本|改变|冲突|一致|conflict/i, 'Stale locale accepted')
        const after = await readBatch(client, kind, 'locale-conflict')
        equal(after[sourcePath(kind, 'locale-conflict')], before[sourcePath(kind, 'locale-conflict')], 'Rejected locale transaction partly wrote source')
        equal(after[languagePath(kind, 'locale-conflict', 'zh_cn')], before[languagePath(kind, 'locale-conflict', 'zh_cn')], 'Rejected locale transaction partly wrote Chinese')
        equal(after[enPath], concurrent, 'Concurrent English was overwritten')
        frozenTransaction(client, frozen.session, 'conflict')
      })
    }
    for(const kind of ['item','entity'] as const){
      await test(`${kind}: 有身份文本会话的模式与双语修改合批保存，重开恢复`,async()=>{
        const frozen=await prepare(kind,'text-session'),text=prepareTextEditing(frozen.session,frozen.candidate),rows=text.open.rows.map(rowValue)
        const name=rows.find(r=>r.field.endsWith('custom_name'))!;name.localized=false;name.literal={text:'Fixed in game',color:'red'};name.translations.en_us='Retained English'
        const applied=applyTextEditing(frozen.session,text,frozen.candidate,{protocol:DISPLAY_TEXT_PROTOCOL,rows})
        await commitLocalizedResult(frozen.session,kind==='item'?stringifyItem(applied.document as ReturnType<typeof parseItem>):stringifyEntity(applied.document as ReturnType<typeof parseEntity>),applied.edits)
        const after=await readBatch(client,kind,'text-session'),stored=JSON.parse(after[sourcePath(kind,'text-session')]!)
        equal(stored.displayTextEditor[`${kind}.custom_name`].localized,false,'Mode was not stored')
        equal(JSON.parse(after[languagePath(kind,'text-session','en_us')]!)['display.custom_name'],'Retained English','Stored English was lost')
        const reopened=await prepare(kind,'text-session'),again=prepareTextEditing(reopened.session,reopened.candidate),restore=again.open.rows.map(rowValue)
        restore.find(r=>r.field.endsWith('custom_name'))!.localized=true
        const restored=applyTextEditing(reopened.session,again,reopened.candidate,{protocol:DISPLAY_TEXT_PROTOCOL,rows:restore})
        await commitLocalizedResult(reopened.session,kind==='item'?stringifyItem(restored.document as ReturnType<typeof parseItem>):stringifyEntity(restored.document as ReturnType<typeof parseEntity>),restored.edits)
        const final=await readBatch(client,kind,'text-session');assert(final[sourcePath(kind,'text-session')]!.includes('hanshu.'),'Original binding did not recover')
        equal(JSON.parse(final[languagePath(kind,'text-session','en_us')]!)['display.custom_name'],'Retained English','Restore overwrote translations')
      })
      await test(`${kind}: 新文本会话保留未编辑语言的 CAS，冲突时整批不写入`,async()=>{
        const frozen=await prepare(kind,'text-conflict'),text=prepareTextEditing(frozen.session,frozen.candidate),rows=text.open.rows.map(rowValue)
        rows.find(r=>r.field.endsWith('custom_name'))!.translations.zh_cn='New text'
        const applied=applyTextEditing(frozen.session,text,frozen.candidate,{protocol:DISPLAY_TEXT_PROTOCOL,rows}),before=await readBatch(client,kind,'text-conflict')
        await rpc('write',languagePath(kind,'text-conflict','en_us'),JSON.stringify({'display.custom_name':'Other author'}))
        await rejects(()=>commitLocalizedResult(frozen.session,kind==='item'?stringifyItem(applied.document as ReturnType<typeof parseItem>):stringifyEntity(applied.document as ReturnType<typeof parseEntity>),applied.edits),/版本|改变|冲突|一致|conflict/i,'Stale new text session accepted')
        const after=await readBatch(client,kind,'text-conflict');equal(after[sourcePath(kind,'text-conflict')],before[sourcePath(kind,'text-conflict')],'Conflict partly changed source');equal(after[languagePath(kind,'text-conflict','zh_cn')],before[languagePath(kind,'text-conflict','zh_cn')],'Conflict partly changed translation')
      })
    }
    await test('丢失真实成功回执后，IndexedDB 恢复冻结请求并按原编号查询，不重复写入', async () => {
      const frozen = await prepare('item', 'unknown')
      const before = await transport(true)
      await rejects(() => commitLocalizedResult(frozen.session, frozen.sourceResult, localized(frozen)), /待确认|可能已经保存|提交结果/i, 'Lost response must be uncertain')
      const pending = frozenTransaction(client, frozen.session, 'uncertain')
      const captured = client.transactions.submission(pending.id)
      const stored = await journal('main').load()
      const durable = stored.find(record => record.requestId === pending.requestId)
      assert(durable, 'Unknown request was not durable in IndexedDB')
      equal(durable.edits, captured, 'Durable recovery altered the frozen payload')
      const disk = await readBatch(client, 'item', 'unknown')
      equal(disk[sourcePath('item', 'unknown')], frozen.sourceResult, 'Fault proxy did not lose a successful response')
      const recovered = await createClient(bootstrap.owner, 'main')
      const restored = frozenTransaction(recovered, frozen.session, 'uncertain')
      equal(restored.requestId, pending.requestId, 'Recovery generated another request ID')
      await recovered.transactions.confirm(restored.id)
      equal(recovered.transactions.getSnapshot().transactions.find(record => record.id === restored.id)?.phase, 'saved', 'Original receipt did not settle recovery')
      const after = await transport()
      equal(after.commits.length, before.commits.length + 1, 'Receipt recovery sent another write')
      assert(after.queries.some((path: string) => path.endsWith(pending.requestId)), 'Recovery did not query the original transaction')
      client = recovered
    })
    await test('真实 viewer 会话不能准备本地化；伪造客户端角色仍被 S 拒绝', async () => {
      const viewer = await createClient(bootstrap.viewer, 'viewer')
      const before = await readBatch(viewer, 'item', 'viewer')
      await rejects(() => prepare('item', 'viewer'), /可写|只读/, 'Viewer prepared an edit')
      viewer.snapshot.role = 'editor'
      await rejects(() => viewer.apply([{ op: 'write', path: sourcePath('item', 'viewer'), data: 'forged viewer source' }]), /权限|只读|授权|forbidden/i, 'S accepted forged C role')
      equal(await readBatch(viewer, 'item', 'viewer'), before, 'Viewer modified project files')
      setProjectClient(client); setProjectSession(await loadServiceProject(client.root()))
    })
    await test('IBE 打开后主体被降为 viewer，旧客户端仍在线也不能提交源文档或译文', async () => {
      const revocable = await createClient(bootstrap.revocable, 'revocable')
      const frozen = await prepare('entity', 'revoke')
      const before = await readBatch(revocable, 'entity', 'revoke')
      await fetch('/integration-revoke', { method: 'POST' })
      assert(revocable.writable, 'This case must retain a stale writable C snapshot')
      await rejects(() => commitLocalizedResult(frozen.session, frozen.sourceResult, localized(frozen)), /权限|只读|授权|forbidden/i, 'S accepted revoked author')
      equal(await readBatch(client, 'entity', 'revoke'), before, 'Revoked subject partly modified project')
      setProjectClient(client); setProjectSession(await loadServiceProject(client.root()))
    })
    await test('断线保留源文档和多语言冻结候选；恢复连接不自动发送旧结果', async () => {
      const frozen = await prepare('entity', 'offline')
      const before = await readBatch(client, 'entity', 'offline')
      const sent = await transport()
      client.setStatus(false)
      await rejects(() => commitLocalizedResult(frozen.session, frozen.sourceResult, localized(frozen)), /离线|只读|切换/, 'Offline result accepted')
      const retained = frozenTransaction(client, frozen.session, 'conflict')
      equal(client.transactions.submission(retained.id).find(edit => edit.path === frozen.session.sourcePath)?.data, frozen.sourceResult, 'Offline source candidate was discarded')
      client.setStatus(true)
      equal((await transport()).commits.length, sent.commits.length, 'Reconnect automatically sent stale result')
      equal(await readBatch(client, 'entity', 'offline'), before, 'Offline result wrote files')
    })
    await test('切换真实工程后旧 IBE 结果留在原工程恢复记录，不写入任一工程', async () => {
      const frozen = await prepare('item', 'switch')
      const original = await readBatch(client, 'item', 'switch')
      const switched = await createClient(bootstrap.other, 'other', true)
      const otherBefore = await readBatch(switched, 'item', 'switch')
      await rejects(() => commitLocalizedResult(frozen.session, frozen.sourceResult, localized(frozen)), /切换/, 'Old reply accepted after project switch')
      frozenTransaction(client, frozen.session, 'conflict')
      equal(await readBatch(client, 'item', 'switch'), original, 'Old project was modified after switching')
      equal(await readBatch(switched, 'item', 'switch'), otherBefore, 'Old result leaked into new project')
    })
    window.integrationResult = { ok: true, checks, transport: await transport() }
  } catch (error) {
    window.integrationResult = { ok: false, checks, error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) }
    document.getElementById('results')!.textContent += `\nFAIL ${window.integrationResult.error}`
  }
  await fetch('/integration-result', { method: 'POST', body: JSON.stringify(window.integrationResult) })
}
