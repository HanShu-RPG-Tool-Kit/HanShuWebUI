/**
 * `.tts` 配音方案的读写与校验 —— 规范 `docs/tts-spec.md` §3 / §5 / §7.1 / §7.2。
 *
 * 两条读写法则（规范 §9）：
 * - **读要宽容**：老版本、未知键都能进；解析不动原文里认识的键之外的东西。
 * - **写要严格**：只写当前版本的规范形状，外加保留下来的未知键。
 *
 * 校验分两级，别混：
 * - `validateVoicePlanStructure` 只看这份 JSON 的形状，**离线可跑**，不需要工程上下文。
 * - `validateVoicePlanSemantics` 查引用：服务文件在不在、音色 id 拼得对不对。
 *
 * 顶层只有 `version` 与 `voices`。**没有顶层 `service`，也没有 `default` 兜底键** ——
 * 每条语言写全自己的配置，缺语言是"录音棚里选不到"，不是错误（规范 §7.4）。
 */

import { formatLocaleTag, isValidLocaleTag } from '../i18n/locales'
import {
  PROTOCOLS,
  SERVICE_FILE_DIR,
  VOICE_PLAN_EXTENSION,
  characterNameOfFileName,
  hasErrors,
  isPlainObject,
  type Issue,
  type ReadResult,
} from './spec'
import type { ResolvedService } from './service'

/** 一条语言。**自给自足** —— 服务、音色、语速都在这一层 */
export type VoicePlanEntry = {
  /** 服务 id，引用 `meta/voice/service/<id>.ttsservice` */
  service: string
  /**
   * 音色 id —— 厂商账号下的那个。**克隆音色也是 id**：克隆在厂商控制台做，
   * 这里只引用结果（实测：ElevenLabs 的 `GET /v1/voices` 能列出控制台建的音色；
   * MiniMax 列不出，但 T2A 对不存在的 id 报 `2054 voice id not exist`，可精确验证）。
   */
  voice?: string
  /** 语速；不写即 1.0（**字段默认值**，不是从别处继承） */
  speed?: number
  /** 保留的未知键，回写时带上（规范 §9） */
  extra: Record<string, unknown>
}

export type VoicePlan = {
  version: number
  voices: Record<string, VoicePlanEntry>
  /** 保留的未知键 */
  extra: Record<string, unknown>
}

const KNOWN_TOP_KEYS = ['version', 'voices']
const KNOWN_ENTRY_KEYS = ['service', 'voice', 'speed']

/**
 * 顶层出现即**报错**的键。它们是"认识的键放错了位置" ——
 * 当未知键放过的话，用户会以为顶层那个值生效了，而实际读的是语言条目里的值。
 * 与规范 §5.1 拒绝顶层 `character` / `name` 是同一条思路。
 */
const MISPLACED_TOP_KEYS: Record<string, string> = {
  character: '角色名只来自文件名',
  name: '角色名只来自文件名',
  id: '角色名只来自文件名',
  service: '`service` 属于语言条目，见规范 §5.5',
  speed: '`speed` 属于语言条目，见规范 §5.5',
}

function unknownKeys(
  source: Record<string, unknown>,
  known: readonly string[],
  path: string,
): Issue[] {
  const issues: Issue[] = []
  for (const key of Object.keys(source)) {
    if (known.includes(key)) continue
    issues.push({
      level: 'warning',
      path: path ? `${path}.${key}` : key,
      message: '未知键，会被原样保留',
    })
  }
  return issues
}

// ===== 结构校验（§7.1）=====

/**
 * §7.1 结构校验。只吃**已经 `JSON.parse` 过**的原始值，不看类型化模型 ——
 * 这样形状不对的字段不会在解析阶段被丢掉，错误能报在真正出问题的那一层。
 */
export function validateVoicePlanStructure(raw: unknown, fileName?: string): Issue[] {
  const issues: Issue[] = []
  const error = (path: string, message: string) =>
    issues.push({ level: 'error', path, message })
  const warn = (path: string, message: string) =>
    issues.push({ level: 'warning', path, message })

  if (fileName !== undefined && !characterNameOfFileName(fileName)) {
    error('文件名', `「${fileName}」不是合法的 ${VOICE_PLAN_EXTENSION} 文件名`)
  }

  if (!isPlainObject(raw)) {
    error('$', '顶层必须是对象')
    return issues
  }

  if (raw.version === undefined) {
    error('version', '缺少 version')
  } else if (typeof raw.version !== 'number' || !Number.isInteger(raw.version)) {
    error('version', 'version 必须是整数')
  } else if (raw.version !== 1) {
    error('version', `不认识的版本 ${raw.version}，当前只认 1`)
  }

  for (const [key, reason] of Object.entries(MISPLACED_TOP_KEYS)) {
    if (key in raw) error(key, `顶层不允许出现：${reason}`)
  }

  if (raw.voices === undefined) {
    error('voices', '缺少 voices')
    return issues
  }
  if (!isPlainObject(raw.voices)) {
    error('voices', 'voices 必须是对象')
    return issues
  }

  const locales = Object.keys(raw.voices)
  if (locales.length === 0) error('voices', '至少要有一条语言')

  for (const locale of locales) {
    const path = `voices.${locale}`

    if (!isValidLocaleTag(locale)) {
      const formatted = formatLocaleTag(locale)
      error(
        path,
        formatted
          ? `语言标签必须是格式化后的形式，用 \`${formatted}\``
          : '不是合法的语言标签（小写，可带 `_region` 段）',
      )
      continue
    }

    const entry = raw.voices[locale]
    if (!isPlainObject(entry)) {
      error(path, '语言条目必须是对象')
      continue
    }

    validateEntryStructure(entry, path, { error, warn })
  }

  return [...issues, ...unknownKeys(raw, [...KNOWN_TOP_KEYS, ...Object.keys(MISPLACED_TOP_KEYS)], '')]
}

type Reporters = {
  error: (path: string, message: string) => void
  warn: (path: string, message: string) => void
}

function validateEntryStructure(
  entry: Record<string, unknown>,
  path: string,
  { error, warn }: Reporters,
): void {
  if (typeof entry.service !== 'string' || !entry.service.trim()) {
    error(`${path}.service`, '缺少 service（每条语言都要自带服务）')
  }

  if (typeof entry.voice !== 'string' || !entry.voice.trim()) {
    error(`${path}.voice`, '缺少 voice —— 厂商账号下的音色 id（克隆音色也在厂商控制台克隆，这里只填 id）')
  }

  // 旧版格式（≤0.0.x）允许 `clone` 描述样本集并在本机克隆 —— 实测后改为「克隆一律
  // 在厂商控制台做，这里只引用音色 id」。旧键不丢：落进 `extra` 原样保留（§9）。
  if (entry.clone !== undefined) {
    error(
      `${path}.clone`,
      '克隆已不在工程里做 —— 到厂商控制台克隆，把音色 id 填进 voice（这个键会被原样保留，不会丢）',
    )
  }

  if (entry.speed !== undefined && typeof entry.speed !== 'number') {
    error(`${path}.speed`, 'speed 必须是数值')
  }

  for (const key of Object.keys(entry)) {
    if (!KNOWN_ENTRY_KEYS.includes(key) && key !== 'clone') {
      warn(`${path}.${key}`, '未知键，会被原样保留')
    }
  }
}

// ===== 解析 =====

/** 从已校验（或至少已解析）的原始值构建类型化模型，能取多少取多少 */
export function toVoicePlan(raw: unknown): VoicePlan {
  const plan: VoicePlan = { version: 1, voices: {}, extra: {} }
  if (!isPlainObject(raw)) return plan

  if (typeof raw.version === 'number') plan.version = raw.version

  if (isPlainObject(raw.voices)) {
    for (const [locale, entryRaw] of Object.entries(raw.voices)) {
      if (!isPlainObject(entryRaw)) continue
      const entry: VoicePlanEntry = { service: '', extra: {} }

      if (typeof entryRaw.service === 'string') entry.service = entryRaw.service
      if (typeof entryRaw.voice === 'string') entry.voice = entryRaw.voice
      if (typeof entryRaw.speed === 'number') entry.speed = entryRaw.speed

      for (const [key, value] of Object.entries(entryRaw)) {
        if (!KNOWN_ENTRY_KEYS.includes(key)) entry.extra[key] = value
      }
      plan.voices[locale] = entry
    }
  }

  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN_TOP_KEYS.includes(key)) plan.extra[key] = value
  }

  return plan
}

/**
 * 解析 + 结构校验。**`ok` 为 false 时不要回写** —— 原文里有解析不了的东西，
 * 覆盖等于丢数据。
 */
export function readVoicePlan(raw: string, fileName?: string): ReadResult<VoicePlan> {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (parseError) {
    const message = parseError instanceof Error ? parseError.message : String(parseError)
    return {
      value: toVoicePlan(null),
      issues: [{ level: 'error', path: '$', message: `不是合法 JSON：${message}` }],
      ok: false,
    }
  }

  const issues = validateVoicePlanStructure(data, fileName)
  return { value: toVoicePlan(data), issues, ok: !hasErrors(issues) }
}

// ===== 语义校验（§7.2）=====

export type PlanSemanticContext = {
  /** 工程里已有的服务定义，按 id 索引 */
  services: ReadonlyMap<string, ResolvedService>
  /** 本机凭据是否可解析；不给则跳过凭据体检 */
  hasCredential?: (ref: string) => boolean
}

/**
 * §7.2 语义校验。**凭据缺失只提示不报错** —— 协作者打开工程时必然缺凭据，
 * 那不是文件的问题（规范 §7.2）。
 */
export function validateVoicePlanSemantics(
  plan: VoicePlan,
  context: PlanSemanticContext,
): Issue[] {
  const issues: Issue[] = []
  const warn = (path: string, message: string) =>
    issues.push({ level: 'warning', path, message })
  const error = (path: string, message: string) =>
    issues.push({ level: 'error', path, message })

  for (const [locale, entry] of Object.entries(plan.voices)) {
    const path = `voices.${locale}`

    const service = context.services.get(entry.service)
    if (!service) {
      error(
        `${path}.service`,
        `找不到服务「${entry.service}」—— 工程里需要 ${SERVICE_FILE_DIR}/${entry.service}.ttsservice`,
      )
      continue
    }

    // 音色能否用，取决于该服务走的预设 —— 预设给了固定枚举时才判得了
    if (entry.voice && service.preset?.voices) {
      if (!service.preset.voices.includes(entry.voice)) {
        error(`${path}.voice`, `「${entry.voice}」不在 ${service.preset.id} 的音色列表里`)
      }
    }

    // 语速越界只警告并钳制：各协议区间不同，用户不该被一个数字拦在门外
    if (entry.speed !== undefined && service.protocol) {
      const range = PROTOCOLS[service.protocol].speedRange
      if (range && (entry.speed < range[0] || entry.speed > range[1])) {
        warn(
          `${path}.speed`,
          `${service.protocol} 的语速区间是 ${range[0]}–${range[1]}，${entry.speed} 会被钳制`,
        )
      }
    }

    if (context.hasCredential) {
      for (const field of service.auth) {
        if (!context.hasCredential(field.value)) {
          warn(
            `${path}.service`,
            `本机还没有凭据「${field.value}」（服务「${entry.service}」需要）`,
          )
        }
      }
    }
  }

  return issues
}

// ===== 写出 =====

function entryToJson(entry: VoicePlanEntry): Record<string, unknown> {
  const out: Record<string, unknown> = { service: entry.service }
  if (entry.voice !== undefined) out.voice = entry.voice
  if (entry.speed !== undefined) out.speed = entry.speed
  // 未知键原样带上，跨版本往返不丢数据
  for (const [key, value] of Object.entries(entry.extra)) out[key] = value
  return out
}

/** 只写当前版本的规范形状 + 保留下来的未知键 */
export function stringifyVoicePlan(plan: VoicePlan): string {
  const voices: Record<string, unknown> = {}
  for (const [locale, entry] of Object.entries(plan.voices)) {
    voices[locale] = entryToJson(entry)
  }

  const out: Record<string, unknown> = { version: plan.version, voices }
  for (const [key, value] of Object.entries(plan.extra)) out[key] = value

  return `${JSON.stringify(out, null, 2)}\n`
}

// ===== 录音棚的两级门禁（§7.4）=====

/**
 * 第①级：工程里有哪些配音方案。
 * **没有 `.tts` 的说话人不出现在这一级** —— 选不到，而不是报错。
 */
export function listPlanCharacters(
  fileNames: readonly string[],
): { name: string; fileName: string }[] {
  return fileNames
    .map((fileName) => ({ name: characterNameOfFileName(fileName), fileName }))
    .filter((item): item is { name: string; fileName: string } => item.name !== null)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}

/**
 * 第②级：这份方案能生成哪些语言。
 * 键就是全部选项 —— 没配的语言不在列表里，不存在"选了一个没配的语言"这种状态。
 */
export function listPlanLocales(plan: VoicePlan): string[] {
  return Object.keys(plan.voices).sort()
}
