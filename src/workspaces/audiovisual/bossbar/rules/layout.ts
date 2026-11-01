import type {
  BossbarBarDirection,
  BossbarBox,
  BossbarLayout,
  BossbarUv,
} from '../protocol'
import { BOSSBAR_LIMITS } from '../protocol'

/** 矩形（设计像素或 GUI 逻辑像素，由调用方约定） */
export type Rect = { x: number; y: number; width: number; height: number }

/** 一次贴图：源区域（相对 UV 原点）+ 目标区域 */
export type SpriteDraw = {
  sx: number
  sy: number
  sw: number
  sh: number
  dx: number
  dy: number
  dw: number
  dh: number
}

export type RegionPlacement = {
  /** 显示区域左上角（GUI 逻辑像素） */
  x: number
  y: number
  width: number
  height: number
  /** 设计像素 → GUI 逻辑像素 */
  scale: number
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

export function intersectRect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  if (!(right > x) || !(bottom > y)) return null
  return { x, y, width: right - x, height: bottom - y }
}

/** 显示区域包含判断：四边相切合法 */
export function containsBox(region: BossbarBox, box: BossbarBox): boolean {
  const eps = 1e-9
  return (
    box.x >= region.x - eps &&
    box.y >= region.y - eps &&
    box.x + box.width <= region.x + region.width + eps &&
    box.y + box.height <= region.y + region.height + eps
  )
}

/** s = min(scale, max(0, G - 2 × safeMargin) / rw)；s=0 时不绘制 */
export function layoutScale(layout: BossbarLayout, regionWidth: number, guiWidth: number): number {
  const available = Math.max(0, guiWidth - layout.safeMargin * 2)
  if (!(regionWidth > 0)) return 0
  const limit = available / regionWidth
  return Math.min(layout.scale, limit)
}

export function placeRegion(
  layout: BossbarLayout,
  region: BossbarBox,
  guiWidth: number,
  rowY: number = BOSSBAR_LIMITS.rowTopMargin,
): RegionPlacement | null {
  const scale = layoutScale(layout, region.width, guiWidth)
  if (!(scale > 0) || !Number.isFinite(scale)) return null
  const width = region.width * scale
  const height = region.height * scale
  return { x: (guiWidth - width) / 2, y: rowY, width, height, scale }
}

/** componentScreenX = screenX + (x - rx) * s；Y 同理 */
export function mapBoxToScreen(
  box: BossbarBox,
  region: BossbarBox,
  placement: RegionPlacement,
): Rect {
  return {
    x: placement.x + (box.x - region.x) * placement.scale,
    y: placement.y + (box.y - region.y) * placement.scale,
    width: box.width * placement.scale,
    height: box.height * placement.scale,
  }
}

/** stretch / contain / cover；源坐标以 UV 左上角为原点 */
export function fitSprite(
  source: { width: number; height: number },
  dst: Rect,
  fit: 'stretch' | 'contain' | 'cover',
): SpriteDraw | null {
  if (!(source.width > 0) || !(source.height > 0) || !(dst.width > 0) || !(dst.height > 0)) return null
  if (fit === 'stretch') {
    return { sx: 0, sy: 0, sw: source.width, sh: source.height, dx: dst.x, dy: dst.y, dw: dst.width, dh: dst.height }
  }
  const scale =
    fit === 'cover'
      ? Math.max(dst.width / source.width, dst.height / source.height)
      : Math.min(dst.width / source.width, dst.height / source.height)
  const dw = source.width * scale
  const dh = source.height * scale
  return {
    sx: 0,
    sy: 0,
    sw: source.width,
    sh: source.height,
    dx: dst.x + (dst.width - dw) / 2,
    dy: dst.y + (dst.height - dh) / 2,
    dw,
    dh,
  }
}

/**
 * 九宫格：角保持尺寸，边与中间拉伸。insets 相对选中的 UV 区域。
 * 目标过小时边距同比缩小到能容纳，中心允许为零。
 */
export function nineSliceSprites(
  source: { width: number; height: number },
  dst: Rect,
  insets: readonly [number, number, number, number],
): SpriteDraw[] {
  const srcW = source.width
  const srcH = source.height
  if (!(srcW > 0) || !(srcH > 0) || !(dst.width > 0) || !(dst.height > 0)) return []
  let left = Math.max(0, Math.min(insets[0], srcW))
  let right = Math.max(0, Math.min(insets[2], srcW))
  let top = Math.max(0, Math.min(insets[1], srcH))
  let bottom = Math.max(0, Math.min(insets[3], srcH))
  if (left + right > srcW) {
    const shrink = srcW / (left + right)
    left *= shrink
    right *= shrink
  }
  if (top + bottom > srcH) {
    const shrink = srcH / (top + bottom)
    top *= shrink
    bottom *= shrink
  }
  const scaleX = left + right > 0 ? Math.min(1, dst.width / (left + right)) : 1
  const scaleY = top + bottom > 0 ? Math.min(1, dst.height / (top + bottom)) : 1
  const dstLeft = left * scaleX
  const dstRight = right * scaleX
  const dstTop = top * scaleY
  const dstBottom = bottom * scaleY
  const innerW = Math.max(0, dst.width - dstLeft - dstRight)
  const innerH = Math.max(0, dst.height - dstTop - dstBottom)
  const srcInnerW = Math.max(0, srcW - left - right)
  const srcInnerH = Math.max(0, srcH - top - bottom)
  const x0 = dst.x
  const y0 = dst.y
  const x1 = dst.x + dstLeft
  const y1 = dst.y + dstTop
  const x2 = dst.x + dst.width - dstRight
  const y2 = dst.y + dst.height - dstBottom
  const srcX1 = left
  const srcY1 = top
  const srcX2 = srcW - right
  const srcY2 = srcH - bottom

  const pieces: SpriteDraw[] = [
    { sx: 0, sy: 0, sw: srcX1, sh: srcY1, dx: x0, dy: y0, dw: dstLeft, dh: dstTop },
    { sx: srcX1, sy: 0, sw: srcInnerW, sh: srcY1, dx: x1, dy: y0, dw: innerW, dh: dstTop },
    { sx: srcX2, sy: 0, sw: right, sh: srcY1, dx: x2, dy: y0, dw: dstRight, dh: dstTop },
    { sx: 0, sy: srcY1, sw: srcX1, sh: srcInnerH, dx: x0, dy: y1, dw: dstLeft, dh: innerH },
    { sx: srcX1, sy: srcY1, sw: srcInnerW, sh: srcInnerH, dx: x1, dy: y1, dw: innerW, dh: innerH },
    { sx: srcX2, sy: srcY1, sw: right, sh: srcInnerH, dx: x2, dy: y1, dw: dstRight, dh: innerH },
    { sx: 0, sy: srcY2, sw: srcX1, sh: bottom, dx: x0, dy: y2, dw: dstLeft, dh: dstBottom },
    { sx: srcX1, sy: srcY2, sw: srcInnerW, sh: bottom, dx: x1, dy: y2, dw: innerW, dh: dstBottom },
    { sx: srcX2, sy: srcY2, sw: right, sh: bottom, dx: x2, dy: y2, dw: dstRight, dh: dstBottom },
  ]
  return pieces.filter((piece) => piece.sw > 0 && piece.sh > 0 && piece.dw > 0 && piece.dh > 0)
}

/** 条的可见区：比例 from→to 之间（可反序）的矩形 */
export function barSegment(
  box: BossbarBox,
  from: number,
  to: number,
  direction: BossbarBarDirection,
): Rect | null {
  const low = Math.min(clamp(from, 0, 1), clamp(to, 0, 1))
  const high = Math.max(clamp(from, 0, 1), clamp(to, 0, 1))
  const span = high - low
  if (!(span > 0)) return null
  if (direction === 'left-to-right') {
    return { x: box.x + box.width * low, y: box.y, width: box.width * span, height: box.height }
  }
  if (direction === 'right-to-left') {
    return {
      x: box.x + box.width * (1 - high),
      y: box.y,
      width: box.width * span,
      height: box.height,
    }
  }
  if (direction === 'top-to-bottom') {
    return { x: box.x, y: box.y + box.height * low, width: box.width, height: box.height * span }
  }
  return {
    x: box.x,
    y: box.y + box.height * (1 - high),
    width: box.width,
    height: box.height * span,
  }
}

export function uvContains(outer: BossbarUv, inner: BossbarUv): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  )
}
