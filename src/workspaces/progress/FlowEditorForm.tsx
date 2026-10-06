import { IdField, TextField } from './Fields'
import { clone, disconnectLink, getNode, parseFlow, removeNode, renameNode, type FlowSelection, type FlowText, type ProgressFlow } from './model'
import { withCanvasPositions } from './canvas'

export function FlowEditorForm({ flow, selection, onChange, onSelect, onPending, onNotice, locked }: {
  flow: ProgressFlow; selection: FlowSelection; onChange: (flow: ProgressFlow) => void; onSelect: (selection: FlowSelection) => void
  onPending: (label: string, value: boolean) => void; onNotice: (notice: string) => void; locked: boolean
}) {
  function edit(mutate: (next: ProgressFlow) => void) {
    const next = clone(flow); mutate(next)
    onChange(parseFlow(JSON.stringify(next)))
  }
  function attempt(action: () => void) { try { action() } catch (error) { onNotice(String(error)) } }
  const authorText = (label: string, value: FlowText, update: (next: ProgressFlow, value: FlowText) => void, multiline = false) => (
    <TextField label={label} value={value.text} disabled={locked} multiline={multiline} onChange={(content) => edit((next) => update(next, { text: content }))} />
  )

  if (selection.kind === 'entry' || selection.kind === 'entry-link') return <div className="flow-editor-fields">
    <p className="flow-hint">开始节点保存整张图的名称与说明，并作为唯一信号源。出口连线在画布上操作；Ctrl+点击发出 S(未激活→已激活)。</p>
    {authorText('流程名称', flow.entry.title, (next, value) => { next.entry.title = value })}
    {authorText('流程说明', flow.entry.description, (next, value) => { next.entry.description = value }, true)}
  </div>

  if (selection.kind === 'flow') return <p className="flow-hint">在画布上选择开始节点，可编辑流程名称与说明。</p>

  if (selection.kind === 'node') {
    const { id } = selection, node = getNode(flow, id)
    if (!node) return <p className="flow-hint">节点已移除，请重新选择。</p>
    return <div className="flow-editor-fields">
      {authorText('阶段名称', node.title, (next, value) => { next.nodes[id].title = value })}
      {authorText('阶段说明', node.description, (next, value) => { next.nodes[id].description = value }, true)}
      <p className="flow-hint">后续经线性变迁：ckpt 激活出 → Parent；Next 发 S → 下一 ckpt。结束流程请连到「结束」节点。</p>
      <details><summary>结构与高级设置</summary>
        <IdField key={id} label="节点 ID" value={id} disabled={locked} onPending={onPending} onApply={(value) => { onChange(renameNode(flow, id, value)); onSelect({ kind: 'node', id: value }) }} />
        <div className="flow-inline-actions"><button type="button" className="flow-danger" disabled={locked} onClick={() => {
          attempt(() => { onChange(removeNode(withCanvasPositions(flow), id)); onSelect({ kind: 'flow' }) })
        }}>删除当前节点</button></div>
        <p className="flow-hint">只删除当前节点及相关连接，其他节点保留。完成后可撤销。</p>
      </details>
    </div>
  }

  if (selection.kind === 'logic-link') {
    const link = flow.logic?.links.find(link => link.id === selection.id)
    if (!link) return <p className="flow-hint">连接已移除，请重新选择。</p>
    return <div className="flow-editor-fields">
      <p className="flow-route">{link.from} → {link.to}</p>
      <p className="flow-hint">逻辑连线在画布上编辑；此处仅可断开。</p>
      <button type="button" className="flow-danger" disabled={locked} onClick={() => { onChange(disconnectLink(withCanvasPositions(flow), selection)); onSelect({ kind: 'flow' }) }}>断开连接</button>
    </div>
  }

  return <p className="flow-hint">当前选中的节点类型没有可编辑表单；请在画布上选择开始节点或 checkpoint。</p>
}
