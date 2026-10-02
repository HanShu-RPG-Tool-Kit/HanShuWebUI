import { getAssetBlob } from '../assets/idb'
import {
  VOICE_REF_EXTENSION,
  isSameVoiceAsset,
  resolveVoiceBindingFor,
  voiceAssetExtension,
  voiceFileName,
  voiceKeyAssetPath,
  voiceKeyRefPath,
  type VoiceBinding,
} from './voiceMap'
import { canPlatformDecodeAudio } from './voiceTranscode'
import {
  createVoiceRuntime,
  formatVoiceChannels,
  formatVoiceDuration,
  type VoiceAudioInfo,
  type VoiceDecodeResult,
  type VoicePlaybackProgress,
  type VoiceRuntime,
  type VoiceSource,
} from './voiceRuntime'

/**
 * 音频映射管理（界面唯一入口）。
 *
 * **没有映射文件**：某个键该用哪个音频，完全由「脚本路径 + 键名」推导出的**对等文件**决定
 * （见 voiceMap）。对等位置上可以是：
 * - `.ogg`：真文件 —— 导入 / 录音 / TTS 的产物；
 * - `.ref`：**「引用资产」**，一行路径的文本文件，指向同包内的另一个音频资产。
 *
 * 两者同时在时 **`.ogg` 优先**（见 `resolveVoiceBindingFor`）。
 *
 * 所以这里不再持有键值表，只做三件事：
 * 1. 把键解析成一次「绑定」（`.ogg` 或 `.ref`）→ 四态
 * 2. 资产清单 + IndexedDB blob 的读取
 * 3. 单流播放 / 解码缓存（时长 / 声道 / 波形）
 *
 * 四态（引用一并适用：判的就是它引到的那份音频）：
 * - `missing` 对等位置上既没有 `.ogg` 也没有 `.ref`
 * - `invalid` 找到了，但不是**单声道 Vorbis ogg**；或引用解析不出来（目标缺失 / 不是音频 / 内容坏）
 * - `ready`   单声道 Vorbis ogg，可播
 * - `playing` 正在播的就是这份音频
 *
 * `status.path` 是**绑定文件**（`.ogg` / `.ref`：删除与改名都针对它），
 * `status.audioPath` 才是拿去解码 / 播放的那份（引用时是目标资产）。
 */

export type VoiceUnitState = 'missing' | 'invalid' | 'ready' | 'playing'

export type VoiceUnitStatus = {
  state: VoiceUnitState
  /** 绑定文件路径（`.ogg` / `.ref`）；缺失时 null */
  path: string | null
  /** 实际音频路径（引用时是目标资产）；缺失或引用解析不出来时 null */
  audioPath: string | null
  /** 这次绑定是实文件还是引用（缺失时按"期望的是实文件"给 `file`） */
  source: 'file' | 'ref'
  /** 缺失 / 不合法的原因（用于按钮 tooltip） */
  reason: string | null
  /** 解码后的元信息（未解码或非法时为 null） */
  info: VoiceAudioInfo | null
}

/** 选择器资源管理器里的一项（根目录是 assets，什么都可能出现在这里） */
export type VoiceAssetEntry = {
  /** `assets/...` 完整路径 */
  path: string
  /** 相对 assets 的相对路径 */
  relative: string
  /** 文件名（含后缀） */
  name: string
  ext: string
  size: number
  mime: string
  /** 后缀在平台可解码白名单里（值不值得试） */
  decodable: boolean
}

/** 资产清单里本模块用得到的字段（与 workspace 的 AssetFile 结构兼容） */
export type VoiceAssetLike = {
  path: string
  mime: string
  size: number
  updatedAt?: number
  /** `.ref`（「引用资产」）正文解析出的目标路径；加载 / 写入时填好 */
  refTarget?: string | null
}

export type VoiceLibrary = {
  readonly locale: string
  /** 当前脚本的名（对等路径按它推导） */
  readonly scriptName: string
  /** 该键的对等文件路径（固定 .ogg）——导入的写入目标 */
  targetPathOf(key: string): string
  /** 该键的引用文件路径（固定 .ref）——「引用资产」的写入目标 */
  refPathOf(key: string): string
  /** 该键当前**实际提供音频**的那份资产路径（引用时是它的目标）；没有音频 null */
  resolvedPathOf(key: string): string | null
  /** 键 → 四态 */
  statusOf(key: string): VoiceUnitStatus
  /** 可用则播；正在播则停（按钮点击语义） */
  togglePlay(key: string): void
  /** 选择器用：assets 下的资产（可按路径模糊过滤） */
  listAssets(query?: string): VoiceAssetEntry[]
  /** 资源管理器根目录：固定 assets */
  rootDir(): string
  /** 单流预览（选择器试听） */
  preview(path: string): void
  /** 单流预览：内存里的源（拖入但还没入库的文件；`id` 用于播放态比对） */
  previewBlob(id: string, name: string, bytes: Uint8Array): void
  /** 选择器用：某资产的解码结果（无副作用；没解过返回 null） */
  peek(path: string): VoiceDecodeResult | null
  /** 选择器用：选中某项时触发解码并返回当前结果 */
  inspect(path: string): VoiceDecodeResult | null
  /** 选择器用：这条资产是不是正在试听 */
  isPreviewing(path: string): boolean
  /** 试听进度（没有在播 / 元信息未就绪时 null） */
  previewProgress(): VoicePlaybackProgress | null
  /** 试听暂停 / 继续（没有在播时忽略） */
  pausePreview(): void
  resumePreview(): void
  /** 拖动进度条（0..1 比例） */
  seekPreview(ratio: number): void
  /** 进度订阅：**独立于 subscribe**（timeupdate 频率高，不能带着覆盖层重绘） */
  subscribePreviewProgress(listener: () => void): () => void
  /**
   * 资产清单变了（导入完成 / 拖入 / 删除）时由上层调用：
   * 清掉解析缓存并广播一次，让覆盖层按钮与已打开的选择器都刷新。
   */
  notifyAssetsChanged(): void
  stop(): void
  subscribe(listener: () => void): () => void
  dispose(): void
}

export function createVoiceLibrary(options: {
  locale: string
  /** 当前脚本名：`hello/cp1.hs` → 对等目录 `assets/<tag>/voice/hello/cp1/` */
  scriptName: string
  /** 当前包的资产清单（React 状态数组，引用稳定） */
  assets: () => readonly VoiceAssetLike[]
  /** 当前包 id（IndexedDB blob 的键前缀） */
  packageId: () => string
  /** 可注入的播放/解码运行时：默认自己建一个（注入用于无浏览器的逻辑测试） */
  runtime?: VoiceRuntime
}): VoiceLibrary {
  const { locale, scriptName } = options
  const listeners = new Set<() => void>()

  const source: VoiceSource = {
    stat(path) {
      const hit = options.assets().find((asset) => asset.path === path)
      if (!hit) return null
      // 版本里带上包 id：换包后缓存自然失效
      return { revision: `${options.packageId()}:${hit.size}:${hit.updatedAt ?? 0}` }
    },
    read(path) {
      return getAssetBlob(options.packageId(), path)
    },
  }

  const ownsRuntime = options.runtime == null
  const runtime: VoiceRuntime = options.runtime ?? createVoiceRuntime(source)

  // 解析结果按「键」缓存；资产清单数组换了引用（工作区改动）就整表作废
  let cachedAssets: readonly VoiceAssetLike[] | null = null
  let resolveCache = new Map<string, VoiceBinding<VoiceAssetLike> | null>()

  const resolve = (key: string): VoiceBinding<VoiceAssetLike> | null => {
    const list = options.assets()
    if (list !== cachedAssets) {
      cachedAssets = list
      resolveCache = new Map()
    }
    const normalized = key.trim().toLowerCase()
    if (resolveCache.has(normalized)) return resolveCache.get(normalized) ?? null
    const hit = resolveVoiceBindingFor(scriptName, normalized, locale, list)
    resolveCache.set(normalized, hit)
    return hit
  }

  const emit = () => {
    for (const listener of listeners) listener()
  }

  const unsubscribeRuntime = runtime.subscribe(() => {
    // 解码是异步的：播到一半才发现不是单通道 Vorbis，就停掉（播放态与四态保持一致）。
    //
    // 但这条**成品规则只管"某个键的配音"**（play(path, key)）。选择器里的试听是
    // play(path, null)，面对的是"源"（wav / mp3 都可能），套成品规则会在开播瞬间
    // 就把它停掉 —— 表现就是"按下播放毫无反应，只有 ogg 能播"。
    const playing = runtime.getPlayback()
    if (playing && playing.key != null) {
      const decoded = runtime.peek(playing.path)
      if (decoded && !decoded.ok) runtime.stop()
    }
    emit()
  })

  const statusOf = (key: string): VoiceUnitStatus => {
    const normalized = key.trim().toLowerCase()
    if (!normalized) {
      return {
        state: 'missing',
        path: null,
        audioPath: null,
        source: 'file',
        reason: '键名无效',
        info: null,
      }
    }
    const hit = resolve(normalized)
    if (!hit) {
      return {
        state: 'missing',
        path: null,
        audioPath: null,
        source: 'file',
        reason:
          `没有对等配音文件（期望 ${voiceKeyAssetPath(locale, scriptName, normalized)}` +
          ` 或同名的 .${VOICE_REF_EXTENSION}）`,
        info: null,
      }
    }

    const bindingPath = hit.path
    const source = hit.kind

    // 引用解析不出来：原因直接用 voiceMap 给的原话（目标缺失 / 不是音频 / 内容坏）
    if (!hit.audioPath) {
      return {
        state: 'invalid',
        path: bindingPath,
        audioPath: null,
        source,
        reason: hit.reason ?? '引用解析不出来',
        info: null,
      }
    }

    // 实际音频：实文件就是它自己，引用是它指向的那份
    const path = hit.audioPath

    if (runtime.isPlaying(path)) {
      const decoded = runtime.peek(path)
      return {
        state: 'playing',
        path: bindingPath,
        audioPath: path,
        source,
        reason: null,
        info: decoded && decoded.ok ? decoded.info : null,
      }
    }

    // 非 ogg 不必解码就能判死；ogg 也要看是不是 Vorbis（引擎约定）
    if (!path.toLowerCase().endsWith('.ogg')) {
      const ext = voiceAssetExtension(path)
      return {
        state: 'invalid',
        path: bindingPath,
        audioPath: path,
        source,
        reason:
          source === 'ref'
            ? `引用目标必须是单通道 ogg Vorbis（当前是 ${ext || '无后缀'}）`
            : `只允许单通道 ogg Vorbis（当前是 ${ext || '无后缀'}）`,
        info: null,
      }
    }

    const decoded = runtime.peek(path)
    if (!decoded) {
      // 乐观：先按可用渲染（黄），解码结果回来再纠正成紫/继续黄。
      // 这里是查询路径，但解码本身幂等且带缓存，重复触发无副作用。
      void runtime.decode(path)
      return {
        state: 'ready',
        path: bindingPath,
        audioPath: path,
        source,
        reason: null,
        info: null,
      }
    }
    if (!decoded.ok) {
      return {
        state: 'invalid',
        path: bindingPath,
        audioPath: path,
        source,
        reason: decoded.reason,
        info: null,
      }
    }
    // 解码成功 ≠ 符合约定：单声道 Opus 也解得开，但引擎要的是 Vorbis
    if (decoded.info.channels !== 1) {
      return {
        state: 'invalid',
        path: bindingPath,
        audioPath: path,
        source,
        reason: `只允许单通道（当前 ${formatVoiceChannels(decoded.info.channels)}）`,
        info: null,
      }
    }
    if (decoded.info.codec !== 'vorbis') {
      const codec =
        decoded.info.codec === 'opus'
          ? 'Opus'
          : decoded.info.codec === 'other'
            ? '未知编码'
            : '（没有容器信息）'
      return {
        state: 'invalid',
        path: bindingPath,
        audioPath: path,
        source,
        reason: `ogg 里装的是 ${codec}，按约定需要 Vorbis`,
        info: null,
      }
    }
    return {
      state: 'ready',
      path: bindingPath,
      audioPath: path,
      source,
      reason: null,
      info: decoded.info,
    }
  }

  return {
    locale,
    scriptName,

    targetPathOf: (key) => voiceKeyAssetPath(locale, scriptName, key),

    refPathOf: (key) => voiceKeyRefPath(locale, scriptName, key),

    // 「实际提供音频的那份」：引用时是目标资产 —— 选择器标"当前目标"、显示"已有配音"都看它
    resolvedPathOf: (key) => resolve(key)?.audioPath ?? null,

    statusOf,

    togglePlay(key) {
      const status = statusOf(key)
      if (status.state === 'playing') {
        runtime.stop()
        return
      }
      // 播的是"实际音频"：引用时是它指向的那份，不是 `.ref` 本身
      if (status.state === 'ready' && status.audioPath) {
        void runtime.play(status.audioPath, key.trim().toLowerCase())
      }
    },

    listAssets(query) {
      const needle = (query ?? '').trim().toLowerCase()
      const out: VoiceAssetEntry[] = []
      for (const asset of options.assets()) {
        const path = asset.path.trim().replace(/\\/g, '/')
        if (!path.toLowerCase().startsWith('assets/')) continue
        if (needle && !path.toLowerCase().includes(needle)) continue
        out.push({
          path,
          relative: path.slice('assets/'.length),
          name: voiceFileName(path),
          ext: voiceAssetExtension(path),
          size: asset.size,
          mime: asset.mime,
          decodable: canPlatformDecodeAudio(path),
        })
      }
      return out.sort((a, b) => a.path.localeCompare(b.path))
    },

    /** 资源管理器根目录：按需求固定为 assets */
    rootDir: () => 'assets',

    preview(path) {
      void runtime.play(path, null)
    },

    previewBlob(id, name, bytes) {
      // 类型留空，交给 runtime 按 name 的后缀补（wav/mp3… 与成品那条规则无关）
      void runtime.playBlob(id, name, new Blob([bytes as BlobPart]))
    },

    // 选择器面对的是"源"：任何平台能解的格式都要给出波形/时长，不能套成品那套 ogg 规则
    peek: (path) => runtime.peek(path, 'source'),

    inspect(path) {
      const hit = runtime.peek(path, 'source')
      // 没解过就顺手触发一次：解码完成后 runtime 会 emit，界面自然刷新
      if (!hit) void runtime.decode(path, 'source')
      return hit
    },

    isPreviewing: (path) => runtime.isPlaying(path),

    previewProgress: () => runtime.playbackProgress(),

    pausePreview: () => runtime.pause(),

    resumePreview: () => runtime.resume(),

    seekPreview: (ratio) => runtime.seekRatio(ratio),

    subscribePreviewProgress: (listener) => runtime.subscribeProgress(listener),

    notifyAssetsChanged() {
      cachedAssets = null
      resolveCache = new Map()
      emit()
    },

    stop() {
      runtime.stop()
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    dispose() {
      unsubscribeRuntime()
      listeners.clear()
      resolveCache.clear()
      if (ownsRuntime) runtime.dispose()
    },
  }
}

/** 某个已解析资产是否就是该键的对等文件（选择器用来标「当前目标」） */
export function isCurrentVoiceAsset(
  path: string,
  locale: string,
  scriptName: string,
  key: string,
): boolean {
  return isSameVoiceAsset(path, locale, scriptName, key)
}

/** 供界面显示：时长 · 声道 */
export function describeVoiceInfo(info: VoiceAudioInfo): string {
  return `${formatVoiceDuration(info.duration)} · ${formatVoiceChannels(info.channels)}`
}

/** 一个资产是不是「本工作流产出的合法配音」（给选择器/状态用） */
export function isAcceptedVoice(path: string, decoded: VoiceDecodeResult | null): boolean {
  if (!path.toLowerCase().endsWith('.ogg')) return false
  return (
    decoded?.ok === true &&
    decoded.info.channels === 1 &&
    decoded.info.codec === 'vorbis'
  )
}
