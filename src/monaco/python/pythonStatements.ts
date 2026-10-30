export type PythonStatement = { start: number; end: number; text: string }

/** Conservative lexical guard for import reference edits; never rewrite strings/comments. */
export function isPythonCodeOffset(source: string, offset: number): boolean {
  let quote = '', triple = false, comment = false
  for (let i = 0; i < offset; i++) {
    const c = source[i]
    if (comment) { if (c === '\n') comment = false; continue }
    if (quote) {
      if (c === '\\') { i++; continue }
      if (triple ? source.slice(i, i + 3) === quote.repeat(3) : c === quote) { if (triple) i += 2; quote = '' }
      continue
    }
    if (c === '#') comment = true
    if (c === '"' || c === "'") { quote = c; triple = source.slice(i, i + 3) === c.repeat(3); if (triple) i += 2 }
  }
  return !quote && !comment
}

// Lexical statement boundaries only; Python semantics and type inference stay in Pyright.
export function pythonStatements(source: string): PythonStatement[] {
  const result: PythonStatement[] = []
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

