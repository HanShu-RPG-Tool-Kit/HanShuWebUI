/**
 * 「打字跟手」的纯几何判定：显示什么文本、框多宽多高、要不要 view zone。
 *
 * 为什么单独一个文件而不是塞进 textEditor：这套判定既要在编辑器里跑（逐键实时应用），
 * 又要能被断言（scripts/verify-text-live-geometry.ts）。留在那个 2800 行的 DOM 模块里
 * 就只能靠开浏览器点着看 —— 而"多打一个字符框该宽多少、多一行该高多少"恰恰是最容易写错、
 * 又最该有回归的一小撮规则。
 *
 * 这里一行 DOM 都不碰：宽度一律由调用方传进来的**实测**函数给（与覆盖框同一把 meter），
 * 所以同一份规则既能跑在浏览器里，也能跑在 node 里。
 */

/**
 * 框底留出的空隙（避免相邻行的框交叉）。
 * 定义在这里而不是 textEditor：渲染路径与实时路径必须用同一个值 ——
 * 差一个像素的话，打字时框高与提交后框高会差一点、看起来像"跳了一下"。
 */
export const TEXT_BOX_GAP_PX = 3

/**
 * 编辑模式：改键名 / 改译文。
 * 与 textEditor 的 TextEditMode 同形；这里刻意不 import 它 —— 那个模块拉着一堆 DOM 依赖，
 * 反向 import 会绕成一个环，纯规则模块不该被拖进浏览器世界。
 */
export type TextLiveMode = 'key' | 'value'

/** 一次实时几何的完整结果（宽高都按"框"算，槽位宽度由 liveSlotWidthPx 另加按钮） */
export type TextLiveGeometry = {
  /** 框里显示什么（也是量宽的依据） */
  display: string
  /** 显示文本按 `\n` 切出来的行（含空行与行尾空格） */
  lines: string[]
  lineCount: number
  /** 框宽 = 各行实测宽度的最大值 */
  widthPx: number
  /** 框高 = 行数 × 行高 − 缝隙（至少 1px，空文本时也不塌成 0 高） */
  heightPx: number
  /** 多出来的行要占的高度（0 = 不需要 zone） */
  zoneHeightPx: number
  /** 是否需要 view zone 把后面的行推下去 */
  needsZone: boolean
}

/**
 * 框里显示的文本。
 *
 * - 改键名：显示草稿本身（正在打的就是这个键名）
 * - 改译文：草稿为空时回退成键名 —— 这就是编辑框的 placeholder，
 *   于是"把译文删空"与"这条还没有译文"是同一个观感（键名宽度），
 *   框不会塌成 0 宽、字和光标都无处可站
 */
export function liveDisplayText(
  mode: TextLiveMode,
  draft: string,
  key: string,
): string {
  if (mode === 'key') return draft
  return draft === '' ? key : draft
}

/**
 * **渲染**这一条时显示什么文本（覆盖层的整体重画与实时跟手共用这一条口径）。
 *
 * - 正在被编辑的那一条：一律按它**自己的草稿**显示，既不看 `ctrlHeld` 也不看映射 ——
 *   编辑期间 Ctrl 按下 / 松开不许改变显示模式（原 `activeEdit.showKey` 的语义），
 *   显示什么完全由打开那一刻的 `mode` + 草稿决定。
 * - 其余条：按住 Ctrl 显示键名、缺译文显示键名、否则显示映射值。
 *
 * 为什么单独抽出来：`editing` 传 null 就是"这一条没有编辑目标"，
 * 也就是**上一个编辑目标已经关掉**之后 render 必须走的路径 —— 回到映射里的值、
 * 绝不把上一个目标的草稿继承下来（这条规则曾经踩过：换编辑目标时上一个框的尺寸
 * 还停在草稿上，见 textEditor.restorePreviousEditingBox）。
 */
export function renderDisplayText(options: {
  /** 这一条正在被编辑时的编辑态；不是编辑目标就传 null */
  editing: { mode: TextLiveMode; draft: string } | null
  key: string
  value: string | null
  ctrlHeld: boolean
}): string {
  if (options.editing) {
    return liveDisplayText(options.editing.mode, options.editing.draft, options.key)
  }
  if (options.ctrlHeld || options.value == null) return options.key
  return options.value
}

/**
 * 实时几何。
 *
 * `measureWidths` 是**批量**接口：一次调用只触发一轮布局（meter 的行为，见 textSlotStyles），
 * 逐行单独量会把多行值变成多次布局 —— 逐键跑在打字路径上，这个差别是实打实的。
 */
export function liveBoxGeometry(options: {
  mode: TextLiveMode
  draft: string
  key: string
  lineHeightPx: number
  /** 实测文本宽度（与覆盖框共用同一把 meter） */
  measureWidths(texts: readonly string[]): readonly number[]
  /** 覆盖框底缝隙（默认与渲染路径同值） */
  boxGapPx?: number
}): TextLiveGeometry {
  const gap = options.boxGapPx ?? TEXT_BOX_GAP_PX
  const lineHeight =
    Number.isFinite(options.lineHeightPx) && options.lineHeightPx > 0
      ? options.lineHeightPx
      : 28
  const display = liveDisplayText(options.mode, options.draft, options.key)

  // 按 `\n` 切分即可：`white-space: pre` 下换行只来自文本里的显式换行，
  // 空行与**行尾空格**都是真实占位（行尾空格尤其要量进去，否则末尾打空格时框不变宽、
  // 光标会跑到框外）
  const lines = display.split('\n')

  /**
   * 空显示文本量不出宽度（键名模式下把草稿删空就是这个情形）：退回按键名量。
   * 不退回的话框宽是 0，编辑框跟着塌成一条线 —— 而这时用户正打算重新打字。
   */
  const fallbackToKey = display === ''
  const texts = fallbackToKey ? [options.key] : lines
  const widths = options.measureWidths(texts)
  const at = (index: number): number => {
    const value = widths[index]
    return Number.isFinite(value) && value > 0 ? value : 0
  }

  let widthPx = 0
  if (fallbackToKey) {
    widthPx = at(0)
  } else {
    for (let i = 0; i < lines.length; i++) widthPx = Math.max(widthPx, at(i))
  }

  const lineCount = lines.length
  return {
    display,
    lines,
    lineCount,
    widthPx,
    heightPx: Math.max(lineCount * lineHeight - gap, 1),
    zoneHeightPx: (lineCount - 1) * lineHeight,
    needsZone: lineCount > 1,
  }
}

/**
 * 文档里那个槽位要留多宽：整个原子单位 = 文本框 + 间距 + 配音按钮。
 * 单独一个函数是为了让"槽位比框宽一个按钮"这条规则只有一个出处、并且可断言。
 *
 * 两个入参都过 `Number.isFinite` + 夹零，与另外两条宽度路径
 * （textSlotStyles 的 decorationClassFor / liveSlotClass）用同一类守卫：
 * 槽位宽度一旦是 NaN，Monaco 那边就是一条 `width:NaNpx` 的无效规则 ——
 * 槽位退回按原文列数撑开，同一行后面的正文整体错位，
 * 而且错得很隐蔽（看上去只是"位置不太对"，不像报错）。
 * 实际路径上 `liveBoxGeometry` 已经把量不出的宽度折成 0，这里是最后一道兜底。
 */
export function liveSlotWidthPx(
  boxWidthPx: number,
  slotExtraPx: number,
): number {
  const box = Number.isFinite(boxWidthPx) ? Math.max(0, boxWidthPx) : 0
  const extra = Number.isFinite(slotExtraPx) ? Math.max(0, slotExtraPx) : 0
  return box + extra
}
