import { BoxGeometry, BufferGeometry, CylinderGeometry, ExtrudeGeometry, Shape } from 'three'
import type { LevelArea, LevelPolygonArea } from './levelDoc'
import { circleWorldCenter, polygonWorldPoint, rectWorldBox, worldYSpan } from './levelGeometry'

export function buildAreaGeometry(area: LevelArea, viewDistance: number): BufferGeometry | null {
  if (area.kind === 'rect') {
    const box = rectWorldBox(area.x, area.z, area.y)
    const sizeX = box.maxX - box.minX
    const sizeY = box.maxY - box.minY
    const sizeZ = box.maxZ - box.minZ
    if (![sizeX, sizeY, sizeZ].every((span) => Number.isFinite(span) && span > 0)) return null
    const geometry = new BoxGeometry(sizeX, sizeY, sizeZ)
    geometry.translate((box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2, (box.minZ + box.maxZ) / 2)
    return geometry
  }
  const [y0, y1] = worldYSpan(area.y)
  const height = y1 - y0
  if (!(height > 0)) return null
  if (area.kind === 'circle') {
    if (!(area.radius > 0)) return null
    const [centerX, centerZ] = circleWorldCenter(area.center[0], area.center[1])
    const geometry = new CylinderGeometry(area.radius, area.radius, height, circleSegments(area.radius, viewDistance))
    geometry.translate(centerX, (y0 + y1) / 2, centerZ)
    return geometry
  }
  const shifted: LevelPolygonArea = {
    ...area,
    points: area.points.map(([x, z]) => polygonWorldPoint(x, z)),
  }
  return buildPolygonVolume(shifted, y1, height)
}

/**
 * Shape 画在 XY，点是 (x, z)。挤出沿局部 +Z。
 * rotateX(+π/2) 把局部 +Y 送到世界 +Z、局部 +Z 送到世界 −Y，再平移到 yMax，
 * 所以顶面在 yMax，底面在 yMax − height。只反转网格副本，不改文档顶点。
 */
export function buildPolygonVolume(area: LevelPolygonArea, yMax: number, height: number): BufferGeometry | null {
  if (area.points.length < 3 || height <= 0) return null
  const ordered = signedArea(area.points) < 0 ? [...area.points].reverse() : area.points
  const shape = new Shape()
  const first = ordered[0]
  if (!first) return null
  shape.moveTo(first[0], first[1])
  for (let index = 1; index < ordered.length; index += 1) {
    const point = ordered[index]
    if (point) shape.lineTo(point[0], point[1])
  }
  try {
    const geometry = new ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, steps: 1, curveSegments: 1 })
    geometry.rotateX(Math.PI / 2)
    geometry.translate(0, yMax, 0)
    return geometry
  } catch {
    return null
  }
}

function circleSegments(radius: number, distance: number): number {
  const apparent = radius / Math.max(distance, 1)
  if (apparent < 0.015) return 8
  if (apparent < 0.06) return 14
  return 28
}

function signedArea(points: readonly [number, number][]): number {
  let sum = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    if (current && next) sum += current[0] * next[1] - next[0] * current[1]
  }
  return sum
}
