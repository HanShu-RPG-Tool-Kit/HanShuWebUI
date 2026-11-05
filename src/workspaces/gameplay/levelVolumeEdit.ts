import type { LevelArea, LevelCircleArea, LevelPolygonArea, LevelRectArea, LevelY } from './levelDoc'
import {
  BLOCK_CENTER_OFFSET,
  DISPLAY_Y_MAX,
  DISPLAY_Y_MIN,
  areaWithinLimit,
  circleWorldCenter,
  decimalAdd,
  decimalSub,
  moveAuthoredFace,
  polygonWorldPoint,
  snapAbsolute,
  snapFromOrigin,
  type SnapStep,
} from './levelGeometry'

export { DISPLAY_Y_MIN, DISPLAY_Y_MAX }

/** 从 all 拖高度时，未拖动的一端用侧栏「限定高度」的 0..256，不用显示带。 */
const HANDLE_Y_MIN = 0
const HANDLE_Y_MAX = 256

export type LevelTool = 'select' | 'rect' | 'circle' | 'polygon' | 'landmark'

/** Four inclusive block rows from the drawing plane, matching the native workbench. */
export function creationHeight(planeY: number): [number, number] {
  const bottom = Math.floor(planeY)
  return [bottom, bottom + 3]
}

export type LevelSelection =
  | { kind: 'region'; id: string; area: number }
  | { kind: 'landmark'; id: string }
  | null

export type RectHandle =
  | 'minX'
  | 'maxX'
  | 'minZ'
  | 'maxZ'
  | 'minXminZ'
  | 'maxXminZ'
  | 'minXmaxZ'
  | 'maxXmaxZ'

export function areaDisplaySpan(y: LevelY): [number, number] {
  return y === 'all' ? [DISPLAY_Y_MIN, DISPLAY_Y_MAX] : [y[0], y[1]]
}

export function yFromHandle(current: LevelY, edge: 'min' | 'max', hitY: number, step: SnapStep = 1): LevelY {
  if (current === 'all') {
    const snapped = snapAbsolute(hitY, step)
    if (edge === 'max') return [HANDLE_Y_MIN, Math.max(HANDLE_Y_MIN + 1, snapped)]
    return [Math.min(HANDLE_Y_MAX - 1, snapped), HANDLE_Y_MAX]
  }
  const minFace = current[0]
  const maxFace = decimalAdd(current[1], 1)
  if (edge === 'max') {
    const author = moveAuthoredFace(maxFace, hitY, minFace, true, step)
    return author === null ? current : [current[0], author]
  }
  const author = moveAuthoredFace(minFace, hitY, maxFace, false, step)
  return author === null ? current : [author, current[1]]
}

export function translateArea(area: LevelArea, dx: number, dz: number): LevelArea {
  let next: LevelArea
  if (area.kind === 'rect') {
    next = { ...area, x: [decimalAdd(area.x[0], dx), decimalAdd(area.x[1], dx)], z: [decimalAdd(area.z[0], dz), decimalAdd(area.z[1], dz)] }
  } else if (area.kind === 'circle') {
    next = { ...area, center: [decimalAdd(area.center[0], dx), decimalAdd(area.center[1], dz)] }
  } else {
    next = { ...area, points: area.points.map(([x, z]) => [decimalAdd(x, dx), decimalAdd(z, dz)] as [number, number]) }
  }
  return areaWithinLimit(next) ? next : area
}

export function resizeRect(
  area: LevelRectArea,
  handle: RectHandle,
  x: number,
  z: number,
  step: SnapStep = 1,
): LevelRectArea {
  let minX = area.x[0]
  let maxX = area.x[1]
  let minZ = area.z[0]
  let maxZ = area.z[1]
  const minFaceX = area.x[0]
  const maxFaceX = decimalAdd(area.x[1], 1)
  const minFaceZ = area.z[0]
  const maxFaceZ = decimalAdd(area.z[1], 1)
  if (handle === 'minX' || handle === 'minXminZ' || handle === 'minXmaxZ') {
    const next = moveAuthoredFace(minFaceX, x, maxFaceX, false, step)
    if (next === null) return area
    minX = next
  }
  if (handle === 'maxX' || handle === 'maxXminZ' || handle === 'maxXmaxZ') {
    const next = moveAuthoredFace(maxFaceX, x, minFaceX, true, step)
    if (next === null) return area
    maxX = next
  }
  if (handle === 'minZ' || handle === 'minXminZ' || handle === 'maxXminZ') {
    const next = moveAuthoredFace(minFaceZ, z, maxFaceZ, false, step)
    if (next === null) return area
    minZ = next
  }
  if (handle === 'maxZ' || handle === 'minXmaxZ' || handle === 'maxXmaxZ') {
    const next = moveAuthoredFace(maxFaceZ, z, minFaceZ, true, step)
    if (next === null) return area
    maxZ = next
  }
  return { ...area, x: [minX, maxX], z: [minZ, maxZ] }
}

/** 半径手柄在世界中心 + 半径的 X 上。x 是这只手柄的世界 X，z 不参与半径。 */
export function resizeCircle(area: LevelCircleArea, x: number, z: number, step: SnapStep = 1): LevelCircleArea {
  void z
  const [worldX] = circleWorldCenter(area.center[0], area.center[1])
  const origin = decimalAdd(worldX, area.radius)
  const radius = decimalSub(snapFromOrigin(origin, x, step), worldX)
  if (!(radius > 0) || !areaWithinLimit({ ...area, radius })) return area
  return { ...area, radius }
}

export function movePolygonVertex(
  area: LevelPolygonArea,
  vertex: number,
  x: number,
  z: number,
  step: SnapStep = 1,
): LevelPolygonArea {
  const point = area.points[vertex]
  if (!point) return area
  const [worldX, worldZ] = polygonWorldPoint(point[0], point[1])
  const authorX = decimalSub(snapFromOrigin(worldX, x, step), BLOCK_CENTER_OFFSET)
  const authorZ = decimalSub(snapFromOrigin(worldZ, z, step), BLOCK_CENTER_OFFSET)
  const points = area.points.map((current, index) => (
    index === vertex ? [authorX, authorZ] as [number, number] : [current[0], current[1]] as [number, number]
  ))
  const next = { ...area, points }
  return areaWithinLimit(next) ? next : area
}
