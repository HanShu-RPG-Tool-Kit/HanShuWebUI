/**
 * 会话视图映射验收：工具调用参数（`input`）从助手消息回填到工具条目 / 实时工具槽；
 * 回滚通知的整轮标注；每条已结束 Run 的统计行（`run-meta`：用时/轮次/token/分支点）。
 *
 * 背景：工具结果条目本身只有 `toolCallId`，参数只存在于发出请求的那条助手消息里。
 * 面板要在工具结果上显示「输入」，就必须在顺序扫描时把 assistant 条目的 ToolCall 参数
 * 收集起来、再按 callId 配对（src/agent/pi/view.ts:70 `toolCallInputsOf`）。
 * 统计行同理是纯映射：用户条目开启一轮，assistant 累计轮次与 usage，下一条用户条目到来
 * 时把统计行插到它前面；分支按钮用 `forkBeforeEntryId` 定位「复制到这一轮为止」。
 * 这里不渲染 React，只断言纯函数的输出。
 *
 * 跑法：`node scripts/run-verification.mjs scripts/verify-agent-view.ts`
 */
import assert from 'node:assert/strict'
import type { ConversationView, EntryRecord, LiveState } from '@earendil-works/pi-durable'
import type { AgentViewItem } from '../src/agent/contracts'
import { entriesToItems, entryRecordsToItems, liveToItems } from '../src/agent/pi/view'

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

/* ───────────────────────── 构造器：只造 view.ts 真正读到的字段 ───────────────────────── */

/** 助手消息：content 里可以混正文 / 思考 / 多个 toolCall */
function assistantEntry(
  id: string,
  options: {
    text?: string
    thinking?: string
    calls?: { id: string; name: string; arguments?: unknown }[]
  } = {},
): EntryRecord {
  const content: unknown[] = []
  if (options.thinking) content.push({ type: 'thinking', thinking: options.thinking })
  if (options.text) content.push({ type: 'text', text: options.text })
  for (const call of options.calls ?? []) {
    content.push({
      type: 'toolCall',
      id: call.id,
      name: call.name,
      arguments: call.arguments ?? {},
    })
  }
  return { id, kind: 'pi.assistant', model: [{ role: 'assistant', content }] } as unknown as EntryRecord
}

/** 工具结果消息：顺序扫描时按 `toolCallId` 去助手消息里找参数 */
function toolResultEntry(
  id: string,
  options: {
    toolCallId?: string
    toolName?: string
    text?: string
    isError?: boolean
  } = {},
): EntryRecord {
  const content = options.text ? [{ type: 'text', text: options.text }] : []
  return {
    id,
    kind: 'pi.tool-result',
    model: [
      {
        role: 'toolResult',
        toolCallId: options.toolCallId,
        toolName: options.toolName ?? 'read_source',
        isError: options.isError ?? false,
        content,
      },
    ],
  } as unknown as EntryRecord
}

function userEntry(id: string, text: string): EntryRecord {
  return { id, kind: 'pi.user', model: [{ role: 'user', content: text }] } as unknown as EntryRecord
}

/**
 * 回滚通知条目：`data` 给 UI（runs/outcomes/forced/auto），`model` 给模型（脚本里不关心）。
 * 故意允许传任意坏 data：视图必须自己过滤，不能因为一条坏通知把整个对话打崩。
 */
function rollbackEntry(id: string, data: unknown): EntryRecord {
  return { id, kind: 'hanshu.rollback', data, model: [] } as unknown as EntryRecord
}

type RollbackItem = Extract<AgentViewItem, { kind: 'rollback' }>
function rollbackItems(items: AgentViewItem[]): RollbackItem[] {
  return items.filter((item): item is RollbackItem => item.kind === 'rollback')
}

type RowFlags = { rolledBackRun?: boolean; rolledBack?: boolean }
function flagsOf(item: AgentViewItem | undefined): RowFlags {
  return (item ?? {}) as RowFlags
}

function viewOf(entries: EntryRecord[]): ConversationView {
  return { entries } as unknown as ConversationView
}

type ToolItem = { id: string; kind: string; name: string; status: string; input?: string; output?: string }
function toolItems(items: ReturnType<typeof entryRecordsToItems>): ToolItem[] {
  return items.filter((item) => item.kind === 'tool') as unknown as ToolItem[]
}

/* ───────────────────────── 已提交条目：参数回填 ───────────────────────── */

await test('entries：工具结果的 input 是助手消息里 ToolCall 参数的紧凑 JSON', async () => {
  const entries = [
    assistantEntry('a1', {
      calls: [{ id: 'call-1', name: 'read_source', arguments: { path: '序章.hs', offset: 3 } }],
    }),
    toolResultEntry('t1', { toolCallId: 'call-1', toolName: 'read_source', text: '文件内容' }),
  ]
  const [tool] = toolItems(entryRecordsToItems(entries))
  assert.ok(tool, '应映射出一条工具条目')
  assert.equal(tool.id, 't1')
  assert.equal(tool.name, 'read_source')
  assert.equal(tool.status, 'done')
  assert.equal(tool.output, '文件内容')
  assert.equal(
    tool.input,
    '{"path":"序章.hs","offset":3}',
    'input 必须是紧凑 JSON（不能带空格换行，UI 直接展示）',
  )
  assert.deepEqual(JSON.parse(tool.input ?? 'null'), { path: '序章.hs', offset: 3 })
})

await test('entries：空参数 {} 不产生 input（避免 UI 多一个空输入入口）', async () => {
  const entries = [
    assistantEntry('a1', { calls: [{ id: 'call-1', name: 'list_sources', arguments: {} }] }),
    toolResultEntry('t1', { toolCallId: 'call-1', toolName: 'list_sources' }),
  ]
  const [tool] = toolItems(entryRecordsToItems(entries))
  assert.equal(tool.input, undefined, '空参数时 input 应为 undefined')
})

await test('entries：多条 toolCall 各自配对，错误结果 status=error 但 input 仍回填', async () => {
  const entries = [
    assistantEntry('a1', {
      calls: [
        { id: 'call-a', name: 'read_source', arguments: { path: 'a.hs' } },
        { id: 'call-b', name: 'write_source', arguments: { path: 'b.hs', content: '正文' } },
      ],
    }),
    toolResultEntry('t1', { toolCallId: 'call-a', toolName: 'read_source', text: 'ok' }),
    toolResultEntry('t2', {
      toolCallId: 'call-b',
      toolName: 'write_source',
      text: '写入失败：版本冲突',
      isError: true,
    }),
  ]
  const tools = toolItems(entryRecordsToItems(entries))
  assert.equal(tools.length, 2)
  assert.equal(tools[0].input, '{"path":"a.hs"}')
  assert.equal(tools[1].input, '{"path":"b.hs","content":"正文"}')
  assert.equal(tools[1].status, 'error', 'isError=true 的结果应映射成 error')
})

await test('entries：找不到对应 toolCall 的结果不给 input（不猜参数）', async () => {
  const entries = [
    assistantEntry('a1', { calls: [{ id: 'call-known', name: 'read_source', arguments: { path: 'a.hs' } }] }),
    toolResultEntry('t1', { toolCallId: 'call-unknown', toolName: 'read_source' }),
    toolResultEntry('t2', { toolName: 'read_source' }),
  ]
  const tools = toolItems(entryRecordsToItems(entries))
  assert.equal(tools.length, 2)
  assert.equal(tools[0].input, undefined, '未知 callId 不应拿到别人的参数')
  assert.equal(tools[1].input, undefined, '没有 toolCallId 的结果没有 input')
})

await test('entries：用户 / 助手 / 工具的顺序与正文不受参数映射影响', async () => {
  const entries = [
    userEntry('u1', '读一下序章'),
    assistantEntry('a1', {
      text: '我来读。',
      thinking: '先确认路径',
      calls: [{ id: 'call-1', name: 'read_source', arguments: { path: '序章.hs' } }],
    }),
    toolResultEntry('t1', { toolCallId: 'call-1', toolName: 'read_source', text: '正文' }),
    assistantEntry('a2', { text: '读完了。' }),
  ]
  const items = entryRecordsToItems(entries)
  // 最后一个 Run 收尾时也会追加统计行（详见后面的 Run 统计行用例）
  assert.deepEqual(
    items.map((item) => item.kind),
    ['user', 'assistant', 'tool', 'assistant', 'run-meta'],
  )
  const assistant = items[1] as unknown as { text: string; thinking?: string }
  assert.equal(assistant.text, '我来读。')
  assert.equal(assistant.thinking, '先确认路径')
  const [tool] = toolItems(items)
  assert.equal(tool.input, '{"path":"序章.hs"}')
  // entriesToItems 是同一份映射（面板实际入口）
  assert.deepEqual(entriesToItems(viewOf(entries)), items)
})

await test('entries：只有工具调用的助手消息不产生 assistant 条目', async () => {
  const items = entryRecordsToItems([
    assistantEntry('a1', { calls: [{ id: 'call-1', name: 'read_source', arguments: { path: 'a.hs' } }] }),
  ])
  assert.deepEqual(items, [], '无正文无思考的调用请求不应出现在对话流里')
})

/* ───────────────────────── 实时（pi.live）部分 ───────────────────────── */

function liveOf(partial: {
  text?: string
  calls?: { id: string; name: string; arguments?: unknown }[]
  tools?: {
    callId: string
    name: string
    status?: 'running' | 'done'
    output?: string
    entry?: unknown
  }[]
}): LiveState {
  return {
    run: { taskId: 'task-1', turns: 0 },
    generation: {
      message: assistantEntry('live-message', { text: partial.text, calls: partial.calls })['model'][0],
    },
    tools: partial.tools ?? [],
  } as unknown as LiveState
}

await test('live：工具槽的 input 来自正在生成的助手消息（紧凑 JSON）', async () => {
  const items = liveToItems(
    liveOf({
      text: '我来读',
      calls: [{ id: 'call-1', name: 'read_source', arguments: { path: '序章.hs' } }],
      tools: [{ callId: 'call-1', name: 'read_source', status: 'running' }],
    }),
  )
  const assistant = items.find((item) => item.kind === 'assistant') as unknown as
    | { streaming?: boolean }
    | undefined
  assert.equal(assistant?.streaming, true, '实时正文条目应标记 streaming')
  const tool = items.find((item) => item.kind === 'tool') as unknown as ToolItem | undefined
  assert.ok(tool)
  assert.equal(tool.id, 'live:tool:call-1')
  assert.equal(tool.status, 'running')
  assert.equal(tool.input, '{"path":"序章.hs"}')
})

await test('live：已提交的工具槽（slot.entry 存在）跳过，input 不再重复给出', async () => {
  const items = liveToItems(
    liveOf({
      calls: [{ id: 'call-1', name: 'read_source', arguments: { path: 'a.hs' } }],
      tools: [{ callId: 'call-1', name: 'read_source', status: 'done', entry: { id: 't1' } }],
    }),
  )
  assert.equal(
    items.filter((item) => item.kind === 'tool').length,
    0,
    '结果已提交的工具槽不渲染，交给 entries',
  )
})

await test('live：done 状态 / 空参数 / 多个工具槽各自正确', async () => {
  const items = liveToItems(
    liveOf({
      calls: [
        { id: 'call-a', name: 'read_source', arguments: { path: 'a.hs' } },
        { id: 'call-b', name: 'list_sources', arguments: {} },
      ],
      tools: [
        { callId: 'call-a', name: 'read_source', status: 'done', output: '正文' },
        { callId: 'call-b', name: 'list_sources', status: 'running' },
      ],
    }),
  )
  const tools = items.filter((item) => item.kind === 'tool') as unknown as ToolItem[]
  assert.equal(tools.length, 2)
  assert.equal(tools[0].status, 'done')
  assert.equal(tools[0].output, '正文')
  assert.equal(tools[0].input, '{"path":"a.hs"}')
  assert.equal(tools[1].status, 'running')
  assert.equal(tools[1].input, undefined, '空参数不产生 input')
})

await test('live：undefined / 无 run 时不产生条目', async () => {
  assert.deepEqual(liveToItems(undefined), [])
  assert.deepEqual(liveToItems({ tools: [] } as unknown as LiveState), [])
})

/* ───────────────────────── 回滚通知（hanshu.rollback） ───────────────────────── */

await test('rollback：通知映射成 rollback 条目（runs/outcomes/forced/auto/createdAt）', async () => {
  const items = entryRecordsToItems([
    userEntry('u1', '请改写序章'),
    assistantEntry('a1', { text: '改好了。' }),
    rollbackEntry('r1', {
      createdAt: 1_760_000_000_000,
      forced: true,
      runs: [{ userIndex: 0, userText: '请改写序章', files: ['序章.hs', '序章.lang'] }],
      outcomes: [
        { path: '序章.hs', action: 'restored' },
        { path: '序章.lang', action: 'skipped', reason: 'unavailable' },
      ],
    }),
  ])
  const [notice] = rollbackItems(items)
  assert.ok(notice, '应映射出一条回滚通知')
  assert.equal(notice.id, 'r1')
  assert.equal(notice.createdAt, 1_760_000_000_000)
  assert.equal(notice.forced, true, '强制回滚要保留 forced 标记')
  assert.equal(notice.auto, undefined, '用户主动回滚不是 auto')
  assert.equal(notice.runs.length, 1)
  assert.equal(notice.runs[0].userIndex, 0)
  assert.equal(notice.runs[0].userText, '请改写序章')
  assert.deepEqual(notice.runs[0].files, ['序章.hs', '序章.lang'])
  assert.equal(notice.outcomes.length, 2)
  assert.equal(notice.outcomes[0].action, 'restored')
  assert.equal(notice.outcomes[1].action, 'skipped')
  assert.equal(notice.outcomes[1].reason, 'unavailable')

  const [auto] = rollbackItems(
    entryRecordsToItems([
      userEntry('u1', '跑一轮'),
      rollbackEntry('r2', { where: '原样', createdAt: 7, auto: true, runs: [], outcomes: [] }),
    ]),
  )
  assert.ok(auto)
  assert.equal(auto.auto, true, '失败自动回滚要保留 auto 标记')
  assert.equal(auto.forced, undefined)
  assert.deepEqual(auto.runs, [])
  assert.deepEqual(auto.outcomes, [])
})

await test('rollback：按 userIndex 把整轮 user/assistant/tool 标 rolledBackRun，user 还标 rolledBack', async () => {
  const entries = [
    userEntry('u1', '第一轮'),
    assistantEntry('a1', { text: '第一轮答复' }),
    toolResultEntry('t1', { toolName: 'read_source', text: '正文' }),
    userEntry('u2', '第二轮'),
    assistantEntry('a2', { text: '第二轮答复' }),
    rollbackEntry('r1', { createdAt: 1, runs: [{ userIndex: 0, files: ['序章.hs'] }], outcomes: [] }),
  ]
  const items = entryRecordsToItems(entries)
  // 回滚通知到期时当前 Run 先收尾（统计行在通知之前），所以第 1 轮统计行排在通知前、
  // 通知之后没有新的 Run，不存在「通知后的统计行」。
  assert.deepEqual(
    items.map((item) => item.kind),
    ['user', 'assistant', 'tool', 'run-meta', 'user', 'assistant', 'run-meta', 'rollback'],
  )
  // 第 0 轮：user → 下一条 user 之前的 user/assistant/tool/run-meta 全部画红线
  assert.equal(flagsOf(items[0]).rolledBackRun, true, '被回滚那轮的 user 行要画红线')
  assert.equal(flagsOf(items[0]).rolledBack, true, 'user 行还要标「已回滚」，控制回滚入口置灰')
  assert.equal(flagsOf(items[1]).rolledBackRun, true)
  assert.equal(flagsOf(items[1]).rolledBack, undefined, 'assistant 行不标 rolledBack')
  assert.equal(flagsOf(items[2]).rolledBackRun, true)
  assert.equal(flagsOf(items[3]).rolledBackRun, true, '统计行属于被回滚区间，红线必须连续')
  // 下一轮（items[4] 起的 user/assistant）不受影响
  assert.equal(flagsOf(items[4]).rolledBackRun, undefined)
  assert.equal(flagsOf(items[4]).rolledBack, undefined)
  assert.equal(flagsOf(items[5]).rolledBackRun, undefined)
  assert.equal(flagsOf(items[6]).rolledBackRun, undefined, '未被回滚的 Run 统计行不标红')
  // 通知自身不是 Run 行，不能被打标
  assert.equal(flagsOf(items[7]).rolledBackRun, undefined)
})

await test('rollback：坏 data / 坏 runs / 坏 outcomes 逐条过滤，不影响其它条目', async () => {
  const entries = [
    userEntry('u1', '第一轮'),
    assistantEntry('a1', { text: '答复' }),
    // data 不是对象：整条通知忽略
    rollbackEntry('bad-null', null),
    rollbackEntry('bad-string', 'oops'),
    rollbackEntry('bad-array', [1, 2]),
    // runs 不是数组：通知仍在，但 runs 为空（不标任何轮）
    rollbackEntry('bad-runs', { createdAt: 3, runs: 'nope', outcomes: [] }),
    // 坏 run 条目被过滤，只有带数字 userIndex 的留下；files 里的非字符串被丢弃
    rollbackEntry('mixed', {
      createdAt: 4,
      runs: [
        { userIndex: '1' },
        { userIndex: 2, files: [1, 'b.hs', null] },
      ],
      outcomes: [null, { path: 3 }, { path: 'x.hs', action: 'restored' }],
    }),
  ]
  const items = entryRecordsToItems(entries)
  const notices = rollbackItems(items)
  assert.equal(notices.length, 2, '两条坏 data 被忽略，两条保留')
  assert.deepEqual(notices[0].runs, [])
  assert.equal(notices[1].runs.length, 1, 'userIndex 不是数字的 run 要被过滤')
  assert.equal(notices[1].runs[0].userIndex, 2)
  assert.deepEqual(notices[1].runs[0].files, ['b.hs'])
  assert.equal(notices[1].outcomes.length, 1, '坏 outcome 条目要被过滤')
  assert.equal(notices[1].outcomes[0].path, 'x.hs')
  // 前两条正常条目仍完整
  assert.equal(items[0].kind, 'user')
  assert.equal(items[1].kind, 'assistant')
})

await test('rollback：多条通知分别标注；userIndex 越界 / 空正文 user 不误标、不崩', async () => {
  const entries = [
    userEntry('u1', ''), // 空正文的 user 不渲染条目，但 userIndex 仍按「用户消息序列」计数
    userEntry('u2', '第二轮'),
    assistantEntry('a1', { text: '第二轮答复' }),
    rollbackEntry('r1', { runs: [{ userIndex: 1, files: [] }], outcomes: [] }),
    rollbackEntry('r2', { runs: [{ userIndex: 9, files: [] }], outcomes: [] }), // 越界：跳过
    rollbackEntry('r3', { runs: [{ userIndex: 0, files: [] }], outcomes: [] }), // 空正文：无行可标
  ]
  const items = entryRecordsToItems(entries)
  // 统计行（run-meta）单独断言，这里只看对话行与通知的顺序
  const dialogKinds = items.filter((item) => item.kind !== 'run-meta').map((item) => item.kind)
  assert.deepEqual(dialogKinds, ['user', 'assistant', 'rollback', 'rollback', 'rollback'])
  const userRow = items.find((item) => item.kind === 'user')
  const assistantRow = items.find((item) => item.kind === 'assistant')
  assert.equal(flagsOf(userRow).rolledBackRun, true, 'user 行属于被回滚的整轮')
  assert.equal(flagsOf(assistantRow).rolledBackRun, true, 'assistant 行属于被回滚的整轮')
  assert.equal(flagsOf(userRow).rolledBack, true)
  assert.equal(flagsOf(assistantRow).rolledBack, undefined)
  for (const item of rollbackItems(items)) {
    assert.equal(flagsOf(item).rolledBackRun, undefined, '通知自身不能被打标')
  }
})

/* ───────── 回滚通知：userIndex 越界 / 不可渲染 user 时的结构回退 ───────── */

/**
 * 为什么需要回退：归档增量/裁剪会把条目复制进更短的片段，通知里的 userIndex 是
 * 原完整会话里的序号，在新片段里可能越界。此时按「通知前最近 N 个已渲染 user」
 * 回退，红线仍能标在正确的后缀轮上（回滚只允许后缀轮）。
 */
await test('rollback：userIndex 越界时回退到最后 N 个已渲染 user（归档裁剪场景）', async () => {
  const items = entryRecordsToItems([
    userEntry('u1', '第一轮'),
    assistantEntry('a1', { text: '答复1' }),
    userEntry('u2', '第二轮'),
    assistantEntry('a2', { text: '答复2' }),
    // 原完整会话里是第 5、6 轮，被复制进只有 2 轮的片段后两个序号都越界
    rollbackEntry('r1', {
      createdAt: 1,
      runs: [
        { userIndex: 5, files: [] },
        { userIndex: 6, files: [] },
      ],
      outcomes: [],
    }),
    userEntry('u3', '第三轮'),
    assistantEntry('a3', { text: '答复3' }),
  ])
  const row = (id: string) => items.find((item) => (item as unknown as { id: string }).id === id)
  // 退回到最后 2 个已渲染 user：u1 与 u2 两轮整段画红线
  for (const id of ['u1', 'a1', 'u2', 'a2']) {
    assert.equal(flagsOf(row(id)).rolledBackRun, true, `${id} 属于回退出的后缀轮，要画红线`)
  }
  assert.equal(flagsOf(row('u1')).rolledBack, true)
  assert.equal(flagsOf(row('u2')).rolledBack, true, '两轮都标「已回滚」')
  assert.equal(flagsOf(row('a2')).rolledBack, undefined, 'assistant 行不标 rolledBack')
  // 通知本身与后续轮次不能被打标
  const notice = rollbackItems(items)[0]
  assert.ok(notice)
  assert.equal(flagsOf(notice).rolledBackRun, undefined, '通知自身不参与红线')
  for (const id of ['u3', 'a3']) {
    assert.equal(flagsOf(row(id)).rolledBackRun, undefined, `${id} 在通知之后，不能被误标`)
  }
})

await test('rollback：userIndex 有效时按 data 精确标注，不触发结构回退', async () => {
  const items = entryRecordsToItems([
    userEntry('u1', '第一轮'),
    assistantEntry('a1', { text: '答复1' }),
    userEntry('u2', '第二轮'),
    assistantEntry('a2', { text: '答复2' }),
    rollbackEntry('r1', {
      createdAt: 1,
      runs: [{ userIndex: 1, files: [] }],
      outcomes: [],
    }),
    userEntry('u3', '第三轮'),
    assistantEntry('a3', { text: '答复3' }),
  ])
  const row = (id: string) => items.find((item) => (item as unknown as { id: string }).id === id)
  // 只有第 1 轮（u2）被回滚：第 0 轮必须保持不变
  assert.equal(flagsOf(row('u1')).rolledBackRun, undefined, 'userIndex 有效时不能误标前一轮')
  assert.equal(flagsOf(row('a1')).rolledBackRun, undefined)
  assert.equal(flagsOf(row('u2')).rolledBackRun, true)
  assert.equal(flagsOf(row('u2')).rolledBack, true)
  assert.equal(flagsOf(row('a2')).rolledBackRun, true)
  assert.equal(flagsOf(row('u3')).rolledBackRun, undefined)
  assert.equal(flagsOf(rollbackItems(items)[0]).rolledBackRun, undefined)
})

await test('rollback：userIndex 指向不可渲染 user（空正文）时同样回退到后缀轮', async () => {
  const items = entryRecordsToItems([
    userEntry('u1', ''), // 空正文：不渲染 user 行，userItemIndexes 里是 -1
    userEntry('u2', '第二轮'),
    assistantEntry('a2', { text: '答复2' }),
    rollbackEntry('r1', { createdAt: 1, runs: [{ userIndex: 0, files: [] }], outcomes: [] }),
    userEntry('u3', '第三轮'),
  ])
  const row = (id: string) => items.find((item) => (item as unknown as { id: string }).id === id)
  // 序号 0 指向空正文 user，无法标行 → 回退到「最后 1 个已渲染 user」= u2
  assert.equal(row('u1'), undefined, '空正文 user 没有渲染行')
  assert.equal(flagsOf(row('u2')).rolledBackRun, true, '回退到 u2 这一轮')
  assert.equal(flagsOf(row('u2')).rolledBack, true)
  assert.equal(flagsOf(row('a2')).rolledBackRun, true)
  assert.equal(flagsOf(row('u3')).rolledBackRun, undefined, '通知之后的轮次不标记')
  assert.equal(flagsOf(rollbackItems(items)[0]).rolledBackRun, undefined)
})

/* ───────────────────────── Run 统计行（run-meta） ───────────────────────── */

/**
 * 统计行由 `entryRecordsToItems` 收集：用户条目开启一轮，assistant 累计轮次与 usage，
 * tool-result 只影响结束时间；下一条用户条目到来时把 `run-meta` 插到它前面。
 * 这里给带时间戳/usage 的构造器，专门喂统计行逻辑（旧构造器保持原样，避免动已有用例）。
 */
function userEntryAt(id: string, text: string, timestamp?: number): EntryRecord {
  const message: Record<string, unknown> = { role: 'user', content: text }
  if (typeof timestamp === 'number') message.timestamp = timestamp
  return { id, kind: 'pi.user', model: [message] } as unknown as EntryRecord
}

function assistantEntryAt(
  id: string,
  options: {
    text?: string
    timestamp?: number
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  } = {},
): EntryRecord {
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: options.text ? [{ type: 'text', text: options.text }] : [],
  }
  if (typeof options.timestamp === 'number') message.timestamp = options.timestamp
  if (options.usage) message.usage = options.usage
  return { id, kind: 'pi.assistant', model: [message] } as unknown as EntryRecord
}

function toolResultEntryAt(id: string, timestamp?: number): EntryRecord {
  const message: Record<string, unknown> = {
    role: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'read_source',
    isError: false,
    content: [{ type: 'text', text: '正文' }],
  }
  if (typeof timestamp === 'number') message.timestamp = timestamp
  return { id, kind: 'pi.tool-result', model: [message] } as unknown as EntryRecord
}

type RunMetaItem = Extract<AgentViewItem, { kind: 'run-meta' }>
function runMetas(items: AgentViewItem[]): RunMetaItem[] {
  return items.filter((item): item is RunMetaItem => item.kind === 'run-meta')
}

await test('run-meta：每个已结束 Run 一条统计行（用时/轮次/token 累计/分支点/位置）', async () => {
  const entries = [
    userEntryAt('u1', '第一轮问题', 1000),
    assistantEntryAt('a2', { text: '第一轮答复', timestamp: 1500, usage: { input: 100, output: 20, cacheRead: 900 } }),
    toolResultEntryAt('t3', 1700),
    assistantEntryAt('a4', { text: '补充回复', timestamp: 2000, usage: { input: 50, output: 10, cacheRead: 300 } }),
    userEntryAt('u5', '第二轮问题', 3000),
    assistantEntryAt('a6', { text: '第二轮答复', timestamp: 3500, usage: { input: 70, output: 5, cacheRead: 10 } }),
  ]
  const items = entryRecordsToItems(entries)
  assert.deepEqual(
    items.map((item) => item.kind),
    ['user', 'assistant', 'tool', 'assistant', 'run-meta', 'user', 'assistant', 'run-meta'],
  )
  const [first, second] = runMetas(items)
  assert.ok(first && second, '两轮各一条统计行')
  // 用时 = 最后一条模型/工具消息 - 用户消息；中间工具调用只延后结束时间，不算轮次
  assert.equal(first.durationMs, 1000)
  assert.equal(first.turns, 2, '轮次 = assistant 条目数（含只调工具的回复）')
  assert.equal(first.inputTokens, 150, 'input 跨轮累计')
  assert.equal(first.cachedTokens, 1200, 'cached 取 cacheRead 累计')
  assert.equal(first.outputTokens, 30)
  assert.equal(first.forkBeforeEntryId, 'u5', '分支点 = 下一条用户条目 id（复制到这一轮为止）')
  assert.equal(first.id, 'run-meta:u1', '统计行 id 绑定开启这一轮的用户条目')
  // 位置：落在下一条用户条目之前，属于上一轮
  assert.equal(items[4].kind, 'run-meta')
  assert.equal((items[5] as unknown as { id: string }).id, 'u5')

  assert.equal(second.durationMs, 500)
  assert.equal(second.turns, 1)
  assert.equal(second.inputTokens, 70)
  assert.equal(second.cachedTokens, 10)
  assert.equal(second.outputTokens, 5)
  assert.equal(second.forkBeforeEntryId, undefined, '最后一条 Run 省略分支点 = 复制全部')
})

await test('run-meta：usage / 时间戳缺失时不产生 NaN，轮次与 token 归零', async () => {
  const items = entryRecordsToItems([
    userEntryAt('u1', '第一轮', 1000),
    assistantEntryAt('a2', { text: '无 usage 无时间戳' }),
    toolResultEntryAt('t3'),
    userEntryAt('u4', '第二轮', 2000),
    assistantEntryAt('a5', { text: '同样没有 usage' }),
  ])
  const [first, second] = runMetas(items)
  assert.ok(first && second)
  // 时间戳缺失：结束时间退化为用户消息时间，时长 0（而不是算出巨大/负数）
  assert.equal(first.durationMs, 0)
  assert.equal(first.turns, 1)
  assert.equal(first.inputTokens, 0)
  assert.equal(first.cachedTokens, 0)
  assert.equal(first.outputTokens, 0)
  assert.equal(first.forkBeforeEntryId, 'u4')
  assert.equal(second.durationMs, 0)
  assert.equal(second.turns, 1)
  for (const meta of runMetas(items)) {
    assert.ok(Number.isFinite(meta.durationMs) && meta.durationMs >= 0, '时长必须是非负有限数')
  }
})

await test('run-meta：空正文用户消息也收尾上一轮，分支点指向该条目 id', async () => {
  const items = entryRecordsToItems([
    userEntryAt('u1', '第一轮', 1000),
    assistantEntryAt('a2', { text: '答复', timestamp: 1400 }),
    userEntryAt('u3', '', 2000), // 空正文：不渲染 user 行，但仍是下一轮的开始
    userEntryAt('u4', '第三轮', 3000),
    assistantEntryAt('a5', { text: '答复2', timestamp: 3300 }),
  ])
  const metas = runMetas(items)
  assert.equal(metas.length, 3, '两个已结束 Run + 最后一条 Run 各一条')
  assert.equal(metas[0].forkBeforeEntryId, 'u3', '分支点可以指向没有渲染行的用户条目')
  assert.equal(metas[1].forkBeforeEntryId, 'u4')
  assert.equal(metas[1].turns, 0, '空正文这一轮没有模型回复')
  assert.equal(metas[1].durationMs, 0)
  assert.equal(metas[2].forkBeforeEntryId, undefined)
})

await test('run-meta：回滚通知覆盖的 Run，统计行也标 rolledBackRun（红线连续）', async () => {
  const items = entryRecordsToItems([
    userEntryAt('u1', '第一轮', 1000),
    assistantEntryAt('a2', { text: '答复', timestamp: 1400 }),
    rollbackEntry('r1', { runs: [{ userIndex: 0, files: ['序章.hs'] }], outcomes: [] }),
    userEntryAt('u3', '第二轮', 2000),
    assistantEntryAt('a4', { text: '答复2', timestamp: 2400 }),
  ])
  const metas = runMetas(items)
  assert.equal(metas.length, 2)
  // 统计行落在被回滚区间内（第一条 user 到下一条 user 之前），应与上下行一起画红线
  assert.equal(flagsOf(metas[0]).rolledBackRun, true, '被回滚 Run 的统计行必须标 rolledBackRun')
  assert.equal(flagsOf(metas[1]).rolledBackRun, undefined, '未被回滚的 Run 不受影响')
  // 对话行的标注保持不变
  const userRow = items.find((item) => item.kind === 'user')
  const assistantRow = items.find((item) => item.kind === 'assistant')
  assert.equal(flagsOf(userRow).rolledBack, true)
  assert.equal(flagsOf(assistantRow).rolledBackRun, true)
})

/* ───────────────── 非 Run 条目（回滚/重置/压缩）作为 Run 边界 ───────────────── */

/** 重置 / 压缩通知：只保留视图认识的 kind，正文由视图自己给出固定文案 */
function boundaryEntry(id: string, kind: 'pi.reset' | 'pi.compaction'): EntryRecord {
  return { id, kind } as unknown as EntryRecord
}

await test('run-meta：回滚通知先收尾当前 Run，统计行排在通知之前，分支点回填下一轮用户', async () => {
  const items = entryRecordsToItems([
    userEntryAt('u1', '第一轮', 1000),
    assistantEntryAt('a2', { text: '答复', timestamp: 1500 }),
    toolResultEntryAt('t3', 1700),
    rollbackEntry('r1', { createdAt: 5, runs: [{ userIndex: 0, files: ['序章.hs'] }], outcomes: [] }),
    userEntryAt('u5', '第二轮', 2000),
    assistantEntryAt('a6', { text: '答复2', timestamp: 2400 }),
  ])
  // 统计行是 Run 的尾巴，不能被回滚卡片「挤到后面」；通知本身不产生统计行。
  assert.deepEqual(
    items.map((item) => item.kind),
    ['user', 'assistant', 'tool', 'run-meta', 'rollback', 'user', 'assistant', 'run-meta'],
  )
  const [first, second] = runMetas(items)
  assert.ok(first && second, '两轮各一条统计行')
  assert.equal(items[3].kind, 'run-meta', '第一条统计行紧跟在工具条目后、通知之前')
  assert.equal(items[4].kind, 'rollback')
  assert.equal(first.durationMs, 700, '通知只收尾当前 Run，不影响已累计的用时')
  assert.equal(first.turns, 1)
  assert.equal(
    first.forkBeforeEntryId,
    'u5',
    '通知后扫到下一轮用户，前一条统计行的分支点要回填（否则分支按钮会丢）',
  )
  assert.equal(second.forkBeforeEntryId, undefined, '末轮仍省略分支点')

  // 红线：第 0 轮区间到下一轮 user 为止，统计行在内、通知不在内
  assert.equal(flagsOf(items[0]).rolledBackRun, true)
  assert.equal(flagsOf(items[3]).rolledBackRun, true, '统计行属于被回滚区间')
  assert.equal(flagsOf(items[4]).rolledBackRun, undefined, '通知自身不画红线')
  assert.equal(flagsOf(items[5]).rolledBackRun, undefined)
  assert.equal(flagsOf(items[7]).rolledBackRun, undefined, '下一轮的统计行不受影响')
})

await test('run-meta：两条 Run 之间的多条通知（含坏 data）仍只回填一次分支点', async () => {
  const items = entryRecordsToItems([
    userEntryAt('u1', '第一轮', 1000),
    assistantEntryAt('a2', { text: '答复', timestamp: 1400 }),
    // 坏通知：视图忽略它，但它仍然是边界，当前 Run 先收尾
    rollbackEntry('bad', null),
    rollbackEntry('r2', { createdAt: 2, runs: [], outcomes: [] }),
    userEntryAt('u3', '第二轮', 2000),
    assistantEntryAt('a4', { text: '答复2', timestamp: 2300 }),
    rollbackEntry('r5', { createdAt: 5, runs: [{ userIndex: 1, files: [] }], outcomes: [] }),
  ])
  assert.deepEqual(
    items.map((item) => item.kind),
    ['user', 'assistant', 'run-meta', 'rollback', 'user', 'assistant', 'run-meta', 'rollback'],
  )
  const metas = runMetas(items)
  assert.equal(metas.length, 2)
  assert.equal(metas[0].durationMs, 400)
  assert.equal(metas[0].forkBeforeEntryId, 'u3', '连续通知不会重复回填/覆盖分支点')
  // 第二条通知（r5）回滚的是第二轮：统计行随整段画红线
  assert.equal(metas[1].forkBeforeEntryId, undefined, '没有后续用户，分支点保持省略')
  assert.equal(flagsOf(metas[1]).rolledBackRun, true, '被回滚的第 1 轮统计行要标红')
  assert.equal(flagsOf(metas[0]).rolledBackRun, undefined, '第 0 轮未回滚，统计行不标红')
})

await test('run-meta：通知之后新一轮统计行照常累计（通知不打断后续 Run）', async () => {
  const items = entryRecordsToItems([
    userEntryAt('u1', '第一轮', 1000),
    assistantEntryAt('a2', { text: '答复', timestamp: 1300 }),
    rollbackEntry('r3', { createdAt: 3, runs: [], outcomes: [] }),
    userEntryAt('u4', '第二轮', 2000),
    assistantEntryAt('a5', {
      text: '答复2',
      timestamp: 2500,
      usage: { input: 7, output: 3, cacheRead: 5 },
    }),
    toolResultEntryAt('t6', 2600),
    userEntryAt('u7', '第三轮', 3000),
    assistantEntryAt('a8', { text: '答复3', timestamp: 3400 }),
  ])
  const metas = runMetas(items)
  assert.equal(metas.length, 3, '通知后两轮各一条 + 第一条被通知收尾')
  assert.equal(metas[0].durationMs, 300)
  assert.equal(metas[0].forkBeforeEntryId, 'u4')
  assert.equal(metas[1].durationMs, 600, '通知之后 startTs 从新用户消息重新计时')
  assert.equal(metas[1].turns, 1)
  assert.equal(metas[1].inputTokens, 7)
  assert.equal(metas[1].cachedTokens, 5)
  assert.equal(metas[1].outputTokens, 3)
  assert.equal(metas[1].forkBeforeEntryId, 'u7')
  assert.equal(metas[2].durationMs, 400)
  assert.equal(metas[2].turns, 1)
  assert.equal(metas[2].inputTokens, 0, '第三轮没有 usage，不继承上一轮')
  assert.equal(metas[2].forkBeforeEntryId, undefined)
  // 位置：每条统计行都在它所属 Run 之后、下一轮用户之前
  assert.deepEqual(
    items.map((item) => item.kind),
    ['user', 'assistant', 'run-meta', 'rollback', 'user', 'assistant', 'tool', 'run-meta', 'user', 'assistant', 'run-meta'],
  )
})

await test('run-meta：重置 / 压缩通知同样先收尾当前 Run，并回填分支点', async () => {
  const cases: { id: string; kind: 'pi.reset' | 'pi.compaction'; text: string }[] = [
    { id: 'x1', kind: 'pi.reset', text: '对话已重置' },
    { id: 'x2', kind: 'pi.compaction', text: '较早的对话已压缩' },
  ]
  for (const notice of cases) {
    const items = entryRecordsToItems([
      userEntryAt('u1', '第一轮', 1000),
      assistantEntryAt('a2', { text: '答复', timestamp: 1400 }),
      boundaryEntry(notice.id, notice.kind),
      userEntryAt('u3', '第二轮', 2000),
      assistantEntryAt('a4', { text: '答复2', timestamp: 2300 }),
    ])
    assert.deepEqual(
      items.map((item) => item.kind),
      ['user', 'assistant', 'run-meta', 'notice', 'user', 'assistant', 'run-meta'],
      `${notice.text} 也要先把当前 Run 收尾`,
    )
    const shown = items[3] as unknown as { kind: string; text: string }
    assert.equal(shown.text, notice.text, `${notice.kind} 通知文案由视图统一给出`)
    const [first, second] = runMetas(items)
    assert.ok(first && second)
    assert.equal(first.forkBeforeEntryId, 'u3', '分支点回填到通知后的下一轮用户')
    assert.equal(second.forkBeforeEntryId, undefined)
    // 这些通知不是回滚，不能给任何行打「已回滚」标记
    for (const item of items) {
      assert.equal(flagsOf(item).rolledBackRun, undefined, '重置/压缩通知不产生回滚标注')
    }
  }
})

/* ───────────────────────── 汇总 ───────────────────────── */

console.log(`\n通过 ${checks} 项，失败 ${failures.length} 项。`)
if (failures.length > 0) {
  console.error(`失败项：${failures.join('、')}`)
  process.exitCode = 1
}
