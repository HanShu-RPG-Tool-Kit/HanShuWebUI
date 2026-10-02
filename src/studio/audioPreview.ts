import { computePeaks } from '../i18n/voiceRuntime'

/**
 * 录音棚的音频小工具：**内存字节的解码**与**麦克风录音**。
 *
 * 两件事刻意放在一个文件里，因为它们共享同一个前提：
 * 录制回来的东西在成为配音之前**只是一段内存字节**（没有资产路径、不在 assets 里），
 * 所以既不能走 `voiceLibrary.inspect`，也不能走资产树 —— 只能就地解码、就地试听。
 *
 * 真正把它变成配音的那一步（转成单通道 Vorbis ogg + 写入对等文件）仍然复用语料库里
 * 那条固定工作流（`runVoiceImport`），这里不重复实现。
 */

export type MemoryAudioInfo = {
  /** 秒 */
  duration: number
  channels: number
  sampleRate: number
  /** 归一化峰值，用于画形状 */
  peaks: number[]
}

/**
 * 解码用的离线上下文（**单例**）。
 *
 * 只为 `decodeAudioData` 服务 —— 它要一个 BaseAudioContext，但这里不需要输出声音，
 * 所以不建 AudioContext（那个会占用音频输出、还可能被自动播放策略卡住）。
 */
let decodeCtx: OfflineAudioContext | null = null

function ensureDecodeContext(): OfflineAudioContext | null {
  if (decodeCtx) return decodeCtx
  if (typeof OfflineAudioContext === 'undefined') return null
  try {
    decodeCtx = new OfflineAudioContext(1, 1, 44100)
  } catch {
    decodeCtx = null
  }
  return decodeCtx
}

/**
 * 把内存里的音频字节解码成「时长 / 声道 / 采样率 / 波形」。
 * 解不开（平台不认这个容器）返回 null —— 调用方按"无法预览"处理，不抛错。
 */
export async function decodeMemoryAudio(
  bytes: Uint8Array,
): Promise<MemoryAudioInfo | null> {
  const ctx = ensureDecodeContext()
  if (!ctx) return null
  try {
    // decodeAudioData 会把传入的 ArrayBuffer detach 掉：给副本，别弄坏调用方的字节
    const copy = bytes.slice()
    const buffer = await ctx.decodeAudioData(copy.buffer as ArrayBuffer)
    return {
      duration: buffer.duration,
      channels: buffer.numberOfChannels,
      sampleRate: buffer.sampleRate,
      peaks: computePeaks(buffer),
    }
  } catch (error) {
    console.warn('[hanshu] 录音结果解码失败', error)
    return null
  }
}

/** 录音结果：内存字节 + 由容器类型推出来的文件名（名字只影响 MIME 推断与提示） */
export type RecordingTake = {
  name: string
  bytes: Uint8Array
  mime: string
}

export type VoiceRecorder = {
  /** 停止并拿到结果（没有录到任何数据时返回 null） */
  stop(): Promise<RecordingTake | null>
  /** 放弃这次录音（丢弃数据） */
  cancel(): void
  /** 实时电平（0..1，RMS），用于"正在收音"的反馈 */
  level(): number
  /** 已录时长（秒，按墙钟算） */
  elapsed(): number
}

/**
 * MediaRecorder 支持的容器偏好：**优先 webm/opus**（Chromium / WebView2 必支持），
 * 退到 ogg/opus。反正真正的落地产物是对等位置上的单通道 Vorbis ogg，
 * 这里录到什么都会被导入工作流转码，所以只求"浏览器一定认"。
 */
const RECORDER_TYPES: Array<{ mime: string; ext: string }> = [
  { mime: 'audio/webm;codecs=opus', ext: 'webm' },
  { mime: 'audio/webm', ext: 'webm' },
  { mime: 'audio/ogg;codecs=opus', ext: 'ogg' },
  { mime: 'audio/ogg', ext: 'ogg' },
]

function pickRecorderType(): { mime: string; ext: string } | null {
  if (typeof MediaRecorder === 'undefined') return null
  for (const candidate of RECORDER_TYPES) {
    if (MediaRecorder.isTypeSupported?.(candidate.mime)) return candidate
  }
  return null
}

/** 当前环境能不能录音（有没有 MediaRecorder + getUserMedia） */
export function canRecordAudio(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  )
}

/**
 * 开始录音。**权限被拒 / 没有麦克风 / 平台不支持**都会抛错，
 * 由界面把 `message` 原样显示给用户（那是唯一能解释"为什么按了没反应"的东西）。
 */
export async function startVoiceRecording(): Promise<VoiceRecorder> {
  if (!canRecordAudio()) {
    throw new Error('当前环境不支持录音（没有 MediaRecorder / 麦克风接口）')
  }
  const picked = pickRecorderType()
  if (!picked) throw new Error('当前环境没有可用的录音容器（webm / ogg）')

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    },
  })

  const chunks: BlobPart[] = []
  let recorder: MediaRecorder
  try {
    recorder = new MediaRecorder(stream, { mimeType: picked.mime })
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop())
    throw new Error(
      `无法开始录音：${error instanceof Error ? error.message : String(error)}`,
    )
  }

  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data)
  }
  // 每 200ms 收一小块：中途出错也不会整段丢
  recorder.start(200)

  // 电平表：只用于界面反馈，取 RMS 足够
  const audioCtx =
    typeof AudioContext !== 'undefined' ? new AudioContext() : null
  const analyser = audioCtx?.createAnalyser() ?? null
  if (audioCtx && analyser) {
    analyser.fftSize = 1024
    try {
      audioCtx.createMediaStreamSource(stream).connect(analyser)
    } catch {
      /* 只是没有电平反馈，不影响录音 */
    }
  }
  const levelBuffer = analyser ? new Float32Array(analyser.fftSize) : null
  const startedAt = Date.now()

  const teardown = () => {
    stream.getTracks().forEach((track) => track.stop())
    if (audioCtx) void audioCtx.close().catch(() => undefined)
  }

  const waitStopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
  })

  let finished = false

  return {
    async stop(): Promise<RecordingTake | null> {
      if (finished) return null
      finished = true
      try {
        if (recorder.state !== 'inactive') {
          recorder.stop()
          await waitStopped
        }
      } finally {
        teardown()
      }
      // ondataavailable 是异步派发的，等事件循环走一圈再收
      await new Promise((resolve) => window.setTimeout(resolve, 0))
      if (chunks.length === 0) return null
      const blob = new Blob(chunks, { type: picked.mime })
      const bytes = new Uint8Array(await blob.arrayBuffer())
      if (bytes.byteLength === 0) return null
      return { name: `录音.${picked.ext}`, bytes, mime: picked.mime }
    },

    cancel() {
      if (finished) return
      finished = true
      try {
        if (recorder.state !== 'inactive') recorder.stop()
      } catch {
        /* 忽略 */
      }
      chunks.length = 0
      teardown()
    },

    level() {
      if (!analyser || !levelBuffer) return 0
      analyser.getFloatTimeDomainData(levelBuffer)
      let sum = 0
      for (let i = 0; i < levelBuffer.length; i += 1) {
        sum += levelBuffer[i] * levelBuffer[i]
      }
      const rms = Math.sqrt(sum / levelBuffer.length)
      // 人声 RMS 大概在 0.02..0.3，映射到 0..1 好显示
      return Math.max(0, Math.min(1, rms * 4))
    },

    elapsed() {
      return (Date.now() - startedAt) / 1000
    },
  }
}
