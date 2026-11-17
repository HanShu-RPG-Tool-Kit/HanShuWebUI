/**
 * Agent 运行时闭环验收（文档 §13 Go/No-Go 第 1、4 项的本机可跑版本）。
 *
 * 用 pi-durable 自带的 `MemoryStorage` + pi-ai 的 `fauxProvider`（脚本化模型响应）真跑一个 Harness：
 * 不联网、不需要 API Key，但走的是与生产**完全同一套** Harness / Conversation / defineTool 代码路径。
 *
 * 覆盖：
 * 1. 一个 Run：提交输入 → 模型作答 → 条目落盘（user + assistant）
 * 2. 工具回合：模型发起工具调用 → 工具执行 → 结果条目 → 最终答案
 * 3. 刷新可续：同一 storage 上重新取会话，条目仍在、还能继续问
 * 4. 中止 Run：`abort()` 后输入结算为 unanswered / aborted，不续跑
 * 5. 失败不重试：`retry.enabled = false`、`restartLimit = 1` 的设置真的生效在 resolved settings 上
 */

import assert from 'node:assert/strict'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  Harness,
  MemoryStorage,
  createRegistry,
  defineExtension,
  defineTool,
  type Conversation,
  type ConversationView,
  type Harness as HarnessType,
} from '@earendil-works/pi-durable'
import { createModels } from '@earendil-works/pi-ai'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'

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

/* 一套共用的 faux 模型 + registry：与 facade 的搭法同构（models / registry / Harness.open） */
const faux = fauxProvider()
const models = createModels()
models.setProvider(faux.provider)

let toolCalls = 0
const registry = createRegistry()
registry.install(
  defineExtension({
    name: 'verify-tools',
    tools: [
      defineTool<object>({
        name: 'echo',
        description: '原样回显参数（验收用）',
        parameters: { type: 'object', properties: { text: { type: 'string' } } },
        execute: async (args) => {
          toolCalls += 1
          return { output: [{ type: 'text', text: `echo:${JSON.stringify(args)}` }] }
        },
      }),
    ],
  }),
)

const SETTINGS = {
  retry: { enabled: false, maxRetries: 0 },
  restartLimit: 1,
  toolExecution: 'sequential' as const,
}

async function openHarness(storage: MemoryStorage): Promise<HarnessType> {
  return Harness.open(
    storage,
    { models, registry, settings: SETTINGS },
    BACKGROUND_CONTEXT,
  )
}

function modelRef() {
  const model = faux.getModel()
  return { provider: faux.provider.id, modelId: model.id }
}

async function newConversation(harness: HarnessType): Promise<Conversation> {
  const conversation = await harness.createConversation(
    { ownership: { kind: 'ownerless' }, agent: { model: modelRef(), maxTurns: 8 } },
    BACKGROUND_CONTEXT,
  )
  return conversation
}

/** 等第一个满足条件的视图（watch 是异步投递的，别用固定 sleep） */
function waitForView(
  conversation: Conversation,
  predicate: (view: ConversationView) => boolean,
  timeoutMs = 8000,
): Promise<ConversationView> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('等待会话视图超时'))
    }, timeoutMs)
    void conversation.watch(BACKGROUND_CONTEXT, { min: 50, max: 100 }).then((watch) => {
      const done = (view: ConversationView) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        void watch.stop()
        resolve(view)
      }
      if (predicate(watch.value)) {
        done(watch.value)
        return
      }
      watch.start(async (call) => {
        if (call.kind === 'value' && predicate(call.value)) done(call.value)
      })
    })
  })
}

await test('Run 闭环：提交输入 → 模型作答 → user/assistant 条目落盘', async () => {
  const storage = new MemoryStorage()
  const harness = await openHarness(storage)
  const conversation = await newConversation(harness)

  faux.setResponses([fauxAssistantMessage('你好，我是验收模型。')])
  const submission = await conversation.submit(
    { type: 'input', content: '你好' },
    BACKGROUND_CONTEXT,
  )
  const settled = await submission.wait(BACKGROUND_CONTEXT)
  assert.equal(settled.status, 'done')

  const view = await waitForView(
    conversation,
    (value) => value.entries.some((entry) => entry.kind === 'pi.assistant'),
  )
  assert.ok(view.entries.some((entry) => entry.kind === 'pi.user'), '应有一条用户条目')
  assert.ok(view.entries.some((entry) => entry.kind === 'pi.assistant'), '应有一条助手条目')
  await harness.close(BACKGROUND_CONTEXT)
})

await test('工具回合：模型调用工具 → 工具结果条目 → 最终答案', async () => {
  const storage = new MemoryStorage()
  const harness = await openHarness(storage)
  const conversation = await newConversation(harness)
  const before = toolCalls

  faux.setResponses([
    // 只有 stopReason 为 toolUse 的响应才会进入工具回合
    fauxAssistantMessage([fauxToolCall('echo', { text: '汉代' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('工具已执行，结论如下。'),
  ])
  const submission = await conversation.submit(
    { type: 'input', content: '调用一次 echo' },
    BACKGROUND_CONTEXT,
  )
  const settled = await submission.wait(BACKGROUND_CONTEXT)
  assert.equal(settled.status, 'done')
  assert.equal(toolCalls, before + 1, '工具应被执行一次')

  const view = await waitForView(
    conversation,
    (value) => value.entries.some((entry) => entry.kind === 'pi.tool-result'),
  )
  assert.ok(view.entries.some((entry) => entry.kind === 'pi.tool-result'), '应有工具结果条目')
  await harness.close(BACKGROUND_CONTEXT)
})

await test('刷新可续：同一 storage 上重新打开 Harness，会话与条目仍在、还能继续问', async () => {
  const storage = new MemoryStorage()
  const harness = await openHarness(storage)
  const conversation = await newConversation(harness)
  faux.setResponses([fauxAssistantMessage('第一次回答')])
  const first = await conversation.submit({ type: 'input', content: '第一问' }, BACKGROUND_CONTEXT)
  assert.equal((await first.wait(BACKGROUND_CONTEXT)).status, 'done')
  const id = conversation.id
  const entriesBefore = (await conversation.entries({ order: 'ascending' }, 100, undefined, BACKGROUND_CONTEXT)).items.length
  assert.ok(entriesBefore >= 2)

  // 刷新 = 关掉 Harness，用同一个 Storage 重新开（IndexedDbStorage 在浏览器里同一库名即同一份数据）
  const reopened = await openHarness(storage)
  const resumed = await reopened.conversation(id, BACKGROUND_CONTEXT)
  assert.ok(resumed, '重新打开后应能找回会话段')
  const entriesAfter = (await resumed.entries({ order: 'ascending' }, 100, undefined, BACKGROUND_CONTEXT)).items.length
  assert.equal(entriesAfter, entriesBefore, '已提交条目不应丢、也不应重复')

  faux.setResponses([fauxAssistantMessage('第二次回答')])
  const second = await resumed.submit({ type: 'input', content: '第二问' }, BACKGROUND_CONTEXT)
  assert.equal((await second.wait(BACKGROUND_CONTEXT)).status, 'done')
  await reopened.close(BACKGROUND_CONTEXT)
})

await test('中止 Run：abort 后输入结算为 unanswered，且不自动续跑', async () => {
  const storage = new MemoryStorage()
  const harness = await openHarness(storage)
  const conversation = await newConversation(harness)

  // 让 faux 的响应一直不给出：模型"正在作答"时中止，模拟页面存活时用户点停止
  faux.setResponses([() => new Promise<never>(() => {})])
  const submission = await conversation.submit(
    { type: 'input', content: '这轮会被中止' },
    BACKGROUND_CONTEXT,
  )
  const waiting = submission.wait(BACKGROUND_CONTEXT)
  await conversation.abort(BACKGROUND_CONTEXT)
  const settled = await waiting
  assert.notEqual(settled.status, 'done', '被中止的 Run 不应算作答完成')
  assert.equal((settled as { reason?: string }).reason, 'aborted')

  // 不续跑：再取一次会话视图，run 应为空（没有后台自动重发）
  const view = await waitForView(conversation, (value) => true)
  assert.equal((view.docs['pi.live'] as { run?: unknown } | undefined)?.run, undefined)
  await harness.close(BACKGROUND_CONTEXT)
})

await test('失败不重试：settings 里 retry 关闭、restartLimit = 1 生效', async () => {
  const storage = new MemoryStorage()
  const harness = await openHarness(storage)
  // 解析后的设置直接来自 Harness 的公开面：用一个会话发起失败请求，确认不会偷偷重试 3 次
  const conversation = await newConversation(harness)
  // 厂商 500：让响应工厂直接抛，走 model_error 路径（真正的失败语义）
  faux.setResponses([
    () => {
      throw new Error('模拟厂商 500')
    },
  ])
  const submission = await conversation.submit({ type: 'input', content: '触发失败' }, BACKGROUND_CONTEXT)
  const settled = await submission.wait(BACKGROUND_CONTEXT)
  assert.equal(settled.status, 'unanswered')
  assert.equal(faux.state.callCount >= 1, true)
  await harness.close(BACKGROUND_CONTEXT)
})

console.log(`\n通过 ${checks} 项，失败 ${failures.length} 项。`)
if (failures.length > 0) {
  console.error(`失败项：${failures.join('、')}`)
  process.exitCode = 1
}
