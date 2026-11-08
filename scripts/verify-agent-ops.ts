/**
 * 宿主层 P2/P3（阶段 6-B / 草案 D6）纯函数验收。
 *
 * 覆盖：
 * ① `paginateSource`：limit > 2000 截断并标 `limitClamped`；offset/分页边界；
 * ② `readSource` 的 offset 越界判定（`sourceOffsetError`）；
 * ③ `.hs` agent lint：非法角色名 / 全角冒号 / 未转义 `-` / 对白块内选项行，全部带行号；
 *    转义后的 `-` 不报；`.char` 不跑这套 lint；
 * ④ 语言键校验：8 位小写十六进制，非法与同调用重复分开报；
 * ⑤ 编译错误：带 code/line，agent 侧消息英文（编辑器 UI 的中文 message 不变）；
 * ⑥ P1 键复用：parse 不把 map 全量当占用，unparse→parse 键稳定；
 * ⑦ P5 配音文案：ok 只说 mono Vorbis Ogg，invalid 才给原因；
 * ⑧ P10 键格式 lint：大写 / 长度不对的十六进制；纯小写数字不误报；
 * ⑨ panel-ui 纯函数：collectOrphanKeys / translateExportWarning；
 * ⑩ B6 未成键检测：countUnparsedTexts + validate_source 汇总诊断；
 * ⑪ 1 语言路径反推源名（sourceNameFromLangPath）；
 * ⑫ A3 反解析安全内联（unrepresentable）；
 * ⑬ A4 跳转目标 lint；
 * ⑭ B9 诊断补 1 起行号。
 *
 * 跑法：node scripts/run-verification.mjs scripts/verify-agent-ops.ts
 */

import assert from 'node:assert/strict'
import { compileHsToHsc, HsCompileError } from '../src/hanshu/compiler'
import {
  LANG_KEY_PATTERN,
  collectOrphanKeys,
  countUnparsedTexts,
  lintHsSource,
  paginateSource,
  parseSourceText,
  sourceNameFromLangPath,
  sourceOffsetError,
  translateExportWarning,
  unparseSourceText,
  validateLangKeys,
  validateSourceContent,
  voiceFormatNote,
} from '../src/agent/agentOps'
import { suspectKeySpans } from '../src/hanshu/sourceKeys'

/* ── ① 分页 ── */
{
  const lines = Array.from({ length: 3000 }, (_, index) => `line-${index + 1}`)
  const content = lines.join('\n')

  const big = paginateSource(content, 1, 5000)
  assert.equal(big.limitClamped, true, 'limit > 2000 必须标 limitClamped')
  assert.equal(big.content.split('\n').length, 2000, '截到 2000 行')
  assert.equal(big.truncated, true, '被截断时 truncated=true')

  const exact = paginateSource(content, 1, 2000)
  assert.equal(exact.limitClamped, false, 'limit=2000 不算 clamp')

  const page = paginateSource(content, 100, 10)
  assert.equal(page.content.split('\n')[0], 'line-100', 'offset 1-based')
  assert.equal(page.content.split('\n').length, 10)
  assert.equal(page.truncated, true)
  assert.equal(page.offset, 100)

  const tail = paginateSource(content, 2995, 10)
  assert.equal(tail.content.split('\n').length, 6, '尾部只返回剩余行')
  assert.equal(tail.truncated, false)

  const empty = paginateSource('', 1, 10)
  assert.equal(empty.totalLines, 1)
  assert.equal(empty.limitClamped, false)
  assert.equal(paginateSource(content, 0, 10).offset, 1, '非正 offset 兜底为 1')
}

/* ── ② offset 越界 ── */
assert.deepEqual(sourceOffsetError(10, 11), {
  ok: false,
  error: 'offset out of range',
  totalLines: 10,
})
assert.equal(sourceOffsetError(10, 10), null, 'offset = 总行数是最后一行，合法')
assert.equal(sourceOffsetError(10, 0), null, '0 兜底为 1，不算越界')
assert.equal(sourceOffsetError(10, undefined), null)

/* ── ③ `.hs` agent lint ── */
const lintSource = [
  '旁白:你好', // 1 非法角色名（中文）
  'narrator：你好', // 2 全角冒号
  'narrator:', // 3 多行对白块开始
  '这一句里有-破折号', // 4 未转义 -
  '*选项写进了对白块', // 5 块内选项行
  '这一句用 \\- 转义', // 6 合法
  '//', // 7 结束块
  'narrator:正常//', // 8 合法单行
  '-选项:回复//', // 9 块外选项，合法
].join('\n')

const lint = lintHsSource(lintSource)
assert.deepEqual(
  lint.map((item) => item.line),
  [1, 2, 4, 5],
  '四类问题各报一次且行号正确（转义后的 - 不报）',
)
assert.ok(lint.every((item) => item.kind === 'agent-lint'))
assert.ok(/^line 1: invalid character name/.test(lint[0]!.message), '英文消息带行号')
assert.ok(/full-width colon/.test(lint[1]!.message))
assert.ok(/unescaped "-"/.test(lint[2]!.message))
assert.ok(/choice line inside a dialogue block/.test(lint[3]!.message))

const validLint = lintHsSource(
  [
    '# 注释里的：和 - 都不管',
    'narrator:正常正文//',
    'narrator:正文里可以有全角：标点//',
  ].join('\n'),
)
assert.equal(validLint.length, 0, '注释/正文标点不误报')

/* `.hs` 走 lint，`.char` 保持原诊断（没有 agent-lint） */
const hs = validateSourceContent(
  '序章.hs',
  ['旁白:你好', 'narrator:', '正文', '//'].join('\n'),
)
assert.ok(hs.diagnostics.some((item) => item.kind === 'agent-lint'), '.hs 带 agent lint')
const char = validateSourceContent('角色.char', '旁白:你好')
assert.ok(!char.diagnostics.some((item) => item.kind === 'agent-lint'), '.char 不跑 agent lint')

/* ── ④ 语言键 ── */
assert.equal(LANG_KEY_PATTERN.test('1a2b3c4d'), true)
assert.equal(LANG_KEY_PATTERN.test('1A2B3C4D'), false, '大写不合法')
assert.deepEqual(validateLangKeys(['1a2b3c4d', '1A2B3C4D', '1234567']), {
  invalidKeys: ['1A2B3C4D', '1234567'],
  duplicates: [],
})
assert.deepEqual(validateLangKeys(['1a2b3c4d', '1a2b3c4d', 'deadbeef']), {
  invalidKeys: [],
  duplicates: ['1a2b3c4d'],
})
assert.deepEqual(validateLangKeys([' 1a2b3c4d', '1a2b3c4d ']), {
  invalidKeys: [' 1a2b3c4d', '1a2b3c4d '],
  duplicates: [],
}, '不再替模型 trim / 小写归一化')

/* ── ⑤ 编译错误 → agent 英文（D5；编辑器 UI 仍用中文 message） ── */
const outside = validateSourceContent('chapter.hs', 'narrator:7f3a91c2')
assert.ok(outside.compileError, '未闭合语句应报编译错误')
assert.equal(outside.compileError.code, 'key-outside-span')
assert.equal(outside.compileError.line, 1)
assert.ok(
  outside.compileError.message.startsWith(
    'line 1: key must live inside a closed statement',
  ),
  outside.compileError.message,
)
assert.equal(
  /\p{Script=Han}/u.test(outside.compileError.message),
  false,
  'agent 侧编译错误必须英文',
)

const multipleKeys = validateSourceContent(
  'chapter.hs',
  ['narrator:', 'faw613da', '# scene', 'a1b2c3d4', '//'].join('\n'),
)
assert.ok(multipleKeys.compileError, '一个块多个键应报编译错误')
assert.equal(multipleKeys.compileError.code, 'multiple-keys-in-block')
assert.equal(multipleKeys.compileError.line, 4)
assert.ok(
  multipleKeys.compileError.message.startsWith(
    'line 4: a multi-line dialogue block may contain only one key',
  ),
  multipleKeys.compileError.message,
)
assert.equal(/\p{Script=Han}/u.test(multipleKeys.compileError.message), false)

// 编辑器 UI 仍拿中文 message：编译器本身不改文案，只多给 code/line
try {
  compileHsToHsc('narrator:7f3a91c2')
  assert.fail('应当抛错')
} catch (error) {
  assert.ok(error instanceof HsCompileError)
  assert.match(error.message, /^第 1 行：/, '编辑器 UI 的中文 message 保持不变')
  assert.equal(error.code, 'key-outside-span')
  assert.equal(error.line, 1)
}

/* ── ⑥ P1 键复用：parse 不再把 map 全量当占用 ── */
const p1Source = ['narrator:', '你好，世界。', '//'].join('\n')
const initial = parseSourceText(p1Source, {})
assert.equal(initial.entries.length, 1)
const reusedKey = initial.entries[0]![0]
assert.match(reusedKey, LANG_KEY_PATTERN)
const translation = { [reusedKey]: '你好，世界。' }

// 三轮 parse → unparse：unparse 把译文还原成正文后再成键，键必须稳定
let roundTrip = p1Source
for (let round = 1; round <= 3; round += 1) {
  const parsed = parseSourceText(roundTrip, translation)
  assert.equal(parsed.entries[0]?.[0], reusedKey, `第 ${round} 轮 parse 的键必须一致`)
  assert.equal(parsed.reused, 1, '命中同文本已有键 → reused=1')
  roundTrip = unparseSourceText(parsed.content, translation).content
}

// map 有历史键、正文没有该键：同文本依然复用
const historical = { aaaaaaaa: '历史译文', bbbbbbbb: '另一条' }
const fromHistory = parseSourceText(['narrator:', '历史译文', '//'].join('\n'), historical)
assert.equal(fromHistory.entries[0]![0], 'aaaaaaaa', '同文本必须复用历史键')
assert.equal(fromHistory.reused, 1)

// 不同文本不冲突
const multiText = parseSourceText(
  ['narrator:', '历史译文', '//', 'narrator:', '全新的台词', '//'].join('\n'),
  historical,
)
assert.equal(multiText.entries[0]![0], 'aaaaaaaa')
assert.notEqual(multiText.entries[1]![0], 'bbbbbbbb', '不用没对上的历史键')
assert.notEqual(multiText.entries[1]![0], 'aaaaaaaa')
assert.match(multiText.entries[1]![0], LANG_KEY_PATTERN)

// 同文件同文本两处 → 同键
const repeated = parseSourceText(
  ['narrator:', '重复台词', '//', 'narrator:', '重复台词', '//'].join('\n'),
  {},
)
assert.equal(repeated.entries.length, 2)
assert.equal(repeated.entries[0]![0], repeated.entries[1]![0], '同文本两处必须同键')

// 非法（大写）的历史键不参与复用
const invalidHistory = { 'ABCDEF12': '历史译文' }
const fromInvalid = parseSourceText(['narrator:', '历史译文', '//'].join('\n'), invalidHistory)
assert.notEqual(fromInvalid.entries[0]![0], 'ABCDEF12')
assert.match(fromInvalid.entries[0]![0], LANG_KEY_PATTERN)

/* ── ⑦ P5 配音文案：合格只说 mono Vorbis Ogg，invalid 才给原因 ── */
const monoInfo = { ogg: true, codec: 'vorbis' as const, channels: 1, sampleRate: 44100 }
assert.equal(voiceFormatNote(monoInfo, 'ok'), 'mono Vorbis Ogg')
assert.equal(voiceFormatNote(monoInfo, 'ok').includes('mono required'), false, 'ok 不能提示需要单声道')
assert.equal(voiceFormatNote(monoInfo, 'ref'), 'mono Vorbis Ogg', '.ref 合格也走同一文案')
const notOgg = { ogg: false, codec: null, channels: null, sampleRate: null }
assert.equal(voiceFormatNote(notOgg, 'invalid'), 'not an ogg container')
assert.match(
  voiceFormatNote({ ogg: true, codec: 'opus', channels: 1, sampleRate: 48000 }, 'invalid'),
  /Opus/,
)
assert.match(
  voiceFormatNote({ ogg: true, codec: 'vorbis', channels: 2, sampleRate: 44100 }, 'invalid'),
  /2 channel/,
)

/* ── ⑧ P10 键格式 lint：大写 / 长度不对的十六进制，纯小写数字不误报 ── */
const upperKey = validateSourceContent('chapter.hs', 'narrator:7F3A91C2//')
assert.ok(
  upperKey.diagnostics.some(
    (item) =>
      item.kind === 'agent-lint' &&
      item.line === 1 &&
      item.message.includes('not a valid 8-digit lowercase hex key'),
  ),
  '8 位大写键应当报 agent-lint',
)
const shortUpper = validateSourceContent('chapter.hs', 'narrator:7F3A91C//')
assert.ok(
  shortUpper.diagnostics.some(
    (item) => item.kind === 'agent-lint' && item.message.includes('7F3A91C'),
  ),
  '6–10 位含大写的十六进制也应报',
)
const plainDigits = validateSourceContent('chapter.hs', 'narrator:123456//')
assert.equal(
  plainDigits.diagnostics.some(
    (item) => item.kind === 'agent-lint' && item.message.includes('not a valid'),
  ),
  false,
  '纯小写数字台词不误报',
)
const lowerKey = validateSourceContent('chapter.hs', 'narrator:7f3a91c2//')
assert.equal(
  lowerKey.diagnostics.some(
    (item) => item.kind === 'agent-lint' && item.message.includes('not a valid'),
  ),
  false,
  '合法小写键不报',
)
const charFile = validateSourceContent('character.char', 'narrator:7F3A91C2//')
assert.equal(
  charFile.diagnostics.some((item) => item.kind === 'agent-lint'),
  false,
  '.char 不跑 agent lint',
)
assert.deepEqual(
  suspectKeySpans(['narrator:', '7E3A91C', '//'].join('\n')).map((item) => item.text),
  ['7E3A91C'],
)
assert.deepEqual(suspectKeySpans(['narrator:', '123456', '//'].join('\n')), [])

/* ── ⑨ panel-ui 纯函数：孤儿键 / 导出 warning 英文化 ── */
assert.deepEqual(
  collectOrphanKeys(['aaaaaaaa'], { aaaaaaaa: 'A', cccccccc: 'C', bbbbbbbb: 'B' }),
  [
    { key: 'bbbbbbbb', text: 'B' },
    { key: 'cccccccc', text: 'C' },
  ],
  '孤儿键按 key 排序',
)
assert.deepEqual(collectOrphanKeys([], {}), [])

const gameplayWarning = translateExportWarning(
  '符号 skill_1 已提供但未被引用（src/script/skill_1.js）',
)
assert.equal(gameplayWarning.group, 'gameplay')
assert.match(gameplayWarning.message, /symbol skill_1/)
assert.ok(gameplayWarning.message.includes('src/script/skill_1.js'))
const assetsWarning = translateExportWarning(
  'assets/zh_cn/lang_hs/a.lang: 找不到已导出的所属源文件，已跳过',
)
assert.equal(assetsWarning.group, 'assets')
assert.match(assetsWarning.message, /owning source file/)
const otherWarning = translateExportWarning('某个未知的中文 warning')
assert.equal(otherWarning.group, 'other')
assert.equal(/[\u4e00-\u9fff]/.test(otherWarning.message), false, 'other 兜底不能夹中文')

/* ── ⑩ B6 未成键检测：parseSourceText 干跑 + 汇总诊断 ── */
const unparsed = countUnparsedTexts(['narrator:', '你好', '//'].join('\n'), 'chapter.hs')
assert.equal(unparsed.count, 1)
assert.deepEqual(unparsed.samples, [{ line: 2, text: '你好' }])

const allKeyed = countUnparsedTexts('narrator:7f3a91c2//', 'chapter.hs')
assert.equal(allKeyed.count, 0, '已全部成键 → 0')
assert.deepEqual(allKeyed.samples, [])

const afterStop = countUnparsedTexts(
  ['narrator:', '你好', '//', '#stopparse', 'narrator:', '引擎原文', '//'].join('\n'),
  'chapter.hs',
)
assert.equal(afterStop.count, 1, '#stopparse 之后不计')

const manyTexts = countUnparsedTexts(
  [
    'narrator:',
    '一',
    '//',
    'narrator:',
    '二',
    '//',
    'narrator:',
    '三',
    '//',
    'narrator:',
    '四',
    '//',
  ].join('\n'),
  'chapter.hs',
)
assert.equal(manyTexts.count, 4)
assert.equal(manyTexts.samples.length, 3, '样本最多 3 条')

const validateUnkeyed = validateSourceContent(
  'chapter.hs',
  ['narrator:', '还没有键', '//'].join('\n'),
)
const unkeyedSummary = validateUnkeyed.diagnostics.find(
  (item) => item.kind === 'agent-lint' && item.message.includes('not keyed yet'),
)
assert.ok(unkeyedSummary, 'validate_source 要有一条未成键汇总诊断')
assert.equal(unkeyedSummary.line, 2)
assert.match(
  unkeyedSummary.message,
  /^1 localizable text segment\(s\) are not keyed yet; run parse_hs to create keys$/,
)
const validateKeyed = validateSourceContent('chapter.hs', 'narrator:7f3a91c2//')
assert.equal(
  validateKeyed.diagnostics.some(
    (item) => item.kind === 'agent-lint' && item.message.includes('not keyed yet'),
  ),
  false,
)

/* ── ⑪ 1 语言资产路径反推源文件逻辑名（unlock_lang 省略 locales 用） ── */
assert.equal(sourceNameFromLangPath('assets/zh_cn/lang_hs/序章.lang'), '序章.hs')
assert.equal(sourceNameFromLangPath('assets/en_us/lang_char/sub/角色.lang'), 'sub/角色.char')
assert.equal(sourceNameFromLangPath('assets/ja_jp/lang_md/docs/说明.lang'), 'docs/说明.md')
assert.equal(sourceNameFromLangPath('assets/zh_cn/voice_hs/序章/7f3a91c2.ogg'), null)
assert.equal(sourceNameFromLangPath('src/hanshu/序章.hs'), null)

/* ── ⑫ A3 反解析安全内联：不安全文本不内联，进 unrepresentable ── */
const unparseMap = {
  '11111111': '普通文本',
  '22222222': '带 // 的译文',
  '33333333': '含冒号:回复',
  '44444444': 'a >> b',
}
const unparseSource = [
  'narrator:11111111//',
  'narrator:22222222//',
  '-问题:33333333//',
  'narrator:44444444//',
].join('\n')
const safeUnparse = unparseSourceText(unparseSource, unparseMap)
assert.equal(safeUnparse.replaced, 2, '普通文本与 >> 文本可内联')
assert.match(safeUnparse.content, /narrator:普通文本\/\//)
assert.match(safeUnparse.content, /narrator:22222222\/\//, '含 // 的译文保持原键名')
assert.match(safeUnparse.content, /-问题:33333333\/\//, '选项回复里的键保持原样')
assert.ok(safeUnparse.content.includes('a \\>> b'), '>> 仍要转义')
const unsafeReasons = new Map(
  safeUnparse.unrepresentable.map((item) => [item.key, item.reason]),
)
assert.equal(unsafeReasons.get('22222222'), 'line-terminator')
assert.equal(unsafeReasons.get('33333333'), 'option-colon')

/* ── ⑬ A4 跳转目标 lint：本文件 / foreignInjects / 注释 ── */
const jumpFound = validateSourceContent('a.hs', ['@start', '-去:>>start//'].join('\n'))
assert.equal(
  jumpFound.diagnostics.some(
    (item) => item.kind === 'agent-lint' && item.message.startsWith('jump target not found'),
  ),
  false,
)
const jumpMissing = validateSourceContent('a.hs', '-去:>>missing//')
const missingJump = jumpMissing.diagnostics.find(
  (item) => item.kind === 'agent-lint' && item.message === 'jump target not found: missing',
)
assert.ok(missingJump, '缺失跳转目标要报 agent-lint')
assert.equal(missingJump.line, 1)
const jumpForeign = validateSourceContent('a.hs', '-去:>>OTHER//', {
  foreignInjects: new Map([['other', 'b.hs']]),
})
assert.equal(
  jumpForeign.diagnostics.some(
    (item) => item.kind === 'agent-lint' && item.message.startsWith('jump target not found'),
  ),
  false,
  '跨文件注入点大小写不敏感',
)
const jumpComment = validateSourceContent('a.hs', ['# 注释 :>>nowhere', 'narrator:7f3a91c2//'].join('\n'))
assert.equal(
  jumpComment.diagnostics.some(
    (item) => item.kind === 'agent-lint' && item.message.startsWith('jump target not found'),
  ),
  false,
  '注释里的 :>> 不报',
)

/* ── ⑭ B9 诊断统一补 1 起行号（保留 offset） ── */
const hsDiagnostics = validateSourceContent('a.hs', ['narrator:', '正文', ''].join('\n'))
assert.ok(hsDiagnostics.diagnostics.length > 0)
assert.ok(
  hsDiagnostics.diagnostics.every((item) => Number.isInteger(item.line) && item.line >= 1),
  '每条 .hs 诊断都要有 1 起 line',
)
const charDiagnostics = validateSourceContent('role.char', ['key:msg//', 'broken line'].join('\n'))
const badChar = charDiagnostics.diagnostics.find((item) => item.kind === 'invalid-char-line')
assert.ok(badChar, '.char 诊断要保留 kind/offset 并补 line')
assert.equal((badChar as { offset: number }).offset > 0, true)
assert.equal(badChar.line, 2)

console.log(
  '通过：宿主层（分页/lint/语言键/编译映射/P1/P5/P10/panel 纯函数/B6/路径反推/A3 安全内联/A4 跳转 lint/B9 行号）',
)
