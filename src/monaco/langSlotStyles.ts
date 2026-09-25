/**
 * 文档里原文（键名 / 被挪走的 `//`）的占位槽位。
 *
 * 键名在文档里本来占 8 列，渲染出来的本地化文本长度通常不等于 8 列。
 * 这里把那段原文改造成「宽度 = 渲染长度」的 inline-block 槽位，
 * 于是同一行后面的标点（`:`、`>>` 等）会紧贴渲染文本，
 * 占位空间、覆盖框、点击判定区三者对齐。
 */

/** 文档里键名 / `//` 的占位槽位类前缀（量真实矩形时按它查询） */
export const SLOT_CLASS = 'hs-lang-slot'

/** 让原文不可见：保留占位、不参与视觉 */
export const HIDDEN_CLASS = 'hs-lang-key-hidden'

/** 全角字符（东亚宽 / 全宽）占 2 个 ch，跟 Monaco 的列宽口径保持一致 */
function isFullWidth(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  )
}

/** 文本的可视宽度（以 ch 计，按码点算） */
export function visualWidthCh(text: string): number {
  let width = 0
  for (const ch of text) {
    width += isFullWidth(ch.codePointAt(0) ?? 0) ? 2 : 1
  }
  return width
}

/** 多行文本里最长一行的可视宽度（ch） */
export function longestLineCh(text: string): number {
  let max = 0
  for (const line of text.split('\n')) {
    const width = visualWidthCh(line)
    if (width > max) max = width
  }
  return max
}

export type LangSlotStyles = {
  /** 该宽度的槽位类，返回可直接交给 `inlineClassName` 的完整类名 */
  decorationClassFor(widthCh: number): string
  dispose(): void
}

/**
 * 槽位宽度是按需生成的，所以挂一个内部样式表，同一宽度只生成一条规则。
 * 用 `clip-path` 而不是 `overflow: hidden`：后者会把 inline-block 的基线改成底边，
 * 把整行文字顶歪。`clip-path` 只影响绘制与命中，基线不受影响。
 */
export function createLangSlotStyles(): LangSlotStyles {
  const styleEl =
    typeof document !== 'undefined' && document.head
      ? document.createElement('style')
      : null
  if (styleEl) document.head.appendChild(styleEl)
  const known = new Set<string>()

  return {
    decorationClassFor(widthCh: number): string {
      const width = Math.max(0, Math.round(widthCh))
      const cls = `${SLOT_CLASS}-${width}`
      if (styleEl && !known.has(cls)) {
        known.add(cls)
        styleEl.textContent += `.${cls}{display:inline-block;width:${width}ch;clip-path:inset(0)}\n`
      }
      return `${HIDDEN_CLASS} ${cls}`
    },
    dispose() {
      known.clear()
      styleEl?.remove()
    },
  }
}
