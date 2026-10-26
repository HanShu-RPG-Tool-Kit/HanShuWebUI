import type { FlowSimState } from './signals'

/** Local observer settings. Never mutate the executor or persist to the quest. */
export type SignalBreakpoints = { nodes: string[]; links: string[] }
export type SignalStop = { traceId: number; nodeId: string; reason: 'node' | 'link' | 'target' }
export function signalStop(sim: FlowSimState, breakpoints: SignalBreakpoints, target: string | null = null): SignalStop | null {
  const delivery = sim.queue[0]
  if (!delivery || delivery.traceId === undefined || sim.outcome || sim.fault) return null
  const reason = delivery.to === target ? 'target' : breakpoints.nodes.includes(delivery.to) ? 'node'
    : delivery.link && breakpoints.links.includes(delivery.link) ? 'link' : null
  return reason ? { traceId: delivery.traceId, nodeId: delivery.to, reason } : null
}
