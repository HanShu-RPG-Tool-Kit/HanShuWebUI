import { Vector3, type PerspectiveCamera } from 'three'
import type { LevelArea, LevelDocument } from './levelDoc'
import { contentBounds } from './levelEdit'
import { circleWorldCenter, polygonWorldPoint, rectWorldBox, worldYSpan, type ViewCommandKind } from './levelGeometry'
import type { LevelSelection } from './levelVolumeEdit'

/**
 * 文档轨道相机。phi 是从世界 +Y 往下量的角，theta 从 +Z 转向 +X。
 * 这是唯一用角度摆相机的地方；平移只读 camera.matrixWorld 的列。
 */
export type OrbitState = {
  target: Vector3
  radius: number
  theta: number
  phi: number
}

/** Bounded indoor volumes and landmarks can be far above Y=0. The all-height display band does not force a zoom-out. */
export function initialDocumentOrbit(doc: LevelDocument): OrbitState {
  const bounds = contentBounds(doc)
  let minY = Infinity
  let maxY = -Infinity
  for (const region of doc.regions) for (const area of region.areas) {
    if (area.y !== 'all') { minY = Math.min(minY, area.y[0]); maxY = Math.max(maxY, area.y[1]) }
  }
  for (const point of doc.landmarks) { minY = Math.min(minY, point.param.y); maxY = Math.max(maxY, point.param.y) }
  const bounded = Number.isFinite(minY) && Number.isFinite(maxY)
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ, bounded ? maxY - minY : 0, 16)
  return {
    target: new Vector3((bounds.minX + bounds.maxX) / 2, bounded ? (minY + maxY) / 2 : 0, (bounds.minZ + bounds.maxZ) / 2),
    radius: Math.min(8000, Math.max(8, span * 1.35)), theta: 0.6, phi: 0.72,
  }
}

export function placeOrbitCamera(camera: PerspectiveCamera, orbit: OrbitState): void {
  const sinPhi = Math.sin(orbit.phi)
  camera.position.set(
    orbit.target.x + orbit.radius * sinPhi * Math.sin(orbit.theta),
    orbit.target.y + orbit.radius * Math.cos(orbit.phi),
    orbit.target.z + orbit.radius * sinPhi * Math.cos(orbit.theta),
  )
  camera.lookAt(orbit.target)
  camera.updateMatrixWorld()
}

/** 中键抓取：画面中的对象随鼠标向右/向下移动。相机与目标沿相反的屏幕方向平移。 */
export function panOffset(camera: PerspectiveCamera, orbit: OrbitState, viewHeight: number, dx: number, dy: number): Vector3 {
  const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
  const up = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1)
  const height = Math.max(viewHeight, 1)
  const scale = (2 * Math.max(orbit.radius, 0.1) * Math.tan((camera.fov * Math.PI) / 360)) / height
  return new Vector3().addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale)
}

/**
 * 全高度体积的可编辑薄带。有限高度取中位，避免显示柱 -64..320 把相机拉开。
 * 没有有限高度时落在主世界常见地面。
 */
export function editingBandAuthorY(doc: LevelDocument): number {
  const mids: number[] = []
  for (const region of doc.regions) for (const area of region.areas) {
    if (area.y === 'all') continue
    mids.push((Math.min(area.y[0], area.y[1]) + Math.max(area.y[0], area.y[1])) / 2)
  }
  if (mids.length === 0) return 64
  mids.sort((left, right) => left - right)
  return mids[Math.floor((mids.length - 1) / 2)] ?? 64
}

export function viewAngles(kind: Exclude<ViewCommandKind, 'focus'>, currentTheta: number): { theta: number; phi: number } {
  if (kind === 'top') return { theta: currentTheta, phi: 0.22 }
  if (kind === 'front') return { theta: 0, phi: 1.15 }
  if (kind === 'side') return { theta: Math.PI / 2, phi: 1.15 }
  return { theta: 0.6, phi: 0.72 }
}

function areaFocusBox(area: LevelArea, bandY: number): { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } | null {
  const y = area.y === 'all' ? [bandY, bandY] as [number, number] : area.y
  if (area.kind === 'rect') return rectWorldBox(area.x, area.z, y)
  const [minY, maxY] = worldYSpan(y)
  if (area.kind === 'circle') {
    const [centerX, centerZ] = circleWorldCenter(area.center[0], area.center[1])
    return {
      minX: centerX - area.radius,
      maxX: centerX + area.radius,
      minY,
      maxY,
      minZ: centerZ - area.radius,
      maxZ: centerZ + area.radius,
    }
  }
  if (area.points.length === 0) return null
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const point of area.points) {
    const [x, z] = polygonWorldPoint(point[0], point[1])
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minZ = Math.min(minZ, z)
    maxZ = Math.max(maxZ, z)
  }
  return { minX, maxX, minY, maxY, minZ, maxZ }
}

/** 对准选中包围盒。无选中时用整场，并保留当前轨道角。全高度不把显示柱算进半径。 */
export function selectionFocusOrbit(
  doc: LevelDocument,
  selection: LevelSelection,
  angles: { theta: number; phi: number },
): OrbitState {
  const bandY = editingBandAuthorY(doc)
  let box: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } | null = null
  if (selection?.kind === 'region') {
    const area = doc.regions.find((region) => region.id === selection.id)?.areas[selection.area]
    if (area) box = areaFocusBox(area, bandY)
  } else if (selection?.kind === 'landmark') {
    const point = doc.landmarks.find((item) => item.id === selection.id)
    if (point) {
      box = {
        minX: point.param.x,
        maxX: point.param.x,
        minY: point.param.y,
        maxY: point.param.y,
        minZ: point.param.z,
        maxZ: point.param.z,
      }
    }
  }
  if (!box) {
    const initial = initialDocumentOrbit(doc)
    return { target: initial.target.clone(), radius: initial.radius, theta: angles.theta, phi: angles.phi }
  }
  const span = Math.max(box.maxX - box.minX, box.maxY - box.minY, box.maxZ - box.minZ, 4)
  return {
    target: new Vector3((box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2, (box.minZ + box.maxZ) / 2),
    radius: Math.min(8000, Math.max(8, span * 1.85)),
    theta: angles.theta,
    phi: angles.phi,
  }
}
