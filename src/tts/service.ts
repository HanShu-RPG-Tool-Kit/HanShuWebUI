/**
 * `.ttsservice` 服务定义的读写、校验与解析 —— 规范见帮助「配音：服务与方案规范」§4 / §7.3。
 *
 * 一个文件 = 一个账号。**文件名就是 id**（没有 `id` 字段）：名字只有一个来源，
 * 否则会出现"文件名与内部 id 不一致"的合法输入，引用就没法静态解析了。
 *
 * 它落在工程里，会被完整分享、进版本库、被贴进 issue，所以 `auth` 里**只放引用**
 * （`env:` / `app:`），真实的密钥永远不进任何文本。
 *
 * `provider` 三态：
 * - 内置预设 / 用户自建预设 —— `protocol` 是**派生值**，写了必须与预设一致
 * - `template` —— 不走预设，`protocol` 与 `baseUrl` 都由用户填
 */

import { findPreset, TEMPLATE_PROVIDER_ID, type ProviderPreset } from './providers'
import {
  AUTH_SHAPES,
  CREDENTIAL_REF_RE,
  PROTOCOLS,
  SERVICE_FILE_DIR,
  defaultCredentialRef,
  hasErrors,
  isPlainObject,
  isProtocolId,
  isValidBaseUrl,
  isValidServiceId,
  serviceFileName,
  serviceIdOfFileName,
  type AuthShapeId,
  type Issue,
  type ProtocolId,
  type ReadResult,
} from './spec'

/** 凭据引用表：`apiKeyRef` → `env:OPENAI_API_KEY`。**没有密钥，只有引用** */
export type AuthSpec = Record<string, string>

export type ServiceDefinition = {
  version: number
  /** 界面显示名；可省，默认取文件名 */
  label?: string
  provider: string
  /** 预设时是派生值；`template` 时是用户输入 */
  protocol?: ProtocolId
  auth: AuthSpec
  baseUrl?: string
  model?: string
  /** 保留的未知键，回写时带上（规范 §9） */
  extra: Record<string, unknown>
}

const KNOWN_KEYS = [
  'version',
  'label',
  'provider',
  'protocol',
  'auth',
  'baseUrl',
  'model',
]

/** 该 id 的服务定义在工程里的路径 */
export function serviceFilePath(id: string): string {
  return `${SERVICE_FILE_DIR}/${serviceFileName(id)}`
}

// ===== 结构校验（§7.3）=====

/**
 * §7.3 结构校验。吃**已经 `JSON.parse` 过**的原始值。
 *
 * 目录内 id 唯一性不在这里判 —— 那是调用方拿全目录的文件名列表做的事。
 */
export function validateServiceStructure(
  raw: unknown,
  id: string,
  presets: readonly ProviderPreset[],
): Issue[] {
  const issues: Issue[] = []
  const error = (path: string, message: string) =>
    issues.push({ level: 'error', path, message })
  const warn = (path: string, message: string) =>
    issues.push({ level: 'warning', path, message })

  if (id && !isValidServiceId(id)) {
    error('文件名', `「${id}」不能当服务 id（不能含 \\ / : * ? " < > |）`)
  }

  if (!isPlainObject(raw)) {
    error('$', '顶层必须是对象')
    return issues
  }

  if (raw.version === undefined) {
    error('version', '缺少 version')
  } else if (raw.version !== 1) {
    error('version', `不认识的版本 ${String(raw.version)}，当前只认 1`)
  }

  if ('id' in raw) error('id', '不允许出现 id —— 文件名就是 id，名字只有一个来源')

  if (raw.label !== undefined && (typeof raw.label !== 'string' || !raw.label.trim())) {
    error('label', 'label 必须是非空字符串')
  }

  const providerId = typeof raw.provider === 'string' ? raw.provider.trim() : ''
  if (!providerId) {
    error('provider', '缺少 provider')
  }

  const isTemplate = providerId === TEMPLATE_PROVIDER_ID
  const preset = isTemplate ? null : findPreset(presets, providerId)
  if (providerId && !isTemplate && !preset) {
    error('provider', `预设表里没有「${providerId}」—— 先建一条预设，或改用 template`)
  }

  const protocol = validateProtocol(raw, { isTemplate, preset, error })
  validateAuth(raw, protocol, { error, warn })
  validateEndpointAndModel(raw, { isTemplate, preset, error, warn })

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.includes(key)) {
      warn(key, '未知键，会被原样保留')
    }
  }

  return issues
}

type Reporters = {
  error: (path: string, message: string) => void
  warn: (path: string, message: string) => void
}

/** `protocol` 是派生值，不是自由输入值 */
function validateProtocol(
  raw: Record<string, unknown>,
  context: { isTemplate: boolean; preset: ProviderPreset | null; error: Reporters['error'] },
): ProtocolId | null {
  const { isTemplate, preset, error } = context
  const value = raw.protocol

  if (isTemplate) {
    if (!isProtocolId(value)) {
      error('protocol', 'template 必须自己选一个 protocol')
      return null
    }
    return value
  }

  if (value !== undefined) {
    if (!isProtocolId(value)) {
      error('protocol', '不是已知的协议')
      return preset?.protocol ?? null
    }
    if (preset && value !== preset.protocol) {
      // 否则会出现 provider: "openai" + protocol: "azure" 这种自相矛盾的合法输入
      error('protocol', `预设「${preset.id}」固定用 ${preset.protocol}，不能改成 ${value}`)
      return preset.protocol
    }
    return value
  }

  return preset?.protocol ?? null
}

function validateAuth(
  raw: Record<string, unknown>,
  protocol: ProtocolId | null,
  { error, warn }: Reporters,
): void {
  const auth = raw.auth
  if (!isPlainObject(auth)) {
    error('auth', '缺少 auth（哪怕只有引用）')
    return
  }

  for (const [key, value] of Object.entries(auth)) {
    if (!key.endsWith('Ref')) {
      error(`auth.${key}`, 'auth 里只放 `*Ref` 引用，不放密钥本身')
      continue
    }
    if (typeof value !== 'string' || !CREDENTIAL_REF_RE.test(value.trim())) {
      error(`auth.${key}`, '必须是 `env:NAME` 或 `app:NAME`')
    }
  }

  if (!protocol) return
  const shape: AuthShapeId = PROTOCOLS[protocol].authShape
  for (const field of AUTH_SHAPES[shape]) {
    if (!(field.key in auth)) {
      error(`auth.${field.key}`, `${protocol} 需要「${field.label}」，不能省`)
    }
  }
  const expected = new Set<string>(AUTH_SHAPES[shape].map((field) => field.key))
  for (const key of Object.keys(auth)) {
    if (key.endsWith('Ref') && !expected.has(key)) {
      warn(`auth.${key}`, `${protocol} 用不到这个字段`)
    }
  }
}

function validateEndpointAndModel(
  raw: Record<string, unknown>,
  context: {
    isTemplate: boolean
    preset: ProviderPreset | null
    error: Reporters['error']
    warn: Reporters['warn']
  },
): void {
  const { isTemplate, preset, error, warn } = context

  const baseUrl = raw.baseUrl
  if (baseUrl === undefined) {
    // `template` 没有预设可依；Azure / Polly 这类按区域部署的预设也没有默认端点
    if (isTemplate) {
      error('baseUrl', 'template 必须自己填 baseUrl')
    } else if (preset && !preset.baseUrl) {
      error('baseUrl', `预设「${preset.id}」没有默认端点，必须自己填`)
    }
  } else if (typeof baseUrl !== 'string' || !isValidBaseUrl(baseUrl)) {
    error('baseUrl', '必须是 https:// 端点（只对 localhost 放行 http://）')
  }

  const model = raw.model
  if (model !== undefined) {
    if (typeof model !== 'string' || !model.trim()) {
      error('model', 'model 必须是非空字符串')
    } else if (preset?.models && !preset.models.includes(model)) {
      // 厂商上新快于应用发版，所以只在候选名单里时才提示，不拦
      warn('model', `不在「${preset.id}」的候选模型里，确认一下拼写`)
    }
  }
}

// ===== 解析 =====

export function toServiceDefinition(raw: unknown): ServiceDefinition {
  const definition: ServiceDefinition = { version: 1, provider: '', auth: {}, extra: {} }
  if (!isPlainObject(raw)) return definition

  if (typeof raw.version === 'number') definition.version = raw.version
  if (typeof raw.label === 'string') definition.label = raw.label
  if (typeof raw.provider === 'string') definition.provider = raw.provider
  if (isProtocolId(raw.protocol)) definition.protocol = raw.protocol
  if (typeof raw.baseUrl === 'string') definition.baseUrl = raw.baseUrl
  if (typeof raw.model === 'string') definition.model = raw.model
  if (isPlainObject(raw.auth)) {
    for (const [key, value] of Object.entries(raw.auth)) {
      if (typeof value === 'string') definition.auth[key] = value
    }
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN_KEYS.includes(key)) definition.extra[key] = value
  }

  return definition
}

/** 解析 + 结构校验。**`ok` 为 false 时不要回写** */
export function readServiceDefinition(
  raw: string,
  id: string,
  presets: readonly ProviderPreset[],
): ReadResult<ServiceDefinition> {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (parseError) {
    const message = parseError instanceof Error ? parseError.message : String(parseError)
    return {
      value: toServiceDefinition(null),
      issues: [{ level: 'error', path: '$', message: `不是合法 JSON：${message}` }],
      ok: false,
    }
  }

  const issues = validateServiceStructure(data, id, presets)
  return { value: toServiceDefinition(data), issues, ok: !hasErrors(issues) }
}

// ===== 解析成"生效值" =====

/**
 * 把定义折叠成调用方真正要用的那几项 —— 预设默认值在这里补齐。
 *
 * 规范管这叫"推导出来的默认"：选了 `provider: "minimax"`，端点和模型就唯一确定了，
 * 写不写都一样，所以省掉它**不产生歧义**（与"顶层默认值"是两回事，见规范 §4.6）。
 */
export type ResolvedService = {
  id: string
  label: string
  provider: string
  /** 没有可用协议时为 null（provider 不在表里，或 `template` 没选协议） */
  protocol: ProtocolId | null
  baseUrl: string | null
  model: string | null
  /** 该协议要求的凭据字段与引用，供凭据体检与适配器取用 */
  auth: { key: string; value: string }[]
  authShape: AuthShapeId | null
  preset: ProviderPreset | null
  issues: Issue[]
}

export function resolveService(
  definition: ServiceDefinition,
  id: string,
  presets: readonly ProviderPreset[],
): ResolvedService {
  const issues: Issue[] = []
  const isTemplate = definition.provider === TEMPLATE_PROVIDER_ID
  const preset = isTemplate ? null : findPreset(presets, definition.provider)

  if (definition.provider && !isTemplate && !preset) {
    issues.push({
      level: 'error',
      path: 'provider',
      message: `预设表里没有「${definition.provider}」`,
    })
  }

  const protocol = preset ? preset.protocol : (definition.protocol ?? null)
  if (definition.provider && !protocol) {
    issues.push({ level: 'error', path: 'protocol', message: '没有可用的协议' })
  }

  return {
    id,
    label: definition.label?.trim() || id,
    provider: definition.provider,
    protocol,
    baseUrl: definition.baseUrl ?? preset?.baseUrl ?? null,
    model: definition.model ?? preset?.model ?? null,
    auth: Object.entries(definition.auth).map(([key, value]) => ({ key, value })),
    authShape: protocol ? PROTOCOLS[protocol].authShape : null,
    preset,
    issues,
  }
}

// ===== 写出 =====

/**
 * 新建一个服务定义的**起点**。
 *
 * 直接建成能通过结构校验的：选一家供应商、按该协议的鉴权形态把凭据引用起好名字。
 * 存一份"什么都还没填"的空壳，只会让它在**方案的服务下拉里都出不来** ——
 * 而新建之后最需要看到它的地方，恰恰就是那里。
 *
 * 端点、模型都不写 —— 留空即跟随预设（§4.6），那是新建时最合理的状态。
 */
export function blankServiceDefinition(
  id: string,
  provider: string,
  presets: readonly ProviderPreset[],
): ServiceDefinition {
  const preset = presets.find((item) => item.id === provider)
  const definition: ServiceDefinition = {
    version: 1,
    provider: preset?.id ?? provider,
    auth: {},
    extra: {},
  }
  if (preset) {
    definition.label = preset.label
    for (const field of AUTH_SHAPES[PROTOCOLS[preset.protocol].authShape]) {
      definition.auth[field.key] = defaultCredentialRef(id, field.key)
    }
  }
  return definition
}

/** 只写当前版本的规范形状 + 保留下来的未知键 */
export function stringifyServiceDefinition(definition: ServiceDefinition): string {
  const out: Record<string, unknown> = { version: definition.version }
  if (definition.label !== undefined) out.label = definition.label
  out.provider = definition.provider
  if (definition.protocol !== undefined) out.protocol = definition.protocol
  out.auth = { ...definition.auth }
  if (definition.baseUrl !== undefined) out.baseUrl = definition.baseUrl
  if (definition.model !== undefined) out.model = definition.model

  for (const [key, value] of Object.entries(definition.extra)) out[key] = value

  return `${JSON.stringify(out, null, 2)}\n`
}

// ===== 目录级 =====

/** 工程里有哪些服务定义 —— 录音棚与角色编辑器都用它填服务下拉 */
export function listServiceIds(fileNames: readonly string[]): string[] {
  const ids = new Set<string>()
  for (const fileName of fileNames) {
    const id = serviceIdOfFileName(fileName)
    if (id) ids.add(id)
  }
  return [...ids].sort()
}
