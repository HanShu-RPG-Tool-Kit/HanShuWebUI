import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type * as Monaco from 'monaco-editor'
import { applyHookHandler, hookInsertRequestActive, type HookInsertRequest } from './hookInsertAction'
import { planHookHandler, hookEventSymbol } from './hookInsert'
import './javaImport.css'

export function HookInsertDialog({
  request,
  monaco,
  close,
}: {
  request: HookInsertRequest
  monaco: typeof Monaco
  close(): void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [error, setError] = useState('')
  const [active, setActive] = useState(true)
  useEffect(() => {
    const dialog = ref.current!
    dialog.showModal()
    input.current?.focus()
    const check = () => setActive(current => current && hookInsertRequestActive(request, monaco))
    const model = request.model.onDidChangeContent(check)
    const option = request.editor.onDidChangeConfiguration(check)
    const swap = request.editor.onDidChangeModel(check)
    const disposed = request.model.onWillDispose(() => setActive(false))
    return () => {
      model.dispose()
      option.dispose()
      swap.dispose()
      disposed.dispose()
      dialog.close()
    }
  }, [request, monaco])
  const filtered = request.hooks.filter(hook => {
    const q = query.trim().toLowerCase()
    if (!q) return true
    return hook.id.toLowerCase().includes(q)
      || (hook.eventClass?.toLowerCase().includes(q) ?? false)
  })
  useEffect(() => { setSelected(0) }, [query])
  useEffect(() => {
    ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selected, filtered])
  const entry = filtered[selected]
  let preview = ''
  let planError = ''
  if (entry && !request.model.isDisposed()) {
    try {
      preview = planHookHandler(request.model.getValue(), entry, request.caretOffset).preview
    } catch (cause) {
      planError = String(cause)
    }
  }
  const finish = () => {
    close()
    if (!request.model.isDisposed()) request.editor.focus()
  }
  const apply = () => {
    if (!entry || !active || planError) return
    try {
      applyHookHandler(request, entry, monaco)
      finish()
    } catch (cause) {
      setError(String(cause))
    }
  }
  return createPortal(<dialog className="java-import-dialog" ref={ref} aria-labelledby={titleId} onCancel={e => { e.preventDefault(); finish() }} onKeyDown={e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const count = filtered.length
      if (count) setSelected(i => (i + (e.key === 'ArrowDown' ? 1 : count - 1)) % count)
    }
    if (e.key === 'Enter') { e.preventDefault(); apply() }
    e.stopPropagation()
  }}>
    <header>
      <strong id={titleId}>插入钩子函数</strong>
      <button type="button" aria-label="关闭插入钩子" onClick={finish}>×</button>
    </header>
    <input
      ref={input}
      aria-label="筛选宿主钩子"
      placeholder="筛选钩子 id 或事件类型…"
      value={query}
      disabled={!active}
      onChange={e => { setQuery(e.target.value); setError('') }}
    />
    {!active && <p role="alert">文档或权限已变化，请关闭后重试。</p>}
    <div className="java-import-results" role="listbox" aria-label="宿主钩子列表">
      {filtered.map((item, index) => (
        <button
          type="button"
          role="option"
          aria-selected={selected === index}
          key={item.id}
          disabled={!active}
          onClick={() => setSelected(index)}
          onDoubleClick={() => { if (selected === index) apply() }}
        >
          <strong>{item.id}</strong>
          <small>{item.cancellable ? '可取消' : '不可取消'}</small>
          <code>{item.eventClass ? `${hookEventSymbol(item.eventClass)} · ${item.eventClass}` : '无 eventClass'}</code>
        </button>
      ))}
    </div>
    {!filtered.length && <p>没有匹配的宿主钩子。</p>}
    {entry && <pre aria-label="钩子插入预览">{preview}</pre>}
    {(error || planError) && <p role="alert">{error || planError}</p>}
    <footer>
      <span>↑↓ 选择 · Enter 插入 · Esc 取消 · Ctrl+Alt+H</span>
      <button type="button" disabled={!active || !entry || !!planError} onClick={apply}>插入</button>
    </footer>
  </dialog>, document.body)
}
