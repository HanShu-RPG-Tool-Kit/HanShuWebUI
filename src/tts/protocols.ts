/**
 * 协议适配器 —— 每个 `protocol` 一份"怎么构造请求、怎么读响应"。
 *
 * 适配器**不认识网络**:它们只产出一个 `TtsHttpRequest` 并解析 `TtsHttpResponse`,
 * 真正发出去由注入的 `TtsTransport` 负责(见 `transport.ts`)。所以换传输不用动这里,
 * 这里也一行都不用知道 CORS 是什么。
 *
 * 报文细节对着各家线上文档核对过;把握不足的地方在注释里点名,不要凭印象改。
 *
 * **`baseUrl` 一律填"API 根"**(如 `https://api.elevenlabs.io`),路径由适配器拼 ——
 * 预设给的默认值就是这个形态,用户覆盖时也照这个填。
 */

import { isPlainObject, type TtsFailure } from './spec'
import type { ResolvedService } from './service'
import {
  decodeEmbeddedAudio,
  decodeJson,
  decodeText,
  joinUrl,
  type TtsHttpRequest,
  type TtsHttpResponse,
} from './transport'
import type { ProtocolId } from './spec'

/** 统一请求：只覆盖各家交集,厂商私有参数由适配器自己补齐 */
export type TtsRequest = {
  text: string
  voice: string
  /** 目标语言标签(`zh_cn` / `en_us`…)。适配器负责翻成该协议要的语言码 */
  language?: string
  /** 语速;不传即 1.0 */
  speed?: number
}

/** 要无损还是小体积。默认 `wav` —— 无损且自带头,转码最干净(规范 §5.1) */
export type AudioFormat = 'wav' | 'mp3'

export type AdapterInput = {
  service: ResolvedService
  request: TtsRequest
  /** 取凭据真值。拿不到返回 null,由适配器给出可读错误 */
  credential: (ref: string) => string | null
  format?: AudioFormat
}

export type ParsedAudio =
  | { ok: true; audio: Uint8Array }
  | { ok: false; failure: TtsFailure }

export type AdaptedRequest =
  | {
      ok: true
      http: TtsHttpRequest
      /**
       * 把响应翻成音频字节。**厂商会把错误塞进 HTTP 200 的响应体里**
       * (MiniMax 的 `base_resp.status_code` 就是),所以这里不能只看状态码。
       */
      parse: (response: TtsHttpResponse) => ParsedAudio
    }
  | { ok: false; failure: TtsFailure }

/**
 * 取值的两种结果。导出给 `voices.ts` 复用 —— 音色列表/验证也要"缺端点 / 缺凭据"
 * 这两句一模一样的话,抄一份迟早会有一处忘记改。
 */
export type Resolved<T> = { ok: true; value: T } | { ok: false; failure: TtsFailure }

// ===== 语言码 =====

/** `zh_cn` → `zh`(ISO 639-1) */
export function toIso639(tag: string): string {
  return tag.trim().toLowerCase().split('_')[0] ?? ''
}

/**
 * `zh_cn` → `zh-CN`(BCP-47)。
 *
 * 子标签的大小写不是"一律大写":地区是两位字母或三位数字(全大写),
 * 书写系统是四位字母(词首大写,`zh_hant_tw` → `zh-Hant-TW`)。
 */
export function toBcp47(tag: string): string {
  const parts = tag.trim().toLowerCase().split('_').filter(Boolean)
  const language = parts.shift()
  if (!language) return ''
  return [language, ...parts.map(formatSubtag)].join('-')
}

function formatSubtag(part: string): string {
  if (part.length === 2 || /^\d{3}$/.test(part)) return part.toUpperCase()
  if (part.length === 4) return `${part[0].toUpperCase()}${part.slice(1)}`
  return part
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// ===== 共用零件 =====

export function requireBaseUrl(service: ResolvedService): Resolved<string> {
  if (!service.baseUrl) {
    return {
      ok: false,
      failure: {
        kind: 'config',
        message: `服务「${service.id}」没有端点地址`,
        hint: '在服务设置页里填端点',
      },
    }
  }
  return { ok: true, value: service.baseUrl }
}

function requireModel(service: ResolvedService): Resolved<string> {
  if (!service.model) {
    return {
      ok: false,
      failure: {
        kind: 'config',
        message: `服务「${service.id}」没有模型`,
        hint: '在服务设置页里选模型',
      },
    }
  }
  return { ok: true, value: service.model }
}

/** 该协议要的那个凭据字段 —— 名字由 `AUTH_SHAPES` 定,不是适配器自己编的 */
export function requireApiKey(input: {
  service: ResolvedService
  credential: (ref: string) => string | null
}): Resolved<string> {
  const field = input.service.auth.find((item) => item.key === 'apiKeyRef')
  if (!field) {
    return {
      ok: false,
      failure: {
        kind: 'config',
        message: `服务「${input.service.id}」没有 apiKeyRef`,
        hint: '在服务设置页里补上 API KEY 引用',
      },
    }
  }
  const value = input.credential(field.value)
  if (!value) {
    return {
      ok: false,
      failure: {
        kind: 'credential',
        message: `本地缓存里没有 API KEY「${field.value}」`,
        hint: '打开本地缓存填一份 —— 它不进工程，只在你这台机器上',
      },
    }
  }
  return { ok: true, value }
}

/**
 * 把失败响应翻成一句人话。
 *
 * 这是"选传输层"拿不到的那半个好处:能读到厂商的错误体,于是"Key 无效""额度不足"
 * 能直接显示给用户,而不是一句 `Failed to fetch`。
 */
export function describeHttpFailure(provider: string, response: TtsHttpResponse): string {
  let detail = decodeText(response.bytes).trim().slice(0, 300)
  const parsed = decodeJson(response.bytes)
  if (isPlainObject(parsed)) {
    if (isPlainObject(parsed.error) && typeof parsed.error.message === 'string') {
      detail = parsed.error.message
    } else {
      for (const key of ['message', 'detail', 'status_msg', 'error_description']) {
        if (typeof parsed[key] === 'string') {
          detail = parsed[key] as string
          break
        }
      }
    }
  }
  return `${provider} 返回 ${response.status}${detail ? `：${detail}` : ''}`
}

/** 裸音频字节响应:非 2xx 一律翻成可读错误 */
function rawAudioParser(provider: string): (response: TtsHttpResponse) => ParsedAudio {
  return (response) =>
    response.ok && response.bytes.length > 0
      ? { ok: true, audio: response.bytes }
      : {
          ok: false,
          failure: { kind: 'http', message: describeHttpFailure(provider, response) },
        }
}

function jsonHeaders(extra: Record<string, string>): Record<string, string> {
  return { 'Content-Type': 'application/json', ...extra }
}

// ===== 各协议 =====

/**
 * OpenAI 兼容 —— `POST /v1/audio/speech`,裸音频字节。
 * 一家吃下 OpenAI / Groq / OpenRouter 及各类兼容网关。
 */
function openaiCompatible(input: AdapterInput): AdaptedRequest {
  const baseUrl = requireBaseUrl(input.service)
  if (!baseUrl.ok) return baseUrl
  const model = requireModel(input.service)
  if (!model.ok) return model
  const apiKey = requireApiKey(input)
  if (!apiKey.ok) return apiKey

  const body: Record<string, unknown> = {
    model: model.value,
    input: input.request.text,
    voice: input.request.voice,
    // **绝不请求 `opus`** —— 返回的是 Ogg Opus,转码管线会判非法(规范 §5.1)
    response_format: input.format === 'mp3' ? 'mp3' : 'wav',
  }
  if (input.request.speed !== undefined) body.speed = input.request.speed

  return {
    ok: true,
    http: {
      url: joinUrl(baseUrl.value, '/audio/speech'),
      headers: jsonHeaders({ Authorization: `Bearer ${apiKey.value}` }),
      body: JSON.stringify(body),
    },
    parse: rawAudioParser('OpenAI 兼容接口'),
  }
}

/** ElevenLabs —— voice 在**路径**里,鉴权用 `xi-api-key` 头 */
function elevenLabs(input: AdapterInput): AdaptedRequest {
  const baseUrl = requireBaseUrl(input.service)
  if (!baseUrl.ok) return baseUrl
  const model = requireModel(input.service)
  if (!model.ok) return model
  const apiKey = requireApiKey(input)
  if (!apiKey.ok) return apiKey

  // 文档里 `output_format` 的形态是 `codec_sampleRate_bitrate`，默认 `mp3_44100_128`。
  // 它还有 PCM 档（需 Pro 档订阅，且是无头裸流，要自己包 WAV 头）——
  // 先照文档给的值走，换成无损档要另做一层封装。
  const outputFormat = 'mp3_44100_128'

  const body: Record<string, unknown> = {
    text: input.request.text,
    model_id: model.value,
  }
  // 文档明说 `language_code` **不被 multilingual_v2 支持**，传了也只会被忽略，
  // 所以只有换到别的模型时才带它。
  if (input.request.language && model.value !== 'eleven_multilingual_v2') {
    body.language_code = toIso639(input.request.language)
  }
  if (input.request.speed !== undefined) {
    body.voice_settings = { speed: input.request.speed }
  }

  const path = `/v1/text-to-speech/${encodeURIComponent(input.request.voice)}`
  return {
    ok: true,
    http: {
      url: `${joinUrl(baseUrl.value, path)}?output_format=${outputFormat}`,
      headers: jsonHeaders({
        'xi-api-key': apiKey.value,
        Accept: 'audio/mpeg',
      }),
      body: JSON.stringify(body),
    },
    parse: rawAudioParser('ElevenLabs'),
  }
}

/** Azure —— SSML 请求体,格式由头指定 */
function azure(input: AdapterInput): AdaptedRequest {
  const baseUrl = requireBaseUrl(input.service)
  if (!baseUrl.ok) return baseUrl
  const apiKey = requireApiKey(input)
  if (!apiKey.ok) return apiKey

  // 无头裸 PCM 是 `raw-*`；`riff-*` 是包了 WAV 头的,转码侧不用再补头
  const outputFormat =
    input.format === 'mp3'
      ? 'audio-24khz-96kbitrate-mono-mp3'
      : 'riff-24khz-16bit-mono-pcm'

  const locale = toBcp47(input.request.language ?? 'en_us')
  const voice = escapeXml(input.request.voice)
  const text = escapeXml(input.request.text)

  // 语速在 SSML 里是相对百分比：1.05 → +5%
  const rate =
    input.request.speed === undefined || input.request.speed === 1
      ? ''
      : `<prosody rate="${input.request.speed >= 1 ? '+' : ''}${Math.round(
          (input.request.speed - 1) * 100,
        )}%">${text}</prosody>`
  const inner = rate || text

  const ssml =
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}">` +
    `<voice name="${voice}">${inner}</voice>` +
    `</speak>`

  return {
    ok: true,
    http: {
      // 预设没有默认端点（按区域部署），所以 baseUrl 是用户填的；
      // 填成整条 `…/cognitiveservices/v1` 也不会拼成两遍
      url: appendOnce(baseUrl.value, '/cognitiveservices/v1'),
      headers: {
        'Ocp-Apim-Subscription-Key': apiKey.value,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': outputFormat,
        // 官方样例都带它；某些部署上缺了会被拒
        'User-Agent': 'HanShuWebUI',
      },
      body: ssml,
    },
    parse: rawAudioParser('Azure Speech'),
  }
}

/** MiniMax —— 返回的音频在 JSON 里,编码由**请求时**声明 */
function minimax(input: AdapterInput): AdaptedRequest {
  const baseUrl = requireBaseUrl(input.service)
  if (!baseUrl.ok) return baseUrl
  const model = requireModel(input.service)
  if (!model.ok) return model
  const apiKey = requireApiKey(input)
  if (!apiKey.ok) return apiKey

  const voiceSetting: Record<string, unknown> = {
    voice_id: input.request.voice,
    vol: 1,
    pitch: 0,
  }
  if (input.request.speed !== undefined) voiceSetting.speed = input.request.speed

  const body = {
    model: model.value,
    text: input.request.text,
    stream: false,
    // 编码是我们**声明**的，所以解码时不用猜（见 transport 里的说明）
    output_format: 'hex',
    voice_setting: voiceSetting,
    audio_setting: { sample_rate: 32000, format: input.format === 'mp3' ? 'mp3' : 'wav', channel: 1 },
  }

  return {
    ok: true,
    http: {
      url: joinUrl(baseUrl.value, '/t2a_v2'),
      headers: jsonHeaders({ Authorization: `Bearer ${apiKey.value}` }),
      body: JSON.stringify(body),
    },
    parse: (response) => {
      if (!response.ok) {
        return { ok: false, failure: { kind: 'http', message: describeHttpFailure('MiniMax', response) } }
      }
      const payload = decodeJson(response.bytes)
      if (!isPlainObject(payload)) {
        return { ok: false, failure: { kind: 'decode', message: 'MiniMax 返回的不是 JSON' } }
      }
      // **业务错误藏在 200 里**，不看这一层会把失败当成功
      const baseResp = payload.base_resp
      if (isPlainObject(baseResp) && baseResp.status_code !== 0) {
        const detail = typeof baseResp.status_msg === 'string' ? baseResp.status_msg : ''
        return {
          ok: false,
          failure: {
            kind: 'http',
            message: `MiniMax 报错：${detail || baseResp.status_code}`,
          },
        }
      }
      const data = payload.data
      if (!isPlainObject(data)) {
        return { ok: false, failure: { kind: 'decode', message: 'MiniMax 没有返回 data' } }
      }
      if (data.status !== 2) {
        return {
          ok: false,
          failure: {
            kind: 'http',
            message: `MiniMax 音频未完成（status=${String(data.status)}）`,
          },
        }
      }
      const audio = decodeEmbeddedAudio(data.audio, 'hex')
      if (!audio || audio.length === 0) {
        return { ok: false, failure: { kind: 'decode', message: 'MiniMax 返回的音频解不开' } }
      }
      return { ok: true, audio }
    },
  }
}

/**
 * 还没实现的协议。
 *
 * `google` 要 OAuth2(给 service account 私钥签 JWT 换 access token),
 * `polly` 要 SigV4 签名 —— 两件都是**签名**活儿,和"贴一个 Key"不是一回事,
 * 单独一片做。在这里明确失败,好过让用户在服务编辑器里配好了却在合成时才炸。
 */
function notImplemented(protocol: ProtocolId): (input: AdapterInput) => AdaptedRequest {
  return () => ({
    ok: false,
    failure: {
      kind: 'unsupported',
      message: `协议「${protocol}」的鉴权需要签名，尚未实现`,
      hint: '先用 openai-compatible / elevenlabs / azure / minimax 这四家',
    },
  })
}

/** 拼一个"只加一次"的后缀 —— 用户把整条路径填进端点时不会变成两遍 */
function appendOnce(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  const suffix = path.replace(/^\/+/, '')
  return base.endsWith(suffix) ? base : `${base}/${suffix}`
}

/** 按协议分派。**这张表就是代码分支的入口** —— 加协议要发版,加供应商不用 */
export const ADAPTERS: Record<ProtocolId, (input: AdapterInput) => AdaptedRequest> = {
  'openai-compatible': openaiCompatible,
  elevenlabs: elevenLabs,
  azure,
  minimax,
  google: notImplemented('google'),
  polly: notImplemented('polly'),
}
