/**
 * 客户端的核对 —— 文本切分、一次合成的编排。
 * Run: npm run test:tts-client
 *
 * 不打真实网络:传输是注入的,用假实现按调用次序返回不同的字节,
 * 这样"顺序对不对""有没有丢文本""半截失败会不会被当成功"都能钉住。
 */

import { resolvePresets } from '../src/tts/providers.ts'
import { resolveService, toServiceDefinition, type ResolvedService } from '../src/tts/service.ts'
import { toVoicePlan } from '../src/tts/plan.ts'
import { splitTextForSynthesis } from '../src/tts/textSplit.ts'
import { concatAudio, synthesize, synthesizePlanLocale } from '../src/tts/client.ts'
import {
  TtsTransportError,
  encodeText,
  type TtsHttpRequest,
  type TtsHttpResponse,
  type TtsTransport,
} from '../src/tts/transport.ts'
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

const unknownFailure: TtsFailure = { kind: 'config', message: '<没失败>' }

const presets = resolvePresets().presets
const KEY = 'sk-test'

function serviceOf(json: string, id: string): ResolvedService {
  return resolveService(toServiceDefinition(JSON.parse(json)), id, presets)
}

const OPENAI = '{"version":1,"provider":"openai","auth":{"apiKeyRef":"app:k"}}'
const openaiService = serviceOf(OPENAI, 'openai-main')

const credential = (ref: string) => (ref === 'app:k' ? KEY : null)

function okResponse(bytes: Uint8Array): TtsHttpResponse {
  return { status: 200, ok: true, bytes, contentType: 'audio/wav' }
}

/** 记录每次请求，并按调用序号返回不同字节 —— 于是"顺序"可断言 */
function recordingTransport(options: {
  failAt?: number
  throwAt?: number
} = {}): { transport: TtsTransport; requests: TtsHttpRequest[] } {
  const requests: TtsHttpRequest[] = []
  const transport: TtsTransport = async (request) => {
    requests.push(request)
    const index = requests.length
    if (options.throwAt === index) throw new TtsTransportError('Failed to fetch', '可能是 CORS')
    if (options.failAt === index) {
      return { status: 429, ok: false, bytes: encodeText('rate limited'), contentType: 'text/plain' }
    }
    return okResponse(new Uint8Array([index, index, index]))
  }
  return { transport, requests }
}

// ===== 1. 文本切分 =====

section('1. 文本切分：切点是句末，且**一个字符都不丢**')
check('空文本', splitTextForSynthesis(''), [])
check('没有上限就不切', splitTextForSynthesis('很长的一段话。', undefined), [
  { text: '很长的一段话。', start: 0 },
])
check('没超限就不切', splitTextForSynthesis('短。', 100), [{ text: '短。', start: 0 }])

const SENTENCE = '这是一句话。'
const LONG = SENTENCE.repeat(700)
const longChunks = splitTextForSynthesis(LONG, 4096)
check('超限才切，且切成两块', longChunks.length, 2)
check(
  '每块都在上限内',
  longChunks.every((chunk) => chunk.text.length <= 4096),
  true,
)
check('**拼回去与原文逐字相同**（丢字是最难查的错）', longChunks.map((c) => c.text).join(''), LONG)
check(
  '`start` 指回原文的位置',
  longChunks.every((chunk) => LONG.slice(chunk.start, chunk.start + chunk.text.length) === chunk.text),
  true,
)
check('切点落在句末', longChunks[0].text.endsWith('。'), true)

const noEnding = '甲'.repeat(50)
const forced = splitTextForSynthesis(noEnding, 20)
check('没有句末标点时按长度硬切', forced.map((c) => c.text.length), [20, 20, 10])
check('硬切也不丢字', forced.map((c) => c.text).join(''), noEnding)

const clauses = '甲甲甲甲甲，乙乙乙乙乙，丙丙丙丙丙。'
const byClause = splitTextForSynthesis(clauses, 12)
check('单句超限时先退到从句', byClause.map((c) => c.text), ['甲甲甲甲甲，乙乙乙乙乙，', '丙丙丙丙丙。'])
check('从句切也不丢字', byClause.map((c) => c.text).join(''), clauses)

// ===== 2. 一次合成 =====

section('2. 一次合成')
check('拼接工具', [...concatAudio([new Uint8Array([1, 2]), new Uint8Array([3])])], [1, 2, 3])

const single = recordingTransport()
const singleResult = await synthesize(
  { service: openaiService, text: '你好。', voice: 'alloy', language: 'zh_cn' },
  { transport: single.transport, credential },
)
check('单块成功', singleResult.ok, true)
check(
  '音频就是传输返回的字节',
  singleResult.ok ? [...singleResult.audio] : null,
  [1, 1, 1],
)
check('发了一次请求', single.requests.length, 1)
check('请求带上了语言与音色', JSON.parse(String(single.requests[0].body)), {
  model: 'gpt-4o-mini-tts',
  input: '你好。',
  voice: 'alloy',
  response_format: 'wav',
})

section('3. 长文本：分块发、按顺序拼')
const multi = recordingTransport()
const ratios: number[] = []
const multiResult = await synthesize(
  { service: openaiService, text: LONG, voice: 'alloy', language: 'zh_cn' },
  {
    transport: multi.transport,
    credential,
    onProgress: (ratio) => ratios.push(ratio),
  },
)
check('成功', multiResult.ok, true)
check('发了两次请求', multi.requests.length, 2)
check('块数报出来', multiResult.ok ? multiResult.chunks : 0, 2)
check(
  '**音频按请求顺序拼**，不跳段',
  multiResult.ok ? [...multiResult.audio] : null,
  [1, 1, 1, 2, 2, 2],
)
check(
  '**发出去的文本拼回来与原文相同**（切分不丢字，也没重排）',
  multi.requests.map((r) => JSON.parse(String(r.body)).input).join(''),
  LONG,
)
check('进度从 1/n 到 1', ratios, [0.5, 1])

section('4. 失败：分类 + 不留半截音频')
const noKey = await synthesize(
  { service: openaiService, text: '你好。', voice: 'alloy' },
  { transport: recordingTransport().transport, credential: () => null },
)
check('凭据缺失归到 credential', noKey.ok ? unknownFailure.kind : noKey.failure.kind, 'credential')
check(
  '并且带下一步',
  noKey.ok ? false : noKey.failure.hint?.includes('本地缓存'),
  true,
)

const dead = await synthesize(
  { service: openaiService, text: '你好。', voice: 'alloy' },
  { transport: recordingTransport({ throwAt: 1 }).transport, credential },
)
check('传输失败归到 transport（不是 http）', dead.ok ? unknownFailure.kind : dead.failure.kind, 'transport')
check('传输层给的 hint 被保住', dead.ok ? '' : dead.failure.hint, '可能是 CORS')

const refused = await synthesize(
  { service: openaiService, text: '你好。', voice: 'alloy' },
  { transport: recordingTransport({ failAt: 1 }).transport, credential },
)
check('厂商拒绝归到 http', refused.ok ? unknownFailure.kind : refused.failure.kind, 'http')
check('说的是哪家的什么错', refused.ok ? '' : refused.failure.message, 'OpenAI 兼容接口 返回 429：rate limited')

const halfFailed = await synthesize(
  { service: openaiService, text: LONG, voice: 'alloy' },
  { transport: recordingTransport({ failAt: 2 }).transport, credential },
)
check('**第二块失败就整体失败**（不留半截配音）', halfFailed.ok, false)
check('并且报的是那一块的错', halfFailed.ok ? '' : halfFailed.failure.kind, 'http')

const controller = new AbortController()
const cancelled = recordingTransport()
controller.abort()
const aborted = await synthesize(
  { service: openaiService, text: LONG, voice: 'alloy' },
  { transport: cancelled.transport, credential, signal: controller.signal },
)
check('已取消就不发请求', cancelled.requests.length, 0)
check('取消也是一次明确的失败', aborted.ok ? '' : aborted.failure.message, '合成已取消')

// ===== 5. 从一条语言出发（两级门禁）=====

section('5. 从 `.tts` 的一条语言出发')
const plan = toVoicePlan(
  JSON.parse(
    '{"version":1,"voices":{"zh_cn":{"service":"openai-main","voice":"alloy"},"ja_jp":{"service":"openai-main","voice":"voice-custom"}}}',
  ),
)
const services = new Map<string, ResolvedService>([['openai-main', openaiService]])

const presetVoice = await synthesizePlanLocale(
  { plan, locale: 'zh_cn', text: '你好。', services },
  { transport: recordingTransport().transport, credential },
)
check('预置音色直接合成', presetVoice.ok, true)

const noLocale = await synthesizePlanLocale(
  { plan, locale: 'en_us', text: 'hi', services },
  { transport: recordingTransport().transport, credential },
)
check('没配的语言归到 config', noLocale.ok ? '' : noLocale.failure.kind, 'config')
check('说的是这份方案没配它', noLocale.ok ? '' : noLocale.failure.message, '这份配音方案没有配「en_us」')

const noService = await synthesizePlanLocale(
  { plan, locale: 'zh_cn', text: '你好。', services: new Map() },
  { transport: recordingTransport().transport, credential },
)
check('服务文件缺失归到 config', noService.ok ? '' : noService.failure.kind, 'config')

const customTransport = recordingTransport()
const customVoice = await synthesizePlanLocale(
  { plan, locale: 'ja_jp', text: 'こんにちは。', services },
  { transport: customTransport.transport, credential },
)
check('自定义音色 id（控制台克隆的也是 id）直接合成', customVoice.ok, true)
check('**音色就是 .tts 里写的那个 id**', JSON.parse(String(customTransport.requests[0].body)).voice, 'voice-custom')

const noVoicePlan = toVoicePlan(
  JSON.parse('{"version":1,"voices":{"zh_cn":{"service":"openai-main"}}}'),
)
const noVoice = await synthesizePlanLocale(
  { plan: noVoicePlan, locale: 'zh_cn', text: '你好。', services },
  { transport: recordingTransport().transport, credential },
)
check('没填音色 id 归到 config', noVoice.ok ? '' : noVoice.failure.kind, 'config')
check(
  '并说清去哪儿填（不是只说"生成失败"）',
  noVoice.ok ? '' : Boolean(noVoice.failure.hint?.includes('配音方案') && noVoice.failure.hint?.includes('音色')),
  true,
)

// ===== 汇总 =====

console.log(
  failures.length === 0
    ? `\n全部通过（${checks} 项）\n`
    : `\n${failures.length} / ${checks} 项失败：\n\n${failures.map((f) => `  ✗ ${f}`).join('\n\n')}\n`,
)
process.exit(failures.length === 0 ? 0 : 1)
