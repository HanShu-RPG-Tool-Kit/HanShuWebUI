/**
 * 传输层 —— 适配器唯一认识的"怎么把请求发出去"的抽象。
 *
 * 它存在的理由只有一条:**把"请求从哪儿发出去"从适配器里摘出来**,这样换它就够了。
 *
 * - 桌面版注入 Tauri 侧传输(`@tauri-apps/plugin-http`):请求由 Rust 后端执行,
 *   **不受 WebView 的 CORS 约束**,并且能拿到真实的错误。
 * - 浏览器构建注入原生 `fetch`:有些供应商能用、有些不能 —— 那是浏览器的固有限制。
 *
 * **这不是洁癖,是硬需求。** OpenAI 的 API 不返回 `Access-Control-Allow-Origin`,
 * 浏览器 / webview 直接调必失败(`POST /v1/audio/speech` 尤其),
 * 而 Tauri 的 webview 就是浏览器内核,一样受管。换传输能修,换适配器修不了。
 *
 * 第二个理由在错误类型里:`transport` 失败与 `http` 失败必须能分开。
 * 前者是"拿不到响应"(CORS / DNS / 断网 / 证书),后者是"厂商明确拒绝了"。
 * 分不开的话,用户永远只看到一句 `Failed to fetch`,而真正的原因
 * (“Key 无效”“额度不足”)就藏在它后面拿不到。
 */

export type TtsHttpRequest = {
  url: string
  headers: Record<string, string>
  /**
   * 方法。默认 `POST`（合成全是 POST）；`GET` 用于只读查询（如 ElevenLabs 的音色列表），
   * 此时 `body` 被忽略 —— GET 不允许带请求体。
   */
  method?: 'GET' | 'POST'
  /** **已序列化**的请求体 —— 适配器负责序列化,传输只管发 */
  body: string | Uint8Array
  /** 取消用。适配器不需要认识它,由 `client` 在发之前挂上去 */
  signal?: AbortSignal
}

export type TtsHttpResponse = {
  status: number
  ok: boolean
  /** 响应体原始字节。音频、JSON、错误详情都从这里取,传输层不做判断 */
  bytes: Uint8Array
  contentType: string | null
}

export type TtsTransport = (request: TtsHttpRequest) => Promise<TtsHttpResponse>

/** 传输层失败：请求根本没到得了厂商那里 */
export class TtsTransportError extends Error {
  /** 给人看的一句话，说清"可能是哪一类" */
  readonly hint: string

  constructor(message: string, hint: string) {
    super(message)
    this.name = 'TtsTransportError'
    this.hint = hint
  }
}

/** 拼端点：`https://api.openai.com/v1` + `/audio/speech` */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

type FetchLike = (
  input: string,
  init: {
    method: string
    headers: Record<string, string>
    body?: string | Uint8Array
    signal?: AbortSignal
  },
) => Promise<Response>

/**
 * 浏览器 / webview 的传输。
 *
 * 失败时浏览器只会抛一个 `TypeError: Failed to fetch` —— **CORS、DNS、断网、证书
 * 全被压成同一句话**。所以这里挂一句 `hint`,把"这句话不代表密钥有问题"讲明白,
 * 否则用户会去反复重填 Key。
 */
export function createFetchTransport(impl?: FetchLike): TtsTransport {
  const send = impl ?? ((input, init) => fetch(input, init as RequestInit))

  return async (request) => {
    let response: Response
    try {
      response = await send(request.url, {
        method: request.method ?? 'POST',
        headers: request.headers,
        // GET 不允许带请求体 —— fetch 会直接拒绝
        body: request.method === 'GET' ? undefined : request.body,
        signal: request.signal,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new TtsTransportError(
        message,
        error instanceof TypeError
          ? '浏览器把 CORS、DNS、断网、证书都报成同一句话，所以这**不一定**是密钥的问题。'
            + 'OpenAI 这类不返回 CORS 头的供应商只能在 Rust 侧发请求。'
          : '请求没能发出去，先确认网络与端点地址。',
      )
    }

    const buffer = await response.arrayBuffer()
    return {
      status: response.status,
      ok: response.ok,
      bytes: new Uint8Array(buffer),
      contentType: response.headers.get('content-type'),
    }
  }
}

/**
 * 当前是不是在 Tauri 里跑。
 *
 * 用它决定要不要注入 Rust 侧传输 —— 判据是运行环境，不是"有没有配置"。
 */
export function hasTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

// ===== 字节解码 =====
//
// 各协议的响应体形态不一：裸音频字节 / base64 藏 JSON 里 / 十六进制藏 JSON 里。
// 解码器集中在这里，适配器只管说"我要哪一段"。

const decoder = new TextDecoder()
const encoder = new TextEncoder()

export function encodeText(text: string): Uint8Array {
  return encoder.encode(text)
}

export function decodeText(bytes: Uint8Array): string {
  return decoder.decode(bytes)
}

/** 字节拼接 —— `Uint8Array` 没有 concat，音频与 multipart 都要用 */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** 解析 JSON；坏 JSON 返回 null，由调用方给出可读的错误 */
export function decodeJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decodeText(bytes))
  } catch {
    return null
  }
}

export function decodeBase64(value: string): Uint8Array | null {
  const cleaned = value.trim()
  if (!cleaned) return null
  try {
    // `atob` 浏览器有，Node 16+ 也有，不引 Buffer（app 的 tsconfig 里没有 node 类型）
    const binary = atob(cleaned)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

/** MiniMax 这类把音频编成十六进制串塞进 JSON 的形态 */
export function decodeHex(value: string): Uint8Array | null {
  const cleaned = value.trim()
  if (!cleaned || cleaned.length % 2 !== 0 || /[^0-9a-fA-F]/.test(cleaned)) return null
  const out = new Uint8Array(cleaned.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/** JSON 里那串音频是哪种编码 */
export type EmbeddedEncoding = 'base64' | 'hex'

/**
 * 从 JSON 响应里取音频字节。**编码由适配器指定，不猜。**
 *
 * 猜是错的：十六进制串的每个字符都在 base64 字母表里，所以"先试 base64"对一个 hex
 * 串会**成功**，只是解出一堆垃圾。后果不是报错，而是一段坏音频被写进配音资产 ——
 * 所以这里要求调用方说清是哪种编码，`decodeHex` 也自带合法性判别。
 */
export function decodeEmbeddedAudio(
  value: unknown,
  encoding: EmbeddedEncoding,
): Uint8Array | null {
  if (typeof value !== 'string' || !value.trim()) return null
  return encoding === 'hex' ? decodeHex(value) : decodeBase64(value)
}
