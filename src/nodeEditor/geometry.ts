import type { EditorConnection, EditorNode, Point, Port, PortSide } from './types'

export function normalizeConnection(nodes: EditorNode[], connection: EditorConnection): EditorConnection | null {
  const source = nodes.find(node => node.id === connection.source)?.ports.find(port => port.id === connection.sourcePort)
  const target = nodes.find(node => node.id === connection.target)?.ports.find(port => port.id === connection.targetPort)
  if (!source || !target || source.direction === target.direction) return null
  return source.direction === 'output' ? connection : {
    source: connection.target, target: connection.source, sourcePort: connection.targetPort, targetPort: connection.sourcePort,
  }
}

export function portSide(port: Pick<Port, 'direction' | 'side'>): PortSide {
  return port.side ?? (port.direction === 'output' ? 'right' : 'left')
}
export function portOffset(port: Pick<Port, 'direction' | 'side' | 'x' | 'y'>): number | '50%' {
  const side = portSide(port)
  return (side === 'top' || side === 'bottom' ? port.x : port.y) ?? '50%'
}
const normals: Record<PortSide, Point> = { left:{x:-1,y:0}, right:{x:1,y:0}, top:{x:0,y:-1}, bottom:{x:0,y:1} }
/** Controls leave both sockets along their outward sides, independent of semantic direction. */
export function wireGeometry(from: Point, to: Point, loop = false, sourceSide: PortSide = 'right', targetSide: PortSide = 'left') {
  const source = normals[sourceSide], target = normals[targetSide], dx = to.x-from.x, dy = to.y-from.y
  const projection = Math.max(Math.abs(dx*source.x+dy*source.y),Math.abs(dx*target.x+dy*target.y))
  const bend = Math.min(160, Math.max(projection*.45, Math.min(24,Math.hypot(dx,dy)*.2)))
  const lateral = loop ? {x:-source.y*140,y:source.x*140} : {x:0,y:0}
  const distance = loop ? 95 : bend
  const a = {x:from.x+source.x*distance+lateral.x,y:from.y+source.y*distance+lateral.y}
  const b = {x:to.x+target.x*distance+lateral.x,y:to.y+target.y*distance+lateral.y}
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

