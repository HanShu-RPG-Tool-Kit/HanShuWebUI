/** Bounded session history survives editor/Worker disposal so lifecycle failures can be reported. */
export type LanguageDiagnosticEvent = {at: string; scope: string; event: string; detail: unknown}
const events: LanguageDiagnosticEvent[] = []
const LIMIT = 180

export function diagnosticValue(value: unknown): unknown {
  if (value instanceof Error) return {name: value.name, message: value.message, stack: value.stack}
  try {
    const text = JSON.stringify(value)
    if (text === undefined) return null
    return text.length > 12_000 ? {truncated: true, preview: text.slice(0, 12_000)} : JSON.parse(text)
  } catch { return String(value) }
}

export function recordLanguageDiagnostic(scope: string, event: string, detail: unknown = null) {
  events.push({at: new Date().toISOString(), scope, event, detail: diagnosticValue(detail)})
  if (events.length > LIMIT) events.splice(0, events.length - LIMIT)
}

export function languageDiagnosticHistory() { return events.map(entry => ({...entry})) }

/** Explicit allowlists at collection sites omit account/connection preferences; redact URL credentials too. */
export function stringifyLanguageDiagnostics(report: unknown, description: string, connectionPassword = '') {
  const escapedSecret=connectionPassword.length>=4?connectionPassword:null
  let text = JSON.stringify({...report as Record<string, unknown>, description}, (key,value)=>{
    // A password may equal a Java package segment (e.g. "mchhui"). Never rewrite source/type names.
    return escapedSecret&&typeof value==='string'&&['message','stack','error'].includes(key)?value.split(escapedSecret).join('[redacted]'):value
  }, 2)
  text = text.replace(/([?&](?:password|token|secret|authorization|api_key)=)[^&\s"<>\\]*/gi, '$1[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [redacted]')
  return text + '\n'
}

export function downloadLanguageDiagnostics(report: unknown, description: string, name: string, password = '') {
  const blob = new Blob([stringifyLanguageDiagnostics(report, description, password)], {type: 'application/json;charset=utf-8'})
  const url = URL.createObjectURL(blob), anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${name.replace(/[\\/:*?"<>|]/g, '_').replace(/\.js$/i, '') || 'script'}-language-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  document.body.append(anchor); anchor.click(); anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
