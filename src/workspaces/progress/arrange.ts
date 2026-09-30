import { layoutCanvas, moveCanvasNodes, nodeMetrics } from './canvas'
import type { FlowPosition, ProgressFlow } from './model'

const TOLERANCE = 32
const EPSILON = .001
type Item = FlowPosition & { id: string; width: number; height: number }
type Axis = 'x' | 'y'
type Band = { items: Item[]; size: number }

/** Refine the author's existing rows and columns; graph connectivity never sets the layout. */
export function smartArrangeCanvas(flow: ProgressFlow, ids: string[]): ProgressFlow {
  const layout = layoutCanvas(flow), selected = new Set(ids)
  const all = layout.ids.map(id => ({ id, ...layout.positions.get(id)!, ...nodeMetrics(flow, id) }))
  const items = all.filter(item => selected.has(item.id))
  if (items.length < 2) return flow
  const original = new Map(all.map(item => [item.id, { x: item.x, y: item.y }]))
  const overlap = (a: Item, b: Item) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))

  function apply(axis: Axis, changes: Map<Item, number>) {
    if (!changes.size) return
    const next = (item: Item) => changes.has(item) ? { ...item, [axis]: changes.get(item)! } : item
    // Keep every nudge small and avoid creating or worsening overlaps, including unselected items.
    for (const [item, value] of changes) {
      const point = { ...item, [axis]: value }, start = original.get(item.id)!
      if (Math.hypot(point.x - start.x, point.y - start.y) > TOLERANCE + EPSILON) return
      for (const other of all) {
        if (other === item) continue
        if (overlap(next(item), next(other)) > overlap(item, other) + EPSILON) return
      }
    }
    for (const [item, value] of changes) item[axis] = value
  }

  function bands(axis: Axis): Band[] {
    const size = axis === 'x' ? 'width' : 'height'
    const sorted = [...items].sort((a, b) => a[axis] - b[axis] || a.id.localeCompare(b.id))
    const nearby: Item[][] = []
    for (const item of sorted) {
      const previous = nearby.at(-1)
      if (previous && item[axis] - previous.at(-1)![axis] <= TOLERANCE) previous.push(item)
      else nearby.push([item])
    }
    // A long chain of small offsets is ambiguous; leave it alone instead of collapsing it.
    const groups = nearby.flatMap(group => group.at(-1)![axis] - group[0][axis] <= TOLERANCE ? [group] : group.map(item => [item]))
    return groups.map(group => {
      const anchor = group.reduce((sum, item) => sum + item[axis], 0) / group.length
      apply(axis, new Map(group.map(item => [item, anchor])))
      return { items: group, size: Math.max(...group.map(item => item[size])) }
    })
  }

  const columns = bands('x'), rows = bands('y')
  function space(axis: Axis, along: Band[], across: Band[]) {
    const membership = new Map(along.flatMap((band, index) => band.items.map(item => [item.id, index] as const)))
    const parents = along.map((_, index) => index)
    const root = (index: number): number => parents[index] === index ? index : (parents[index] = root(parents[index]))
    // Shared columns/rows move together, keeping an existing matrix intact.
    for (const band of across) {
      const indices = [...new Set(band.items.map(item => membership.get(item.id)!))]
      if (indices.length < 3 || band.items.some(item => Math.abs(item[axis === 'x' ? 'y' : 'x'] - band.items[0][axis === 'x' ? 'y' : 'x']) > EPSILON)) continue
      for (const index of indices.slice(1)) parents[root(index)] = root(indices[0])
    }
    const components = new Map<number, number[]>()
    along.forEach((_, index) => { const key = root(index); components.set(key, [...(components.get(key) ?? []), index]) })
    for (const indices of components.values()) {
      if (indices.length < 3) continue
      const group = indices.map(index => along[index])
      if (group.some(band => band.items.some(item => Math.abs(item[axis] - band.items[0][axis]) > EPSILON))) continue
      const gaps = group.slice(1).map((band, index) => band.items[0][axis] - group[index].items[0][axis] - group[index].size)
      if (Math.min(...gaps) < 12 || Math.max(...gaps) - Math.min(...gaps) > TOLERANCE) continue
      const gap = gaps.reduce((sum, value) => sum + value, 0) / gaps.length
      let anchor = group[0].items[0][axis]
      const changes = new Map<Item, number>()
      for (const band of group) {
        for (const item of band.items) changes.set(item, anchor)
        anchor += band.size + gap
      }
      apply(axis, changes)
    }
  }
  space('x', columns, rows)
  space('y', rows, columns)
  const positions = Object.fromEntries(items.filter(item => Math.abs(item.x - original.get(item.id)!.x) > EPSILON || Math.abs(item.y - original.get(item.id)!.y) > EPSILON).map(item => [item.id, { x: item.x, y: item.y }]))
  return Object.keys(positions).length ? moveCanvasNodes(flow, positions) : flow
}
