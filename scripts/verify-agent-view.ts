/**
 * 会话视图映射验收：工具调用参数（`input`）从助手消息回填到工具条目 / 实时工具槽。
 *
 * 背景：工具结果条目本身只有 `toolCallId`，参数只存在于发出请求的那条助手消息里。
 * 面板要在工具结果上显示「输入」，就必须在顺序扫描时把 assistant 条目的 ToolCall 参数
 * 收集起来、再按 callId 配对（src/agent/pi/view.ts:70 `toolCallInputsOf`）。
 * 这里不渲染 React，只断言纯函数的输出。
 *
 * 跑法：`node scripts/run-verification.mjs scripts/verify-agent-view.ts`
 */
import assert from 'node:assert/strict'
import type { ConversationView, EntryRecord, LiveState } from '@earendil-works/pi-durable'
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
  assert.deepEqual(
    items.map((item) => item.kind),
    ['user', 'assistant', 'tool', 'assistant'],
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

/* ───────────────────────── 汇总 ───────────────────────── */

console.log(`\n通过 ${checks} 项，失败 ${failures.length} 项。`)
if (failures.length > 0) {
  console.error(`失败项：${failures.join('、')}`)
  process.exitCode = 1
}
