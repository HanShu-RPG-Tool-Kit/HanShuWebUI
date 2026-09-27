/** Reject duplicate keys instead of silently losing author data through JSON.parse. */
export function parseJsonValue(text: string): unknown {
  if (text.length > 16 * 1024 * 1024) throw new Error('JSON 文本超过 16 MiB。')
  let at = 0
  let values = 0
  const whitespace = () => { while (/[ \t\r\n]/.test(text[at] ?? '') && at < text.length) at++ }
  const fail = (message: string): never => { throw new Error(`JSON 第 ${at + 1} 个字符：${message}`) }
  function string(): string {
    const start = at++
    while (at < text.length) {
      const char = text[at++]
      if (char === '\\') { at++; continue }
      if (char === '"') return JSON.parse(text.slice(start, at)) as string
    }
    return fail('字符串未结束。')
  }
  function value(depth: number): unknown {
    whitespace()
    if (++values > 200_000) fail('超过 200000 个 JSON 值。')
    const char = text[at]
    if (char === '"') return string()
    if (char === '{' || char === '[') {
      if (depth >= 32) fail('JSON 嵌套超过 32 层。')
      at++
      const isObject = char === '{'
      const close = isObject ? '}' : ']'
      const result: Record<string, unknown> | unknown[] = isObject ? {} : []
      whitespace()
      if (text[at] === close) { at++; return result }
      while (at < text.length) {
        whitespace()
        if (isObject) {
          if (text[at] !== '"') fail('对象键必须是字符串。')
          const key = string()
          if (Object.hasOwn(result, key)) fail(`重复的对象键 ${JSON.stringify(key)}。`)
          whitespace()
          if (text[at++] !== ':') fail('对象键后需要冒号。')
          Object.defineProperty(result, key, { value: value(depth + 1), writable: true, enumerable: true, configurable: true })
        } else (result as unknown[]).push(value(depth + 1))
        whitespace()
        if (text[at] === close) { at++; return result }
        if (text[at++] !== ',') fail('需要逗号或结束括号。')
      }
      return fail('JSON 容器未结束。')
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at))?.[0]
    if (!token) return fail('无效的 JSON 值。')
    at += token.length
    const result: unknown = JSON.parse(token)
    if (typeof result === 'number' && !Number.isFinite(result)) fail('数字必须有限。')
    if (typeof result === 'number' && Number.isInteger(result) && !Number.isSafeInteger(result)) fail('整数超出浏览器可无损编辑的范围。')
    return result
  }
  const result = value(0)
  whitespace()
  if (at !== text.length) fail('JSON 后存在多余内容。')
  return result
}
