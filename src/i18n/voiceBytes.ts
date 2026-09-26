/**
 * Ogg 字节层面的纯解析（不依赖任何解码器，node / 浏览器都能跑）。
 *
 * 用途：
 * - 导入前判断「源是不是已经是本工作流产出的那种文件」（单声道 Vorbis ogg）
 * - 播放/状态判定时确认容器与编解码器（解码成功 ≠ 是 Vorbis：单声道 Opus 也解得开）
 *
 * 约定来自项目自带的占位 ogg：`OggS` + `\x01vorbis` + channels=1 + sampleRate=44100。
 */

export type VoiceOggInfo = {
  /** 是不是 Ogg 容器（看 `OggS` 魔数） */
  ogg: boolean
  /** 第一页里认出来的编解码器 */
  codec: 'vorbis' | 'opus' | 'other' | null
  /** 声道数（从标识头读，不解码） */
  channels: number | null
  /** 采样率（从标识头读） */
  sampleRate: number | null
}

const OGG_MAGIC = [0x4f, 0x67, 0x67, 0x53] // 'OggS'
const VORBIS_MAGIC = [0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73] // '\x01vorbis'
const OPUS_MAGIC = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64] // 'OpusHead'

function indexOfBytes(haystack: Uint8Array, needle: number[], from = 0): number {
  const limit = haystack.length - needle.length
  for (let i = Math.max(0, from); i <= limit; i++) {
    let hit = true
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        hit = false
        break
      }
    }
    if (hit) return i
  }
  return -1
}

const readU32LE = (bytes: Uint8Array, at: number): number | null =>
  at + 4 <= bytes.length
    ? bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)
    : null

/**
 * Vorbis 标识头：`\x01vorbis` + version(4) + channels(1) + sampleRate(4)
 * Opus 标识头：`OpusHead` + version(1) + channels(1) + preSkip(2) + inputSampleRate(4)
 */
export function inspectOggBytes(bytes: Uint8Array): VoiceOggInfo {
  const empty: VoiceOggInfo = {
    ogg: false,
    codec: null,
    channels: null,
    sampleRate: null,
  }
  if (bytes.length < 4 || indexOfBytes(bytes, OGG_MAGIC) !== 0) return empty

  const vorbis = indexOfBytes(bytes, VORBIS_MAGIC)
  if (vorbis >= 0) {
    const channels = vorbis + 11 < bytes.length ? bytes[vorbis + 11] : null
    return {
      ogg: true,
      codec: 'vorbis',
      channels,
      sampleRate: readU32LE(bytes, vorbis + 12),
    }
  }

  const opus = indexOfBytes(bytes, OPUS_MAGIC)
  if (opus >= 0) {
    const channels = opus + 9 < bytes.length ? bytes[opus + 9] : null
    return {
      ogg: true,
      codec: 'opus',
      channels,
      sampleRate: readU32LE(bytes, opus + 12),
    }
  }

  return { ogg: true, codec: 'other', channels: null, sampleRate: null }
}

/** 是否已经是「本工作流产出的那种文件」：单声道 Vorbis 的 ogg */
export function isMonoVorbisOgg(bytes: Uint8Array): boolean {
  const info = inspectOggBytes(bytes)
  return info.ogg && info.codec === 'vorbis' && info.channels === 1
}

/** 把探测结果说成人话，给失败提示 / 状态原因用 */
export function describeVoiceFormat(info: VoiceOggInfo): string {
  if (!info.ogg) return '不是 ogg 容器'
  if (info.codec === 'opus') return 'ogg 里装的是 Opus，按约定需要 Vorbis'
  if (info.codec === 'other') return 'ogg 里不是 Vorbis / Opus'
  const channels = info.channels ?? '未知'
  return `Vorbis，但声道数是 ${channels}（需要单通道）`
}
