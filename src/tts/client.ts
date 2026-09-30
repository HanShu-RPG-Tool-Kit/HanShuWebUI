/**
 * 一次合成 —— 把"服务定义 + 一条语言 + 传输 + 凭据"串起来。
 *
 * 它只做三件事:**切分文本、逐块走适配器、把音频按顺序拼回去**。
 * 它**不做**落盘(那是 `runVoiceImport` 的活)、不做克隆(那是克隆端点 + `cloneRegistry`
 * 的活)、不认识界面、不碰工程文件。
 *
 * 长文本在这里切好、按顺序发、按顺序拼。顺序不能乱 —— 乱一次,旁白就会跳。
 */

import { PROTOCOLS, type TtsFailure } from './spec'
import type { ResolvedService } from './service'
import { ADAPTERS, type AdapterInput, type AudioFormat, type TtsRequest } from './protocols'
import { splitTextForSynthesis } from './textSplit'
import {
  TtsTransportError,
  concatBytes,
  type TtsHttpResponse,
  type TtsTransport,
} from './transport'
import type { VoicePlan } from './plan'

export { concatBytes as concatAudio }

export type SynthesizeContext = {
  transport: TtsTransport
  credential: (ref: string) => string | null
  /** 进度：`ratio` 是 0–1,`chunk` 说明这是第几块(共几块) */
  onProgress?: (ratio: number, chunk: { index: number; total: number }) => void
  signal?: AbortSignal
  format?: AudioFormat
}

export type SynthesizeResult =
  | { ok: true; audio: Uint8Array; chunks: number; contentType: string | null }
  | { ok: false; failure: TtsFailure }

export type SynthesizeInput = {
  service: ResolvedService
  text: string
  /** 音色 id。预置音色直接给;克隆音色要先用登记表查出来 */
  voice: string
  language?: string
  speed?: number
}

/**
 * 合成一段文本。
 *
 * **整段全部成功才算成功。** 中途某一块失败就整体失败,不返回半截音频 ——
 * 半截配音比没有配音更难发现,它会安安静静地进到资产里。
 */
export async function synthesize(
  input: SynthesizeInput,
  context: SynthesizeContext,
): Promise<SynthesizeResult> {
  const { service } = input
  if (!service.protocol) {
    return {
      ok: false,
      failure: {
        kind: 'config',
        message: `服务「${service.id}」没有可用的协议`,
        hint: '到服务编辑器里选一个供应商，或给 template 档指定协议',
      },
    }
  }

  const adapter = ADAPTERS[service.protocol]
  const limit = PROTOCOLS[service.protocol].requestCharLimit
  const chunks = splitTextForSynthesis(input.text, limit)
  if (chunks.length === 0) {
    return {
      ok: false,
      failure: { kind: 'config', message: '没有要合成的文本' },
    }
  }

  const request: Omit<TtsRequest, 'text'> = {
    voice: input.voice,
    language: input.language,
    speed: input.speed,
  }

  const parts: Uint8Array[] = []
  let contentType: string | null = null

  for (const [index, chunk] of chunks.entries()) {
    if (context.signal?.aborted) {
      return { ok: false, failure: { kind: 'transport', message: '合成已取消' } }
    }

    const adapterInput: AdapterInput = {
      service,
      request: { ...request, text: chunk.text },
      credential: context.credential,
      format: context.format,
    }

    const built = adapter(adapterInput)
    if (!built.ok) return { ok: false, failure: built.failure }

    let response: TtsHttpResponse
    try {
      response = await context.transport({ ...built.http, signal: context.signal })
    } catch (error) {
      // 传输失败与"厂商拒绝"在这里分开 —— 两者的下一步完全不同
      if (error instanceof TtsTransportError) {
        return {
          ok: false,
          failure: { kind: 'transport', message: error.message, hint: error.hint },
        }
      }
      return {
        ok: false,
        failure: {
          kind: 'transport',
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }

    const parsed = built.parse(response)
    if (!parsed.ok) return { ok: false, failure: parsed.failure }

    parts.push(parsed.audio)
    contentType = contentType ?? response.contentType
    context.onProgress?.((index + 1) / chunks.length, {
      index: index + 1,
      total: chunks.length,
    })
  }

  return { ok: true, audio: concatBytes(parts), chunks: chunks.length, contentType }
}

// ===== 从一份 `.tts` 的一条语言出发 =====

export type PlanSynthesizeContext = SynthesizeContext & {
  /** 查克隆音色的登记表；返回 null 表示还没登记过 */
  lookupClonedVoice?: (input: {
    serviceId: string
    samples: readonly string[]
  }) => Promise<string | null> | string | null
}

/**
 * 按 `.tts` 的一条语言合成 —— 录音棚真正调的就是这个。
 *
 * 规范 §7.4 的两级门禁在这一层体现:没配的语言、找不到的服务、还没登记的克隆,
 * 都给出**分类明确的失败**,而不是一句"生成失败"。
 */
export async function synthesizePlanLocale(
  input: {
    plan: VoicePlan
    locale: string
    text: string
    services: ReadonlyMap<string, ResolvedService>
  },
  context: PlanSynthesizeContext,
): Promise<SynthesizeResult> {
  const entry = input.plan.voices[input.locale]
  if (!entry) {
    return {
      ok: false,
      failure: {
        kind: 'config',
        message: `这份配音方案没有配「${input.locale}」`,
        hint: '到角色编辑器里加一条语言',
      },
    }
  }

  const service = input.services.get(entry.service)
  if (!service) {
    return {
      ok: false,
      failure: {
        kind: 'config',
        message: `找不到服务「${entry.service}」`,
        hint: '这个工程缺它的服务定义文件',
      },
    }
  }

  let voice = entry.voice ?? ''
  if (entry.clone) {
    const resolved = context.lookupClonedVoice
      ? await context.lookupClonedVoice({
          serviceId: service.id,
          samples: entry.clone.samples,
        })
      : null
    if (!resolved) {
      return {
        ok: false,
        failure: {
          kind: 'clone-required',
          message: `「${input.locale}」用的是克隆音色，但还没有登记`,
          hint: `先拿 ${entry.clone.samples.length} 个样本做一次克隆`,
        },
      }
    }
    voice = resolved
  }

  return synthesize(
    {
      service,
      text: input.text,
      voice,
      language: input.locale,
      speed: entry.speed,
    },
    context,
  )
}
