import type { Monaco } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import {
  createLocaleKeyFromText,
  isLocaleKey,
  normalizeLocaleKey,
  type TextMap,
} from '../i18n/textMap'
import { stopParseLineOf } from '../hanshu/directives'
import { createCaretOverlay, type CaretLine } from './textCaretOverlay'
import {
  isDeletionHittingKey,
  deletionRange,
  collectKeyedRegions,
  canonicalDialogueLine,
  pickRedone,
  pickUndone,
  snapTarget,
  statementLineRange,
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
  writeDragPayload,
  type DragSource,
  type DropIntent,
} from '../drag/dragPayload'
import {
  findSpanAt,
  parseTextSpans,
  type DialogueBlock,
  type TextSpan,
} from './textSpans'
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

export type TextEditRequest = {
  mode: TextEditMode
  /** 被编辑的键名 */
  key: string
  /** 编辑框初始值（改键名=键名本身；改值=映射值，缺失为空串） */
  initial: string
  /** 视口坐标（position: fixed 覆盖用） */
  rect: TextRect
  /** 提交：改键名→替换正文里的键；改值→写入映射 */
  apply(next: string): void
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
  /** 当前活动文件的语言文本映射；不适用（非 .hs、无活动文件、看资产）时返回 null */
  getMap(): TextMap | null
  /** 请求弹出等位置覆盖编辑框 */
  onEditRequest(request: TextEditRequest): void
  /** 音频映射管理；非 .hs / 尚未就绪时返回 null（按钮一律渲染成"缺失"） */
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
  /** 光标"整体跳过框"的辅助状态 */
  let snapping = false
  let snapTimer: number | null = null
  let lastArrowDir: 'left' | 'right' | null = null
  let lastCaretOffset: number | null = null
  /** 按 model 版本缓存解析结果（光标移动也要查片段表） */
  let spanCache: { version: number; spans: TextSpan[] } | null = null
  let ctrlHeld = false
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
    const spans = parseTextSpans(model.getValue())
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

  /** 弹出等位置覆盖编辑框；`forced` 用于右键菜单直接指定模式 */
  const openEditor = (
    span: TextSpan,
    element: HTMLElement | null,
    forced?: TextEditMode,
  ) => {
    const map = host.getMap()
    if (!map) return
    const key = normalizeLocaleKey(span.value)
    if (!key) return

    const mode: TextEditMode = forced ?? (ctrlHeld ? 'key' : 'value')
    const rect = rectForSpan(span, element)
    if (mode === 'key') {
      // 改键名是单行框：只按首行高度覆盖（覆盖框可能是多行的）
      rect.height = Math.min(rect.height, lineHeightPx())
    }

    host.onEditRequest({
      mode,
      key,
      initial: mode === 'key' ? key : (map.get(key) ?? ''),
      rect,
      apply: (next: string) => {
        if (mode === 'key') {
          const normalized = normalizeLocaleKey(next)
          if (!normalized) return
          const m = ed.getModel()
          if (!m) return
          const range = monaco.Range.fromPositions(
            m.getPositionAt(span.start),
            m.getPositionAt(span.end),
          )
          if (m.getValueInRange(range).trim().toLowerCase() === normalized) return
          ed.pushUndoStop()
          ed.executeEdits('hanshu-locale-retarget', [
            { range, text: normalized },
          ])
          ed.pushUndoStop()
          render()
          return
        }
        map.set(key, next)
        render()
      },
    })
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
      if (!intent) return
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
    if (state === 'playing') return `${label} · 点击停止`
    if (state === 'ready') {
      const duration =
        status?.info != null ? formatVoiceDuration(status.info.duration) : ''
      return duration
        ? `${label} · 点击播放 · ${duration}`
        : `${label} · 点击播放`
    }
    const hint = state === 'invalid' ? '点击重新选择' : '点击选择'
    return status?.reason ? `${label} · ${status.reason} · ${hint}` : `${label} · ${hint}`
  }

  /**
   * 诊断 → after-content 叠加的虚线符号类名（样式在 App.css 的 `.hs-diag-*`）：
   * 单行缺 `//` 只叠闭合符；多行缺 `//` 叠"回车 + 闭合符"；
   * 闭合符没独占一行 / `speaker:` 后不该有文本只叠回车。
   */
  const diagnosticSymbol = (diag: HsDiagnostic): string =>
    diag.kind === 'missing-terminator'
      ? diag.multiline
        ? 'hs-diag-enter-close'
        : 'hs-diag-close'
      : 'hs-diag-enter'

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
   * 半透明虚线符号走 after-content。
   */
  const diagnosticDecorations = (
    model: editor.ITextModel,
  ): editor.IModelDeltaDecoration[] =>
    analyzeHsDiagnostics(model.getValue()).map((diag) => ({
      range: monaco.Range.fromPositions(model.getPositionAt(diag.offset)),
      options: {
        stickiness:
          monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        afterContentClassName: diagnosticSymbol(diag),
      },
    }))

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
      // 键名和值各自按自己的长度渲染（取较长者会把短的一侧撑宽，跟同行后续内容错位）
      const showKey = ctrlHeld || value == null
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
        // 录音棚：左键 = 单选，按住 Shift / Ctrl / Cmd = 多选
        if (studioMode) {
          host.onUnitSelect?.({
            key,
            additive: event.shiftKey || event.metaKey || event.ctrlKey,
          })
          return
        }
        openEditor(span, box)
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

    const plan: Array<{ span: TextSpan; key: string }> = []
    /**
     * 需要**收缩**的多行对白：成键时整段换成规范单行 `name:<键>//`。
     * 同一条语句的多个片段共享同一个 `dialogueBlock` 对象，按对象聚合。
     */
    const dialogueBlocks = new Map<
      DialogueBlock,
      { key: string; newKeys: number }
    >()
    const noteDialogueBlock = (span: TextSpan, key: string, isNew: boolean) => {
      const block = span.dialogueBlock
      if (!block) return
      const entry = dialogueBlocks.get(block) ?? { key: '', newKeys: 0 }
      entry.key = key || entry.key
      if (isNew) entry.newKeys += 1
      dialogueBlocks.set(block, entry)
    }

    for (const span of currentSpans()) {
      // 指令行之后的文本（含跨过指令行的多行块）不参与自动成键
      if (stopLine != null && span.endLine >= stopLine) continue
      if (isLocaleKey(span.value)) {
        // 已经是键：收缩时也要用上它（不能只认这次新建的键）
        noteDialogueBlock(span, normalizeLocaleKey(span.value), false)
        continue
      }
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
      plan.push({ span, key })
      noteDialogueBlock(span, key, true)
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

      // 需要收缩的多行对白：整段换成规范单行，同一条语句的片段合成一条编辑。
      // 这次没有新建键就不动原文 —— 避免一打开文件就重写用户排版。
      const contractions: Array<{ block: DialogueBlock; text: string }> = []
      for (const [block, entry] of dialogueBlocks) {
        if (entry.newKeys > 0 && entry.key) {
          contractions.push({
            block,
            text: canonicalDialogueLine(block, entry.key),
          })
        }
      }
      const contractedBlocks = new Set(contractions.map(({ block }) => block))
      const contractedSpans = new Set(
        plan
          .filter(
            ({ span }) =>
              span.dialogueBlock != null &&
              contractedBlocks.has(span.dialogueBlock),
          )
          .map(({ span }) => span),
      )

      const edits: editor.IIdentifiedSingleEditOperation[] = [
        ...plan
          .filter(({ span }) => !contractedSpans.has(span))
          .map(({ span, key }) => ({
            range: monaco.Range.fromPositions(
              model.getPositionAt(span.start),
              model.getPositionAt(span.end),
            ),
            text: key,
          })),
        ...contractions.map(({ block, text }) => ({
          range: monaco.Range.fromPositions(
            model.getPositionAt(block.start),
            model.getPositionAt(block.end),
          ),
          text,
        })),
      ]

      let shift = 0
      if (cursorOffset != null) {
        for (const { span, key } of plan) {
          if (contractedSpans.has(span)) continue
          if (span.end <= cursorOffset) {
            shift += key.length - (span.end - span.start)
          }
        }
        // 收缩是"整段换整段"：按语句整体长度变化补偏移
        for (const { block, text } of contractions) {
          if (block.end <= cursorOffset) {
            shift += text.length - (block.end - block.start)
          }
        }
      }

      ed.pushUndoStop()
      ed.executeEdits('hanshu-locale-key', edits)
      ed.pushUndoStop()

      if (cursorOffset != null) {
        const m = ed.getModel()
        if (m) {
          const target = Math.max(0, cursorOffset + shift)
          ed.setPosition(m.getPositionAt(Math.min(target, m.getValueLength())))
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
    if (ctrlHeld === next) return
    ctrlHeld = next
    render()
  }

  /**
   * 框是整体：光标不允许停在键名里面。
   * 从左边进来落到框左沿，从右边进来落到框右沿 —— 也就是"直接跳过整个框"。
   * 延迟一拍再改光标：Monaco 自己的联动编辑也走调度器，在光标事件里同步改会被同一轮更新覆盖。
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
      ed.setPosition(m.getPositionAt(target))
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

  const onKeyDown = (event: KeyboardEvent) => {
    setCtrl(event.ctrlKey || event.metaKey)
    if (!ed.hasTextFocus()) return
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
    openEditor(span, null)
  })

  const contentSub = ed.onDidChangeModelContent((event) => {
    // 内容变了，之前记录的光标偏移失效（避免用它判断方向）
    lastCaretOffset = null
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
  // 光标进出片段 / 焦点变化时重画自绘光标；进框则整体跳到框的另一侧
  const caretSub = ed.onDidChangeCursorPosition(() => {
    snapCursorOutOfBox()
    const m = ed.getModel()
    const p = ed.getPosition()
    lastCaretOffset = m && p ? m.getOffsetAt(p) : null
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
  // 拖到文本区：键名插入（捕获阶段，先于 Monaco 自己的拖放处理）
  domNode?.addEventListener('dragover', onEditorDragOver, true)
  domNode?.addEventListener('drop', onEditorDrop, true)
  domNode?.addEventListener('dragleave', onEditorDragLeave, true)
  // 兜底：任何地方结束拖拽（拖到窗口外、按 ESC 取消）都收掉落点光标
  window.addEventListener('dragend', hideDropCaret, true)
  window.addEventListener('drop', hideDropCaret, true)
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
      if (timer != null) window.clearTimeout(timer)
      if (snapTimer != null) window.clearTimeout(snapTimer)
      if (frame != null) window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onBlur)
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
