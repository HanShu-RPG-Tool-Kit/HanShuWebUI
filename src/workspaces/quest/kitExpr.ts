/**
 * hanshu.kit.expr Standard V1 求值器。
 * 只做标量运算：不使用 eval / Function，名字解析与函数调用都走白名单。
 */

export const KIT_EXPR_VERSION = 1

export type KitExprErrorKind = 'syntax' | 'name' | 'type' | 'arity' | 'domain' | 'math' | 'cycle'

export class KitExprError extends Error {
  readonly kind: KitExprErrorKind
  /** 1 起的列号；0 表示无位置 */
  readonly column: number

  constructor(kind: KitExprErrorKind, message: string, column = 0) {
    super(column > 0 ? `第 ${column} 列：${message}` : message)
    this.kind = kind
    this.column = column
  }
}

export type KitExprNode =
  | { t: 'num'; value: number; pos: number }
  | { t: 'name'; name: string; pos: number }
  | { t: 'neg'; arg: KitExprNode; pos: number }
  | { t: 'bin'; op: '+' | '-' | '*' | '/'; left: KitExprNode; right: KitExprNode; pos: number }
  | { t: 'call'; name: string; args: KitExprNode[]; pos: number }

/** 修饰器表达式里代表输入 rawdata 的保留名 */
export const KIT_EXPR_INPUT = 'x'

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

export function isKitExprIdent(name: string): boolean {
  return IDENT.test(name)
}

// ---------- 词法 ----------

type Token =
  | { k: 'num'; value: number; pos: number }
  | { k: 'name'; name: string; pos: number }
  | { k: 'op'; op: '+' | '-' | '*' | '/' | '(' | ')' | ','; pos: number }
  | { k: 'end'; pos: number }

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < source.length) {
    const ch = source[i]!
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++
      continue
    }
    const pos = i + 1
    if (/[0-9.]/.test(ch)) {
      const match = /^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)/.exec(source.slice(i))
      if (!match) throw new KitExprError('syntax', `无效数字「${ch}」`, pos)
      const next = source[i + match[0].length]
      if (next !== undefined && /[A-Za-z0-9_.]/.test(next)) {
        throw new KitExprError('syntax', `数字后紧跟非法字符「${next}」`, i + match[0].length + 1)
      }
      tokens.push({ k: 'num', value: Number(match[0]), pos })
      i += match[0].length
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i))!
      tokens.push({ k: 'name', name: match[0], pos })
      i += match[0].length
      continue
    }
    if ('+-*/(),'.includes(ch)) {
      tokens.push({ k: 'op', op: ch as '+', pos })
      i++
      continue
    }
    throw new KitExprError('syntax', `不支持的字符「${ch}」`, pos)
  }
  tokens.push({ k: 'end', pos: source.length + 1 })
  return tokens
}

// ---------- 语法 ----------

/**
 * expr    = term { ("+" | "-") term }
 * term    = unary { ("*" | "/") unary }
 * unary   = "-" unary | primary
 * primary = number | name [ "(" [ expr { "," expr } ] ")" ] | "(" expr ")"
 */
export function parseKitExpr(source: string): KitExprNode {
  const tokens = tokenize(source)
  let index = 0
  const peek = () => tokens[index]!
  const isOp = (op: string) => {
    const token = peek()
    return token.k === 'op' && token.op === op
  }
  const describe = (token: Token) => token.k === 'end' ? '表达式结尾' : token.k === 'num' ? `数字 ${token.value}` : token.k === 'name' ? `名字 ${token.name}` : `「${token.op}」`

  function expect(op: string) {
    if (!isOp(op)) throw new KitExprError('syntax', `应为「${op}」，实际是${describe(peek())}`, peek().pos)
    index++
  }

  function expr(): KitExprNode {
    let left = term()
    while (isOp('+') || isOp('-')) {
      const token = tokens[index++] as Extract<Token, { k: 'op' }>
      left = { t: 'bin', op: token.op as '+' | '-', left, right: term(), pos: token.pos }
    }
    return left
  }

  function term(): KitExprNode {
    let left = unary()
    while (isOp('*') || isOp('/')) {
      const token = tokens[index++] as Extract<Token, { k: 'op' }>
      left = { t: 'bin', op: token.op as '*' | '/', left, right: unary(), pos: token.pos }
    }
    return left
  }

  function unary(): KitExprNode {
    if (isOp('-')) {
      const pos = peek().pos
      index++
      return { t: 'neg', arg: unary(), pos }
    }
    return primary()
  }

  function primary(): KitExprNode {
    const token = peek()
    if (token.k === 'num') {
      index++
      return { t: 'num', value: token.value, pos: token.pos }
    }
    if (token.k === 'name') {
      index++
      if (!isOp('(')) return { t: 'name', name: token.name, pos: token.pos }
      index++
      const args: KitExprNode[] = []
      if (!isOp(')')) {
        args.push(expr())
        while (isOp(',')) {
          index++
          args.push(expr())
        }
      }
      expect(')')
      return { t: 'call', name: token.name, args, pos: token.pos }
    }
    if (isOp('(')) {
      index++
      const inner = expr()
      expect(')')
      return inner
    }
    throw new KitExprError('syntax', `此处不能出现${describe(token)}`, token.pos)
  }

  if (peek().k === 'end') throw new KitExprError('syntax', '表达式为空', 1)
  const root = expr()
  if (peek().k !== 'end') throw new KitExprError('syntax', `多余的${describe(peek())}`, peek().pos)
  return root
}

// ---------- 内置函数 ----------

type Arity = { min: number; max?: number; parity?: 'odd' | 'even' }

export type KitExprFunction = {
  name: string
  signature: string
  summary: string
  arity: Arity
}

export const KIT_EXPR_FUNCTIONS: KitExprFunction[] = [
  { name: 'min', signature: 'min(a, b, …)', summary: '最小值', arity: { min: 1 } },
  { name: 'max', signature: 'max(a, b, …)', summary: '最大值', arity: { min: 1 } },
  { name: 'abs', signature: 'abs(v)', summary: '绝对值', arity: { min: 1, max: 1 } },
  { name: 'floor', signature: 'floor(v)', summary: '向下取整', arity: { min: 1, max: 1 } },
  { name: 'ceil', signature: 'ceil(v)', summary: '向上取整', arity: { min: 1, max: 1 } },
  { name: 'round', signature: 'round(v)', summary: '四舍五入（.5 远离 0）', arity: { min: 1, max: 1 } },
  { name: 'clamp', signature: 'clamp(v, lo, hi)', summary: '限制在 [lo, hi]', arity: { min: 3, max: 3 } },
  { name: 'step', signature: 'step(v, edge, a, b)', summary: 'v < edge 取 a，否则取 b', arity: { min: 4, max: 4 } },
  { name: 'select', signature: 'select(v, e1, v1, …, vDefault)', summary: '按升序门槛分段取值', arity: { min: 4, parity: 'even' } },
  { name: 'lerp', signature: 'lerp(v, at1, v1, at2, v2, …)', summary: '折线插值，端点外钳制', arity: { min: 5, parity: 'odd' } },
  { name: 'spline', signature: 'spline(v, at1, v1, at2, v2, …)', summary: 'Catmull-Rom 样条，端点外钳制', arity: { min: 5, parity: 'odd' } },
]

const FUNCTION_BY_NAME = new Map(KIT_EXPR_FUNCTIONS.map((fn) => [fn.name, fn]))

export function isKitExprReserved(name: string): boolean {
  return name === KIT_EXPR_INPUT || FUNCTION_BY_NAME.has(name)
}

function checkArity(fn: KitExprFunction, count: number, pos: number) {
  const { min, max, parity } = fn.arity
  const ok = count >= min && (max === undefined || count <= max) && (!parity || count % 2 === (parity === 'odd' ? 1 : 0))
  if (ok) return
  const expected = max === min ? `${min} 个` : parity ? `${parity === 'odd' ? '奇' : '偶'}数个且至少 ${min} 个` : `至少 ${min} 个`
  throw new KitExprError('arity', `${fn.name} 需要${expected}参数，实际 ${count} 个`, pos)
}

/** 按 Standard V1 的 round：.5 远离 0（不是银行家舍入） */
export function kitRound(value: number): number {
  return Math.sign(value) * Math.floor(Math.abs(value) + 0.5) + 0
}

function controlPoints(name: string, args: number[], pos: number): { at: number[]; value: number[] } {
  const at: number[] = []
  const value: number[] = []
  for (let i = 1; i < args.length; i += 2) {
    at.push(args[i]!)
    value.push(args[i + 1]!)
  }
  for (let i = 1; i < at.length; i++) {
    if (!(at[i]! > at[i - 1]!)) throw new KitExprError('domain', `${name} 的控制点 at 必须严格递增`, pos)
  }
  return { at, value }
}

function segmentOf(at: number[], v: number): number {
  let i = 0
  while (i < at.length - 2 && v >= at[i + 1]!) i++
  return i
}

function callBuiltin(name: string, args: number[], pos: number): number {
  switch (name) {
    case 'min': return Math.min(...args)
    case 'max': return Math.max(...args)
    case 'abs': return Math.abs(args[0]!)
    case 'floor': return Math.floor(args[0]!)
    case 'ceil': return Math.ceil(args[0]!)
    case 'round': return kitRound(args[0]!)
    case 'clamp': {
      const lo = Math.min(args[1]!, args[2]!)
      const hi = Math.max(args[1]!, args[2]!)
      return Math.min(hi, Math.max(lo, args[0]!))
    }
    case 'step': return args[0]! < args[1]! ? args[2]! : args[3]!
    case 'select': {
      const v = args[0]!
      let previous = -Infinity
      for (let i = 1; i < args.length - 1; i += 2) {
        if (!(args[i]! > previous)) throw new KitExprError('domain', 'select 的门槛必须严格递增', pos)
        previous = args[i]!
      }
      for (let i = 1; i < args.length - 1; i += 2) {
        if (v < args[i]!) return args[i + 1]!
      }
      return args[args.length - 1]!
    }
    case 'lerp': {
      const { at, value } = controlPoints(name, args, pos)
      const v = args[0]!
      if (v <= at[0]!) return value[0]!
      if (v >= at[at.length - 1]!) return value[value.length - 1]!
      const i = segmentOf(at, v)
      const t = (v - at[i]!) / (at[i + 1]! - at[i]!)
      return value[i]! + (value[i + 1]! - value[i]!) * t
    }
    case 'spline': {
      const { at, value } = controlPoints(name, args, pos)
      const v = args[0]!
      if (v <= at[0]!) return value[0]!
      if (v >= at[at.length - 1]!) return value[value.length - 1]!
      const i = segmentOf(at, v)
      const t = (v - at[i]!) / (at[i + 1]! - at[i]!)
      const p1 = value[i]!
      const p2 = value[i + 1]!
      const p0 = i > 0 ? value[i - 1]! : p1
      const p3 = i + 2 < value.length ? value[i + 2]! : p2
      return 0.5 * (
        2 * p1
        + (-p0 + p2) * t
        + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
        + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t
      )
    }
  }
  throw new KitExprError('name', `未知函数 ${name}`, pos)
}

// ---------- 名字检查与求值 ----------

/** 超参数在表达式中的取值：数值参与运算；字符串参数被引用即为类型错误 */
export type KitExprParamValue = number | { string: string }

export type KitExprScope = {
  params: ReadonlyMap<string, KitExprParamValue>
  /** 修饰器 id 集合（可作为一元函数调用） */
  modifiers: ReadonlySet<string>
  /** 是否允许引用 `x`（修饰器表达式内为 true） */
  allowInput: boolean
}

/** 静态检查：名字、函数元数；返回直接调用的修饰器 id（用于环检测） */
export function checkKitExpr(node: KitExprNode, scope: KitExprScope): Set<string> {
  const calls = new Set<string>()
  const visit = (current: KitExprNode) => {
    switch (current.t) {
      case 'num': return
      case 'neg': visit(current.arg); return
      case 'bin': visit(current.left); visit(current.right); return
      case 'name': {
        if (current.name === KIT_EXPR_INPUT) {
          if (!scope.allowInput) throw new KitExprError('name', '此处不能使用输入 x', current.pos)
          return
        }
        const param = scope.params.get(current.name)
        if (param === undefined) {
          if (FUNCTION_BY_NAME.has(current.name) || scope.modifiers.has(current.name)) {
            throw new KitExprError('name', `${current.name} 是函数，需要加括号调用`, current.pos)
          }
          throw new KitExprError('name', `未知名字 ${current.name}`, current.pos)
        }
        if (typeof param !== 'number') throw new KitExprError('type', `超参数 ${current.name} 是字符串，不能参与运算`, current.pos)
        return
      }
      case 'call': {
        const builtin = FUNCTION_BY_NAME.get(current.name)
        if (builtin) checkArity(builtin, current.args.length, current.pos)
        else if (scope.modifiers.has(current.name)) {
          if (current.args.length !== 1) throw new KitExprError('arity', `修饰器 ${current.name} 是一元函数，需要 1 个参数，实际 ${current.args.length} 个`, current.pos)
          calls.add(current.name)
        } else if (scope.params.has(current.name)) {
          throw new KitExprError('name', `${current.name} 是超参数，不能调用`, current.pos)
        } else {
          throw new KitExprError('name', `未知函数 ${current.name}`, current.pos)
        }
        current.args.forEach(visit)
      }
    }
  }
  visit(node)
  return calls
}

export type KitExprRuntime = {
  params: ReadonlyMap<string, KitExprParamValue>
  callModifier: (id: string, input: number) => number
}

function finite(value: number, pos: number): number {
  if (!Number.isFinite(value)) throw new KitExprError('math', '结果不是有限数', pos)
  return value
}

export function evalKitExprNode(node: KitExprNode, input: number, runtime: KitExprRuntime): number {
  switch (node.t) {
    case 'num': return node.value
    case 'neg': return -evalKitExprNode(node.arg, input, runtime) + 0
    case 'name': {
      if (node.name === KIT_EXPR_INPUT) return input
      const param = runtime.params.get(node.name)
      if (typeof param !== 'number') throw new KitExprError('name', `无法解析名字 ${node.name}`, node.pos)
      return param
    }
    case 'bin': {
      const left = evalKitExprNode(node.left, input, runtime)
      const right = evalKitExprNode(node.right, input, runtime)
      if (node.op === '+') return finite(left + right, node.pos)
      if (node.op === '-') return finite(left - right, node.pos)
      if (node.op === '*') return finite(left * right, node.pos)
      if (right === 0) throw new KitExprError('math', '除数为 0', node.pos)
      return finite(left / right, node.pos)
    }
    case 'call': {
      const args = node.args.map((arg) => evalKitExprNode(arg, input, runtime))
      if (FUNCTION_BY_NAME.has(node.name)) return finite(callBuiltin(node.name, args, node.pos), node.pos)
      return runtime.callModifier(node.name, args[0]!)
    }
  }
}

// ---------- 修饰器环境 ----------

export type KitExprParamDecl = {
  id: string
  kind: 'float' | 'int' | 'string' | 'bool'
  default: number | string | boolean
}

export type KitExprModifierDecl = {
  id: string
  expr: string
}

export type KitModifierEnv = {
  params: ReadonlyMap<string, KitExprParamValue>
  /** 非空 id 且无错误的修饰器 */
  ready: ReadonlySet<string>
  /** 所有非空 id 修饰器（含有错误的） */
  declared: ReadonlySet<string>
  /** 按修饰器 id 的编译/环错误 */
  modifierErrors: ReadonlyMap<string, KitExprError>
  /** 声明层面的错误（重名、非法 id 等） */
  errors: string[]
  /** 对 rawdata 应用修饰器；失败抛 KitExprError */
  apply: (id: string, input: number) => number
}

function toNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw === 'string' && raw.trim() !== '') {
    const value = Number(raw)
    return Number.isFinite(value) ? value : null
  }
  return null
}

/** 注入值无法按声明类型解释时回落到 default */
function paramValue(param: KitExprParamDecl, override: unknown): KitExprParamValue {
  const raw = override !== undefined ? override : param.default
  if (param.kind === 'string') return { string: String(raw ?? '') }
  if (param.kind === 'bool') return raw === true || raw === 1 || raw === 'true' ? 1 : 0
  const value = toNumber(raw) ?? toNumber(param.default) ?? 0
  return param.kind === 'int' ? Math.trunc(value) : value
}

const MAX_CALL_DEPTH = 64

/**
 * 构建修饰器求值环境：
 * 1. 收集超参数（override 优先于 default）；
 * 2. 编译全部有效修饰器并做名字/元数检查；
 * 3. 按调用图检测环，环上修饰器标记为 cycle 错误。
 */
export function buildKitModifierEnv(
  params: readonly KitExprParamDecl[],
  modifiers: readonly KitExprModifierDecl[],
  overrides: Readonly<Record<string, unknown>> = {},
): KitModifierEnv {
  const errors: string[] = []
  const paramMap = new Map<string, KitExprParamValue>()
  for (const param of params) {
    const id = param.id.trim()
    if (!id) continue
    if (!isKitExprIdent(id)) { errors.push(`超参数 id「${id}」不是合法标识符`); continue }
    if (isKitExprReserved(id)) { errors.push(`超参数 id「${id}」与保留名冲突`); continue }
    if (paramMap.has(id)) { errors.push(`超参数 id「${id}」重复，后者被忽略`); continue }
    paramMap.set(id, paramValue(param, overrides[id]))
  }

  const declared = new Set<string>()
  const sources = new Map<string, string>()
  for (const modifier of modifiers) {
    const id = modifier.id.trim()
    if (!id) continue
    if (!isKitExprIdent(id)) { errors.push(`修饰器 id「${id}」不是合法标识符`); continue }
    if (isKitExprReserved(id)) { errors.push(`修饰器 id「${id}」与保留名冲突`); continue }
    if (paramMap.has(id)) { errors.push(`修饰器 id「${id}」与超参数重名`); continue }
    if (declared.has(id)) { errors.push(`修饰器 id「${id}」重复，后者被忽略`); continue }
    declared.add(id)
    sources.set(id, modifier.expr)
  }

  const scope: KitExprScope = { params: paramMap, modifiers: declared, allowInput: true }
  const compiled = new Map<string, KitExprNode>()
  const graph = new Map<string, Set<string>>()
  const modifierErrors = new Map<string, KitExprError>()
  for (const [id, source] of sources) {
    try {
      const ast = parseKitExpr(source)
      graph.set(id, checkKitExpr(ast, scope))
      compiled.set(id, ast)
    } catch (error) {
      modifierErrors.set(id, error instanceof KitExprError ? error : new KitExprError('syntax', String(error)))
    }
  }

  // Tarjan 求强连通分量：大小 >1 或自调用的分量即为环
  let counter = 0
  const indexOf = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const strongConnect = (id: string) => {
    indexOf.set(id, counter)
    low.set(id, counter)
    counter++
    stack.push(id)
    onStack.add(id)
    for (const next of graph.get(id) ?? []) {
      if (!graph.has(next)) continue
      if (!indexOf.has(next)) {
        strongConnect(next)
        low.set(id, Math.min(low.get(id)!, low.get(next)!))
      } else if (onStack.has(next)) {
        low.set(id, Math.min(low.get(id)!, indexOf.get(next)!))
      }
    }
    if (low.get(id) !== indexOf.get(id)) return
    const component: string[] = []
    let member: string
    do {
      member = stack.pop()!
      onStack.delete(member)
      component.push(member)
    } while (member !== id)
    if (component.length > 1 || graph.get(id)?.has(id)) {
      const path = component.reverse().join(' → ')
      for (const node of component) modifierErrors.set(node, new KitExprError('cycle', `修饰器调用成环：${path}`))
    }
  }
  for (const id of graph.keys()) if (!indexOf.has(id)) strongConnect(id)

  const ready = new Set([...compiled.keys()].filter((id) => !modifierErrors.has(id)))

  let depth = 0
  const apply = (id: string, input: number): number => {
    const error = modifierErrors.get(id)
    if (error) throw new KitExprError(error.kind, `修饰器 ${id} 不可用：${error.message}`)
    const ast = compiled.get(id)
    if (!ast) throw new KitExprError('name', `未知修饰器 ${id}`)
    if (!Number.isFinite(input)) throw new KitExprError('math', `修饰器 ${id} 的输入不是有限数`)
    if (depth >= MAX_CALL_DEPTH) throw new KitExprError('cycle', '修饰器调用过深')
    depth++
    try {
      return finite(evalKitExprNode(ast, input, runtime), 0)
    } finally {
      depth--
    }
  }
  const runtime: KitExprRuntime = { params: paramMap, callModifier: apply }

  return { params: paramMap, ready, declared, modifierErrors, errors, apply }
}

// ---------- 独立表达式与文本插值 ----------

/** 求值不含 `x` 的独立表达式（指令插值、脚本 `kit.expr`）；失败抛 KitExprError */
export function evalKitExpr(source: string, env: KitModifierEnv): number {
  const ast = parseKitExpr(source)
  checkKitExpr(ast, { params: env.params, modifiers: env.declared, allowInput: false })
  return finite(evalKitExprNode(ast, Number.NaN, { params: env.params, callModifier: env.apply }), 0)
}

/** 插值输出格式：整数原样；否则最多 6 位小数并去掉末尾 0 */
export function formatKitNumber(value: number): string {
  if (Number.isInteger(value)) return String(value + 0)
  return value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
}

export type KitInterpolation = { text: string; errors: string[] }

/** 文本中的 `${expr}` 替换为求值结果；`$${` 输出字面量 `${` */
export function interpolateKitText(text: string, env: KitModifierEnv): KitInterpolation {
  const errors: string[] = []
  let out = ''
  let i = 0
  while (i < text.length) {
    if (text.startsWith('$${', i)) {
      out += '${'
      i += 3
      continue
    }
    if (text.startsWith('${', i)) {
      const end = text.indexOf('}', i + 2)
      if (end < 0) {
        errors.push(`第 ${i + 1} 列：插值缺少「}」`)
        out += text.slice(i)
        break
      }
      const source = text.slice(i + 2, end)
      try {
        out += formatKitNumber(evalKitExpr(source, env))
      } catch (error) {
        errors.push(`\${${source}}：${error instanceof Error ? error.message : String(error)}`)
        out += text.slice(i, end + 1)
      }
      i = end + 1
      continue
    }
    out += text[i]
    i++
  }
  return { text: out, errors }
}

// ---------- 条目字段绑定 ----------

export type KitNumberRule = {
  /** 是否为整数字段（结果按 round 取整） */
  int: boolean
  /** 字段下限 */
  min: number
}

export type KitResolvedNumber = {
  raw: number
  value: number
  /** 绑定的修饰器 id（未绑定为空串） */
  mod: string
  /** 求值失败时的错误；此时 value 退回到按字段规则处理的 raw */
  error?: string
  /** 绑定了不存在 / 被无视的修饰器：按恒等处理 */
  warning?: string
}

export function applyKitNumberRule(value: number, rule: KitNumberRule): number {
  const shaped = rule.int ? kitRound(value) : value
  return Math.max(rule.min, shaped)
}

/** 条目最终值 = 字段规则(mod(raw))；未绑定时即 raw */
export function resolveKitNumber(raw: number, modId: string | undefined, env: KitModifierEnv, rule: KitNumberRule): KitResolvedNumber {
  const mod = (modId ?? '').trim()
  if (!mod) return { raw, value: applyKitNumberRule(raw, rule), mod: '' }
  if (!env.declared.has(mod)) {
    return { raw, value: applyKitNumberRule(raw, rule), mod, warning: `修饰器 ${mod} 不存在或被无视，按原值处理` }
  }
  try {
    return { raw, value: applyKitNumberRule(env.apply(mod, raw), rule), mod }
  } catch (error) {
    return { raw, value: applyKitNumberRule(raw, rule), mod, error: error instanceof Error ? error.message : String(error) }
  }
}
