import type { EditorConnection, EditorNode, Point } from './types'

export function normalizeConnection(nodes: EditorNode[], connection: EditorConnection): EditorConnection | null {
  const source = nodes.find(node => node.id === connection.source)?.ports.find(port => port.id === connection.sourcePort)
  const target = nodes.find(node => node.id === connection.target)?.ports.find(port => port.id === connection.targetPort)
  if (!source || !target || source.direction === target.direction) return null
  return source.direction === 'output' ? connection : {
    source: connection.target, target: connection.source, sourcePort: connection.targetPort, targetPort: connection.sourcePort,
  }
}

export function wireGeometry(from: Point, to: Point, loop = false) {
  const bend = Math.min(160, Math.abs(to.x - from.x) * .45)
  const a = loop ? { x: from.x + 95, y: from.y + 140 } : { x: from.x + bend, y: from.y }
  const b = loop ? { x: to.x - 95, y: to.y + 140 } : { x: to.x - bend, y: to.y }
  const path = `M ${from.x} ${from.y} C ${a.x} ${a.y}, ${b.x} ${b.y}, ${to.x} ${to.y}`
  return { path, sample: (t: number): Point => {
    const u = 1 - t
    return { x: u ** 3 * from.x + 3 * u * u * t * a.x + 3 * u * t * t * b.x + t ** 3 * to.x,
      y: u ** 3 * from.y + 3 * u * u * t * a.y + 3 * u * t * t * b.y + t ** 3 * to.y }
  } }
}

export function segmentsCross(a: Point, b: Point, c: Point, d: Point) {
  if (Math.max(a.x,b.x) < Math.min(c.x,d.x) || Math.max(c.x,d.x) < Math.min(a.x,b.x) || Math.max(a.y,b.y) < Math.min(c.y,d.y) || Math.max(c.y,d.y) < Math.min(a.y,b.y)) return false
  const side = (p: Point,q: Point,r: Point) => (q.x-p.x)*(r.y-p.y)-(q.y-p.y)*(r.x-p.x)
  return side(a,b,c)*side(a,b,d) <= 0 && side(c,d,a)*side(c,d,b) <= 0
}

