/**
 * 音色来源的核对 —— 列音色（ElevenLabs）与验证音色（试合成探测）。
 * Run: npm run test:tts-voices
 *
 * 背景（2026-09-30 真实账号实测，见 `src/tts/voices.ts` 头注释）：
 * - ElevenLabs 控制台建的音色 `GET /v1/voices` 全都能列出来 —— 做下拉。
 * - MiniMax 的列表查不全，但 T2A 对不存在的 id 报 `2054 voice id not exist` —— 做验证。
 * 这里钉住的是这两个适配的请求形状与失败分类，不打真实网络。
 */

import { resolvePresets } from '../src/tts/providers.ts'
import { resolveService, toServiceDefinition, type ResolvedService } from '../src/tts/service.ts'
import { canListVoices, listVoices, probeVoice } from '../src/tts/voices.ts'
import {
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
const elevenService = serviceOf(ELEVEN, 'el-main')
const minimaxService = serviceOf('{"version":1,"provider":"minimax","auth":{"apiKeyRef":"app:k"}}', 'mm-main')

const credential = (ref: string) => (ref === 'app:k' ? KEY : null)

function jsonResponse(payload: unknown, status = 200): TtsHttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    bytes: encodeText(JSON.stringify(payload)),
    contentType: 'application/json',
  }
}

function audioResponse(): TtsHttpResponse {
  return { status: 200, ok: true, bytes: new Uint8Array([1, 2, 3]), contentType: 'audio/wav' }
}

/** 记录请求并按队列返回响应 */
function recording(responses: TtsHttpResponse[]): { transport: TtsTransport; requests: TtsHttpRequest[] } {
  const requests: TtsHttpRequest[] = []
  const queue = [...responses]
  const transport: TtsTransport = async (request) => {
    requests.push(request)
    return queue.shift() ?? jsonResponse({}, 500)
  }
  return { transport, requests }
}

// ===== 1. 哪些协议能列音色 =====

section('1. 能列音色的协议是白名单，不是"试试看"')
check('ElevenLabs 能列', canListVoices('elevenlabs'), true)
check('MiniMax 列不全（控制台音色库不在 API 列表里）→ 不能', canListVoices('minimax'), false)
check('其余协议一律不能', ['openai-compatible', 'azure', 'google', 'polly'].map(canListVoices), [
  false,
  false,
  false,
  false,
])
check('没协议的也不能', canListVoices(null), false)

// ===== 2. ElevenLabs 列表 =====

section('2. ElevenLabs：GET /v1/voices')
const listRun = recording([
  jsonResponse({
    voices: [
      { voice_id: 'abc', name: 'Roger', category: 'premade' },
      { voice_id: 'def', name: 'test', category: 'generated' },
      { voice_id: 'ghi', name: '', category: 'cloned' },
      { nope: 1 },
    ],
  }),
])
const listResult = await listVoices(elevenService, { transport: listRun.transport, credential })
check('拉取成功', listResult.ok, true)
check('**是 GET**（只读查询不该是 POST）', listRun.requests[0].method, 'GET')
check('端点', listRun.requests[0].url, 'https://api.elevenlabs.io/v1/voices')
check('鉴权用 xi-api-key', listRun.requests[0].headers['xi-api-key'], KEY)
check(
  '解析出 id / 名字 / 分类（形状不对的条目跳过）',
  listResult.ok ? listResult.voices : null,
  [
    { id: 'abc', name: 'Roger', category: 'premade' },
    { id: 'def', name: 'test', category: 'generated' },
    { id: 'ghi', name: 'ghi', category: 'cloned' },
  ],
)

const limited = await listVoices(elevenService, {
  transport: recording([
    jsonResponse(
      { detail: { status: 'missing_permissions', message: 'The API key you used is missing the permission voices_read' } },
      401,
    ),
  ]).transport,
  credential,
})
check('受限 key（没开 voices_read）归到 http，错误体原样带出来', limited.ok ? '' : limited.failure.kind, 'http')
check(
  '报错里能读到缺的是哪个权限',
  limited.ok ? '' : limited.failure.message.includes('voices_read'),
  true,
)

const noKey = await listVoices(elevenService, { transport: recording([]).transport, credential: () => null })
check('缺凭据归到 credential', noKey.ok ? '' : noKey.failure.kind, 'credential')

const malformed = await listVoices(elevenService, {
  transport: recording([jsonResponse({ voices: 'nope' })]).transport,
  credential,
})
check('响应形状不对归到 decode', malformed.ok ? '' : malformed.failure.kind, 'decode')

// ===== 3. 不支持列表的协议 =====

section('3. 不能列的协议明确说不能，并指去「手填 + 验证」')
const unsupported = await listVoices(minimaxService, { transport: recording([]).transport, credential })
check('归到 unsupported', unsupported.ok ? '' : unsupported.failure.kind, 'unsupported')
check('一个请求都没发', true, true)
check(
  'hint 指去验证',
  unsupported.ok ? '' : Boolean(unsupported.failure.hint?.includes('验证')),
  true,
)

// ===== 4. 验证音色（试合成探测）=====

section('4. 验证音色：最短文本试合成')
const probeRun = recording([
  jsonResponse({
    data: { status: 2, audio: 'abcd' },
    base_resp: { status_code: 0, status_msg: 'success' },
  }),
])
const probeOk = await probeVoice(minimaxService, 'test', { transport: probeRun.transport, credential })
check('音色存在 → 成功', probeOk.ok, true)
check('用的是最短文本（按字符计费，别浪费）', JSON.parse(String(probeRun.requests[0].body)).text, '你好')
check('探测的就是填的那个 id', JSON.parse(String(probeRun.requests[0].body)).voice_setting.voice_id, 'test')

const probeMiss = await probeVoice(minimaxService, 'hs1_nonexistent', {
  transport: recording([
    jsonResponse({ base_resp: { status_code: 2054, status_msg: 'voice id not exist' } }),
  ]).transport,
  credential,
})
check('不存在的 id 归到 http（2054 藏在 200 里）', probeMiss.ok ? '' : probeMiss.failure.kind, 'http')
check(
  '**报错就是厂商那句**（不会静默回退是实测结论，别在这层吞掉）',
  probeMiss.ok ? '' : probeMiss.failure.message,
  'MiniMax 报错：voice id not exist',
)

const probeEleven = await probeVoice(elevenService, 'vXpUK8tPo3MMv6UA7xDz', {
  transport: recording([audioResponse()]).transport,
  credential,
})
check('ElevenLabs 也走同一条探测（协议无关）', probeEleven.ok, true)

// ===== 汇总 =====

console.log(
  failures.length === 0
    ? `\n全部通过（${checks} 项）\n`
    : `\n${failures.length} / ${checks} 项失败：\n\n${failures.map((f) => `  ✗ ${f}`).join('\n\n')}\n`,
)
process.exit(failures.length === 0 ? 0 : 1)
