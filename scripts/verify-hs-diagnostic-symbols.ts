/**
 * 诊断叠加符号的回归检查（`npm run test:hs-diag`）。
 *
 * 钉住一件事：**重复的注入点不能叠 `//`**。
 * 注入点在文件内与跨文件都要求唯一，撞名的提示必须是"冲突符"
 * （`hs-diag-conflict`：两个中空方框重叠 + 重叠处实心 + 中央中空感叹号），
 * 而 `//` 是"缺块闭合符"的意思，会让作者去补一个收尾符。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { analyzeHsDiagnostics } from '../src/monaco/hsDiagnostics.ts'
import { diagnosticSymbolClass } from '../src/monaco/diagnosticSymbol.ts'

let passed = 0
function test(name: string, check: () => void) {
  check()
  passed++
  console.log(`[OK] ${name}`)
}

const root = new URL('../', import.meta.url)
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, root)), 'utf8')

section('1. 重复注入点 → 冲突符（不是 //）')
test('本文件内第二次 @name 报 duplicate-inject 且叠冲突符', () => {
  const source = '@dialog\nnpc:你好。//\n@dialog\n'
  const diags = analyzeHsDiagnostics(source)
  const dup = diags.filter((d) => d.kind === 'duplicate-inject')
  assert.equal(dup.length, 1, `应只有第二次出现被报：${JSON.stringify(diags)}`)
  assert.equal(dup[0]!.offset, source.indexOf('@dialog', 1), '锚点应在第二个 @ 的行首')
  for (const d of dup) {
    assert.equal(diagnosticSymbolClass(d), 'hs-diag-conflict')
    assert.notEqual(diagnosticSymbolClass(d), 'hs-diag-close', '重复不等于缺闭合符')
  }
})

test('跨文件撞名（foreignInjects）同样叠冲突符', () => {
  const foreign = new Map([['dialog', 'a.hs']])
  const diags = analyzeHsDiagnostics('@Dialog\nnpc:你好。//\n', {
    foreignInjects: foreign,
  })
  const dup = diags.filter((d) => d.kind === 'duplicate-inject')
  assert.equal(dup.length, 1, '大小写不敏感：@Dialog 与 a.hs 的 @dialog 撞名')
  assert.equal(diagnosticSymbolClass(dup[0]!), 'hs-diag-conflict')
})

test('未被占用的注入点不报诊断', () => {
  const diags = analyzeHsDiagnostics('@dialog\nnpc:你好。//\n')
  assert.equal(diags.filter((d) => d.kind === 'duplicate-inject').length, 0)
})

section('2. 其它诊断的符号没被带偏')
test('缺闭合符仍是 //，重复系统返回改为冲突符', () => {
  const symbol = (kind: string, multiline?: boolean) =>
    diagnosticSymbolClass(
      (multiline === undefined ? { kind } : { kind, multiline }) as never,
    )
  assert.equal(symbol('missing-terminator', false), 'hs-diag-close')
  assert.equal(symbol('missing-terminator', true), 'hs-diag-enter-close')
  assert.equal(symbol('missing-terminator'), 'hs-diag-close', '.char 没有 multiline 字段')
  assert.equal(symbol('inline-terminator'), 'hs-diag-enter')
  assert.equal(symbol('speaker-needs-newline'), 'hs-diag-enter')
  assert.equal(symbol('invalid-char-line'), 'hs-diag-enter')
  assert.equal(symbol('duplicate-sys-return'), 'hs-diag-conflict')
})

section('3. 样式与图形接线')
test('App.css 暴露 hs-diag-conflict，且不借 // 当提示', () => {
  const css = read('src/App.css')
  assert.match(
    css,
    /\.hs-diag-close,\s*\.hs-diag-enter,\s*\.hs-diag-enter-close,\s*\.hs-diag-conflict\s*\{/,
    '冲突符也要有红色波浪线（否则只剩一个孤零零的图形）',
  )
  const block = /\.hs-diag-conflict::before\s*\{[\s\S]*?\}/.exec(css)?.[0]
  assert.ok(block, 'App.css 缺少 .hs-diag-conflict::before')
  assert.ok(!/content:\s*'\/\/'/.test(block!), '冲突符不能画 //')
  assert.match(block!, /content:\s*''/, '图形由背景图提供，不该有文字内容')
  assert.match(block!, /hs-diag-conflict\.svg/, '应挂上冲突图形')
})

test('冲突图形存在，且是"两方框 + 实心重叠 + 中空感叹号"', () => {
  const svgPath = fileURLToPath(new URL('src/monaco/hs-diag-conflict.svg', root))
  assert.ok(existsSync(svgPath), `缺少 ${svgPath}`)
  const svg = readFileSync(svgPath, 'utf8')
  const group = /<g\b[^>]*>/.exec(svg)?.[0]
  assert.match(group ?? '', /stroke="#e05252"/, '方框用红描边，与波浪线同色')
  const rects = [...svg.matchAll(/<rect\b[^>]*\/>/g)].map((m) => m[0])
  assert.equal(rects.length, 2, '两个方框')
  assert.ok(
    rects.every((r) => !/fill="#/.test(r)),
    '方框只描边（中空）：不能自己带实心 fill',
  )
  const path = /<path\b[\s\S]*?d="([^"]+)"/.exec(svg)
  assert.ok(path, '缺少实心重叠 + 感叹号孔洞的 path')
  assert.match(svg, /fill-rule="evenodd"/, '感叹号是挖出来的孔，必须 evenodd')
  assert.equal(
    (path![1]!.match(/[Mm]/g) ?? []).length,
    3,
    'path 应有 3 个子路径：重叠方框 + 感叹号竖条 + 感叹号圆点',
  )
})

function section(title: string) {
  console.log(`\n${title}`)
}

console.log(`\n${passed} 注入点冲突提示检查通过`)