/**
 * Agent 客户端配置（纯逻辑）验收。
 *
 * 跑法：`node scripts/run-verification.mjs scripts/verify-agent-config.ts`
 *
 * 只测 `src/agent/config.ts` 里不依赖真实浏览器的部分：
 * 模型 id 校验、Pro/Flash 两档默认值与回落规则。Node 下没有 localStorage，
 * `readStorage` 会静默返回空串，正好用来断言「默认值」这一路。
 */

import assert from 'node:assert/strict'
import {
  AGENT_THINKING_LEVELS,
  DEFAULT_BASE_URL,
  DEFAULT_THINKING_LEVEL,
  MODEL_FLASH,
  MODEL_PRO,
  getAgentBaseUrl,
  getAgentModelId,
  getAgentModelIds,
  getAgentThinkingLevel,
  getAgentThinkingLevels,
  getUsePro,
  isValidModelId,
  isValidThinkingLevel,
  setAgentModelIds,
} from '../src/agent/config'

/* ── 模型 id 校验：允许常见厂商写法，挡掉 URL / 空值 / 超长 ── */
assert.equal(isValidModelId('deepseek-v4-pro'), true)
assert.equal(isValidModelId('deepseek-chat'), true)
assert.equal(isValidModelId('Qwen/Qwen2.5-72B'), false, '斜杠不是模型名的合法字符')
assert.equal(isValidModelId('https://api.example.com/v1'), false, '不能把网址填进模型名')
assert.equal(isValidModelId(''), false)
assert.equal(isValidModelId('   '), false)
assert.equal(isValidModelId('a'.repeat(81)), false, '过长的模型名拒绝')
assert.equal(isValidModelId('a'.repeat(80)), true)

/* ── 默认两档：Pro 与 Flash 各有独立 id，互不覆盖 ── */
const defaults = getAgentModelIds()
assert.equal(defaults.pro, MODEL_PRO)
assert.equal(defaults.flash, MODEL_FLASH)
assert.notEqual(defaults.pro, defaults.flash, '两档必须是不同模型，才能分别设置')

/* ── 当前档位随 Pro/Flash 开关走；Node 下默认 Pro ── */
assert.equal(getUsePro(), true, '未设置时默认 Pro')
assert.equal(getAgentModelId(), defaults.pro)

/* ── 网关默认值 ── */
assert.equal(DEFAULT_BASE_URL, 'https://api.deepseek.com')
assert.equal(getAgentBaseUrl(), DEFAULT_BASE_URL, '未设置时网关就是厂商默认值')

/* ── 思考强度：两档各自独立，默认 high ── */
assert.equal(DEFAULT_THINKING_LEVEL, 'high')
assert.ok(isValidThinkingLevel('high') && isValidThinkingLevel('minimal'))
assert.equal(isValidThinkingLevel('highest'), false)
assert.equal(isValidThinkingLevel(''), false)
const levels = getAgentThinkingLevels()
assert.equal(levels.pro, 'high')
assert.equal(levels.flash, 'high')
assert.equal(getAgentThinkingLevel(), levels.pro, '未设置时默认 Pro 档的思考强度')
assert.ok(AGENT_THINKING_LEVELS.includes('max'))

/* ── 无 localStorage 时写设置不能抛；读回来仍是默认值（静默失败是约定） ── */
setAgentModelIds({ pro: 'my-pro', flash: 'my-flash' })
assert.deepEqual(getAgentModelIds(), defaults, '无 localStorage 时写设置静默失败，读回默认值')

console.log('通过：Agent 客户端配置（模型 id 校验、Pro/Flash 两档默认与当前档位）')
