import type { LevelArea } from './levelDoc'

export const HANDLE_TARGET_PX = 12
export const LANDMARK_TARGET_PX = 14

/** 透视投影下让固定像素的手柄在不同距离保持屏幕尺寸。距离翻倍则缩放翻倍。 */
export function stableHandleScale(
  distance: number,
  viewHeight: number,
  fovDeg: number,
  baseSize: number,
  targetPixels: number,
): number {
  const safeDistance = Math.max(distance, 0.5)
  const safeHeight = Math.max(viewHeight, 1)
  const safeBase = Math.max(baseSize, 1e-4)
  const worldPerPixel = (2 * safeDistance * Math.tan((fovDeg * Math.PI) / 360)) / safeHeight
  return (targetPixels * worldPerPixel) / safeBase
}

export function formatAuthor(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const scaled = Math.round(value * 1_000_000) / 1_000_000
  return Object.is(scaled, -0) ? '0' : String(scaled)
}

export function areaDimensionText(area: LevelArea): string {
  const height = area.y === 'all' ? '全高度' : `Y ${formatAuthor(area.y[0])}–${formatAuthor(area.y[1])}`
  if (area.kind === 'rect') {
    return `矩形 · X ${formatAuthor(area.x[0])}–${formatAuthor(area.x[1])} · Z ${formatAuthor(area.z[0])}–${formatAuthor(area.z[1])} · ${height}`
  }
  if (area.kind === 'circle') return `圆 · 半径 ${formatAuthor(area.radius)} · ${height}`
  return `多边形 · ${area.points.length} 点 · ${height}`
}

export function landmarkDimensionText(x: number, y: number, z: number): string {
  return `地标 · ${formatAuthor(x)}, ${formatAuthor(y)}, ${formatAuthor(z)}`
}

export function handleActionText(handle?: string, edge?: string): string {
  if (handle === 'y' && edge === 'min') return '拖底面'
  if (handle === 'y') return '拖顶面'
  if (handle === 'landmark-y') return '拖地标高度'
  if (handle === 'landmark-move') return '拖地标位置'
  if (handle === 'radius') return '拖半径'
  if (handle === 'vertex') return '拖顶点'
  if (edge === 'minX') return '拖 X 最小面'
  if (edge === 'maxX') return '拖 X 最大面'
  if (edge === 'minZ') return '拖 Z 最小面'
  if (edge === 'maxZ') return '拖 Z 最大面'
  if (handle === 'rect') return '拖角'
  if (handle === 'move') return '移动'
  return '移动'
}

export function hoverCursorClass(pick?: string, handle?: string, edge?: string): string {
  if (handle === 'y' || handle === 'landmark-y') return 'is-hover-y'
  if (edge === 'minX' || edge === 'maxX') return 'is-hover-x'
  if (edge === 'minZ' || edge === 'maxZ') return 'is-hover-z'
  if (handle === 'rect') return 'is-hover-corner'
  if (handle === 'radius') return 'is-hover-radius'
  if (handle === 'move' || handle === 'landmark-move') return 'is-hover-move'
  if (pick === 'area' || pick === 'landmark') return 'is-hover-select'
  return 'is-hover-handle'
}
