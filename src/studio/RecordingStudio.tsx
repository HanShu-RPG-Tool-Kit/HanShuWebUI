import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { type VoiceLibrary } from '../i18n/voiceLibrary'
import {
  formatVoiceChannels,
  formatVoiceDuration,
  type VoiceDecodeResult,
} from '../i18n/voiceRuntime'
import type { VoiceImportSource } from '../i18n/voiceImport'
import { VOICE_EXTRA_GLYPHS } from '../ui/voiceIcons'
import { VoiceEmptyGlyph, VoiceGlyph, VoiceWaveform } from '../ui/VoiceVisuals'
import {
  acceptsAudioDrop,
  draggedAssetPath,
  droppedFiles,
  isInternalDrag,
} from '../drag/dragPayload'
import { formatBytes } from '../assets/paths'
import type { TtsFailureKind } from '../tts/spec'
import {
  VoiceAssetBrowser,
  voiceFormatOfPath,
} from './VoiceAssetBrowser'
import {
  canRecordAudio,
  decodeMemoryAudio,
  startVoiceRecording,
  type MemoryAudioInfo,
  type VoiceRecorder,
} from './audioPreview'

/**
 * 录音棚（内置在剧本编辑器里的配音工作台）。
 *
 * **两个维度**，互相正交，所以组件内部是「作用范围 × 配音方式」的笛卡尔积：
 * - `mode`（作用范围）：`single` 单选配音 = 当前选中的那一个键；
 *   `batch` 批量配音 = 全部选中的键
 * - `sourceMode`（配音方式）：`fixed` 固定音频 / `tts` 批量 TTS / `record` 录音
 *
 * 三个配音方式对**单选与批量是同一套实现**，差别只落在"目标键集合"上：
 * - `fixed` ：一份音频写进 1 个（单选）或 N 个（批量）键
 * - `record`：为待录的键逐个录；单选就是"就录这一个"（已有配音也照录，等于覆盖），
 *   批量则排队推进，确认后自动接上下一个没配音的键
 * - `tts`   ：按需求**先留空**（只给一个明确的占位，不假装能用）
 *
 * 单选与「固定音频」共用同一套固定组件（也是全模式的公共外壳）：
 * 配音模式提示 → 预览窗（可拖拽 + 波形）→ 播放与进度条 → 音频信息（路径/时长/格式/声道）
 * → 共用的资产搜索与资源树（见 studio/VoiceAssetBrowser）。
 *
 * 组件是**受控**的：选中了哪些键、当前什么模式都由 ScriptWorkspace 持有
 * （因为选中动作发生在编辑器里，见 monaco/textEditor 的录音棚选择模式）。
 */

export type StudioMode = 'single' | 'batch'
export type StudioSourceMode = 'fixed' | 'tts' | 'record' | 'ref'

/**
 * TTS 生成的当前状态 —— 失败要分类、要给出下一步，不能只说"生成失败"。
 *
 * `failureKind` 直接带上 `TtsFailure.kind`：界面据此决定给哪个"下一步"按钮
 * （API KEY 缺失 → 打开本地缓存），而不是去猜消息里有没有"凭据"两个字。
 */
export type StudioTtsStatus =
  | { kind: 'idle' }
  | { kind: 'busy'; message: string }
  | { kind: 'error'; message: string; hint?: string; failureKind?: TtsFailureKind }
  | { kind: 'done'; message: string }

/**
 * TTS 那一格要的全部东西。
 *
 * 两级选择是**强制**的(规范 §7.4):缺任一级就不能生成 —— 按钮不可用,
 * 而不是等点了才报错。"选不到"由上游决定:没配的语言根本不在这两个列表里。
 */
export type StudioTtsPanel = {
  /** 工程里的配音方案 */
  plans: { name: string; character: string }[]
  planName: string | null
  /** 当前方案可选的语言 */
  locales: string[]
  locale: string | null
  /**
   * 这份方案**为什么还不能用**（校验器给的第一条错误原话）；null = 能用了。
   *
   * 直接透出原话而不是写死一句"还没填完"：拦住的可能是缺音色 id、缺服务，
   * 也可能是旧文件留了个废弃键 —— 猜错一句就等于把用户指错方向。
   */
  planBlockedReason: string | null
  status: StudioTtsStatus
  /**
   * 正在生成。
   *
   * **它必须把「生成配音」按住。** 合成是逐键串行的,而导入共用同一份进度与取消引用
   * (见 ScriptWorkspace 的 `runVoiceImportForKeys`) —— 同一个按钮点两下会跑起两条
   * 合成循环,进度条互相覆盖、取消也取消不干净。
   */
  busy: boolean
  /** 一次合成的分块进度(长文本会切成好几块)。null = 还没开始 */
  progress: { ratio: number; label: string } | null
  canGenerate: boolean
  onPlanChange(name: string): void
  onLocaleChange(locale: string): void
  /**
   * 为这些键各生成一条。
   *
   * 目标集合由这里算好再传出去 —— 单选/批量、哪些键还没有配音,这一格本来就知道,
   * 上层不该再推一遍同样的逻辑。
   */
  onGenerate(keys: string[]): void
  /** 停止生成(中断当前合成,并挡住后面还没开始的键) */
  onCancel?(): void
  /** 新建一份配音方案。建完自动选中它，但**不抢走编辑器** —— 缺什么由这一格说出来 */
  onCreatePlan?(): void
  /** 打开当前选中的那份方案，去把缺的填上 */
  onOpenPlan?(): void
  /** 缺 API KEY 时的下一步 */
  onOpenCredentials?(): void
}

export type RecordingStudioProps = {
  mode: StudioMode
  sourceMode: StudioSourceMode
  /** 已选中的键名（按正文里出现的顺序） */
  selectedKeys: string[]
  /** 音频映射管理；非 .hs 或尚未就绪时为 null */
  library: VoiceLibrary | null
  /**
   * 当前语言的台词：录音时要照着念的那一句；null = 这个键在当前语言下还没有文本。
   *
   * 传函数而不是传一段文本：**要显示哪个键由这一格自己定** —— 单选是选中的那个，
   * 批量录音是队列里还没配音的第一个（录完自动往后走）。上层再推一遍这个判断，
   * 迟早会和下面那行"待录键"说的不是同一个键。
   */
  textFor?: (key: string) => string | null
  onClose(): void
  onModeChange(mode: StudioMode): void
  onSourceModeChange(mode: StudioSourceMode): void
  onClearSelection(): void
  /** 清除这些键的配音（确认与落盘由上层负责） */
  onClearVoice(keys: string[]): void
  /** 用同一份音频导入到这些键 */
  onImport(keys: string[], source: VoiceImportSource): void
  /**
   * 把这些键的配音设成**引用**（「引用资产」）：对等位置上写 `.ref`，不拷贝字节。
   *
   * 与 `onImport` 的区别只有这一件事 —— 被引用的音频留在原处，多个键可以引用同一份。
   */
  onReference?(keys: string[], targetPath: string): void
  /** TTS 那一格；null 表示工程还没准备好（没打开文件、没有配音方案等） */
  tts?: StudioTtsPanel | null
  style?: CSSProperties
}

/** 当前候选音频：资产树上选的，或内存里的（拖入 / 刚录的） */
type StudioSource =
  | { kind: 'asset'; path: string }
  | {
      kind: 'memory'
      id: string
      name: string
      size: number
      bytes: Uint8Array
      origin: 'drop' | 'record'
    }

/** 上拉框里的顺序（固定音频 / 引用资产 / TTS / 录音） */
const SOURCE_MODES: StudioSourceMode[] = ['fixed', 'ref', 'tts', 'record']

/**
 * 配音方式的标签。
 *
 * 批量下的名字是需求里点名固定的（固定音频 / 批量 TTS / 批量录音）；
 * 单选下同一个方式是"就这一个键"，再叫"批量"会自相矛盾，所以去掉前缀。
 */
function sourceModeLabel(mode: StudioMode, source: StudioSourceMode): string {
  if (source === 'tts') return mode === 'batch' ? '批量 TTS' : 'TTS'
  if (source === 'record') return mode === 'batch' ? '批量录音' : '录音'
  if (source === 'ref') return mode === 'batch' ? '批量引用' : '引用资产'
  return '固定音频'
}

/** 配音方式的说明文案（两种作用范围下含义略有不同） */
function sourceModeTitle(mode: StudioMode, source: StudioSourceMode): string {
  const scope = mode === 'single' ? '这一个键' : '所有选中的键'
  if (source === 'tts') return `TTS · 为${scope}各生成一条`
  if (source === 'record') return `录音 · 为${scope}逐条录制`
  if (source === 'ref') {
    return `引用资产 · 让${scope}指向同一份音频（不拷贝字节，改的是引用）`
  }
  return `固定音频 · 同一份音频写进${scope}`
}

function sourceIdOf(source: StudioSource | null): string | null {
  if (!source) return null
  return source.kind === 'asset' ? source.path : source.id
}

export function RecordingStudio({
  mode,
  sourceMode,
  selectedKeys,
  library,
  textFor,
  onClose,
  onModeChange,
  onSourceModeChange,
  onClearSelection,
  onClearVoice,
  onImport,
  onReference,
  tts,
  style,
}: RecordingStudioProps) {
  /** 资产树上选中的资产（单选/固定模式用） */
  const [picked, setPicked] = useState<string | null>(null)
  /** 拖进来 / 录下来的内存音频 */
  const [memory, setMemory] = useState<
    Extract<StudioSource, { kind: 'memory' }> | null
  >(null)
  const [query, setQuery] = useState('')
  const [dropActive, setDropActive] = useState(false)
  /** 底部上拉框（配音方式选择器）是否展开 */
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false)
  /** 批量录音：跳过的键 */
  const [skipped, setSkipped] = useState<string[]>([])
  /**
   * 内存音频（拖入的 / 刚录的）的解码结果：波形、时长、声道都靠它。
   * 资产走的是 `library.inspect`，内存字节没有资产路径，只能就地解。
   */
  const [memoryInfo, setMemoryInfo] = useState<MemoryAudioInfo | null>(null)
  /**
   * 内存音频的解码状态。
   *
   * 为什么要单独一个状态：`memoryInfo` 为 null 同时意味着"还在解"和"解不开"，
   * 只靠它的话拖进来一个不是音频的文件会永远停在"解码中…"，
   * 用户只会觉得"拖进来没反应"。
   */
  const [memoryStatus, setMemoryStatus] = useState<
    'idle' | 'decoding' | 'ready' | 'failed'
  >('idle')
  const [recording, setRecording] = useState(false)
  /** 确认后自动开始下一个待录键 */
  const [autoContinue, setAutoContinue] = useState(true)
  const [notice, setNotice] = useState<string | null>(null)
  /** 「确认导入」之后在等下一个待录键出现 → 出现了就自动开录 */
  const awaitingNextRef = useRef(false)
  const recorderRef = useRef<VoiceRecorder | null>(null)
  const levelRef = useRef<HTMLDivElement>(null)
  const clockRef = useRef<HTMLSpanElement>(null)
  /** 资产解码结果返回 / 试听状态变化时重画 */
  const [, setTick] = useState(0)
  const [, setProgressTick] = useState(0)

  const activeKey = mode === 'single' ? (selectedKeys[0] ?? null) : null

  // —— 订阅：状态（换/停/暂停）与进度（timeupdate）分开，见 voiceRuntime ——
  useEffect(() => {
    if (!library) return
    const offState = library.subscribe(() => setTick((n) => n + 1))
    const offProgress = library.subscribePreviewProgress(() =>
      setProgressTick((n) => n + 1),
    )
    return () => {
      offState()
      offProgress()
    }
  }, [library])

  /**
   * 单选模式下自动跟随：选中某个键就把它现有的配音当候选源（没有就清空）——
   * "编辑这个键的音频"打开时要能直接看到它现在是什么。
   */
  useEffect(() => {
    if (mode !== 'single' || !library || !activeKey) return
    const existing = library.resolvedPathOf(activeKey)
    setPicked(existing)
    setMemory(null)
  }, [mode, library, activeKey])

  // 换键 / 换配音方式时，把还没确认的 take 丢掉（它属于上一个键）
  useEffect(() => {
    setMemory((prev) => (prev?.origin === 'record' ? null : prev))
  }, [activeKey, sourceMode, mode])

  /** 刚录下、还没确认导入的那条 */
  const take = memory?.origin === 'record' ? memory : null

  // 内存音频解码：拖入的和刚录的走同一条路（预览窗的波形与信息栏都依赖它）
  useEffect(() => {
    if (!memory) {
      setMemoryInfo(null)
      setMemoryStatus('idle')
      return
    }
    let cancelled = false
    setMemoryStatus('decoding')
    void decodeMemoryAudio(memory.bytes).then((info) => {
      if (cancelled) return
      setMemoryInfo(info)
      setMemoryStatus(info ? 'ready' : 'failed')
      // 解不开就说清楚 —— 否则用户看到的是"拖进来什么都没发生"
      if (!info) {
        setNotice(
          `「${memory.name}」不是能解码的音频（支持 wav / mp3 / flac / m4a / ogg …）`,
        )
      }
    })
    return () => {
      cancelled = true
    }
  }, [memory])

  const source: StudioSource | null = useMemo(() => {
    // 批量录音模式下"候选音频"就是刚录的那条
    if (memory) return memory
    if (picked) return { kind: 'asset', path: picked }
    return null
  }, [memory, picked])

  const sourceId = sourceIdOf(source)
  const decoded: VoiceDecodeResult | null =
    source?.kind === 'asset' ? (library?.inspect(source.path) ?? null) : null

  /** 统一的音频元信息（资产解出来的 / 内存解码出来的） */
  const audioInfo = useMemo(() => {
    if (source?.kind === 'asset') {
      if (!decoded?.ok) return null
      return {
        duration: decoded.info.duration,
        channels: decoded.info.channels,
        peaks: decoded.info.peaks,
      }
    }
    if (source?.kind === 'memory' && memoryInfo) {
      return {
        duration: memoryInfo.duration,
        channels: memoryInfo.channels,
        peaks: memoryInfo.peaks,
      }
    }
    return null
  }, [source, decoded, memoryInfo])

  const sourcePathLabel = source
    ? source.kind === 'asset'
      ? source.path
      : `${source.origin === 'record' ? '（刚录的）' : '（拖入的）'}${source.name}`
    : null
  const sourceFormat = source
    ? source.kind === 'asset'
      ? voiceFormatOfPath(source.path, decoded)
      : (source.name.split('.').pop() ?? '').toUpperCase() || '无后缀'
    : null

  const playing = sourceId != null && (library?.isPreviewing(sourceId) ?? false)
  const progress = playing ? (library?.previewProgress() ?? null) : null
  const playedRatio =
    progress && progress.duration > 0 ? progress.current / progress.duration : 0

  /** 键有没有可用配音（ready / playing）—— 录音的队列按它筛 */
  const hasVoice = useCallback(
    (key: string): boolean => {
      const status = library?.statusOf(key)
      return status?.state === 'ready' || status?.state === 'playing'
    },
    [library],
  )

  /**
   * 待录队列：选中的键里"还没有可用配音"的那些（跳过的不算）。
   *
   * **不要 useMemo**：`hasVoice` 查的是音频映射的当前状态（导入完成 / 解码结果回来都会变），
   * 而它的依赖（library / selectedKeys）引用都不变 —— 一旦缓存住，导完一条队列也不会往前挪。
   */
  const pendingKeys = selectedKeys.filter(
    (key) => !hasVoice(key) && !skipped.includes(key),
  )
  /**
   * 这次录音要录给哪个键。
   *
   * - `single`：就是当前选中的那一个。**不看它有没有配音** —— 用户明确点了它，
   *   重录就是要覆盖；若按批量的口径跳过已有配音的键，单选录音会直接无键可录。
   * - `batch` ：待录队列的第一个（已有配音的自动跳过，录完推进到下一个）。
   */
  const recordTarget =
    sourceMode !== 'record'
      ? null
      : mode === 'single'
        ? activeKey
        : (pendingKeys[0] ?? null)
  const recordedCount = selectedKeys.filter(hasVoice).length

  /**
   * 台词：正要录的这个键、在当前语言下的文本。
   *
   * 没有译文时**不拿键名顶替**（编辑器覆盖层也是这个规矩：缺译文显示键名并标记），
   * 这里明说缺什么 —— 对着键名念出来的录音是废的，而且发现时人已经念完了。
   */
  const recordText = recordTarget ? (textFor?.(recordTarget) ?? null) : null

  // 选中集合变了：把不再存在的键从跳过表里清掉（否则会一直"少一个"）
  useEffect(() => {
    setSkipped((prev) => {
      const next = prev.filter((key) => selectedKeys.includes(key))
      return next.length === prev.length ? prev : next
    })
  }, [selectedKeys])

  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current
    if (!recorder) return
    recorderRef.current = null
    setRecording(false)
    const result = await recorder.stop()
    if (!result) {
      setNotice('没有录到任何数据，换一个麦克风或检查系统输入设备')
      return
    }
    setNotice(null)
    setMemory({
      kind: 'memory',
      id: `take:${Date.now()}`,
      name: result.name,
      size: result.bytes.byteLength,
      bytes: result.bytes,
      origin: 'record',
    })
  }, [])

  const startRecording = useCallback(async () => {
    if (recorderRef.current) return
    setNotice(null)
    try {
      const recorder = await startVoiceRecording()
      recorderRef.current = recorder
      setRecording(true)
      // 正在录 → 上一次的 take 作废
      setMemory(null)
    } catch (error) {
      setNotice(
        `开始录音失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }, [])

  // 录音中的电平与计时：直接改 DOM，别按帧 setState
  useEffect(() => {
    if (!recording) return
    let frame = 0
    let alive = true
    const tick = () => {
      if (!alive) return
      const recorder = recorderRef.current
      if (recorder) {
        const level = recorder.level()
        if (levelRef.current) {
          levelRef.current.style.width = `${Math.round(level * 100)}%`
        }
        if (clockRef.current) {
          clockRef.current.textContent = formatVoiceDuration(recorder.elapsed())
        }
      }
      frame = window.requestAnimationFrame(tick)
    }
    frame = window.requestAnimationFrame(tick)
    return () => {
      alive = false
      window.cancelAnimationFrame(frame)
    }
  }, [recording])

  // 组件卸载 / 切走：别把麦克风开着
  useEffect(
    () => () => {
      recorderRef.current?.cancel()
      recorderRef.current = null
    },
    [],
  )

  /**
   * 「确认导入」之后的推进：等新的待录键出现，就自动开始录它
   * （需求：确认后继续为下一个没有配音的键名录音）。
   *
   * 为什么不能在这一步清标记：确认之后导入是异步的，`recordTarget` 会先短暂变成
   * null（队列还没重算），标记必须**等得下去**才能接到下一个键。
   *
   * 只有批量才谈得上"下一个"；单选录完那一个就结束，不能在这里再开一轮 ——
   * 单选的目标键恒等于当前选中的键，重新开录会自己套自己、停不下来。
   */
  useEffect(() => {
    if (mode !== 'batch') return
    if (!recordTarget) return
    if (!awaitingNextRef.current) return
    awaitingNextRef.current = false
    if (autoContinue && !recorderRef.current) void startRecording()
  }, [mode, recordTarget, autoContinue, startRecording])

  /**
   * 上面那个标记必须在**意图变化**时作废。
   *
   * 否则会出现这种情况：录完队列里最后一个键 → 标记留着（因为 `recordTarget` 是 null，
   * 上面那个 effect 直接 return 了）→ 过一会儿用户重新选了几个键 → 目标一出现就
   * 自己开始录音。用户没按任何按钮，麦克风却开了。
   *
   * 依赖用「选中集合的字符串形式」而不是数组本身：上层每次重建数组都是新引用，
   * 用引用会在内容没变时也误清标记。
   */
  const selectionKey = selectedKeys.join('|')
  useEffect(() => {
    awaitingNextRef.current = false
  }, [selectionKey, sourceMode, mode])

  /**
   * 拖入外部文件：只当候选源，不直接导入（导入一律走「确认导入」这一步）。
   * 顺手把配音方式切回「固定音频」—— 拖文件进来就是要用它，
   * 停在录音 / TTS 那一栏只会让人以为"拖了没反应"。
   */
  const cacheDroppedFile = (file: File) => {
    void file
      .arrayBuffer()
      .then((buffer) => {
        setPicked(null)
        onSourceModeChange('fixed')
        setMemory({
          kind: 'memory',
          id: `drop:${file.name}:${file.size}`,
          name: file.name,
          size: file.size,
          bytes: new Uint8Array(buffer),
          origin: 'drop',
        })
        setNotice(null)
      })
      .catch((error: unknown) => {
        console.warn('[hanshu] 读取拖入的音频失败', error)
        setNotice(`读取「${file.name}」失败`)
      })
  }

  const previewBlobOf = (item: StudioSource | null) =>
    item?.kind === 'memory' ? item : null

  const togglePlay = () => {
    if (!source || !sourceId || !library) return
    if (playing) {
      // 已经在走 → 暂停；已暂停 → 继续（进度条与按钮同一个语义）
      if (progress?.paused) library.resumePreview()
      else library.pausePreview()
      return
    }
    if (source.kind === 'asset') {
      library.preview(source.path)
      return
    }
    const blob = previewBlobOf(source)
    if (blob) library.previewBlob(blob.id, blob.name, blob.bytes)
  }

  /** 进度条点击 / 拖动定位 */
  const seekFromEvent = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!library || !playing || !progress || progress.duration <= 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width <= 0) return
    library.seekPreview((event.clientX - rect.left) / rect.width)
  }

  /**
   * 投放目标的三件套（面板根节点与预览窗共用）。
   *
   * 两处都接：**面板根**是"随手拖进录音棚"的宽目标（拖拽是瞄准整个面板的手势，
   * 只挂在那 108px 高的预览窗上等于"拖进来没反应"，这条以前踩过）；**预览窗**是
   * "就丢在这一格上"的精确目标 —— 拖到哪一格，哪一格就得亮、就得认。
   *
   * 接两类源：
   * - **外部文件**（从资源管理器 / 桌面拖进来的）：一律接下，见 `shouldAcceptDrop`；
   * - **工程里的资产**（资源管理器的资产拖进来）：等价于在下面的资产树里点了它一下。
   *
   * 键名、脚本拖进来没有语义，保持浏览器默认的"不允许"反馈。
   */
  const dropTargetProps = (stop: boolean) => ({
    onDragOver: (event: ReactDragEvent<HTMLElement>) => {
      // 准放判据见 acceptsAudioDrop：外部拖拽一律接下（别拿 types 判有没有文件），
      // 内部拖拽只认"资产"这一种 —— 漏了资产就是"资产拖到录音棚上没反应"
      if (!acceptsAudioDrop(event.dataTransfer)) return
      event.preventDefault()
      if (stop) event.stopPropagation()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      setDropActive(true)
    },
    onDragLeave: (event: ReactDragEvent<HTMLElement>) => {
      const next = event.relatedTarget as Node | null
      if (!next || !event.currentTarget.contains(next)) setDropActive(false)
    },
    onDrop: (event: ReactDragEvent<HTMLElement>) => {
      const files = droppedFiles(event.dataTransfer)
      const assetPath = draggedAssetPath()
      setDropActive(false)
      event.preventDefault()
      if (stop) event.stopPropagation()
      /*
       * 工程里的资产：与资产树里点一下完全等价 —— 它成为候选源。
       * 先把内存候选清掉，否则 `source` 会继续优先那个（见下面的 source 求值顺序）。
       */
      if (assetPath) {
        setPicked(assetPath)
        setMemory(null)
        setNotice(null)
        return
      }
      // 本应用自己的其它拖拽（键名 / 脚本）落到录音棚没有对应语义，静默放过
      if (isInternalDrag(event.dataTransfer)) return
      const file = files[0]
      if (!file) {
        /*
         * 拖进来了，但系统一个文件都没交出来：说清成因，别让它表现成"拖了没反应"。
         *
         * 先分辨"本来就不是文件"（拖的是一段文本）—— 那种情况把责任推给权限只会误导。
         */
        const kinds = Array.from(event.dataTransfer?.types ?? []).map((type) =>
          type.toLowerCase(),
        )
        const claimedFiles = kinds.includes('files')
        const looksLikeText =
          !claimedFiles &&
          kinds.some((type) => type.startsWith('text/'))
        setNotice(
          looksLikeText
            ? '这里只接受音频文件（拖进来的是文本）'
            : '这次拖拽没带上文件：拖拽事件到了，但系统没把文件交给窗口。' +
              '若一直如此，多半是本程序以管理员身份在运行 —— Windows 会拦住从普通权限的 Explorer 往高权限窗口拖文件。',
        )
        return
      }
      cacheDroppedFile(file)
    },
  })

  const studioDropProps = dropTargetProps(false)
  const waveDropProps = dropTargetProps(true)
  /*
   * 「引用资产」那种方式**不接拖放**：引用只能指向工程里已有的资产，
   * 从桌面拖进来的文件没有包内路径可指（要用它就先在「固定音频」里导入）。
   * 接了反而会让人以为"拖进来就能引用"。
   */
  const dropPropsIfAny = (props: ReturnType<typeof dropTargetProps>) =>
    sourceMode === 'ref' ? {} : props

  /**
   * 从本机挑一个音频文件当候选 —— 和拖入走**同一条路**（`cacheDroppedFile`）。
   *
   * 为什么必须有一个点选的入口：外部文件拖放依赖窗口层的一串前置条件
   * （WebView2 的 `AllowExternalDrop`、以管理员身份运行时 Windows 的跨权限拦截……），
   * 一旦事件压根没进到网页层，应用里的任何判定都无从生效。点选不受这些影响。
   */
  const fileInputRef = useRef<HTMLInputElement>(null)

  /** 底部「确认导入」到底做什么 */
  const importTargets =
    mode === 'single' ? (activeKey ? [activeKey] : []) : selectedKeys

  /**
   * 台词来自哪个语言。
   *
   * 录音棚是**按"当前脚本 + 当前语言"建起来的**（`library.locale`），
   * 而 TTS 合成用的文本正是编辑器里那份 `.lang` —— 所以判据在这里，
   * 不需要上层再传一遍。
   */
  const textLocale = library?.locale ?? null
  /**
   * 选的音色语言与台词语言是否一致。
   *
   * 不一致时合成出来的是"用 A 语言的台词配 B 语言的音色"：发音对、内容错，
   * 比直接报错难发现得多。所以**不给生成**，并说清先切语言。
   */
  const localeMatchesText =
    textLocale === null || !tts?.locale || tts.locale === textLocale
  /** 配音方式是"录音"就走逐键录音那条路（单选 / 批量同一套，只是目标集合不同） */
  const confirmRecord = sourceMode === 'record'
  /** TTS 那一格的"确认"就是生成 —— 仍然是同一个按钮，不另开一条路 */
  const confirmTts = sourceMode === 'tts'
  /** 「引用资产」：确认 = 把这些键指向选中的那份资产（不拷贝字节） */
  const confirmRef = sourceMode === 'ref'
  /**
   * 单选模式下自动跟随出来的"候选源"可能就是它**自己当前的配音** ——
   * 那种情况导入只会白白报一句 already imported，所以直接禁用并说明。
   * 引用同理：让一个键引用它自己现在用的那份音频，什么也没发生。
   */
  const selfOnly =
    mode === 'single' &&
    (sourceMode === 'fixed' || confirmRef) &&
    activeKey != null &&
    source?.kind === 'asset' &&
    (library?.resolvedPathOf(activeKey)?.toLowerCase() ?? '') ===
      source.path.toLowerCase()
  /**
   * 能不能按下去。各种方式各有各的门槛，但**都回到同一个按钮** —— 学习成本只付一次。
   *
   * TTS 那条多一个 `!tts.busy`：生成中再点一次会跑起第二条合成循环，
   * 而两次导入共用同一份进度与取消引用（见 `onGenerate` 的类型注释）。
   * 引用那条多一个 `source.kind === 'asset'`：外部文件没有包内路径，指不了。
   */
  const canConfirm = confirmRecord
    ? Boolean(recordTarget && take)
    : confirmTts
      ? Boolean(
          tts?.canGenerate &&
            !tts.busy &&
            localeMatchesText &&
            importTargets.length > 0,
        )
      : confirmRef
        ? Boolean(
            source?.kind === 'asset' &&
              importTargets.length > 0 &&
              !selfOnly,
          )
        : Boolean(source && importTargets.length > 0 && !selfOnly)

  const confirmLabel = confirmTts
    ? tts?.busy
      ? '生成中…'
      : '生成配音'
    : confirmRef
      ? '确认引用'
      : '确认导入'

  /**
   * 按钮上方那句话。
   *
   * 它回答的是"按下去会发生什么"，**不是复述上面的状态** —— 所以顺序是
   * "先看这次能不能成、再看为什么不能"，而不是把模式的判断抄一遍。
   */
  const confirmHint = (() => {
    if (confirmTts) {
      if (tts?.busy) return tts.status.kind === 'busy' ? tts.status.message : '正在生成…'
      if (importTargets.length === 0) {
        return mode === 'single'
          ? '在编辑器里点一个键名'
          : '在编辑器里多选键名（Shift 或划框）'
      }
      if (!tts || tts.plans.length === 0) return '没有配音方案'
      if (!tts.planName) return '先选配音方案'
      if (!tts.locale) return '这份方案没有语言'
      if (!localeMatchesText) {
        return `台词是「${textLocale}」的 —— 先切到「${tts.locale}」`
      }
      if (!tts.canGenerate) {
        return tts.planBlockedReason ? '这份方案还不能用' : '缺少 API KEY'
      }
      return mode === 'single'
        ? `用「${tts.locale}」生成「${activeKey ?? ''}」`
        : `用「${tts.locale}」为 ${importTargets.length} 个键各生成一条`
    }
    if (confirmRecord) {
      if (recordTarget) {
        return `为「${recordTarget}」写入这条录音${
          mode === 'batch' && autoContinue ? '，然后自动录下一个' : ''
        }`
      }
      return selectedKeys.length === 0 ? '先选择键名' : '选中的键都已有配音'
    }
    if (confirmRef) {
      if (importTargets.length === 0) {
        return mode === 'single'
          ? '在编辑器里点一个键名'
          : '在编辑器里多选键名（Shift 或划框）'
      }
      if (!source) return '先在下面的资源树里选一份音频资产'
      if (source.kind !== 'asset') {
        return '引用只能指向工程里的资产 —— 外部文件请改用「固定音频」导入'
      }
      if (selfOnly) return `这就是「${activeKey}」当前的配音`
      return mode === 'single'
        ? `让「${activeKey}」引用它（不拷贝音频）`
        : `让 ${importTargets.length} 个键都引用它（不拷贝音频）`
    }
    if (importTargets.length === 0) {
      return mode === 'single'
        ? '在编辑器里点一个键名'
        : '在编辑器里多选键名（Shift 或划框）'
    }
    if (!source) return '先选择或拖入音频'
    if (selfOnly) return `这就是「${activeKey}」当前的配音`
    return mode === 'single'
      ? `写入「${activeKey}」`
      : `同一份音频写入 ${importTargets.length} 个键`
  })()

  const handleConfirm = () => {
    if (!canConfirm) return
    if (confirmTts) {
      // 生成之后仍然走 onImport —— 合成出来的字节与拖进来的文件是同一种输入，
      // 转码、落盘、试听都不需要第二条路
      tts?.onGenerate(importTargets)
      return
    }
    if (confirmRecord) {
      if (!recordTarget || !take) return
      // 只有批量才有"下一个"：单选录完这一个就结束，别挂自动续录的钩子
      if (mode === 'batch') awaitingNextRef.current = true
      onImport([recordTarget], {
        kind: 'file',
        name: take.name,
        bytes: take.bytes,
      })
      setMemory(null)
      return
    }
    if (!source) return
    // 播着就别继续播了：导入 / 改引用会把目标覆盖掉，试听那条已经不是最终产物
    library?.stop()
    if (confirmRef) {
      // 内部资产才能被引用（`canConfirm` 已经挡住了非资产源）
      if (source.kind !== 'asset') return
      onReference?.(importTargets, source.path)
      return
    }
    onImport(
      importTargets,
      source.kind === 'asset'
        ? { kind: 'asset', path: source.path }
        : { kind: 'file', name: source.name, bytes: source.bytes },
    )
  }

  /** 配音方式的名字：批量下是需求点名的"批量 TTS / 批量录音"，单选下去掉前缀 */
  const sourceLabel = sourceModeLabel(mode, sourceMode)

  if (!library) {
    return (
      <section className="studio" style={style} aria-label="录音棚">
        <header className="studio-header">
          <div className="studio-title">
            <span className="studio-title-name">录音棚</span>
          </div>
          <button
            type="button"
            className="studio-close"
            onClick={onClose}
            title="关闭录音棚"
            aria-label="关闭录音棚"
          >
            ×
          </button>
        </header>
        <div className="studio-empty">
          当前文件不支持配音：请打开一个 <code>.hs</code> 剧本。
        </div>
      </section>
    )
  }

  return (
    <section
      className={`studio${dropActive ? ' is-drop-target' : ''}`}
      style={style}
      aria-label="录音棚"
      {...dropPropsIfAny(studioDropProps)}
    >
      <header className="studio-header">
        <div className="studio-title">
          <span className="studio-title-name">录音棚</span>
          {/* 只留语言：它决定合成用的是哪份台词，而 TTS 那一格会按它拦人 */}
          <span className="studio-sub">{library.locale}</span>
        </div>
        <button
          type="button"
          className="studio-close"
          onClick={onClose}
          title="关闭录音棚"
          aria-label="关闭录音棚"
        >
          ×
        </button>
      </header>

      {/* 分段控件，不是两个独立按钮 —— 它们互斥，能一眼看出当前在哪一档 */}
      <div className="studio-modes" role="group" aria-label="配音模式">
        <button
          type="button"
          aria-pressed={mode === 'single'}
          className={`studio-mode${mode === 'single' ? ' is-on' : ''}`}
          onClick={() => onModeChange('single')}
        >
          单选配音
        </button>
        <button
          type="button"
          aria-pressed={mode === 'batch'}
          className={`studio-mode${mode === 'batch' ? ' is-on' : ''}`}
          onClick={() => onModeChange('batch')}
        >
          批量配音
        </button>
      </div>

      <div className="studio-selection">
        {/*
          没选键名时这一格**就是**操作指引 —— 不再单开一条提示说同一件事
          （选中之后它换成计数，位置不变，看的人不用重新找）。
        */}
        <span className="studio-selection-count">
          {selectedKeys.length === 0 ? (
            mode === 'single' ? (
              '在编辑器里点一个键名'
            ) : (
              '在编辑器里多选键名（Shift 或划框）'
            )
          ) : (
            <>
              已选 <span className="studio-num">{selectedKeys.length}</span> 个键
              <span className="studio-sep" aria-hidden>
                ·
              </span>
              已有配音 <span className="studio-num">{recordedCount}</span>
              <span className="studio-sep" aria-hidden>
                ·
              </span>
              待配 <span className="studio-num">{selectedKeys.length - recordedCount}</span>
            </>
          )}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="studio-mini"
          disabled={selectedKeys.length === 0}
          onClick={onClearSelection}
          title="清空已选键名（不改动配音）"
        >
          清空选择
        </button>
        <button
          type="button"
          className="studio-mini is-danger"
          disabled={selectedKeys.length === 0}
          onClick={() => onClearVoice(selectedKeys)}
          title="删除这些键已有的配音文件"
        >
          清除配音
        </button>
      </div>

      {selectedKeys.length > 0 && (
        <div className="studio-chips">
          {selectedKeys.map((key) => {
            const filled = hasVoice(key)
            return (
              <span
                key={key}
                className={`studio-chip${filled ? ' is-has-voice' : ''}`}
                title={
                  filled
                    ? `${key} · 已有配音（${library.resolvedPathOf(key) ?? ''}）`
                    : `${key} · 没有配音`
                }
              >
                <span className="studio-chip-mark" aria-hidden />
                {key}
              </span>
            )
          })}
        </div>
      )}

      <div className="studio-body">
        {sourceMode === 'tts' ? (
          <div className="studio-tts">
            <div className="studio-field">
              <label className="studio-field-label" htmlFor="studio-tts-plan">
                配音方案
              </label>
              <select
                id="studio-tts-plan"
                value={tts?.planName ?? ''}
                onChange={(event) => tts?.onPlanChange(event.target.value)}
                disabled={!tts || tts.plans.length === 0 || tts.busy}
              >
                {!tts || tts.plans.length === 0 ? (
                  <option value="">（没有配音方案）</option>
                ) : (
                  tts.plans.map((plan) => (
                    <option key={plan.name} value={plan.name}>
                      {plan.character}
                    </option>
                  ))
                )}
              </select>
              {tts?.onCreatePlan && (
                <button
                  type="button"
                  className="studio-mini"
                  disabled={tts.busy}
                  onClick={tts.onCreatePlan}
                  title="新建一份配音方案（一个说话人一份）"
                >
                  新建
                </button>
              )}
            </div>

            <div className="studio-field">
              <label className="studio-field-label" htmlFor="studio-tts-locale">
                语言方案
              </label>
              <select
                id="studio-tts-locale"
                value={tts?.locale ?? ''}
                onChange={(event) => tts?.onLocaleChange(event.target.value)}
                disabled={!tts || tts.locales.length === 0 || tts.busy}
              >
                {!tts || tts.locales.length === 0 ? (
                  <option value="">（这份方案没配语言）</option>
                ) : (
                  tts.locales.map((locale) => (
                    <option key={locale} value={locale}>
                      {locale}
                    </option>
                  ))
                )}
              </select>
            </div>

            {/* 生成中：进度 + 中断。长文本会切成好几块，没进度就只能干等 */}
            {tts?.busy && (
              <div className="studio-run">
                <div className="studio-run-head">
                  <span className="studio-run-text">
                    {tts.status.kind === 'busy' ? tts.status.message : '正在生成…'}
                  </span>
                  {tts.progress && (
                    <span className="studio-run-pct">
                      {Math.round(tts.progress.ratio * 100)}%
                    </span>
                  )}
                </div>
                <div
                  className={`studio-bar${tts.progress ? '' : ' is-indeterminate'}`}
                  role="progressbar"
                  aria-label="合成进度"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={tts.progress ? Math.round(tts.progress.ratio * 100) : undefined}
                >
                  <span
                    className="studio-bar-fill"
                    style={
                      tts.progress
                        ? { width: `${Math.round(tts.progress.ratio * 100)}%` }
                        : undefined
                    }
                  />
                </div>
                <div className="studio-run-foot">
                  <span className="studio-run-label">{tts.progress?.label ?? ''}</span>
                  {tts.onCancel && (
                    <button type="button" className="studio-mini" onClick={tts.onCancel}>
                      停止生成
                    </button>
                  )}
                </div>
              </div>
            )}

            {/*
              两级没选齐就不给生成 —— 而不是等点了才报错。
              这里只解释"缺的是哪一级、怎么补"，不重复页脚那句"按下去会怎样"。
            */}
            {!tts || tts.plans.length === 0 ? (
              <div className="studio-guide">
                <div className="studio-guide-title">没有配音方案</div>
                <p>配音方案一个说话人一份，里面写服务与音色。</p>
                {tts?.onCreatePlan && (
                  <button
                    type="button"
                    className="studio-mini is-primary"
                    onClick={tts.onCreatePlan}
                  >
                    新建配音方案
                  </button>
                )}
              </div>
            ) : !localeMatchesText && tts.locale ? (
              <div className="studio-guide is-warn">
                <div className="studio-guide-title">台词与语言不一致</div>
                <p>
                  台词是「{textLocale}」的，方案是「{tts.locale}」的 ——
                  先把语言切到「{tts.locale}」再生成。
                </p>
              </div>
            ) : tts.locales.length === 0 ? (
              <div className="studio-guide">
                <div className="studio-guide-title">这份方案没有语言</div>
                <p>按工程的语言表加一条。</p>
                {tts.onOpenPlan && (
                  <button type="button" className="studio-mini" onClick={tts.onOpenPlan}>
                    打开方案
                  </button>
                )}
              </div>
            ) : tts.planBlockedReason ? (
              <div className="studio-guide is-warn">
                <div className="studio-guide-title">这份方案还不能用</div>
                <p>{tts.planBlockedReason}</p>
                {tts.onOpenPlan && (
                  <button type="button" className="studio-mini" onClick={tts.onOpenPlan}>
                    打开方案
                  </button>
                )}
              </div>
            ) : tts.status.kind === 'error' ? (
              <div className="studio-note is-error" role="status">
                <div className="studio-note-title">{tts.status.message}</div>
                {tts.status.hint && <p className="studio-note-body">{tts.status.hint}</p>}
                {tts.status.failureKind === 'credential' && tts.onOpenCredentials && (
                  <button type="button" className="studio-mini" onClick={tts.onOpenCredentials}>
                    填写 API KEY
                  </button>
                )}
              </div>
            ) : tts.status.kind === 'done' ? (
              <div className="studio-note is-done" role="status">
                <div className="studio-note-title">{tts.status.message}</div>
              </div>
            ) : null}
          </div>
        ) : sourceMode === 'record' ? (
          <div className="studio-record">
            <div className="studio-record-target">
              {recordTarget ? (
                <>
                  <span className="studio-record-label">
                    {mode === 'single' ? '目标键' : '待录键'}
                  </span>
                  <code className="studio-record-key">{recordTarget}</code>
                  {mode === 'batch' && (
                    <span className="studio-record-queue">剩 {pendingKeys.length}</span>
                  )}
                </>
              ) : selectedKeys.length === 0 ? (
                <span className="studio-record-label">先选择键名</span>
              ) : (
                <span className="studio-record-label">选中的键都已有配音</span>
              )}
            </div>

            {/*
              台词：录音时要照着念的那一句。放在「开始录音」**上面** —— 按下按钮之前
              应该已经能看见词，而不是录到一半才去找。
            */}
            {recordTarget && (
              <div className="studio-record-script">
                <div className="studio-record-script-head">
                  <span>台词</span>
                  {library && (
                    <span className="studio-record-locale">{library.locale}</span>
                  )}
                </div>
                {recordText ? (
                  <p className="studio-record-line">{recordText}</p>
                ) : (
                  <p className="studio-record-line is-missing">
                    {`这个键${
                      library ? `在「${library.locale}」里` : '在当前语言里'
                    }还没有文本：先写上译文，再录`}
                  </p>
                )}
              </div>
            )}

            <div className="studio-record-controls">
              <button
                type="button"
                className={`studio-record-btn${recording ? ' is-recording' : ''}`}
                disabled={!recordTarget || !canRecordAudio()}
                onClick={() => {
                  if (recording) void stopRecording()
                  else void startRecording()
                }}
                title={
                  canRecordAudio()
                    ? undefined
                    : '当前环境不支持录音（没有 MediaRecorder / 麦克风接口）'
                }
              >
                <span className="studio-record-dot" aria-hidden />
                {recording ? '停止录音' : '开始录音'}
              </button>
              <span className="studio-record-clock" ref={clockRef}>
                0.0s
              </span>
              <span className="spacer" />
              {mode === 'batch' && (
                <label className="studio-record-auto">
                  <input
                    type="checkbox"
                    checked={autoContinue}
                    onChange={(event) => setAutoContinue(event.target.checked)}
                  />
                  自动录下一个
                </label>
              )}
            </div>

            <div className="studio-record-level">
              <div className="studio-record-level-fill" ref={levelRef} />
            </div>

            <div className="studio-take">
              <div className="studio-take-title">本次录音</div>
              {take ? (
                <div className="studio-take-body">
                  <div className="studio-take-time">
                    <button
                      type="button"
                      className="voice-play studio-play"
                      onClick={togglePlay}
                      title={playing ? '暂停 / 继续' : '试听这条录音'}
                    >
                      <VoiceGlyph
                        parts={
                          playing && !progress?.paused
                            ? VOICE_EXTRA_GLYPHS.pause
                            : VOICE_EXTRA_GLYPHS.play
                        }
                      />
                    </button>
                    <span>
                      {memoryStatus === 'failed'
                        ? '解不开'
                        : memoryInfo
                          ? formatVoiceDuration(memoryInfo.duration)
                          : '解码中…'}
                    </span>
                    <span className="spacer" />
                    <button
                      type="button"
                      className="studio-mini"
                      onClick={() => setMemory(null)}
                    >
                      重录
                    </button>
                    {/* 只有批量才有"跳过这个键"可言：单选就一个目标，跳过等于没目标 */}
                    {mode === 'batch' && (
                      <button
                        type="button"
                        className="studio-mini"
                        disabled={!recordTarget}
                        onClick={() => {
                          if (!recordTarget) return
                          setSkipped((prev) =>
                            prev.includes(recordTarget)
                              ? prev
                              : [...prev, recordTarget],
                          )
                          setMemory(null)
                        }}
                      >
                        跳过这个键
                      </button>
                    )}
                  </div>
                  <div className="studio-take-wave">
                    {memoryInfo ? (
                      <VoiceWaveform
                        peaks={memoryInfo.peaks}
                        progress={playedRatio}
                      />
                    ) : (
                      <VoiceEmptyGlyph />
                    )}
                  </div>
                </div>
              ) : (
                <div className="studio-take-empty">
                  {recording
                    ? '正在收音 —— 说完点「停止录音」'
                    : mode === 'single'
                      ? '点「开始录音」录一条'
                      : '点「开始录音」；确认后自动接下一个'}
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            {/*
              预览窗：波形 + 拖拽投放。
              拖放**自己接**（`waveDropProps`）：丢在这一格上就是丢给它，亮起与承接都在
              这里；面板根那层是"拖到了录音棚别处"的宽目标，见 `dropTargetProps`。
            */}
            <div
              className={`studio-wave${audioInfo ? ' is-filled' : ' is-empty'}${
                dropActive ? ' is-drop-target' : ''
              }`}
              title={
                sourceMode === 'ref'
                  ? '在下面的资源树里选一份工程内的音频资产，再点「确认引用」'
                  : '把音频文件，或资源管理器里的资产，拖到这里（或录音棚任意位置）即可当候选音频，再点「确认导入」'
              }
              {...dropPropsIfAny(waveDropProps)}
            >
              {audioInfo ? (
                <VoiceWaveform peaks={audioInfo.peaks} progress={playedRatio} />
              ) : memoryStatus === 'failed' ? (
                <div className="studio-wave-loading">
                  <VoiceEmptyGlyph />
                  <span>这个文件解不开</span>
                </div>
              ) : source ? (
                <div className="studio-wave-loading">
                  <VoiceEmptyGlyph />
                  <span>解码中…</span>
                </div>
              ) : (
                <VoiceEmptyGlyph />
              )}
              {dropActive && (
                <div className="voice-wave-scrim">
                  <span>松开即可选用</span>
                </div>
              )}
            </div>

            {/* 点选入口：拖放被窗口层拦住时的兜底（与拖入同一条路）。
                引用方式不显示它 —— 外部文件没有包内路径，指不了。 */}
            {sourceMode !== 'ref' && (
              <div className="studio-source-row">
                <button
                  type="button"
                  className="studio-mini"
                  onClick={() => fileInputRef.current?.click()}
                  title="从本机挑一个音频文件当候选音频（拖放被系统拦住时用这个）"
                >
                  选择文件…
                </button>
                <input
                  ref={fileInputRef}
                  className="studio-file-input"
                  type="file"
                  accept="audio/*"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    // 先清空：同一个文件再选一次也要能触发 change
                    event.target.value = ''
                    if (file) cacheDroppedFile(file)
                  }}
                />
              </div>
            )}

            {/* 播放与进度条控制（有选定音频才显示） */}
            {source && (
              <div className="studio-player">
                <button
                  type="button"
                  className="voice-play studio-play"
                  onClick={togglePlay}
                  title={playing ? '暂停 / 继续' : '播放候选音频'}
                >
                  <VoiceGlyph
                    parts={
                      playing && !progress?.paused
                        ? VOICE_EXTRA_GLYPHS.pause
                        : VOICE_EXTRA_GLYPHS.play
                    }
                  />
                </button>
                <span className="studio-player-time">
                  {formatVoiceDuration(progress?.current ?? 0)}
                </span>
                <div
                  className="studio-progress"
                  role="slider"
                  aria-label="播放进度"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(playedRatio * 100)}
                  onPointerDown={(event) => {
                    event.currentTarget.setPointerCapture(event.pointerId)
                    seekFromEvent(event)
                  }}
                  onPointerMove={(event) => {
                    if (event.buttons !== 1) return
                    seekFromEvent(event)
                  }}
                >
                  <div
                    className="studio-progress-fill"
                    style={{ width: `${Math.round(playedRatio * 100)}%` }}
                  />
                </div>
                <span className="studio-player-time">
                  {formatVoiceDuration(progress?.duration ?? audioInfo?.duration ?? 0)}
                </span>
                <button
                  type="button"
                  className="studio-mini"
                  onClick={() => library.stop()}
                  title="停止试听"
                >
                  停止
                </button>
              </div>
            )}

            {/* 音频信息栏目 */}
            <div className="studio-info">
              <div className="voice-row">
                <span className="voice-row-label">音频路径</span>
                <span
                  className="voice-row-value"
                  title={sourcePathLabel ?? undefined}
                >
                  {sourcePathLabel ?? '未选择'}
                </span>
              </div>
              <div className="voice-row">
                <span className="voice-row-label">音频时长</span>
                <span className="voice-row-value">
                  {audioInfo ? formatVoiceDuration(audioInfo.duration) : '—'}
                </span>
              </div>
              <div className="voice-row">
                <span className="voice-row-label">音频格式</span>
                <span className="voice-row-value">
                  {sourceFormat ?? '—'}
                </span>
              </div>
              <div className="voice-row">
                <span className="voice-row-label">声道</span>
                <span className="voice-row-value">
                  {audioInfo ? formatVoiceChannels(audioInfo.channels) : '—'}
                </span>
              </div>
              {source?.kind === 'memory' && (
                <div className="voice-row">
                  <span className="voice-row-label">大小</span>
                  <span className="voice-row-value">
                    {formatBytes(source.size)} · 尚未写入工程
                  </span>
                </div>
              )}
            </div>

            {/* 候选音频：搜索 + 资源树（见 studio/VoiceAssetBrowser） */}
            <VoiceAssetBrowser
              library={library}
              query={query}
              onQueryChange={setQuery}
              selected={picked}
              onSelect={(entry) => {
                setPicked(entry.path)
                setMemory(null)
                setNotice(null)
              }}
              isTarget={(path) =>
                importTargets.length === 1 &&
                library.resolvedPathOf(importTargets[0]) === path
              }
            />
          </>
        )}
      </div>

      {notice && (
        <div className="studio-notice" role="status">
          {notice}
        </div>
      )}

      <footer className="studio-footer">
        {/*
          上拉框 = 配音方式选择器。**单选 / 批量都有** —— 单选同样要能选
          TTS 与录音（需求如此），三方式共用同一套实现，只是目标键集合不同。
          它始终排在「确认导入」上方，确认导入仍是面板最底部的元素。
        */}
        <div className="studio-picker">
          <button
            type="button"
            className="studio-picker-trigger"
            aria-haspopup="listbox"
            aria-expanded={sourceMenuOpen}
            title={sourceModeTitle(mode, sourceMode)}
            onClick={() => setSourceMenuOpen((open) => !open)}
          >
            <span className="studio-picker-caption">配音方式</span>
            <span className="studio-picker-label">{sourceLabel}</span>
            <span className="studio-picker-caret" aria-hidden>
              ▴
            </span>
          </button>
          {sourceMenuOpen && (
            <>
              <div
                className="studio-picker-scrim"
                onClick={() => setSourceMenuOpen(false)}
              />
              <ul className="studio-picker-menu" role="listbox">
                {SOURCE_MODES.map((value) => (
                  <li key={value}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={value === sourceMode}
                      className={value === sourceMode ? 'is-on' : ''}
                      title={sourceModeTitle(mode, value)}
                      onClick={() => {
                        setSourceMenuOpen(false)
                        onSourceModeChange(value)
                      }}
                    >
                      {sourceModeLabel(mode, value)}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        <div className="studio-footer-hint">{confirmHint}</div>
        <button
          type="button"
          className={`studio-confirm${confirmTts ? ' is-tts' : ''}${
            confirmRecord ? ' is-record' : ''
          }`}
          disabled={!canConfirm}
          onClick={handleConfirm}
          /* 灰掉的按钮也要能问出"为什么灰" —— 否则用户只能猜 */
          title={canConfirm ? undefined : confirmHint}
        >
          {confirmLabel}
        </button>
      </footer>
    </section>
  )
}
