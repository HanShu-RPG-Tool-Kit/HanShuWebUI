import type * as Monaco from 'monaco-editor'
import type { Hover, Location, LocationLink } from 'vscode-languageserver'
import type { JavaStubLoader } from './stubLoader'
import type { PyrightClient } from './pyrightClient'

export const INTEROP_MARKER_OWNER = 'hanshu-interop'

export type InteropHazard = {
  code: string
  className: string
  member: string
  paramCount: number
  message: string
  prefer: string
}

export type InteropHazardsSnapshot = {
  schemaVersion: 1
  runtimeId: string
  revision: number
  hazards: InteropHazard[]
}

export function readInteropHazards(value: unknown): InteropHazardsSnapshot {
  const env = value as InteropHazardsSnapshot
  if (
    !env ||
    env.schemaVersion !== 1 ||
    typeof env.runtimeId !== 'string' ||
    !Number.isSafeInteger(env.revision) ||
    env.revision < 0 ||
    !Array.isArray(env.hazards) ||
    env.hazards.length > 1000 ||
    env.hazards.some(
      h =>
        !h ||
        typeof h.code !== 'string' ||
        !h.code.trim() ||
        h.code.length > 128 ||
        typeof h.className !== 'string' ||
        !h.className.trim() ||
        h.className.length > 300 ||
        typeof h.member !== 'string' ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(h.member) ||
        !Number.isSafeInteger(h.paramCount) ||
        h.paramCount < 0 ||
        h.paramCount > 64 ||
        typeof h.message !== 'string' ||
        !h.message.trim() ||
        h.message.length > 500 ||
        typeof h.prefer !== 'string' ||
        !h.prefer.trim() ||
        h.prefer.length > 300,
    ) ||
    new Set(env.hazards.map(h => h.code)).size !== env.hazards.length
  ) {
    throw new Error('不兼容的 GraalPy 危险成员目录')
  }
  return env
}

/** Queued catalog fetch; missing RPC on older mods yields an empty catalog. */
export class InteropHazardsLoader {
  private queue: Promise<void> = Promise.resolve()
  private disposed = false
  private current?: InteropHazardsSnapshot
  hazards: readonly InteropHazard[] = []
  private fetch: () => Promise<unknown>

  constructor(fetch: () => Promise<unknown>) {
    this.fetch = fetch
  }

  refresh() {
    this.queue = this.queue.catch(() => {}).then(async () => {
      if (this.disposed) return
      try {
        const env = readInteropHazards(await this.fetch())
        if (this.disposed) return
        if (this.current?.runtimeId === env.runtimeId && this.current.revision >= env.revision) return
        this.current = env
        this.hazards = env.hazards
      } catch {
        if (!this.disposed) {
          this.current = undefined
          this.hazards = []
        }
      }
    })
    return this.queue
  }

  dispose() {
    this.disposed = true
    this.hazards = []
  }
}

function hoverText(hover: Hover | null): string {
  if (!hover) return ''
  const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents]
  return contents.map(value => (typeof value === 'string' ? value : value.value)).join('\n\n')
}

function argumentCount(source: string, openParen: number): number | undefined {
  if (openParen < 0 || openParen >= source.length || source[openParen] !== '(') return undefined
  let depth = 0
  let args = 0
  let token = false
  for (let i = openParen; i < source.length; i++) {
    const ch = source[i]
    if (ch === '(') {
      depth++
      continue
    }
    if (ch === ')') {
      depth--
      if (depth === 0) return token ? args + 1 : args
      continue
    }
    if (depth !== 1) continue
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      i++
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i++
        i++
      }
      token = true
      continue
    }
    if (/\s/.test(ch)) continue
    if (ch === ',') {
      if (!token) return undefined
      args++
      token = false
      continue
    }
    token = true
  }
  return undefined
}

/**
 * Dedicated markers for catalogued GraalPy-unsafe members. Resolves the callee via Pyright
 * type-definition so aliases still match; does not change Python types.
 */
export async function collectInteropMarkers(input: {
  monaco: typeof Monaco
  model: Monaco.editor.ITextModel
  uri: string
  client: PyrightClient
  stubs: JavaStubLoader
  hazards: readonly InteropHazard[]
}): Promise<Monaco.editor.IMarkerData[]> {
  const { monaco, model, uri, client, stubs, hazards } = input
  if (!hazards.length || model.isDisposed()) return []
  await stubs.ensure([...new Set(hazards.map(h => h.className))])
  const byMember = new Map<string, InteropHazard[]>()
  for (const hazard of hazards) {
    const list = byMember.get(hazard.member) ?? []
    list.push(hazard)
    byMember.set(hazard.member, list)
  }
  const source = model.getValue()
  const markers: Monaco.editor.IMarkerData[] = []
  const seen = new Set<string>()
  for (const [member, group] of byMember) {
    const pattern = new RegExp(`\\.${member}\\s*\\(`, 'g')
    for (const match of source.matchAll(pattern)) {
      const dot = match.index ?? 0
      const memberStart = source.indexOf(member, dot)
      const openParen = source.indexOf('(', memberStart + member.length)
      const count = argumentCount(source, openParen)
      if (count === undefined) continue
      const position = model.getPositionAt(memberStart)
      const params = {
        textDocument: { uri },
        position: { line: position.lineNumber - 1, character: position.column - 1 },
      }
      const [definitions, hover] = await Promise.all([
        client.request<Location | Location[] | LocationLink[] | null>('textDocument/typeDefinition', params),
        client.request<Hover | null>('textDocument/hover', params),
      ])
      const names = new Set<string>()
      for (const definition of definitions ? (Array.isArray(definitions) ? definitions : [definitions]) : []) {
        const name = stubs.byUri.get('targetUri' in definition ? definition.targetUri : definition.uri)
        if (name) names.add(name)
      }
      const words = new Set(hoverText(hover).match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])
      for (const name of stubs.classes.keys()) {
        if (words.has(name.split(/[.$]/).at(-1)!)) names.add(name)
      }
      for (const hazard of group) {
        if (hazard.paramCount !== count || !names.has(hazard.className)) continue
        const key = `${hazard.code}:${position.lineNumber}:${position.column}`
        if (seen.has(key)) continue
        seen.add(key)
        const end = model.getPositionAt(openParen + 1)
        markers.push({
          severity: monaco.MarkerSeverity.Error,
          message: `${hazard.message}；请改用 ${hazard.prefer}`,
          source: 'RPGToolKit',
          code: hazard.code,
          startLineNumber: position.lineNumber,
          startColumn: position.column,
          endLineNumber: end.lineNumber,
          endColumn: end.column,
        })
      }
    }
  }
  return markers
}
