/**
 * 文本截断：超宽在最后完整字形处省略并加 `…`，禁止拆开 Unicode 代理对。
 *
 * 宽度测量由调用方提供（浏览器 canvas.measureText / 游戏字体），
 * 本函数只决定"切到哪里"，因此可以脱离 DOM 单测。
 */

export function splitGraphemes(text: string): string[] {
  const Segmenter = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: string }) => { segment(input: string): Iterable<{ segment: string }> } }).Segmenter
  if (Segmenter) {
    const segmenter = new Segmenter(undefined, { granularity: 'grapheme' })
    return [...segmenter.segment(text)].map((entry) => entry.segment)
  }
  return Array.from(text)
}

/** 按字形逐个累加宽度，尽量放入；放不下时以 `…` 收尾 */
export function truncateToWidth(
  text: string,
  maxWidth: number,
  measure: (value: string) => number,
  ellipsis = '…',
): string {
  if (!(maxWidth > 0)) return ''
  if (measure(text) <= maxWidth) return text
  const graphemes = splitGraphemes(text)
  if (!graphemes.length) return ''
  let low = 0
  let high = graphemes.length
  // 二分找最长可放下的前缀（宽度随长度单调增，但字距调整不保证严格单调，二分后再线性确认）
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (measure(graphemes.slice(0, mid).join('') + ellipsis) <= maxWidth) low = mid
    else high = mid - 1
  }
  let cut = low
  while (cut > 0 && measure(graphemes.slice(0, cut).join('') + ellipsis) > maxWidth) cut -= 1
  if (cut <= 0) return measure(ellipsis) <= maxWidth ? ellipsis : ''
  return graphemes.slice(0, cut).join('') + ellipsis
}

/** 单行文本：显式换行按空格处理，首版不支持多行 */
export function singleLine(text: string): string {
  return text.replace(/[\r\n\t]+/g, ' ')
}
