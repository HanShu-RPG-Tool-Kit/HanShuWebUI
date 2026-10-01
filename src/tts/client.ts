/**
 * 一次合成 —— 把"服务定义 + 一条语言 + 传输 + 凭据"串起来。
 *
 * 它只做三件事:**切分文本、逐块走适配器、把音频按顺序拼回去**。
 * 它**不做**落盘(那是 `runVoiceImport` 的活)、不认识界面、不碰工程文件。
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
  /** 音色 id —— 厂商账号下的那个；克隆音色也是 id（克隆在厂商控制台做） */
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
        hint: '在服务设置页里选供应商，或给 template 档指定协议',
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

/**
 * 按 `.tts` 的一条语言合成 —— 录音棚真正调的就是这个。
 *
 * 规范 §7.4 的两级门禁在这一层体现:没配的语言、找不到的服务、没填的音色 id,
 * 都给出**分类明确的失败**,而不是一句"生成失败"。
 */
export async function synthesizePlanLocale(
  input: {
    plan: VoicePlan
    locale: string
    text: string
    services: ReadonlyMap<string, ResolvedService>
  },
  context: SynthesizeContext,
): Promise<SynthesizeResult> {
  const entry = input.plan.voices[input.locale]
  if (!entry) {
    return {
      ok: false,
      failure: {
        kind: 'config',
        message: `这份配音方案没有配「${input.locale}」`,
        hint: '在这份方案的设置页里加一条语言',
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

  if (!entry.voice?.trim()) {
    return {
      ok: false,
      failure: {
        kind: 'config',
        message: `「${input.locale}」还没有配音色`,
        hint: '在编辑器里打开这个配音方案（.tts 文件），为这一条选/填一个音色 id',
      },
    }
  }

  return synthesize(
    {
      service,
      text: input.text,
      voice: entry.voice,
      language: input.locale,
      speed: entry.speed,
    },
    context,
  )
}
