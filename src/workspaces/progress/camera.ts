import type { FlowPosition } from './model'

export type CanvasCamera = FlowPosition & { zoom: number }
export const MIN_CANVAS_ZOOM = .2
export const MAX_CANVAS_ZOOM = 2.5

export function worldPoint(camera: CanvasCamera, point: FlowPosition): FlowPosition {
  return { x: (point.x - camera.x) / camera.zoom, y: (point.y - camera.y) / camera.zoom }
}

/** Keep the world point under the cursor still when changing the view scale. */
export function zoomCamera(camera: CanvasCamera, zoom: number, anchor: FlowPosition): CanvasCamera {
  const nextZoom = Math.max(MIN_CANVAS_ZOOM, Math.min(MAX_CANVAS_ZOOM, zoom)), point = worldPoint(camera, anchor)
  return { x: anchor.x - point.x * nextZoom, y: anchor.y - point.y * nextZoom, zoom: nextZoom }
}
