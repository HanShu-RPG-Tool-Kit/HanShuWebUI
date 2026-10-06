import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Field, IdField, TextField } from './Fields'
import { documentExtOf, isKitDocument, isNavigationDocument, isProgressDocument, isScriptDocument, resourceName } from './library'
import { parseFlow, setFlowId } from './model'
import type { FlowDocument } from './storage'

function formatStamp(value?: string) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false })
}

export function FlowDocumentProperties({ doc, onSave, onCancel }: {
  doc: FlowDocument
  onSave: (next: { name: string; source: string }) => void
  onCancel: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const script = isScriptDocument(doc)
  const kit = isKitDocument(doc)
  const progress = isProgressDocument(doc)
  const navigation = isNavigationDocument(doc)
  const plain = script || kit || progress || navigation
  const parsed = plain ? { flow: null, error: '' } : (() => { try { return { flow: parseFlow(doc.source), error: '' } } catch (error) { return { flow: null, error: error instanceof Error ? error.message : String(error) } } })()
  const [name, setName] = useState(doc.name)
  const [source, setSource] = useState(doc.source)
  const [flowId, setFlowIdDraft] = useState(parsed.flow?.id ?? '')
  const [error, setError] = useState('')
  const [pendingId, setPendingId] = useState(false)
  const currentId = plain ? '' : (() => { try { return parseFlow(source).id } catch { return parsed.flow?.id ?? '' } })()
  const dirty = pendingId || name !== doc.name || source !== doc.source
  const nameExt = documentExtOf(doc)

  useEffect(() => {
    const element = dialog.current
    if (!element) return
    element.showModal()
    element.querySelector<HTMLElement>('input:not(:disabled)')?.focus()
    return () => { element.close() }
  }, [])

  function applyId(value: string) {
    if (!parsed.flow && !currentId) throw new Error(parsed.error || '草稿无法解析，暂不能改文档 ID。')
    const flow = parseFlow(source)
    const next = setFlowId(flow, value)
    setSource(JSON.stringify(next, null, 2))
    setFlowIdDraft(next.id)
  }

  function submit() {
    try {
      if (pendingId) throw new Error('请先应用或放弃文档 ID 的修改。')
      const nextName = resourceName(name, nameExt)
      if (!plain && source !== doc.source) parseFlow(source)
      onSave({ name: nextName, source })
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  const title = kit ? '礼包属性' : navigation ? '导航点属性' : progress ? '进度属性' : script ? '脚本属性' : '流程属性'

  return createPortal(<dialog ref={dialog} className="flow-alert-dialog flow-properties-dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onCancel() }}>
    <header><strong id={titleId}>{title}</strong></header>
    <div className="flow-alert-body flow-properties-body">
      <TextField label="文件名" value={name} onChange={(value) => { setName(value); setError('') }} />
      {kit ? (
        <p className="flow-hint">礼包以 `.kit`（JSON）保存在本机草稿库；内容在主区表单中修改。</p>
      ) : navigation ? (
        <p className="flow-hint">导航点以 `.nav`（JSON）保存在本机草稿库；内容在主区表单中修改。</p>
      ) : progress ? (
        <p className="flow-hint">进度以 `.progress`（JSON）保存在本机草稿库；内容在主区表单中修改。</p>
      ) : script ? (
        <p className="flow-hint">脚本以 `.py` 保存在本机草稿库；内容在主编辑区修改。</p>
      ) : parsed.flow || currentId ? (
        <IdField key={currentId || flowId} label="文档 ID" value={currentId || flowId} disabled={false} onPending={(_, pending) => setPendingId(pending)} onApply={(value) => { applyId(value); setError('') }} />
      ) : (
        <p className="flow-error" role="alert">{parsed.error || '草稿无法解析，暂不能改文档 ID。'}</p>
      )}
      {!plain && <p className="flow-hint">文档 ID 是 `.hflow` 内的稳定身份，可按作者需要修改；不会改写图内节点引用。资源树中的文件键与文件名是另一套标识。</p>}
      <Field label="创建时间"><input value={formatStamp(doc.createdAt)} disabled readOnly /></Field>
      <Field label="修改时间"><input value={formatStamp(doc.updatedAt)} disabled readOnly /></Field>
      {error && <p className="flow-error" role="alert">{error}</p>}
    </div>
    <footer>
      <button type="button" onClick={onCancel}>取消</button>
      <button type="button" className="flow-primary" disabled={!dirty} onClick={submit}>保存</button>
    </footer>
  </dialog>, document.body)
}
