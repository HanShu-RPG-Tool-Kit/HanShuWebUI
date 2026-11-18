/**
 * 失败卡片三选项（阶段 4-B / 草案 D3）验收。
 *
 * 覆盖：
 * ① 只有 `pendingRollback` 存在时才有卡片；三个选项按钮齐全；
 * ② `status === 'failed'` 才多出「重试回滚」，并逐项展示未恢复文件；
 * ③ 点击映射到对应 runtime 方法（用假 runtime 断言调用次数与结果文案）；
 * ④ 「让 Agent 帮忙处理冲突」拼出的中文消息包含文件路径与原因；
 * ⑤ 用户主动停止：卡片标题「已停止，改动保留为草稿」，只提供回滚本次改动 / 保留改动；
 * ⑥ 进行中态下所有按钮互斥禁用。
 *
 * 跑法：node scripts/run-verification.mjs scripts/verify-agent-rollback-ui.ts
 */

import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  RollbackCard,
  composeConflictMessage,
  describeManualRollbackFailure,
  executeRollbackAction,
  formatRollbackFailures,
} from '../src/AgentPanel'
import type { PendingRollback, UndoConflict, UndoOutcome } from '../src/agent/contracts'

const CONFLICTS: UndoConflict[] = [
  { path: '序章.hs', channel: 'source', reason: 'human_editing' },
  { path: 'assets/zh_cn/lang_hs/序章.lang', channel: 'lang', reason: 'version_stale' },
]

function pending(overrides: Partial<PendingRollback> = {}): PendingRollback {
  return {
    status: 'pending',
    conflicts: CONFLICTS,
    runItemId: 'run-1',
    createdAt: 1,
    ...overrides,
  }
}

const noop = () => undefined

function renderCard(
  rollback: PendingRollback | null,
  busy: 'help' | 'force' | 'abandon' | 'retry' | null = null,
  disabled = false,
  notice?: string,
): string {
  return renderToStaticMarkup(
    createElement(RollbackCard, {
      pending: rollback,
      busy,
      disabled,
      notice,
      onHelp: noop,
      onForce: noop,
      onAbandon: noop,
      onRetry: noop,
    }),
  )
}

/* ── ① 没有 pendingRollback 就没有卡片 ── */
assert.equal(renderCard(null), '', '没有待处理回滚时不渲染失败卡片')

const html = renderCard(pending())
assert.ok(html.includes('回滚待处理'), '有 pendingRollback 时显示卡片')
assert.ok(html.includes('让 Agent 帮忙处理冲突'), '选项一：让 Agent 帮忙处理冲突')
assert.ok(html.includes('强制回滚'), '选项二：强制回滚')
assert.ok(html.includes('放弃回滚'), '选项三：放弃回滚')
assert.ok(!html.includes('重试回滚'), 'status=pending 时没有重试回滚')
assert.ok(!html.includes('回滚失败'), 'status=pending 时不显示失败标签')
assert.ok(html.includes('序章.hs'), '冲突文件路径可见')
assert.ok(html.includes('编辑器里还有未保存修改'), '冲突原因用中文展示')

/* ── ①′ 用户主动停止：只问「回滚本次改动 / 保留改动」，不是失败 ── */
const stoppedHtml = renderCard(pending({ reason: 'stopped', conflicts: [] }))
assert.ok(stoppedHtml.includes('已停止，改动保留为草稿'), '停止卡片标题说明改动已保留为草稿')
assert.ok(stoppedHtml.includes('停止后待处理'), '停止卡片与失败卡片的 aria-label 区分')
assert.ok(stoppedHtml.includes('回滚本次改动'), '停止后可以主动回滚本次改动')
assert.ok(stoppedHtml.includes('保留改动'), '停止后可以保留改动')
assert.ok(!stoppedHtml.includes('回滚待处理'), '停止不是失败，不显示失败标题')
assert.ok(!stoppedHtml.includes('让 Agent 帮忙处理冲突'), '停止后默认不引入 Agent 处理冲突')
assert.ok(!stoppedHtml.includes('强制回滚'), '停止后默认不显示强制回滚')
assert.ok(!stoppedHtml.includes('放弃回滚'), '停止后按钮文案是「保留改动」')
assert.equal(
  (stoppedHtml.match(/disabled=""/g) ?? []).length,
  0,
  '停止卡片默认两个操作都可用',
)

const stoppedBusyHtml = renderCard(pending({ reason: 'stopped', conflicts: [] }), 'retry')
assert.equal((stoppedBusyHtml.match(/disabled=""/g) ?? []).length, 2, '停止卡片回滚中两个按钮都禁用')

const stoppedFailedHtml = renderCard(
  pending({ reason: 'stopped', status: 'failed', conflicts: [] }),
  null,
  false,
  '回滚未完成',
)
assert.ok(stoppedFailedHtml.includes('让 Agent 帮忙处理冲突'), '停止后回滚失败仍可让 Agent 处理冲突')
assert.ok(stoppedFailedHtml.includes('强制回滚'), '停止后回滚失败仍可强制回滚')
assert.ok(stoppedFailedHtml.includes('保留改动'), '回滚失败后仍可保留改动')
assert.equal(
  (stoppedFailedHtml.match(/disabled=""/g) ?? []).length,
  0,
  '停止后回滚失败卡片按钮都可用',
)

/* ── ② failed 才多出重试，并逐项展示未恢复文件 ── */
const failedOutcomes: UndoOutcome[] = [
  { path: '序章.hs', channel: 'source', action: 'skipped', reason: 'version_stale' },
  { path: 'other.hs', channel: 'source', action: 'restored' },
]
const failedHtml = renderCard(
  pending({ status: 'failed', outcomes: failedOutcomes }),
  null,
  false,
  '回滚未完成',
)
assert.ok(failedHtml.includes('重试回滚'), 'status=failed 时显示重试回滚')
assert.ok(failedHtml.includes('未恢复：序章.hs（之后被改过）'), '逐项展示失败项与原因')
assert.ok(!failedHtml.includes('other.hs'), '成功恢复的文件不列进失败项')
assert.ok(failedHtml.includes('回滚未完成'), '展示执行后的短提示')

/* ── ⑤ 进行中态：按钮互斥禁用 + 进行中文案 ── */
const busyHtml = renderCard(pending(), 'force')
assert.ok(busyHtml.includes('回滚中…'), '执行中的按钮显示进行中文案')
assert.equal(
  (busyHtml.match(/disabled=""/g) ?? []).length,
  3,
  '进行中时三个（或四个）按钮全部禁用',
)
const busyFailedHtml = renderCard(pending({ status: 'failed' }), 'retry')
assert.equal((busyFailedHtml.match(/disabled=""/g) ?? []).length, 4, 'failed 时四个按钮全禁用')
const runningHtml = renderCard(pending(), null, true)
assert.equal((runningHtml.match(/disabled=""/g) ?? []).length, 3, 'Run 运行中同样禁用全部按钮')

/* ── ④ 冲突消息：包含路径、原因与“先读再改”的约束 ── */
const message = composeConflictMessage(CONFLICTS)
assert.ok(message.includes('序章.hs'))
assert.ok(message.includes('assets/zh_cn/lang_hs/序章.lang'))
assert.ok(message.includes('编辑器里还有未保存修改'))
assert.ok(message.includes('之后被改过'))
assert.ok(message.includes('不要覆盖我后来的修改'))
assert.ok(message.includes('告诉我改了哪些文件'))

const many = composeConflictMessage(
  Array.from({ length: 25 }, (_, index) => ({
    path: `f${index}.hs`,
    channel: 'source' as const,
    reason: 'version_stale' as const,
  })),
)
assert.ok(many.includes('……等 25 个文件'), '冲突过多时截断避免刷屏')

/* ── ③ 动作映射到 runtime 方法（假 runtime 计数） ── */
{
  const calls = { force: 0, abandon: 0, retry: 0 }
  const runtime = {
    forceRollback: async () => {
      calls.force += 1
      return [
        { path: 'a.hs', channel: 'source' as const, action: 'restored' as const },
      ]
    },
    abandonRollback: async () => {
      calls.abandon += 1
    },
    retryRollback: async () => {
      calls.retry += 1
      return { ok: true, outcomes: [], conflicts: [] }
    },
  }
  assert.deepEqual(await executeRollbackAction(runtime, 'force'), {
    ok: true,
    message: '已强制回滚',
  })
  assert.deepEqual(await executeRollbackAction(runtime, 'abandon'), {
    ok: true,
    message: '已放弃回滚',
  })
  assert.deepEqual(await executeRollbackAction(runtime, 'retry'), {
    ok: true,
    message: '已回滚',
  })
  assert.deepEqual(calls, { force: 1, abandon: 1, retry: 1 }, '每个选项只调对应的方法')
}

/* ── ③ 失败项暴露：force/retry 的部分失败不静默 ── */
{
  const forceResult = await executeRollbackAction(
    {
      forceRollback: async () => [
        { path: 'b.hs', channel: 'source' as const, action: 'skipped' as const, reason: 'no_before_image' },
      ],
      abandonRollback: async () => undefined,
      retryRollback: async () => ({ ok: false, outcomes: [], conflicts: [] }),
    },
    'force',
  )
  assert.equal(forceResult.ok, false)
  assert.ok(forceResult.message.includes('b.hs'))
  assert.ok(forceResult.message.includes('没有写前快照'))

  const retryResult = await executeRollbackAction(
    {
      forceRollback: async () => [],
      abandonRollback: async () => undefined,
      retryRollback: async () => ({
        ok: false,
        outcomes: [],
        conflicts: [{ path: 'c.hs', channel: 'source' as const, reason: 'human_editing' as const }],
      }),
    },
    'retry',
  )
  assert.equal(retryResult.ok, false)
  assert.ok(retryResult.message.includes('c.hs'))
  assert.ok(retryResult.message.includes('编辑器里还有未保存修改'))
}

assert.deepEqual(formatRollbackFailures([]), [])
assert.deepEqual(
  formatRollbackFailures([
    { path: 'ok.hs', channel: 'source', action: 'restored' },
    { path: 'skip.hs', channel: 'lang', action: 'skipped', reason: 'unavailable' },
  ]),
  ['skip.hs（当前不支持回滚该文件）'],
)

/* ── ⑥ 手动回滚失败摘要：保留 error + 只列前 5 个冲突 + 总数 ── */
assert.equal(
  describeManualRollbackFailure({
    ok: false,
    rolledBackRuns: [],
    outcomes: [],
    conflicts: [],
  }),
  '回滚未完成',
  '没有 error/冲突时给兜底文案',
)
const manyConflicts = Array.from({ length: 7 }, (_, index) => ({
  path: `f${index}.hs`,
  channel: 'source' as const,
  reason: 'human_editing' as const,
}))
const manualFailure = describeManualRollbackFailure({
  ok: false,
  rolledBackRuns: [],
  outcomes: [],
  conflicts: manyConflicts,
  error: '有文件被后续轮次改过',
})
assert.ok(manualFailure.includes('有文件被后续轮次改过'), '保留 runtime error')
assert.ok(manualFailure.includes('f0.hs'), '展示冲突文件')
assert.ok(!manualFailure.includes('f5.hs'), '只列前 5 个冲突文件')
assert.ok(manualFailure.includes('……等 7 个文件'), '冲突总数仍然可见')

console.log(
  '通过：失败卡片三选项（仅 pending 出现、failed 才有重试、动作映射 runtime、冲突消息、互斥禁用）；停止卡片（回滚/保留、失败后才出现强制与 Agent）；手动回滚失败摘要',
)
