/**
 * `.tts` / `.ttsservice` 的共用词汇表 —— 协议枚举、凭据形态、语速区间、校验结果类型。
 *
 * 规范见应用内帮助「配音：服务与方案规范」。这里只放**协议本身的事实**（请求长什么样、要哪种凭据），
 * 不放**哪家供应商**（默认端点、默认模型、默认能力），后者在 `providers.ts`。
 *
 * 协议枚举是**封闭**的：每个值背后是一个适配器，只能在发版时增加。
 * 扩展点不在这里，在 `provider` 预设表；而且预设表连用户都能加条目。
 */

import { FILE_DIRS } from '../workspace'

/** 配音方案的后缀 */
export const VOICE_PLAN_EXTENSION = '.tts'
/** 服务定义的后缀 —— 比 `.tts` 长，`getExtension` 取最后一个点之后的全串，不会误判 */
export const SERVICE_FILE_EXTENSION = '.ttsservice'

/**
 * 两类文件在工程里的目录。
 * 与 `workspace.FILE_DIRS` **同源**：归位、加载、校验都读同一处，不另写一份。
 */
export const VOICE_PLAN_DIR = FILE_DIRS[VOICE_PLAN_EXTENSION]
export const SERVICE_FILE_DIR = FILE_DIRS[SERVICE_FILE_EXTENSION]

// ===== 协议 =====

export const PROTOCOL_IDS = [
  'openai-compatible',
  'elevenlabs',
  'azure',
  'minimax',
  'google',
  'polly',
] as const

export type ProtocolId = (typeof PROTOCOL_IDS)[number]

export function isProtocolId(value: unknown): value is ProtocolId {
  return (
    typeof value === 'string' && (PROTOCOL_IDS as readonly string[]).includes(value)
  )
}

/**
 * 凭据字段的形态 —— 预设档决定该协议要哪一种，编辑器据此渲染表单。
 * 用户看到的是"贴一个 Key"或"贴一对 Key"，不是抽象的字段名。
 */
export const AUTH_SHAPES = {
  apiKey: [{ key: 'apiKeyRef', label: 'API KEY' }],
  awsSigV4: [
    { key: 'accessKeyRef', label: 'Access Key' },
    { key: 'secretKeyRef', label: 'Secret Key' },
  ],
  serviceAccount: [{ key: 'serviceAccountRef', label: 'Service Account' }],
} as const

export type AuthShapeId = keyof typeof AUTH_SHAPES

/**
 * 凭据字段 → 引用名的后缀。
 *
 * `apiKeyRef` 不加后缀（一个服务一个 Key，名字就是服务名）；其余要区分，
 * 否则 Polly 的两个引用会都叫 `app:polly` —— 那在凭据库里没法看。
 */
export const AUTH_SUFFIX: Record<string, string> = {
  apiKeyRef: '',
  accessKeyRef: '-access',
  secretKeyRef: '-secret',
  serviceAccountRef: '-sa',
}

/**
 * 凭据引用的默认名字。
 *
 * 新建服务 / 换供应商时用它补上没填的引用：空着只是把同样的输入推后一步，
 * 而这个名字与凭据库里要填的那条对得上。**已有的值不动。**
 */
export function defaultCredentialRef(serviceId: string, fieldKey: string): string {
  return `app:${serviceId}${AUTH_SUFFIX[fieldKey] ?? ''}`
}

export const AUTH_SHAPE_IDS = Object.keys(AUTH_SHAPES) as AuthShapeId[]

export type ProtocolInfo = {
  /** 界面显示名 */
  label: string
  /** 端点形态，给人看的一句话 */
  endpoint: string
  /** 该协议的凭据形态 */
  authShape: AuthShapeId
  /**
   * 语速合法区间。**没有可靠共识的协议留空**，表示不校验 ——
   * 编一个数字进去比不校验更坏，用户会以为那是厂商规定的上下限。
   */
  speedRange?: readonly [number, number]
  /**
   * 单次请求的字符上限，超过要在客户端切分。**同样只填有文档依据的**：
   * 补一个猜的数会让长文本在某一段突然失败，而切分本身是免费的。
   * 留空 = 没有已知上限，不切。
   */
  requestCharLimit?: number
}

export const PROTOCOLS: Record<ProtocolId, ProtocolInfo> = {
  'openai-compatible': {
    label: 'OpenAI 兼容',
    endpoint: 'POST /v1/audio/speech，JSON → 裸音频字节',
    authShape: 'apiKey',
    speedRange: [0.25, 4],
    requestCharLimit: 4096,
  },
  elevenlabs: {
    label: 'ElevenLabs',
    endpoint: 'POST /v1/text-to-speech/{voice_id}，JSON → 裸音频字节',
    authShape: 'apiKey',
    speedRange: [0.7, 1.2],
    requestCharLimit: 5000,
  },
  azure: {
    label: 'Azure Speech',
    endpoint: 'POST /cognitiveservices/v1，SSML → 裸音频字节',
    authShape: 'apiKey',
    // 没查到明确的单请求字符上限，所以不切 —— 猜一个只会让长文本在中间莫名失败
  },
  minimax: {
    label: 'MiniMax',
    endpoint: 'POST /v1/t2a_v2，JSON → **JSON 内 hex**',
    authShape: 'apiKey',
    speedRange: [0.5, 2],
    requestCharLimit: 10000,
  },
  google: {
    label: 'Google Cloud TTS',
    endpoint: 'text:synthesize，JSON → JSON 内 base64',
    authShape: 'serviceAccount',
  },
  polly: {
    label: 'Amazon Polly',
    endpoint: 'SynthesizeSpeech，SigV4 签名',
    authShape: 'awsSigV4',
  },
}

// ===== 校验 =====

export type IssueLevel = 'error' | 'warning'

/** 一条校验结论。`path` 是 JSON 路径（`voices.zh_cn.service`），顶层问题用键名本身 */
export type Issue = {
  level: IssueLevel
  path: string
  message: string
}

/**
 * 合成失败的分类。**分类本身是功能**:每一种都要给用户不同的下一步,
 * 混成一句"合成失败"等于什么都没说。
 *
 * - `config` —— 服务定义自己不成立(缺端点 / 缺模型),改的是 `.ttsservice`
 * - `credential` —— 本地缓存里没有 API KEY，改的是本地缓存
 * - `unsupported` —— 该协议还没实现,改的是选哪家
 * - `transport` —— 请求没发出去(CORS / DNS / 断网 / 证书)
 * - `http` —— 厂商明确拒绝了(Key 无效 / 额度不足 / 模型名不对 / 音色不存在)
 * - `decode` —— 响应读不出来或音频解不开
 */
export type TtsFailureKind =
  | 'config'
  | 'credential'
  | 'unsupported'
  | 'transport'
  | 'http'
  | 'decode'

export type TtsFailure = {
  kind: TtsFailureKind
  message: string
  /** 用户能照做的下一步。有的话一定要给 —— 这才是失败信息的意义 */
  hint?: string
}

/** 纯对象 —— JSON 里的 `{}`，不含数组与 null */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function hasErrors(issues: readonly Issue[]): boolean {
  return issues.some((issue) => issue.level === 'error')
}

export function issueErrors(issues: readonly Issue[]): Issue[] {
  return issues.filter((issue) => issue.level === 'error')
}

/**
 * 读出来的结果。**`ok` 为 false 时不要回写** —— 原文里有解析不了的东西，
 * 覆盖等于丢数据（规范 §9：迁移/解析失败要报告原因并保留原文）。
 */
export type ReadResult<T> = {
  value: T
  issues: Issue[]
  ok: boolean
}

/** 凭据引用：`env:NAME` / `app:NAME`。`auth` 里每个 `*Ref` 键都要匹配它 */
export const CREDENTIAL_REF_RE = /^(env|app):[A-Za-z0-9_.-]+$/

/**
 * 凭据**名字**允许的字符 —— 就是 `CREDENTIAL_REF_RE` 去掉 `env:` / `app:` 前缀那一段。
 *
 * 单独导出而不是让每个表单各写一份：名字的字符集是引用语法的一半，
 * 抄一份迟早会有一处忘记改（凭据弹窗与服务表单原先是两份字面量相同的正则）。
 */
export const CREDENTIAL_NAME_RE = /^[A-Za-z0-9_.-]+$/

/** 服务 id 可用字符（与 `normalizeResourceName` 一致：非空、不含这些字符） */
export const RESOURCE_NAME_BAD_RE = /[\\/:*?"<>|]/

/** 服务 id 是否是合法资源名。**允许中文** —— 与 `序章.hs` 一致 */
export function isValidServiceId(raw: string): boolean {
  const id = raw.trim()
  if (!id) return false
  return !RESOURCE_NAME_BAD_RE.test(id)
}

/** 端点：必须 `https://`；只对 localhost / 127.0.0.1 放行 `http://` */
export function isValidBaseUrl(raw: string): boolean {
  const value = raw.trim()
  if (!value) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol === 'https:') return true
  if (url.protocol === 'http:') {
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  }
  return false
}

/** `.ttsservice` 的文件名 ←→ 服务 id */
export function serviceFileName(id: string): string {
  return `${id}${SERVICE_FILE_EXTENSION}`
}

/** 文件名 → 服务 id；不是 `.ttsservice` 或名字不合法时返回 null */
export function serviceIdOfFileName(fileName: string): string | null {
  const name = fileName.trim()
  if (!name.toLowerCase().endsWith(SERVICE_FILE_EXTENSION)) return null
  const id = name.slice(0, name.length - SERVICE_FILE_EXTENSION.length)
  return isValidServiceId(id) ? id.trim() : null
}

/** `.tts` 的文件名 ←→ 角色名（角色名就是文件名去后缀，见规范 §5.1） */
export function planFileName(character: string): string {
  return `${character}${VOICE_PLAN_EXTENSION}`
}

/** 这个文件名属于哪一类 TTS 文件；都不是则 null */
export function ttsFileKindOf(fileName: string): 'service' | 'plan' | null {
  if (serviceIdOfFileName(fileName)) return 'service'
  if (characterNameOfFileName(fileName)) return 'plan'
  return null
}

export function characterNameOfFileName(fileName: string): string | null {
  const name = fileName.trim()
  if (!name.toLowerCase().endsWith(VOICE_PLAN_EXTENSION)) return null
  const character = name.slice(0, name.length - VOICE_PLAN_EXTENSION.length)
  return isValidServiceId(character) ? character.trim() : null
}
