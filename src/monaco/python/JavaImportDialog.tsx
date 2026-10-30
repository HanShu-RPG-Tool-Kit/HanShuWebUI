import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type * as Monaco from 'monaco-editor'
import { subscribeControlHub, isControlConnected } from '../../gameDevServer/controlHub'
import { subscribeProjectSession } from '../../project/projectSession'
import { applyJavaImport, importRequestActive, searchJavaClasses, type ClassSearch, type ImportRequest } from './javaImportAction'
import { planJavaImport } from './javaImportPlan'
import './javaImport.css'

export function JavaImportDialog({ request, monaco, close }: { request: ImportRequest; monaco: typeof Monaco; close(): void }) {
  const ref = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null), titleId = useId()
  const [query, setQuery] = useState(request.query)
  const [search, setSearch] = useState<{ query: string; result: ClassSearch | null; error: string }>({ query: '', result: null, error: '' })
  const [selected, setSelected] = useState(0), [alias, setAlias] = useState(''), [error, setError] = useState(''), [applying, setApplying] = useState(false)
  const alive = useRef(true)
  const [active, setActive] = useState(true)
  useEffect(() => {
    alive.current = true
    const dialog = ref.current!; dialog.showModal(); input.current?.focus(); input.current?.select()
    const check = () => setActive(current => current && importRequestActive(request, monaco))
    const stop = subscribeControlHub(check), project = subscribeProjectSession(check)
    const model = request.model.onDidChangeContent(check), option = request.editor.onDidChangeConfiguration(check), swap = request.editor.onDidChangeModel(check), disposed = request.model.onWillDispose(() => setActive(false))
    return () => { alive.current = false; stop(); project(); model.dispose(); option.dispose(); swap.dispose(); disposed.dispose(); dialog.close() }
  }, [request, monaco])
  useEffect(() => {
    let cancelled = false
    if (query.trim().length < 2 || !active) return
    const timer = setTimeout(() => {
      void searchJavaClasses(query.trim()).then(
        value => { if (!cancelled) setSearch({ query, result: value, error: '' }) },
        cause => { if (!cancelled) setSearch({ query, result: null, error: `类搜索失败：${String(cause)}` }) },
      )
    }, 200)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [query, active])
  const results = active && search.query === query ? search.result : null
  const searching = active && query.trim().length >= 2 && search.query !== query
  const searchError = search.query === query ? search.error : ''
  useEffect(() => { ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [selected, results])
  const entry = results?.classes[selected]
  let preview = '', planError = ''
  if (entry && !request.model.isDisposed()) try { preview = planJavaImport(request.model.getValue(), entry, alias).preview } catch (cause) { planError = String(cause) }
  const finish = () => { alive.current = false; close(); if (!request.model.isDisposed()) request.editor.focus() }
  const apply = async () => {
    if (!entry || !results || !active || applying || planError) return
    setApplying(true); setError('')
    try { await applyJavaImport(request, entry, alias, results.runtimeId, monaco, () => !alive.current); if (alive.current) finish() }
    catch (cause) { if (alive.current) { setError(String(cause)); setApplying(false) } }
  }
  return createPortal(<dialog className="java-import-dialog" ref={ref} aria-labelledby={titleId} onCancel={e => { e.preventDefault(); finish() }} onKeyDown={e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const count = results?.classes.length ?? 0; if (count) { setSelected(i => (i + (e.key === 'ArrowDown' ? 1 : count - 1)) % count); setAlias('') } }
    if (e.key === 'Enter') { e.preventDefault(); void apply() }
    e.stopPropagation()
  }}>
    <header><strong id={titleId}>导入 Java 类</strong><button aria-label="关闭 Java 类导入" onClick={finish}>×</button></header>
    <input ref={input} aria-label="搜索 Java 类" placeholder="输入类名或完整包名…" value={query} disabled={!active || applying} onChange={e => { setQuery(e.target.value); setSelected(0); setAlias(''); setError('') }} />
    {!active && <p role="alert">文档、权限或游戏连接已变化，请关闭后重新导入。{!isControlConnected() && '需要连接游戏开发服务器。'}</p>}
    {searching && <p role="status">正在搜索游戏中的 Java 类…</p>}
    {!searching && query.trim().length < 2 && <p>输入至少两个字符开始搜索。</p>}
    <div className="java-import-results" role="listbox" aria-label="Java 类搜索结果">
      {results?.classes.map((item, index) => <button type="button" role="option" aria-selected={selected === index} key={item.name} disabled={!active || applying} onClick={() => { setSelected(index); setAlias('') }} onDoubleClick={() => { if (selected === index) void apply() }}>
        <strong>{item.symbol}</strong><small>{item.origin}</small><code>{item.name}</code>
      </button>)}
    </div>
    {!searching && results?.classes.length === 0 && <p>没有找到可导入的公开类。</p>}
    {results?.hasMore && <p>还有更多结果，请输入更完整的类名或包名。</p>}
    {entry && <><label>别名（可选）<input aria-label="Java 类导入别名" value={alias} disabled={!active || applying} placeholder="重名时自动避让" onChange={e => setAlias(e.target.value.trim())} /></label><pre aria-label="Java 类导入预览">{preview}</pre></>}
    {(error || planError || searchError) && <p role="alert">{error || planError || searchError}</p>}
    <footer><span>↑↓ 选择 · Enter 导入 · Esc 取消</span><button disabled={!active || !entry || searching || applying || !!planError} onClick={() => void apply()}>{applying ? '正在导入…' : '导入'}</button></footer>
  </dialog>, document.body)
}
