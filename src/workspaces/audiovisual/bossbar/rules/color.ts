/** 颜色：协议统一写作 #RRGGBBAA，加载器负责换算成渲染 API 的顺序。 */

export type Rgba = { r: number; g: number; b: number; a: number }

export function parseColor(hex: string): Rgba {
  const match = /^#([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})$/.exec(hex)
  if (!match) throw new Error('颜色必须是 #RRGGBBAA：' + hex)
  return {
    r: parseInt(match[1], 16),
    g: parseInt(match[2], 16),
    b: parseInt(match[3], 16),
    a: parseInt(match[4], 16),
  }
}

export function colorToCss(color: Rgba): string {
  const alpha = Math.round((color.a / 255) * 1000) / 1000
  return 'rgba(' + color.r + ', ' + color.g + ', ' + color.b + ', ' + alpha + ')'
}

/** Java 侧用 ARGB；这里只做同一份数值的另一种表达，方便夹具对拍 */
export function colorToArgb(color: Rgba): number {
  return (((color.a << 24) >>> 0) + (color.r << 16) + (color.g << 8) + color.b) >>> 0
}

/** #RRGGBBAA → #AARRGGBB（Minecraft 的 ARGB 十六进制） */
export function colorToArgbHex(hex: string): string {
  const { r, g, b, a } = parseColor(hex)
  const pad = (value: number) => value.toString(16).padStart(2, '0').toUpperCase()
  return '#' + pad(a) + pad(r) + pad(g) + pad(b)
}

export function withAlpha(hex: string, alpha: number): Rgba {
  const color = parseColor(hex)
  color.a = Math.max(0, Math.min(255, Math.round(alpha * 255)))
  return color
}
