/**
 * `.hs → .hsc` 编译的回归检查（`npm run test:hs-compile`）。
 *
 * 钉住四件事：
 * 1. **闭合跟随多行文本的标准规则**：`speaker:` 不再要求 `//` 与键名同一行行末 ——
 *    多行块 `speaker:` + `<键>` + 独占一行的 `//`（成键后的标准形态）必须能编译；
 * 2. **没闭合仍然报错**：键名摊在未闭合 / 不成键的语句里一律抛 `HsCompileError`；
 * 3. **一个多行块只能有一个键名**：块里夹 `#` 注释把正文切成多段的形状要报错，
 *    不能导出"第二段永远不显示"的 `.hsc`；
 * 4. **编辑器自动成键 ≡ Agent `parse_hs`**：同一份输入的产物逐字节一致。
 */
import assert from 'node:assert/strict'

import {
  HsCompileError,
  compileHsToHsc,
} from '../src/hanshu/compiler.ts'
import { analyzeHsDiagnostics } from '../src/monaco/hsDiagnostics.ts'
import { parseSourceText, unparseSourceText } from '../src/agent/agentOps.ts'
import { stopParseLineOf } from '../src/hanshu/directives.ts'
import { collectSourceKeys } from '../src/hanshu/sourceKeys.ts'
import { parseTextSpans } from '../src/monaco/textSpans.ts'
import { keyReplacementFor } from '../src/monaco/textKeyRules.ts'
import { createLocaleKeyFromText, isLocaleKey } from '../src/i18n/textMap.ts'

let passed = 0
function test(name: string, check: () => void) {
  check()
  passed++
  console.log(`[OK] ${name}`)
}

function section(title: string) {
  console.log(`\n## ${title}`)
}

function one(name: string, hs: string, hsc: string) {
  test(name, () => {
    assert.equal(compileHsToHsc(hs), hsc, `输入：${JSON.stringify(hs)}`)
  })
}

function fails(name: string, hs: string, match?: RegExp) {
  test(name, () => {
    assert.throws(
      () => compileHsToHsc(hs),
      (err: unknown) => {
        assert.ok(err instanceof HsCompileError, `应是 HsCompileError：${String(err)}`)
        if (match) assert.match(err.message, match)
        return true
      },
    )
  })
}

/** 每一行（1 基）的行末 offset：不含 `\n` / `\r`，与 Monaco `getLineMaxColumn` 同义 */
function lineEnds(source: string): number[] {
  const ends: number[] = []
  let start = 0
  for (let i = 0; i <= source.length; i++) {
    if (i === source.length || source[i] === '\n') {
      const end = i > start && source[i - 1] === '\r' ? i - 1 : i
      ends.push(end)
      start = i + 1
    }
  }
  return ends
}

/**
 * 模拟编辑器的自动成键（`textEditor.migrateNow` 用的同一批纯规则）：
 * 逐片段就地换成键名、空体多行块把键名插到下一行；**不改语句结构**。
 * 返回成键后的文本与写进映射的条目。
 */
function keyAll(source: string): { text: string; entries: Array<[string, string]> } {
  const ends = lineEnds(source)
  const used = new Set<string>()
  const entries: Array<[string, string]> = []
  const stopLine = stopParseLineOf(source)
  const edits = parseTextSpans(source)
    // `#stopparse` 之后不参与成键（与 migrateNow / parse_hs 同一条规则）
    .filter((span) => stopLine == null || span.endLine < stopLine)
    .filter((span) => !isLocaleKey(span.value))
    .map((span) => {
      const key = createLocaleKeyFromText(span.value, (candidate) => used.has(candidate))
      used.add(key)
      entries.push([key, span.value])
      return keyReplacementFor(span, key, '\n', (line) => ends[line - 1] ?? 0)
    })
    .sort((a, b) => b.start - a.start)
  let text = source
  for (const edit of edits) {
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end)
  }
  return { text, entries }
}

section('1. 已闭合的键名：单行写法与多行块写法都能编译')

one(
  '单行 `speaker:键//`',
  'narrator:7f3a91c2//',
  'narrator:7f3a91c2',
)
one(
  '多行块 `speaker:` + 键名 + 独占一行 `//`（成键后的标准形态）',
  'narrator:\n7f3a91c2\n//',
  'narrator:7f3a91c2',
)
one(
  '多行块键名前后有空格 / 制表符：编译时删掉',
  'narrator:\n  \t7f3a91c2  \t\n//',
  'narrator:7f3a91c2',
)
one(
  '多行块里的键名可以不在块的第一行（空行照旧去掉）',
  'narrator:\n\n7f3a91c2\n//',
  'narrator:7f3a91c2',
)
one(
  '选项行不受影响（本就单行 + 行末闭合）',
  '-0b41d5ee:a7c3e812//\n--c1d2e3f4//',
  '-0b41d5ee:a7c3e812\n--c1d2e3f4',
)
one(
  '未成键的多行原文照样编译',
  'narrator:\n夜色压在城墙上。\n//',
  'narrator:夜色压在城墙上。',
)
one(
  '注释 / 空行照旧去掉，块结构保持',
  '# 场景\n\nnarrator:\n7f3a91c2\n//\n\n# 结尾',
  'narrator:7f3a91c2',
)
one(
  '注入点与语句之间的换行边界保持',
  '@start\nnarrator:\n7f3a91c2\n//\n-abcd1234:a7c3e812//',
  '@start\nnarrator:7f3a91c2\n-abcd1234:a7c3e812',
)
one(
  'CRLF 源文件',
  'narrator:\r\n7f3a91c2\r\n//\r\n',
  'narrator:7f3a91c2',
)
one(
  '注释里的十六进制串不算正文键名',
  '# 7f3a91c2 是示例\nnarrator:\n7f3a91c2\n//',
  'narrator:7f3a91c2',
)

section('2. 没闭合 / 键名不独占正文：仍然抛错')

fails('单行语句缺 `//`', 'narrator:7f3a91c2', /闭合/)
fails('多行块缺 `//`', 'narrator:\n7f3a91c2', /闭合/)
fails('一个块里摊了两个键', 'narrator:\n7f3a91c2\na1b2c3d4\n//', /闭合/)
fails(
  '块里夹注释切出两段、两段都成键（一个块两个键）',
  'narrator:\nfaw613da\n# 场景\na1b2c3d4\n//',
  /一个多行对白块只能有一个键名/,
)
fails(
  '块里夹注释切出两段、只有后一段成键（键名不在第一段正文里）',
  'narrator:\n还有正文。\n# 场景\n7f3a91c2\n//',
  /一个多行对白块只能有一个键名/,
)
fails('键名后面还跟着正文', 'narrator:\n7f3a91c2\n还有正文\n//', /闭合/)
fails('裸键名行（不在任何语句里）', '7f3a91c2', /闭合/)
fails('未闭合的选项行', '-abcd1234:a7c3e812', /闭合/)

test('报错指向具体行号', () => {
  try {
    compileHsToHsc('@start\nnarrator:\n7f3a91c2\n')
    assert.fail('应当抛错')
  } catch (err) {
    assert.ok(err instanceof HsCompileError)
    assert.match(err.message, /第 3 行/)
  }
})

section('3. 成键后的形态：既能编译、也没有诊断')

test('`narrator:` + 独占一行的键名 + 独占一行的 `//` 无诊断', () => {
  const diags = analyzeHsDiagnostics('narrator:\n7f3a91c2\n//\n')
  assert.deepEqual(diags, [], `不该有诊断：${JSON.stringify(diags)}`)
})

test('单行 `narrator:7f3a91c2//` 无诊断', () => {
  const diags = analyzeHsDiagnostics('narrator:7f3a91c2//\n')
  assert.deepEqual(diags, [], `不该有诊断：${JSON.stringify(diags)}`)
})

test('键位扫描（list_lang_keys / write_lang）认得多行块里的键名', () => {
  const keys = collectSourceKeys(
    'narrator:\n7f3a91c2\n//\n-0b41d5ee:a7c3e812//\n',
  )
  assert.deepEqual(keys, [
    { key: '7f3a91c2', line: 2 },
    { key: '0b41d5ee', line: 4 },
    { key: 'a7c3e812', line: 4 },
  ])
})

section('4. 端到端：编辑器成键后的文档必须能编译')

test('单段多行块：键名就地独占一行，编译折叠回单行', () => {
  const source = 'narrator:\n夜色压在城墙上。\n卫兵的脚步由远及近。\n//\n'
  const { text, entries } = keyAll(source)
  assert.equal(text, `narrator:\n${entries[0]![0]}\n//\n`, '语句形态不变：`//` 仍独占一行')
  assert.equal(entries[0]![1], '夜色压在城墙上。\n卫兵的脚步由远及近。')
  assert.equal(compileHsToHsc(text), `narrator:${entries[0]![0]}`)
})

test('空体多行块：键名插到 `speaker:` 的下一行', () => {
  const { text, entries } = keyAll('narrator:\n//\n')
  assert.equal(text, `narrator:\n${entries[0]![0]}\n//\n`)
  assert.equal(compileHsToHsc(text), `narrator:${entries[0]![0]}`)
})

test('块里夹注释切出多段：编辑器的成键结果会被编译器拒绝（不静默出厂）', () => {
  // 编辑器（和 Agent 的 parse_hs）会把每段正文各成一个键 —— 这个形状本身
  // 在 .hsc 里没法表达（紧凑化只折 `speaker:` 后的第一段，后面的键名会掉成裸行，
  // 机器按行执行、那几行没人执行），所以编译器必须报错，而不是导出一个
  // 第二段永远不显示的 .hsc。
  const { text, entries } = keyAll('narrator:\n夜色。\n# 场景\n卫兵。\n//\n')
  assert.equal(
    text,
    `narrator:\n${entries[0]![0]}\n# 场景\n${entries[1]![0]}\n//\n`,
  )
  assert.throws(
    () => compileHsToHsc(text),
    (err: unknown) => {
      assert.ok(err instanceof HsCompileError, `应是 HsCompileError：${String(err)}`)
      assert.match(err.message, /一个多行对白块只能有一个键名/)
      assert.match(err.message, /第 4 行/)
      return true
    },
  )
  // 作者该做的改法：拆成两条语句，各自闭合 → 可编译
  const split = `narrator:${entries[0]![0]}//\nnarrator:${entries[1]![0]}//\n`
  assert.equal(
    compileHsToHsc(split),
    `narrator:${entries[0]![0]}\nnarrator:${entries[1]![0]}`,
  )
})

test('键名前面只有空行 / 注释：照旧合法（键名仍在块的第一段正文里）', () => {
  // 键名**之前**的注释不算"切段"：紧凑化先丢注释，键名仍是第一段正文
  assert.equal(compileHsToHsc('narrator:\n# 场景\n7f3a91c2\n//\n'), 'narrator:7f3a91c2')
  assert.equal(
    compileHsToHsc('narrator:\n\n# 场景\n\n7f3a91c2\n//\n'),
    'narrator:7f3a91c2',
  )
  // 键名之后的注释 / 空行也无所谓
  assert.equal(compileHsToHsc('narrator:\n7f3a91c2\n# 场景\n//\n'), 'narrator:7f3a91c2')
})

test('CRLF 文件：键名独占一行，编译折叠回单行', () => {
  const { text, entries } = keyAll('narrator:\r\n夜色。\r\n//\r\n')
  assert.equal(text, `narrator:\r\n${entries[0]![0]}\r\n//\r\n`)
  assert.equal(compileHsToHsc(text), `narrator:${entries[0]![0]}`)
})

test('单行语句：键名落在行末，行为不变', () => {
  const { text, entries } = keyAll('narrator:夜色压在城墙上。//\n')
  assert.equal(text, `narrator:${entries[0]![0]}//\n`)
  assert.equal(compileHsToHsc(text), `narrator:${entries[0]![0]}`)
})

test('没闭合的空体块：成键什么都不做，不会插进一个没闭合的键名', () => {
  const { text, entries } = keyAll('narrator:\n')
  assert.equal(text, 'narrator:\n', '不该插入键名')
  assert.deepEqual(entries, [])
})

test('成键后的文件整份可编译（含选项与后续语句）', () => {
  const { text } = keyAll(
    '@start\n' +
      'narrator:\n夜色。\n//\n' +
      '-这是哪？:大牢……//\n' +
      '--该死的哑巴。//\n',
  )
  const out = compileHsToHsc(text)
  assert.match(out, /^@start\nnarrator:[0-9a-f]{8}\n/)
})

section('5. 编辑器自动成键 ≡ Agent `parse_hs`：逐字节一致')

for (const source of [
  'narrator:\n夜色压在城墙上。\n卫兵的脚步由远及近。\n//\n',
  'narrator:\n//\n',
  'narrator:   \n//\n',
  'narrator:\n\n7f3a91c2\n//\n',
  'narrator:夜色压在城墙上。//\n',
  'narrator:\r\n夜色。\r\n//\r\n',
  '@start\nnarrator:\n夜色。\n//\n-这是哪？:大牢……//\n--该死的哑巴。//\n',
  '# 场景\n\nnarrator:\n夜色。\n# 旁白\n卫兵。\n//\n',
  'narrator:\n#stopparse\n这段原样保留。\n//\n',
]) {
  test(`同一份输入产出同一份文档与条目：${JSON.stringify(source)}`, () => {
    const editor = keyAll(source)
    const agent = parseSourceText(source, {})
    assert.equal(agent.content, editor.text, '成键后的文档必须逐字节一致')
    assert.deepEqual(agent.entries, editor.entries, '写进映射的键值对必须一致')
  })
}

test('空体多行块两边都成键（键名插成独立一行、写进映射的原文为空串）', () => {
  const agent = parseSourceText('narrator:\n//\n', {})
  assert.match(agent.content, /^narrator:\n[0-9a-f]{8}\n\/\/\n$/)
  assert.deepEqual(agent.entries, [[agent.entries[0]![0], '']])
})

test('正文只有注释的空体块：成键后键名在前、注释照旧，编译照旧通过', () => {
  // 块里唯一的"正文"是注释 → 片段是零长度的空体，键名插到 `narrator:` 的下一行，
  // 注释留在块里（编译时丢掉）
  const { text } = keyAll('narrator:\n# 场景\n//\n')
  assert.match(text, /^narrator:\n[0-9a-f]{8}\n# 场景\n\/\/\n$/)
  assert.match(compileHsToHsc(text), /^narrator:[0-9a-f]{8}$/)
})

test('Agent 成键后的文档同样能编译（与编辑器产物等价）', () => {
  const agent = parseSourceText('narrator:\n夜色。\n//\n', {})
  assert.equal(compileHsToHsc(agent.content), `narrator:${agent.entries[0]![0]}`)
  assert.equal(
    compileHsToHsc(agent.content),
    compileHsToHsc(keyAll('narrator:\n夜色。\n//\n').text),
  )
})

section('6. `#stopparse`：仅解析的控制指令 —— 拦成键与键位扫描，**不拦编译**')

test('顶格 `#stopparse` 才是指令（缩进 / 拼错都只是注释）', () => {
  assert.equal(stopParseLineOf('#stopparse\n正文\n'), 1)
  assert.equal(stopParseLineOf('#stopparse   \n正文\n'), 1)
  assert.equal(stopParseLineOf('  #stopparse\n正文\n'), null)
  assert.equal(stopParseLineOf('#stopparseX\n正文\n'), null)
  assert.equal(stopParseLineOf('narrator:\n#stopparse\n正文\n//\n'), 2)
})

test('指令之后的片段不参与自动成键（编辑器与 Agent 都停手）', () => {
  const source = '#stopparse\nnarrator:\n引擎原文。\n//\n'
  assert.equal(keyAll(source).text, source, '编辑器不该动它')
  const agent = parseSourceText(source, {})
  assert.equal(agent.content, source)
  assert.deepEqual(agent.entries, [])
  assert.equal(agent.skipped, 1, '跳过的段数要如实报出来')
})

test('指令只拦指定行之后的片段：前面的照旧成键', () => {
  const source = 'narrator:\n先成键。\n//\n#stopparse\nnarrator:\n后停手。\n//\n'
  assert.match(
    keyAll(source).text,
    /^narrator:\n[0-9a-f]{8}\n\/\/\n#stopparse\nnarrator:\n后停手。\n\/\/\n$/,
  )
})

test('键位扫描（list_lang_keys / write_lang）在指令处截断', () => {
  assert.deepEqual(
    collectSourceKeys('narrator:\n7f3a91c2\n//\n#stopparse\nnarrator:\ndeadbeef\n//\n'),
    [{ key: '7f3a91c2', line: 2 }],
  )
})

section('6.1 编译**不认**这条指令：指令之后的键名照旧按键名规则校验')
one(
  '指令之后的普通原文照旧编译',
  '#stopparse\nnarrator:\n引擎原文。\n//\n',
  'narrator:引擎原文。',
)
one(
  '指令之后形如键名的正文照旧按键名编译',
  '#stopparse\nnarrator:\ndeadbeef\n//\n',
  'narrator:deadbeef',
)
one(
  '指令之前的键位与之后的正文各自照旧',
  'narrator:\n7f3a91c2\n//\n#stopparse\nnarrator:\ndeadbeef\n//\n',
  'narrator:7f3a91c2\nnarrator:deadbeef',
)
// 没闭合的裸键名行不会因为"在指令之后"就放行
fails('指令之后的裸键名行照样报错', '#stopparse\ndeadbeef\n', /闭合/)
fails('缩进的 `#stopparse` 不是指令，后面的裸键名行也照样报错', '  #stopparse\ndeadbeef\n', /闭合/)

test('`unparse_hs` 也不受指令限制：指令常顶格写在第一行，逆解析要还原整个文件', () => {
  const map = { '7f3a91c2': '译好的台词' }
  const unparsed = unparseSourceText('#stopparse\nnarrator:\n7f3a91c2\n//\n', map)
  assert.equal(unparsed.content, '#stopparse\nnarrator:\n译好的台词\n//\n')
  assert.equal(unparsed.replaced, 1)

  // 成键 → 指令 → 逆解析 → 再成键：键可复现（Agent 的"关闭解析/主动解析"流程）
  const keyed = keyAll('narrator:\n译好的台词\n//\n').text
  assert.match(keyed, /^narrator:\n[0-9a-f]{8}\n\/\/\n$/)
})

console.log(`\n${passed} hs-compile checks passed.`)