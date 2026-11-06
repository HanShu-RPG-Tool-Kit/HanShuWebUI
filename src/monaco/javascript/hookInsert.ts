import { planJavaImport } from './javaImportPlan'

export type HookCatalogEntry = {
  id: string
  cancellable: boolean
  eventClass?: string
}

export type HookHandlerPlan = {
  importText: string
  importAt: number
  importEnd: number
  bodyAt: number
  body: string
  binding: string
  functionName: string
  preview: string
  caretInBody: number
}

/** `pkg.PlayerEvent$Hurt` → `Hurt`；`pkg.PlayerEvent` → `PlayerEvent` */
export function hookEventSymbol(fqcn: string): string {
  const leaf = fqcn.split('.').pop() ?? fqcn
  const nested = leaf.split('$')
  return nested[nested.length - 1] || leaf
}

/** 作者签名里的事件类型是否对应该 hook 的 eventClass（import 别名或简短类名均可）。 */
export function hookEventTypeMatches(
  written: string,
  expectedFqcn: string,
  aliases: Readonly<Record<string, string>> = {},
): boolean {
  const raw = written.trim().replace(/\[\]$/, '')
  if (!raw || raw === 'any') return false
  const resolved = aliases[raw] ?? raw
  if (resolved === expectedFqcn) return true
  if (raw === expectedFqcn) return true
  const expectedLeaf = hookEventSymbol(expectedFqcn)
  return resolved === expectedLeaf || raw === expectedLeaf
}

function sanitizeFunctionName(id: string): string {
  const base = `on_${id.replace(/[^A-Za-z0-9_]/g, '_')}`
  return /^[A-Za-z_$]/.test(base) ? base : `on_hook_${base}`
}

function uniqueFunctionName(source: string, id: string): string {
  const taken = new Set(
    [...source.matchAll(/^\s*function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map(m => m[1]!),
  )
  let name = sanitizeFunctionName(id)
  if (!taken.has(name)) return name
  for (let i = 2; ; i++) {
    const next = `${name}_${i}`
    if (!taken.has(next)) return next
  }
}

/** 在光标所在行之后插入；若当前行为空则占用该行起点。 */
export function hookInsertOffset(source: string, offset: number): number {
  const safe = Math.max(0, Math.min(offset, source.length))
  const lineStart = source.lastIndexOf('\n', safe - 1) + 1
  const lineEnd = source.indexOf('\n', safe)
  const end = lineEnd < 0 ? source.length : lineEnd
  const line = source.slice(lineStart, end).replace(/\r$/, '')
  if (!line.trim()) return lineStart
  return end + (source[end] === '\n' ? 1 : 0)
}

export function planHookHandler(
  source: string,
  hook: HookCatalogEntry,
  caretOffset: number,
): HookHandlerPlan {
  const nl = source.includes('\r\n') ? '\r\n' : '\n'
  const functionName = uniqueFunctionName(source, hook.id)
  let binding = 'any'
  let importText = ''
  let importAt = 0
  let importEnd = 0
  if (hook.eventClass) {
    const plan = planJavaImport(source, {
      name: hook.eventClass,
      symbol: hookEventSymbol(hook.eventClass),
      packageName: hook.eventClass.includes('.') ? hook.eventClass.slice(0, hook.eventClass.lastIndexOf('.')) : '',
      origin: 'hook',
    })
    binding = plan.binding
    importText = plan.text
    importAt = plan.insertAt
    importEnd = plan.replaceEnd
  }
  const options = hook.cancellable === false ? `, {cancellable:false}` : ''
  const header = `@hook(${JSON.stringify(hook.id)}${options})`
  const open = `function ${functionName}(event: ${binding}, blackboard: Blackboard): void {`
  const bodyInner = `${nl}    ${nl}`
  const body = `${header}${nl}${open}${bodyInner}}${nl}`
  const bodyAt = hookInsertOffset(source, caretOffset)
  // import 插在文件头时，若 body 插在其后需平移；plan 本身分开返回，由调用方按序应用
  const caretInBody = body.indexOf('{') + 1 + nl.length + 4
  const preview = `${importText ? importText.trimEnd() + nl : ''}${body.trimEnd()}`
  return {
    importText,
    importAt,
    importEnd,
    bodyAt,
    body,
    binding,
    functionName,
    preview,
    caretInBody,
  }
}
