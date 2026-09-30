/**
 * 音色来源 —— **克隆在厂商控制台做**，这里只负责「列出能选的」与「验证填的」。
 *
 * 实测结论（2026-09-30，真实账号）：
 * - **ElevenLabs `GET /v1/voices`** 列出账号下全部音色（预置 + Voice Design + IVC 克隆），
 *   控制台建的也在 —— 可以做下拉。**受限 key 可能没开 `voices_read`**（报错体里
 *   写明 `missing the permission voices_read`），拉取失败退回手填。
 * - **MiniMax `POST /v1/get_voice`** 能列 `voice_cloning`，但控制台「音色库」里建的音色
 *   **不在列表里**（用过一次也不出现）—— 列不全的下拉比没有更害人。
 *   好在 T2A 对不存在的 id 报 `2054 voice id not exist`（实测：不存在的 id 明确报错，
 *   不会静默回退），所以 MiniMax 走「手填 + 验证音色」。
 */

import { isPlainObject, type ProtocolId, type TtsFailure } from './spec'
import type { ResolvedService } from './service'
import { describeHttpFailure, requireApiKey, requireBaseUrl } from './protocols'
import { synthesize, type SynthesizeResult } from './client'
import {
  decodeJson,
  joinUrl,
  type TtsHttpResponse,
  type TtsTransport,
} from './transport'

export type VoiceInfo = {
  id: string
  /** 显示名；厂商没给名字时退回 id */
  name: string
  /** 厂商分类（`premade` / `generated` / `cloned` …），仅展示用 */
  category?: string
}

export type ListVoicesResult =
  | { ok: true; voices: VoiceInfo[] }
  | { ok: false; failure: TtsFailure }

export type VoicesContext = {
  transport: TtsTransport
  credential: (ref: string) => string | null
  signal?: AbortSignal
}

/** 这个协议能不能拉音色列表。**不能的退回「手填 + 验证」，不是错误 */
export function canListVoices(protocol: ProtocolId | null): boolean {
  return protocol === 'elevenlabs'
}

/**
 * 拉取服务账号下的音色列表。只有 ElevenLabs 有可靠的全量列表（见模块头注释）；
 * 其他协议返回 `unsupported` —— 调用方据此收掉下拉、只留手填。
 */
export async function listVoices(
  service: ResolvedService,
  context: VoicesContext,
): Promise<ListVoicesResult> {
  if (!service.protocol) {
    return {
      ok: false,
      failure: { kind: 'config', message: `服务「${service.id}」没有可用的协议` },
    }
  }
  if (!canListVoices(service.protocol)) {
    return {
      ok: false,
      failure: {
        kind: 'unsupported',
        message: `协议「${service.protocol}」没有可靠的音色列表接口`,
        hint: '手填音色 id，然后点「验证」确认它在你的账号里',
      },
    }
  }

  const baseUrl = requireBaseUrl(service)
  if (!baseUrl.ok) return baseUrl
  const apiKey = requireApiKey({ service, credential: context.credential })
  if (!apiKey.ok) return apiKey

  let response: TtsHttpResponse
  try {
    response = await context.transport({
      url: joinUrl(baseUrl.value, '/v1/voices'),
      method: 'GET',
      headers: { 'xi-api-key': apiKey.value },
      body: '',
      signal: context.signal,
    })
  } catch (error) {
    return {
      ok: false,
      failure: {
        kind: 'transport',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }

  if (!response.ok) {
    return {
      ok: false,
      failure: { kind: 'http', message: describeHttpFailure('ElevenLabs', response) },
    }
  }

  const payload = decodeJson(response.bytes)
  if (!isPlainObject(payload) || !Array.isArray(payload.voices)) {
    return { ok: false, failure: { kind: 'decode', message: 'ElevenLabs 没有返回音色列表' } }
  }

  const voices: VoiceInfo[] = []
  for (const item of payload.voices) {
    if (!isPlainObject(item) || typeof item.voice_id !== 'string' || !item.voice_id) continue
    voices.push({
      id: item.voice_id,
      name: typeof item.name === 'string' && item.name.trim() ? item.name : item.voice_id,
      category: typeof item.category === 'string' ? item.category : undefined,
    })
  }
  return { ok: true, voices }
}

/**
 * 验证一个音色 id 在账号里是否真的存在 —— 用**最短的一段文本**试合成。
 *
 * 这是 MiniMax 唯一可靠的判据（`2054 voice id not exist`，实测无静默回退）；
 * 对其他协议也通用：合成不了的理由（音色不存在 / 额度不足 / 模型不对）都会
 * 原样带回来，用户看到的就是下一步。
 *
 * **有成本**：按字符计一次合成（两个字符）。调用方要把这一点写进确认文案。
 */
export async function probeVoice(
  service: ResolvedService,
  voice: string,
  context: VoicesContext,
): Promise<SynthesizeResult> {
  return synthesize(
    { service, text: '你好', voice },
    { transport: context.transport, credential: context.credential, signal: context.signal },
  )
}
