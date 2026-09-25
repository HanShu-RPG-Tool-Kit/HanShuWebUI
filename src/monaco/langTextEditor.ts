import type { Monaco } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import {
  createLocaleKey,
  isLocaleKey,
  normalizeLocaleKey,
  type LangTextMap,
} from '../i18n/langTextMap'
import { createLangCaretOverlay, type CaretLine } from './langCaretOverlay'
import {
  createLangSlotStyles,
  longestLineCh,
  SLOT_CLASS,
} from './langSlotStyles'
import { findSpanAt, parseLangSpans, type LangSpan } from './langTextSpans'

/**
 * 编辑器内的本地化文本渲染 / 交互 / 自动成键。
 *
 * 渲染是「渲染级替换」：文档一个字都不改，只改动原文的占位宽度。
 * - 原文键名与紧随的 `//` 都被隐藏，并改造成「宽度 = 渲染长度」的槽位
 *   （见 langSlotStyles），因此同一行后面的标点会紧贴渲染文本
 * - 显示值画在覆盖层 `.hs-lang-layer` 的 `.hs-lang-line` 里：整个值（含真换行）
 *   是**一个连续框**，框高 = 行数 × 行高 − 缝隙；值多于一行时多出来的高度由
 *   **ViewZone** 真实占位（zone 本身是空元素），把后面的行往下推
 * - 紧跟片段的 `//` 由 `.hs-lang-tail` 重画在框右侧的**首行**（框外）
 * - 定位量的是槽位的真实矩形（Monaco 的列坐标是算术推导，与渲染宽度已不一致）
 * - 不按 Ctrl：命中=半透明黄底、缺失=半透明红底，鼠标悬停时底色加深
 * - 按住 Ctrl：显示原始键名 + 蓝色虚线框
 * - 光标落在片段内时由 langCaretOverlay 接管（原生光标会停在不可见的原文列上）
 *
 * 交互：点击框 = 覆盖弹出编辑框（Ctrl=改键名，否则=改映射值）。
 * 自动成键：`//` 终结的可本地化文本还不是 8 位键名时，生成无冲突随机键名，
 * 写入映射并把原文替换成键名。
 */

export type LangTextRect = {
  left: number
  top: number
  width: number
  height: number
}

export type LangEditMode = 'key' | 'value'

export type LangEditRequest = {
  mode: LangEditMode
  /** 被编辑的键名 */
  key: string
  /** 编辑框初始值（改键名=键名本身；改值=映射值，缺失为空串） */
  initial: string
  /** 视口坐标（position: fixed 覆盖用） */
  rect: LangTextRect
  /** 提交：改键名→替换正文里的键；改值→写入映射 */
  apply(next: string): void
}

export type LangTextHost = {
  /** 当前活动文件的语言文本映射；不适用（非 .hs、无活动文件、看资产）时返回 null */
  getMap(): LangTextMap | null
  /** 请求弹出等位置覆盖编辑框 */
  onEditRequest(request: LangEditRequest): void
}

export type LangTextBinding = {
  /** 外部状态变化（换语言 / 换文件 / 映射内容变）时重算 */
  refresh(): void
  dispose(): void
}

const LAYER_CLASS = 'hs-lang-layer'
const LINE_CLASS = 'hs-lang-line'
const ROW_CLASS = 'hs-lang-row'
const BOX_CLASS = 'hs-lang-box'
const TAIL_CLASS = 'hs-lang-tail'
const ZONE_CLASS = 'hs-lang-zone'
const MIGRATE_DEBOUNCE_MS = 220
/** 框底留出的空隙，避免相邻行的框交叉 */
const BOX_GAP_PX = 3

/** 一行覆盖框：形状即 langCaretOverlay 需要的输入，另加一个用于移除的根节点 */
type LineEntry = CaretLine & { el: HTMLElement }
type ZoneEntry = {
  /** 纯占位元素：视觉一律走覆盖层，见 render() 里的注释 */
  el: HTMLElement
  span: LangSpan
  heightPx: number
  id: string
}

export function bindLangText(
  ed: editor.IStandaloneCodeEditor,
  monaco: Monaco,
  host: LangTextHost,
): LangTextBinding {
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
  let ctrlHeld = false
  let migrating = false
  let disposed = false
  let timer: number | null = null
  let frame: number | null = null

  /** 单行行高（来自编辑器字体信息） */
  const lineHeightPx = (): number => {
    const info = ed.getOption?.(monaco.editor.EditorOption.fontInfo)
    const value = Number(info?.lineHeight)
    return Number.isFinite(value) && value > 0 ? value : 28
  }

  /** 文档里原文的占位槽位（宽度 = 渲染长度），见 langSlotStyles */
  const slotStyles = createLangSlotStyles()
  /** 光标落在片段内时接管原生光标，见 langCaretOverlay */
  const caretOverlay = createLangCaretOverlay({
    ed,
    domNode,
    getLines: () => lineEntries,
    isCtrlHeld: () => ctrlHeld,
    lineHeightPx,
  })

  const currentSpans = (): LangSpan[] => {
    const model = ed.getModel()
    return model ? parseLangSpans(model.getValue()) : []
  }

  /** 按 offset 换算覆盖框的视口矩形（需要时取元素本身的矩形） */
  const rectForSpan = (
    span: LangSpan,
    element: HTMLElement | null,
  ): LangTextRect => {
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

  /** 弹出等位置覆盖编辑框 */
  const openEditor = (span: LangSpan, element: HTMLElement | null) => {
    const map = host.getMap()
    if (!map) return
    const key = normalizeLocaleKey(span.value)
    if (!key) return

    const mode: LangEditMode = ctrlHeld ? 'key' : 'value'
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
   * 由于键名槽位宽度 != 键名列数，Monaco 的列坐标（charWidth × 列号）已经不等于画面位置，
   * 所以优先量槽位的真实矩形；只有在槽位没渲染出来（行不在可视区）时才退回列坐标。
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
  }

  const schedulePosition = () => {
    if (frame != null || disposed) return
    frame = window.requestAnimationFrame(positionBoxes)
  }

  const makeTail = (): HTMLElement => {
    const tail = document.createElement('div')
    tail.className = TAIL_CLASS
    tail.textContent = '//'
    return tail
  }

  const makeBox = (
    text: string,
    stateClass: string,
    widthCh: number,
    heightPx: number,
    key: string,
  ): HTMLElement => {
    const box = document.createElement('div')
    box.className = `${BOX_CLASS} ${stateClass}`
    box.textContent = text
    box.style.minWidth = `${widthCh}ch`
    box.style.height = `${heightPx}px`
    box.title = ctrlHeld
      ? `键名 ${key}`
      : `键名 ${key} · 按住 Ctrl 点击可改键名`
    return box
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
      return
    }

    const lineHeight = lineHeightPx()
    const decorations: editor.IModelDeltaDecoration[] = []
    // 被隐藏的原文改造成「宽度 = 渲染长度」的槽位，后续标点就会紧贴渲染文本
    const hide = (
      start: number,
      end: number,
      widthCh: number,
    ): editor.IModelDeltaDecoration => ({
      range: monaco.Range.fromPositions(
        model.getPositionAt(start),
        model.getPositionAt(end),
      ),
      options: {
        stickiness:
          monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        inlineClassName: slotStyles.decorationClassFor(widthCh),
        inlineClassNameAffectsLetterSpacing: true,
      },
    })

    const pendingZones: Array<{
      el: HTMLElement
      span: LangSpan
      heightPx: number
    }> = []

    for (const span of currentSpans()) {
      const key = normalizeLocaleKey(span.value)
      if (!key) continue

      const value = map.get(key)
      const display = ctrlHeld ? key : (value ?? key)
      const displayLines = display.split('\n')
      const multi = displayLines.length > 1
      const stateClass = ctrlHeld
        ? 'hs-lang-ctrl'
        : value == null
          ? 'hs-lang-miss'
          : 'hs-lang-hit'
      // 键名和值各自按自己的长度渲染（取较长者会把短的一侧撑宽，跟同行后续内容错位）
      const widthCh =
        ctrlHeld || value == null ? key.length : Math.max(longestLineCh(value), 1)

      // 原文键名 + 被挪走的 `//` 都改成等宽槽位（保留文档，但占位跟随渲染长度）
      decorations.push(hide(span.start, span.end, widthCh))
      if (span.terminator) {
        // `//` 的渲染替身是我的尾标，槽位宽度取 0
        decorations.push(hide(span.terminator.start, span.terminator.end, 0))
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

      const box = makeBox(display, stateClass, widthCh, boxHeight, key)
      box.addEventListener('mousedown', (event) => {
        event.preventDefault()
        event.stopPropagation()
        openEditor(span, box)
      })
      row.appendChild(box)
      // `//` 渲染在第一行、框外右侧（行是 flex-start 对齐，所以贴在首行）
      const tail = span.terminator ? makeTail() : null
      if (tail) row.appendChild(tail)
      lineEl.appendChild(row)
      layer.appendChild(lineEl)
      lineEntries.push({ el: lineEl, row, box, tail, span })

      // 多出来的行用 view zone 占位，把后面的行真实往下推。
      // zone 里不放任何内容：zone 的 DOM 被 Monaco 插在 .view-lines 之下
      // （view.js 里 .view-zones 先 append），点击会被文本层吃掉，
      // 所以视觉一律走覆盖层，zone 只负责撑高度。
      if (multi) {
        const zoneEl = document.createElement('div')
        zoneEl.className = ZONE_CLASS
        pendingZones.push({
          el: zoneEl,
          span,
          heightPx: (displayLines.length - 1) * lineHeight,
        })
      }
    }

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
  }

  /** 自动成键：把还不是键名的可本地化文本换成新键名 */
  const migrateNow = () => {
    if (disposed || migrating) return
    const model = ed.getModel()
    const map = host.getMap()
    if (!model || !map) return

    const spans = parseLangSpans(model.getValue())
    const used = new Set<string>()
    for (const [key] of map.entries()) used.add(key)

    const plan: Array<{ span: LangSpan; key: string }> = []
    for (const span of spans) {
      if (isLocaleKey(span.value)) continue
      const key = createLocaleKey((candidate) => used.has(candidate))
      used.add(key)
      plan.push({ span, key })
    }
    if (plan.length === 0) return

    const cursor = ed.getPosition()
    const cursorOffset = cursor ? model.getOffsetAt(cursor) : null

    // 先锁住重入：写映射会触发订阅回调 → refresh → migrateNow
    migrating = true
    try {
      // 先写映射（缓存 + 虚拟文件），再改正文
      map.setMany(plan.map(({ span, key }) => [key, span.value]))

      const edits: editor.IIdentifiedSingleEditOperation[] = plan.map(
        ({ span, key }) => ({
          range: monaco.Range.fromPositions(
            model.getPositionAt(span.start),
            model.getPositionAt(span.end),
          ),
          text: key,
        }),
      )

      let shift = 0
      if (cursorOffset != null) {
        for (const { span, key } of plan) {
          if (span.end <= cursorOffset) {
            shift += key.length - (span.end - span.start)
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
      migrateNow()
      render()
    }, MIGRATE_DEBOUNCE_MS)
  }

  const setCtrl = (next: boolean) => {
    if (ctrlHeld === next) return
    ctrlHeld = next
    render()
  }

  const onKeyDown = (event: KeyboardEvent) =>
    setCtrl(event.ctrlKey || event.metaKey)
  const onKeyUp = (event: KeyboardEvent) =>
    setCtrl(event.ctrlKey || event.metaKey)
  const onBlur = () => setCtrl(false)

  const onScroll = () => schedulePosition()
  // 注意：加 view zone 本身会触发 layout 变化，这里绝不能重建 zone
  const onLayout = () => {
    if (domNode) ed.applyFontInfo(layer)
    schedulePosition()
  }

  // 覆盖框盖住了键名，Monaco 收不到点击；这里兜住直接点在键名占位上的情况
  const mouseSub = ed.onMouseDown((event) => {
    if (!host.getMap()) return
    const model = ed.getModel()
    const position = event.target.position
    if (!model || !position) return
    const span = findSpanAt(
      parseLangSpans(model.getValue()),
      model.getOffsetAt(position),
    )
    if (!span) return
    event.event.preventDefault()
    openEditor(span, null)
  })

  const contentSub = ed.onDidChangeModelContent(() => scheduleMigrate())
  const scrollSub = ed.onDidScrollChange(onScroll)
  const layoutSub = ed.onDidLayoutChange(onLayout)
  // 光标进出片段 / 焦点变化时重画自绘光标
  const caretSub = ed.onDidChangeCursorPosition(() => caretOverlay.update())
  const focusSub = ed.onDidFocusEditorText?.(() => caretOverlay.update())
  const blurSub = ed.onDidBlurEditorText?.(() => caretOverlay.update())

  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('keyup', onKeyUp, true)
  window.addEventListener('blur', onBlur)

  // 初次：先成键再渲染
  migrateNow()
  render()

  return {
    refresh() {
      migrateNow()
      render()
    },
    dispose() {
      disposed = true
      if (timer != null) window.clearTimeout(timer)
      if (frame != null) window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onBlur)
      contentSub.dispose()
      scrollSub.dispose()
      layoutSub.dispose()
      caretSub.dispose()
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
