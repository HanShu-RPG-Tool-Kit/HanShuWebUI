/**
 * Agent 面板纯函数视图派生测试。
 *
 * 跑法：`node scripts/run-verification.mjs scripts/verify-agent-panel.ts`
 *
 * 只测 `src/agent/view/derive.ts`：不渲染 React、不碰 localStorage / IndexedDB，
 * 因此可以在 Node 里直接断言。覆盖：视图行派生、失败 Run 记录与回滚摘要、
 * 归档段库占用阈值分级、Key 掩码、时间与文本格式化。
 */

import assert from 'node:assert/strict'
import {
  STORAGE_DANGER_BYTES,
  STORAGE_WARN_BYTES,
  appendRunFailure,
  clipText,
  contextReference,
  deriveMessageRows,
  describeError,
  formatBytes,
  formatClock,
  formatDateTime,
  maskApiKey,
  runStateLabel,
  segmentOptionLabel,
  segmentStateLabel,
  storageUsageHint,
  storageUsageLevel,
  storageUsagePercent,
  summarizeUndo,
} from '../src/agent/view/derive'
import type { AgentRunResult, AgentViewItem, SegmentInfo, UndoOutcome } from '../src/agent/contracts'

/* ── 视图行派生：1:1 保持 id 与顺序，流式/工具语义不丢 ── */
const items: AgentViewItem[] = [
  { id: 'u1', kind: 'user', text: '把序章.hs 的第二行改一下' },
  { id: 'a1', kind: 'assistant', text: '好的，先读文件。', streaming: true },
  { id: 't1', kind: 'tool', name: 'read_source', status: 'running', output: '第一行\n第二行' },
  { id: 't2', kind: 'tool', name: 'write_source', status: 'done' },
  { id: 'e1', kind: 'error', text: '版本已变，write 被拒绝' },
  { id: 'n1', kind: 'notice', text: '已按版本守卫回滚' },
]
const rows = deriveMessageRows(items)
assert.deepEqual(
  rows.map((row) => row.id),
  ['u1', 'a1', 't1', 't2', 'e1', 'n1'],
  '派生的行必须与 view.items 同序同 id（React key 依赖它）',
)
assert.deepEqual(
  rows.map((row) => row.kind),
  ['user', 'assistant', 'tool', 'tool', 'error', 'notice'],
)
assert.equal(rows[0].roleLabel, '你')
assert.equal(rows[1].roleLabel, 'Agent')
assert.equal(rows[1].streaming, true, 'assistant.streaming 要透传，面板据此显示光标')
assert.equal(rows[1].thinking, undefined, '没有思考内容时不渲染思考块')
assert.equal(rows[2].tool?.name, 'read_source')
assert.equal(rows[2].tool?.status, 'running')
assert.equal(rows[2].tool?.output, '第一行\n第二行')
assert.equal(rows[4].roleLabel, '错误')
assert.equal(rows[5].roleLabel, '提示')
const thinkingRows = deriveMessageRows([
  { id: 'a2', kind: 'assistant', text: '答案', thinking: '先看文件再改' },
  { id: 'a3', kind: 'assistant', text: '', thinking: '只有思考' },
])
assert.equal(thinkingRows[0].thinking, '先看文件再改', '思考内容要透传给折叠块')
assert.equal(thinkingRows[1].thinking, '只有思考', '只有思考、没有正文时也要能查看')
assert.equal(deriveMessageRows([]).length, 0)
assert.ok(
  deriveMessageRows([{ id: 'a0', kind: 'assistant', text: '完成' }])[0].streaming === false,
  '缺省 streaming 视为 false，不能显示幽灵光标',
)

/* ── 失败 Run：留记录 + 回滚结论；已覆盖时不重复 ── */
const undo: UndoOutcome[] = [
  { path: '序章.hs', action: 'restored' },
  { path: '新建.hs', action: 'deleted' },
  { path: '角色.hs', action: 'skipped', reason: '被后来的人类编辑覆盖' },
  { path: '已确认.hs', action: 'skipped' },
  { path: '第五个.hs', action: 'skipped' },
  { path: '第六个.hs', action: 'skipped' },
  { path: '其他.hs', action: 'finished' },
]
const undoText = summarizeUndo(undo)
assert.ok(undoText.includes('已自动撤销 1 个文件'), undoText)
assert.ok(undoText.includes('已删掉新建的 1 个文件'), undoText)
assert.ok(undoText.includes('4 个文件之后又被改过'), undoText)
assert.ok(undoText.includes('角色.hs'), '跳过的文件要报出名字')
assert.ok(undoText.includes('等'), '只列前三个，其余用“等”收束')
assert.ok(!undoText.includes('其他.hs'), 'finished 不参与回滚摘要')
assert.equal(summarizeUndo(undefined), '')
assert.equal(summarizeUndo([]), '')
assert.ok(
  summarizeUndo(undefined, false).includes('保留为草稿'),
  'rolledBack=false（刷新/崩溃）必须明说改动仍留在工作区',
)

const failed: AgentRunResult = { ok: false, error: '模型请求超时', undo }
const withFailure = appendRunFailure(rows, failed, 'run-1')
assert.equal(withFailure.length, rows.length + 1, '失败且运行时没写 error 时补一条')
const failureRow = withFailure[withFailure.length - 1]
assert.equal(failureRow.kind, 'error')
assert.equal(failureRow.id, 'run-failure:run-1')
assert.ok(failureRow.text?.includes('模型请求超时'))
assert.ok(failureRow.text?.includes('已自动撤销 1 个文件'), '失败条目要带回滚结论')
assert.equal(appendRunFailure(rows, { ok: true }, 'run-2'), rows, '成功的 Run 不追加任何行')
assert.equal(appendRunFailure(rows, null, null), rows, '没有失败结果时不追加')

const covered = deriveMessageRows([
  { id: 'e9', kind: 'error', text: '模型请求超时' },
])
const coveredRows = appendRunFailure(covered, failed, 'run-3')
assert.equal(coveredRows.length, 2, '运行时已写 error 时不重复报错')
assert.equal(coveredRows[1].kind, 'notice', '只补“回滚”说明')
assert.ok(coveredRows[1].text?.includes('已自动撤销 1 个文件'))

const coveredWithUndo = deriveMessageRows([
  { id: 'e9', kind: 'error', text: `模型请求超时\n\n${undoText}` },
])
assert.equal(
  appendRunFailure(coveredWithUndo, failed, 'run-4').length,
  1,
  '运行时已经把回滚写进 error 时不能再补一条',
)

// 运行时自己的 failureItem 措辞是「已自动撤销 / 没有自动撤销，请手动检查」，
// 与 derive 的 undoText 不同；检测到同义结论就不该再补一条重复的“回滚”提示。
const coveredWithRuntimeWording = deriveMessageRows([
  {
    id: 'e10',
    kind: 'error',
    text: '模型请求超时\n已自动撤销：序章.hs\n这些文件之后又被改过，没有自动撤销，请手动检查：角色.hs',
  },
])
assert.equal(
  appendRunFailure(coveredWithRuntimeWording, failed, 'run-6').length,
  1,
  '运行时已用别的措辞报告回滚时，不再重复追加',
)

assert.ok(
  appendRunFailure(rows, { ok: false }, 'run-5').at(-1)?.text?.includes('可重试'),
  '失败但无原因时也要给出可执行提示',
)

/* ── 归档段占用阈值：50 MB 黄条 / 100 MB 红条（文档 §9） ── */
assert.equal(STORAGE_WARN_BYTES, 50 * 1024 * 1024)
assert.equal(STORAGE_DANGER_BYTES, 100 * 1024 * 1024)
assert.equal(storageUsageLevel(0), 'ok')
assert.equal(storageUsageLevel(STORAGE_WARN_BYTES - 1), 'ok')
assert.equal(storageUsageLevel(STORAGE_WARN_BYTES), 'warn', '到 50 MB 即黄条')
assert.equal(storageUsageLevel(STORAGE_DANGER_BYTES - 1), 'warn')
assert.equal(storageUsageLevel(STORAGE_DANGER_BYTES), 'danger', '到 100 MB 即红条')
assert.equal(storageUsageLevel(Number.NaN), 'ok')
assert.equal(storageUsagePercent(0), 0)
assert.equal(storageUsagePercent(STORAGE_DANGER_BYTES / 2), 50)
assert.equal(storageUsagePercent(STORAGE_DANGER_BYTES * 3), 100, '超过 100 MB 进度条夹到 100')
assert.ok(storageUsageHint(STORAGE_DANGER_BYTES).includes('100 MB'))
assert.ok(storageUsageHint(STORAGE_WARN_BYTES).includes('50 MB'))
assert.ok(storageUsageHint(0).includes('正常'))

assert.equal(formatBytes(0), '0 B')
assert.equal(formatBytes(-1), '0 B')
assert.equal(formatBytes(512), '512 B')
assert.equal(formatBytes(1536), '1.5 KB')
assert.equal(formatBytes(50 * 1024 * 1024), '50 MB')
assert.equal(formatBytes(123 * 1024 * 1024), '123 MB')

/* ── Key 掩码：永不回显明文 ── */
assert.equal(maskApiKey(''), '未配置')
assert.equal(maskApiKey('   '), '未配置')
assert.equal(maskApiKey('sk-123'), 'sk-…', '短 Key 完全遮住')
const masked = maskApiKey('sk-1234567890abcdef')
assert.equal(masked, 'sk-…cdef')
assert.ok(!masked.includes('1234567890'), '掩码不能带出中间明文')
assert.ok(masked.length < 'sk-1234567890abcdef'.length)
assert.equal(maskApiKey('abcdefghijkl'), '…ijkl', '非 sk- 前缀同样只留后四位')

/* ── 时间 / 文案 ── */
const sample = new Date(2026, 0, 2, 3, 4, 5).getTime()
assert.equal(formatClock(sample), '03:04')
assert.equal(formatDateTime(sample), '2026-01-02 03:04')
assert.equal(formatClock(Number.NaN), '--:--')
assert.equal(formatDateTime(Number.NaN), '--')
assert.equal(segmentStateLabel('active'), '活跃')
assert.equal(segmentStateLabel('dormant'), '休眠')
assert.equal(segmentStateLabel('sealed'), '已封存')
assert.equal(runStateLabel('idle'), '空闲')
assert.equal(runStateLabel('running'), '运行中')
assert.equal(runStateLabel('aborted'), '已中止')
assert.equal(runStateLabel('failed'), '失败')
const segment: SegmentInfo = {
  id: 's1',
  title: '序章润色',
  createdAt: sample,
  updatedAt: sample,
  windowId: 'w1',
  state: 'active',
  runCount: 3,
}
assert.equal(segmentOptionLabel(segment), '序章润色 · 3 轮')
assert.equal(segmentOptionLabel({ ...segment, runCount: 0, title: '' }), '未命名段')

/* ── 文本裁剪 / 上下文引用 / 错误文案 ── */
assert.equal(clipText('  hi  '), 'hi', '首尾空白先裁掉')
const longText = 'x'.repeat(1300)
const clipped = clipText(longText)
assert.ok(clipped.startsWith('x'.repeat(1200)))
assert.ok(clipped.includes('已截断'))
assert.ok(clipped.includes('1300'))
assert.equal(clipText('短文本', 10), '短文本')
assert.equal(contextReference(undefined), '')
assert.equal(contextReference('  '), '')
assert.equal(contextReference(' 序章.hs '), '（当前文件：序章.hs）')
assert.equal(describeError(new Error('网络断了')), '网络断了')
assert.equal(describeError('自定义错误'), '自定义错误')
assert.equal(describeError(42), '42')

console.log(
  '通过：Agent 面板视图派生（行 id/流式/工具状态、失败记录与回滚摘要、占用阈值、Key 掩码、时间与文案）',
)
