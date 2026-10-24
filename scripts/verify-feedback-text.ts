import assert from 'node:assert/strict'
import {
  applyFeedbackStyleRange,
  clearFeedbackStyles,
  parseFeedbackText,
  replaceFeedbackPlainText,
  stringifyFeedbackText,
} from '../src/workspaces/progress/feedbackText'
import { textComponentSegments } from '../src/workspaces/progress/itemTooltip'

function roundTrip(raw: string) {
  return stringifyFeedbackText(parseFeedbackText(raw))
}

assert.equal(stringifyFeedbackText([{ text: '' }]), '')
assert.equal(stringifyFeedbackText([{ text: '欢迎' }]), '欢迎')
assert.deepEqual(parseFeedbackText('欢迎'), [{ text: '欢迎' }])

const gold = stringifyFeedbackText([{ text: '欢迎', color: '#FFAA00' }])
assert.equal(gold, JSON.stringify({ text: '欢迎', color: '#FFAA00' }))
assert.deepEqual(parseFeedbackText(gold), [{ text: '欢迎', color: '#FFAA00' }])
assert.equal(roundTrip(gold), gold)

const named = stringifyFeedbackText([{ text: '红', color: '#FF5555', bold: true }])
assert.equal(
  named,
  JSON.stringify({ text: '红', color: '#FF5555', bold: true }),
)
assert.deepEqual(parseFeedbackText(named), [
  { text: '红', color: '#FF5555', bold: true },
])

const multi = stringifyFeedbackText([
  { text: 'A', color: '#FFFFFF' },
  { text: 'B', color: '#55FFFF', italic: true },
])
assert.equal(
  multi,
  JSON.stringify({
    text: '',
    extra: [
      { text: 'A', color: '#FFFFFF' },
      { text: 'B', color: '#55FFFF', italic: true },
    ],
  }),
)
assert.deepEqual(parseFeedbackText(multi), [
  { text: 'A', color: '#FFFFFF' },
  { text: 'B', color: '#55FFFF', italic: true },
])
assert.equal(roundTrip(multi), multi)

const scary = stringifyFeedbackText([{ text: '{"text":"x"}' }])
assert.equal(scary, JSON.stringify({ text: '{"text":"x"}' }))
assert.deepEqual(parseFeedbackText(scary), [{ text: '{"text":"x"}' }])

assert.deepEqual(parseFeedbackText(JSON.stringify({ text: '金', color: 'gold' })), [
  { text: '金', color: '#FFAA00' },
])

assert.deepEqual(textComponentSegments(multi), [
  { text: 'A', color: '#FFFFFF' },
  { text: 'B', color: '#55FFFF', italic: true },
])

// 选区上色 → 自动拆段；同款相邻再合并
const painted = applyFeedbackStyleRange(
  [{ text: '你好世界' }],
  2,
  4,
  { color: '#FF5555' },
)
assert.deepEqual(painted, [
  { text: '你好' },
  { text: '世界', color: '#FF5555' },
])

const whole = applyFeedbackStyleRange(painted, 0, 4, { bold: true })
assert.deepEqual(whole, [
  { text: '你好', bold: true },
  { text: '世界', color: '#FF5555', bold: true },
])

const merged = applyFeedbackStyleRange(whole, 0, 4, { color: '#FF5555' })
assert.deepEqual(merged, [
  { text: '你好世界', color: '#FF5555', bold: true },
])

// 改正文时尽量保留前缀样式
const rewritten = replaceFeedbackPlainText(painted, '你好啊世界')
assert.deepEqual(rewritten, [
  { text: '你好' },
  { text: '啊世界', color: '#FF5555' },
])

assert.deepEqual(replaceFeedbackPlainText(painted, ''), [{ text: '' }])
assert.equal(stringifyFeedbackText([{ text: '' }]), '')

assert.deepEqual(clearFeedbackStyles(merged, 0, 4), [{ text: '你好世界' }])
assert.deepEqual(clearFeedbackStyles(painted, 2, 4), [{ text: '你好世界' }])

console.log('通过：feedback 文本组件编解码 / 选区样式拆合 / 清除样式')
