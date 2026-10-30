export type JavaClassEntry = { name: string; symbol: string; packageName: string; origin: string }
export type ImportPlan = { insertAt: number; text: string; binding: string; reused: boolean; preview: string }
type Statement = { start: number; end: number; text: string }

// Lexical statement boundaries only; Python semantics and type inference stay in Pyright.
function statements(source: string): Statement[] {
  const result: Statement[] = []
  let start = 0, depth = 0, quote = '', triple = false, comment = false
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (comment) { if (c !== '\n') continue; comment = false }
    if (quote) {
      if (c === '\\') { i++; continue }
      if (triple ? source.slice(i, i + 3) === quote.repeat(3) : c === quote) { if (triple) i += 2; quote = '' }
      continue
    }
    if (c === '#') { comment = true; continue }
    if (c === '"' || c === "'") { quote = c; triple = source.slice(i, i + 3) === c.repeat(3); if (triple) i += 2; continue }
    if ('([{'.includes(c)) depth++
    if (')]}'.includes(c)) depth--
    if (c === '\n' && depth <= 0 && source[i - 1] !== '\\' && source.slice(Math.max(0, i - 2), i) !== '\\\r') {
      result.push({ start, end: i + 1, text: source.slice(start, i + 1) }); start = i + 1; depth = 0
    }
  }
  if (start < source.length) result.push({ start, end: source.length, text: source.slice(start) })
  return result
}

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/
const keywords = new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case type'.split(' '))
const validIdentifier = (name: string) => identifier.test(name) && !keywords.has(name)
const cleanImport = (text: string) => text.replace(/#[^\r\n]*/g, '').replace(/\\\r?\n/g, ' ').trim()

export function planJavaImport(source: string, entry: JavaClassEntry, requestedAlias = ''): ImportPlan {
  if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(entry.name) || !validIdentifier(entry.symbol)) throw new Error('此 Java 类没有可用的 Python 名称')
  const parts = statements(source), bindings = new Set<string>()
  const imports: { javaName: string; binding: string; preview: string }[] = []
  let javaBinding = '', insertAt = 0, inHeader = true, docstringAllowed = true
  for (const part of parts) {
    const trimmed = part.text.trim()
    const topLevel = /^\S/.test(part.text)
    const empty = !trimmed || trimmed.startsWith('#')
    const code = cleanImport(part.text)
    const isImport = topLevel && /^(?:from\s|import\s)/.test(code)
    const docstring = docstringAllowed && topLevel && /^(?:[rRuU])?(?:"""|'''|"|')/.test(trimmed)
    if (inHeader && (empty || docstring || isImport)) insertAt = part.end
    else if (!empty) inHeader = false
    if (!empty) docstringAllowed = false
    if (!topLevel) continue
    const from = /^from\s+([\w.]+)\s+import\s+([\s\S]+)$/.exec(code)
    if (from) for (const raw of from[2].replace(/[()]/g, '').split(',')) {
      const match = /^\s*(\w+)\s*(?:as\s+(\w+))?\s*$/.exec(raw)
      if (match) { const binding = match[2] ?? match[1]; bindings.add(binding); imports.push({ javaName: `${from[1]}.${match[1]}`, binding, preview: code }) }
    }
    const plain = /^import\s+([\s\S]+)$/.exec(code)
    if (plain) for (const raw of plain[1].split(',')) {
      const match = /^\s*([\w.]+)\s*(?:as\s+(\w+))?\s*$/.exec(raw)
      if (match) { const binding = match[2] ?? match[1].split('.')[0]; bindings.add(binding); if (match[1] === 'java') javaBinding = binding }
    }
    const assigned = /^(\w+)\s*(?:[=:]|\()/.exec(code)
    const declared = /^(?:async\s+)?(?:def|class)\s+(\w+)/.exec(code)
    if (assigned) bindings.add(assigned[1])
    if (declared) bindings.add(declared[1])
    const typed = /^(\w+)\s*=\s*(\w+)\.type\(\s*['"]([\w.$]+)['"]\s*\)/.exec(code)
    if (typed && typed[2] === javaBinding) imports.push({ javaName: typed[3], binding: typed[1], preview: code })
  }
  if (requestedAlias && !validIdentifier(requestedAlias)) throw new Error('别名必须是有效的 Python 标识符')
  const existing = imports.find(i => i.javaName === entry.name && (!requestedAlias || requestedAlias === i.binding))
  if (existing) return { insertAt, text: '', binding: existing.binding, reused: true, preview: existing.preview }
  let binding = requestedAlias || entry.symbol
  if (requestedAlias && bindings.has(binding)) throw new Error(`名称 ${binding} 已被占用`)
  if (!requestedAlias && bindings.has(binding)) {
    const base = `${binding}Java`; binding = base
    for (let n = 2; bindings.has(binding); n++) binding = `${base}${n}`
  }
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  let preview: string
  if (entry.name.includes('$') || !entry.name.split('.').every(validIdentifier)) {
    const alreadyImported = !!javaBinding
    if (!javaBinding) { javaBinding = 'java'; for (let n = 2; bindings.has(javaBinding); n++) javaBinding = `java${n}` }

    preview = `${alreadyImported ? '' : `import java${javaBinding === 'java' ? '' : ` as ${javaBinding}`}\n`}${binding} = ${javaBinding}.type(${JSON.stringify(entry.name)})`
  } else {
    const split = entry.name.lastIndexOf('.')
    preview = `from ${entry.name.slice(0, split)} import ${entry.name.slice(split + 1)}${binding === entry.symbol ? '' : ` as ${binding}`}`
  }
  const text = (insertAt > 0 && source[insertAt - 1] !== '\n' ? newline : '') + preview.replaceAll('\n', newline) + newline + (insertAt === 0 && source ? newline : '')
  return { insertAt, text, binding, reused: false, preview }
}
