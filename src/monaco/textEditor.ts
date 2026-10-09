import type { Monaco } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import {
  createLocaleKeyFromText,
  isLocaleKey,
  normalizeLocaleKey,
  type TextMap,
} from '../i18n/textMap'
import { stopParseLineOf } from '../hanshu/directives'
import { blockCloserLine } from '../hanshu/hsSyntaxRules'
import { createCaretOverlay, type CaretLine } from './textCaretOverlay'
import {
  boxLineAt,
  isDeletionHittingKey,
  deletionRange,
  collectKeyedRegions,
  clampOffset,
  exitCaretTarget,
  exitLineFor,
  hitCaretBox,
  isPressEcho,
  isSameSpot,
  keyReplacementFor,
  lineIndexOfOffset,
  lineStartOffset,
  lineXForOffset,
  offsetAtLineX,
  pickRedone,
  pickUndone,
  slotAtX,
  snapTarget,
  statementLineRange,
  atomicRegion,
  type LineSlot,
  type PressEcho,
  type TextRange,
  type MigrationRecord,
} from './textKeyRules'
import {
  createSlotStyles,
  createTextWidthMeter,
  SLOT_CLASS,
} from './textSlotStyles'
import {
  VOICE_STATE_LABEL,
  formatVoiceButtonSvg,
  type VoiceButtonState,
} from '../ui/voiceIcons'
import type { VoiceLibrary, VoiceUnitStatus } from '../i18n/voiceLibrary'
import { formatVoiceDuration } from '../i18n/voiceRuntime'
import {
  currentDrag,
  endDrag,
  hasExternalFiles,
  readDragPayload,
  resolveDropIntent,
  shouldAcceptDrop,
  writeDragPayload,
  type DragSource,
  type DropIntent,
} from '../drag/dragPayload'
import {
  findSpanAt,
  parseTextSpans,
  type TextSpan,
} from './textSpans'
import type { CharDiagnostic } from './charDiagnostics'
import { diagnosticSymbolClass } from './diagnosticSymbol'
import { analyzeHsDiagnostics, type HsDiagnostic } from './hsDiagnostics'

/**
 * 编辑器内的本地化文本渲染 / 交互 / 自动成键。
 *
 * 渲染是「渲染级替换」：文档一个字都不改，只改动原文的占位宽度。
 * - 原文键名与紧随的 `//` 都被隐藏，并改造成「宽度 = 渲染长度」的槽位
 *   （见 textSlotStyles），因此同一行后面的标点会紧贴渲染文本
 * - 那个宽度是**实测像素值**：按当前字体量显示文本，不是「全角 = 2ch」那种列数推算
 *   （ch 是「0」的宽度，Consolas 0.5498em ≠ 0.5em，推算会让中文框越拉越长）
 * - 显示值画在覆盖层 `.hs-lang-layer` 的 `.hs-lang-line` 里：整个值（含真换行）
 *   是**一个连续框**，框高 = 行数 × 行高 − 缝隙；值多于一行时多出来的高度由
 *   **ViewZone** 真实占位（zone 本身是空元素），把后面的行往下推
 * - 紧跟片段的 `//` 由 `.hs-lang-tail` 重画在框右侧的**首行**（框外）
 * - 定位量的是槽位的真实矩形（Monaco 的列坐标是算术推导，与渲染宽度已不一致）
 * - 不按 Ctrl：命中=半透明黄底、缺失=半透明红底，鼠标悬停时底色加深
 * - 按住 Ctrl：显示原始键名 + 蓝色虚线框
 * - 光标落在片段内时由 textCaretOverlay 接管（原生光标会停在不可见的原文列上）
 *
 * 交互：点击框 = 覆盖弹出编辑框（Ctrl=改键名，否则=改映射值）。
 * 编辑框是**沉浸式**的：与黄底框等大、贴着文字，光标在两者之间连续流动 ——
 * - 光标贴着框（框内 / 两侧框沿，见 `hitCaretBox`）就自动打开编辑框，
 *   插入点按"框内比例 → 横向像素 → 最近的字符边界"预判，点击同理（点哪插哪）
 * - 方向键在编辑框边缘再往外挪 = 出框：左右在框外**多走一步**（`exitCaretOffset`），
 *   上下按框内横向位置预判到上一行 / 下一行（落在别的框上就直接打开那个框）
 * - Esc 回到进编辑框之前的光标处；提交后停在框外一步
 *
 * 自动成键（详见 textKeyRules）：
 * - 只有带 `//` 终结的可本地化文本才成键；文本还不是 8 位键名时生成无冲突随机键名，
 *   写入映射并把原文替换成键名
 * - 打字触发的路径会跳过"光标还在里面"的语句，等光标离开整条语句再成键
 * - 成键后框是原子单位：光标整体跳过，删除只"蹭到"框时无响应
 * - 撤销 / 重做时按"键名是否还在正文里"回收 / 放回映射条目
 */

export type TextRect = {
  left: number
  top: number
  width: number
  height: number
}

export type TextEditMode = 'key' | 'value'

/** 从编辑框里向外挪的方向（上下左右都要能出去） */
export type TextEditExitDirection = 'left' | 'right' | 'up' | 'down'

/** 提交方式：回车提交要把焦点还给编辑器，点外面提交则不能抢焦点 */
export type TextEditCommitReason = 'enter' | 'outside'

/** 编辑框里的实时状态：出框预判要用（多行值的第几行、行内横向位置） */
export type TextEditInputState = {
  /** 输入框此刻的文本（编辑后的，可能与 initial 不同） */
  text: string
  /** 输入框此刻的插入位置 */
  caretIndex: number
  /**
   * 输入框自己的横向滚动量。值被编辑得比框还长时输入框会内部滚动，
   * 这时"插入位置对应的像素"要减掉它，否则上下出框的横向基准是偏的。
   */
  scrollLeft?: number
}

/**
 * 与编辑器逐像素对齐所需的字体信息（取自框的 computed style，见 `fontOfBox`）。
 * 编辑框要"和黄底同等大小、都贴着文字"，文字基线就必须和框里那行字完全一致，
 * 所以这里不写死，一律照抄框上算出来的值。
 */
export type TextEditFont = {
  family: string
  size: string
  weight: string
  letterSpacing: string
  featureSettings: string
  variationSettings: string
  /** 编辑器行高（px）：输入的可见高度按它给，框与输入才会逐行对齐 */
  lineHeightPx: number
}

/**
 * 编辑框此刻该待在哪（**视口**坐标）。
 *
 * 编辑框是 `position: fixed` 贴上去的，位置只在打开那一刻量一次；编辑器一滚 / 一改布局，
 * 覆盖层的框跟着正文走、编辑框却钉在原地 —— 所以编辑器在滚动、布局变化后把新位置推给
 * 订阅者（见 TextEditRequest.subscribeSpot）。
 */
export type TextEditSpot = {
  left: number
  top: number
  /** 框还在编辑器的可视区里吗：滚出去后编辑框隐身，但**不卸载**（卸载会丢输入焦点） */
  visible: boolean
  /** 编辑器可视区（视口坐标）：编辑框超出它的部分要裁掉，免得盖到工具栏 / 底栏上 */
  clip?: TextRect
}

export type TextEditRequest = {
  mode: TextEditMode
  /** 被编辑的键名 */
  key: string
  /** 编辑框初始值（改键名=键名本身；改值=映射值，缺失为空串） */
  initial: string
  /** 视口坐标（position: fixed 覆盖用）：**就是黄底框自己的矩形**，编辑框与它等大 */
  rect: TextRect
  /** 初始插入位置（不传：改键名=全选，改值=末尾） */
  caretIndex?: number
  /** 与框逐像素对齐用的字体（不传时用样式表默认值） */
  font?: TextEditFont
  /** 值是空的（缺失 / 空串）时输入框的占位文本：框里显示的是键名，编辑框照抄 */
  placeholder?: string
  /**
   * 订阅"编辑框现在该待在哪"：滚轮 / 布局变化后由编辑器推新位置，返回取消订阅。
   *
   * 订阅一挂上就先同步推一次当前位置（框可能已经被 render 重新锚过），所以订阅者拿到的
   * 永远是最新的，不会先闪一下旧位置。位置推的是**只有 left / top / visible**：
   * 宽高锁死 —— 字形量测、占位加宽都在打开那一刻算完，中途变尺寸会让文字重排、与框错开。
   *
   * 为什么不把位置塞回上层 React 的编辑态：滚动时每帧都在变，让整个工作区跟着重渲染太亏；
   * 订阅只重渲染那个小输入框。
   */
  subscribeSpot?(onSpot: (spot: TextEditSpot) => void): () => void
  /**
   * 编辑框外按下时先问一句："这一点按在**另一个键框**上了吗？"
   *
   * 是就返回一个回调：调用方照旧提交当前这份（点外面本来就是提交），提交完再调它，
   * 编辑目标就切过去了 —— 不用点第二次（现在点第二次的毛病是：只脱出、不进新框）。
   * 返回 null = 不是（点了空白 / 行尾 / 配音按钮，或者点的就是正在编辑的这个框），
   * 调用方照旧当"点了外面"处理。
   *
   * 为什么现在就返回回调、而不是让调用方稍后自己按坐标找：提交当前编辑会让正文重排、
   * 框整体挪位，等会儿同一坐标底下可能已经换了另一条 —— 所以 key 和插入位置在按下
   * 这一刻就量好（回调里按 key 重新找活着的元素，见 grabBoxAt 实现）。
   *
   * 注意回调只是**排进切换队列**，真正开框要等这一按抬起来（见 pendingSwitch）：
   * 按下就开的话，紧接着的 mousedown 会把焦点从刚聚焦的输入框抢走 —— 新框里没光标。
   */
  grabBoxAt?(clientX: number, clientY: number): (() => void) | null
  /** 提交：改键名→替换正文里的键；改值→写入映射 */
  apply(next: string, reason: TextEditCommitReason): void
  /** 取消（Esc）：光标回到进编辑框之前的位置 */
  cancel(): void
  /**
   * 方向键在编辑框边缘继续向外挪：离开编辑框，并把 Monaco 光标预判到框外
   * （左右 = 框沿再往外一步；上下 = 按框内横向位置换行）。
   * 返回**是否真的出框了** —— 外面没地方去（框贴文档头 / 尾、已经在首行末行、
   * 预判落点还是原地）时返回 false，调用方要把这一按当无事发生、编辑框留着。
   */
  exit(direction: TextEditExitDirection, input: TextEditInputState): boolean
}

/** 上级容器右键：请求弹出可扩展菜单 */
export type TextUnitMenuRequest = {
  /** 被右键的键名 */
  key: string
  /** 视口坐标（菜单按它摆位） */
  x: number
  y: number
}

/** 上级容器被投放：意图已经解析好（外部文件导入音频 / 资产导入音频 / 另一个键名替换） */
export type TextUnitDropRequest = {
  key: string
  intent: DropIntent
  /** 外部文件（intent.action === 'import-audio-file' 时有） */
  files: File[]
  /** 内部载荷（资产 / 键名） */
  source: DragSource | null
}

export type TextHost = {
  /** 当前活动文件的语言文本映射；不适用（非可本地化源、无活动文件、看资产）时返回 null */
  getMap(): TextMap | null
  /**
   * 可本地化片段解析；默认 `.hs` 的 `parseTextSpans`。
   * `.char` 等应传入对应解析器。
   */
  parseSpans?(source: string): TextSpan[]
  /**
   * 语法诊断；默认 `.hs`。传入 `parseCharTextSpans` 时应同时传 char 诊断。
   */
  analyzeDiagnostics?(
    source: string,
  ): Array<HsDiagnostic | CharDiagnostic>
  /** 请求弹出等位置覆盖编辑框 */
  onEditRequest(request: TextEditRequest): void
  /** 音频映射管理；非可本地化源 / 尚未就绪时返回 null（按钮一律渲染成"缺失"） */
  getVoice?(): VoiceLibrary | null
  /** 上级容器被右键 */
  onUnitMenu?(request: TextUnitMenuRequest): void
  /** 上级容器被投放（拖拽） */
  onUnitDrop?(request: TextUnitDropRequest): void
  /** 点了配音按钮但当前是缺失 / 无效态：请求打开录音棚编辑这个键的音频 */
  onEditVoice?(key: string): void
  /**
   * **录音棚模式**下左键点了某个键名（或缺失态下点了它的配音按钮）。
   * `additive` = 按住 Shift / Ctrl / Cmd（多选）。
   */
  onUnitSelect?(request: TextUnitSelectRequest): void
  /** 录音棚模式下划框选中了一批键（框在空白处松开且没拖动时 keys 为空 = 清空） */
  onMarquee?(request: TextMarqueeRequest): void
}

/** 录音棚模式下点选一个键名 */
export type TextUnitSelectRequest = {
  key: string
  /** 追加到已选集合（否则替换） */
  additive: boolean
}

/** 录音棚模式下划框选中 */
export type TextMarqueeRequest = {
  /** 落在框内的键名（正文顺序） */
  keys: string[]
  additive: boolean
}

export type TextBinding = {
  /** 外部状态变化（换语言 / 换文件 / 映射内容变）时重算 */
  refresh(): void
  /** 只重画覆盖框、不动文档：配音播放态 / 解码结果变化时用 */
  refreshVoice(): void
  /** 右键菜单用：按键名打开「改键名 / 改文本」编辑框 */
  editUnit(key: string, mode: TextEditMode): void
  /** 右键菜单用：删除该键的原子范围（键名 + 它自己的那个 `//`） */
  deleteUnit(key: string): void
  /** 拖拽"替换键名"用：把目标键的原文换成另一个键名 */
  replaceUnitKey(targetKey: string, nextKey: string): void
  /**
   * 录音棚模式开关：开着的时候左键=选中键名、按住 Shift 多选、长按拖动=划框，
   * 并且**不再**打开编辑框 / 右键菜单（常规编辑器交互被禁用）。
   */
  setStudioMode(on: boolean): void
  /** 录音棚：设置"已选中的键名"（覆盖层据此画高亮） */
  setStudioSelection(keys: readonly string[]): void
  /** 录音棚：正文里出现的全部键名（按出现顺序、去重） */
  listKeys(): string[]
  dispose(): void
}

const LAYER_CLASS = 'hs-lang-layer'
const LINE_CLASS = 'hs-lang-line'
const ROW_CLASS = 'hs-lang-row'
const BOX_CLASS = 'hs-lang-box'
const TAIL_CLASS = 'hs-lang-tail'
const ZONE_CLASS = 'hs-lang-zone'
/**
 * 上级容器：包住「文本 + 配音按钮」，原子化的责任在它身上 ——
 * 右键菜单、拖拽拦截、左键打开编辑框都挂这里，文本框只负责显示。
 */
const UNIT_CLASS = 'hs-lang-unit'
/** 配音按钮（正方形，和文本等高） */
const VOICE_CLASS = 'hs-lang-voice'
const VOICE_STATE_CLASS: Record<VoiceButtonState, string> = {
  missing: 'hs-voice-missing',
  invalid: 'hs-voice-invalid',
  ready: 'hs-voice-ready',
  playing: 'hs-voice-playing',
}
const MIGRATE_DEBOUNCE_MS = 220
/** 投放高亮（框式）：容器与资源管理器的目录行共用 */
const DROP_TARGET_CLASS = 'is-drop-target'
/** 拖拽落点光标（键名拖到文本区时的插入点指示） */
const DROP_CARET_CLASS = 'hs-lang-drop-caret'
/** 原子单位被文档选区命中（多行值要由覆盖层补底色，见 syncUnitSelection） */
const SELECTED_CLASS = 'is-selected'
/**
 * 编辑框打开期间挂在被覆盖的那个框上：框里的文字藏掉（底色留着），
 * 免得和输入框里的字重影 —— 编辑框与框等大、都贴着文字，重影会立刻看出来。
 */
const EDITING_CLASS = 'is-editing'
/** 编辑器失焦：选区底色换成 vs-dark 的"非活动选区"色 */
const UNFOCUSED_CLASS = 'is-unfocused'
/** 录音棚：该键名被选中（与文档选区无关，是录音棚自己的集合） */
const STUDIO_SELECTED_CLASS = 'is-studio-selected'
/** 录音棚模式：挂在编辑器根节点上（换光标、禁文本选区等） */
const STUDIO_MODE_CLASS = 'hs-studio-mode'
/** 录音棚划框时画的选框（纯视觉，pointer-events 已被 layer 关掉） */
const MARQUEE_CLASS = 'hs-lang-marquee'
/** 划框的最小位移：小于它算"点了一下空白处"（清空选择） */
const MARQUEE_MIN_DRAG_PX = 4

/**
 * 片段集合的指纹：`起始偏移:结束偏移:值` 拼起来。
 *
 * 用途：编辑后判断"只重摆位置"是否安全。**绝不能**用行数变化之类的粗判据 ——
 * 行数不变但键被删掉（选中行内文本删除、删最后一行）时，上一次渲染留下的
 * `span.start` 已经越界，而 `model.getPositionAt` 不会报错、会**夹到文档末尾**，
 * 于是幽灵框会闪现在最后一行最左侧。指纹一变就重建，`positionBoxes` 就永远
 * 拿不到过期片段。
 */
export function computeSpanFingerprint(
  spans: ReadonlyArray<{ start: number; end: number; value: string }>,
): string {
  return spans.map((span) => `${span.start}:${span.end}:${span.value}`).join('|')
}
/** 框底留出的空隙，避免相邻行的框交叉 */
const BOX_GAP_PX = 3
/**
 * 配音按钮的边长（固定正方形）。
 * 不跟文本等高：文本可能有多行，按钮只需要在文本的**垂直中央**右侧，
 * 所以尺寸固定、由 CSS 的 `align-items: center` 摆在中间。
 */
const VOICE_BUTTON_PX = 22

/**
 * 按钮与文本框之间的间距（由 TS 写在按钮的内联样式上，样式表不再声明，
 * 这样"槽位要留多宽"和"按钮实际占多宽"只有一个来源）。
 */
const VOICE_BUTTON_GAP_PX = 6

/**
 * 尾标 `//` 与容器之间的间距。
 * 同样只在这里定义：内联给尾标、并计入它的槽位宽度（槽位按**尾标实际宽度**留），
 * 否则 `//` 后面的正文会从按钮右沿开始、压在尾标上。
 */
const TAIL_GAP_PX = 2

/** 尾标的文字（测量槽位宽度与创建元素都用它，避免两处写死） */
const TAIL_TEXT = '//'

/**
 * 原子单位比文本框多出来的宽度（间距 + 按钮）。
 *
 * 文档里的槽位宽度必须按**整个单位**算：Monaco 的原生选区是按这个区间绘制的，
 * 只算文本框的话蓝色选中范围会正好短一个按钮宽（光标判定同理）。
 */
const VOICE_SLOT_EXTRA_PX = VOICE_BUTTON_PX + VOICE_BUTTON_GAP_PX

/** 一行覆盖框：形状即 textCaretOverlay 需要的输入，另加一个用于移除的根节点 */
/** 一次自动成键写进映射的条目（撤销时要能原样回收 / 重做时放回） */
type LineEntry = CaretLine & { el: HTMLElement }
type ZoneEntry = {
  /** 纯占位元素：视觉一律走覆盖层，见 render() 里的注释 */
  el: HTMLElement
  span: TextSpan
  heightPx: number
  id: string
}

export function bindText(
  ed: editor.IStandaloneCodeEditor,
  monaco: Monaco,
  host: TextHost,
): TextBinding {
  const collection = ed.createDecorationsCollection([])
  const domNode = ed.getDomNode()
  const layer = document.createElement('div')
  layer.className = LAYER_CLASS
  domNode?.appendChild(layer)
  // 覆盖层按编辑器左上角定位：Monaco 自带 `.monaco-editor{position:relative}`，
  // 万一站位不对（static）就补一个，保证绝对定位的参照系是编辑器本身。
  if (
    domNode &&
    typeof window.getComputedStyle === 'function' &&
    window.getComputedStyle(domNode).position === 'static'
  ) {
    domNode.style.position = 'relative'
  }
  ed.applyFontInfo(layer)

  let lineEntries: LineEntry[] = []
  let zoneEntries: ZoneEntry[] = []
  /** 上次渲染时片段集合的指纹（编辑后据此判断能否只重摆位置） */
  let renderedFingerprint = ''
  /** 自动成键写下的条目；被撤销的挪进 redoLog，重做时放回 */
  let migrationLog: MigrationRecord[] = []
  let redoLog: MigrationRecord[] = []
  /** 光标"整体跳过框"的辅助状态（开不了编辑框时的兜底） */
  let snapping = false
  let snapTimer: number | null = null
  let lastArrowDir: 'left' | 'right' | null = null
  let lastCaretOffset: number | null = null
  /** 上一次光标所在行：上下键贴到框上时判断"从上面还是下面进来" */
  let lastCaretLine: number | null = null
  /**
   * 程序化搬运光标的"跳过一格"：光标落到这一格时不算"贴上框"，不回吸。
   * 只给内部搬运用（Esc 复位 / 提交落点 / 自动成键后的偏移补偿），
   * 用户自己按键出的框不设防 —— 那样落点若压在别的框上，正好顺势打开那个框。
   */
  let caretGuardOffset: number | null = null
  /**
   * 编辑框打开期间被覆盖的那个框（`is-editing` 挂在它身上）。
   * `render()` 会重建所有框，所以每次重画都要按 key 重新挂上，见 syncEditingBox。
   * `showKey` 是打开那一刻框的显示方式 —— 编辑期间**锁死**：
   * Ctrl 中途按下 / 松开不能让框改宽度（槽位宽度跟着变，后面的正文会整体挪位，
   * 编辑框还停在旧位置上，与框错开）。
   */
  let activeEdit: {
    key: string
    showKey: boolean
    /** 当前渲染出来的那个框（元素会被 render 换掉，见 syncEditingBox） */
    el: HTMLElement | null
    /** 进编辑框之前的光标位置：Esc 复位用 */
    returnOffset: number
  } | null = null
  /**
   * 编辑框位置的订阅者（见 TextEditRequest.subscribeSpot）。同一时刻最多一个编辑框，
   * 所以只留一个回调；关框（clearEditingBox）时立刻摘掉，避免上一个框还收到推送。
   */
  let spotListener: ((spot: TextEditSpot) => void) | null = null
  /** 上一次推过的位置：位置没变就不推（滚动时每帧都会走到 reportEditSpot） */
  let lastSpot: TextEditSpot | null = null
  /**
   * 刚由"点别的框 → 切编辑目标"按下过：同一按还会冒出个 click（见 isPressEcho）。
   * 提交已经把正文重排了一遍，同一坐标底下可能换成别的框了 —— 那一下要吃掉，
   * 否则会出现"点了 B 却开出 C"。新的一次 pointerdown 就作废。
   */
  let pressEcho: PressEcho | null = null
  /**
   * 待执行的"点别的框 → 切编辑目标"（见 grabBoxAt）：按下那一刻记好目标与落点，
   * **等这一按抬起来再开框**。
   *
   * 为什么不在按下时就开：开框要聚焦输入框，而这一按后面还跟着 mousedown ——
   * 点不可聚焦的 div，浏览器默认把焦点丢给 body（编辑框当场失焦 = 框里没光标、
   * 字也打不进去），落在 Monaco 正文上时更是 Monaco 自己抢焦点。
   * 抬起来再开，挂载时的聚焦就是最后一手，谁也抢不走；拖拽手势也照旧
   * （一拖就在 dragstart 里作废这次切换）。
   */
  let pendingSwitch: { x: number; y: number; open: () => void } | null = null
  /** 按 model 版本缓存解析结果（光标移动也要查片段表） */
  let spanCache: { version: number; spans: TextSpan[] } | null = null
  let ctrlHeld = false
  /**
   * 物理按键态。编辑框开着时 Ctrl 只记在这里，等编辑结束才落到渲染上（见 flushCtrlRender）：
   * 渲染态一切换，所有框都要在「译文 / 键名」之间改宽度、整篇正文跟着重排，
   * 而编辑框是按打开那一刻的矩形贴上去的（position: fixed）—— 一按 Ctrl 就留在原地、跟框错开。
   */
  let ctrlRaw = false
  let migrating = false
  let disposed = false
  let timer: number | null = null
  let frame: number | null = null
  /** 录音棚模式：左键=选中、Shift=多选、长按拖动=划框（常规交互被禁用） */
  let studioMode = false
  /** 录音棚已选中的键名（覆盖层据此画高亮；渲染时读它） */
  let studioSelection = new Set<string>()

  /** 单行行高（来自编辑器字体信息） */
  const lineHeightPx = (): number => {
    const info = ed.getOption?.(monaco.editor.EditorOption.fontInfo)
    const value = Number(info?.lineHeight)
    return Number.isFinite(value) && value > 0 ? value : 28
  }

  /** 文档里原文的占位槽位（宽度 = 渲染长度），见 textSlotStyles */
  const slotStyles = createSlotStyles()
  /** 编辑器字体指纹：字体 / 字号一变，量出来的宽度就得重算 */
  const fontKey = (): string => {
    const info = ed.getOption?.(monaco.editor.EditorOption.fontInfo)
    if (!info) return 'default'
    return [
      info.fontFamily,
      info.fontWeight,
      info.fontSize,
      info.fontFeatureSettings,
      info.fontVariationSettings,
      info.letterSpacing,
      info.lineHeight,
    ].join('|')
  }
  /** 文本宽度实测：槽位与框共用同一份宽度（覆盖层已经带了编辑器字体，量它最准） */
  const meter = createTextWidthMeter({
    host: () => layer,
    fontKey,
    fallbackFontSize: () => {
      const size = Number(
        ed.getOption?.(monaco.editor.EditorOption.fontInfo)?.fontSize,
      )
      return Number.isFinite(size) && size > 0 ? size : 18
    },
  })
  /** 光标落在片段内时接管原生光标，见 textCaretOverlay */
  const caretOverlay = createCaretOverlay({
    ed,
    domNode,
    // 被藏起来的条目（偏移越界的兜底）不参与：否则会按 0 尺寸在左上角画出光标
    getLines: () => lineEntries.filter((entry) => entry.el.style.display !== 'none'),
    isCtrlHeld: () => ctrlHeld,
    // 编辑框开着时它自己画光标，自绘光标让位
    isSuppressed: () => activeEdit != null,
    lineHeightPx,
    // 与尾标内联间距同源，见 TAIL_GAP_PX
    tailGapPx: TAIL_GAP_PX,
  })

  const currentSpans = (): TextSpan[] => {
    const model = ed.getModel()
    if (!model) return []
    // 光标移动也要查片段表，按 model 版本缓存，避免每次按键都重解析全篇
    const version =
      typeof model.getVersionId === 'function' ? model.getVersionId() : -1
    if (version >= 0 && spanCache && spanCache.version === version) {
      return spanCache.spans
    }
    const parse = host.parseSpans ?? parseTextSpans
    const spans = parse(model.getValue())
    if (version >= 0) spanCache = { version, spans }
    return spans
  }

  /** 按 offset 换算覆盖框的视口矩形（需要时取元素本身的矩形） */
  const rectForSpan = (
    span: TextSpan,
    element: HTMLElement | null,
  ): TextRect => {
    if (element && typeof element.getBoundingClientRect === 'function') {
      const rect = element.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        return {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        }
      }
    }
    const model = ed.getModel()
    if (model && domNode) {
      const a = ed.getScrolledVisiblePosition(model.getPositionAt(span.start))
      const b = ed.getScrolledVisiblePosition(model.getPositionAt(span.end))
      if (a && b) {
        const base = domNode.getBoundingClientRect()
        return {
          left: base.left + a.left,
          top: base.top + a.top,
          width: Math.max(b.left - a.left, 48),
          height: a.height,
        }
      }
    }
    return { left: 120, top: 120, width: 220, height: 24 }
  }

  /** 已成键的框 + 它的片段：光标进出要拿片段算预判（行号、原子范围） */
  const keyedBoxes = (): Array<{ region: TextRange; span: TextSpan }> =>
    currentSpans()
      .filter((span) => normalizeLocaleKey(span.value))
      .map((span) => ({ region: atomicRegion(span), span }))

  /** 文本里第 line 行的内容（越界夹到首 / 末行） */
  const lineTextAt = (text: string, line: number): string => {
    const start = lineStartOffset(text, line)
    const end = text.indexOf('\n', start)
    return text.slice(start, end === -1 ? text.length : end)
  }

  /** 一行文本里，插入位置 indexInLine 相对行左端的**实测**宽度 */
  const prefixWidth = (lineText: string, indexInLine: number): number => {
    if (indexInLine <= 0 || !lineText) return 0
    const prefix = lineText.slice(0, indexInLine)
    return meter.measure([prefix]).get(prefix) ?? 0
  }

  /**
   * 一行文本里，横向像素 x 最靠近哪条字符边界（返回行内下标）。
   * 与框共用同一份实测宽度，中文 / 等宽混排都不会按"列数"错位。
   */
  const indexAtX = (lineText: string, x: number): number => {
    const prefixes: string[] = []
    for (let i = 0; i <= lineText.length; i++) prefixes.push(lineText.slice(0, i))
    const widths = meter.measure(prefixes)
    let best = 0
    let bestDistance = Number.POSITIVE_INFINITY
    for (let i = 0; i < prefixes.length; i++) {
      const distance = Math.abs((widths.get(prefixes[i]!) ?? 0) - x)
      if (distance >= bestDistance) continue
      bestDistance = distance
      best = i
    }
    return best
  }

  /** 编辑框里的"行 + 行内像素" → 输入框的字符下标 */
  const indexAtLineX = (text: string, line: number, x: number): number =>
    lineStartOffset(text, line) + indexAtX(lineTextAt(text, line), x)

  /** 输入框的字符下标 → 它在框内的横向像素（多行值按所在行算） */
  const xAtIndex = (text: string, index: number): number =>
    prefixWidth(
      lineTextAt(text, lineIndexOfOffset(text, index)),
      index - lineStartOffset(text, lineIndexOfOffset(text, index)),
    )

  /**
   * 光标贴到框上时的插入位置：文档偏移 → 框内比例（0 左沿 / 1 右沿）→ 框内横向像素
   * → 最近的字符边界。左沿落在行首、右沿落在行尾，与看到的框沿一一对应。
   * 多行值还要挑落在哪一行：从下面进来的落最后一行，否则落首行（见 `boxLineAt`，
   * 与"上下键进框"走 `boxLandingAt` 是同一条行规则）。
   *
   * 注意这里的横向换算用的是**框自己的宽度**（= 最宽那行的实测宽度，槽位就是这么宽的），
   * 而不是译文每一行各自的宽度：光标停在这个槽位上，屏幕坐标本来就按框宽铺开。
   */
  const caretIndexInBox = (
    span: TextSpan,
    offset: number,
    text: string,
    rect: TextRect,
    fromBelow: boolean,
  ): number => {
    const length = span.end - span.start
    const fraction = length > 0 ? (offset - span.start) / length : 0
    const line = boxLineAt(span, span.line, text.split('\n').length, fromBelow)
    return indexAtLineX(text, line, fraction * rect.width)
  }

  /** 点在框上时的插入位置：按点击点在框内的行 / 横向像素算（点哪插哪） */
  const clickIndexInBox = (
    text: string,
    rect: TextRect,
    clientX: number,
    clientY: number,
  ): number => {
    const line = Math.floor((clientY - rect.top) / lineHeightPx())
    return indexAtLineX(text, line, clientX - rect.left)
  }

  /**
   * 目标行上「横向像素 → 文档 offset」，自己算（纯算术部分见 `offsetAtLineX`）。
   *
   * 这里**不能**用 `ed.getTargetAtClientPoint`，两个坑都实地踩过：
   * 1) 它先做 DOM 命中（`HitTestRequest` 没给事件目标时改走 `doHitTest`），
   *    而命中到的那个元素要按祖先逐个认领（`_createMouseTarget` 里一串
   *    `ElementPath.isChildOf*`）。黄底框（`.hs-lang-unit`，为收点击开着
   *    `pointer-events`）正盖在正文上：命中到覆盖层就一路认领不上，最后落到
   *    `fulfillUnknown()` —— position 为 null。邻行也是键名时（`speaker:KEY//`
   *    一行接一行、框左沿还对齐），上下键**永远**出不了框；
   * 2) 没命中覆盖层的那一半也不准：GPU 渲染的行走
   *    `viewLinesGpu.getPositionAtCoordinate`，它是按**原文**逐字累加宽度反推列号的
   *    （见 `glyphRasterizer.getTextMetrics`），而键名 / `//` 在屏幕上是被渲染成
   *    「宽度 = 译文实测宽度」的槽位的 —— 槽位那一段的落点就一路偏。
   *
   * 自己算反而简单：纵向的行号由文档算（见 `exitLineFor`），横向只认覆盖层的真实矩形
   * 与实测文字宽度 —— 一个像素都不用猜，也不必让 Monaco 知道槽位这回事。
   */
  const offsetAtLineXInEditor = (
    lineNumber: number,
    clientX: number,
  ): number | null => {
    const model = ed.getModel()
    if (!model) return null
    const lineStart = model.getOffsetAt({ lineNumber, column: 1 })
    const lineText = model.getLineContent(lineNumber)
    const lineLeft = lineLeftOf(lineNumber)
    if (lineLeft == null) return null
    return offsetAtLineX(
      lineStart,
      lineText,
      clientX - lineLeft,
      lineSlotsOf(lineNumber, lineLeft),
      (text) => meter.measure([text]).get(text) ?? 0,
    )
  }

  /**
   * 某一行的行首文字左沿（视口坐标）。
   * 行首位置只取决于缩进 / 横向滚动，与行内容无关 —— 这个是准的，槽位几何都挂在它上面。
   */
  const lineLeftOf = (lineNumber: number): number | null => {
    const base =
      typeof domNode?.getBoundingClientRect === 'function'
        ? domNode.getBoundingClientRect()
        : null
    const head = ed.getScrolledVisiblePosition({ lineNumber, column: 1 })
    if (!base || !head) return null
    return base.left + head.left
  }

  /**
   * 这一行在屏幕上占几个视觉行（开着软换行时 > 1）。
   *
   * 软换行下 Monaco 的上下键走的是**视觉行**，而本模块的槽位几何一律按**文档行**算
   * （槽位宽、行首左沿、`boxLineAt` 都是），两者混着用会跨过一整行。
   * 拿不准的行（量不到下一行）当作占多行 → 让位给 Monaco 的原生行为。
   */
  const lineVisualRows = (lineNumber: number): number => {
    const model = ed.getModel()
    const head = ed.getScrolledVisiblePosition({ lineNumber, column: 1 })
    const next = ed.getScrolledVisiblePosition({ lineNumber: lineNumber + 1, column: 1 })
    if (!head) return 1
    if (!next) return model && lineNumber >= model.getLineCount() ? 1 : 2
    const step = lineHeightPx()
    if (step <= 0) return 1
    return Math.max(1, Math.round((next.top - head.top) / step))
  }

  /**
   * 这一行上"被渲染成别的东西"的槽位：键名框 + 尾标 `//`。
   * 多行译文的 `//` 会落在后面的行上，所以两半各认各的行。
   * `left` / `width` 一律相对**行首文字左沿**，与 `lineXForOffset` / `offsetAtLineX` 同一把尺子。
   */
  const lineSlotsOf = (lineNumber: number, lineLeft: number): LineSlot[] => {
    const model = ed.getModel()
    const slots: LineSlot[] = []
    if (!model) return slots
    for (const entry of lineEntries) {
      if (entry.span.line === lineNumber) {
        const slot = slotOf(lineLeft, entry.span.start, entry.span.end, entry.box)
        if (slot) slots.push(slot)
      }
      const term = entry.span.terminator
      if (term && model.getPositionAt(term.start).lineNumber === lineNumber) {
        const slot = slotOf(lineLeft, term.start, term.end, entry.tail)
        if (slot) slots.push(slot)
      }
    }
    return slots
  }

  /**
   * 目标行上「横向像素 → 压在键名框上就预判框内插入位置」。
   *
   * 上下挪移 / 从编辑框里往外挪都以**像素**为基准找落点：框内位置直接由同一个 x 反推，
   * 不再折回原文 offset 再按 8 格键名的比例换算 —— 那一步等于拿隐藏键名当尺子，
   * 1 格原文 ≈ 框宽的 1/8（用户实测约 4 个译文汉字），进和出还会各偏一点、来回不可逆。
   * 返回 null = 这个 x 不在任何键名框上（尾标 `//` 不算框），交给调用方按老路走。
   */
  const boxLandingAt = (
    lineNumber: number,
    clientX: number,
    fromBelow = false,
  ): {
    span: TextSpan
    el: HTMLElement | null
    mode: TextEditMode
    caretIndex: number
  } | null => {
    const map = host.getMap()
    if (!map) return null
    const lineLeft = lineLeftOf(lineNumber)
    if (lineLeft == null) return null
    const hit = slotAtX(lineSlotsOf(lineNumber, lineLeft), clientX - lineLeft)
    if (!hit) return null
    const entry = lineEntries.find(
      (item) => item.span.start === hit.start && item.span.end === hit.end,
    )
    if (!entry) return null
    const key = normalizeLocaleKey(entry.span.value)
    if (!key) return null
    // 与 render 的显示口径一致：Ctrl / 缺文本时框里显示键名，预判就得按键名量
    const showKey = ctrlHeld || map.get(key) == null
    const text = showKey ? key : (map.get(key) ?? '')
    const displayLines = text.split('\n')
    return {
      span: entry.span,
      el: entry.box,
      mode: showKey ? 'key' : 'value',
      caretIndex: indexAtLineX(
        text,
        boxLineAt(entry.span, lineNumber, displayLines.length, fromBelow),
        clientX - lineLeft - hit.left,
      ),
    }
  }

  /** 量一个槽位的真实矩形（相对行首文字左沿）；量不到就返回 null 由调用方兜底 */
  const slotOf = (
    lineLeft: number,
    start: number,
    end: number,
    el: HTMLElement | null,
  ): LineSlot | null => {
    if (end <= start) return null
    const rect =
      el && typeof el.getBoundingClientRect === 'function'
        ? el.getBoundingClientRect()
        : null
    if (!rect || rect.width <= 0 || rect.height <= 0) return null
    return { start, end, left: rect.left - lineLeft, width: rect.width }
  }

  /**
   * 抄框的 computed style：编辑框要贴着文字，字体 / 字距就得和框里那行同源。
   * 取不到（框还没挂上 / 无头环境）时返回 undefined，由样式表兜底。
   */
  const fontOfBox = (element: HTMLElement | null): TextEditFont | undefined => {
    if (!element || typeof window.getComputedStyle !== 'function') return undefined
    const style = window.getComputedStyle(element)
    if (!style || !style.fontFamily) return undefined
    return {
      family: style.fontFamily,
      size: style.fontSize,
      weight: style.fontWeight,
      letterSpacing: style.letterSpacing,
      featureSettings: style.fontFeatureSettings,
      variationSettings: style.fontVariationSettings,
      lineHeightPx: lineHeightPx(),
    }
  }

  /** 摘掉"正在编辑"（关编辑框；重开时先摘旧的） */
  const clearEditingBox = () => {
    activeEdit?.el?.classList.remove(EDITING_CLASS)
    activeEdit = null
    // 关框就断掉位置推送：编辑框正在卸载，再推就是推给下一个框了
    spotListener = null
    lastSpot = null
    // 自绘光标该回来了（编辑框自己画的那份随组件一起卸载）
    caretOverlay.update()
  }

  /**
   * 把"编辑框现在该待在哪"推给订阅者（见 TextEditRequest.subscribeSpot）。
   *
   * 位置取**框元素自己的视口矩形** —— 与打开那一刻 `rectForSpan` 用的是同一把尺子，
   * 所以滚动 / 布局变化后编辑框与框始终逐像素重合。只推 left / top / visible / clip：
   * 宽高在编辑期间锁死（中途改尺寸会让文字重排）。
   * 框滚出可视区（覆盖层把它藏起来、量不到矩形）时沿用最后一次位置并报 `visible: false`：
   * 编辑框只是隐身，不卸载 —— 卸载会丢输入焦点，滚回来还得重新点一次。
   * `clip` = 编辑器自己的可视矩形，半露在上下边缘的框按它裁，才像贴在编辑器里。
   */
  const reportEditSpot = () => {
    if (!activeEdit || !lastSpot) return
    const entry = lineEntries.find(
      (item) => normalizeLocaleKey(item.span.value) === activeEdit?.key,
    )
    const rect =
      entry?.box && typeof entry.box.getBoundingClientRect === 'function'
        ? entry.box.getBoundingClientRect()
        : null
    // 编辑器自己的矩形：量不到（无头环境 / 还没挂上）就不裁，也不据它判隐身
    const raw =
      typeof domNode?.getBoundingClientRect === 'function'
        ? domNode.getBoundingClientRect()
        : null
    const clip =
      raw && raw.width > 0 && raw.height > 0
        ? { left: raw.left, top: raw.top, width: raw.width, height: raw.height }
        : null
    const shown =
      !!entry &&
      entry.el.style.display !== 'none' &&
      !!rect &&
      rect.width > 0 &&
      // 整个框都在编辑器可视区外：没必要留在屏幕上（但组件留着，见上）
      (!clip ||
        (rect.left < clip.left + clip.width &&
          rect.left + rect.width > clip.left &&
          rect.top < clip.top + clip.height &&
          rect.top + rect.height > clip.top))
    const next: TextEditSpot = shown && rect
      ? { left: rect.left, top: rect.top, visible: true, clip: clip ?? undefined }
      : { left: lastSpot.left, top: lastSpot.top, visible: false }
    if (
      next.left === lastSpot.left &&
      next.top === lastSpot.top &&
      next.visible === lastSpot.visible &&
      // 编辑器自身大小变了（裁切范围跟着变）也要重推
      next.clip?.width === lastSpot.clip?.width &&
      next.clip?.height === lastSpot.clip?.height &&
      next.clip?.left === lastSpot.clip?.left &&
      next.clip?.top === lastSpot.clip?.top
    ) {
      return
    }
    lastSpot = next
    spotListener?.(next)
  }

  /** `render()` 换掉了框的元素：把"正在编辑"重新挂到新的那个框上 */
  const syncEditingBox = () => {
    if (!activeEdit) return
    const entry = lineEntries.find(
      (item) => normalizeLocaleKey(item.span.value) === activeEdit?.key,
    )
    if (!entry?.box) {
      clearEditingBox()
      return
    }
    activeEdit.el = entry.box
    entry.box.classList.add(EDITING_CLASS)
  }

  /**
   * 程序化搬运光标。`guard` = 这一格不算"贴上框"，不回吸 ——
   * 框沿本身是进框信号（见 handleCaretEnter），出框 / 复位若落回框沿会当场被吞回去。
   * Monaco 的 setPosition 同步触发光标事件，guard 就在那一拍被消费掉。
   */
  const moveCaret = (offset: number, guard: boolean) => {
    const model = ed.getModel()
    if (!model) return
    const target = clampOffset(offset, model.getValueLength())
    if (guard) caretGuardOffset = target
    ed.setPosition(model.getPositionAt(target))
  }

  /**
   * 提交编辑后光标该落在哪：**语句结尾**，且绝不能停在框沿上
   * （框沿是进框信号，见 `handleCaretEnter`，停在那儿下一拍会被吸回编辑框）。
   *
   * - 有行末 `//`：落在它后面（退格删的是第二个 `/`，全程碰不到框沿）；
   * - 多行块（`//` 独占一行）：落在收尾符那一行的行末。键名单独占一行时
   *   `span.end` 就是框右沿，落在那里会把编辑框重新吸开；
   * - 找不到收尾符（理论上不会 —— 键名只出现在已闭合的片段里）：退回框右沿。
   */
  const statementEndOffsetFor = (span: TextSpan): number => {
    if (span.terminator) return span.terminator.end
    const model = ed.getModel()
    if (!model) return span.end
    const closer = blockCloserLine(model.getLinesContent(), span.endLine + 1)
    if (closer == null) return span.end
    return model.getOffsetAt({
      lineNumber: closer,
      column: model.getLineMaxColumn(closer),
    })
  }

  /** 进编辑框之前的光标位置：Esc 复位用（点开时 Monaco 光标没动，取当前值即可） */
  const returnOffsetFor = (span: TextSpan): number => {
    const model = ed.getModel()
    const position = ed.getPosition()
    const current = model && position ? model.getOffsetAt(position) : null
    const outside = (offset: number | null): offset is number =>
      offset != null && (offset < span.start || offset > span.end)
    if (outside(current)) return current
    if (outside(lastCaretOffset)) return lastCaretOffset
    return span.start - 1
  }

  /** 弹出等位置覆盖编辑框；`forced` 用于右键菜单直接指定模式，`caretIndex` 用于点哪插哪 */
  const openEditor = (
    span: TextSpan,
    element: HTMLElement | null,
    forced?: TextEditMode,
    caretIndex?: number,
  ): boolean => {
    const map = host.getMap()
    if (!map) return false
    const key = normalizeLocaleKey(span.value)
    if (!key) return false

    const mode: TextEditMode = forced ?? (ctrlHeld ? 'key' : 'value')
    const rect = rectForSpan(span, element)
    if (mode === 'key') {
      // 改键名是单行框：只按首行高度覆盖（覆盖框可能是多行的）
      rect.height = Math.min(rect.height, lineHeightPx())
    }
    const initial = mode === 'key' ? key : (map.get(key) ?? '')
    // 空值（缺失 / 空串）时框里显示的是键名：编辑框照抄成占位文本，宽度也照键名算
    const placeholder = initial === '' ? key : undefined
    if (placeholder) {
      rect.width = Math.max(rect.width, meter.measure([key]).get(key) ?? 0)
    }

    const returnOffset = returnOffsetFor(span)
    clearEditingBox()
    // 打开这一刻框的显示方式（与 render 里的 showKey 同一式）：编辑期间照着它渲染，
    // 宽度才不会中途跳变、和编辑框错开
    activeEdit = {
      key,
      showKey: ctrlHeld || map.get(key) == null,
      el: element,
      returnOffset,
    }
    element?.classList.add(EDITING_CLASS)
    // 编辑框接管这一格的光标：自绘光标与原生光标层都让位
    caretOverlay.update()
    // 位置的起点就是打开这一刻量的矩形；之后由 reportEditSpot 按滚动 / 布局推新的
    lastSpot = { left: rect.left, top: rect.top, visible: true }
    spotListener = null

    host.onEditRequest({
      mode,
      key,
      initial,
      rect,
      caretIndex,
      font: fontOfBox(element),
      placeholder,
      subscribeSpot: (onSpot) => {
        spotListener = onSpot
        // 订阅时补一次当前位置：挂载到这份请求之间的那一拍里框可能刚被 render 重新锚过
        if (lastSpot) onSpot(lastSpot)
        return () => {
          if (spotListener === onSpot) spotListener = null
        }
      },
      grabBoxAt,
      apply: (next: string, reason: TextEditCommitReason) => {
        // 绑定可能已经重建（换文件）：旧请求不能再动文档
        if (disposed) return
        clearEditingBox()
        flushCtrlRender()
        /**
         * 提交后光标落在语句结尾（见 `statementEndOffsetFor`）。
         * 不能停在框沿上：框沿是进框信号（`hitCaretBox` 含两侧），
         * 下一拍就会被吸回编辑框里 —— guard 只挡得住这一拍。
         * 落在 `//` 之后还有个好处：退格删的是第二个 `/`，光标退到两个 `/` 之间，
         * 全程碰不到框沿。
         */
        const landing = statementEndOffsetFor(span)
        if (mode === 'key') {
          const normalized = normalizeLocaleKey(next)
          const m = ed.getModel()
          if (!normalized || !m) return
          const range = monaco.Range.fromPositions(
            m.getPositionAt(span.start),
            m.getPositionAt(span.end),
          )
          if (m.getValueInRange(range).trim().toLowerCase() !== normalized) {
            ed.pushUndoStop()
            ed.executeEdits('hanshu-locale-retarget', [
              { range, text: normalized },
            ])
            ed.pushUndoStop()
            render()
          }
          if (reason === 'enter') ed.focus()
          moveCaret(landing, true)
          return
        }
        map.set(key, next)
        render()
        if (reason === 'enter') ed.focus()
        moveCaret(landing, true)
      },
      cancel: () => {
        if (disposed) return
        const back = activeEdit?.returnOffset ?? returnOffset
        clearEditingBox()
        flushCtrlRender()
        ed.focus()
        moveCaret(back, true)
      },
      exit: (direction: TextEditExitDirection, input: TextEditInputState) => {
        if (disposed) return false
        const box = activeEdit
        if (!box) return false
        // 先预判落点：外面没地方去就别关编辑框（否则一按就把框关了，光标还没动）
        const plan = planEditorExit(
          { key: box.key, el: box.el, rect },
          direction,
          input,
        )
        if (!plan) return false
        clearEditingBox()
        flushCtrlRender()
        // 落点压在邻行的键名框上：直接开那个框（插入位置按同一个像素 x 预判）
        if (plan.kind === 'box') {
          return openEditor(plan.span, plan.el, plan.mode, plan.caretIndex)
        }
        ed.focus()
        moveCaret(plan.offset, plan.guard)
        return true
      },
    })
    return true
  }

  /**
   * 出框落点：要么把光标挪到文档里（`caret`），要么直接落到另一个键名框上（`box`）。
   * 后者要把插入点一起带过去 —— 中间折回原文 offset 会按 8 格键名把比例放大。
   */
  type EditorExitPlan =
    | { kind: 'caret'; offset: number; guard: boolean }
    | {
        kind: 'box'
        span: TextSpan
        el: HTMLElement | null
        mode: TextEditMode
        caretIndex: number
      }

  /**
   * 预判"从编辑框里向外挪一步"的落点（见 TextEditRequest.exit）：
   * - 左右：框沿再往外一步（`exitCaretTarget`）—— 停在框沿会被立刻吸回框里
   * - 上下：按编辑框内的横向位置预判到上一行 / 下一行；多行值内部翻行由输入框自己处理，
   *   只有"首行向上 / 末行向下"才走到这里。落点若压在别的框上，**直接按同一个像素 x
   *   开那个框**（见 boxLandingAt）—— 折回原文 offset 再按 8 格键名换算的话，
   *   同一格来回挪会各偏一点，用户实测"同样位置的进和出不对等、不可逆"。
   *
   * 返回 null = 外面没地方去（框贴文档头 / 尾、已在首行末行、落点等于原地），
   * 调用方保持编辑框开着，把这一按当无事发生。
   */
  const planEditorExit = (
    box: { key: string; el: HTMLElement | null; rect: TextRect },
    direction: TextEditExitDirection,
    input: TextEditInputState,
  ): EditorExitPlan | null => {
    const model = ed.getModel()
    if (!model) return null
    const span = currentSpans().find(
      (item) => normalizeLocaleKey(item.value) === box.key,
    )
    if (!span) return null
    const current = ed.getPosition()
    const here = current ? model.getOffsetAt(current) : null
    /** 预判到原地 = 没挪动：别关编辑框 */
    const pick = (offset: number, guard: boolean) =>
      offset === here ? null : { kind: 'caret', offset, guard } as const

    if (direction === 'left' || direction === 'right') {
      const { offset, guard } = exitCaretTarget(
        atomicRegion(span),
        direction,
        model.getValueLength(),
      )
      return pick(offset, guard)
    }

    // 上下：行由文档算（多行译文的第一行上方 / `//` 所在行的下方），
    // 横向拿编辑框里光标所在的那一格，落到目标行的同一个像素位置上。
    const line = exitLineFor(span, direction, model.getLineCount())
    if (line == null) return null
    // 横向基准取框的实时矩形；框元素被重建过就退回打开那一刻量的矩形（几何是锁死的）。
    // 框内偏移 = 光标那一格的实测像素 − 输入框自己的横向滚动，并夹在框宽内，
    // 免得极端滚动值把落点甩到行外去。
    const rect = box.el?.getBoundingClientRect?.() ?? box.rect
    if (!rect) return null
    const inside = Math.max(
      0,
      Math.min(rect.width, xAtIndex(input.text, input.caretIndex) - (input.scrollLeft ?? 0)),
    )
    // 落点压在邻行的键名框上 → 直接开那个框，插入位置就用这个 x 反推（不经过原文 offset）
    // 向上出框 = 从下面贴上新框，落在它的末行；向下出框 = 从上面下来，落在首行
    const landing = boxLandingAt(line, rect.left + inside, direction === 'up')
    if (landing && landing.span.start !== span.start) {
      return {
        kind: 'box',
        span: landing.span,
        el: landing.el,
        mode: landing.mode,
        caretIndex: landing.caretIndex,
      }
    }
    const offset = offsetAtLineXInEditor(line, rect.left + inside)
    if (offset == null) return null
    // 这里**不**做 pick 的"预判到原地就不出框"：出口行已经保证在框外，
    // 用户按了上下就是要出去，落点恰好等于原光标位置也该把编辑框交还出来
    return {
      kind: 'caret',
      offset: clampOffset(offset, model.getValueLength()),
      guard: false,
    }
  }

  /**
   * 把覆盖框摆到对应片段位置（滚动 / 改尺寸时只做这一步）。
   * 槽位宽度 != 键名列数，所以不能按列坐标推算位置。
   *
   * 注意：槽位上挂的是 `.hs-lang-slot-w<N>` 这类派生名，而下面按基础类
   * `.hs-lang-slot` 查询，实际命中不了 —— 每次都会走 getScrolledVisiblePosition。
   * 退回值同样准：inlineClassNameAffectsLetterSpacing 会把这些行从 Monaco 的
   * Fast 路径（列数 × 字符宽）踢进 DOM 量测渲染器，读的是真实矩形。
   */
  const positionBoxes = () => {
    frame = null
    if (disposed) return
    const model = ed.getModel()
    if (!model) return
    const editorWidth = domNode?.clientWidth ?? 0

    const slots = new Map<string, HTMLElement>()
    const editorRect =
      typeof domNode?.getBoundingClientRect === 'function'
        ? domNode.getBoundingClientRect()
        : null
    if (typeof domNode?.querySelectorAll === 'function') {
      for (const el of Array.from(
        domNode.querySelectorAll(`.${SLOT_CLASS}`),
      ) as HTMLElement[]) {
        const text = el.textContent ?? ''
        if (/^[0-9a-f]{8}$/.test(text)) slots.set(text, el)
      }
    }

    for (const entry of lineEntries) {
      const key = normalizeLocaleKey(entry.span.value)
      // 兜底：片段偏移已经越界（理论上不会发生 —— 指纹一变就重建）。
      // 一旦越界，`getPositionAt` 会**夹到文档末尾**，把框画到最后一行最左侧闪一下，
      // 所以这里宁可先藏起来，也别拿过期偏移去测量。
      if (entry.span.start > model.getValueLength()) {
        entry.el.style.display = 'none'
        continue
      }
      const slot = key ? slots.get(key) : undefined
      const slotRect =
        slot && typeof slot.getBoundingClientRect === 'function'
          ? slot.getBoundingClientRect()
          : null
      const pos =
        slotRect && editorRect
          ? {
              left: slotRect.left - editorRect.left,
              top: slotRect.top - editorRect.top,
            }
          : ed.getScrolledVisiblePosition(
              model.getPositionAt(entry.span.start),
            )
      if (!pos) {
        entry.el.style.display = 'none'
        continue
      }
      entry.el.style.display = ''
      entry.el.style.left = `${pos.left}px`
      entry.el.style.top = `${pos.top}px`
      entry.el.style.maxWidth = `${Math.max(120, editorWidth - pos.left - 12)}px`
    }
    // 滚动 / 布局变化后，拖拽落点光标跟着新几何走（否则会留在旧位置）
    positionDropCaret()
    // 编辑框也钉在框上：把框此刻的位置推给订阅者（见 reportEditSpot）
    reportEditSpot()
  }

  const schedulePosition = () => {
    if (frame != null || disposed) return
    frame = window.requestAnimationFrame(positionBoxes)
  }

  /**
   * 拖拽落点光标：键名拖到**文本区**时指示插入点，落在别处（含键名容器）不显示 ——
   * 落到键名上是"替换键名"，没有插入点可言。
   *
   * 为什么自己画：Monaco 自带的落点指示器（`dnd-target` 装饰）只靠它自己的
   * drop / dragleave / dragend 清除，而我们在键名容器上 stopPropagation 之后它收不到，
   * 拖完会永久残留一根虚线，所以那个特性被关掉了（编辑器 options 里的 dropIntoEditor）。
   * 自己画的这版在所有收尾路径（drop / dragleave / dragend / 离开编辑器）都会清掉。
   */
  let dropCaretEl: HTMLElement | null = null
  let dropCaretPosition: { lineNumber: number; column: number } | null = null

  const positionDropCaret = () => {
    if (!dropCaretEl || !dropCaretPosition) return
    const box = ed.getScrolledVisiblePosition(dropCaretPosition)
    if (!box) {
      dropCaretEl.style.display = 'none'
      return
    }
    dropCaretEl.style.display = ''
    dropCaretEl.style.left = `${box.left}px`
    dropCaretEl.style.top = `${box.top}px`
    dropCaretEl.style.height = `${box.height || lineHeightPx()}px`
  }

  const showDropCaretAt = (position: { lineNumber: number; column: number }) => {
    dropCaretPosition = position
    if (!dropCaretEl) {
      dropCaretEl = document.createElement('div')
      dropCaretEl.className = DROP_CARET_CLASS
      layer.appendChild(dropCaretEl)
    }
    positionDropCaret()
  }

  const hideDropCaret = () => {
    dropCaretPosition = null
    dropCaretEl?.remove()
    dropCaretEl = null
  }

  /**
   * 选区命中：文档选区只要**碰到**某个原子单位，就把整个单位记为选中态。
   *
   * 为什么必须由覆盖层来画：多行值是覆盖层渲染的，文档里只占**一行、一个槽位**，
   * Monaco 的原生蓝色只能盖住那一行 —— 其余行完全没有高亮（选中整行时尤其明显）。
   * 底色用**不透明**色，否则与原生选区在同一行叠加会深一块、分成两种观感。
   */
  const syncUnitSelection = () => {
    const model = ed.getModel()
    const selection = ed.getSelection()
    const start = model && selection ? model.getOffsetAt(selection.getStartPosition()) : 0
    const end = model && selection ? model.getOffsetAt(selection.getEndPosition()) : 0
    const ranged = start !== end
    for (const entry of lineEntries) {
      const { span } = entry
      const hit = ranged && start < span.end && end > span.start
      entry.unit?.classList.toggle(SELECTED_CLASS, hit)
    }
    layer.classList.toggle(UNFOCUSED_CLASS, !ed.hasTextFocus?.())
  }

  /**
   * 编辑之后**立刻**把覆盖框摆正（成键仍然走 220ms 防抖，那是刻意的）。
   *
   * 为什么必须显式做：
   * 1. 内容变化不重摆的话，覆盖框要等到防抖回调里那次 `render()` 才动 —— 换行 /
   *    删整行这类整体位移就会肉眼可见地慢约 0.2 秒。
   * 2. Monaco 自己的视图渲染是 rAF 调度的。要在这一个同步任务里量到**新**几何，
   *    得先用公开 API `ed.render()` 把它刷出来（否则量到的是上一帧的行位置）。
   *
   * 片段指纹变了就重建（键被删掉 / 偏移移动，view zone 的锚点也可能失效）；
   * 只有指纹完全一致（改动落在片段之外，纯几何位移）才只重摆位置。
   */
  const syncOverlayAfterEdit = () => {
    ed.render()
    if (computeSpanFingerprint(currentSpans()) !== renderedFingerprint) {
      render()
      return
    }
    positionBoxes()
    caretOverlay.update()
  }

  const makeTail = (): HTMLElement => {
    const tail = document.createElement('div')
    tail.className = TAIL_CLASS
    tail.textContent = TAIL_TEXT
    // 间距由这里定义：槽位宽度按「间距 + 尾标实际宽度」留，见 TAIL_GAP_PX
    tail.style.marginLeft = `${TAIL_GAP_PX}px`
    return tail
  }

  const makeBox = (
    text: string,
    stateClass: string,
    widthPx: number,
    heightPx: number,
    key: string,
  ): HTMLElement => {
    const box = document.createElement('div')
    box.className = `${BOX_CLASS} ${stateClass}`
    box.textContent = text
    // 与槽位同一份实测宽度：框宽 == 槽位宽 == 渲染文本宽
    box.style.minWidth = `${widthPx}px`
    box.style.height = `${heightPx}px`
    box.title = ctrlHeld
      ? `键名 ${key}`
      : `键名 ${key} · 按住 Ctrl 点击可改键名`
    return box
  }

  /**
   * 配音按钮：正方形，边长与文本等高。
   * 四态只由 `state` 决定形状与底色（缺失红 / 无效紫 / 可用黄 / 播放中蓝）。
   * 按下就吞掉事件，免得容器的「打开文本编辑框」也响应同一次点击。
   */
  const makeVoiceButton = (
    state: VoiceButtonState,
    sizePx: number,
    title: string,
    onToggle: (event: MouseEvent) => void,
  ): HTMLElement => {
    const button = document.createElement('div')
    button.className = `${VOICE_CLASS} ${VOICE_STATE_CLASS[state]}`
    button.style.width = `${sizePx}px`
    button.style.height = `${sizePx}px`
    // 间距也由这里定义：槽位宽度按「文本框 + 间距 + 按钮」算，见 VOICE_SLOT_EXTRA_PX
    button.style.marginLeft = `${VOICE_BUTTON_GAP_PX}px`
    button.title = title
    button.setAttribute('role', 'button')
    button.setAttribute('aria-label', title)
    button.innerHTML = formatVoiceButtonSvg(state)
    button.addEventListener('mousedown', (event) => {
      // 只拦冒泡：**不能 preventDefault**，否则从按钮上起手就拖不动整个单位
      event.stopPropagation()
    })
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      onToggle(event)
    })
    return button
  }

  /**
   * 容器的拖拽接线：
   * - 作为**拖拽源**：拖出去的载荷是 `{ kind: 'key', key }`
   * - 作为**投放目标**：外部文件 / 资产 → 尝试导入音频；另一个键名 → 替换键名
   * 支持的投放才 `preventDefault` 并高亮，其余一律不接管（让浏览器保持默认）。
   */
  const bindUnitDragDrop = (unit: HTMLElement, key: string) => {
    // 录音棚模式下不拖拽：那时是"划框选择"，留着 HTML5 拖拽会和它抢手势
    unit.draggable = !studioMode
    unit.addEventListener('dragstart', (event) => {
      if (studioMode) return
      writeDragPayload(event.dataTransfer, { kind: 'key', key })
    })
    unit.addEventListener('dragend', () => {
      unit.classList.remove(DROP_TARGET_CLASS)
      endDrag()
    })
    unit.addEventListener('dragover', (event) => {
      const intent = resolveDropIntent({
        target: 'key',
        source: currentDrag(),
        hasFiles: hasExternalFiles(event.dataTransfer),
      })
      if (!intent) {
        /*
         * 判定不出意图也要把默认行为吃掉：准放判据只有一条 —— 不是本应用自己的内部
         * 拖拽就一律接下（见 `shouldAcceptDrop`）。拿 `types` 判"有没有文件"在
         * WebView2 上会漏，漏了就是不 preventDefault、浏览器不允许投放、`drop` 不来
         * （"拖到键名上没反应 + 🚫"）。
         */
        if (shouldAcceptDrop(event.dataTransfer)) event.preventDefault()
        return
      }
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect =
          intent.action === 'replace-key' ? 'move' : 'copy'
      }
      unit.classList.add(DROP_TARGET_CLASS)
    })
    unit.addEventListener('dragleave', (event) => {
      const next = event.relatedTarget as Node | null
      if (!next || !unit.contains(next)) unit.classList.remove(DROP_TARGET_CLASS)
    })
    unit.addEventListener('drop', (event) => {
      unit.classList.remove(DROP_TARGET_CLASS)
      const files = Array.from(event.dataTransfer?.files ?? [])
      const source = readDragPayload(event.dataTransfer)
      const intent = resolveDropIntent({
        target: 'key',
        source,
        hasFiles: files.length > 0,
      })
      if (!intent) return
      event.preventDefault()
      event.stopPropagation()
      host.onUnitDrop?.({ key, intent, files, source })
      endDrag()
      // 拖放结束后把焦点还给编辑器：否则 Ctrl+Z 到不了 Monaco（拖拽改的是正文，
      // 必须能撤销/重做）
      ed.focus()
    })
  }

  /**
   * 配音按钮的 tooltip：状态 + 原因 / 时长。
   * 缺失 / 无效时按钮点下去是"打开选择器"，文案里要说清楚。
   */
  const voiceButtonTitle = (
    state: VoiceButtonState,
    status: VoiceUnitStatus | null,
  ): string => {
    const label = VOICE_STATE_LABEL[state]
    /*
     * 「引用资产」的键在四态上与真文件一模一样（都是 ready），但**来源不同**：
     * 它不是这个键自己的音频，而是指向别处的一份。不说清楚，用户会去对等位置
     * 找一个并不存在的 `.ogg`。
     */
    const viaRef =
      status?.source === 'ref' && status.audioPath
        ? ` · 引用自 ${status.audioPath}`
        : ''
    if (state === 'playing') return `${label}${viaRef} · 点击停止`
    if (state === 'ready') {
      const duration =
        status?.info != null ? formatVoiceDuration(status.info.duration) : ''
      return duration
        ? `${label}${viaRef} · 点击播放 · ${duration}`
        : `${label}${viaRef} · 点击播放`
    }
    const hint = state === 'invalid' ? '点击重新选择' : '点击选择'
    return status?.reason ? `${label} · ${status.reason} · ${hint}` : `${label} · ${hint}`
  }

  // ——————————————————————————————————————————————————————————————
  //  录音棚模式（键名选择）
  //  - 左键点键名 = 选中（Shift / Ctrl / Cmd = 追加多选）
  //  - 在空白处按下并拖动 = 划框选择范围内的键名
  //  - 常规交互（打开编辑框、右键菜单）在这个模式下全部让位
  //
  //  为什么选择逻辑放在这里而不是上层：键名是覆盖层画出来的 DOM，
  //  "哪些键在框里"只有这里量得到（lineEntries 持有每个单位的真实矩形）。
  //  上层只收到「哪些键被选中」这一个事实。
  // ——————————————————————————————————————————————————————————————

  /** 把已选集合画到现有的覆盖框上（不重建 DOM） */
  const applyStudioSelection = () => {
    for (const entry of lineEntries) {
      const key = normalizeLocaleKey(entry.span.value)
      entry.unit?.classList.toggle(
        STUDIO_SELECTED_CLASS,
        Boolean(key && studioSelection.has(key)),
      )
    }
  }

  /** 正文里出现的键名（按出现顺序、去重）—— 上层做范围选择与排序要靠它 */
  const listUnitKeys = (): string[] => {
    const out: string[] = []
    const seen = new Set<string>()
    for (const span of currentSpans()) {
      const key = normalizeLocaleKey(span.value)
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push(key)
    }
    return out
  }

  /**
   * 划框中的状态（null = 没在划）。
   *
   * 三个坐标都是**内容坐标**（编辑器里的正文坐标，与滚动量无关），见 `contentPointOf`。
   */
  let marquee: {
    startX: number
    startY: number
    /** 拖到的最后一点：滚轮翻页时没有 pointermove，要靠它重画 */
    lastX: number
    lastY: number
    additive: boolean
    dragging: boolean
  } | null = null
  let marqueeEl: HTMLElement | null = null

  const removeMarquee = () => {
    marqueeEl?.remove()
    marqueeEl = null
  }

  /**
   * 视口坐标 → **内容坐标**。
   *
   * 划框必须按内容坐标记。滚动之后同一个屏幕位置对应的是另一行正文：屏幕坐标的框
   * 永远只覆盖得到当前视口，视口外的键名一辈子框不进来 —— 而"按住往下拖、中途用滚轮
   * 翻页"要选中的恰恰是**内容上跨过的那一段**。
   */
  const contentPointOf = (clientX: number, clientY: number) => {
    const rect =
      typeof domNode?.getBoundingClientRect === 'function'
        ? domNode.getBoundingClientRect()
        : null
    return {
      x: (rect ? clientX - rect.left : clientX) + ed.getScrollLeft(),
      y: (rect ? clientY - rect.top : clientY) + ed.getScrollTop(),
    }
  }

  /** 内容坐标 → 覆盖层坐标（layer 铺满编辑器视口，见 LAYER_CLASS） */
  const layerPointOf = (x: number, y: number) => ({
    x: x - ed.getScrollLeft(),
    y: y - ed.getScrollTop(),
  })

  /** 按当前滚动量把划框重画到覆盖层上（超出视口的部分夹掉，画出去也看不见） */
  const drawMarquee = () => {
    if (!marquee || !marqueeEl) return
    const a = layerPointOf(marquee.startX, marquee.startY)
    const b = layerPointOf(marquee.lastX, marquee.lastY)
    const left = Math.max(0, Math.min(a.x, b.x))
    const top = Math.max(0, Math.min(a.y, b.y))
    const right = Math.min(domNode?.clientWidth ?? 0, Math.max(a.x, b.x))
    const bottom = Math.min(domNode?.clientHeight ?? 0, Math.max(a.y, b.y))
    marqueeEl.style.left = `${left}px`
    marqueeEl.style.top = `${top}px`
    marqueeEl.style.width = `${Math.max(0, right - left)}px`
    marqueeEl.style.height = `${Math.max(0, bottom - top)}px`
  }

  /**
   * 框住哪些键：按单位（文本 + 配音按钮）与框的相交判定，两边都在**内容坐标**里比。
   *
   * 可见的那些用**真实矩形**（DOM 量出来最准）；滚出视口的那些 Monaco 根本没渲染，
   * 没有矩形可用 —— 只能按**行带**判定（`getTopForLineNumber` 给的也是内容坐标），
   * 横向不再参与。这正是"往下拖、滚轮翻页，中间所有键都选上"要的语义：
   * 横向只对眼睛看得见的那一段有意义。行带是近似（编辑器上下各 14px 内边距没算进去，
   * 误差在半行以内），只落在看不见的那一段上，够用。
   */
  const keysInMarquee = (): string[] => {
    if (!marquee) return []
    const left = Math.min(marquee.startX, marquee.lastX)
    const right = Math.max(marquee.startX, marquee.lastX)
    const top = Math.min(marquee.startY, marquee.lastY)
    const bottom = Math.max(marquee.startY, marquee.lastY)

    const rect =
      typeof domNode?.getBoundingClientRect === 'function'
        ? domNode.getBoundingClientRect()
        : null
    const scrollTop = ed.getScrollTop()
    const scrollLeft = ed.getScrollLeft()
    const keys: string[] = []
    const seen = new Set<string>()
    for (const entry of lineEntries) {
      const key = normalizeLocaleKey(entry.span.value)
      if (!key || seen.has(key) || !entry.unit) continue
      const hidden = entry.el.style.display === 'none'
      const unitRect =
        hidden || typeof entry.unit.getBoundingClientRect !== 'function'
          ? null
          : entry.unit.getBoundingClientRect()
      if (unitRect && rect && (unitRect.width > 0 || unitRect.height > 0)) {
        const unitLeft = unitRect.left - rect.left + scrollLeft
        const unitRight = unitRect.right - rect.left + scrollLeft
        const unitTop = unitRect.top - rect.top + scrollTop
        const unitBottom = unitRect.bottom - rect.top + scrollTop
        if (unitRight < left || unitLeft > right) continue
        if (unitBottom < top || unitTop > bottom) continue
      } else {
        const lineTop = ed.getTopForLineNumber(entry.span.line)
        const lineBottom = ed.getTopForLineNumber(entry.span.endLine) + lineHeightPx()
        if (lineBottom < top || lineTop > bottom) continue
      }
      seen.add(key)
      keys.push(key)
    }
    return keys
  }

  const onStudioPointerDown = (event: PointerEvent) => {
    if (!studioMode || disposed || event.button !== 0) return
    const target = event.target as HTMLElement | null
    // 键名容器（含配音按钮）自己处理点击，放行
    if (target?.closest?.(`.${UNIT_CLASS}`)) return
    // 滚动条 / 小地图 / 概览标尺不是"空白处"，别拦
    if (
      target?.closest?.('.scrollbar, .minimap, .slider, .decorationsOverviewRuler')
    ) {
      return
    }
    // 空白处按下：吃掉这次按下 —— 否则 Monaco 会开始选文本 / 移动光标；
    // 然后按"按下并拖动"起一个划框
    event.preventDefault()
    event.stopPropagation()
    const point = contentPointOf(event.clientX, event.clientY)
    marquee = {
      startX: point.x,
      startY: point.y,
      lastX: point.x,
      lastY: point.y,
      additive: event.shiftKey || event.metaKey || event.ctrlKey,
      dragging: false,
    }
  }

  const onStudioPointerMove = (event: PointerEvent) => {
    const box = marquee
    if (!box) return
    const point = contentPointOf(event.clientX, event.clientY)
    const dx = point.x - box.startX
    const dy = point.y - box.startY
    box.lastX = point.x
    box.lastY = point.y
    if (!box.dragging && Math.hypot(dx, dy) < MARQUEE_MIN_DRAG_PX) return
    if (!box.dragging) {
      box.dragging = true
      marqueeEl = document.createElement('div')
      marqueeEl.className = MARQUEE_CLASS
      layer.appendChild(marqueeEl)
    }
    drawMarquee()
  }

  const onStudioPointerUp = () => {
    const box = marquee
    if (!box) return
    removeMarquee()
    if (box.dragging) {
      const keys = keysInMarquee()
      marquee = null
      host.onMarquee?.({ keys, additive: box.additive })
      return
    }
    // 没拖动 = 点了一下空白处：清空选择（按住 Shift 时保留）
    marquee = null
    if (!box.additive) host.onMarquee?.({ keys: [], additive: false })
  }

  const setStudioMode = (on: boolean) => {
    if (studioMode === on) return
    studioMode = on
    if (on) {
      domNode?.classList.add(STUDIO_MODE_CLASS)
      // 让编辑器失焦：否则之前留下的焦点会让「插入角色 / 成键」那套快捷键照样生效
      // （那些热键只在 hasTextFocus 时动作），录音棚模式下正文不该再被改动
      const active = document.activeElement as HTMLElement | null
      if (active && domNode?.contains(active)) active.blur()
    } else {
      domNode?.classList.remove(STUDIO_MODE_CLASS)
      marquee = null
      removeMarquee()
    }
    // 进/出模式都重画一次：按钮的 title 与"缺失态点按钮 = 选中"的语义跟着变
    render()
  }

  /**
   * 语法诊断 → Monaco 装饰：波浪线画在锚点之后（"离文本一个空格"的留白由 CSS 负责），
   * 半透明图形走 after-content（类名映射见 `diagnosticSymbol`）。
   */
  const diagnosticDecorations = (
    model: editor.ITextModel,
  ): editor.IModelDeltaDecoration[] => {
    const analyze = host.analyzeDiagnostics ?? analyzeHsDiagnostics
    return analyze(model.getValue()).map((diag) => ({
      range: monaco.Range.fromPositions(model.getPositionAt(diag.offset)),
      options: {
        stickiness:
          monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        afterContentClassName: diagnosticSymbolClass(diag),
      },
    }))
  }

  /** 重建覆盖框与 view zone（内容 / Ctrl / 映射变化） */
  const render = () => {
    if (disposed) return

    for (const entry of lineEntries) entry.el.remove()
    lineEntries = []
    if (zoneEntries.length > 0) {
      const doomed = zoneEntries
      zoneEntries = []
      ed.changeViewZones((accessor) => {
        for (const entry of doomed) accessor.removeZone(entry.id)
      })
    }

    const model = ed.getModel()
    const map = host.getMap()
    if (!model || !map) {
      collection.clear()
      renderedFingerprint = ''
      return
    }

    const lineHeight = lineHeightPx()
    const decorations: editor.IModelDeltaDecoration[] = []
    // 被隐藏的原文改造成「宽度 = 渲染长度」的槽位，后续标点就会紧贴渲染文本
    const hide = (
      start: number,
      end: number,
      widthPx: number,
    ): editor.IModelDeltaDecoration => ({
      range: monaco.Range.fromPositions(
        model.getPositionAt(start),
        model.getPositionAt(end),
      ),
      options: {
        stickiness:
          monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        inlineClassName: slotStyles.decorationClassFor(widthPx),
        inlineClassNameAffectsLetterSpacing: true,
      },
    })

    const pendingZones: Array<{
      el: HTMLElement
      span: TextSpan
      heightPx: number
    }> = []

    // 先把这一批要渲染的片段收齐，再一次性量宽度：整批只触发一轮布局
    type RenderItem = {
      span: TextSpan
      key: string
      display: string
      displayLines: string[]
      /** Ctrl / 缺文本时显示的是键名，宽度按键名算 */
      showKey: boolean
      stateClass: string
    }
    const items: RenderItem[] = []
    const texts: string[] = []
    const spans = currentSpans()
    renderedFingerprint = computeSpanFingerprint(spans)
    for (const span of spans) {
      const key = normalizeLocaleKey(span.value)
      if (!key) continue

      const value = map.get(key)
      // 键名和值各自按自己的长度渲染（取较长者会把短的一侧撑宽，跟同行后续内容错位）。
      // 正在被编辑的那个框按"打开那一刻"的显示方式渲染：Ctrl 状态中途变化不改它的宽度，
      // 否则槽位跟着变宽变窄，后面的正文整体挪位，编辑框还停在旧位置、和框错开。
      const showKey =
        activeEdit?.key === key ? activeEdit.showKey : ctrlHeld || value == null
      const display = showKey ? key : (value ?? key)
      const displayLines = display.split('\n')
      const stateClass = ctrlHeld
        ? 'hs-lang-ctrl'
        : value == null
          ? 'hs-lang-miss'
          : 'hs-lang-hit'

      items.push({ span, key, display, displayLines, showKey, stateClass })
      if (showKey) texts.push(key)
      else texts.push(...displayLines)
      // 尾标要按实际宽度留槽位，也纳入这批测量
      if (span.terminator) texts.push(TAIL_TEXT)
    }

    // 槽位与框共用同一份实测宽度（px），见 textSlotStyles
    const widths = meter.measure(texts)
    const widthOf = (text: string): number => widths.get(text) ?? 0

    // 音频状态来自音频映射管理（每次 render 取一次句柄即可）
    const voice = host.getVoice?.() ?? null

    for (const item of items) {
      const { span, key, display, displayLines, showKey, stateClass } = item
      const widthPx = showKey
        ? widthOf(key)
        : Math.max(...displayLines.map(widthOf), 1)

      // 原文键名 + 被挪走的 `//` 都改成等宽槽位（保留文档，但占位跟随渲染长度）
      // 槽位宽度 = 文本框 + 间距 + 按钮：选区/光标判定按整个原子单位算
      decorations.push(hide(span.start, span.end, widthPx + VOICE_SLOT_EXTRA_PX))
      if (span.terminator) {
        // `//` 的字符隐掉，但槽位按**它的实际宽度**留（再加与容器的间距）：
        // 尾标由覆盖层画在同一位置，留了宽度，`//` 后面的正文才会排在它之后，
        // 而不是从按钮右沿开始、压在尾标上。
        decorations.push(
          hide(
            span.terminator.start,
            span.terminator.end,
            TAIL_GAP_PX + widthOf(TAIL_TEXT),
          ),
        )
      }

      // 整个值画成一个框（含真换行），框高 = 行数 × 行高 − 3px 缝隙
      const boxHeight = Math.max(
        displayLines.length * lineHeight - BOX_GAP_PX,
        1,
      )
      const lineEl = document.createElement('div')
      lineEl.className = `${LINE_CLASS} ${stateClass}`
      lineEl.style.height = `${boxHeight}px`

      const row = document.createElement('div')
      row.className = ROW_CLASS

      // 上级容器：文本 + 配音按钮。原子化（右键 / 拖拽 / 打开编辑框）都归它
      const unit = document.createElement('div')
      unit.className = `${UNIT_CLASS}${
        studioMode ? ' is-studio' : ''
      }${studioSelection.has(key) ? ` ${STUDIO_SELECTED_CLASS}` : ''}`
      // 键名既是拖拽源（拖到别的键名=替换、拖到文本=插入键名文本），也是投放目标
      bindUnitDragDrop(unit, key)

      const box = makeBox(display, stateClass, widthPx, boxHeight, key)
      unit.appendChild(box)

      // 文本右侧的配音按钮：固定正方形（垂直中央由 CSS 摆放）；四态由映射管理给
      const status = voice?.statusOf(key) ?? null
      const voiceState: VoiceButtonState = status?.state ?? 'missing'
      const button = makeVoiceButton(
        voiceState,
        VOICE_BUTTON_PX,
        studioMode
          ? `${VOICE_STATE_LABEL[voiceState]} · ${
              voiceState === 'ready' || voiceState === 'playing'
                ? '点击播放 / 停止'
                : '点击选中这个键'
            }`
          : voiceButtonTitle(voiceState, status),
        (event) => {
          const additive = event.shiftKey || event.metaKey || event.ctrlKey
          // 录音棚模式下：有音频就照常试听，没有音频点它 = 选中这个键
          if (studioMode) {
            if (voiceState === 'ready' || voiceState === 'playing') {
              voice?.togglePlay(key)
            } else {
              host.onUnitSelect?.({ key, additive })
            }
            return
          }
          // 缺失 / 无效：没有可播的东西，点它就是"配一条音频" —— 打开录音棚
          if (voiceState === 'missing' || voiceState === 'invalid') {
            host.onEditVoice?.(key)
            return
          }
          voice?.togglePlay(key)
        },
      )
      unit.appendChild(button)

      // 左键按下：只拦冒泡（别让 Monaco 收走去动光标）。
      // **不能 preventDefault** —— 浏览器靠 mousedown 的默认行为启动拖拽手势，
      // 阻止了键名就拖不动了。打开编辑框挪到 click（拖拽之后不会触发 click，正好区分）。
      // 代价是焦点会离开编辑器（点不可聚焦的 div 会把焦点丢给 body），
      // 于是 Monaco 收不到 Ctrl+Z、撤销失效 —— 所以这里显式把焦点还回去。
      // 录音棚模式下不抢焦点：编辑器是只读的，抢过去只会多一个没用的光标。
      unit.addEventListener('mousedown', (event) => {
        if (event.button !== 0) return
        event.stopPropagation()
        if (!studioMode) ed.focus()
      })
      unit.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        // 同一按的余波：刚"点别的框 → 切编辑目标"（见 grabBoxAt）——
        // 那一刻已经记过账了，这一下 click 别再按坐标开一次框（提交后重排，底下可能换条了）
        if (echoedPress(event.clientX, event.clientY)) {
          pressEcho = null
          return
        }
        // 录音棚：左键 = 单选，按住 Shift / Ctrl / Cmd = 多选
        if (studioMode) {
          host.onUnitSelect?.({
            key,
            additive: event.shiftKey || event.metaKey || event.ctrlKey,
          })
          return
        }
        openEditorAtPoint(span, box, event.clientX, event.clientY)
      })
      // 右键：交给上层弹可扩展菜单（录音棚模式下没有常规交互，直接吃掉）
      unit.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (studioMode) return
        host.onUnitMenu?.({ key, x: event.clientX, y: event.clientY })
      })
      unit.setAttribute('data-hs-key', key)
      row.appendChild(unit)
      // `//` 渲染在第一行、框外右侧（行是 flex-start 对齐，所以贴在首行）
      const tail = span.terminator ? makeTail() : null
      if (tail) row.appendChild(tail)
      lineEl.appendChild(row)
      layer.appendChild(lineEl)
      lineEntries.push({
        el: lineEl,
        row,
        box,
        // 光标定位要用容器右沿（原子单位是文本 + 按钮）
        unit,
        tail,
        span,
        // 尾标现在排在按钮右边：光标定位要用它的真实左沿
        tailLeft: tail ? tail.offsetLeft : null,
      })

      // 多出来的行用 view zone 占位，把后面的行真实往下推。
      // zone 里不放任何内容：zone 的 DOM 被 Monaco 插在 .view-lines 之下
      // （view.js 里 .view-zones 先 append），点击会被文本层吃掉，
      // 所以视觉一律走覆盖层，zone 只负责撑高度。
      if (displayLines.length > 1) {
        const zoneEl = document.createElement('div')
        zoneEl.className = ZONE_CLASS
        pendingZones.push({
          el: zoneEl,
          span,
          heightPx: (displayLines.length - 1) * lineHeight,
        })
      }
    }

    // —— 诊断装饰：缺闭合符 / 闭合符没独占一行 / `speaker:` 后不该有文本 ——
    decorations.push(...diagnosticDecorations(model))

    collection.set(decorations)

    if (pendingZones.length > 0) {
      ed.changeViewZones((accessor) => {
        zoneEntries = pendingZones.map((zone) => ({
          el: zone.el,
          span: zone.span,
          heightPx: zone.heightPx,
          id: accessor.addZone({
            afterLineNumber: zone.span.endLine,
            heightInPx: zone.heightPx,
            domNode: zone.el,
          }),
        }))
      })
    }

    // 框的元素是刚重建的：正在编辑的那个要重新挂上"藏文字"（编辑框里已经有一份字了）
    syncEditingBox()
    positionBoxes()
    caretOverlay.update()
    syncUnitSelection()
  }

  /** 已成键的框的原子范围（未成键的原文不设防） */
  const boxRegions = () => collectKeyedRegions(currentSpans())

  /** 按 key 找当前渲染出来的那条（菜单动作用；找不到返回 null） */
  const entryFor = (key: string): LineEntry | null => {
    const wanted = normalizeLocaleKey(key)
    if (!wanted) return null
    return (
      lineEntries.find(
        (item) => normalizeLocaleKey(item.span.value) === wanted,
      ) ?? null
    )
  }

  /** 按 key 找片段（覆盖层可能还没渲染，直接查文档片段表兜底） */
  const spanFor = (key: string): TextSpan | null => {
    const wanted = normalizeLocaleKey(key)
    if (!wanted) return null
    return (
      currentSpans().find(
        (span) => normalizeLocaleKey(span.value) === wanted,
      ) ?? null
    )
  }

  /** 右键菜单：改键名 / 改文本（复用等位置覆盖编辑框） */
  const editUnit = (key: string, mode: TextEditMode) => {    const entry = entryFor(key)
    const span = entry?.span ?? spanFor(key)
    if (!span) return
    openEditor(span, entry?.box ?? null, mode)
  }

  /**
   * 右键菜单：删除该键的原子范围 —— 键名本身 + **它自己的**那个 `//`。
   * 于是 `test:key//` → `test:`、`-key1:key2//` 删 key2 → `-key1:`；
   * 而删选项文案（label 不持有终结符）时留着 `//`：`-key1:key2//` 删 key1 → `-:key2//`。
   * 只动正文，映射条目（.lang / .voice）不动 —— 与手工删键的行为一致。
   */
  const deleteUnit = (key: string) => {
    const model = ed.getModel()
    const span = entryFor(key)?.span ?? spanFor(key)
    if (!model || !span) return

    const edits: editor.IIdentifiedSingleEditOperation[] = []
    if (span.terminator) {
      edits.push({
        range: monaco.Range.fromPositions(
          model.getPositionAt(span.terminator.start),
          model.getPositionAt(span.terminator.end),
        ),
        text: '',
      })
    }
    edits.push({
      range: monaco.Range.fromPositions(
        model.getPositionAt(span.start),
        model.getPositionAt(span.end),
      ),
      text: '',
    })

    ed.pushUndoStop()
    ed.executeEdits('hanshu-locale-delete', edits)
    ed.pushUndoStop()
    render()
  }

  /**
   * 拖拽「替换键名」：把目标键的原文整体换成另一个键名。
   * 只改正文（同 deleteUnit 的口径），映射条目不动 —— 换完之后这个片段按新键名取文本。
   */
  const replaceUnitKey = (targetKey: string, nextKey: string) => {
    const model = ed.getModel()
    const span = entryFor(targetKey)?.span ?? spanFor(targetKey)
    const normalized = normalizeLocaleKey(nextKey)
    if (!model || !span || !normalized) return
    if (normalizeLocaleKey(span.value) === normalized) return

    ed.pushUndoStop()
    ed.executeEdits('hanshu-locale-replace-key', [
      {
        range: monaco.Range.fromPositions(
          model.getPositionAt(span.start),
          model.getPositionAt(span.end),
        ),
        text: normalized,
      },
    ])
    ed.pushUndoStop()
    render()
  }

  /**
   * 编辑器文本区：只接受**键名**，落点插入键名文本（**只插文本，不主动成键**）。
   *
   * 无论是否接受都必须吃掉 dragover/drop 的默认行为：否则把外部文件拖进来时，
   * 浏览器会直接导航到那个文件，应用状态全丢。
   * 用捕获阶段（先于 Monaco 自己的拖放处理），但**落在键名容器上的事件要放行**，
   * 否则祖先上的 stopPropagation 会把事件从容器手里抢走。
   */
  const eventInsideUnit = (event: DragEvent): boolean => {
    const target = event.target as HTMLElement | null
    return Boolean(target?.closest?.(`.${UNIT_CLASS}`))
  }

  const onEditorDragOver = (event: DragEvent) => {
    // 落在键名上 = 替换，不是插入：不该有插入光标
    if (eventInsideUnit(event)) {
      hideDropCaret()
      return
    }
    const intent = resolveDropIntent({
      target: 'text',
      source: currentDrag(),
      hasFiles: hasExternalFiles(event.dataTransfer),
    })
    event.preventDefault()
    if (intent?.action !== 'insert-key') {
      // 不接受的内容（例如外部文件）也别留插入光标
      hideDropCaret()
      return
    }
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    const target = ed.getTargetAtClientPoint?.(event.clientX, event.clientY)
    if (target?.position) showDropCaretAt(target.position)
    else hideDropCaret()
  }

  const onEditorDragLeave = (event: DragEvent) => {
    const next = event.relatedTarget as Node | null
    if (!next || !domNode?.contains(next)) hideDropCaret()
  }

  const onEditorDrop = (event: DragEvent) => {
    if (eventInsideUnit(event)) return
    event.preventDefault()
    event.stopPropagation()
    hideDropCaret()
    const source = readDragPayload(event.dataTransfer)
    const intent = resolveDropIntent({
      target: 'text',
      source,
      hasFiles: false,
    })
    endDrag()
    // 拖放后焦点回到编辑器：撤销/重做才有落脚点
    ed.focus()
    if (intent?.action !== 'insert-key') return

    const model = ed.getModel()
    const target = ed.getTargetAtClientPoint?.(event.clientX, event.clientY)
    const position = target?.position ?? ed.getPosition()
    if (!model || !position) return
    ed.pushUndoStop()
    ed.executeEdits('hanshu-key-insert', [
      {
        range: monaco.Range.fromPositions(position),
        text: intent.source.key,
      },
    ])
    ed.pushUndoStop()
  }

  /**
   * 自动成键：把还不是键名的可本地化文本换成新键名。
   *
   * 成键**只换正文、不动语句结构**：多行对白成键后仍是多行块
   * （`name:` / 键名 / 独占一行的 `//` 各占一行），不再收缩成单行 `name:<键>//`。
   * 收缩等于替作者重排版面（注释 / 空行 / 光标位置一起被吞），
   * 也与 Agent 的 `parse_hs`（一直是就地替换）行为不一致。
   *
   * `skipEditing` 用于"用户正在写"的触发路径：光标还在某条语句里（正文行或它的 `//` 行）
   * 就先不成键，等光标离开整条语句再说 —— 否则打到一半的正文会被抢走，也没法再改。
   * 打开文件 / 刷新这类批量路径不带这个选项。
   */
  const migrateNow = (options?: { skipEditing?: boolean }) => {
    if (disposed || migrating) return
    const model = ed.getModel()
    const map = host.getMap()
    if (!model || !map) return

    // `#stopparse` 之后不再自动成键：用户显式关闭这段文本的本地化
    const stopLine = stopParseLineOf(model.getValue())

    const used = new Set<string>()
    for (const [key] of map.entries()) used.add(key)

    const caretLine = options?.skipEditing
      ? (ed.getPosition()?.lineNumber ?? null)
      : null

    /** 空体多行块成键时要插到 `name:` 那一行的行末之后（键名单独占一行） */
    const speakerLineEndOf = (line: number): number =>
      model.getOffsetAt({
        lineNumber: line,
        column: model.getLineMaxColumn(line),
      })

    const plan: Array<{
      span: TextSpan
      key: string
      start: number
      end: number
      text: string
    }> = []

    for (const span of currentSpans()) {
      // 指令行之后的文本（含跨过指令行的多行块）不参与自动成键
      if (stopLine != null && span.endLine >= stopLine) continue
      if (isLocaleKey(span.value)) continue
      if (caretLine != null) {
        const next =
          span.endLine < model.getLineCount()
            ? model.getLineContent(span.endLine + 1)
            : null
        const range = statementLineRange(span, next)
        if (caretLine >= range.from && caretLine <= range.to) continue
      }
      const key = createLocaleKeyFromText(span.value, (candidate) =>
        used.has(candidate),
      )
      used.add(key)
      plan.push({
        span,
        key,
        ...keyReplacementFor(span, key, model.getEOL(), speakerLineEndOf),
      })
    }
    if (plan.length === 0) return

    const cursor = ed.getPosition()
    const cursorOffset = cursor ? model.getOffsetAt(cursor) : null

    // 先锁住重入：写映射会触发订阅回调 → refresh → migrateNow
    migrating = true
    try {
      // 先写映射（缓存 + 虚拟文件），再改正文
      const entries = plan.map(({ span, key }) => [key, span.value] as [string, string])
      migrationLog.push({ entries })
      map.setMany(entries)

      const edits: editor.IIdentifiedSingleEditOperation[] = plan.map(
        ({ start, end, text }) => ({
          range: monaco.Range.fromPositions(
            model.getPositionAt(start),
            model.getPositionAt(end),
          ),
          text,
        }),
      )

      let shift = 0
      if (cursorOffset != null) {
        for (const { start, end, text } of plan) {
          if (end <= cursorOffset) shift += text.length - (end - start)
        }
      }

      ed.pushUndoStop()
      ed.executeEdits('hanshu-locale-key', edits)
      ed.pushUndoStop()

      if (cursorOffset != null) {
        const m = ed.getModel()
        if (m) {
          const target = Math.max(0, cursorOffset + shift)
          // 内部搬运：落点即使压在框沿上也不算"贴框"，别顺势弹编辑框
          moveCaret(target, true)
        }
      }
    } finally {
      migrating = false
    }

    render()
  }

  const scheduleMigrate = () => {
    if (disposed || migrating) return
    if (timer != null) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = null
      // 打字触发：光标还在语句里就不成键
      migrateNow({ skipEditing: true })
      render()
    }, MIGRATE_DEBOUNCE_MS)
  }

  /**
   * 撤销 / 重做自动成键时，把映射一起收拾干净（E2）：
   * - 撤销：正文退回了原文 → 这次成键写入的条目已无人引用 → 删掉（否则 lang 文件里会残留孤儿条目）
   * - 重做：键名又回到正文 → 把条目放回去，避免变成"缺文本"的红框
   * 判断依据是"键名是否还在正文里"（见 textKeyRules.pickUndone / pickRedone），
   * 不依赖具体编辑批次，多级撤销也能逐条对上。
   */
  const reconcileMigrations = (event: editor.IModelContentChangedEvent) => {
    const model = ed.getModel()
    const map = host.getMap()
    if (!model || !map) return
    const text = model.getValue()

    // 删条目 / 放回条目会触发订阅 → refresh → migrateNow，锁住避免立刻重新成键
    const withLock = (apply: () => void) => {
      migrating = true
      try {
        apply()
      } finally {
        migrating = false
      }
    }

    if (event.isUndoing) {
      const { drop, keep } = pickUndone(migrationLog, text)
      migrationLog = keep
      if (drop.length === 0) return
      withLock(() => {
        for (const record of drop) {
          map.deleteMany(record.entries.map(([key]) => key))
        }
      })
      redoLog.push(...drop)
    } else {
      const { restore, keep } = pickRedone(redoLog, text)
      redoLog = keep
      if (restore.length === 0) return
      withLock(() => {
        for (const record of restore) map.setMany(record.entries)
      })
      migrationLog.push(...restore)
    }
  }

  const setCtrl = (next: boolean) => {
    ctrlRaw = next
    // 编辑中**不切渲染态**：切了，所有框都要改宽度、正文整体重排，而编辑框是按
    // 打开那一刻的矩形贴上去的 —— 一按 Ctrl 框就跟正文脱开、留在原地。
    // 这一按只记进 ctrlRaw，等编辑结束（flushCtrlRender）再跟手。
    if (activeEdit) return
    if (ctrlHeld === next) return
    ctrlHeld = next
    render()
  }

  /**
   * 编辑结束：把编辑期间按过 / 放过的 Ctrl 补到渲染上。
   * 提交 / 取消 / 出框三条出口都是先 clearEditingBox 再调这里，所以此刻能安全重画 ——
   * 否则「按住 Ctrl 点开框 → 松开 Ctrl → 关掉框」会一直停在键名预览那一版。
   */
  const flushCtrlRender = () => {
    if (activeEdit || ctrlHeld === ctrlRaw) return
    ctrlHeld = ctrlRaw
    render()
  }

  /**
   * 光标贴到框上时打开编辑框（插入点按"框内比例 → 横向像素 → 最近的字符边界"预判）。
   * 返回是否真的打开了；开不了时调用方退回"整体跳到框另一侧"的老行为。
   */
  const openEditorFromCaret = (
    span: TextSpan,
    offset: number,
  ): boolean => {
    const map = host.getMap()
    if (!map) return false
    const key = normalizeLocaleKey(span.value)
    if (!key) return false
    const mode: TextEditMode = ctrlHeld ? 'key' : 'value'
    const text = mode === 'key' ? key : (map.get(key) ?? '')
    const element = entryFor(key)?.box ?? null
    const rect = rectForSpan(span, element)
    if (mode === 'key') rect.height = Math.min(rect.height, lineHeightPx())
    // 从下面贴上来的（上一次光标在框下面）落多行值的最后一行，否则落首行
    const fromBelow = lastCaretLine != null && lastCaretLine > span.endLine
    return openEditor(
      span,
      element,
      mode,
      caretIndexInBox(span, offset, text, rect, fromBelow),
    )
  }

  /** 点在框上：按点击点算插入位置（点哪插哪），再打开编辑框 */
  const openEditorAtPoint = (
    span: TextSpan,
    element: HTMLElement | null,
    clientX: number,
    clientY: number,
  ) => {
    const map = host.getMap()
    if (!map) return
    const key = normalizeLocaleKey(span.value)
    if (!key) return
    const mode: TextEditMode = ctrlHeld ? 'key' : 'value'
    const text = mode === 'key' ? key : (map.get(key) ?? '')
    // 调用方没给框元素（例如点在隐藏的键名占位上、由 mouseSub 兜住）就按 key 找回来：
    // 量出来的矩形才是"黄底框自己的矩形"，编辑框要跟它等大
    const box = element ?? entryFor(key)?.box ?? null
    const rect = rectForSpan(span, box)
    if (mode === 'key') rect.height = Math.min(rect.height, lineHeightPx())
    openEditor(span, box, mode, clickIndexInBox(text, rect, clientX, clientY))
  }

  /**
   * 编辑框外按下时先问一句："这一点按在**另一个键框**上了吗"（见 TextEditRequest.grabBoxAt）。
   *
   * 是 → 返回"提交完当前这份就把这一按排进切换队列"的回调。此刻按下点的几何最准，
   * 所以**现在**就把插入位置算好（提交会让正文重排、框挪位，稍后同一坐标底下可能已经不是这条了）。
   * 开框的动作等这一按抬起来再做（见 onSwitchRelease / pendingSwitch）——
   * 按下时就开的话，后面那一记 mousedown 会把焦点从刚聚焦的输入框抢走，框里就没光标了。
   *
   * 不是 → null（点空白 / 行尾 / 配音按钮，或者点的就是正在编辑的这个框）。
   * 配音按钮要排除：那一下归按钮自己（开录音棚 / 试听），不该顺手把编辑框挪过来。
   */
  const grabBoxAt = (clientX: number, clientY: number): (() => void) | null => {
    if (disposed || studioMode) return null
    const map = host.getMap()
    if (!map) return null
    const target = document.elementFromPoint?.(clientX, clientY) as HTMLElement | null
    if (!target) return null
    if (target.closest?.(`.${VOICE_CLASS}`)) return null
    const unit = target.closest?.(`.${UNIT_CLASS}`) as HTMLElement | null
    const key = normalizeLocaleKey(unit?.getAttribute('data-hs-key') ?? '')
    if (!key) return null
    // 点的就是正在编辑的这个框：当"点了外面"（提交并脱出）就好，不重开
    if (activeEdit?.key === key) return null
    const entry = entryFor(key)
    if (!entry) return null
    const mode: TextEditMode = ctrlHeld ? 'key' : 'value'
    const text = mode === 'key' ? key : (map.get(key) ?? '')
    const caretIndex = clickIndexInBox(
      text,
      entry.box.getBoundingClientRect(),
      clientX,
      clientY,
    )
    // 这一按的余波现在就要记账：提交会让正文重排，随后那记 click 的坐标底下
    // 可能已经换成别的框了 —— 认出来吃掉它（见 echoedPress / isPressEcho）
    pressEcho = { x: clientX, y: clientY, at: Date.now() }
    return () => {
      if (disposed) return
      // 提交完了：把切换排进队列，等这一按抬起来再开（见 pendingSwitch / onSwitchRelease）。
      // 开的时候按 key 重新查活着的框（提交后覆盖层已重建，元素和 span 都是新的）。
      const open = () => {
        if (disposed) return
        const live = entryFor(key)
        if (!live) return
        openEditor(live.span, live.box, mode, caretIndex)
      }
      pendingSwitch = { x: clientX, y: clientY, open }
    }
  }

  /**
   * 这一按抬起来了：真要是"点"（没挪窝）就把排队的切换兑现。
   * 挪远了（按着拖了一段）就不算点，作废 —— 拖拽另有 dragstart 那道作废。
   */
  const onSwitchRelease = (event: MouseEvent) => {
    if (pendingSwitch == null || event.button !== 0) return
    const pending = pendingSwitch
    pendingSwitch = null
    if (!isSameSpot(pending, event.clientX, event.clientY)) return
    pending.open()
  }

  /** 作废排队的切换 + 这一按的记账（新的一次按下 / 拖拽 / 敲键盘都算"这一按过去了"） */
  const cancelSwitch = () => {
    pendingSwitch = null
    pressEcho = null
  }

  /**
   * 刚由"点别的框 → 切编辑目标"按下过吗（见 `isPressEcho`，判定本身在纯算术里）。
   * 同一按的余波要认它：click 别再按坐标开一次框（消费，见 render 里的 click 监听）。
   */
  const echoedPress = (x: number, y: number): boolean =>
    isPressEcho(pressEcho, x, y, Date.now())

  /**
   * 光标"贴上框"就自动开编辑框 —— **位置驱动**：不管是方向键、点击还是 Home/End，
   * 只要落点贴在框上（含两侧框沿，见 `hitCaretBox`）就进框，插入点由 caretIndexInBox 预判。
   * 因此在正文里光标永远停不到框沿上，从框里往外挪必须多走一步（见 exitCaretOffset）。
   *
   * 不抢的情况：有选区（用户在选择）、编辑器没有文本焦点（内部搬运光标）、
   * 以及刚被内部搬过来的那一格（caretGuardOffset）。
   * 开不了编辑框（例如还没有语言映射）时退回老行为：整体跳到框的另一侧。
   */
  const handleCaretEnter = () => {
    if (disposed || studioMode) return
    const model = ed.getModel()
    const position = ed.getPosition()
    if (!model || !position) return
    const offset = model.getOffsetAt(position)
    if (caretGuardOffset != null) {
      const guarded = caretGuardOffset === offset
      caretGuardOffset = null
      if (guarded) return
    }
    const selection = ed.getSelection()
    if (selection && !selection.isEmpty()) return
    if (!ed.hasTextFocus?.()) return
    const boxes = keyedBoxes()
    if (boxes.length === 0) return
    const hit = hitCaretBox(
      boxes.map((box) => box.region),
      offset,
    )
    if (!hit) return
    const box = boxes.find(
      (item) =>
        item.region.start === hit.region.start &&
        item.region.end === hit.region.end,
    )
    if (!box) return
    if (openEditorFromCaret(box.span, offset)) return
    snapCursorOutOfBox()
  }

  /**
   * 框是整体：光标不允许停在键名里面。
   * 从左边进来落到框左沿，从右边进来落到框右沿 —— 也就是"直接跳过整个框"。
   * 延迟一拍再改光标：Monaco 自己的联动编辑也走调度器，在光标事件里同步改会被同一轮更新覆盖。
   * 注意：这是**开不了编辑框时**的兜底，能开框的路径见 handleCaretEnter。
   */
  const snapCursorOutOfBox = () => {
    if (disposed || snapping) return
    const model = ed.getModel()
    const position = ed.getPosition()
    if (!model || !position) return
    const offset = model.getOffsetAt(position)
    const dir =
      lastArrowDir ??
      (lastCaretOffset != null && offset < lastCaretOffset ? 'left' : 'right')
    const target = snapTarget(boxRegions(), offset, dir)
    if (target == null) return
    lastArrowDir = null
    snapping = true
    if (snapTimer != null) window.clearTimeout(snapTimer)
    snapTimer = window.setTimeout(() => {
      snapTimer = null
      snapping = false
      const m = ed.getModel()
      if (disposed || !m) return
      // 落到的是框沿 —— 那也是"贴框"信号，这一格同样要屏蔽掉，否则会被编辑框吞回去
      moveCaret(target, true)
    }, 0)
  }

  /**
   * 删除键只"蹭到"框的一部分时，整键无响应：
   * 否则会改坏键名，被自动成键逻辑当成新文本再生成一个键。
   * 完整包含整个框的删除（例如选中整行）仍然放行 —— 那是明确的删除意图。
   */
  const deletionTouchesBox = (forward: boolean): boolean => {
    const model = ed.getModel()
    if (!model) return false
    const regions = boxRegions()
    if (regions.length === 0) return false
    const ranges = (ed.getSelections() ?? []).map((selection) =>
      deletionRange(
        {
          start: model.getOffsetAt({
            lineNumber: selection.startLineNumber,
            column: selection.startColumn,
          }),
          end: model.getOffsetAt({
            lineNumber: selection.endLineNumber,
            column: selection.endColumn,
          }),
        },
        forward,
      ),
    )
    return isDeletionHittingKey(regions, ranges)
  }

  /**
   * 上下键挪进框里：在**像素**上预判落点，直接开那个框。
   *
   * 为什么不能交给 Monaco：上下移动按**列号**走（GPU 渲染的行更是拿原文逐字累加宽度
   * 反推列），而键名 / `//` 在屏幕上是宽度等于译文实测宽度的槽位。于是从上一行的第 3 列
   * 按下来，光标落在隐藏键名的第 3 格 —— 那是**框宽的 3/8**，预判到的译文插入点被放大成
   * 四五个字；反方向挪回去也回不到原来那一格（用户实测"同样位置的进和出不对等、不可逆"）。
   *
   * 做法：先取当前光标的**实测像素 x**（`lineXForOffset`，与 `offsetAtLineX` 同一把尺子），
   * 再看目标行上同一个 x 是不是压在某个键名框上（`boxLandingAt`）：是就直接开那个框，
   * 插入位置由这个 x 反推 —— 上下挪移只改行、不改横向像素，进和出用的是同一条尺子。
   * 压不上框（或算不出几何）返回 false，交回 Monaco 走原生行为。
   */
  const verticalBoxEntry = (down: boolean): boolean => {
    if (disposed || studioMode || activeEdit) return false
    // Ctrl 模式显示的是键名本身，原生列号就是对的；带修饰键 / 有选区也不抢
    if (ctrlHeld || ctrlRaw) return false
    if (!ed.hasTextFocus?.()) return false
    const selection = ed.getSelection()
    if (selection && !selection.isEmpty()) return false
    const model = ed.getModel()
    const position = ed.getPosition()
    if (!model || !position) return false
    const line = position.lineNumber
    const target = down ? line + 1 : line - 1
    if (target < 1 || target > model.getLineCount()) return false
    // 软换行行：上下键走视觉行，这里按文档行算会跨行，让位给 Monaco
    if (lineVisualRows(line) > 1) return false
    const lineLeft = lineLeftOf(line)
    if (lineLeft == null) return false
    const x =
      lineLeft +
      lineXForOffset(
        model.getOffsetAt({ lineNumber: line, column: 1 }),
        model.getLineContent(line),
        model.getOffsetAt(position),
        lineSlotsOf(line, lineLeft),
        (text) => meter.measure([text]).get(text) ?? 0,
      )
    const landing = boxLandingAt(target, x, !down)
    if (!landing) return false
    return openEditor(landing.span, landing.el, landing.mode, landing.caretIndex)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    // 用户自己动手了：上一次内部搬运留下的"跳过一格"作废；
    // 键盘都敲下来了，说明"点别的框"那一按早结束了，排队/记账一并作废
    caretGuardOffset = null
    cancelSwitch()
    setCtrl(event.ctrlKey || event.metaKey)
    if (!ed.hasTextFocus()) return
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
      if (verticalBoxEntry(event.key === 'ArrowDown')) {
        // 捕获阶段拦下：不让 Monaco 按列号再挪一次（那会把落点甩到框的另一格）
        event.preventDefault()
        event.stopPropagation()
      }
      return
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      lastArrowDir = event.key === 'ArrowLeft' ? 'left' : 'right'
      return
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      if (deletionTouchesBox(event.key === 'Delete')) {
        // 捕获阶段拦下：Monaco 的文本框收不到这次按键，等于无响应
        event.preventDefault()
        event.stopPropagation()
      }
    }
  }
  const onKeyUp = (event: KeyboardEvent) =>
    setCtrl(event.ctrlKey || event.metaKey)
  const onBlur = () => setCtrl(false)

  const onScroll = () => {
    schedulePosition()
    // 划框中滚轮翻页：框锚在内容上，滚动后要按新的滚动量重画，才跟着正文走
    if (marquee?.dragging) drawMarquee()
  }
  /**
   * 任何祖先容器的滚动（含整页滚动）。
   *
   * 编辑框是 `position: fixed`，整页一滚它就与原位错开，而 Monaco 的滚动事件不会响 ——
   * 所以编辑期间额外听一层 document 的 scroll（捕获阶段，能听到内层滚动容器）。
   * 没开编辑框时这个监听一分钱不花。
   */
  const onAnyScroll = () => {
    if (activeEdit) schedulePosition()
  }
  // 注意：加 view zone 本身会触发 layout 变化，这里绝不能重建 zone
  const onLayout = () => {
    if (domNode) ed.applyFontInfo(layer)
    schedulePosition()
  }

  // 覆盖框盖住了键名，Monaco 收不到点击；这里兜住直接点在键名占位上的情况
  const mouseSub = ed.onMouseDown((event) => {
    if (!host.getMap()) return
    // 录音棚：常规交互整体让位（左键点键名归覆盖层，点空白处归划框）
    if (studioMode) return
    const model = ed.getModel()
    const position = event.target.position
    if (!model || !position) return
    const span = findSpanAt(currentSpans(), model.getOffsetAt(position))
    if (!span) return
    event.event.preventDefault()
    // 直接点在键名占位上的那一下：也要"点哪插哪"（位置驱动平时会先兜住这种情况）
    openEditorAtPoint(
      span,
      null,
      event.event.browserEvent.clientX,
      event.event.browserEvent.clientY,
    )
  })

  const contentSub = ed.onDidChangeModelContent((event) => {
    // 内容变了，之前记录的光标偏移失效（避免用它判断方向）
    lastCaretOffset = null
    lastCaretLine = null
    // 撤销 / 重做：只收拾映射，不再自动成键（否则刚撤销就被立刻重新成键，撤销等于无效）
    if (event.isUndoing || event.isRedoing) {
      reconcileMigrations(event)
      render()
      return
    }
    // 先摆正覆盖框（同步），再安排成键（防抖）
    syncOverlayAfterEdit()
    scheduleMigrate()
  })
  const scrollSub = ed.onDidScrollChange(onScroll)
  const layoutSub = ed.onDidLayoutChange(onLayout)
  // 光标进出片段 / 焦点变化时重画自绘光标；**贴上框就打开编辑框**（位置驱动）
  const caretSub = ed.onDidChangeCursorPosition(() => {
    handleCaretEnter()
    const m = ed.getModel()
    const p = ed.getPosition()
    lastCaretOffset = m && p ? m.getOffsetAt(p) : null
    lastCaretLine = p?.lineNumber ?? null
    caretOverlay.update()
    // 光标离开某条语句后补做成键（"光标还在里面就不成键"需要这一脚）
    scheduleMigrate()
  })
  const focusSub = ed.onDidFocusEditorText?.(() => {
    caretOverlay.update()
    syncUnitSelection()
  })
  const blurSub = ed.onDidBlurEditorText?.(() => {
    caretOverlay.update()
    syncUnitSelection()
  })
  // 选区变化：多行值的选中底色由覆盖层补（见 syncUnitSelection）
  const selectionSub = ed.onDidChangeCursorSelection?.(() => syncUnitSelection())

  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('keyup', onKeyUp, true)
  window.addEventListener('blur', onBlur)
  // 捕获阶段听所有滚动容器的滚动：编辑框是 fixed 定位，光靠 Monaco 的滚动事件不够
  window.addEventListener('scroll', onAnyScroll, true)
  // 拖到文本区：键名插入（捕获阶段，先于 Monaco 自己的拖放处理）
  domNode?.addEventListener('dragover', onEditorDragOver, true)
  domNode?.addEventListener('drop', onEditorDrop, true)
  domNode?.addEventListener('dragleave', onEditorDragLeave, true)
  // 兜底：任何地方结束拖拽（拖到窗口外、按 ESC 取消）都收掉落点光标
  window.addEventListener('dragend', hideDropCaret, true)
  window.addEventListener('drop', hideDropCaret, true)
  /**
   * "点别的框 → 切编辑目标"这一按的收尾（见 grabBoxAt / pendingSwitch）：
   * - pointerdown（捕获，早于编辑框的提交处理）→ 上一次记账作废：新的一按开始了
   * - mouseup → 兑现排队的切换（真要是"点"才兑现）
   * - dragstart → 按着开始拖了，不是点，作废
   */
  window.addEventListener('pointerdown', cancelSwitch, true)
  window.addEventListener('mouseup', onSwitchRelease, true)
  window.addEventListener('dragstart', cancelSwitch, true)
  // 录音棚划框：按下在编辑器内（捕获阶段，先于 Monaco），移动 / 抬起听 window
  domNode?.addEventListener('pointerdown', onStudioPointerDown, true)
  window.addEventListener('pointermove', onStudioPointerMove)
  window.addEventListener('pointerup', onStudioPointerUp)
  window.addEventListener('pointercancel', onStudioPointerUp)

  // 初次：先成键再渲染
  migrateNow()
  render()

  return {
    refresh() {
      migrateNow()
      render()
    },
    refreshVoice() {
      // 配音状态是渲染期读出来的：只重画覆盖框，不动文档、不触发成键
      render()
    },
    editUnit,
    deleteUnit,
    replaceUnitKey,
    setStudioMode,
    setStudioSelection(keys) {
      studioSelection = new Set(
        keys.map((key) => normalizeLocaleKey(key)).filter(Boolean),
      )
      applyStudioSelection()
    },
    listKeys: listUnitKeys,
    dispose() {
      disposed = true
      clearEditingBox()
      if (timer != null) window.clearTimeout(timer)
      if (snapTimer != null) window.clearTimeout(snapTimer)
      if (frame != null) window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('scroll', onAnyScroll, true)
      domNode?.removeEventListener('dragover', onEditorDragOver, true)
      domNode?.removeEventListener('drop', onEditorDrop, true)
      domNode?.removeEventListener('dragleave', onEditorDragLeave, true)
      domNode?.removeEventListener('pointerdown', onStudioPointerDown, true)
      window.removeEventListener('pointermove', onStudioPointerMove)
      window.removeEventListener('pointerup', onStudioPointerUp)
      window.removeEventListener('pointercancel', onStudioPointerUp)
      domNode?.classList.remove(STUDIO_MODE_CLASS)
      marquee = null
      removeMarquee()
      window.removeEventListener('dragend', hideDropCaret, true)
      window.removeEventListener('drop', hideDropCaret, true)
      window.removeEventListener('pointerdown', cancelSwitch, true)
      window.removeEventListener('mouseup', onSwitchRelease, true)
      window.removeEventListener('dragstart', cancelSwitch, true)
      cancelSwitch()
      hideDropCaret()
      contentSub.dispose()
      scrollSub.dispose()
      layoutSub.dispose()
      caretSub.dispose()
      selectionSub?.dispose()
      focusSub?.dispose()
      blurSub?.dispose()
      mouseSub.dispose()
      collection.clear()
      caretOverlay.dispose()
      slotStyles.dispose()
      for (const entry of lineEntries) entry.el.remove()
      lineEntries = []
      if (zoneEntries.length > 0) {
        const doomed = zoneEntries
        zoneEntries = []
        ed.changeViewZones((accessor) => {
          for (const entry of doomed) accessor.removeZone(entry.id)
        })
      }
      layer.remove()
    },
  }
}
