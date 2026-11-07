/**
 * 工具仲裁层验收（文档 §8 严格模式 + 「写后哈希自更新」）。
 *
 * 跑法：`node scripts/run-verification.mjs scripts/verify-agent-arbiter.ts`
 *
 * 用内存假宿主 + 真 LockTable / RunUndoLog / RuntimeArbiter：
 * 不碰浏览器 API，但走的是生产同一套锁与撤销代码。
 */

import assert from 'node:assert/strict'
import { RuntimeArbiter } from '../src/agent/pi/arbiter'
import { LockTable } from '../src/agent/runtime/lockTable'
import { RunUndoLog } from '../src/agent/runtime/runUndo'
import { contentVersion } from '../src/agent/runtime/version'
import type { AgentFileWorld, AgentHost } from '../src/agent/contracts'

const files = new Map<string, string>([
  ['序章.hs', '第一行\n'],
  ['角色.hs', '旧卡\n'],
])

const host = {
  readFullSource: (source: string) => {
    const content = files.get(source)
    return content === undefined ? { ok: false, error: `未找到文件：${source}` } : { ok: true, content }
  },
  readSource: (source: string) => host.readFullSource(source),
  writeSource: (source: string, content: string) => {
    files.set(source, content)
    return { ok: true, source }
  },
  createSource: (source: string, content: string) => {
    files.set(source, content)
    return { ok: true, source, created: true }
  },
  deleteSource: async (source: string) => {
    files.delete(source)
    return { ok: true, source }
  },
  isHumanDirty: () => false,
} as unknown as AgentHost

const world: AgentFileWorld = {
  read: async (path) => {
    const content = files.get(path)
    if (content === undefined) return null
    return { content, version: await contentVersion(content) }
  },
  isHumanDirty: (path) => host.isHumanDirty?.(path) === true,
  write: async (path, content) => {
    if (content === null) files.delete(path)
    else files.set(path, content)
  },
}

const RUN = 'run-1'
const locks = new LockTable(world)
const undo = new RunUndoLog(world)
const arbiter = new RuntimeArbiter({ host, locks, undo, runKey: () => RUN })

let checks = 0
const failures: string[] = []
async function test(name: string, run: () => Promise<void>) {
  try {
    await run()
    checks += 1
    console.log(`通过：${name}`)
  } catch (error) {
    failures.push(name)
    console.error(`失败：${name}`, error)
  }
}

await test('read 返回内容哈希，并让同一 Run 可以按这一版加锁', async () => {
  const read = await arbiter.read('序章.hs')
  assert.equal(read.ok, true)
  assert.equal(read.version, await contentVersion('第一行\n'))
  const locked = await arbiter.lock(['序章.hs'])
  assert.equal(locked.locked, true)
  const writable = await arbiter.assertWritable('序章.hs')
  assert.equal(writable.ok, true)
  await arbiter.endRound()
})

await test('未持锁的写被拒绝，且提示下一步', async () => {
  const denied = await arbiter.assertWritable('角色.hs')
  assert.equal(denied.ok, false)
  if (!denied.ok) {
    assert.ok(denied.hint?.includes('lock_source'), denied.hint)
  }
})

await test('写成功后哈希自更新：同一 Run 重新加锁不必再读一遍', async () => {
  await arbiter.read('角色.hs')
  const locked = await arbiter.lock(['角色.hs'])
  assert.equal(locked.locked, true)
  const writable = await arbiter.assertWritable('角色.hs')
  assert.equal(writable.ok, true)

  files.set('角色.hs', '新卡\n') // 模拟宿主真正落盘
  await arbiter.noteWritten('角色.hs')

  // 不再 read，直接再锁：agent 应该知道自己刚写的文件长什么样
  const relocked = await arbiter.lock(['角色.hs'])
  assert.equal(relocked.locked, true, '写后版本应已更新，不该判 version_stale / not_read')
  if (relocked.locked) {
    assert.equal(relocked.content, '新卡\n')
    assert.equal(relocked.version, await contentVersion('新卡\n'))
  }
  const rewritable = await arbiter.assertWritable('角色.hs')
  assert.equal(rewritable.ok, true)
  await arbiter.endRound()
})

await test('新建：先占名（creating）再写；写完同样更新版本', async () => {
  const locked = await arbiter.lock(['新文件.hs'], { creating: true })
  assert.equal(locked.locked, true)
  const writable = await arbiter.assertWritable('新文件.hs', { creating: true })
  assert.equal(writable.ok, true)
  files.set('新文件.hs', '内容\n')
  await arbiter.noteWritten('新文件.hs')

  const relocked = await arbiter.lock(['新文件.hs'])
  assert.equal(relocked.locked, true)
  if (relocked.locked) assert.equal(relocked.content, '内容\n')
  await arbiter.endRound()
})

await test('撤销日志记下写前映像，回滚后文件回到旧内容', async () => {
  await arbiter.read('序章.hs')
  await arbiter.lock(['序章.hs'])
  await arbiter.assertWritable('序章.hs')
  files.set('序章.hs', '改坏了\n')
  await arbiter.noteWritten('序章.hs')
  assert.equal(files.get('序章.hs'), '改坏了\n')

  const outcomes = await undo.rollback(RUN)
  undo.discard(RUN)
  assert.equal(files.get('序章.hs'), '第一行\n', '回滚应恢复到写前内容')
  const own = outcomes.find((item) => item.path === '序章.hs')
  assert.equal(own?.action, 'restored')
  // 逆序回放：本 Run 新建的文件最先被撤销（before 为 null → deleted）
  assert.equal(outcomes[0]?.path, '新文件.hs')
  assert.equal(outcomes[0]?.action, 'deleted')
})

console.log(`\n通过 ${checks} 项，失败 ${failures.length} 项。`)
if (failures.length > 0) {
  console.error(`失败项：${failures.join('、')}`)
  process.exitCode = 1
}
