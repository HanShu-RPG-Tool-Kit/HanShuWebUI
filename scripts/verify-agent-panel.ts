/**
 * Agent 面板纯函数视图派生测试。
 *
 * 跑法：`node scripts/run-verification.mjs scripts/verify-agent-panel.ts`
 *
 * 以 `derive.ts` 纯函数为主，另用 SSR 断言消息行/工具行的静态结构；不碰
 * localStorage / IndexedDB，因此可以在 Node 里直接跑。覆盖：视图行派生、失败 Run 记录与回滚摘要、
 * 用户行手动回滚字段与消息图标、输入区回滚按钮的启用条件、
 * 归档段库占用阈值分级、Key 掩码、时间与文本格式化。
 */

import assert from 'node:assert/strict'
import { Fragment, createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MessageList, RollbackNoticeDetails, RunMetaLine } from '../src/agent/view/MessageList'
import {
  AgentPanel,
  ForkButton,
  MANUAL_ROLLBACK_MESSAGE,
  ManualRollbackFailureCard,
  RollbackCard,
  SegmentSealedHint,
  forkAfterRun,
  forkCurrentSegment,
  runAfterInheritingArchive,
} from '../src/AgentPanel'
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
  formatRunDuration,
  formatTokenCount,
  maskApiKey,
  prettyToolText,
  runStateLabel,
  segmentOptionLabel,
  segmentStateLabel,
  storageUsageHint,
  storageUsageLevel,
  storageUsagePercent,
  summarizeUndo,
} from '../src/agent/view/derive'
import type {
  AgentRunResult,
  AgentRuntime,
  AgentRuntimeView,
  AgentViewItem,
  ForkSegmentOptions,
  SegmentInfo,
  UndoOutcome,
} from '../src/agent/contracts'

/* ── 视图行派生：1:1 保持 id 与顺序，流式/工具语义不丢 ── */
const items: AgentViewItem[] = [
  { id: 'u1', kind: 'user', text: '把序章.hs 的第二行改一下' },
  { id: 'a1', kind: 'assistant', text: '好的，先读文件。', streaming: true },
  { id: 't1', kind: 'tool', name: 'read_source', status: 'running', input: '{"source":"序章.hs"}', output: '第一行\n第二行' },
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
assert.equal(rows[2].tool?.input, '{"source":"序章.hs"}', '工具调用参数要透传给展开区')
assert.equal(rows[2].tool?.output, '第一行\n第二行')
assert.equal(rows[4].roleLabel, '错误')
assert.equal(rows[5].roleLabel, '提示')

/* ── 用户行手动回滚字段：runKey / rollbackable / rolledBack 原样透传 ── */
const rollbackItems: AgentViewItem[] = [
  { id: 'u0', kind: 'user', text: '普通消息' },
  { id: 'u1', kind: 'user', text: '可回滚的一轮', runKey: 'run-1', rollbackable: true },
  {
    id: 'u2',
    kind: 'user',
    text: '已经回滚的一轮',
    runKey: 'run-2',
    rollbackable: false,
    rolledBack: true,
  },
]
const rollbackRows = deriveMessageRows(rollbackItems)
assert.equal(rollbackRows[0].runKey, undefined, '普通用户行没有 runKey')
assert.equal(rollbackRows[1].runKey, 'run-1', '可回滚轮次透传 runKey')
assert.equal(rollbackRows[1].rollbackable, true, '可回滚标记透传')
assert.equal(rollbackRows[1].rolledBack, undefined, '未回滚时不带 rolledBack')
assert.equal(rollbackRows[2].rollbackable, false, '已回滚标记透传')
assert.equal(rollbackRows[2].rolledBack, true, 'rolledBack 透传')
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

/* ── 工具行：压成一行，输入/输出是可展开入口，状态用“成功” ── */
const toolHtml = renderToStaticMarkup(
  createElement(MessageList, {
    // 只渲染工具行，避免 SSR 走到 AgentMarkdown（DOMPurify 在 Node 下不可用）
    rows: rows.filter((row) => row.kind === 'tool'),
    status: '',
    resetKey: null,
  }),
)
assert.ok(toolHtml.includes('agent-tool-row'), '工具调用渲染成一行')
assert.ok(toolHtml.includes('agent-tool-tag">工具<'), '一行里带“工具”标签')
assert.ok(toolHtml.includes('read_source'), '一行里带工具名')
assert.ok(toolHtml.includes('输入</button>'), '有调用参数时提供「输入」入口')
assert.ok(toolHtml.includes('输出</button>'), '有输出时提供「输出」入口')
assert.ok(toolHtml.includes('agent-tool-caret'), '展开入口带三角符号')
assert.ok(toolHtml.includes('▸'), '默认收起时三角朝右')
const actionsAt = toolHtml.indexOf('agent-tool-actions')
const statusAt = toolHtml.indexOf('agent-tool-status')
assert.ok(actionsAt > 0 && statusAt > actionsAt, '输入/输出入口在状态左边')
assert.ok(toolHtml.includes('成功'), 'done 状态显示「成功」而不是「完成」')
assert.ok(toolHtml.includes('运行中'), 'running 状态显示「运行中」')
assert.equal((toolHtml.match(/agent-tool-row/g) ?? []).length, 2, '每个工具调用只占一行')
assert.ok(!toolHtml.includes('agent-msg-role">工具'), '不再使用独立的角色行')
assert.ok(!toolHtml.includes('agent-tool-pane'), '输入/输出默认收起')
assert.ok(!toolHtml.includes('序章.hs'), '收起时不把参数内容铺到对话流里')

/* ── 工具输入/输出的 JSON 展示：两空格缩进；非 JSON 原样 ── */
assert.equal(
  prettyToolText('{"source":"阿拉丁神灯.hs"}'),
  '{\n  "source": "阿拉丁神灯.hs"\n}',
  '合法 JSON 按两空格缩进格式化',
)
assert.equal(prettyToolText('第一行\n第二行'), '第一行\n第二行', '非 JSON 文本原样返回')
assert.equal(prettyToolText(undefined), undefined, '没有内容时不产生展示文本')

/* ── 用户消息左侧回滚图标：只在可回滚/已回滚时出现，已回滚置灰 ── */
const rollbackHtml = renderToStaticMarkup(
  createElement(MessageList, {
    rows: rollbackRows,
    status: '',
    resetKey: null,
    onRollbackRun: () => {},
  }),
)
assert.equal(
  (rollbackHtml.match(/agent-msg-rollback/g) ?? []).length,
  2,
  '只有可回滚与已回滚的用户行出现图标',
)
assert.ok(rollbackHtml.includes('aria-label="回滚这一轮的改动"'), '可回滚行给出回滚入口')
assert.ok(rollbackHtml.includes('aria-label="这一轮已回滚"'), '已回滚行说明状态')
assert.ok(
  /<button[^>]*agent-msg-rollback rolled[^>]*disabled/.test(rollbackHtml),
  '已回滚的图标不可再点',
)
assert.ok(
  /<button[^>]*agent-msg-rollback[^>]*>[\s\S]*?<\/button><div class="agent-msg-user-main">/.test(
    rollbackHtml,
  ),
  '图标在用户气泡左侧',
)

/* ── 输入区「回滚」按钮：在发送左边；没有可回滚 Run / 已封存时禁用 ── */
const makeView = (items: AgentViewItem[], segmentSealed = false): AgentRuntimeView => ({
  segmentId: 'seg-1',
  runId: null,
  runState: 'idle',
  items,
  status: '',
  lockedPaths: [],
  segmentSealed,
})
const makeRuntime = (items: AgentViewItem[], segmentSealed = false): AgentRuntime =>
  ({
    view: () => makeView(items, segmentSealed),
    subscribe: () => () => {},
  }) as unknown as AgentRuntime
const renderPanel = (items: AgentViewItem[], segmentSealed = false): string =>
  renderToStaticMarkup(
    createElement(AgentPanel, {
      open: true,
      runtime: makeRuntime(items, segmentSealed),
      onClose: () => {},
      saveBlockedByRun: false,
    }),
  )
const rollbackButtonTag = (html: string): string => {
  const match = html.match(/<button[^>]*agent-manual-rollback[^>]*>/)
  assert.ok(match, '输入区应有回滚按钮')
  return match[0]
}
const activePanel = renderPanel(rollbackItems)
assert.ok(
  activePanel.indexOf('agent-manual-rollback') < activePanel.indexOf('>发送<'),
  '回滚按钮位于发送按钮左侧',
)
assert.ok(!rollbackButtonTag(activePanel).includes('disabled'), '有可回滚 Run 时按钮可用')
assert.ok(
  rollbackButtonTag(renderPanel([{ id: 'u0', kind: 'user', text: '普通消息' }])).includes(
    'disabled',
  ),
  '没有可回滚 Run 时按钮禁用',
)
assert.ok(
  rollbackButtonTag(renderPanel(rollbackItems, true)).includes('disabled'),
  '已封存段按钮禁用',
)

/* ── 手动回滚失败卡片：两个明确出口，关闭不触发强制回滚 ── */
type TestElement = {
  type?: unknown
  props?: {
    children?: unknown
    onClick?: () => void
    disabled?: boolean
    className?: string
  }
}
const collectButtons = (node: unknown, out: TestElement[] = []): TestElement[] => {
  if (Array.isArray(node)) {
    for (const child of node) collectButtons(child, out)
    return out
  }
  if (!node || typeof node !== 'object') return out
  const element = node as TestElement
  if (element.type === 'button') out.push(element)
  collectButtons(element.props?.children, out)
  return out
}
const elementText = (node: unknown): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(elementText).join('')
  if (!node || typeof node !== 'object') return ''
  return elementText((node as TestElement).props?.children)
}
const noop = () => {}
assert.equal(
  renderToStaticMarkup(
    createElement(ManualRollbackFailureCard, {
      failure: null,
      busy: false,
      onForce: noop,
      onClose: noop,
    }),
  ),
  '',
  '没有失败时失败卡片不占位',
)
assert.equal(
  renderToStaticMarkup(
    createElement(RollbackCard, {
      pending: null,
      busy: null,
      onHelp: noop,
      onForce: noop,
      onAbandon: noop,
      onRetry: noop,
    }),
  ),
  '',
  '没有待处理回滚时回滚卡片不占位（两张卡互不抢占）',
)
let forced = 0
let closed = 0
const failureCard = ManualRollbackFailureCard({
  failure: { message: '部分文件已被修改，未执行回滚；冲突：a.hs（版本已变化）' },
  busy: false,
  onForce: () => {
    forced += 1
  },
  onClose: () => {
    closed += 1
  },
}) as unknown
const failureButtons = collectButtons(failureCard)
assert.equal(failureButtons.length, 2, '失败卡片只有两个按钮')
const forceButton = failureButtons.find((button) => elementText(button).includes('强制回滚'))
const closeButton = failureButtons.find((button) => elementText(button).includes('关闭'))
assert.ok(forceButton && closeButton, '按钮文字为「强制回滚」「关闭」')
closeButton.props?.onClick?.()
assert.equal(closed, 1, '「关闭」只回调关闭')
assert.equal(forced, 0, '「关闭」不触发强制回滚')
forceButton.props?.onClick?.()
assert.equal(forced, 1, '「强制回滚」回调强制入口')
const failureHtml = renderToStaticMarkup(
  createElement(ManualRollbackFailureCard, {
    failure: { message: '部分文件已被修改，未执行回滚' },
    busy: false,
    onForce: noop,
    onClose: noop,
  }),
)
assert.ok(failureHtml.includes('回滚未完成'), '失败卡片标题')
assert.ok(failureHtml.includes('agent-manual-rollback-failure'), '失败卡片有独立容器类')
assert.ok(failureHtml.includes('部分文件已被修改，未执行回滚'), '失败卡片展示失败原因')
assert.ok(failureHtml.includes('>强制回滚<') && failureHtml.includes('>关闭<'), '两个出口文案')
const onlyFailureHtml = renderToStaticMarkup(
  createElement(
    Fragment,
    null,
    createElement(RollbackCard, {
      pending: null,
      busy: null,
      onHelp: noop,
      onForce: noop,
      onAbandon: noop,
      onRetry: noop,
    }),
    createElement(ManualRollbackFailureCard, {
      failure: { message: '部分文件已被修改，未执行回滚' },
      busy: false,
      onForce: noop,
      onClose: noop,
    }),
  ),
)
assert.equal(
  (onlyFailureHtml.match(/class="agent-rollback(?:\s|")/g) ?? []).length,
  1,
  '两张卡片同一处渲染时不重复占位',
)
const busyFailureHtml = renderToStaticMarkup(
  createElement(ManualRollbackFailureCard, {
    failure: { message: '部分文件已被修改，未执行回滚' },
    busy: true,
    onForce: noop,
    onClose: noop,
  }),
)
assert.equal(
  (busyFailureHtml.match(/<button[^>]*disabled/g) ?? []).length,
  2,
  '回滚进行中两个按钮都禁用',
)

/* ── 回滚通知：rolledBackRun 透传 + 整轮红线分组 + 详情折叠 ── */
const rolledRunItems: AgentViewItem[] = [
  { id: 'ru1', kind: 'user', text: '把序章第一行改一下', rolledBackRun: true },
  { id: 'rt1', kind: 'tool', name: 'write_source', status: 'done', rolledBackRun: true },
  { id: 'ra1', kind: 'assistant', text: '已改写完成', rolledBackRun: true },
  { id: 'ru2', kind: 'user', text: '这一轮没有回滚' },
]
const rolledRunRows = deriveMessageRows(rolledRunItems)
assert.equal(rolledRunRows[0].rolledBackRun, true, 'user 行的 rolledBackRun 透传')
assert.equal(rolledRunRows[1].rolledBackRun, true, 'tool 行的 rolledBackRun 透传')
assert.equal(rolledRunRows[2].rolledBackRun, true, 'assistant 行的 rolledBackRun 透传')
assert.equal(rolledRunRows[3].rolledBackRun, undefined, '未回滚的行不带 rolledBackRun')

const noticeItem: Extract<AgentViewItem, { kind: 'rollback' }> = {
  id: 'rb1',
  kind: 'rollback',
  createdAt: Date.now(),
  forced: true,
  runs: [
    { userIndex: 0, userText: '把序章的第一行改成“好的”', files: ['序章.hs', '角色.hs'] },
    { userIndex: 1, userText: '继续改第二行', files: ['序章.hs'] },
  ],
  outcomes: [
    { path: '序章.hs', action: 'restored' },
    { path: '角色.hs', action: 'skipped', reason: '被后来的人类编辑覆盖' },
  ],
}
const autoNoticeItem: Extract<AgentViewItem, { kind: 'rollback' }> = {
  id: 'rb2',
  kind: 'rollback',
  createdAt: Date.now(),
  auto: true,
  runs: [],
  outcomes: [],
}
const noticeDerived = deriveMessageRows([noticeItem, autoNoticeItem])
assert.equal(noticeDerived[0].kind, 'rollback', 'rollback 条目派生为回滚通知行')
assert.equal(noticeDerived[0].rollback?.forced, true, '强制回滚标记透传')
assert.equal(noticeDerived[0].rollback?.runs.length, 2, '回滚轮次透传')
assert.deepEqual(noticeDerived[0].rollback?.runs[1].files, ['序章.hs'], '每轮文件透传')
assert.equal(noticeDerived[0].rollback?.outcomes[1].action, 'skipped', '恢复结果透传')
assert.equal(noticeDerived[1].rollback?.auto, true, '自动回滚标记透传')

const runRolledHtml = renderToStaticMarkup(
  createElement(MessageList, {
    // assistant 行走 AgentMarkdown（DOMPurify 在 Node 下不可用），这里只验证分组容器
    rows: rolledRunRows.filter((row) => row.kind !== 'assistant'),
    status: '',
    resetKey: null,
  }),
)
assert.equal(
  (runRolledHtml.match(/class="agent-run-rolled"/g) ?? []).length,
  1,
  '连续的已回滚行合并成一个红线分组',
)
assert.ok(runRolledHtml.includes('已回滚的对话轮次'), '红线分组带无障碍标签')
assert.ok(runRolledHtml.includes('agent-run-rolled-label">已回滚<'), '红线旁显示「已回滚」小字')
const rolledGroupAt = runRolledHtml.indexOf('agent-run-rolled')
const plainUserAt = runRolledHtml.indexOf('这一轮没有回滚')
assert.ok(rolledGroupAt >= 0 && plainUserAt > rolledGroupAt, '未回滚行仍排在分组之后')
const rolledGroupHtml = runRolledHtml.slice(rolledGroupAt, plainUserAt)
assert.ok(rolledGroupHtml.includes('把序章第一行改一下'), '分组内包含已回滚的用户消息')
assert.ok(rolledGroupHtml.includes('write_source'), '分组内包含该轮的工具调用')
assert.ok(!rolledGroupHtml.includes('这一轮没有回滚'), '未回滚的消息不会被包进红线')

const noticeHtml = renderToStaticMarkup(
  createElement(MessageList, {
    rows: noticeDerived,
    status: '',
    resetKey: null,
  }),
)
assert.ok(noticeHtml.includes('agent-msg rollback'), '回滚通知使用独立消息行')
assert.ok(noticeHtml.includes('已回滚 2 轮改动'), '标题显示回滚轮次')
assert.ok(noticeHtml.includes('agent-rollback-notice-tag forced">强制<'), '强制回滚带「强制」标记')
assert.ok(noticeHtml.includes('agent-rollback-notice-tag auto">自动<'), '自动回滚带「自动」标记')
assert.ok(noticeHtml.includes('aria-expanded="false"'), '回滚通知默认收起')
assert.ok(!noticeHtml.includes('agent-rollback-notice-body'), '收起时不渲染详情')

const noticeDetailsHtml = renderToStaticMarkup(
  createElement(RollbackNoticeDetails, { rollback: noticeItem }),
)
assert.ok(noticeDetailsHtml.includes('回滚轮次'), '详情包含回滚轮次分组')
assert.ok(noticeDetailsHtml.includes('第 1 轮'), '轮次从 1 开始编号')
assert.ok(noticeDetailsHtml.includes('第 2 轮'), '两轮都列出')
assert.ok(noticeDetailsHtml.includes('把序章的第一行改成'), '展示用户消息摘要')
assert.ok(noticeDetailsHtml.includes('继续改第二行'), '第二轮用户消息也展示')
assert.ok(noticeDetailsHtml.includes('序章.hs'), '展示涉及文件')
assert.ok(noticeDetailsHtml.includes('角色.hs'), '同一轮的多个文件都列出')
assert.ok(noticeDetailsHtml.includes('恢复与跳过'), '详情包含恢复结果分组')
assert.ok(noticeDetailsHtml.includes('已恢复') && noticeDetailsHtml.includes('已跳过'), '区分恢复与跳过')
assert.ok(noticeDetailsHtml.includes('被后来的人类编辑覆盖'), '跳过原因可见')

/* ── 分支/继承：封段文案 + Run 统计行（三位有效数字、用时、分支按钮在左） ── */
const sealedHintHtml = renderToStaticMarkup(createElement(SegmentSealedHint))
assert.ok(
  sealedHintHtml.includes('本次保存已封存所有活跃会话；发送消息将继承当前会话'),
  '封段提示说明保存封存所有活跃会话、发送消息继承当前会话',
)
assert.ok(!sealedHintHtml.includes('开始新会话'), '不再显示错误的“开始新会话”文案')

// 用户消息回滚图标只回滚后缀轮，弹窗简化为单次确认（不再给范围选项）。
assert.ok(
  MANUAL_ROLLBACK_MESSAGE.includes('该轮及之后所有轮次'),
  '回滚确认文案说明会回滚该轮及之后的所有轮次',
)
assert.ok(MANUAL_ROLLBACK_MESSAGE.includes('不会删除对话消息'), '确认文案说明不删除对话消息')

assert.equal(formatTokenCount(0), '0')
assert.equal(formatTokenCount(999), '999')
assert.equal(formatTokenCount(1000), '1K')
assert.equal(formatTokenCount(12_300), '12.3K', '三位有效数字')
assert.equal(formatTokenCount(123_456), '123K', '整数千位不再显示小数')
assert.equal(formatTokenCount(1_234_567), '1.23M', '百万级保留三位有效数字')
assert.equal(formatTokenCount(999_950), '1M', '四舍五入后进位，不能出现 1000K')
assert.equal(formatTokenCount(-1), '0', '非法/负数按 0 处理')
assert.equal(formatTokenCount(Number.NaN), '0')

assert.equal(formatRunDuration(0), '0ms')
assert.equal(formatRunDuration(950), '950ms', '不足 1 秒用毫秒')
assert.equal(formatRunDuration(1000), '1s', '整秒去掉 .0')
assert.equal(formatRunDuration(12_345), '12.3s', '不足 1 分钟保留 1 位小数')
assert.equal(formatRunDuration(12_000), '12s', '整秒不显示 .0')
assert.equal(formatRunDuration(59_949), '59.9s')
assert.equal(formatRunDuration(60_000), '1m00s', '满 1 分钟用 m/s')
assert.equal(formatRunDuration(125_000), '2m05s', '秒数补两位')
assert.equal(formatRunDuration(-5), '0ms')

const runMetaItem: AgentViewItem = {
  id: 'rm1',
  kind: 'run-meta',
  durationMs: 12_345,
  turns: 3,
  inputTokens: 12_300,
  cachedTokens: 650,
  outputTokens: 1_234_567,
  forkBeforeEntryId: 'u-next',
}
const runMetaDerived = deriveMessageRows([runMetaItem])
assert.equal(runMetaDerived[0].kind, 'run-meta', 'run-meta 条目派生为统计行')
assert.equal(runMetaDerived[0].roleLabel, 'Run')
assert.deepEqual(
  runMetaDerived[0].runMeta,
  {
    durationMs: 12_345,
    turns: 3,
    inputTokens: 12_300,
    cachedTokens: 650,
    outputTokens: 1_234_567,
    forkBeforeEntryId: 'u-next',
  },
  '统计字段与分支点原样透传',
)

const runMetaHtml = renderToStaticMarkup(
  createElement(MessageList, {
    rows: deriveMessageRows([
      { id: 'u0', kind: 'user', text: '第一轮' },
      runMetaItem,
    ]),
    status: '',
    resetKey: null,
    onForkRun: noop,
  }),
)
assert.equal(
  (runMetaHtml.match(/class="agent-run-meta"/g) ?? []).length,
  1,
  '每个已完成 Run 渲染一条统计行',
)
assert.ok(runMetaHtml.includes('class="agent-run-fork"'), '统计行左侧渲染分支按钮')
assert.ok(
  runMetaHtml.includes('aria-label="从此轮之后分支会话"'),
  '分支按钮说明从这一轮之后分支',
)
assert.ok(
  runMetaHtml.includes('用时 12.3s · 3 轮 · 输入12.3K · 缓存650 · 输出1.23M'),
  '统计行单行显示用时/轮次/输入/缓存/输出',
)
const runForkAt = runMetaHtml.indexOf('class="agent-run-fork"')
const runStatsAt = runMetaHtml.indexOf('agent-run-meta-stats')
assert.ok(runForkAt >= 0 && runStatsAt > runForkAt, '分支按钮在统计文字左侧')
assert.ok(!runMetaHtml.includes('agent-msg-fork'), '用户行不再显示分支图标')

const forkArgs: Array<string | undefined> = []
const runMetaLineElement = RunMetaLine({
  runMeta: runMetaDerived[0].runMeta!,
  onForkRun: (beforeEntryId) => {
    forkArgs.push(beforeEntryId)
  },
}) as unknown
const runForkButton = collectButtons(runMetaLineElement).find((button) =>
  button.props?.className?.includes('agent-run-fork'),
)
assert.ok(runForkButton, '统计行的分支按钮可直接调用并测试点击')
runForkButton.props?.onClick?.()
assert.deepEqual(forkArgs, ['u-next'], '点击分支按钮把下一轮 entry id 交给面板')

forkArgs.length = 0
const lastRunElement = RunMetaLine({
  runMeta: { ...runMetaDerived[0].runMeta!, forkBeforeEntryId: undefined },
  onForkRun: (beforeEntryId) => {
    forkArgs.push(beforeEntryId)
  },
}) as unknown
const lastRunButton = collectButtons(lastRunElement).find((button) =>
  button.props?.className?.includes('agent-run-fork'),
)
assert.ok(lastRunButton, '最后一轮同样有分支按钮')
lastRunButton.props?.onClick?.()
assert.deepEqual(forkArgs, [undefined], '最后一轮分支传 undefined，表示复制全部对话')

forkArgs.length = 0
const rolledRunElement = RunMetaLine({
  runMeta: runMetaDerived[0].runMeta!,
  rolledBack: true,
  onForkRun: (beforeEntryId) => {
    forkArgs.push(beforeEntryId)
  },
}) as unknown
const rolledRunButton = collectButtons(rolledRunElement).find((button) =>
  button.props?.className?.includes('agent-run-fork'),
)
assert.ok(rolledRunButton, '已回滚轮次的统计行仍有（禁用的）分支按钮')
assert.equal(rolledRunButton.props?.disabled, true, '已回滚轮次的分支按钮必须 disabled')
rolledRunButton.props?.onClick?.()
assert.deepEqual(forkArgs, [], '已回滚轮次即使合成点击也不能触发分支回调')
const rolledRunHtml = renderToStaticMarkup(
  createElement(RunMetaLine, {
    runMeta: runMetaDerived[0].runMeta!,
    rolledBack: true,
    onForkRun: noop,
  }),
)
const rolledRunTag = rolledRunHtml.match(/<button[^>]*class="agent-run-fork"[^>]*>/)
assert.ok(rolledRunTag, '可提取已回滚轮次的分支按钮标签')
assert.ok(rolledRunTag[0].includes('disabled'), 'SSR 中分支按钮带 disabled')
assert.ok(
  rolledRunTag[0].includes('aria-label="该轮已回滚，不能从此轮分支"'),
  '已回滚轮次的分支按钮无障碍说明已禁用',
)
assert.ok(
  rolledRunTag[0].includes('title="该轮已回滚，不能从此轮分支"'),
  '已回滚轮次的分支按钮悬浮说明已禁用',
)

const rolledMetaHtml = renderToStaticMarkup(
  createElement(MessageList, {
    rows: deriveMessageRows([
      { id: 'ru1', kind: 'user', text: '已回滚的一轮', rolledBackRun: true },
      { ...runMetaItem, id: 'rm-rolled', rolledBackRun: true },
    ]),
    status: '',
    resetKey: null,
  }),
)
assert.ok(rolledMetaHtml.includes('agent-run-rolled'), '统计行跟随整轮红线分组')
assert.ok(rolledMetaHtml.includes('agent-run-meta'), '红线分组内包含统计行')
const rolledMetaForkTag = rolledMetaHtml.match(/<button[^>]*class="agent-run-fork"[^>]*>/)
assert.ok(rolledMetaForkTag, '红线分组内仍渲染统计行分支按钮')
assert.ok(
  rolledMetaForkTag[0].includes('disabled'),
  'MessageRowView 把 rolledBackRun 透传给统计行并禁用分支',
)

let inputForkClicks = 0
const forkButtonElement = ForkButton({
  disabled: false,
  onClick: () => {
    inputForkClicks += 1
  },
}) as unknown
const forkButton = collectButtons(forkButtonElement).find((button) =>
  button.props?.className?.includes('agent-fork'),
)
assert.ok(forkButton, '输入区分支按钮有独立类名')
assert.equal(elementText(forkButton), '分支')
forkButton.props?.onClick?.()
assert.equal(inputForkClicks, 1, '点击输入区分支按钮触发回调')

const activePanelWithFork = renderPanel(rollbackItems)
assert.ok(activePanelWithFork.includes('class="agent-fork"'), '输入区渲染「分支」按钮')
const forkTag = activePanelWithFork.match(/<button[^>]*class="agent-fork"[^>]*>/)
assert.ok(forkTag, '可提取输入区分支按钮标签')
assert.ok(
  forkTag[0].includes('title="从当前会话末尾分支出一个新段"'),
  '输入区分支按钮说明从末尾分支',
)
assert.ok(!forkTag[0].includes('disabled'), '空闲且已有运行时时输入区分支按钮可用')
const disabledForkHtml = renderToStaticMarkup(
  createElement(ForkButton, { disabled: true, onClick: noop }),
)
assert.ok(/<button[^>]*disabled/.test(disabledForkHtml), '运行中禁用输入区分支按钮')
const archiveForkHtml = renderToStaticMarkup(
  createElement(ForkButton, {
    disabled: false,
    title: '继承该归档段并分支出新对话',
    onClick: noop,
  }),
)
assert.ok(
  archiveForkHtml.includes('title="继承该归档段并分支出新对话"'),
  '查看归档段时输入区分支按钮提示继承归档段',
)

const forkSegmentInfo: SegmentInfo = {
  id: 'seg-fork',
  title: '分支',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  windowId: 'w1',
  state: 'active',
  runCount: 0,
}
const forkCalls: Array<ForkSegmentOptions | undefined> = []
const forkRuntime = {
  ...makeRuntime([]),
  forkSegment: async (options?: ForkSegmentOptions) => {
    forkCalls.push(options)
    return forkSegmentInfo
  },
} as unknown as AgentRuntime
const currentFork = forkCurrentSegment(forkRuntime, false)
assert.ok(currentFork, '输入区分支在空闲时返回 Promise')
await currentFork
assert.deepEqual(forkCalls[0], { label: 'branch' }, '输入区分支调用 forkSegment({label: branch})')
forkCalls.length = 0
const afterRunFork = forkAfterRun(forkRuntime, false, 'u2')
assert.ok(afterRunFork, 'Run 分支在空闲时返回 Promise')
await afterRunFork
assert.deepEqual(
  forkCalls[0],
  { beforeEntryId: 'u2', label: 'branch' },
  'Run 分支只复制到该轮为止',
)
forkCalls.length = 0
const tailFork = forkAfterRun(forkRuntime, false)
assert.ok(tailFork, '最后一轮分支在空闲时返回 Promise')
await tailFork
assert.deepEqual(forkCalls[0], { label: 'branch' }, '最后一轮分支复制全部对话')
forkCalls.length = 0
assert.equal(forkCurrentSegment(forkRuntime, true), null, '运行中不允许从末尾分支')
assert.equal(forkAfterRun(forkRuntime, true, 'u2'), null, '运行中不允许从 Run 分支')
assert.equal(forkCalls.length, 0, '被拒绝的分支不会调用 runtime')

/* ── 只读归档段内发送：先继承归档段，再在继承出的活跃段里开 Run ── */
const archiveOrder: string[] = []
const archiveRuntime = {
  forkSnapshot: async (snapshotId: string) => {
    archiveOrder.push(`fork:${snapshotId}`)
    return forkSegmentInfo
  },
  run: async (text: string) => {
    archiveOrder.push(`run:${text}`)
    return { ok: true } as AgentRunResult
  },
}
const archiveRunResult = await runAfterInheritingArchive(
  archiveRuntime,
  'snap-1',
  '  继续写第二章  ',
)
assert.deepEqual(
  archiveOrder,
  ['fork:snap-1', 'run:继续写第二章'],
  '归档段内发送必须继承归档段后再 run，且文本已 trim',
)
assert.equal(archiveRunResult.ok, true, '继承并运行成功时返回 run 结果')

const forkFailureOrder: string[] = []
const failingArchiveRuntime = {
  forkSnapshot: async () => {
    forkFailureOrder.push('fork')
    throw new Error('归档段不存在')
  },
  run: async () => {
    forkFailureOrder.push('run')
    return { ok: true } as AgentRunResult
  },
}
await assert.rejects(
  () => runAfterInheritingArchive(failingArchiveRuntime, 'snap-gone', '继续'),
  /归档段不存在/,
  '继承失败时错误向上抛出',
)
assert.deepEqual(forkFailureOrder, ['fork'], '继承失败时不会在旧活跃段里 run')

console.log(
  '通过：Agent 面板视图派生（行 id/流式/工具状态、失败记录与回滚摘要、占用阈值、Key 掩码、时间与文案）',
)
