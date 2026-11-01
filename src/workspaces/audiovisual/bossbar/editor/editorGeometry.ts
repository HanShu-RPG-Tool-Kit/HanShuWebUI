import { isPaintable, type BossbarBox, type BossbarComponent } from '../protocol'
import type { Rect } from '../rules/layout'

/**
 * 设计视图的几何与吸附。
 *
 * 只算矩形与吸附线，不碰 DOM；画布交互组件与单元测试共用同一套规则。
 */

export type BossbarHandle =
  | 'nw'
  | 'n'
  | 'ne'
  | 'e'
  | 'se'
  | 's'
  | 'sw'
  | 'w'

export const BOSSBAR_HANDLES: BossbarHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

export function normalizeBox(box: BossbarBox): BossbarBox {
  const x = box.width < 0 ? box.x + box.width : box.x
  const y = box.height < 0 ? box.y + box.height : box.y
  return {
    x,
    y,
    width: Math.max(1, Math.abs(box.width)),
    height: Math.max(1, Math.abs(box.height)),
  }
}

export function boxFromPoints(a: { x: number; y: number }, b: { x: number; y: number }): BossbarBox {
  return normalizeBox({
    x: a.x,
    y: a.y,
    width: b.x - a.x,
    height: b.y - a.y,
  })
}

export function boxesIntersect(a: Rect, b: Rect): boolean {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  )
}

export function pointInBox(box: Rect, point: { x: number; y: number }): boolean {
  return (
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height
  )
}

export function handlePoint(box: BossbarBox, handle: BossbarHandle): { x: number; y: number } {
  const left = box.x
  const right = box.x + box.width
  const top = box.y
  const bottom = box.y + box.height
  const midX = box.x + box.width / 2
  const midY = box.y + box.height / 2
  switch (handle) {
    case 'nw':
      return { x: left, y: top }
    case 'n':
      return { x: midX, y: top }
    case 'ne':
      return { x: right, y: top }
    case 'e':
      return { x: right, y: midY }
    case 'se':
      return { x: right, y: bottom }
    case 's':
      return { x: midX, y: bottom }
    case 'sw':
      return { x: left, y: bottom }
    default:
      return { x: left, y: midY }
  }
}

export function handleCursor(handle: BossbarHandle): string {
  if (handle === 'nw' || handle === 'se') return 'nwse-resize'
  if (handle === 'ne' || handle === 'sw') return 'nesw-resize'
  if (handle === 'n' || handle === 's') return 'ns-resize'
  return 'ew-resize'
}

/** 拖动控制点后重新算矩形；宽高至少 1 像素 */
export function resizeBox(
  box: BossbarBox,
  handle: BossbarHandle,
  delta: { x: number; y: number },
): BossbarBox {
  let { x, y, width, height } = box
  if (handle.includes('w')) {
    x += delta.x
    width -= delta.x
  }
  if (handle.includes('e')) width += delta.x
  if (handle.includes('n')) {
    y += delta.y
    height -= delta.y
  }
  if (handle.includes('s')) height += delta.y
  if (width < 1) {
    if (handle.includes('w')) x = box.x + box.width - 1
    width = 1
  }
  if (height < 1) {
    if (handle.includes('n')) y = box.y + box.height - 1
    height = 1
  }
  return { x, y, width, height }
}

export type SnapLines = { x: number[]; y: number[] }

/** 显示区域边界、中线、组件边缘，以及与设计原点对齐的网格线。 */
export function collectSnapLines(
  boxes: readonly BossbarBox[],
  canvas: { x?: number; y?: number; width: number; height: number },
  grid: number,
  includeGrid: boolean,
  excludeIndex = -1,
): SnapLines {
  const left = canvas.x ?? 0
  const top = canvas.y ?? 0
  const xs = new Set<number>([left, left + canvas.width / 2, left + canvas.width])
  const ys = new Set<number>([top, top + canvas.height / 2, top + canvas.height])
  boxes.forEach((box, index) => {
    if (index === excludeIndex) return
    xs.add(box.x)
    xs.add(box.x + box.width / 2)
    xs.add(box.x + box.width)
    ys.add(box.y)
    ys.add(box.y + box.height / 2)
    ys.add(box.y + box.height)
  })
  if (includeGrid && grid > 0) {
    const step = Math.max(1, grid)
    const startX = Math.ceil(left / step) * step
    const startY = Math.ceil(top / step) * step
    for (let index = 0; index <= Math.floor(canvas.width / step); index++) {
      const x = startX + index * step
      if (x <= left + canvas.width) xs.add(x)
    }
    for (let index = 0; index <= Math.floor(canvas.height / step); index++) {
      const y = startY + index * step
      if (y <= top + canvas.height) ys.add(y)
    }
  }
  return { x: [...xs].sort((a, b) => a - b), y: [...ys].sort((a, b) => a - b) }
}

function bestSnap(value: number, lines: readonly number[], threshold: number): number | null {
  let best: number | null = null
  let bestDistance = threshold + 1
  for (const line of lines) {
    const distance = Math.abs(line - value)
    if (distance <= threshold && distance < bestDistance) {
      best = line
      bestDistance = distance
    }
  }
  return best
}

export type SnapResult = { delta: { x: number; y: number }; guides: SnapLines }

/** 移动吸附：左/中/右三条候选边各试一次，取位移最小的那次 */
export function snapMove(
  box: BossbarBox,
  lines: SnapLines,
  threshold: number,
): SnapResult {
  const candidatesX = [box.x, box.x + box.width / 2, box.x + box.width]
  const candidatesY = [box.y, box.y + box.height / 2, box.y + box.height]
  let dx = 0
  let dy = 0
  let bestX = threshold + 1
  for (const candidate of candidatesX) {
    const snapped = bestSnap(candidate, lines.x, threshold)
    if (snapped === null) continue
    const shift = snapped - candidate
    if (Math.abs(shift) < bestX) {
      bestX = Math.abs(shift)
      dx = shift
    }
  }
  let bestY = threshold + 1
  for (const candidate of candidatesY) {
    const snapped = bestSnap(candidate, lines.y, threshold)
    if (snapped === null) continue
    const shift = snapped - candidate
    if (Math.abs(shift) < bestY) {
      bestY = Math.abs(shift)
      dy = shift
    }
  }
  const guides: SnapLines = { x: [], y: [] }
  if (dx !== 0) guides.x.push(box.x + dx, box.x + box.width / 2 + dx, box.x + box.width + dx)
  if (dy !== 0) guides.y.push(box.y + dy, box.y + box.height / 2 + dy, box.y + box.height + dy)
  return { delta: { x: dx, y: dy }, guides }
}

/** 缩放吸附：只吸附被拖动的边 */
export function snapResize(
  box: BossbarBox,
  handle: BossbarHandle,
  lines: SnapLines,
  threshold: number,
): { box: BossbarBox; guides: SnapLines } {
  const guides: SnapLines = { x: [], y: [] }
  let next = { ...box }
  const left = box.x
  const right = box.x + box.width
  const top = box.y
  const bottom = box.y + box.height
  if (handle.includes('w')) {
    const snapped = bestSnap(left, lines.x, threshold)
    if (snapped !== null && snapped < right - 1) {
      next.x = snapped
      next.width = right - snapped
      guides.x.push(snapped, right)
    }
  }
  if (handle.includes('e')) {
    const snapped = bestSnap(right, lines.x, threshold)
    if (snapped !== null && snapped > left + 1) {
      next.width = snapped - left
      guides.x.push(left, snapped)
    }
  }
  if (handle.includes('n')) {
    const snapped = bestSnap(top, lines.y, threshold)
    if (snapped !== null && snapped < bottom - 1) {
      next.y = snapped
      next.height = bottom - snapped
      guides.y.push(snapped, bottom)
    }
  }
  if (handle.includes('s')) {
    const snapped = bestSnap(bottom, lines.y, threshold)
    if (snapped !== null && snapped > top + 1) {
      next.height = snapped - top
      guides.y.push(top, snapped)
    }
  }
  return { box: next, guides }
}

/** 多选时以并集框为参考，按方向键微调 */
export function unionBox(boxes: readonly BossbarBox[]): BossbarBox | null {
  if (!boxes.length) return null
  const left = Math.min(...boxes.map((box) => box.x))
  const top = Math.min(...boxes.map((box) => box.y))
  const right = Math.max(...boxes.map((box) => box.x + box.width))
  const bottom = Math.max(...boxes.map((box) => box.y + box.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** 图层列表可以选中锁定组件，但移动集合始终排除锁定组件和显示区域。 */
export function movableSelection(
  components: readonly BossbarComponent[],
  selection: readonly string[],
  locked: readonly string[],
) {
  return components.filter((component) =>
    isPaintable(component) && selection.includes(component.id) && !locked.includes(component.id),
  )
}

/** 多选共用一个位移，按联合外框约束，不改变组件间距。 */
export function clampMoveDelta(
  boxes: readonly BossbarBox[],
  delta: { x: number; y: number },
  region: BossbarBox | null,
): { x: number; y: number } {
  const bounds = unionBox(boxes)
  if (!region || !bounds) return delta
  return {
    x: Math.min(Math.max(delta.x, region.x - bounds.x), region.x + region.width - bounds.x - bounds.width),
    y: Math.min(Math.max(delta.y, region.y - bounds.y), region.y + region.height - bounds.y - bounds.height),
  }
}

/** 对拖动后的多选外框吸附，再统一约束整组位移。 */
export function moveBoxes(
  boxes: readonly BossbarBox[],
  delta: { x: number; y: number },
  region: BossbarBox | null,
  snap?: { lines: SnapLines; threshold: number },
): { boxes: BossbarBox[]; guides: SnapLines } {
  const bounds = unionBox(boxes)
  if (!bounds) return { boxes: [], guides: { x: [], y: [] } }
  const candidate = { ...bounds, x: bounds.x + delta.x, y: bounds.y + delta.y }
  const snapped = snap
    ? snapMove(candidate, snap.lines, snap.threshold)
    : { delta: { x: 0, y: 0 }, guides: { x: [], y: [] } }
  const desired = { x: delta.x + snapped.delta.x, y: delta.y + snapped.delta.y }
  const constrained = clampMoveDelta(boxes, desired, region)
  return {
    boxes: boxes.map((box) => ({ ...box, x: box.x + constrained.x, y: box.y + constrained.y })),
    guides: {
      x: constrained.x === desired.x ? snapped.guides.x : [],
      y: constrained.y === desired.y ? snapped.guides.y : [],
    },
  }
}

/** 单独移动显示区域，只允许在仍包住全部组件的范围内平移。 */
export function moveRegionBox(
  region: BossbarBox,
  delta: { x: number; y: number },
  components: readonly BossbarBox[],
): BossbarBox {
  const bounds = unionBox(components)
  const x = region.x + delta.x
  const y = region.y + delta.y
  return {
    ...region,
    x: bounds ? Math.min(Math.max(x, bounds.x + bounds.width - region.width), bounds.x) : x,
    y: bounds ? Math.min(Math.max(y, bounds.y + bounds.height - region.height), bounds.y) : y,
  }
}

/** 设计像素 ↔ 视口像素 */
export type ViewTransform = { zoom: number; panX: number; panY: number }

export function toDesign(point: { x: number; y: number }, view: ViewTransform): { x: number; y: number } {
  return { x: (point.x - view.panX) / view.zoom, y: (point.y - view.panY) / view.zoom }
}

export function toScreen(point: { x: number; y: number }, view: ViewTransform): { x: number; y: number } {
  return { x: point.x * view.zoom + view.panX, y: point.y * view.zoom + view.panY }
}

export const ALIGN_ACTIONS = ['left', 'center-x', 'right', 'top', 'middle-y', 'bottom', 'distribute-x', 'distribute-y'] as const
export type AlignAction = (typeof ALIGN_ACTIONS)[number]

/** 多选对齐：至少两个组件才有意义 */
export function alignBoxes(boxes: readonly BossbarBox[], action: AlignAction): BossbarBox[] {
  if (boxes.length < 2) return [...boxes]
  const union = unionBox(boxes)!
  if (action === 'distribute-x' || action === 'distribute-y') {
    const horizontal = action === 'distribute-x'
    const sorted = boxes
      .map((box, index) => ({ box, index }))
      .sort((a, b) => (horizontal ? a.box.x - b.box.x : a.box.y - b.box.y))
    const total = sorted.reduce((sum, entry) => sum + (horizontal ? entry.box.width : entry.box.height), 0)
    const span = horizontal ? union.width : union.height
    const gap = sorted.length > 1 ? (span - total) / (sorted.length - 1) : 0
    const result = [...boxes]
    let cursor = horizontal ? union.x : union.y
    for (const entry of sorted) {
      result[entry.index] = horizontal
        ? { ...entry.box, x: cursor }
        : { ...entry.box, y: cursor }
      cursor += (horizontal ? entry.box.width : entry.box.height) + gap
    }
    return result
  }
  return boxes.map((box) => {
    switch (action) {
      case 'left':
        return { ...box, x: union.x }
      case 'center-x':
        return { ...box, x: union.x + union.width / 2 - box.width / 2 }
      case 'right':
        return { ...box, x: union.x + union.width - box.width }
      case 'top':
        return { ...box, y: union.y }
      case 'middle-y':
        return { ...box, y: union.y + union.height / 2 - box.height / 2 }
      default:
        return { ...box, y: union.y + union.height - box.height }
    }
  })
}
