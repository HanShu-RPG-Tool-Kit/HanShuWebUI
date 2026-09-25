import {
  extractChoiceSources,
  extractDialogueBlocks,
} from '../monaco/copyDialogue'

/** hash → source（仅对应关系，全量由 .hs 编译） */
export type LinesFile = Record<string, string>

/** 把 `name.hs` 换成 `name.lines` */
export function linesFileNameForHs(hsName: string): string {
  return hsName.replace(/\.hs$/i, '.lines')
}

/** FNV-1a 32-bit → 8 位 hex */
export function hashLineSource(source: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < source.length; i++) {
    h ^= source.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
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

const SPEAKER_LINE = /^([a-zA-Z_][a-zA-Z0-9_]*):(.*)$/

function uniqueSourcesFromHs(hsText: string): string[] {
  const seen = new Set<string>()
  const list: string[] = []
  const add = (source: string) => {
    const s = source.replace(/^\s+|\s+$/g, '')
    if (!s || seen.has(s)) return
    seen.add(s)
    list.push(s)
  }

  for (const { content } of extractDialogueBlocks(hsText)) add(content)
  for (const s of extractChoiceSources(hsText)) add(s)

  return list
}

/** 从当前 .hs 全量编译（删句即删条目，不合并旧文件） */
export function compileLinesFromHs(hsText: string): LinesFile {
  const out: LinesFile = {}
  for (const source of uniqueSourcesFromHs(hsText)) {
    out[hashLineSource(source)] = source
  }
  return out
}

export function stringifyLinesFile(data: LinesFile): string {
  const keys = Object.keys(data).sort((a, b) => a.localeCompare(b))
  const ordered: LinesFile = {}
  for (const key of keys) ordered[key] = data[key]
  return `${JSON.stringify(ordered, null, 2)}\n`
}

/** Ctrl+S 时写入的 .lines 正文 */
export function buildLinesContent(hsText: string): string {
  return stringifyLinesFile(compileLinesFromHs(hsText))
}

/** `name.hs` → `name.hsc` */
export function hscFileNameForHs(hsName: string): string {
  return hsName.replace(/\.hs$/i, '.hsc')
}

/**
 * 为 .hsc 去掉噪音：注释行、空行。
 * 保留顶格 `#define`；不碰 `''''…''''` 内 Python（含其中空行）。
 * 不移动 `@` 注入点——它们是后续内容的位置标记。
 */
export function stripHsComments(hsText: string): string {
  const nl = hsText.includes('\r\n') ? '\r\n' : '\n'
  const lines = hsText.split(/\r?\n/)
  const out: string[] = []
  let inPython = false

  for (const line of lines) {
    const toggles = countEmbedDelimiters(line)
    if (inPython) {
      out.push(line)
      if (toggles % 2 === 1) inPython = false
      continue
    }
    if (toggles % 2 === 1) {
      inPython = true
      out.push(line)
      continue
    }

    // 顶格 #define 留给引擎展开；其余 # 行为注释
    if (line.startsWith('#define')) {
      out.push(line)
      continue
    }
    if (/^\s*#/.test(line)) continue
    if (/^\s*$/.test(line)) continue

    out.push(line)
  }

  return out.join(nl)
}

const HSC_SPEAKER_OPEN = /^([a-zA-Z_][a-zA-Z0-9_]*):\s*$/

function isHscStructuralLine(line: string): boolean {
  return (
    line.startsWith('#') ||
    line.startsWith('@') ||
    line.startsWith('-') ||
    line.startsWith("''''") ||
    SPEAKER_LINE.test(line)
  )
}

/**
 * hash 替换后的紧凑化（仅 .hsc）：
 * - 去掉块结束符 `//`（含独占一行的）
 * - 把 `speaker:\\nhash` 收成 `speaker:hash`
 * 语句之间的换行保留（行首 `-` / `@` / `@@` / speaker 仍靠换行分界）。
 */
export function minifyHsForHsc(hsText: string): string {
  const nl = hsText.includes('\r\n') ? '\r\n' : '\n'
  const raw = hsText.split(/\r?\n/)
  const flat: string[] = []
  let inPython = false

  for (const line of raw) {
    const toggles = countEmbedDelimiters(line)
    if (inPython) {
      flat.push(line)
      if (toggles % 2 === 1) inPython = false
      continue
    }
    if (toggles % 2 === 1) {
      inPython = true
      flat.push(line)
      continue
    }

    if (/^\/\/\s*$/.test(line)) continue
    flat.push(line.replace(/\/\/\s*$/, ''))
  }

  const out: string[] = []
  inPython = false
  for (let i = 0; i < flat.length; i++) {
    const line = flat[i]
    const toggles = countEmbedDelimiters(line)

    if (inPython) {
      out.push(line)
      if (toggles % 2 === 1) inPython = false
      continue
    }
    if (toggles % 2 === 1) {
      inPython = true
      out.push(line)
      continue
    }

    const open = line.match(HSC_SPEAKER_OPEN)
    if (open) {
      const next = flat[i + 1]
      if (
        next !== undefined &&
        !isHscStructuralLine(next) &&
        countEmbedDelimiters(next) % 2 === 0
      ) {
        out.push(`${open[1]}:${next}`)
        i++
        continue
      }
    }

    out.push(line)
  }

  return out.join(nl)
}

/**
 * 按 .lines 映射把源文替换为 hash（长串优先，避免短句误伤）。
 * 未传入 lines 时从 hs 现场编译。注释、空行、`//` 不进入 .hsc。
 */
export function compileHsToHsc(
  hsText: string,
  lines?: LinesFile,
): string {
  const map = lines ?? compileLinesFromHs(hsText)
  const pairs = Object.entries(map)
    .filter(([, source]) => Boolean(source))
    .sort((a, b) => b[1].length - a[1].length)

  let out = stripHsComments(hsText)
  for (const [hash, source] of pairs) {
    if (!source || !out.includes(source)) continue
    out = out.split(source).join(hash)
  }
  return minifyHsForHsc(out)
}
