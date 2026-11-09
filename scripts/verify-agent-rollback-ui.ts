/**
 * 失败卡片三选项（阶段 4-B / 草案 D3）验收。
 *
 * 覆盖：
 * ① 只有 `pendingRollback` 存在时才有卡片；三个选项按钮齐全；
 * ② `status === 'failed'` 才多出「重试回滚」，并逐项展示未恢复文件；
 * ③ 点击映射到对应 runtime 方法（用假 runtime 断言调用次数与结果文案）；
 * ④ 「让 Agent 帮忙处理冲突」拼出的中文消息包含文件路径与原因；
 * ⑤ 进行中态下所有按钮互斥禁用。
 *
 * 跑法：node scripts/run-verification.mjs scripts/verify-agent-rollback-ui.ts
 */

import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  RollbackCard,
  composeConflictMessage,
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

console.log(
  '通过：失败卡片三选项（仅 pending 出现、failed 才有重试、动作映射 runtime、冲突消息、互斥禁用）',
)
