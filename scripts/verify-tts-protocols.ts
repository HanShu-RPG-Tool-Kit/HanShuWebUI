/**
 * 协议适配器的行为核对 —— 规范见帮助「配音：服务与方案规范」§5.2 / §5.1。
 * Run: npm run test:tts-protocols
 *
 * 不打真实网络:适配器只产出请求、只解析响应,所以这里拿假响应把两件事都钉住。
 * 报文形态对着各家线上文档核对过 —— 改动前请先复核文档,不要凭印象改。
 */

import { resolvePresets } from '../src/tts/providers.ts'
import { resolveService, toServiceDefinition, type ResolvedService } from '../src/tts/service.ts'
import {
  ADAPTERS,
  toBcp47,
  toIso639,
  type AdapterInput,
  type AdaptedRequest,
  type ParsedAudio,
} from '../src/tts/protocols.ts'
import { decodeText, encodeText, type TtsHttpResponse } from '../src/tts/transport.ts'
import type { TtsFailure } from '../src/tts/spec.ts'

let checks = 0
const failures: string[] = []

function check(label: string, actual: unknown, expected: unknown): void {
  checks += 1
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) failures.push(`${label}\n       实际 ${a}\n       期望 ${e}`)
}

function section(name: string): void {
  console.log(`\n${name}`)
}

const presets = resolvePresets().presets
const KEY = 'sk-test-key'

function serviceOf(json: string, id: string): ResolvedService {
  return resolveService(toServiceDefinition(JSON.parse(json)), id, presets)
}

function build(
  protocol: keyof typeof ADAPTERS,
  service: ResolvedService,
  request: AdapterInput['request'],
  format?: AdapterInput['format'],
): AdaptedRequest {
  return ADAPTERS[protocol]({
    service,
    request,
    credential: (ref) => (ref === 'app:k' ? KEY : null),
    format,
  })
}

function expectOk(result: AdaptedRequest): Extract<AdaptedRequest, { ok: true }> {
  if (!result.ok) throw new Error(`构建失败：${result.failure.message}`)
  return result
}

/** 失败是**分类的**，不是一句话 —— 两种属性都要断言 */
const failureOf = (result: AdaptedRequest | ParsedAudio): TtsFailure =>
  result.ok ? { kind: 'config', message: '' } : result.failure

const bodyOf = (result: Extract<AdaptedRequest, { ok: true }>): Record<string, unknown> =>
  JSON.parse(String(result.http.body)) as Record<string, unknown>

function response(status: number, body: string | Uint8Array): TtsHttpResponse {
  const bytes = typeof body === 'string' ? encodeText(body) : body
  return { status, ok: status >= 200 && status < 300, bytes, contentType: null }
}

const OPENAI = '{"version":1,"provider":"openai","auth":{"apiKeyRef":"app:k"}}'
const ELEVEN = '{"version":1,"provider":"elevenlabs","auth":{"apiKeyRef":"app:k"}}'
const AZURE =
  '{"version":1,"provider":"azure","baseUrl":"https://eastasia.tts.speech.microsoft.com","auth":{"apiKeyRef":"app:k"}}'
const MINIMAX = '{"version":1,"provider":"minimax","auth":{"apiKeyRef":"app:k"}}'

// ===== 1. 语言码 =====

section('1. 语言码换算')
check('ISO 639-1 取语言段', toIso639('zh_cn'), 'zh')
check('ISO 639-1 只要语言段', toIso639('en_us'), 'en')
check('BCP-47 地区大写', toBcp47('zh_cn'), 'zh-CN')
check('BCP-47 只有语言', toBcp47('ja'), 'ja')
check('BCP-47 书写系统词首大写', toBcp47('zh_hant_tw'), 'zh-Hant-TW')
check('BCP-47 数字地区', toBcp47('es_419'), 'es-419')

// ===== 2. OpenAI 兼容 =====

section('2. openai-compatible')
const openai = expectOk(
  build('openai-compatible', serviceOf(OPENAI, 'openai-main'), {
    text: '你好',
    voice: 'alloy',
    language: 'zh_cn',
  }),
)
check('端点', openai.http.url, 'https://api.openai.com/v1/audio/speech')
check('鉴权头', openai.http.headers.Authorization, `Bearer ${KEY}`)
check('内容类型', openai.http.headers['Content-Type'], 'application/json')
check('请求体', bodyOf(openai), {
  model: 'gpt-4o-mini-tts',
  input: '你好',
  voice: 'alloy',
  response_format: 'wav',
})
check(
  '不传语速就不带 speed',
  'speed' in bodyOf(openai),
  false,
)
check(
  '传了语速才带',
  bodyOf(
    expectOk(
      build('openai-compatible', serviceOf(OPENAI, 'openai-main'), {
        text: '你好',
        voice: 'alloy',
        speed: 1.2,
      }),
    ),
  ).speed,
  1.2,
)
check(
  '**绝不请求 opus**',
  bodyOf(openai).response_format === 'opus',
  false,
)
check(
  'mp3 只在明确要求时才用',
  bodyOf(
    expectOk(
      build('openai-compatible', serviceOf(OPENAI, 'openai-main'), { text: 'x', voice: 'v' }, 'mp3'),
    ),
  ).response_format,
  'mp3',
)
check(
  '返回裸字节直接当音频',
  decodeText(
    (
      expectOk(build('openai-compatible', serviceOf(OPENAI, 'openai-main'), { text: 'x', voice: 'v' }))
        .parse(response(200, new Uint8Array([1, 2, 3]))) as { ok: true; audio: Uint8Array }
    ).audio,
  ),
  '\u0001\u0002\u0003',
)

// ===== 3. ElevenLabs =====

section('3. elevenlabs')
const eleven = expectOk(
  build('elevenlabs', serviceOf(ELEVEN, 'el'), { text: 'Hello', voice: 'abc/def', language: 'ja_jp' }),
)
check(
  'voice 在路径里且被转义',
  eleven.http.url,
  'https://api.elevenlabs.io/v1/text-to-speech/abc%2Fdef?output_format=mp3_44100_128',
)
check('xi-api-key 头（不是 Bearer）', eleven.http.headers['xi-api-key'], KEY)
check('Authorization 头不该出现', 'Authorization' in eleven.http.headers, false)
check('multilingual_v2 不带 language_code（文档明说不支持）', bodyOf(eleven), {
  text: 'Hello',
  model_id: 'eleven_multilingual_v2',
})
check(
  '换到 v3 才带 language_code',
  bodyOf(
    expectOk(
      build(
        'elevenlabs',
        resolveService(
          toServiceDefinition(
            JSON.parse('{"version":1,"provider":"elevenlabs","model":"eleven_v3","auth":{"apiKeyRef":"app:k"}}'),
          ),
          'el',
          presets,
        ),
        { text: 'Hello', voice: 'v', language: 'ja_jp' },
      ),
    ),
  ).language_code,
  'ja',
)
check(
  '语速放进 voice_settings',
  bodyOf(
    expectOk(build('elevenlabs', serviceOf(ELEVEN, 'el'), { text: 'x', voice: 'v', speed: 1.1 })),
  ).voice_settings,
  { speed: 1.1 },
)

// ===== 4. Azure =====

section('4. azure（SSML）')
const azure = expectOk(
  build('azure', serviceOf(AZURE, 'az'), { text: '你好', voice: 'zh-CN-XiaoxiaoNeural', language: 'zh_cn' }),
)
check('端点', azure.http.url, 'https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1')
check('整条路径填进去也不会拼两遍', expectOk(
  build(
    'azure',
    resolveService(
      toServiceDefinition(
        JSON.parse('{"version":1,"provider":"azure","baseUrl":"https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1","auth":{"apiKeyRef":"app:k"}}'),
      ),
      'az',
      presets,
    ),
    { text: 'x', voice: 'v' },
  ),
).http.url, 'https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1')
check('鉴权头', azure.http.headers['Ocp-Apim-Subscription-Key'], KEY)
check('内容类型是 SSML', azure.http.headers['Content-Type'], 'application/ssml+xml')
check(
  '**要单声道 WAV 档**（riff 自带 WAV 头，转码不用补）',
  azure.http.headers['X-Microsoft-OutputFormat'],
  'riff-24khz-16bit-mono-pcm',
)
check('带 User-Agent（官方样例都有）', azure.http.headers['User-Agent'], 'HanShuWebUI')
check(
  'SSML 里是 BCP-47 语言码与音色名',
  String(azure.http.body).includes('xml:lang="zh-CN"') &&
    String(azure.http.body).includes('<voice name="zh-CN-XiaoxiaoNeural">'),
  true,
)
check('不加语速就没有 prosody', String(azure.http.body).includes('prosody'), false)
check(
  '语速换成相对百分比',
  String(
    expectOk(
      build('azure', serviceOf(AZURE, 'az'), { text: 'x', voice: 'v', language: 'zh_cn', speed: 1.05 }),
    ).http.body,
  ).includes('<prosody rate="+5%">'),
  true,
)
check(
  '减速是负号',
  String(
    expectOk(
      build('azure', serviceOf(AZURE, 'az'), { text: 'x', voice: 'v', language: 'zh_cn', speed: 0.9 }),
    ).http.body,
  ).includes('<prosody rate="-10%">'),
  true,
)
check(
  '文本被 XML 转义（否则 SSML 直接坏掉）',
  String(
    expectOk(
      build('azure', serviceOf(AZURE, 'az'), { text: 'A & B <C>', voice: 'v', language: 'zh_cn' }),
    ).http.body,
  ).includes('A &amp; B &lt;C&gt;'),
  true,
)

// ===== 5. MiniMax =====

section('5. minimax（音频在 JSON 里）')
const minimax = expectOk(
  build('minimax', serviceOf(MINIMAX, 'mm'), { text: '你好', voice: 'linwan_v1' }),
)
check('端点', minimax.http.url, 'https://api.minimax.io/v1/t2a_v2')
check('鉴权头', minimax.http.headers.Authorization, `Bearer ${KEY}`)
check('**请求里声明编码**，解码时不用猜', bodyOf(minimax).output_format, 'hex')
check('音频设置要单声道', bodyOf(minimax).audio_setting, {
  sample_rate: 32000,
  format: 'wav',
  channel: 1,
})
check('voice_setting 带 id', (bodyOf(minimax).voice_setting as Record<string, unknown>).voice_id, 'linwan_v1')
check('语速不传就不写', 'speed' in (bodyOf(minimax).voice_setting as Record<string, unknown>), false)

const HEX_OK = '{"data":{"audio":"4f676753","status":2},"base_resp":{"status_code":0,"status_msg":"success"}}'
check(
  'hex 音频解得开',
  decodeText((minimax.parse(response(200, HEX_OK)) as { ok: true; audio: Uint8Array }).audio),
  'OggS',
)
const baseRespError = failureOf(
  minimax.parse(response(200, '{"base_resp":{"status_code":1002,"status_msg":"rate limit"}}')),
)
check('**业务错误藏在 200 里，必须看 base_resp**', baseRespError.message, 'MiniMax 报错：rate limit')
check('这类失败归到 http（厂商明确拒绝了）', baseRespError.kind, 'http')

const incomplete = failureOf(
  minimax.parse(
    response(200, '{"data":{"audio":"4f676753","status":1},"base_resp":{"status_code":0}}'),
  ),
)
check('音频没完成（status≠2）也算失败', incomplete.message, 'MiniMax 音频未完成（status=1）')

const undecodable = failureOf(
  minimax.parse(response(200, '{"data":{"audio":"zz","status":2},"base_resp":{"status_code":0}}')),
)
check('解不开的音频不放过（宁可失败也不写坏资产）', undecodable.message, 'MiniMax 返回的音频解不开')
check('解不开归到 decode（是我们的问题，不是厂商拒绝）', undecodable.kind, 'decode')

// ===== 6. 失败路径都要说人话 =====

section('6. 失败要说人话（这就是选传输层拿不到的那半个好处）')
const openaiBuilt = expectOk(
  build('openai-compatible', serviceOf(OPENAI, 'openai-main'), { text: 'x', voice: 'v' }),
)
const badKey = failureOf(openaiBuilt.parse(response(401, '{"error":{"message":"Incorrect API key provided"}}')))
check('厂商错误体被读出来（OpenAI 的嵌套形态）', badKey.message, 'OpenAI 兼容接口 返回 401：Incorrect API key provided')
check('归到 http', badKey.kind, 'http')

const plainText = failureOf(openaiBuilt.parse(response(500, 'upstream exploded')))
check('纯文本错误体也照样带出来', plainText.message, 'OpenAI 兼容接口 返回 500：upstream exploded')

section('7. 缺东西时给的是**分类的**可读原因，不是崩掉')
const noCredential = failureOf(
  ADAPTERS['openai-compatible']({
    service: serviceOf(OPENAI, 'openai-main'),
    request: { text: 'x', voice: 'v' },
    credential: () => null,
  }),
)
check('凭据没配 —— 是 credential，不是"合成失败"', noCredential.kind, 'credential')
check('并且告诉用户下一步', noCredential.hint?.includes('本地缓存'), true)

const noBaseUrl = failureOf(
  ADAPTERS.azure({
    service: resolveService(
      toServiceDefinition(JSON.parse('{"version":1,"provider":"azure","auth":{"apiKeyRef":"app:k"}}')),
      'az',
      presets,
    ),
    request: { text: 'x', voice: 'v' },
    credential: () => KEY,
  }),
)
check('预设没有默认端点（Azure）时归到 config', noBaseUrl.kind, 'config')
check('说的是缺什么', noBaseUrl.message, '服务「az」没有端点地址')

section('8. 还没实现的协议明确说不，而不是悄悄发出去')
const google = failureOf(
  ADAPTERS.google({
    service: serviceOf('{"version":1,"provider":"google","auth":{"serviceAccountRef":"app:sa"}}', 'g'),
    request: { text: 'x', voice: 'v' },
    credential: () => KEY,
  }),
)
check('google 归到 unsupported（要换一家，不是去改配置）', google.kind, 'unsupported')
check('google 要 OAuth2 签名', google.message, '协议「google」的鉴权需要签名，尚未实现')

const polly = failureOf(
  ADAPTERS.polly({
    service: serviceOf(
      '{"version":1,"provider":"polly","baseUrl":"https://polly.us-east-1.amazonaws.com","auth":{"accessKeyRef":"app:a","secretKeyRef":"app:s"}}',
      'p',
    ),
    request: { text: 'x', voice: 'v' },
    credential: () => KEY,
  }),
)
check('polly 要 SigV4 签名', polly.message, '协议「polly」的鉴权需要签名，尚未实现')
check('polly 同样归到 unsupported', polly.kind, 'unsupported')

// ===== 汇总 =====

console.log(
  failures.length === 0
    ? `\n全部通过（${checks} 项）\n`
    : `\n${failures.length} / ${checks} 项失败：\n\n${failures.map((f) => `  ✗ ${f}`).join('\n\n')}\n`,
)
process.exit(failures.length === 0 ? 0 : 1)
