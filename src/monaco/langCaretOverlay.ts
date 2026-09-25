import type { editor } from 'monaco-editor'
import type { LangSpan } from './langTextSpans'

/** 覆盖层里自绘的光标 */
export const CARET_CLASS = 'hs-lang-caret'
/** 加在编辑器根节点上：接管光标时藏掉原生光标层 */
const CARET_HIDDEN_CLASS = 'hs-lang-caret-hidden'
/** 尾标 `//` 与框之间的间距，必须与 .hs-lang-tail 的 margin-left 一致 */
const TAIL_GAP_PX = 2

/** 自绘光标需要的每行信息（结构上兼容 langTextEditor 的 LineEntry） */
export type CaretLine = {
  row: HTMLElement
  box: HTMLElement
  tail: HTMLElement | null
  span: LangSpan
}

export type LangCaretOverlay = {
  /** 光标位置 / 焦点 / 内容变化后重画 */
  update(): void
  dispose(): void
}

/**
 * 原生光标由 Monaco 按「列号 × 字符宽」的算术位置绘制，而文档里的原文已经被
 * 改造成宽度等于渲染长度的槽位（见 langSlotStyles），两者不再一致，
 * 光标会停在看不见的原文列上、甚至落在框内部。
 *
 * 做法：这一段位置由我们自己负责 —— 藏掉原生光标层，在框所在的那一行自绘一个同款光标，
 * 按渲染出来的布局定位：
 *   片段起点        -> 框左边
 *   键名内部        -> 框右边（键名是原子 token，没有更细的位置）
 *   `//` 之前       -> 框右边
 *   `//` 之后       -> 尾标右边（语句真正结束的位置）
 * Ctrl 模式显示的就是键名本身，原生光标位置是对的，所以不接管。
 */
export function createLangCaretOverlay(options: {
  ed: editor.IStandaloneCodeEditor
  domNode: HTMLElement | null
  /** 当前覆盖层里的行（每次 render 会重建） */
  getLines(): CaretLine[]
  isCtrlHeld(): boolean
  lineHeightPx(): number
}): LangCaretOverlay {
  const { ed, domNode, getLines, isCtrlHeld, lineHeightPx } = options
  let caretEl: HTMLElement | null = null
  let hiddenCaretLayer: HTMLElement | null = null
  let disposed = false

  /**
   * 藏 / 还原原生光标层。除了类名（CSS 兜底），再直接改 .cursors-layer 的内联样式：
   * 不依赖「容器上一定有 monaco-editor 这个类」这种前提。
   */
  const hideNativeCaret = (hidden: boolean) => {
    const layerEl = domNode?.querySelector?.('.cursors-layer') as HTMLElement | null
    if (hidden) {
      if (layerEl) {
        layerEl.style.visibility = 'hidden'
        hiddenCaretLayer = layerEl
      }
      domNode?.classList?.add(CARET_HIDDEN_CLASS)
      return
    }
    if (hiddenCaretLayer) {
      hiddenCaretLayer.style.visibility = ''
      hiddenCaretLayer = null
    }
    domNode?.classList?.remove(CARET_HIDDEN_CLASS)
  }

  const clear = () => {
    if (caretEl) {
      caretEl.remove()
      caretEl = null
    }
    hideNativeCaret(false)
  }

  const update = () => {
    if (disposed) return
    clear()
    if (isCtrlHeld() || !ed.hasTextFocus?.()) return

    const model = ed.getModel()
    const position = ed.getPosition()
    if (!model || !position) return
    const offset = model.getOffsetAt(position)
    if (!Number.isFinite(offset)) return

    for (const { span, row, box, tail } of getLines()) {
      const tailEnd = span.terminator ? span.terminator.end : span.end
      // 片段 + 它自己那个 `//` 的整段文档占位，都在框/尾标覆盖的可视范围内
      if (offset < span.start || offset > tailEnd) continue

      let left = 0
      if (offset > span.start) {
        // 量出来的实际宽度：框宽 = max(渲染长度)，跟原文列数无关
        const boxWidth = box.getBoundingClientRect?.().width ?? 0
        const tailWidth = tail?.getBoundingClientRect?.().width ?? 0
        left =
          span.terminator && offset >= span.terminator.end
            ? boxWidth + TAIL_GAP_PX + tailWidth
            : boxWidth
      }

      const caret = document.createElement('div')
      caret.className = CARET_CLASS
      caret.style.height = `${lineHeightPx()}px`
      caret.style.left = `${left}px`
      row.appendChild(caret)
      caretEl = caret
      hideNativeCaret(true)
      return
    }
  }

  return {
    update,
    dispose() {
      disposed = true
      clear()
    },
  }
}
