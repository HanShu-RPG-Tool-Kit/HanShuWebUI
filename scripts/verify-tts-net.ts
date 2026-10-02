/**
 * 传输层与凭据库的行为核对 —— 规范 `docs/tts-spec.md` §1 / §5.3 / §7.2。
 * Run: npm run test:tts-net
 *
 * 这里管的是"请求从哪儿出去、凭什么出去"这两件事,也就是"密钥不进文本"的落地。
 * 不发真实网络请求 —— 传输是注入的,用假实现钉住契约。
 */

import {
  TtsTransportError,
  createFetchTransport,
  decodeBase64,
  decodeEmbeddedAudio,
  decodeHex,
  decodeJson,
  decodeText,
  encodeText,
  joinUrl,
  type TtsHttpRequest,
} from '../src/tts/transport.ts'
import {
  CREDENTIAL_STORAGE_KEY,
  auditCredentials,
  createCredentialResolver,
  createLocalBackend,
  createMemoryBackend,
  maskSecret,
  parseCredentialRef,
} from '../src/tts/credentials.ts'
import { toServiceDefinition, stringifyServiceDefinition } from '../src/tts/service.ts'

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

// ===== 1. 端点拼装 =====

section('1. 端点拼装')
check('base 带不带尾斜杠都一样', joinUrl('https://api.openai.com/v1', '/audio/speech'), 'https://api.openai.com/v1/audio/speech')
check('尾斜杠会被吃掉', joinUrl('https://api.openai.com/v1/', 'audio/speech'), 'https://api.openai.com/v1/audio/speech')
check('base 带路径前缀时不丢', joinUrl('https://api.groq.com/openai/v1', '/audio/speech'), 'https://api.groq.com/openai/v1/audio/speech')

// ===== 2. 传输：成功路径 =====

section('2. 传输（注入假实现，不打真网络）')
const AUDIO = new Uint8Array([79, 103, 103, 83, 0, 2]) // "OggS" + 版本字节
let captured: TtsHttpRequest | null = null

const okTransport = createFetchTransport(async (input, init) => {
  captured = {
    url: input,
    headers: init.headers,
    body: init.body as string,
  }
  return new Response(AUDIO, { status: 200, headers: { 'content-type': 'audio/wav' } })
})

const okResponse = await okTransport({
  url: 'https://api.openai.com/v1/audio/speech',
  headers: { Authorization: 'Bearer app-key' },
  body: '{"model":"gpt-4o-mini-tts"}',
})

check('请求原样发出', [captured?.url, captured?.headers.Authorization, captured?.body], [
  'https://api.openai.com/v1/audio/speech',
  'Bearer app-key',
  '{"model":"gpt-4o-mini-tts"}',
])
check('响应字节原样带回', [...okResponse.bytes], [...AUDIO])
check('状态与 content-type 带回', [okResponse.status, okResponse.ok, okResponse.contentType], [200, true, 'audio/wav'])

// ===== 3. 传输：失败必须分得开 =====

section('3. 传输失败：CORS 与"厂商拒绝"必须分得开')
let transportError: TtsTransportError | null = null
const deadTransport = createFetchTransport(async () => {
  throw new TypeError('Failed to fetch')
})
try {
  await deadTransport({ url: 'https://api.openai.com/v1/audio/speech', headers: {}, body: '{}' })
} catch (error) {
  transportError = error as TtsTransportError
}
check('CORS / 断网这类失败抛出 TtsTransportError', transportError instanceof TtsTransportError, true)
check('原始信息保留', transportError?.message, 'Failed to fetch')
check(
  'hint 说清"不一定是密钥问题"',
  transportError?.hint.includes('不一定') && transportError?.hint.includes('CORS'),
  true,
)

let genericError: TtsTransportError | null = null
try {
  await createFetchTransport(async () => {
    throw new Error('socket hang up')
  })({ url: 'https://x.test/v1', headers: {}, body: '{}' })
} catch (error) {
  genericError = error as TtsTransportError
}
check('非 TypeError 不套用 CORS 说法', genericError?.hint.includes('CORS'), false)

const rejected = await okTransport.call(null, {
  url: 'https://api.openai.com/v1/audio/speech',
  headers: {},
  body: '{}',
})
check('厂商拒绝仍走正常返回（由适配器翻成可读错误）', [rejected.ok, rejected.status], [true, 200])

// ===== 4. 解码 =====

section('4. 解码：编码由适配器指定，不猜')
check('文本往返', decodeText(encodeText('旁白')), '旁白')
check('JSON 解析', decodeJson(encodeText('{"a":1}')), { a: 1 })
check('坏 JSON 返回 null', decodeJson(encodeText('{oops')), null)

const BASE64_SAMPLE = btoa('OggS-audio')
check('base64 解出正确字节', decodeText(decodeBase64(BASE64_SAMPLE) ?? new Uint8Array()), 'OggS-audio')
check('非法 base64 返回 null', decodeBase64('!!!'), null)
check('hex 解出正确字节', decodeText(decodeHex('4f676753') ?? new Uint8Array()), 'OggS')
check('奇数长度 / 非 hex 字符返回 null', [decodeHex('4f6'), decodeHex('zz')], [null, null])

check('按声明取 hex', decodeText(decodeEmbeddedAudio('4f676753', 'hex') ?? new Uint8Array()), 'OggS')
check('按声明取 base64', decodeText(decodeEmbeddedAudio(BASE64_SAMPLE, 'base64') ?? new Uint8Array()), 'OggS-audio')
check('空值返回 null', decodeEmbeddedAudio('', 'hex'), null)
// 这条是"为什么不猜"的证据：hex 串的每个字符都在 base64 字母表里，
// 所以按 base64 解会**成功**，只是解出一堆垃圾 —— 不报错，而是写坏音频。
check(
  '当作 base64 解一个 hex 串会静默出错（所以必须声明编码）',
  decodeText(decodeEmbeddedAudio('4f6767534f676753', 'base64') ?? new Uint8Array()) !== 'OggSOggS',
  true,
)

// ===== 5. 凭据引用 =====

section('5. 凭据引用')
check('env 引用', parseCredentialRef('env:OPENAI_API_KEY'), { scheme: 'env', name: 'OPENAI_API_KEY' })
check('app 引用', parseCredentialRef('app:minimax-main'), { scheme: 'app', name: 'minimax-main' })
check('没有 scheme 的拒绝', parseCredentialRef('OPENAI_API_KEY'), null)
check('别的 scheme 拒绝', parseCredentialRef('keychain:abc'), null)
check('带空格的拒绝', parseCredentialRef('env: MY KEY'), null)

// ===== 6. 凭据库与解析 =====

section('6. 凭据库与解析')
const backend = createMemoryBackend({ 'openai-main': 'sk-live-abcdefghijklmn' })
const resolver = createCredentialResolver({ backend })

check('app: 解析到真值', resolver.resolve('app:openai-main'), 'sk-live-abcdefghijklmn')
check('没配的解析为 null', resolver.resolve('app:missing'), null)
check('has() 能给体检用', [resolver.has('app:openai-main'), resolver.has('app:missing')], [true, false])
check(
  'env: 默认取不到（webview 读不到进程环境变量）',
  createCredentialResolver({ backend }).resolve('env:OPENAI_API_KEY'),
  null,
)
check(
  'env: 由注入的读取器提供',
  createCredentialResolver({ backend, env: (name) => (name === 'OPENAI_API_KEY' ? 'sk-env-1' : null) }).resolve('env:OPENAI_API_KEY'),
  'sk-env-1',
)
check('空白值不算配好', createCredentialResolver({ backend: createMemoryBackend({ blank: '   ' }) }).has('app:blank'), false)

// ===== 7. 凭据体检 =====

section('7. 凭据体检：缺只列出，不报错')
const audit = auditCredentials(
  ['app:openai-main', 'env:MINIMAX_API_KEY', 'app:openai-main', 'sk-plain-text'],
  resolver,
)
check('已配的挑出来', audit.present, ['app:openai-main'])
check('缺的列成待填清单', audit.missing, ['env:MINIMAX_API_KEY'])
check('格式不对的单独归一类', audit.invalid, ['sk-plain-text'])
check('重复引用只算一次', audit.present.length, 1)

// ===== 8. 应用级存储 =====

section('8. 应用级存储（注入假 storage）')
const memory = new Map<string, string>()
const fakeStorage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => {
    memory.set(key, value)
  },
}
const local = createLocalBackend(fakeStorage)
local.set('minimax-main', 'sk-mm-1')
check('写进去了', local.get('minimax-main'), 'sk-mm-1')
check('列得出名字', local.names(), ['minimax-main'])
check('存储键沿用 hanshu.* 命名', memory.has(CREDENTIAL_STORAGE_KEY), true)
local.remove('minimax-main')
check('删得掉', local.get('minimax-main'), null)

memory.set(CREDENTIAL_STORAGE_KEY, '{坏 JSON')
check('坏数据不炸，退回空表', createLocalBackend(fakeStorage).names(), [])

// ===== 9. 关键不变量：密钥不出现在任何文本里 =====

section('9. 不变量：密钥不进任何文本')
const SECRET = 'sk-live-must-never-be-written'
const leakResolver = createCredentialResolver({ backend: createMemoryBackend({ 'openai-main': SECRET }) })
const definition = toServiceDefinition(
  JSON.parse('{"version":1,"provider":"openai","auth":{"apiKeyRef":"app:openai-main"}}'),
)
const fileText = stringifyServiceDefinition(definition)

check('服务定义文本里没有密钥', fileText.includes(SECRET), false)
check('服务定义文本里只有引用', fileText.includes('app:openai-main'), true)
check('真值是分开才拿得到的', leakResolver.resolve('app:openai-main'), SECRET)
check('显示时打码（留头尾 4 位，够辨认是哪个）', maskSecret(SECRET), 'sk-l••••tten')
check('短值整体打码', maskSecret('short'), '••••')

// ===== 汇总 =====

console.log(
  failures.length === 0
    ? `\n全部通过（${checks} 项）\n`
    : `\n${failures.length} / ${checks} 项失败：\n\n${failures.map((f) => `  ✗ ${f}`).join('\n\n')}\n`,
)
process.exit(failures.length === 0 ? 0 : 1)
