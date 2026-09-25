/**
 * 汉书 `#define`：C 式简单标识符替换（无参数宏）。
 * 引擎 / 诊断可在解析前调用 expandDefines。
 */

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/
const DEFINE_LINE =
  /^#define\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+(\S.*)$/
const IDENT_TOKEN = /[a-zA-Z_][a-zA-Z0-9_]*/g

const MAX_EXPAND_PASSES = 16

export type DefineMap = Map<string, string>

/** 收集顶格 `#define name replacement`（跳过 '''' 块内） */
export function collectDefines(source: string): DefineMap {
  const defines: DefineMap = new Map()
  let inPython = false

  for (const raw of source.split(/\r?\n/)) {
    const line = raw
    const toggles = countEmbedDelimiters(line)
    if (inPython) {
      if (toggles % 2 === 1) inPython = false
      continue
    }
    if (toggles % 2 === 1) {
      inPython = true
      continue
    }

    const m = line.match(DEFINE_LINE)
    if (m && IDENT.test(m[1])) {
      defines.set(m[1], m[2].trimEnd())
    }
  }

  return defines
}

/**
 * 展开标识符宏。
 * - 跳过：`#…` 行（含 `#define` / 注释）、`''''…''''` 块
 * - 多层宏有限次展开（防止递归炸）
 */
export function expandDefines(source: string, defines?: DefineMap): string {
  const map = defines ?? collectDefines(source)
  if (map.size === 0) return source

  const nl = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source.split(/\r?\n/)
  let inPython = false

  const out = lines.map((line) => {
    const toggles = countEmbedDelimiters(line)
    if (inPython) {
      if (toggles % 2 === 1) inPython = false
      return line
    }
    if (toggles % 2 === 1) {
      inPython = true
      return line
    }
    if (line.startsWith('#')) return line
    return expandLine(line, map)
  })

  return out.join(nl)
}

function expandLine(line: string, defines: DefineMap): string {
  let result = line
  for (let pass = 0; pass < MAX_EXPAND_PASSES; pass++) {
    let changed = false
    result = result.replace(IDENT_TOKEN, (id) => {
      const rep = defines.get(id)
      if (rep === undefined) return id
      changed = true
      return rep
    })
    if (!changed) break
  }
  return result
}

function countEmbedDelimiters(line: string): number {
  let n = 0
  let i = 0
  while (i < line.length) {
    if (line.startsWith("''''", i)) {
      n++
      i += 4
    } else {
      i++
    }
  }
  return n
}
