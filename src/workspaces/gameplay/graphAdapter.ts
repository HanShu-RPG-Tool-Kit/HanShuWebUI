import * as M from './model'
import { layoutCanvas, nodeMetrics, socketOffset } from './canvas'
import type { FlowSimState } from './signals'
import type { EditorEdge, EditorNode } from '../../nodeEditor'

export type ProgressNodeData = { flow: M.ProgressFlow; sim: FlowSimState; draft: boolean; resolveText?: (key: string) => string | null }

const COLORS = {
  activate: '#7a9aab',
  success: '#7fae86',
  failure: '#c07a7a',
  conjunction: '#c9b07a',
  disjunction: '#8fa9c9',
  predicate: '#b79ad0',
} as const

export function nodeSelection(flow: M.ProgressFlow, id: string): M.FlowSelection {
  if (M.getCanvasNote(flow, id)) return { kind: 'note', id }
  if (M.getProgressNode(flow, id)) return { kind: 'progress', id }
  if (M.getPredicateNode(flow, id)) return { kind: 'predicate', id }
  if (M.getTransitionNode(flow, id)) return { kind: 'transition', id }
  if (M.getEndNode(flow, id)) return { kind: 'end', id }
  return { kind: 'flow' }
}
export function edgeSelection(id: string): M.FlowSelection {
  return { kind: 'logic-link', id: id.slice(6) }
}

export function portColor(flow: M.ProgressFlow, id: string, port: M.FlowPort): string {
  if (M.getProgressNode(flow, id)) return port === 'output' ? COLORS.success : port === 'output2' ? COLORS.failure : COLORS.activate
  if (M.getTransitionNode(flow, id)) return port === 'input' ? COLORS.conjunction : port === 'input2' ? COLORS.disjunction : COLORS.activate
  if (M.getEndNode(flow, id)) return port === 'input2' ? COLORS.failure : COLORS.success
  if (M.getPredicateNode(flow, id)) return COLORS.predicate
  return COLORS.activate
}

function portLabel(flow: M.ProgressFlow, id: string, port: M.FlowPort): string {
  if (M.getProgressNode(flow, id)) return port === 'output' ? '成功' : port === 'output2' ? '失败' : '激活'
  if (M.getTransitionNode(flow, id)) return port === 'input' ? '合取' : port === 'input2' ? '析取' : '通过'
  if (M.getEndNode(flow, id)) return port === 'input2' ? '失败入' : '成功入'
  if (M.getPredicateNode(flow, id)) return '查询'
  return 'A'
}

export function progressEdges(flow: M.ProgressFlow): EditorEdge[] {
  return (flow.logic?.links ?? []).map(link => {
    const sourcePort = M.linkSourcePort(flow, link.from, link.fromPort)
    return {
      id: `logic:${link.id}`,
      source: link.from,
      target: link.to,
      sourcePort,
      targetPort: link.port,
      color: portColor(flow, link.from, sourcePort),
      label: `${portLabel(flow, link.from, sourcePort)} → ${portLabel(flow, link.to, link.port)}`,
    }
  })
}

export function progressNodes(flow: M.ProgressFlow, sim: FlowSimState, onUpdateNote: (id: string, patch: Partial<M.FlowCanvasNote>) => void, resolveText?: (key: string) => string | null): EditorNode[] {
  const layout = layoutCanvas(flow)
  const reachable = M.connectedToStart(flow)
  return layout.ids.map(id => {
    const note = M.getCanvasNote(flow, id), metrics = nodeMetrics(flow, id)
    const ports = [...M.inputPorts(flow, id), ...M.outputPorts(flow, id)].map(port => ({
      id: port,
      direction: M.isOutputPort(port) ? 'output' as const : 'input' as const,
      y: socketOffset(flow, id, port).y,
      label: portLabel(flow, id, port),
      color: portColor(flow, id, port),
    }))
    return {
      id,
      type: note ? 'note' : 'progress',
      position: layout.positions.get(id)!,
      width: metrics.width,
      height: metrics.height,
      ports,
      deletable: id !== flow.start,
      label: id === flow.start ? '开始进度节点，不可删除' : `${nodeSelection(flow, id).kind} ${id}`,
      data: note ? { ...note, onChange: (patch: Partial<M.FlowCanvasNote>) => onUpdateNote(id, patch) } : { flow, sim, draft: !reachable.has(id), resolveText },
    }
  })
}
