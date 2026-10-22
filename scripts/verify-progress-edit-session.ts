import assert from 'node:assert/strict'
import { ProgressEditSession, type ProgressSessionAdapter, type ProgressSessionRecovery } from '../src/workspaces/progress/progressEditSession'
import { applyProgressEffects, coalesceProgressEffects, progressDocumentEffects, progressSlot, sameProgressValue, type ProgressAcknowledgement, type ProgressCommand, type ProgressEffect } from '../src/workspaces/progress/progressOperations'
import { createProgress, parseProgress, stringifyProgress } from '../src/workspaces/progress/progressDoc'

const document = () => ({ ...createProgress(), id: 'document-a', goals: [{ id: 'goal-a', kind: 'counter', config: { target: 1, bonus: 3 } }] })
const wait = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
function fixture(recovery?: ProgressSessionRecovery) {
  let state = { source: stringifyProgress(document()), languages: { zh_cn: { name: '标题', description: '' } } as Record<string, Record<string, string>>, revision: 1 }
  let saved: ProgressSessionRecovery | null = null
  let hold: Promise<void> | null = null
  let fail: string | null = null
  const records = new Map<number, { requestId: string; phase: string; message: string }>()
  const acks = new Map<string, ProgressAcknowledgement>()
  const sent: { requestId: string; command: ProgressCommand }[] = []
  let next = 0
  const adapter: ProgressSessionAdapter = {
    read: async () => structuredClone(state),
    submit(command) {
      const id = ++next, requestId = `tx-${id}`
      records.set(id, { requestId, phase: 'submitting', message: '' }); sent.push({ requestId, command: structuredClone(command) })
      const completion = (async () => {
        if (hold) await hold
        if (fail) throw new Error(fail)
        const effects = command.command === 'apply' ? command.changes : acks.get(command.transactionId)!.result.effects.map(effect => ({ target: effect.target, expected: effect.value, value: effect.expected }))
        for (const effect of effects) if (!sameProgressValue(progressSlot(state, effect.target), effect.expected)) throw new Error('conflict')
        state = { ...applyProgressEffects(state, effects), revision: state.revision + 1 }
        const ack = { transactionId: requestId, result: { path: 'src/progress/a.progress', documentId: 'document-a', source: state.source, effects, languages: [] } }
        acks.set(requestId, ack); records.set(id, { requestId, phase: 'saved', message: '' }); return ack
      })().catch(error => { records.set(id, { requestId, phase: 'conflict', message: String(error) }); throw error })
      return { id, requestId, completion }
    },
    record: id => records.get(id), acknowledgement: requestId => acks.get(requestId), recover: async requestId => acks.get(requestId) ?? null,
    reinstate: async attempt => { const id = ++next; records.set(id, { requestId: attempt.requestId, phase: 'uncertain', message: 'unknown' }); return id },
    forget: async id => { records.delete(id) }, dirty() {}, persist: value => { saved = value ? structuredClone(value) : null },
  }
  const session = new ProgressEditSession(state, adapter, recovery)
  return { session, sent, records, acks, adapter, get state() { return state }, get saved() { return saved },
    setHold(value: Promise<void> | null) { hold = value }, setFail(value: string | null) { fail = value },
    peer(change: Partial<ReturnType<typeof document>>) { state = { ...state, source: stringifyProgress({ ...parseProgress(state.source), ...change }), revision: state.revision + 1 } },
  }
}
let passed = 0
async function test(name: string, run: () => Promise<void> | void) { await run(); passed++; console.log(`通过：${name}`) }
await test('参数变更使用目标身份与单参数 CAS，其他字段保持独立', () => {
  const before = document(), after = structuredClone(before); after.goals[0].config.target = 8
  assert.deepEqual(progressDocumentEffects(stringifyProgress(before), stringifyProgress(after)), [{ target: { kind: 'goal-config', goalId: 'goal-a', goalKind: 'counter', key: 'target' }, expected: { present: true, value: 1 }, value: { present: true, value: 8 } }])
})
await test('等待回执时继续输入，原操作冻结且下一次沿用自己的已确认值', async () => {
  const f = fixture(); await f.session.initialize(); const held = gate(); f.setHold(held.promise)
  f.session.editText('zh_cn', 'name', '第一次', true); await wait()
  f.session.editText('zh_cn', 'name', '第二次'); assert.equal(f.session.getSnapshot().view.languages.zh_cn.name, '第二次')
  held.release(); f.setHold(null); await f.session.flush()
  assert.equal(f.state.languages.zh_cn.name, '第二次'); assert.equal(f.sent.length, 2)
  const second = f.sent[1].command; assert.equal(second.command, 'apply'); if (second.command === 'apply') assert.equal(second.changes[0].expected.value, '第一次')
})
await test('同字段失败保留原始前提和后续输入，显式采用服务器才舍弃', async () => {
  const f = fixture(); await f.session.initialize(); f.setFail('conflict')
  f.session.editText('zh_cn', 'name', '我的标题'); await assert.rejects(f.session.flush())
  f.session.editText('zh_cn', 'description', '新描述'); await assert.rejects(f.session.flush())
  assert.equal(f.sent.length, 1); assert.equal(f.session.getSnapshot().view.languages.zh_cn.description, '新描述')
  await f.session.resolveFailure(false); assert.equal(f.session.getSnapshot().view.languages.zh_cn.name, '标题'); assert.equal(f.session.getSnapshot().dirty, false)
})
await test('远端更新只刷新未触及字段，不给草稿偷偷换 CAS 基线', async () => {
  const f = fixture(); await f.session.initialize()
  const next = parseProgress(f.session.getSnapshot().view.source); next.authorNotes = '本地备注'; f.session.editSource(stringifyProgress(next))
  f.peer({ authorNotes: '远端备注', completion: 'any' }); await f.session.refresh()
  assert.equal(parseProgress(f.session.getSnapshot().view.source).completion, 'any')
  await assert.rejects(f.session.flush()); assert.equal(parseProgress(f.session.getSnapshot().view.source).authorNotes, '本地备注')
})
await test('撤销与重做只提交服务端回执的逆操作，保留协作者其他字段', async () => {
  const f = fixture(); await f.session.initialize()
  const next = parseProgress(f.session.getSnapshot().view.source); next.completion = 'any'; f.session.editSource(stringifyProgress(next)); await f.session.flush()
  f.peer({ authorNotes: '协作者' }); await f.session.refresh(); await f.session.undo()
  assert.equal(parseProgress(f.state.source).completion, 'all'); assert.equal(parseProgress(f.state.source).authorNotes, '协作者')
  await f.session.undo(true); assert.equal(parseProgress(f.state.source).completion, 'any'); assert.equal(f.sent[2].command.command, 'revert')
})
await test('撤销碰到协作者修改同字段时拒绝，撤销栈和当前值均保留', async () => {
  const f = fixture(); await f.session.initialize()
  const next = parseProgress(f.session.getSnapshot().view.source); next.authorNotes = '我'; f.session.editSource(stringifyProgress(next)); await f.session.flush()
  f.peer({ authorNotes: '协作者' }); await assert.rejects(f.session.undo())
  assert.equal(parseProgress(f.state.source).authorNotes, '协作者'); assert.equal(f.session.getSnapshot().canUndo, true)
  f.session.editText('zh_cn', 'description', '后续输入'); f.session.pauseText()
  await assert.rejects(f.session.resolveFailure(true)); assert.ok(f.session.getSnapshot().active)
  await f.session.resolveFailure(false); await f.session.flush()
  assert.equal(parseProgress(f.state.source).authorNotes, '协作者'); assert.equal(f.state.languages.zh_cn.description, '后续输入')
})
await test('IME 组合输入期间不提交，结束时只提交完成文字', async () => {
  const f = fixture(); await f.session.initialize(); f.session.composition(true); f.session.editText('zh_cn', 'name', '拼音')
  await wait(600); assert.equal(f.sent.length, 0)
  f.session.editText('zh_cn', 'name', '中文'); f.session.composition(false); await f.session.flush()
  assert.equal(f.sent.length, 1); assert.equal(f.state.languages.zh_cn.name, '中文')
})
await test('尚未提交的配置和类型切换合成一次原始主体 CAS', () => {
  const original = document(), first = structuredClone(original), second = structuredClone(first)
  first.goals[0].config.target = 4; second.goals[0] = { id: 'goal-a', kind: 'other', config: { target: 9, bonus: 2 } }
  const effects = coalesceProgressEffects([...progressDocumentEffects(stringifyProgress(original), stringifyProgress(first)), ...progressDocumentEffects(stringifyProgress(first), stringifyProgress(second))])
  assert.equal(effects.length, 1); assert.equal(effects[0].target.kind, 'goal-body'); assert.deepEqual(effects[0].expected.value, { kind: 'counter', config: { target: 1, bonus: 3 } })
})
await test('新增目标后的参数输入仍保持一个新增节点操作', () => {
  const before = document(), added = structuredClone(before); added.goals.push({ id: 'goal-b', kind: 'counter', config: { target: 2, bonus: 0 } })
  const edited = structuredClone(added); edited.goals[1].config.target = 10
  const effects = coalesceProgressEffects([...progressDocumentEffects(stringifyProgress(before), stringifyProgress(added)), ...progressDocumentEffects(stringifyProgress(added), stringifyProgress(edited))])
  assert.equal(effects.length, 2); assert.equal((effects.find(effect => effect.target.kind === 'goal')!.value.value as { config: { target: number } }).config.target, 10)
})
await test('窗口恢复保留未提交草稿及预期值，缺失 outbox 重建同一请求号', async () => {
  const f = fixture(); await f.session.initialize(); f.session.editText('zh_cn', 'name', '草稿'); f.session.pauseText()
  const recovered = fixture(f.saved!); await recovered.session.initialize(); recovered.session.pauseText()
  assert.equal(recovered.session.getSnapshot().view.languages.zh_cn.name, '草稿')
  const recovery = structuredClone(f.saved!); recovery.pending = []; recovery.active = { id: 88, requestId: 'original-id', mode: 'edit', command: { command: 'apply', documentId: 'document-a', changes: f.saved!.pending } }
  const uncertain = fixture(recovery); await uncertain.session.initialize()
  assert.equal(uncertain.session.getSnapshot().active?.requestId, 'original-id'); assert.equal(uncertain.records.get(1)?.phase, 'uncertain'); assert.equal(uncertain.sent.length, 0)
})
await test('文本合并只影响相同语言同一个键', () => {
  const make = (locale: string, key: string, before: string, after: string): ProgressEffect => ({ target: { kind: 'locale', locale, key }, expected: { present: true, value: before }, value: { present: true, value: after } })
  assert.equal(coalesceProgressEffects([make('zh_cn', 'name', 'A', 'B'), make('zh_cn', 'name', 'B', 'C'), make('en_us', 'name', 'A', 'D'), make('zh_cn', 'description', '', 'E')]).length, 3)
})
await test('可选备注和非间隔重复方式与服务端规范化一致', () => {
  const raw = JSON.parse(stringifyProgress(document())); delete raw.authorNotes; raw.repeat.hours = 60
  const state = { source: JSON.stringify(raw), languages: {} }
  assert.deepEqual(progressSlot(state, { kind: 'field', field: 'authorNotes' }), { present: true, value: '' })
  assert.deepEqual(progressSlot(state, { kind: 'field', field: 'repeat' }), { present: true, value: { kind: 'once' } })
})
await test('已缓存回执但原 outbox 仍待确认时不提前移除原操作', async () => {
  const f = fixture(); await f.session.initialize(); f.setFail('uncertain')
  f.session.editText('zh_cn', 'name', '我的标题'); await assert.rejects(f.session.flush())
  const active = f.session.getSnapshot().active!
  f.records.set(active.id, { requestId: active.requestId, phase: 'uncertain', message: '本地刷新失败' })
  f.acks.set(active.requestId, { transactionId: active.requestId, result: { path: 'a', documentId: 'document-a', source: f.state.source, effects: [], languages: [] } })
  await f.session.reconcile(); assert.equal(f.session.getSnapshot().active?.requestId, active.requestId)
  f.records.set(active.id, { requestId: active.requestId, phase: 'saved', message: '' }); await f.session.reconcile(); assert.equal(f.session.getSnapshot().active, null)
})
await test('页面内提交编号被复用时恢复仍按原请求身份查找', async () => {
  const original = fixture(); await original.session.initialize(); original.session.editText('zh_cn', 'name', '草稿'); original.session.pauseText()
  const recovery = structuredClone(original.saved!); recovery.active = { id: 1, requestId: 'old-request', mode: 'edit', command: { command: 'apply', documentId: 'document-a', changes: recovery.pending } }; recovery.pending = []
  const fresh = fixture(); fresh.records.set(1, { requestId: 'other-request', phase: 'saved', message: '' })
  const session = new ProgressEditSession(fresh.state, fresh.adapter, recovery)
  await session.initialize(); assert.equal(session.getSnapshot().active?.requestId, 'old-request')
})
await test('参数和语言键按字面量访问，不将对象继承属性当作默认值', () => {
  const state = { source: stringifyProgress(document()), languages: { zh_cn: {} } }
  const target = { kind: 'goal-config' as const, goalId: 'goal-a', goalKind: 'counter', key: '__proto__' }
  assert.deepEqual(progressSlot(state, target), { present: false, value: null })
  const effects: ProgressEffect[] = [{ target, expected: { present: false, value: null }, value: { present: true, value: 'safe' } }, { target: { kind: 'locale', locale: 'zh_cn', key: 'constructor' }, expected: { present: false, value: null }, value: { present: true, value: '文字' } }]
  const next = applyProgressEffects(state, effects)
  assert.equal(progressSlot(next, target).value, 'safe'); assert.equal(next.languages.zh_cn.constructor, '文字')
})
await test('同一路径被新文档替换时冻结原身份，不把未提交输入改绑到新文档', async () => {
  const f = fixture(); await f.session.initialize(); f.session.composition(true); f.session.editText('zh_cn', 'name', '旧文档草稿')
  f.peer({ id: 'replacement-document' }); await assert.rejects(f.session.refresh())
  f.session.composition(false); await assert.rejects(f.session.flush())
  assert.equal(f.sent.length, 0); assert.equal(f.session.getSnapshot().view.languages.zh_cn.name, '旧文档草稿')
  assert.equal(JSON.parse(f.session.getSnapshot().view.source).id, 'document-a'); assert.equal(f.session.getSnapshot().replaced, true)
  await f.session.openReplacement(); assert.equal(JSON.parse(f.session.getSnapshot().view.source).id, 'replacement-document'); assert.equal(f.session.getSnapshot().dirty, false)
})
await test('完整草稿导出包含最新本地语言、源文件、原始预期及冻结请求', async () => {
  const f = fixture(); await f.session.initialize(); f.setFail('conflict')
  const next = parseProgress(f.session.getSnapshot().view.source); next.completion = 'any'; f.session.editSource(stringifyProgress(next)); await assert.rejects(f.session.flush())
  f.session.editText('zh_cn', 'name', '尚未提交的标题'); f.session.pauseText()
  const backup = f.session.backup()
  assert.equal(JSON.parse(backup.source).completion, 'any'); assert.equal(backup.languages.zh_cn.name, '尚未提交的标题')
  assert.equal(backup.pending[0].expected.value, '标题'); assert.equal(backup.active?.requestId, 'tx-1')
  backup.languages.zh_cn.name = '修改导出对象不改变编辑器'; assert.equal(f.session.getSnapshot().view.languages.zh_cn.name, '尚未提交的标题')
})
await test('冲突处理等待服务器期间独立禁用输入，结束后恢复编辑', async () => {
  const f = fixture(); await f.session.initialize(); f.setFail('conflict')
  f.session.editText('zh_cn', 'name', '待处理标题'); await assert.rejects(f.session.flush())
  const held = gate(), read = f.adapter.read; f.adapter.read = async () => { await held.promise; return read() }
  const resolving = f.session.resolveFailure(false); assert.equal(f.session.getSnapshot().resolving, true)
  f.session.editText('zh_cn', 'description', '禁用期间的过期事件')
  assert.equal(f.session.getSnapshot().view.languages.zh_cn.description, '')
  held.release(); await resolving; assert.equal(f.session.getSnapshot().resolving, false)
  f.session.editText('zh_cn', 'description', '恢复编辑'); f.session.pauseText(); assert.equal(f.session.getSnapshot().view.languages.zh_cn.description, '恢复编辑')
})
await test('取消失败操作时移除记录的通知不会重新恢复已取消的请求', async () => {
  const f = fixture(); await f.session.initialize(); f.setFail('conflict')
  f.session.editText('zh_cn', 'name', '失败草稿'); await assert.rejects(f.session.flush())
  let reinstated = 0
  f.adapter.reinstate = async () => { reinstated++; return 99 }
  f.adapter.forget = async id => { f.records.delete(id); void f.session.reconcile() }
  await f.session.resolveFailure(false); await wait()
  assert.equal(reinstated, 0); assert.equal(f.session.getSnapshot().active, null)
  assert.equal(f.session.getSnapshot().error, '')
  assert.equal(f.session.getSnapshot().view.languages.zh_cn.name, '标题')
})
await test('批量同步只丢冲突字段，保留并提交其他字段', async () => {
  const f=fixture();await f.session.initialize();f.session.composition(true)
  const next=parseProgress(f.session.getSnapshot().view.source);next.authorNotes='本机备注';next.completion='any'
  f.session.editSource(stringifyProgress(next));f.session.pauseText()
  f.peer({authorNotes:'远端备注'});await f.session.refresh();f.session.composition(false)
  await assert.rejects(f.session.flush())
  await f.session.synchronize()
  assert.equal(parseProgress(f.state.source).authorNotes,'远端备注')
  assert.equal(parseProgress(f.state.source).completion,'any')
  assert.equal(f.session.getSnapshot().dirty,false)
})
console.log(`进度编辑会话 ${passed} 组通过。`)
