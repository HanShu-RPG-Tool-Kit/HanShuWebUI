/**
 * 汉书着色不变量检查（常驻）。
 *
 * 跑法：`npm run check:hs`
 *
 * 这些规则是**实测**踩出来的，改 tokenizer 时务必让它保持绿色：
 * 1. 选项规则必须 ≥3 段分组，且对象只放最后一段（两段写法整行不上色）；
 * 2. 分组内不得用 `@pop`（会让整行不上色），只能写状态名；
 * 3. 单行语句状态必须以行为界：`-` / `-text` / `-text//` / `-text:` / `-text:text`
 *    五种写法都要"短横线 + 文案上色，且行末状态回到 root"；
 * 4. `.hs` 与 `.hsc` 两套 tokenizer 都要满足上面几条（它们共用规则工厂）。
 */
import assert from 'node:assert/strict'
import { collectSourceKeys } from '../src/hanshu/sourceKeys'
import { createLocaleKeyFromText } from '../src/i18n/textMap'
import {
  HANSHU_HSC_LANGUAGE_ID,
  HANSHU_LANGUAGE_ID,
  registerHanshuLanguage,
} from '../src/monaco/hanshuLanguage'

const NL = String.fromCharCode(10)

type Piece = string | { token: string; next?: string; switchTo?: string }
type Rule = [RegExp, Piece | Piece[], string?]
type Provider = { tokenizer: Record<string, Rule[]> }
type Token = { text: string; type: string }

const providers: Record<string, Provider> = {}
registerHanshuLanguage({
  languages: {
    getLanguages: () => [],
    register: () => undefined,
    setLanguageConfiguration: () => undefined,
    setMonarchTokensProvider: (id: string, p: unknown) => {
      providers[id] = p as Provider
    },
  },
  editor: { defineTheme: () => undefined, setTheme: () => undefined },
} as never)

/** 极简 Monarch 行词法：只实现本仓库用到的 token / 分组 / next / switchTo */
function lex(
  provider: Provider,
  text: string,
): Array<{ tokens: Token[]; endState: string }> {
  const states = provider.tokenizer
  let state = 'root'
  const out: Array<{ tokens: Token[]; endState: string }> = []
  for (const line of text.split(NL)) {
    let rest = line
    const tokens: Token[] = []
    let guard = 0
    while (rest.length > 0 && guard++ < 100) {
      let advanced = false
      for (const [re, action, third] of states[state] ?? []) {
        const m = re.exec(rest)
        if (!m || m.index !== 0 || m[0].length === 0) continue
        let next = Array.isArray(action)
          ? undefined
          : typeof third === 'string'
            ? third
            : undefined
        if (Array.isArray(action)) {
          action.forEach((piece, index) => {
            if (typeof piece === 'object' && (piece.next ?? piece.switchTo)) {
              next = piece.next ?? piece.switchTo
            }
            tokens.push({
              text: m[index + 1] ?? '',
              type: typeof piece === 'string' ? piece : piece.token,
            })
          })
        } else if (typeof action === 'string') {
          tokens.push({ text: m[0], type: action })
        } else {
          if (action.next) next = action.next
          tokens.push({ text: m[0], type: action.token })
        }
        rest = rest.slice(m[0].length)
        if (next) state = next === '@pop' ? 'root' : next.replace('@', '')
        advanced = true
        break
      }
      if (!advanced) {
        tokens.push({ text: rest, type: '' })
        rest = ''
      }
    }
    out.push({ tokens, endState: state })
  }
  return out
}

const HS_CASES = [
  '-',
  '-text',
  '-text//',
  '-text:',
  '-text:text',
  '--text:msg//',
  '-c945411d',
  '-c945411d:',
]
/** `.hsc` 里没有 `//`（编译时已去掉），所以少了两种形态 */
const HSC_CASES = [
  '-',
  '-text',
  '-text:',
  '-text:text',
  '-c945411d',
  '-c945411d:',
  '-c945411d:msg',
]

console.log('== 选项行着色 ==')
for (const [label, id, cases] of [
  ['.hs', HANSHU_LANGUAGE_ID, HS_CASES],
  ['.hsc', HANSHU_HSC_LANGUAGE_ID, HSC_CASES],
] as const) {
  const provider = providers[id]
  assert.ok(provider, `${label} 未注册 Monarch provider`)
  for (const line of cases) {
    const [result] = lex(provider, line)
    const types = result!.tokens.map((t) => t.type).join(' ')
    assert.ok(
      result!.tokens[0]!.type.includes('choice.mark'),
      `${label} ${line}：短横线要点亮，实际 ${types}`,
    )
    const bareDashes = line.replace(/^-+/, '') === ''
    const label_ = result!.tokens.find(
      (t, i) => i > 0 && t.text.length > 0 && !t.type.includes('punct'),
    )
    assert.ok(
      bareDashes ||
        label_?.type.includes('choice.label') ||
        label_?.type.includes('key'),
      `${label} ${line}：文案要上色，实际 ${types}`,
    )
    assert.equal(result!.endState, 'root', `${label} ${line}：行末状态应为 root`)
  }
  console.log(`  ok - ${label}：${cases.length} 种选项写法都上色且行末退出`)
}

console.log('== 系统返回选项着色 ==')
{
  const provider = providers[HANSHU_LANGUAGE_ID]
  assert.ok(provider, '.hs 未注册 Monarch provider')
  for (const [line, token] of [
    ['--<//', 'sysret.parent'],
    ['--<<//', 'sysret.root'],
    ['---<//', 'sysret.parent'],
    ['---<<//', 'sysret.root'],
  ] as const) {
    const [result] = lex(provider, line)
    const types = result!.tokens.map((t) => t.type).join(' ')
    assert.ok(
      result!.tokens[0]!.type.includes('choice.mark'),
      `${line}：短横线要点亮，实际 ${types}`,
    )
    assert.ok(
      result!.tokens.some((t) => t.type.includes(token)),
      `${line}：应有 ${token}，实际 ${types}`,
    )
    assert.equal(result!.endState, 'root', `${line}：行末状态应为 root`)
  }
  console.log('  ok - --</--<< 系统返回着色正确')
}

console.log('== 选项规则形态 ==')
for (const [id, provider] of Object.entries(providers)) {
  for (const [state, rules] of Object.entries(provider.tokenizer)) {
    for (const [re, action] of rules) {
      if (!re.source.includes('(-+)') && !re.source.includes('(-{2,})')) continue
      assert.ok(Array.isArray(action), `${id}/${state} ${re.source}：必须用分组`)
      const pieces = action as Piece[]
      assert.ok(
        pieces.length >= 3,
        `${id}/${state} ${re.source}：只有 ${pieces.length} 段，两段写法实测不上色`,
      )
      for (const piece of pieces) {
        if (typeof piece !== 'object') continue
        assert.notEqual(piece.next, '@pop', `${id}/${state} ${re.source}：分组内禁用 @pop`)
        assert.notEqual(
          piece.switchTo,
          '@pop',
          `${id}/${state} ${re.source}：分组内禁用 @pop`,
        )
      }
    }
  }
}
console.log('  ok - 所有选项规则 ≥3 段分组，且分组内无 @pop')

console.log('== #stopparse 指令着色 ==')
{
  const provider = providers[HANSHU_LANGUAGE_ID]
  assert.ok(provider, '.hs 未注册 Monarch provider')
  const [directive] = lex(provider, '#stopparse')
  assert.ok(
    directive!.tokens[0]!.type.includes('directive'),
    `.hs #stopparse：应作为指令上色，实际 ${directive!.tokens.map((t) => t.type).join(' ')}`,
  )
  const [indented] = lex(provider, '  #stopparse')
  assert.ok(
    !indented!.tokens[0]!.type.includes('directive'),
    '.hs 缩进的 #stopparse 不是指令（须顶格）',
  )
  const [comment] = lex(provider, '# 普通注释')
  assert.ok(
    comment!.tokens[0]!.type.includes('comment'),
    `.hs 行首 # 注释：应仍是注释，实际 ${comment!.tokens.map((t) => t.type).join(' ')}`,
  )
  console.log('  ok - .hs：指令 / 缩进 / 注释 三者区分正确')
}

console.log('== 文本哈希键 ==')
{
  const keyOf = (text: string, taken: (key: string) => boolean = () => false) =>
    createLocaleKeyFromText(text, taken)
  const a = keyOf('夜色压在城墙上。')
  const b = keyOf('夜色压在城墙上。')
  assert.equal(a, b, '同一段文本必须得到同一个键（可复现）')
  assert.match(a, /^[0-9a-f]{8}$/, `键名必须是 8 位小写十六进制，实际 ${a}`)
  assert.notEqual(
    a,
    keyOf('某个犯人醒来了。'),
    '不同文本的键不应相同',
  )
  const conflict = keyOf('夜色压在城墙上。', (key) => key === a)
  assert.notEqual(conflict, a, '冲突时必须换下一个候选（二次哈希）')
  assert.match(conflict, /^[0-9a-f]{8}$/, `二次哈希也必须是 8 位十六进制，实际 ${conflict}`)
  assert.equal(
    conflict,
    keyOf('夜色压在城墙上。', (key) => key === a),
    '二次哈希也必须可复现',
  )
  console.log('  ok - 键 = 文本哈希，可复现、冲突有确定次序')
}

console.log('== 键位扫描 ==')
{
  const doc = [
    'narrator:7f3a91c2//',
    '',
    '-0b41d5ee:a7c3e812//',
    '--c1d2e3f4//',
    '',
    '#stopparse',
    '',
    'guard_a:deadbeef//',
  ].join(NL)
  const keys = collectSourceKeys(doc).map((item) => item.key)
  assert.deepEqual(
    keys,
    ['7f3a91c2', '0b41d5ee', 'a7c3e812', 'c1d2e3f4'],
    `正文里的键必须都被认出来（#stopparse 之后的除外），实际 ${keys.join(', ')}`,
  )
  const lines = collectSourceKeys(doc).map((item) => item.line)
  assert.deepEqual(lines, [1, 3, 3, 4], `键的行号应来自 span，实际 ${lines.join(', ')}`)
  const multiline = collectSourceKeys(`narrator:${NL}faw613da${NL}7f3a91c2${NL}//`)
  assert.equal(
    multiline.length,
    0,
    '多行块里的"键"是普通文本，不该被当成键（与文档反例一致）',
  )
  console.log('  ok - speaker:键// 、选项键、#stopparse 截断都正确')
}

console.log(NL + '汉书着色不变量检查通过')
