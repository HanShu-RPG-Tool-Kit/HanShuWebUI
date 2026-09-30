/**
 * 克隆流程的核对 —— 规范 `docs/tts-spec.md` §5.6。
 * Run: npm run test:tts-clone
 *
 * 不打真实网络:传输是注入的,按调用次序回不同的假响应。
 * 报文形态对着各家线上文档核对过 —— 改之前先复核文档。
 */

import { resolvePresets } from '../src/tts/providers.ts'
import { resolveService, toServiceDefinition, type ResolvedService } from '../src/tts/service.ts'
import { buildMultipart, uploadFileName } from '../src/tts/multipart.ts'
import {
  clonePlanFor,
  ensureClonedVoice,
  minimaxVoiceId,
  runClone,
  type CloneSample,
} from '../src/tts/clone.ts'
import { fingerprintBytes } from '../src/tts/cloneRegistry.ts'
import { createCloneRegistry } from '../src/tts/cloneRegistry.ts'
import {
  TtsTransportError,
  decodeText,
  encodeText,
  type TtsHttpRequest,
  type TtsHttpResponse,
  type TtsTransport,
} from '../src/tts/transport.ts'

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
const KEY = 'sk-test'

function serviceOf(json: string, id: string): ResolvedService {
  return resolveService(toServiceDefinition(JSON.parse(json)), id, presets)
}

const ELEVEN = '{"version":1,"provider":"elevenlabs","auth":{"apiKeyRef":"app:k"}}'
const MINIMAX = '{"version":1,"provider":"minimax","auth":{"apiKeyRef":"app:k"}}'
const credential = (ref: string) => (ref === 'app:k' ? KEY : null)

const samples: CloneSample[] = [
  { path: 'assets/voice-samples/林晚/ja_jp/01.wav', bytes: encodeText('take-1'), contentType: 'audio/wav' },
  { path: 'assets/voice-samples/林晚/ja_jp/02.wav', bytes: encodeText('take-2'), contentType: 'audio/wav' },
]

function jsonResponse(payload: unknown, status = 200): TtsHttpResponse {
  const bytes = encodeText(JSON.stringify(payload))
  return { status, ok: status >= 200 && status < 300, bytes, contentType: 'application/json' }
}

function recording(responses: (TtsHttpResponse | Error)[]): {
  transport: TtsTransport
  requests: TtsHttpRequest[]
  steps: string[]
} {
  const requests: TtsHttpRequest[] = []
  const steps: string[] = []
  const transport: TtsTransport = async (request) => {
    requests.push(request)
    const next = responses[requests.length - 1]
    if (next instanceof Error) throw next
    return next ?? jsonResponse({})
  }
  return { transport, requests, steps }
}

// ===== 1. multipart =====

section('1. multipart 构造（传输不认识 multipart，所以在这里拼好）')
const form = buildMultipart(
  [
    { name: 'name', value: '林晚' },
    { name: 'files', filename: 'sample-1.wav', contentType: 'audio/wav', bytes: encodeText('take-1') },
  ],
  'BOUND',
)
const formText = decodeText(form.body)
check('content-type 带 boundary', form.contentType, 'multipart/form-data; boundary=BOUND')
check('第一段以 boundary 开头', formText.startsWith('--BOUND\r\n'), true)
check('结尾是闭合 boundary', formText.endsWith('--BOUND--\r\n'), true)
check('文本字段有 Content-Disposition', formText.includes('Content-Disposition: form-data; name="name"\r\n'), true)
check('文件字段带 filename 与类型', formText.includes('name="files"; filename="sample-1.wav"\r\nContent-Type: audio/wav'), true)
check('**内容原样带过去**', formText.includes('take-1'), true)
check(
  '重名字段按出现次数重复（ElevenLabs 的 files 就是重复字段）',
  decodeText(
    buildMultipart(
      [
        { name: 'files', filename: 'a.wav', contentType: 'audio/wav', bytes: encodeText('x') },
        { name: 'files', filename: 'b.wav', contentType: 'audio/wav', bytes: encodeText('y') },
      ],
      'B',
    ).body,
  ).split('name="files"').length - 1,
  2,
)

section('2. 上传文件名只用 ASCII')
check('中文目录不参与文件名', uploadFileName('assets/voice-samples/林晚/ja_jp/01.wav', 0), 'sample-1.wav')
check('保留扩展名', uploadFileName('assets/s/01.m4a', 1), 'sample-2.m4a')
check('没有扩展名时兜底 wav', uploadFileName('assets/s/01', 0), 'sample-1.wav')
check('大小写归一', uploadFileName('assets/s/01.WAV', 0), 'sample-1.wav')

// ===== 3. ElevenLabs =====

section('3. ElevenLabs：一步到位')
const elevenService = serviceOf(ELEVEN, 'el')
const elevenPlan = clonePlanFor({ service: elevenService, credential, samples, name: '林晚' })
check('一步', elevenPlan.ok ? elevenPlan.steps.length : 0, 1)
check('步骤有名字（进度里显示）', elevenPlan.ok ? elevenPlan.steps[0].label : '', '上传样本并创建音色')

const elevenRun = recording([jsonResponse({ voice_id: 'voice-eleven', requires_verification: false })])
const elevenResult = await runClone(elevenPlan, { transport: elevenRun.transport })
check('拿到 voice_id', elevenResult.ok ? elevenResult.voiceId : '', 'voice-eleven')
check('端点', elevenRun.requests[0].url, 'https://api.elevenlabs.io/v1/voices/add')
check('鉴权用 xi-api-key', elevenRun.requests[0].headers['xi-api-key'], KEY)
check('Content-Type 是 multipart', elevenRun.requests[0].headers['Content-Type'].startsWith('multipart/form-data'), true)
check('两个样本都上传了', decodeText(elevenRun.requests[0].body as Uint8Array).split('name="files"').length - 1, 2)
check('语音名带过去', decodeText(elevenRun.requests[0].body as Uint8Array).includes('林晚'), true)

const elevenBad = await runClone(
  clonePlanFor({ service: elevenService, credential, samples, name: 'x' }),
  { transport: recording([jsonResponse({ detail: 'bad' }, 422)]).transport },
)
check('厂商拒绝 → http', elevenBad.ok ? '' : elevenBad.failure.kind, 'http')

const elevenNoId = await runClone(
  clonePlanFor({ service: elevenService, credential, samples, name: 'x' }),
  { transport: recording([jsonResponse({ requires_verification: true })]).transport },
)
check('响应里没有 voice_id → decode', elevenNoId.ok ? '' : elevenNoId.failure.kind, 'decode')

// ===== 4. MiniMax：两步，且 voice_id 由我们给 =====

section('4. MiniMax：两步，`voice_id` 由我们提供')
const minimaxService = serviceOf(MINIMAX, 'mm')
const generated = minimaxVoiceId(samples.map((s) => fingerprintBytes(s.bytes)))
check('**至少 8 字符**', generated.length >= 8, true)
check('**以字母开头**', /^[a-z]/i.test(generated), true)
check('**必须含数字**（厂商硬约束）', /[0-9]/.test(generated), true)
check('只用字母数字', /^[a-z0-9]+$/i.test(generated), true)
check('可由样本复现（重克隆不会堆重复音色）', minimaxVoiceId(samples.map((s) => fingerprintBytes(s.bytes))), generated)

const minimaxPlan = clonePlanFor({ service: minimaxService, credential, samples, name: '林晚' })
check('两步', minimaxPlan.ok ? minimaxPlan.steps.length : 0, 2)
check(
  '步骤名',
  minimaxPlan.ok ? minimaxPlan.steps.map((s) => s.label) : [],
  ['上传样本', '创建克隆音色'],
)

const minimaxRun = recording([
  jsonResponse({ file: { file_id: 'file-123' }, base_resp: { status_code: 0, status_msg: 'success' } }),
  jsonResponse({ input_sensitive: false, base_resp: { status_code: 0, status_msg: 'success' } }),
])
const minimaxResult = await runClone(minimaxPlan, {
  transport: minimaxRun.transport,
  onStep: (label) => minimaxRun.steps.push(label),
})
check('拿到 voice_id（**响应里没有，是我们给的那个**）', minimaxResult.ok ? minimaxResult.voiceId : '', generated)
check('按顺序报了两步', minimaxRun.steps, ['上传样本', '创建克隆音色'])
check('第一步端点', minimaxRun.requests[0].url, 'https://api.minimax.io/v1/files/upload')
check('上传用 Bearer', minimaxRun.requests[0].headers.Authorization, `Bearer ${KEY}`)
check('上传声明 purpose=voice_clone', decodeText(minimaxRun.requests[0].body as Uint8Array).includes('voice_clone'), true)
check('**只上传第一个样本**（它只收一个文件）', decodeText(minimaxRun.requests[0].body as Uint8Array).split('name="file"').length - 1, 1)
check('第二步端点', minimaxRun.requests[1].url, 'https://api.minimax.io/v1/voice_clone')
check('第二步 JSON 带 file_id 与 voice_id', JSON.parse(String(minimaxRun.requests[1].body)), {
  file_id: 'file-123',
  voice_id: generated,
})
check('国际端点不带 GroupId（国内端点才要）', minimaxRun.requests[0].url.includes('GroupId'), false)

const minimaxUploadFailed = await runClone(
  clonePlanFor({ service: minimaxService, credential, samples, name: 'x' }),
  {
    transport: recording([
      jsonResponse({ base_resp: { status_code: 1008, status_msg: 'insufficient balance' } }),
    ]).transport,
  },
)
check(
  '**上传的业务错误藏在 200 里**',
  minimaxUploadFailed.ok ? '' : minimaxUploadFailed.failure.message,
  'MiniMax 报错：insufficient balance',
)

const minimaxCloneFailed = await runClone(
  clonePlanFor({ service: minimaxService, credential, samples, name: 'x' }),
  {
    transport: recording([
      jsonResponse({ file: { file_id: 'f' }, base_resp: { status_code: 0 } }),
      jsonResponse({ base_resp: { status_code: 1042, status_msg: 'voice_id invalid' } }),
    ]).transport,
  },
)
check(
  '第二步的业务错误同样读得出来',
  minimaxCloneFailed.ok ? '' : minimaxCloneFailed.failure.message,
  'MiniMax 报错：voice_id invalid',
)

// ===== 5. 不支持的协议 =====

section('5. 没实现克隆的协议明确说不')
for (const [provider, json] of [
  ['google', '{"version":1,"provider":"google","auth":{"serviceAccountRef":"app:sa"}}'],
  ['polly', '{"version":1,"provider":"polly","baseUrl":"https://polly.us-east-1.amazonaws.com","auth":{"accessKeyRef":"app:a","secretKeyRef":"app:s"}}'],
  ['azure', '{"version":1,"provider":"azure","baseUrl":"https://eastasia.tts.speech.microsoft.com","auth":{"apiKeyRef":"app:k"}}'],
] as const) {
  const plan = clonePlanFor({ service: serviceOf(json, provider), credential, samples, name: 'x' })
  check(`${provider} 归到 unsupported`, plan.ok ? '' : plan.failure.kind, 'unsupported')
}
const azurePlan = clonePlanFor({
  service: serviceOf(
    '{"version":1,"provider":"azure","baseUrl":"https://eastasia.tts.speech.microsoft.com","auth":{"apiKeyRef":"app:k"}}',
    'az',
  ),
  credential,
  samples,
  name: 'x',
})
check(
  '审批受限的两家给出不同的下一步',
  azurePlan.ok ? '' : azurePlan.failure.hint?.includes('人工审批'),
  true,
)

// ===== 6. 跑计划的失败路径 =====

section('6. 跑计划：失败仍是分类的')
const dead = await runClone(elevenPlan, {
  transport: recording([new TtsTransportError('Failed to fetch', '可能是 CORS')]).transport,
})
check('传输失败 → transport', dead.ok ? '' : dead.failure.kind, 'transport')
check('hint 被保住', dead.ok ? '' : dead.failure.hint, '可能是 CORS')

const controller = new AbortController()
controller.abort()
const cancelled = recording([jsonResponse({ voice_id: 'x' })])
const aborted = await runClone(elevenPlan, { transport: cancelled.transport, signal: controller.signal })
check('取消后不发请求', cancelled.requests.length, 0)
check('取消是一次明确失败', aborted.ok ? '' : aborted.failure.message, '克隆已取消')

const wrongShape = await runClone(
  {
    ok: true,
    steps: [
      {
        label: '假装成功但没给 id',
        build: () => ({
          ok: true,
          request: { url: 'https://x.test/v1', headers: {}, body: '{}' },
          parse: () => ({ ok: true, value: { nope: 1 } }),
        }),
      },
    ],
  },
  { transport: recording([jsonResponse({})]).transport },
)
check('最后一步没给出 voice_id → decode，不当作成功', wrongShape.ok ? '' : wrongShape.failure.kind, 'decode')

// ===== 7. 一步到位 =====

section('7. ensureClonedVoice：登记表优先，克隆要花钱所以不重复做')
const memory = new Map<string, string>()
const fakeStorage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => {
    memory.set(key, value)
  },
}
const registry = createCloneRegistry(fakeStorage)

const first = recording([
  jsonResponse({ file: { file_id: 'f' }, base_resp: { status_code: 0 } }),
  jsonResponse({ base_resp: { status_code: 0 } }),
])
const firstClone = await ensureClonedVoice(
  { service: minimaxService, credential, name: '林晚', samples, registry },
  { transport: first.transport },
)
check('第一次：真的克隆了', firstClone.ok ? firstClone.cloned : null, true)
check('拿到的 id 是派生出来的那个', firstClone.ok ? firstClone.voiceId : '', generated)
check('确实发了两步', first.requests.length, 2)

const second = recording([jsonResponse({})])
const secondClone = await ensureClonedVoice(
  { service: minimaxService, credential, name: '林晚', samples, registry },
  { transport: second.transport },
)
check('第二次：命中登记，没重复克隆', secondClone.ok ? secondClone.cloned : null, false)
check('一个请求都没发（克隆是要花钱的）', second.requests.length, 0)
check('复用同一个 id', secondClone.ok ? secondClone.voiceId : '', generated)

const otherSamples = [{ path: 'assets/s/new.wav', bytes: encodeText('take-9'), contentType: 'audio/wav' }]
const third = recording([
  jsonResponse({ file: { file_id: 'f2' }, base_resp: { status_code: 0 } }),
  jsonResponse({ base_resp: { status_code: 0 } }),
])
const thirdClone = await ensureClonedVoice(
  { service: minimaxService, credential, name: '林晚', samples: otherSamples, registry },
  { transport: third.transport },
)
check('**换了样本就重新克隆**（换了音源还沿用旧音色是最难查的错）', thirdClone.ok ? thirdClone.cloned : null, true)
check('新 id 与旧 id 不同', thirdClone.ok ? thirdClone.voiceId === generated : null, false)

const noSamples = await ensureClonedVoice(
  { service: minimaxService, credential, name: 'x', samples: [], registry },
  { transport: recording([]).transport },
)
check('没有样本 → config', noSamples.ok ? '' : noSamples.failure.kind, 'config')

// ===== 汇总 =====

console.log(
  failures.length === 0
    ? `\n全部通过（${checks} 项）\n`
    : `\n${failures.length} / ${checks} 项失败：\n\n${failures.map((f) => `  ✗ ${f}`).join('\n\n')}\n`,
)
process.exit(failures.length === 0 ? 0 : 1)
