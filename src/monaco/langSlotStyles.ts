/**
 * 文档里原文（键名 / 被挪走的 `//`）的占位槽位。
 *
 * 键名在文档里本来占 8 列，渲染出来的本地化文本长度通常不等于 8 列。
 * 这里把那段原文改造成「宽度 = 渲染长度」的 inline-block 槽位，
 * 于是同一行后面的标点（`:`、`>>` 等）会紧贴渲染文本，
 * 占位空间、覆盖框、点击判定区三者对齐。
 *
 * 宽度不按 ch 推算：`ch` 是字体里「0」的宽度，Consolas 是 0.5498em 而不是 0.5em，
 * 而中文字符是 1em —— 于是「全角 = 2ch」会在每个中文字上多算 0.0996em（≈10%），
 * 中文越长、框比文字长得越多。英文恰好不差（等宽字体里 ASCII 步进 == 「0」的步进），
 * 所以只有中文会露出这个偏差。
 * 现在改成实测像素宽度，见 createTextWidthMeter。
 */

/** 文档里键名 / `//` 的占位槽位类前缀（量真实矩形时按它查询） */
export const SLOT_CLASS = 'hs-lang-slot'

/** 让原文不可见：保留占位、不参与视觉 */
export const HIDDEN_CLASS = 'hs-lang-key-hidden'

/** 全角字符（东亚宽 / 全宽）：只在量不出宽度时用于兜底估算 */
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

/** 兜底估算（没有 DOM 可量时）：全角按 1em、其余按 0.6em 计 */
function estimateWidthPx(text: string, fontSize: number): number {
  let width = 0
  for (const ch of text) {
    width += isFullWidth(ch.codePointAt(0) ?? 0) ? fontSize : fontSize * 0.6
  }
  return width
}

/** 量化到 0.01px：同一宽度复用同一条样式规则，误差也远在可见范围之下 */
function roundPx(value: number): number {
  return Math.round(value * 100) / 100
}

export type TextWidthMeter = {
  /** 批量量文本的渲染宽度（px）；一次调用只触发一轮布局，返回值覆盖全部入参 */
  measure(texts: readonly string[]): Map<string, number>
}

/**
 * 实测文本宽度：测量节点挂在 `host` 下，因此继承与渲染**完全一致**的字体、
 * 字号、letter-spacing、font-feature-settings；`white-space: pre` + `inline-block`
 * 保证拿到的是整行的推进宽度，而不是被容器宽度折行之后的结果。
 *
 * 按文本缓存；字体指纹变了整表作废。
 */
export function createTextWidthMeter(options: {
  /** 承载字体的容器（覆盖层）：测量节点只在这里短暂存在 */
  host(): HTMLElement | null
  /** 字体指纹：变了就作废缓存 */
  fontKey(): string
  /** 量不出来时的兜底字号 */
  fallbackFontSize(): number
}): TextWidthMeter {
  const cache = new Map<string, number>()
  let knownFontKey = options.fontKey()

  const estimate = (text: string): number =>
    roundPx(estimateWidthPx(text, options.fallbackFontSize()))

  return {
    measure(texts) {
      const fontKey = options.fontKey()
      if (fontKey !== knownFontKey) {
        cache.clear()
        knownFontKey = fontKey
      }

      const widths = new Map<string, number>()
      const pending: string[] = []
      for (const text of texts) {
        if (widths.has(text)) continue
        if (!text) {
          widths.set(text, 0)
          continue
        }
        const cached = cache.get(text)
        if (cached !== undefined) {
          widths.set(text, cached)
          continue
        }
        widths.set(text, estimate(text)) // 量不到就留兜底值
        pending.push(text)
      }

      const host = options.host()
      if (pending.length === 0 || !host || typeof document === 'undefined') {
        return widths
      }

      const nodes = pending.map((text) => {
        const el = document.createElement('span')
        el.textContent = text
        // 内联样式：不依赖样式表，也不受 .hs-lang-box 之类的规则影响
        el.style.position = 'absolute'
        el.style.left = '-99999px'
        el.style.top = '0'
        el.style.visibility = 'hidden'
        el.style.whiteSpace = 'pre'
        el.style.display = 'inline-block'
        el.style.boxSizing = 'border-box'
        el.style.padding = '0'
        el.style.border = '0'
        el.style.pointerEvents = 'none'
        host.appendChild(el)
        return el
      })

      // 节点先全部挂好，再统一读矩形：整批只触发一次布局
      nodes.forEach((el, index) => {
        const text = pending[index]
        const rect =
          typeof el.getBoundingClientRect === 'function'
            ? el.getBoundingClientRect()
            : null
        const width =
          rect && rect.width > 0 ? roundPx(rect.width) : estimate(text)
        cache.set(text, width)
        widths.set(text, width)
      })
      for (const el of nodes) el.remove()

      return widths
    },
  }
}

export type LangSlotStyles = {
  /** 该宽度的槽位类，返回可直接交给 `inlineClassName` 的完整类名 */
  decorationClassFor(widthPx: number): string
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
    decorationClassFor(widthPx: number): string {
      const width = roundPx(Number.isFinite(widthPx) ? Math.max(0, widthPx) : 0)
      // 类名得是合法标识符：小数点写成下划线
      const cls = `${SLOT_CLASS}-w${String(width).replace('.', '_')}`
      if (styleEl && !known.has(cls)) {
        known.add(cls)
        styleEl.textContent += `.${cls}{display:inline-block;width:${width}px;clip-path:inset(0)}\n`
      }
      return `${HIDDEN_CLASS} ${cls}`
    },
    dispose() {
      known.clear()
      styleEl?.remove()
    },
  }
}
