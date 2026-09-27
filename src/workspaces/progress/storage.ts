import { createFlow, isObject, parseFlow } from './model'
import { parseJsonValue } from '../../utils/strictJson'

export const FLOW_STORAGE_KEY = 'hanshu.progressWorkspace.v1'
export type FlowDocument = { key: string; name: string; source: string }
export type FlowWorkspaceState = { documents: FlowDocument[]; activeKey: string | null }
export const createFlowDocument = (flow = createFlow()): FlowDocument => ({ key: crypto.randomUUID(), name: `${flow.id.replace(/[\\/:*?"<>|]/g, '_')}.hflow`, source: JSON.stringify(flow, null, 2) })

function readState(raw: string): FlowWorkspaceState {
  const state = parseJsonValue(raw)
  if (!isObject(state) || !Array.isArray(state.documents) || !state.documents.every((d) => isObject(d) && typeof d.key === 'string' && typeof d.name === 'string' && typeof d.source === 'string')) throw new Error('本地草稿库结构不正确')
  const documents = state.documents as FlowDocument[]
  if (new Set(documents.map((d) => d.key)).size !== documents.length) throw new Error('草稿标识重复')
  return { documents, activeKey: documents.some((d) => d.key === state.activeKey) ? state.activeKey as string : documents[0]?.key ?? null }
}

export function loadFlowWorkspace(): { state: FlowWorkspaceState; error: string } {
  try {
    const raw = localStorage.getItem(FLOW_STORAGE_KEY)
    if (raw !== null) return { state: readState(raw), error: '' }
    const doc = createFlowDocument()
    return { state: { documents: [doc], activeKey: doc.key }, error: '' }
  } catch (error) { return { state: { documents: [], activeKey: null }, error: `无法读取草稿；原始存储未覆盖。${String(error)}` } }
}
export function saveFlowWorkspace(state: FlowWorkspaceState) { localStorage.setItem(FLOW_STORAGE_KEY, JSON.stringify(state)) }
export function importFlowDocument(name: string, source: string): FlowDocument {
  const flow = parseFlow(source.replace(/^\uFEFF/, ''))
  return { ...createFlowDocument(flow), name: name.replace(/\.(hflow|json)$/i, '') + '.hflow' }
}
export function downloadFlowFile(name: string, data: string | Blob) {
  const url = URL.createObjectURL(typeof data === 'string' ? new Blob([data], { type: 'application/json;charset=utf-8' }) : data)
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = name.replace(/[\\/:*?"<>|]/g, '_')
  document.body.append(anchor); anchor.click(); anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
