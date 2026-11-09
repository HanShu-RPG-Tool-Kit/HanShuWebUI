/**
 * 语法层文本安全判定与注入点扫描的验收（非 agent 层，独立于工具）。
 */
import assert from 'node:assert/strict'
import {
  assessLangValueRisks,
  unsafeInlineReason,
} from '../src/hanshu/inlineText'
import {
  collectInjectDefinitions,
  collectJumpTargets,
} from '../src/hanshu/injectRefs'

let checks = 0
const failures: string[] = []
function test(name: string, run: () => void) {
  try {
    run()
    checks += 1
    console.log(`通过：${name}`)
  } catch (error) {
    failures.push(name)
    console.error(`失败：${name}`, error)
  }
}

const NL = String.fromCharCode(10)

/* ── unsafeInlineReason ── */

test('含 // 的文本不能内联回正文（line-terminator）', () => {
  assert.equal(unsafeInlineReason('go // now', 'dialogue'), 'line-terminator')
  assert.equal(unsafeInlineReason('a//b', 'optionText'), 'line-terminator')
})

test('选项文案/回复里的 : 不能内联；对白正文里的 : 允许', () => {
  assert.equal(unsafeInlineReason('Where is this: really?', 'optionText'), 'option-colon')
  assert.equal(unsafeInlineReason('reply: yes', 'optionReply'), 'option-colon')
  assert.equal(unsafeInlineReason('时间: 12:00', 'dialogue'), null)
})

test('行首结构字符不能内联；普通文本可以', () => {
  assert.equal(unsafeInlineReason('?还有别的吗', 'optionText'), 'leading-structure')
  assert.equal(unsafeInlineReason('!注意', 'dialogue'), 'leading-structure')
  assert.equal(unsafeInlineReason('@guard', 'dialogue'), 'leading-structure')
  assert.equal(unsafeInlineReason('# 不是注释', 'dialogue'), 'leading-structure')
  assert.equal(unsafeInlineReason('*选项', 'dialogue'), 'leading-structure')
  assert.equal(unsafeInlineReason('普通一句台词', 'dialogue'), null)
})

test('多行文本不能内联；>>/<< 由转义负责，不算不安全', () => {
  assert.equal(unsafeInlineReason(`第一行${NL}第二行`, 'dialogue'), 'line-break')
  assert.equal(unsafeInlineReason('>>name', 'dialogue'), null)
  assert.equal(unsafeInlineReason('-减号开头', 'dialogue'), null)
  assert.equal(unsafeInlineReason('', 'dialogue'), 'empty')
})

test('assessLangValueRisks 汇总风险并标注首尾空白', () => {
  assert.deepEqual(assessLangValueRisks('go // now', 'dialogue'), [
    'line-terminator',
  ])
  assert.deepEqual(assessLangValueRisks(' x ', 'dialogue'), [
    'edge-space',
    'leading-space',
    'trailing-space',
  ])
  assert.deepEqual(assessLangValueRisks('reply: yes', 'optionReply'), [
    'option-colon',
  ])
  assert.deepEqual(assessLangValueRisks('正常译文', 'dialogue'), [])
})

test('首尾空白不能内联（P3：内联后会污染正文并导致换键）', () => {
  assert.equal(unsafeInlineReason('好 ', 'dialogue'), 'edge-space')
  assert.equal(unsafeInlineReason(' 好', 'dialogue'), 'edge-space')
  assert.equal(unsafeInlineReason('好', 'dialogue'), null)
})

test('以 >> / << 开头的译文给 leading-jump / leading-rewind 警告（A5 覆盖）', () => {
  assert.deepEqual(assessLangValueRisks('>>test_inject', 'dialogue'), [
    'leading-jump',
  ])
  assert.deepEqual(assessLangValueRisks('<<回整树根', 'optionReply'), [
    'leading-rewind',
  ])
  assert.deepEqual(assessLangValueRisks('go >> later', 'dialogue'), [])
})

/* ── 注入点 / 跳转引用扫描 ── */

test('收集 @name 注入点：忽略 @@、注释与有前导空格的 @', () => {
  const content = [
    '@guard',
    '@@',
    '  @indented',
    '# @commented',
    '@second_point',
  ].join(NL)
  assert.deepEqual(collectInjectDefinitions(content), [
    { name: 'guard', line: 1 },
    { name: 'second_point', line: 5 },
  ])
})

test('收集 :>>name 跳转引用：注释行跳过、行号正确、不误认 --<<', () => {
  const content = [
    '-去问卫兵:>>guard//',
    '# -注释里的:>>ignored//',
    '--<<',
    '-再问:>> second_point//',
  ].join(NL)
  assert.deepEqual(collectJumpTargets(content), [
    { name: 'guard', line: 1 },
    { name: 'second_point', line: 4 },
  ])
})

/* ── 汇总 ── */

console.log(`\n通过 ${checks} 项，失败 ${failures.length} 项。`)
if (failures.length > 0) {
  console.error(`失败项：${failures.join('、')}`)
  process.exitCode = 1
}
