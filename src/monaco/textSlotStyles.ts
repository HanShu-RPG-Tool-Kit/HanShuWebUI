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

/**
 * 按文本缓存的条目上限。
 *
 * 为什么要有上限：打字跟手会不断给 meter 喂**新的**文本（每按一键就多一个前缀，
 * 中文输入法组字时更多），这些前缀几乎互不复用 —— 一篇长文逐字敲下来就是几千条只增不减的
 * 键，Map 只涨不落（内存 + 每次查表都在更大的表上做）。
 * 上限本身导出给测试引用：验证脚本要断言"超限之后留下的是最新的一批"。
 */
export const METER_CACHE_LIMIT = 512

/**
 * 缓存超限时的淘汰：**按插入顺序丢最旧的**，而不是整表清空。
 *
 * 为什么不能清空：`indexAtX`（见 textEditor）一次调用就喂进「行长 + 1」条前缀，
 * 于是**行长 > 上限时"每次都超限"必然成立** —— 整表清空等于每次都全量重量，
 * 缓存对长行一点用都没有，而这一次量测之后紧跟着的 `render()` 还要把所有槽位宽度
 * 再全部量一遍（那一次才是真的贵）。
 * 淘汰最旧则留下"刚量的那一段"：行长 601、上限 512 时同一行的下一次量测约 85% 命中
 * （清空是 0%），而且缓存占用的上界从"无界"变成了一个常数。
 *
 * 为什么是 FIFO 而不是 LRU：这里的命中路径（同一行的前缀扫描、逐字增长的键名）
 * 是**单调**的，刚插入的就是刚命中的；LRU 每次命中都要 delete + set 把键挪到队尾，
 * 白白多付一次 Map 操作。`Map` 天然保留插入顺序，`keys().next().value` 就是最旧的键，
 * 淘汰一条是 O(1)。
 *
 * 单独抽成导出函数是为了可断言：真正的 `measure()` 需要 DOM（没有 `document` 时
 * 它根本不写缓存），在 node 里跑不到淘汰那一步。
 */
export function evictOldestEntries(
  cache: Map<string, number>,
  limit: number,
): void {
  // 上限本身不合法（NaN / 负数）时退化成"清空"：宁可多量一次，也别留下一个只涨不落的表
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0
  while (cache.size > max) {
    const oldest = cache.keys().next().value
    // 理论上到不了（size > max >= 0 保证还有键）；写成早退是为了不写非空断言
    if (oldest === undefined) return
    cache.delete(oldest)
  }
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

      // 见 METER_CACHE_LIMIT / evictOldestEntries：逐键输入会把缓存顶到无界，
      // 超限只丢最旧的几条（不是整表清空 —— 长行每次都超限，清空等于缓存完全失效）。
      // 注意与上面那处 cache.clear() 的区别：那处是**字体指纹变了**，旧值全部作废、
      // 必须整表丢；这里只是**容量**问题，旧的还有用，丢最旧的即可。
      evictOldestEntries(cache, METER_CACHE_LIMIT)

      return widths
    },
  }
}

export type SlotStyles = {
  /** 该宽度的槽位类，返回可直接交给 `inlineClassName` 的完整类名 */
  decorationClassFor(widthPx: number): string
  /**
   * 「正在编辑的那一条」的槽位类：**单例**，宽度靠改写同一条规则更新。
   * 逐键调用不会新增样式规则（这正是它存在的理由，见实现里的注释）。
   */
  liveSlotClass(widthPx: number): string
  dispose(): void
}

/**
 * 槽位宽度是按需生成的，所以挂一个内部样式表，同一宽度只生成一条规则。
 * 用 `clip-path` 而不是 `overflow: hidden`：后者会把 inline-block 的基线改成底边，
 * 把整行文字顶歪。`clip-path` 只影响绘制与命中，基线不受影响。
 *
 * 「正在编辑的那一条」走另一条路（见 liveSlotClass）：它每按一键都换宽度，
 * 走 `decorationClassFor` 的话样式规则数会随按键数无界增长。
 */
export function createSlotStyles(): SlotStyles {
  const styleEl =
    typeof document !== 'undefined' && document.head
      ? document.createElement('style')
      : null
  if (styleEl) document.head.appendChild(styleEl)
  const known = new Set<string>()
  /**
   * 实时槽位那条规则（单例）。
   *
   * 独立一个 `<style>` 节点、并且**只改它的 textContent**：
   * - 不能往上面那个大 styleEl 里追加 —— 那就是"每按一键多一条规则"；
   * - 改写整条规则（而不是改元素的 inline style）是为了让槽位宽度仍然只有**一个来源**：
   *   Monaco 的装饰只认 `inlineClassName`，inline style 会被它下一次重建 DOM 抹掉。
   * 类名固定，于是 Monaco 那边看起来"这个装饰没变"，只有样式表内容变了、浏览器重排一次。
   */
  const liveClass = `${SLOT_CLASS}-live`
  const liveStyleEl =
    typeof document !== 'undefined' && document.head
      ? document.createElement('style')
      : null
  if (liveStyleEl) document.head.appendChild(liveStyleEl)
  /** 上一次写进去的宽度：同一宽度不重复写 textContent（省一次样式失效 / 重排） */
  let liveWidth = -1

  const writeLiveRule = (width: number) => {
    if (!liveStyleEl || liveWidth === width) return
    liveWidth = width
    liveStyleEl.textContent = `.${liveClass}{display:inline-block;width:${width}px;clip-path:inset(0)}\n`
  }

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
    liveSlotClass(widthPx: number): string {
      writeLiveRule(
        roundPx(Number.isFinite(widthPx) ? Math.max(0, widthPx) : 0),
      )
      return `${HIDDEN_CLASS} ${liveClass}`
    },
    dispose() {
      known.clear()
      liveWidth = -1
      liveStyleEl?.remove()
      styleEl?.remove()
    },
  }
}
