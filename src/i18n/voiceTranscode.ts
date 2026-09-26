import oggEncode from '@audio/encode-ogg'
import type { VoiceImportProcessor, VoiceSourceInfo } from './voiceImport'
import { describeVoiceFormat, inspectOggBytes, isMonoVorbisOgg } from './voiceBytes'

/**
 * 配音转码：常见音频 → **单声道 Ogg Vorbis @ 44100**。
 *
 * 具体分工（刻意不依赖 ffmpeg，保证项目 MIT 不受 copyleft 影响）：
 * - **解码**：平台的 Web Audio（`decodeAudioData`）。常见 wav / mp3 / ogg / flac / m4a / aac
 *   都能解；它是运行环境（浏览器 / WebView2）自带的能力，不是本项目分发的组件。
 * - **编码**：`@audio/encode-ogg`（MIT 包装 + libvorbis(BSD-3) 的 WASM）→ Ogg Vorbis。
 *
 * 目标格式对齐项目既有约定：占位 ogg（`src/hanshu/blankVoiceOgg.ts`）解析出来是
 * 「OggS + \x01vorbis + channels=1 + sampleRate=44100」，即**单声道 Vorbis @ 44.1kHz**。
 *
 * 平台解码能力的口径（Chromium `media/base/mime_util_internal.cc`）：
 * - `audio/wav`→PCM、`audio/mpeg|mp3`→MP3、`audio/ogg`→FLAC/OPUS/VORBIS、
 *   `audio/flac`→FLAC、`audio/webm`→OPUS/VORBIS、`audio/mp4`→FLAC/MP3/OPUS(+AAC)、
 *   `audio/aac`/`audio/x-m4a`→AAC（需要构建启用 proprietary codecs；Edge/WebView2 有）
 * - WebView2 额外确认可播：mp3 / wav / flac / aac / m4a / ogg / opus
 * - 平台解不了的（wma / ape / amr / aiff / midi、mkv/avi 容器等）会走失败分支，
 *   由界面给出明确原因
 *
 * 另一个有用的语义（MDN）：`decodeAudioData` 会把结果**重采样到上下文的采样率** ——
 * 所以在 44100 的上下文里解码得到的 PCM 已经是 44100，只有多声道才需要再混单声道。
 *
 * 字节层面的容器/编解码器判定在 `voiceBytes.ts`（纯解析，不解码）。
 */

/** 目标采样率：与占位 ogg 一致 */
export const VOICE_TARGET_SAMPLE_RATE = 44100

/** Vorbis VBR 质量（-1..10）：人声 4 足够，体积小 */
export const VOICE_TARGET_QUALITY = 4

/**
 * 平台（WebView2 / Chromium）能解码的音频后缀。
 * 只用于界面的**预检提示**，真正的判定永远以解码结果为准。
 */
export const PLATFORM_DECODABLE_AUDIO_EXTENSIONS = [
  'wav',
  'mp3',
  'ogg',
  'oga',
  'opus',
  'flac',
  'm4a',
  'mp4',
  'aac',
  'weba',
  'webm',
] as const

/** 该文件后缀是否在平台可解码的白名单里（不保证一定解得出，只保证值得一试） */
export function canPlatformDecodeAudio(path: string): boolean {
  const ext = /\.([a-z0-9]+)$/i.exec(path.trim())?.[1]?.toLowerCase() ?? ''
  if (!ext) return false
  return (PLATFORM_DECODABLE_AUDIO_EXTENSIONS as readonly string[]).includes(ext)
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const chunk of chunks) total += chunk.byteLength
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out
}

/** 报错类型：中断与普通失败区分开，工作流据此给 `interrupted` */
export class VoiceTranscodeAbort extends Error {
  constructor() {
    super('转码已中断')
    this.name = 'VoiceTranscodeAbort'
  }
}

/**
 * PCM → Ogg Vorbis（**纯编码**，可在 node 里直接测）。
 * 分块喂进去以便上报进度；任何一段出错都会 `free()` 掉 wasm 实例。
 */
export async function encodePcmToVorbis(
  channels: Float32Array[],
  sampleRate: number,
  options: {
    quality?: number
    onProgress?(ratio: number): void
    signal?: { aborted: boolean }
  } = {},
): Promise<Uint8Array> {
  const frames = channels[0]?.length ?? 0
  const encoder = await oggEncode({
    sampleRate,
    channels: Math.max(1, channels.length),
    quality: options.quality ?? VOICE_TARGET_QUALITY,
  })

  const chunks: Uint8Array[] = []
  // 一秒一块：既够细地上报进度，也不会把 wasm 调用切得太碎
  const block = Math.max(1, Math.floor(sampleRate))
  try {
    for (let offset = 0; offset < frames; offset += block) {
      if (options.signal?.aborted) throw new VoiceTranscodeAbort()
      const end = Math.min(frames, offset + block)
      const slice = channels.map((data) => data.subarray(offset, end))
      const chunk = encoder.encode(slice)
      if (chunk && chunk.byteLength > 0) chunks.push(chunk)
      options.onProgress?.(frames > 0 ? end / frames : 1)
    }
    const tail = encoder.flush()
    if (tail && tail.byteLength > 0) chunks.push(tail)
  } finally {
    encoder.free()
  }
  options.onProgress?.(1)
  return concatBytes(chunks)
}

type OfflineCtor = new (
  numberOfChannels: number,
  length: number,
  sampleRate: number,
) => OfflineAudioContext

function offlineCtor(): OfflineCtor | null {
  const scope = globalThis as unknown as {
    OfflineAudioContext?: OfflineCtor
    webkitOfflineAudioContext?: OfflineCtor
  }
  return scope.OfflineAudioContext ?? scope.webkitOfflineAudioContext ?? null
}

/**
 * 常见音频字节 → 单声道 44100 Ogg Vorbis。
 * 解码用平台 Web Audio；源本来就是「单声道 + 目标采样率」时跳过重采样那一趟。
 */
export async function transcodeToMonoVorbis(
  bytes: Uint8Array,
  onProgress: (ratio: number) => void,
  signal: { aborted: boolean } = { aborted: false },
): Promise<Uint8Array> {
  const Offline = offlineCtor()
  if (!Offline) throw new Error('当前环境没有 Web Audio，无法解码源音频')

  const decodeCtx = new Offline(1, 1, VOICE_TARGET_SAMPLE_RATE)
  let decoded: AudioBuffer
  try {
    // decodeAudioData 会 detach 传入的 ArrayBuffer：给副本
    decoded = await decodeCtx.decodeAudioData(bytes.slice().buffer as ArrayBuffer)
  } catch (error) {
    throw new Error(
      `源音频解码失败（${error instanceof Error ? error.message : String(error)}）`,
    )
  }
  onProgress(0.2)
  if (signal.aborted) throw new VoiceTranscodeAbort()

  let mono: Float32Array
  if (
    decoded.numberOfChannels === 1 &&
    decoded.sampleRate === VOICE_TARGET_SAMPLE_RATE
  ) {
    mono = decoded.getChannelData(0)
  } else {
    // 混单声道 + 重采样都交给离线渲染（浏览器自带高质量重采样）
    const frames = Math.max(
      1,
      Math.ceil(decoded.duration * VOICE_TARGET_SAMPLE_RATE),
    )
    const renderCtx = new Offline(1, frames, VOICE_TARGET_SAMPLE_RATE)
    const source = renderCtx.createBufferSource()
    source.buffer = decoded
    source.connect(renderCtx.destination)
    source.start()
    const rendered = await renderCtx.startRendering()
    mono = rendered.getChannelData(0)
  }
  onProgress(0.45)
  if (signal.aborted) throw new VoiceTranscodeAbort()

  return encodePcmToVorbis([mono], VOICE_TARGET_SAMPLE_RATE, {
    onProgress: (ratio) => onProgress(0.45 + ratio * 0.55),
    signal,
  })
}

/**
 * 导入工作流要的处理器：探测走纯字节解析，处理走「平台解码 + wasm 编码」。
 * 接入 `runVoiceImport` 即可，工作流本身不关心底层是哪个编码器。
 */
export function createVoiceProcessor(): VoiceImportProcessor {
  return {
    async inspect(bytes): Promise<VoiceSourceInfo> {
      const info = inspectOggBytes(bytes)
      const alreadyTarget = isMonoVorbisOgg(bytes)
      return {
        alreadyTarget,
        detail: alreadyTarget ? undefined : describeVoiceFormat(info),
      }
    },
    process: (bytes, onProgress, signal) =>
      transcodeToMonoVorbis(bytes, onProgress, signal),
  }
}
