/**
 * 图集自动切块：按 alpha 连通域取 AABB，过滤过小碎块。
 * 确认后写入 background / bar 组件（UV 对准切块）。
 */

import {
  BOSSBAR_DEFAULTS,
  type BossbarBox,
  type BossbarDocument,
  type BossbarUv,
} from '../protocol'
import { decodeBase64, decodePngRgba, pngInfo, type PngRgba } from '../png'
import {
  addComponent,
  allocateComponentId,
  displayRegionOf,
  updateComponent,
} from '../document'

export type AtlasSliceKind = 'background' | 'bar'

export type AtlasDetectSlice = {
  id: string
  uv: BossbarUv
  kind: AtlasSliceKind
}

export type AtlasDetectOptions = {
  /** alpha 大于该值视为实心像素，默认 8 */
  alphaThreshold?: number
  /** 宽或高任一小于此值则丢弃，默认 4 */
  minSide?: number
  /** 面积小于此值则丢弃，默认 16 */
  minArea?: number
}

/** 解码图集像素：优先纯 JS 真彩路径，否则走宿主 createImageBitmap。 */
export async function loadAtlasRgba(textureBase64: string): Promise<PngRgba | null> {
  const bytes = decodeBase64(textureBase64)
  if (!bytes || !pngInfo(bytes)) return null
  const direct = decodePngRgba(bytes)
  if (direct) return direct
  if (typeof createImageBitmap !== 'function') return null
  const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], {
    type: 'image/png',
  })
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(bitmap.width, bitmap.height)
      : Object.assign(globalThis.document.createElement('canvas'), {
          width: bitmap.width,
          height: bitmap.height,
        })
    const ctx = canvas.getContext('2d')
    if (!ctx || !('drawImage' in ctx)) return null
    ctx.drawImage(bitmap, 0, 0)
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
    return {
      width: bitmap.width,
      height: bitmap.height,
      rgba: new Uint8Array(imageData.data.buffer.slice(0)),
    }
  } finally {
    bitmap.close()
  }
}

function opaque(rgba: Uint8Array, index: number, threshold: number): boolean {
  return rgba[index * 4 + 3] > threshold
}

/** 4 连通洪水填充，返回按从上到下、从左到右排序的包围盒 */
export function detectAtlasRegions(
  image: PngRgba,
  options?: AtlasDetectOptions,
): BossbarUv[] {
  const { width, height, rgba } = image
  if (!width || !height || rgba.length !== width * height * 4) return []
  const threshold = options?.alphaThreshold ?? 8
  const minSide = options?.minSide ?? 4
  const minArea = options?.minArea ?? 16
  const seen = new Uint8Array(width * height)
  const regions: BossbarUv[] = []
  const stackX: number[] = []
  const stackY: number[] = []

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const start = y * width + x
      if (seen[start] || !opaque(rgba, start, threshold)) continue
      seen[start] = 1
      stackX.length = 0
      stackY.length = 0
      stackX.push(x)
      stackY.push(y)
      let minX = x
      let minY = y
      let maxX = x
      let maxY = y
      let area = 0
      while (stackX.length) {
        const cx = stackX.pop()!
        const cy = stackY.pop()!
        area += 1
        if (cx < minX) minX = cx
        if (cy < minY) minY = cy
        if (cx > maxX) maxX = cx
        if (cy > maxY) maxY = cy
        const neighbors = [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1],
        ] as const
        for (const [nx, ny] of neighbors) {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const ni = ny * width + nx
          if (seen[ni] || !opaque(rgba, ni, threshold)) continue
          seen[ni] = 1
          stackX.push(nx)
          stackY.push(ny)
        }
      }
      const boxWidth = maxX - minX + 1
      const boxHeight = maxY - minY + 1
      if (boxWidth < minSide || boxHeight < minSide || area < minArea) continue
      regions.push({ x: minX, y: minY, width: boxWidth, height: boxHeight })
    }
  }

  regions.sort((a, b) => (a.y - b.y) || (a.x - b.x))
  return regions
}

export function slicesFromRegions(regions: BossbarUv[]): AtlasDetectSlice[] {
  return regions.map((uv, index) => ({
    id: 'slice' + (index + 1),
    uv: { ...uv },
    kind: 'background' as const,
  }))
}

function unionBox(a: BossbarBox, b: BossbarBox): BossbarBox {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  const right = Math.max(a.x + a.width, b.x + b.width)
  const bottom = Math.max(a.y + a.height, b.y + b.height)
  return { x, y, width: right - x, height: bottom - y }
}

/** 把确认后的切块写成组件；必要时扩大 display_region 以容纳它们。 */
export function applyAtlasDetectSlices(
  document: BossbarDocument,
  slices: AtlasDetectSlice[],
): BossbarDocument {
  if (!slices.length) return document
  const region = displayRegionOf(document)
  if (!region) return document

  const originX = Math.min(...slices.map((slice) => slice.uv.x))
  const originY = Math.min(...slices.map((slice) => slice.uv.y))
  const boxes = slices.map((slice) => ({
    x: region.box.x + (slice.uv.x - originX),
    y: region.box.y + (slice.uv.y - originY),
    width: slice.uv.width,
    height: slice.uv.height,
  }))

  let nextRegionBox = region.box
  for (const box of boxes) nextRegionBox = unionBox(nextRegionBox, box)
  let next: BossbarDocument = nextRegionBox === region.box
    ? document
    : updateComponent(document, region.id, { box: nextRegionBox })

  for (let index = 0; index < slices.length; index += 1) {
    const slice = slices[index]
    const box = boxes[index]
    const id = allocateComponentId(next, slice.kind === 'bar' ? 'bar' : 'bg')
    const paint = {
      kind: 'texture' as const,
      uv: { ...slice.uv },
      fit: 'stretch' as const,
    }
    if (slice.kind === 'background') {
      next = addComponent(next, {
        id,
        type: 'background',
        box,
        visible: BOSSBAR_DEFAULTS.visible,
        opacity: BOSSBAR_DEFAULTS.opacity,
        paint,
      })
    } else {
      next = addComponent(next, {
        id,
        type: 'bar',
        box,
        visible: BOSSBAR_DEFAULTS.visible,
        opacity: BOSSBAR_DEFAULTS.opacity,
        progress: 1,
        direction: BOSSBAR_DEFAULTS.direction,
        fill: paint,
        smoothMs: BOSSBAR_DEFAULTS.smoothMs,
      })
    }
  }
  return next
}
