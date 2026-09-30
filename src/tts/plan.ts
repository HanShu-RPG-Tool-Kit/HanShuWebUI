/**
 * `.tts` 角色配音方案的读写与校验 —— 规范 `docs/tts-spec.md` §3 / §5 / §7.1 / §7.2。
 *
 * 两条读写法则（规范 §9）：
 * - **读要宽容**：老版本、未知键都能进；解析不动原文里认识的键之外的东西。
 * - **写要严格**：只写当前版本的规范形状，外加保留下来的未知键。
 *
 * 校验分两级，别混：
 * - `validateVoicePlanStructure` 只看这份 JSON 的形状，**离线可跑**，不需要工程上下文。
 * - `validateVoicePlanSemantics` 查引用：服务文件在不在、服务有没有克隆能力、样本在不在。
 *
 * 顶层只有 `version` 与 `voices`。**没有顶层 `service`，也没有 `default` 兜底键** ——
 * 每条语言写全自己的配置，缺语言是"录音棚里选不到"，不是错误（规范 §7.4）。
 */

import { normalizeAssetPath } from '../assets/paths'
import { formatLocaleTag, isValidLocaleTag } from '../i18n/locales'
import {
  PROTOCOLS,
  SERVICE_FILE_DIR,
  VOICE_PLAN_EXTENSION,
  characterNameOfFileName,
  hasErrors,
  isPlainObject,
  isValidConsentRef,
  type Issue,
  type ReadResult,
} from './spec'
import type { ResolvedService } from './service'

/** 克隆来源：样本 + 同意凭证 */
export type CloneSource = {
  /** `assets/` 下的资源路径，不规定目录 */
  samples: string[]
  /** `meta/` 下的相对路径，或 `env:` / `app:` 引用 */
  consent: string
  /** 保留的未知键，回写时带上（规范 §9） */
  extra: Record<string, unknown>
}

/** 一条语言。**自给自足** —— 服务、音色来源、语速都在这一层 */
export type VoicePlanEntry = {
  /** 服务 id，引用 `meta/voice/service/<id>.ttsservice` */
  service: string
  /** 预置音色 id；与 `clone` 恰好一个 */
  voice?: string
  clone?: CloneSource
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
const KNOWN_ENTRY_KEYS = ['service', 'voice', 'clone', 'speed']
const KNOWN_CLONE_KEYS = ['samples', 'consent']

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

  const hasVoice = entry.voice !== undefined
  const hasClone = entry.clone !== undefined

  if (hasVoice === hasClone) {
    error(
      `${path}`,
      hasVoice
        ? '`voice` 与 `clone` 只能有一个'
        : '缺少音色来源：`voice` 与 `clone` 必须有一个',
    )
  }

  if (hasVoice && (typeof entry.voice !== 'string' || !entry.voice.trim())) {
    error(`${path}.voice`, 'voice 必须是非空字符串')
  }

  if (hasClone) {
    if (!isPlainObject(entry.clone)) {
      error(`${path}.clone`, 'clone 必须是对象')
    } else {
      validateCloneStructure(entry.clone, `${path}.clone`, { error, warn })
    }
  }

  if (entry.speed !== undefined && typeof entry.speed !== 'number') {
    error(`${path}.speed`, 'speed 必须是数值')
  }

  for (const key of Object.keys(entry)) {
    if (!KNOWN_ENTRY_KEYS.includes(key)) {
      warn(`${path}.${key}`, '未知键，会被原样保留')
    }
  }
}

function validateCloneStructure(
  clone: Record<string, unknown>,
  path: string,
  { error, warn }: Reporters,
): void {
  for (const key of Object.keys(clone)) {
    if (!KNOWN_CLONE_KEYS.includes(key)) {
      warn(`${path}.${key}`, '未知键，会被原样保留')
    }
  }

  const samples = clone.samples
  if (!Array.isArray(samples)) {
    error(`${path}.samples`, '缺少 samples（数组，至少一项）')
  } else if (samples.length === 0) {
    error(`${path}.samples`, '至少要给一个样本')
  } else {
    samples.forEach((sample, index) => {
      const samplePath = `${path}.samples[${index}]`
      if (typeof sample !== 'string' || !sample.trim()) {
        error(samplePath, '样本必须是非空字符串')
        return
      }
      // 直接走资源系统的规范化 —— 不另写一套路径检查
      if (!normalizeAssetPath(sample)) {
        error(samplePath, '不是合法的 assets 资源路径')
      }
    })
  }

  if (typeof clone.consent !== 'string' || !clone.consent.trim()) {
    error(`${path}.consent`, '缺少同意凭证——声音是生物特征数据，这一步不能省')
  } else if (!isValidConsentRef(clone.consent)) {
    error(`${path}.consent`, 'consent 必须是 `meta/` 下的路径，或 `env:` / `app:` 引用')
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
      if (isPlainObject(entryRaw.clone)) {
        const cloneRaw = entryRaw.clone
        const samples = cloneRaw.samples
        const clone: CloneSource = {
          samples: Array.isArray(samples)
            ? samples.filter((value): value is string => typeof value === 'string')
            : [],
          consent: typeof cloneRaw.consent === 'string' ? cloneRaw.consent : '',
          extra: {},
        }
        for (const [key, value] of Object.entries(cloneRaw)) {
          if (!KNOWN_CLONE_KEYS.includes(key)) clone.extra[key] = value
        }
        entry.clone = clone
      }

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
  /** 工程里已有的资源路径；不给则跳过"样本是否存在"这一项 */
  assetPaths?: ReadonlySet<string>
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

    // 克隆的可用性由**服务商**决定，不由 `.tts` 里写了什么决定（规范 §5.6 硬规则三）
    if (entry.clone && !service.capabilities.includes('clone')) {
      error(
        `${path}.clone`,
        `服务「${entry.service}」没有开启克隆能力，不能在它上面写 clone`,
      )
    }

    if (entry.clone && context.assetPaths) {
      for (const sample of entry.clone.samples) {
        const normalized = normalizeAssetPath(sample)
        if (normalized && !context.assetPaths.has(normalized)) {
          warn(`${path}.clone.samples`, `工程里没有资源「${normalized}」`)
        }
      }
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
  if (entry.clone) {
    const clone: Record<string, unknown> = {
      samples: [...entry.clone.samples],
      consent: entry.clone.consent,
    }
    for (const [key, value] of Object.entries(entry.clone.extra)) clone[key] = value
    out.clone = clone
  } else if (entry.voice !== undefined) {
    out.voice = entry.voice
  }
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
 * 第①级：工程里有哪些角色方案。
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
