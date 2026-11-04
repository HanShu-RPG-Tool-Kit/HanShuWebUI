import {
  LEVEL_AREAS_MAX,
  stringifyLevelDocument,
  validateLevelDocument,
  type LevelArea,
  type LevelDocument,
  type LevelLandmark,
  type LevelRegion,
  type LevelY,
} from './levelDoc'
import {
  authorCircleFromWorld,
  authorPointFromWorld,
  authorRectFromWorldFaces,
  withinCoordinateLimit,
  type SnapStep,
} from './levelGeometry'

export type DragSnap = { step?: SnapStep; worldFaces?: boolean; authored?: boolean }

const HISTORY_LIMIT = 100

export type LevelHistory = {
  undo: LevelDocument[]
  current: LevelDocument
  redo: LevelDocument[]
}

export function snapBlock(value: number): number {
  return Math.round(value)
}

export function levelHistory(doc: LevelDocument): LevelHistory {
  return { undo: [], current: doc, redo: [] }
}

export function levelHistoryCommit(history: LevelHistory, next: LevelDocument, limit = HISTORY_LIMIT): LevelHistory {
  if (stringifyLevelDocument(history.current) === stringifyLevelDocument(next)) return history
  return {
    undo: [...history.undo, history.current].slice(-limit),
    current: next,
    redo: [],
  }
}

export function levelHistoryUndo(history: LevelHistory): LevelHistory {
  const previous = history.undo.at(-1)
  if (!previous) return history
  return {
    undo: history.undo.slice(0, -1),
    current: previous,
    redo: [...history.redo, history.current],
  }
}

export function levelHistoryRedo(history: LevelHistory): LevelHistory {
  const next = history.redo.at(-1)
  if (!next) return history
  return {
    undo: [...history.undo, history.current],
    current: next,
    redo: history.redo.slice(0, -1),
  }
}

export function uniqueChildId(existing: readonly string[], prefix: string): string {
  const used = new Set(existing.map((id) => id.toLowerCase()))
  if (!used.has(prefix.toLowerCase())) return prefix
  for (let index = 2; index < 10000; index += 1) {
    const id = `${prefix}_${index}`
    if (!used.has(id.toLowerCase())) return id
  }
  return `${prefix}_x`
}

export function rectFromDrag(x0: number, z0: number, x1: number, z1: number, y?: LevelY): LevelArea
export function rectFromDrag(x0: number, z0: number, x1: number, z1: number, y: LevelY, drag: DragSnap): LevelArea | null
export function rectFromDrag(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  y: LevelY = 'all',
  drag?: DragSnap,
): LevelArea | null {
  if (drag?.worldFaces) {
    const authored = authorRectFromWorldFaces(x0, z0, x1, z1, drag.step ?? 1)
    return authored ? { kind: 'rect', x: authored.x, z: authored.z, y } : null
  }
  const minX = Math.min(snapBlock(x0), snapBlock(x1))
  const maxX = Math.max(snapBlock(x0), snapBlock(x1))
  const minZ = Math.min(snapBlock(z0), snapBlock(z1))
  const maxZ = Math.max(snapBlock(z0), snapBlock(z1))
  return { kind: 'rect', x: [minX, maxX], z: [minZ, maxZ], y }
}

export function circleFromDrag(x0: number, z0: number, x1: number, z1: number, y?: LevelY): LevelArea
export function circleFromDrag(x0: number, z0: number, x1: number, z1: number, y: LevelY, drag: DragSnap): LevelArea | null
export function circleFromDrag(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  y: LevelY = 'all',
  drag?: DragSnap,
): LevelArea | null {
  if (drag?.worldFaces) {
    const authored = authorCircleFromWorld(x0, z0, x1, z1, drag.step ?? 1)
    return authored ? { kind: 'circle', center: authored.center, radius: authored.radius, y } : null
  }
  const center: [number, number] = [snapBlock(x0), snapBlock(z0)]
  const radius = Math.max(1, Math.round(Math.hypot(x1 - x0, z1 - z0)))
  return { kind: 'circle', center, radius, y }
}

export function polygonFromPoints(points: readonly [number, number][], y?: LevelY): LevelArea
export function polygonFromPoints(points: readonly [number, number][], y: LevelY, drag: DragSnap): LevelArea | null
export function polygonFromPoints(
  points: readonly [number, number][],
  y: LevelY = 'all',
  drag?: DragSnap,
): LevelArea | null {
  if (drag?.authored || drag?.worldFaces) {
    const converted: [number, number][] = []
    for (const [x, z] of points) {
      if (drag.authored) {
        if (!withinCoordinateLimit(x) || !withinCoordinateLimit(z)) return null
        converted.push([x, z])
      } else {
        const author = authorPointFromWorld(x, z, drag.step ?? 1)
        if (!author) return null
        converted.push(author)
      }
    }
    return { kind: 'polygon', points: converted, y }
  }
  const snapped = points.map(([x, z]) => [snapBlock(x), snapBlock(z)] as [number, number])
  return { kind: 'polygon', points: snapped, y }
}

export function addArea(doc: LevelDocument, regionId: string | null, area: LevelArea): LevelDocument {
  if (regionId) {
    return {
      ...doc,
      regions: doc.regions.map((region) => region.id === regionId && region.areas.length < LEVEL_AREAS_MAX
        ? { ...region, areas: [...region.areas, area] }
        : region),
    }
  }
  const id = uniqueChildId(doc.regions.map((region) => region.id), 'region')
  const region: LevelRegion = { id, areas: [area], custom_data: {} }
  return { ...doc, regions: [...doc.regions, region] }
}

export function replaceArea(doc: LevelDocument, regionId: string, index: number, area: LevelArea): LevelDocument {
  return {
    ...doc,
    regions: doc.regions.map((region) => region.id !== regionId ? region : {
      ...region,
      areas: region.areas.map((current, areaIndex) => areaIndex === index ? area : current),
    }),
  }
}

/** 删掉区域里最后一个 area 时连区域一起删，避免留下空 areas。 */
export function deleteArea(doc: LevelDocument, regionId: string, index: number): LevelDocument {
  return {
    ...doc,
    regions: doc.regions.flatMap((region) => {
      if (region.id !== regionId) return [region]
      const areas = region.areas.filter((_, areaIndex) => areaIndex !== index)
      return areas.length ? [{ ...region, areas }] : []
    }),
  }
}

export function deleteRegion(doc: LevelDocument, regionId: string): LevelDocument {
  return { ...doc, regions: doc.regions.filter((region) => region.id !== regionId) }
}

export function renameRegion(doc: LevelDocument, regionId: string, nextId: string): LevelDocument {
  const id = nextId.trim()
  if (!id || id === regionId) return doc
  if (doc.regions.some((region) => region.id !== regionId && region.id.toLowerCase() === id.toLowerCase())) return doc
  return { ...doc, regions: doc.regions.map((region) => region.id === regionId ? { ...region, id } : region) }
}

export function setRegionCustom(doc: LevelDocument, regionId: string, custom: LevelRegion['custom_data']): LevelDocument {
  return {
    ...doc,
    regions: doc.regions.map((region) => region.id === regionId ? { ...region, custom_data: custom } : region),
  }
}

export function setAreaY(doc: LevelDocument, regionId: string, index: number, y: LevelY): LevelDocument {
  return {
    ...doc,
    regions: doc.regions.map((region) => region.id !== regionId ? region : {
      ...region,
      areas: region.areas.map((area, areaIndex) => areaIndex === index ? { ...area, y } : area),
    }),
  }
}

export function addLandmark(doc: LevelDocument, x: number, z: number, y = 64): { doc: LevelDocument; id: string } {
  const id = uniqueChildId(doc.landmarks.map((point) => point.id), 'landmark')
  const point: LevelLandmark = {
    id,
    kind: 'rpgtoolkit:pos',
    param: { x: snapBlock(x), y: snapBlock(y), z: snapBlock(z) },
    custom_data: {},
  }
  return { doc: { ...doc, landmarks: [...doc.landmarks, point] }, id }
}

export function moveLandmark(doc: LevelDocument, id: string, x: number, z: number): LevelDocument {
  return {
    ...doc,
    landmarks: doc.landmarks.map((point) => point.id === id
      ? { ...point, param: { ...point.param, x: snapBlock(x), z: snapBlock(z) } }
      : point),
  }
}

export function setLandmarkParam(doc: LevelDocument, id: string, param: LevelLandmark['param']): LevelDocument {
  return {
    ...doc,
    landmarks: doc.landmarks.map((point) => point.id === id ? { ...point, param: { ...param } } : point),
  }
}

export function deleteLandmark(doc: LevelDocument, id: string): LevelDocument {
  return { ...doc, landmarks: doc.landmarks.filter((point) => point.id !== id) }
}

export function renameLandmark(doc: LevelDocument, id: string, nextId: string): LevelDocument {
  const renamed = nextId.trim()
  if (!renamed || renamed === id) return doc
  if (doc.landmarks.some((point) => point.id !== id && point.id.toLowerCase() === renamed.toLowerCase())) return doc
  return { ...doc, landmarks: doc.landmarks.map((point) => point.id === id ? { ...point, id: renamed } : point) }
}

export function setLandmarkCustom(doc: LevelDocument, id: string, custom: LevelLandmark['custom_data']): LevelDocument {
  return {
    ...doc,
    landmarks: doc.landmarks.map((point) => point.id === id ? { ...point, custom_data: custom } : point),
  }
}

export function levelIssues(doc: LevelDocument): string[] {
  return validateLevelDocument(doc)
}

export function hitArea(area: LevelArea, x: number, z: number): boolean {
  if (area.kind === 'rect') {
    return x >= area.x[0] && x <= area.x[1] && z >= area.z[0] && z <= area.z[1]
  }
  if (area.kind === 'circle') {
    return Math.hypot(x - area.center[0], z - area.center[1]) <= area.radius
  }
  return pointInPolygon(x, z, area.points)
}

export function contentBounds(doc: LevelDocument): { minX: number; minZ: number; maxX: number; maxZ: number } {
  let minX = 0
  let minZ = 0
  let maxX = 64
  let maxZ = 64
  let any = false
  const grow = (x: number, z: number) => {
    if (!any) {
      minX = maxX = x
      minZ = maxZ = z
      any = true
      return
    }
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minZ = Math.min(minZ, z)
    maxZ = Math.max(maxZ, z)
  }
  for (const region of doc.regions) {
    for (const area of region.areas) {
      if (area.kind === 'rect') {
        grow(area.x[0], area.z[0])
        grow(area.x[1], area.z[1])
      } else if (area.kind === 'circle') {
        grow(area.center[0] - area.radius, area.center[1] - area.radius)
        grow(area.center[0] + area.radius, area.center[1] + area.radius)
      } else {
        for (const [x, z] of area.points) grow(x, z)
      }
    }
  }
  for (const point of doc.landmarks) grow(point.param.x, point.param.z)
  if (maxX - minX < 16) maxX = minX + 16
  if (maxZ - minZ < 16) maxZ = minZ + 16
  return { minX, minZ, maxX, maxZ }
}

function pointInPolygon(x: number, z: number, points: readonly [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, zi] = points[i]!
    const [xj, zj] = points[j]!
    const intersect = (zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / ((zj - zi) || 1e-9) + xi
    if (intersect) inside = !inside
  }
  return inside
}
