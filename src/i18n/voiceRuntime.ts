import { isVoiceOggPath, voiceAssetExtension } from './voicePaths'
import { inspectOggBytes, type VoiceOggInfo } from './voiceBytes'

/**
 * 音频解码缓存 + 单流播放器（「音频缓存流」）。
 *
 * - **单流**：同一时刻只加载/播放一个音频。点另一个直接替换 —— 旧的先停、
 *   释放 objectURL，再挂新的；并用自增令牌挡掉慢读取导致的乱序覆盖。
 * - **解码**负责三件事：判定合法性（能不能解开）、取元信息（时长 / 声道 / 采样率）、
 *   算波形峰值（画音频形状）。结果按「路径 + 内容版本」缓存。
 * - **播放态权威在本模块**：`isPlaying(path)` 只回答「正在播放的是不是这条资产」，
 *   按钮/菜单不自己猜状态。
 * - 合法配音只收**单通道 ogg**：非 ogg 直接判不合法（不需要解码），
 *   声道数要解码后才知道。
 */

export type VoiceAudioInfo = {
  path: string
  /** 秒 */
  duration: number
  /** 声道数：1 单声道 / 2 立体声 / 其它按数值 */
  channels: number
  sampleRate: number
  /**
   * 容器里认出来的编解码器（字节嗅探，非解码推断）：
   * 非 ogg 为 null；ogg 里可能是 vorbis / opus / other。
   * 判「可用」必须同时看它 —— 单声道 Opus 也解得开，但不符合项目约定。
   */
  codec: VoiceOggInfo['codec']
  /** 归一化峰值（0..1），长度固定，用于画波形 */
  peaks: number[]
}

export type VoiceDecodeResult =
  | { ok: true; info: VoiceAudioInfo }
  | { ok: false; reason: string }

/** 资产取用接口：由 ScriptWorkspace 注入（IndexedDB blob / 资产清单） */
export type VoiceSource = {
  /** 同步判断资产在不在清单里，并给出内容版本（用于缓存失效）；不在返回 null */
  stat(path: string): { revision: string } | null
  /** 异步取二进制 */
  read(path: string): Promise<Blob | null>
}

export type VoicePlayback = { path: string; key: string | null }

/**
 * 解码用途（结果不同，所以缓存键里也要带它）：
 *
 * - `asset`：校验**磁盘上的成品配音**。按引擎约定必须是单通道 Vorbis ogg，
 *   非 ogg 连解都不解、直接按后缀判死（省一次读盘 + 解码）。
 * - `source`：选择器里把某个文件当**源**看。任何平台能解的格式（wav / mp3 / flac /
 *   m4a …）都照解，用来画波形、报时长与声道；不设"单通道"限制，因为导入时会
 *   统一下混并转码成单通道 Vorbis。
 *
 * 之前只有 `asset` 一种口径，选择器复用它，于是 wav 这种完全能解的源也被判成
 * "解码失败"（其实是后缀规则挡下的，根本没调用 decodeAudioData）。
 */
export type VoiceDecodeMode = 'asset' | 'source'

export type VoiceRuntime = {
  /** 缓存里已有的解码结果（同步；没解过返回 null） */
  peek(path: string, mode?: VoiceDecodeMode): VoiceDecodeResult | null
  /** 解码（带缓存与并发合并） */
  decode(path: string, mode?: VoiceDecodeMode): Promise<VoiceDecodeResult>
  /** 当前播放的资产（没有在播返回 null） */
  getPlayback(): VoicePlayback | null
  /** 「正在播放的就是这条资产」——按钮的播放态判据 */
  isPlaying(path: string): boolean
  /** 播放；同一时刻只有一个，换目标直接替换。返回是否真的开播 */
  play(path: string, key?: string | null): Promise<boolean>
  /**
   * 直接播一段**内存里**的音频（选择器里拖入但还没入库的文件）。
   * `id` 只作播放态标识（`isPlaying` 用它比对），`name` 用来按后缀补 MIME。
   */
  playBlob(id: string, name: string, blob: Blob): Promise<boolean>
  /** 停止并释放（回到无播放态） */
  stop(): void
  subscribe(listener: () => void): () => void
  dispose(): void
}

/** 波形峰值条数（够画形状，也不需要重新解码） */const WAVEFORM_BUCKETS = 96
/** 解码结果缓存上限（每条只有几百字节，主要防长期积累） */
const DECODE_CACHE_LIMIT = 64
/**
 * 同时最多解几路。首屏可能一次性问很多条的元信息（每条按钮都要判"无效"），
 * 串起来跑免得一口气解上百个文件把主线程占住。
 */
const MAX_DECODE_CONCURRENCY = 2

/**
 * 后缀 → 明确的音频 MIME。
 *
 * 为什么需要：`<audio>` 是按**资源声明的类型**选解复用器的，而资产库里的 blob
 * 可能是空类型、或 `application/octet-stream`（导入时 `file.type` 为空，
 * 或磁盘读回时按后缀猜不到 —— 例如 .m4a / .opus / .aac）。类型不对就拒播，
 * 表现就是"点了没反应"。这里按后缀补一个确定的类型。
 */
const AUDIO_MIME_BY_EXTENSION: Record<string, string> = {
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  webm: 'audio/webm',
}

/** 给 blob 补上按后缀推断的类型（认不出后缀就原样返回；slice 不复制字节） */
export function withAudioMime(blob: Blob, path: string): Blob {
  const dot = path.lastIndexOf('.')
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : ''
  const type = AUDIO_MIME_BY_EXTENSION[ext]
  if (!type || blob.type === type) return blob
  return blob.slice(0, blob.size, type)
}

/** 时长文案：`3.4s` / `1:02.5`（按十分位取整，避免 3.4-3=0.3999… 这种浮点坑） */
export function formatVoiceDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  const tenthsTotal = Math.round(seconds * 10)
  const total = Math.floor(tenthsTotal / 10)
  const tenths = tenthsTotal % 10
  if (total < 60) return `${total}.${tenths}s`
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${minutes}:${String(rest).padStart(2, '0')}.${tenths}`
}

/** 声道文案 */
export function formatVoiceChannels(channels: number): string {
  if (channels === 1) return '单通道'
  if (channels === 2) return '双通道'
  return `${channels} 通道`
}

/** 从解码后的 PCM 算波形峰值（最多混前两个声道，最后按最大值归一化） */
export function computePeaks(
  buffer: AudioBuffer,
  buckets = WAVEFORM_BUCKETS,
): number[] {
  const length = buffer.length
  const channelCount = Math.min(buffer.numberOfChannels, 2)
  if (length === 0 || channelCount === 0) {
    return new Array<number>(buckets).fill(0)
  }
  const data: Float32Array[] = []
  for (let c = 0; c < channelCount; c++) data.push(buffer.getChannelData(c))

  const step = Math.max(1, Math.floor(length / buckets))
  const peaks: number[] = []
  for (let b = 0; b < buckets; b++) {
    const from = b * step
    const to = Math.min(length, from + step)
    let max = 0
    for (let i = from; i < to; i++) {
      let sum = 0
      for (const channel of data) sum += Math.abs(channel[i])
      const value = sum / channelCount
      if (value > max) max = value
    }
    peaks.push(max)
  }
  const globalMax = peaks.reduce((m, v) => (v > m ? v : m), 0)
  return globalMax > 0 ? peaks.map((v) => v / globalMax) : peaks
}

export function createVoiceRuntime(source: VoiceSource): VoiceRuntime {
  const cache = new Map<string, VoiceDecodeResult>()
  const inFlight = new Map<string, Promise<VoiceDecodeResult>>()
  const listeners = new Set<() => void>()

  let ctx: AudioContext | null = null
  let audio: HTMLAudioElement | null = null
  let objectUrl: string | null = null
  let playback: VoicePlayback | null = null
  /** 解码并发闸门：正在解的路数 + 排队等槽位的任务 */
  let decoding = 0
  const decodeQueue: Array<() => void> = []
  /** 播放令牌：换目标 / 停止时自增，用来作废还在路上的异步步骤 */
  let token = 0
  /** 当前播放所属的令牌：`ended` / `error` 只认自己那一轮 */
  let playToken = -1
  let disposed = false

  const emit = () => {
    for (const listener of listeners) listener()
  }

  const cacheKeyOf = (path: string, mode: VoiceDecodeMode): string | null => {
    const stat = source.stat(path)
    return stat ? `${path}::${stat.revision}::${mode}` : null
  }

  const remember = (key: string, result: VoiceDecodeResult) => {
    cache.set(key, result)
    while (cache.size > DECODE_CACHE_LIMIT) {
      const oldest = cache.keys().next()
      if (oldest.done) break
      cache.delete(oldest.value)
    }
  }

  const ensureContext = (): AudioContext | null => {
    if (ctx) return ctx
    if (typeof AudioContext === 'undefined') return null
    try {
      ctx = new AudioContext()
    } catch {
      ctx = null
    }
    return ctx
  }

  const ensureAudio = (): HTMLAudioElement | null => {
    if (audio) return audio
    if (typeof Audio === 'undefined') return null
    audio = new Audio()
    audio.preload = 'auto'
    // 只处理「自己那一轮」的结束/出错：换歌后旧元素的事件不该清掉新播放态
    audio.addEventListener('ended', () => {
      if (playToken === token) releasePlayback()
    })
    audio.addEventListener('error', () => {
      if (playToken !== token) return
      // 别静默：类型不对 / 浏览器不认这个编码时，用户看到的就是"点了没反应"
      console.warn('[hanshu] 音频解码失败（浏览器不认这个文件）', audio?.src)
      releasePlayback()
    })
    return audio
  }

  /** 清空播放态并释放 objectURL（不触碰令牌） */
  const releasePlayback = () => {
    if (audio) {
      try {
        audio.pause()
      } catch {
        /* 忽略：元素可能已失去 src */
      }
      audio.removeAttribute('src')
    }
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl)
      objectUrl = null
    }
    if (playback) {
      playback = null
      emit()
    }
  }

  /** 拿一个解码槽位（超过并发上限就排队等） */
  const acquireDecodeSlot = (): Promise<void> =>
    new Promise((resolve) => {
      const grant = () => {
        decoding += 1
        resolve()
      }
      if (decoding < MAX_DECODE_CONCURRENCY) grant()
      else decodeQueue.push(grant)
    })

  const releaseDecodeSlot = () => {
    decoding -= 1
    decodeQueue.shift()?.()
  }

  const decodeNow = async (
    path: string,
    key: string,
    mode: VoiceDecodeMode,
  ): Promise<VoiceDecodeResult> => {
    const isOgg = isVoiceOggPath(path)
    // 成品配音必须是单通道 ogg：非 ogg 不必解码，直接用后缀就能判不合法
    if (mode === 'asset' && !isOgg) {
      const ext = voiceAssetExtension(path)
      return { ok: false, reason: `只允许单通道 ogg（当前是 ${ext || '无后缀'}）` }
    }
    const blob = await source.read(path)
    if (!blob) return { ok: false, reason: '读取资产失败' }
    const context = ensureContext()
    if (!context) return { ok: false, reason: '当前环境不支持音频解码' }
    let buffer: AudioBuffer
    let codec: VoiceOggInfo['codec'] = null
    try {
      const bytes = await blob.arrayBuffer()
      // 先按字节嗅探容器/编解码器：decodeAudioData 会把 ArrayBuffer detach 掉。
      // 只有 ogg 才谈得上 Vorbis / Opus，别的容器留 null。
      if (isOgg) {
        codec = inspectOggBytes(
          new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 256)),
        ).codec
      }
      buffer = await context.decodeAudioData(bytes)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return { ok: false, reason: `不是合法的音频文件（${detail}）` }
    }
    // 成品要求单通道；当"源"看时不设限 —— 导入时会下混成单通道
    if (mode === 'asset' && buffer.numberOfChannels !== 1) {
      return {
        ok: false,
        reason: `只允许单通道（当前 ${formatVoiceChannels(buffer.numberOfChannels)}）`,
      }
    }
    const info: VoiceAudioInfo = {
      path,
      duration: buffer.duration,
      channels: buffer.numberOfChannels,
      sampleRate: buffer.sampleRate,
      codec,
      peaks: computePeaks(buffer),
    }
    remember(key, { ok: true, info })
    return { ok: true, info }
  }

  const decode = (
    path: string,
    mode: VoiceDecodeMode = 'asset',
  ): Promise<VoiceDecodeResult> => {
    const key = cacheKeyOf(path, mode)
    if (!key) return Promise.resolve({ ok: false, reason: '资产不存在' })
    const hit = cache.get(key)
    if (hit) return Promise.resolve(hit)
    const running = inFlight.get(key)
    if (running) return running

    const task = acquireDecodeSlot()
      .then(() => decodeNow(path, key, mode))
      .then((result) => {
        // decodeNow 里 ok 的结果已经写过缓存；失败的也记下来，避免反复解码坏文件
        if (!result.ok) remember(key, result)
        return result
      })
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error)
        const result: VoiceDecodeResult = { ok: false, reason }
        remember(key, result)
        return result
      })
      .finally(() => {
        releaseDecodeSlot()
        inFlight.delete(key)
        // 解码是异步的：完成时通知一次，按钮状态与选择器信息才能刷新
        emit()
      })

    inFlight.set(key, task)
    return task
  }

  /**
   * 开播的公共部分（单流：换目标直接替换掉上一个）。
   * `resolveBlob` 决定字节从哪来：资产库按路径读，或者直接用内存里的 blob。
   * `warmDecode` 只在按路径播放时开 —— 那条"预热解码"需要能按路径读到文件。
   */
  const runPlayback = async (
    id: string,
    name: string,
    key: string | null,
    resolveBlob: () => Promise<Blob | null>,
    warmDecode: boolean,
  ): Promise<boolean> => {
    if (disposed) {
      console.warn('[hanshu] 播放器已释放，忽略这次播放', id)
      return false
    }
    const myToken = ++token
    playToken = myToken
    // 单流：换目标直接替换掉上一个
    releasePlayback()
    const blob = await resolveBlob()
    if (disposed || myToken !== token) return false
    if (!blob) {
      // 别静默：树里有元数据但 IndexedDB 里没 blob 时，用户看到的就是"点了没反应"
      console.warn('[hanshu] 读不到资产数据（IndexedDB 里没有这个文件）', id)
      return false
    }
    const el = ensureAudio()
    if (!el) {
      console.warn('[hanshu] 当前环境没有 Audio 元素，无法播放', id)
      return false
    }
    // 补类型：blob 的 type 可能是空的或 octet-stream，那样 <audio> 会拒播
    objectUrl = URL.createObjectURL(withAudioMime(blob, name))
    el.src = objectUrl
    playback = { path: id, key }
    emit()
    try {
      await el.play()
    } catch (error) {
      if (myToken === token) {
        releasePlayback()
        console.warn('[hanshu] 音频播放失败', id, error)
      }
      return false
    }
    if (disposed || myToken !== token) return false
    // 预热解码：拿到时长/声道/波形，若发现不是单通道 ogg 由上层停掉
    if (warmDecode) void decode(id)
    return true
  }

  return {
    peek(path, mode = 'asset') {
      const key = cacheKeyOf(path, mode)
      return key ? (cache.get(key) ?? null) : null
    },

    decode,

    getPlayback() {
      return playback
    },

    isPlaying(path) {
      return playback != null && playback.path === path
    },

    async play(path, key = null) {
      return runPlayback(path, path, key ?? null, () => source.read(path), true)
    },

    async playBlob(id, name, blob) {
      // 内存里的字节没有资产路径：不预热解码（那条路要按路径从库里读）
      return runPlayback(id, name, null, async () => blob, false)
    },

    stop() {
      token += 1
      releasePlayback()
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    dispose() {
      disposed = true
      token += 1
      releasePlayback()
      listeners.clear()
      inFlight.clear()
      cache.clear()
      if (ctx) {
        void ctx.close().catch(() => undefined)
        ctx = null
      }
      audio = null
    },
  }
}
