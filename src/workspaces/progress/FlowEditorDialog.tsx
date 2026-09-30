import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FlowEditorForm } from './FlowEditorForm'
import { clone, displayText, getGoalNode, getLogicNode, getTransitionNode, getHubNode, getGatewayNode, getNode, parseFlow, removeNode, validateFlow, type FlowSelection, type ProgressFlow } from './model'
import './FlowEditorDialog.css'

export function FlowEditorDialog({ flow, initialSelection, origin, onComplete, onCancel }: {
  flow: ProgressFlow; initialSelection: FlowSelection; origin: HTMLElement | null
  onComplete: (flow: ProgressFlow, selection: FlowSelection) => void; onCancel: () => void
}) {
  const [draft, setDraft] = useState(() => clone(flow))
  const [selection, setSelection] = useState(initialSelection)
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const [error, setError] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId(), hintId = useId()
  const locked = Object.values(pending).some(Boolean)
  const dirty = locked || JSON.stringify(draft) !== JSON.stringify(flow)
  const isEntry = selection.kind === 'entry' || selection.kind === 'entry-link'
  const kind = isEntry ? '起点' : selection.kind === 'node' ? '阶段' : selection.kind === 'transition' ? '转移节点' : selection.kind === 'hub' ? '集线器' : selection.kind === 'gateway' ? '网关' : selection.kind === 'goal' ? 'Goal' : selection.kind === 'logic' ? '逻辑节点' : selection.kind === 'logic-link' ? '连接' : selection.kind === 'branch' ? '推进分支' : '流程信息'
  const title = isEntry ? '选择流程开始的节点' : selection.kind === 'node' || selection.kind === 'logic' || selection.kind === 'goal' || selection.kind === 'transition' || selection.kind === 'hub' || selection.kind === 'gateway' ? displayText((getNode(draft, selection.id) ?? getLogicNode(draft, selection.id) ?? getGoalNode(draft, selection.id) ?? getTransitionNode(draft, selection.id) ?? getHubNode(draft, selection.id) ?? getGatewayNode(draft, selection.id))?.title ?? { text: '' }) : selection.kind === 'flow' ? displayText(draft.title) : ''

  useEffect(() => {
    const element = dialog.current
    if (!element) return
    element.showModal()
    element.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled)')?.focus()
    return () => {
      element.close()
      requestAnimationFrame(() => {
        if (origin?.isConnected && document.activeElement === document.body) origin.focus({ preventScroll: true })
      })
    }
  }, [origin])
  useEffect(() => {
    const element = dialog.current
    if (element && !element.contains(document.activeElement)) element.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled)')?.focus()
  }, [selection])
  useEffect(() => {
    if (!dirty) return
    const preventLoss = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', preventLoss)
    return () => window.removeEventListener('beforeunload', preventLoss)
  }, [dirty])

  function complete() {
    if (locked) { setError('请先应用或放弃尚未应用的修改。'); return }
    try {
      const next = parseFlow(JSON.stringify(draft))
      // Deletion may empty a wait condition. Preserve that repairable draft just as canvas deletion does.
      const baseline = Object.keys(flow.nodes).reduce((value, id) => getNode(next, id) ? value : removeNode(value, id), flow)
      const previous = new Set(validateFlow(baseline).filter((issue) => issue.severity === 'error').map((issue) => `${issue.path}:${issue.message}`))
      const added = validateFlow(next).filter((issue) => issue.severity === 'error' && !previous.has(`${issue.path}:${issue.message}`))
      if (added.length) { setError(added.map((issue) => issue.message).join(' ')); return }
      onComplete(next, selection)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  return createPortal(<dialog ref={dialog} className="flow-editor-dialog" aria-labelledby={titleId} aria-describedby={hintId} onCancel={(event) => { event.preventDefault(); onCancel() }} onKeyDown={(event) => {
    if ((event.ctrlKey || event.metaKey) && (event.key === 'Enter' || event.key.toLowerCase() === 's')) { event.preventDefault(); event.stopPropagation(); complete() }
  }}>
    <header className="flow-editor-header"><div><h2 id={titleId}>编辑{kind}</h2><p id={hintId}>{title || '填写内容，完成后应用到流程。'}</p></div><button type="button" className="flow-editor-close" aria-label="取消并关闭编辑" onClick={onCancel}>×</button></header>
    <div className="flow-editor-body">
      <FlowEditorForm key={selection.kind === 'node' || selection.kind === 'logic' || selection.kind === 'goal' || selection.kind === 'transition' || selection.kind === 'hub' || selection.kind === 'gateway' || selection.kind === 'logic-link' ? `${selection.kind}:${selection.id}` : selection.kind === 'branch' ? `branch:${selection.parent}:${selection.id}` : selection.kind} flow={draft} selection={selection} onChange={(next) => { setDraft(next); setError('') }} onSelect={setSelection} onPending={(label, value) => setPending((previous) => ({ ...previous, [label]: value }))} onNotice={setError} locked={locked} />
    </div>
    <footer className="flow-editor-footer"><div aria-live="polite">{error ? <p className="flow-error" role="alert">{error}</p> : <span>{locked ? '请先应用或放弃字段修改' : '完成后保存 · Ctrl+Enter 确认'}</span>}</div><button type="button" onClick={onCancel}>取消</button><button type="button" className="flow-primary" disabled={locked} onClick={complete}>完成</button></footer>
  </dialog>, document.body)
}
