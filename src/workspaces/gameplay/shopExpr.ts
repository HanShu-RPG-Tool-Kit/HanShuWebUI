import { checkKitExpr, evalKitExpr, parseKitExpr, type KitModifierEnv } from './kitExpr'

export const SHOP_EXPR_VERSION = 1
type Expr = { kind: 'number'; source: string } | { kind: 'literal'; value: boolean } | { kind: 'not'; arg: Expr } | { kind: 'and'; left: Expr; right: Expr } | { kind: 'or'; left: Expr; right: Expr } | { kind: 'compare'; op: string; left: string; right: string }
/** Boolean layer only; arithmetic remains the unchanged kit V1 grammar. */
function parse(source: string, depth = 0): Expr {
  if (depth > 64 || source.length > 4096) throw new Error('商店表达式过长或嵌套过深')
  let text = source.trim()
  if (!text) throw new Error('条件表达式缺少操作数')
  const positions = (operators: string[]) => {
    const found: { at: number; op: string }[] = []; let nesting = 0
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '(') nesting++
      else if (text[i] === ')') { if (--nesting < 0) throw new Error('条件表达式括号不匹配') }
      else if (nesting === 0) { const op = operators.find(o => text.startsWith(o, i)); if (op) { found.push({ at: i, op }); i += op.length - 1 } }
    }
    if (nesting !== 0) throw new Error('条件表达式括号不匹配')
    return found
  }
  // Strip only a pair that encloses the whole expression.
  while (text[0] === '(') {
    let nesting = 0, end = -1
    for (let i = 0; i < text.length; i++) { if (text[i] === '(') nesting++; if (text[i] === ')' && --nesting === 0) { end = i; break } }
    if (end !== text.length - 1) break
    text = text.slice(1, -1).trim()
    if (!text) throw new Error('条件表达式缺少操作数')
  }
  for (const [op, kind] of [['||', 'or'], ['&&', 'and']] as const) {
    const split = positions([op]).at(-1)
    if (split) return { kind, left: parse(text.slice(0, split.at), depth + 1), right: parse(text.slice(split.at + 2), depth + 1) }
  }
  if (text.startsWith('!') && !text.startsWith('!=')) return { kind: 'not', arg: parse(text.slice(1), depth + 1) }
  const comparisons = positions(['==', '!=', '<=', '>=', '<', '>'])
  if (comparisons.length > 1) throw new Error('不支持比较链，请用 && 连接独立比较')
  if (comparisons.length) { const { at, op } = comparisons[0]; return { kind: 'compare', op, left: text.slice(0, at).trim(), right: text.slice(at + op.length).trim() } }
  if (text === 'true' || text === 'false') return { kind: 'literal', value: text === 'true' }
  return { kind: 'number', source: text }
}
export function compileShopCondition(source: string, env: KitModifierEnv): () => boolean {
  if (!source.trim()) return () => true
  const ast = parse(source)
  const checkNumber = (text: string) => checkKitExpr(parseKitExpr(text), { params: env.params, modifiers: env.declared, allowInput: false })
  const check = (node: Expr): void => {
    if (node.kind === 'number') { checkNumber(node.source); return }
    if (node.kind === 'compare') { checkNumber(node.left); checkNumber(node.right); return }
    if (node.kind === 'not') check(node.arg)
    else if (node.kind !== 'literal') { check(node.left); check(node.right) }
  }
  check(ast)
  const evaluate = (node: Expr): boolean => {
    if (node.kind === 'literal') return node.value
    if (node.kind === 'number') return evalKitExpr(node.source, env) !== 0
    if (node.kind === 'not') return !evaluate(node.arg)
    if (node.kind === 'and') return evaluate(node.left) && evaluate(node.right)
    if (node.kind === 'or') return evaluate(node.left) || evaluate(node.right)
    const left = evalKitExpr(node.left, env), right = evalKitExpr(node.right, env)
    switch (node.op) { case '==': return left === right; case '!=': return left !== right; case '<': return left < right; case '<=': return left <= right; case '>': return left > right; case '>=': return left >= right; default: throw new Error('未知比较运算符') }
  }
  return () => evaluate(ast)
}
export const evalShopCondition = (source: string, env: KitModifierEnv) => compileShopCondition(source, env)()
