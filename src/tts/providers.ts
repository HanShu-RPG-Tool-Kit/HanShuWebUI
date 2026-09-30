/**
 * `provider` 预设表 —— 纯数据，不是代码分支。
 *
 * 加一家供应商 = 加一条数据，不发版、不新写适配器（前提是它的协议已在枚举里）。
 * 而且**用户也能往表里加**：自建预设住应用级存储，与内置预设同权。
 */

import { isProtocolId, type ProtocolId } from './spec'

/** 不走预设、由用户自己选协议的那个档 —— 它不是预设条目，不在这张表里 */
export const TEMPLATE_PROVIDER_ID = 'template'

export type ProviderPreset = {
  /** 预设键，即 `.ttsservice` 里 `provider` 的值 */
  id: string
  /** 界面显示名 */
  label: string
  /** **固定**协议，不可覆盖 */
  protocol: ProtocolId
  /**
   * 默认端点。**留空表示这个预设没有默认端点**（Azure / Polly 按区域部署），
   * 此时 `.ttsservice` 必须自己填 `baseUrl`。
   */
  baseUrl?: string
  /** 默认模型 */
  model?: string
  /**
   * 该协议下语法合法的模型名候选。留空 = 不限定 ——
   * 厂商上新品快于应用发版，卡死候选只会让新模型用不了。
   */
  models?: readonly string[]
  /**
   * 音色来源。留空 = 走列表接口（ElevenLabs）或手填 + 验证（MiniMax），
   * 不做静态校验。给成固定枚举时（如 OpenAI）才校验 `voices.<k>.voice` 是否在枚举里。
   */
  voices?: readonly string[]
  /** 内置预设只读；用户自建的可增删 */
  builtin: boolean
}

/** 内置预设。按 `docs/tts-providers.md` §3.1 的代表模型取值 */
export const BUILTIN_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini-tts',
    models: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'],
    builtin: true,
  },
  {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    protocol: 'elevenlabs',
    baseUrl: 'https://api.elevenlabs.io',
    model: 'eleven_multilingual_v2',
    models: ['eleven_v3', 'eleven_multilingual_v2', 'eleven_turbo_v2_5'],
    builtin: true,
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    protocol: 'minimax',
    baseUrl: 'https://api.minimax.io/v1',
    model: 'speech-2.8-hd',
    models: ['speech-2.8-hd', 'speech-2.8-turbo'],
    builtin: true,
  },
  {
    id: 'azure',
    label: 'Azure Speech',
    protocol: 'azure',
    // 按区域部署，没有通用默认端点 —— `baseUrl` 必须由服务自己填
    builtin: true,
  },
  {
    id: 'google',
    label: 'Google Cloud TTS',
    protocol: 'google',
    baseUrl: 'https://texttospeech.googleapis.com',
    builtin: true,
  },
  {
    id: 'polly',
    label: 'Amazon Polly',
    protocol: 'polly',
    builtin: true,
  },
  {
    id: 'groq',
    label: 'Groq',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    builtin: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    builtin: true,
  },
]

/**
 * 合并内置预设与用户自建预设。
 *
 * **重名时保留内置、丢弃用户那条** —— 规范不设"谁覆盖谁"的优先级。
 * 丢掉的那条由 `rejected` 带出来，编辑器据此提示用户改名，而不是让它静默失效。
 */
export function resolvePresets(userPresets: readonly ProviderPreset[] = []): {
  presets: ProviderPreset[]
  /** 因与内置重名被丢弃的用户预设 id */
  rejected: string[]
} {
  const byId = new Map<string, ProviderPreset>()
  for (const preset of BUILTIN_PRESETS) byId.set(preset.id, preset)

  const rejected: string[] = []
  for (const preset of userPresets) {
    if (!preset.id || byId.has(preset.id)) {
      rejected.push(preset.id)
      continue
    }
    byId.set(preset.id, { ...preset, builtin: false })
  }

  return { presets: [...byId.values()], rejected }
}

export function findPreset(
  presets: readonly ProviderPreset[],
  id: string,
): ProviderPreset | null {
  return presets.find((preset) => preset.id === id) ?? null
}

/**
 * 宽松读取应用级存储里的用户预设 —— 一条坏数据不该让整个列表打不开。
 *
 * 读不出必要字段（id / protocol）的条目直接跳过；这里不报错，报错是编辑器的事，
 * 存储层只负责"能读多少读多少"。
 */
export function parseUserPresets(raw: unknown): ProviderPreset[] {
  if (!Array.isArray(raw)) return []
  const out: ProviderPreset[] = []

  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const source = item as Record<string, unknown>
    const id = typeof source.id === 'string' ? source.id.trim() : ''
    if (!id || !isProtocolId(source.protocol)) continue

    out.push({
      id,
      label: typeof source.label === 'string' && source.label.trim() ? source.label : id,
      protocol: source.protocol,
      baseUrl: typeof source.baseUrl === 'string' ? source.baseUrl : undefined,
      model: typeof source.model === 'string' ? source.model : undefined,
      models: Array.isArray(source.models)
        ? source.models.filter((m): m is string => typeof m === 'string')
        : undefined,
      builtin: false,
    })
  }

  return out
}
