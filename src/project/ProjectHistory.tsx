import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ProjectClient } from './serviceClient'
import { useFileEditing } from './useFileEditing'
import { ProjectHistoryCompare } from './ProjectHistoryCompare'
import { ResourceSaveStatus } from './ResourceSaveStatus'
import { getProjectSession } from './projectSession'
import { decodeHistoryContent, exportLegacyHistory, historyBytes, historyContent, historyStats, listProjectHistory, nameHistoryVersion, planHistoryRestore, type HistoryEntry, type HistoryPage, type HistoryRestorePlan, type HistoryStats } from './historyClient'
import './ProjectHistory.css'

const SKIN_INDEX = '.hanshu/skinmanager/library.json'
const kindName: Record<string, string> = { baseline: '初始版本', edit: '编辑', external: '外部修改', restore: '历史恢复' }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const dateTime = (time: number) => new Date(time).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
const timeOnly = (time: number) => new Date(time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

function HistoryRestore({ client, initial, onSaved, onClose }: { client: ProjectClient; initial: HistoryRestorePlan; onSaved: () => void; onClose: () => void }) {
  const [plan, setPlan] = useState(initial)
  const [transactionId, setTransactionId] = useState<number>()
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const state = useSyncExternalStore(client.transactions.subscribe, client.transactions.getSnapshot)
  const record = state.transactions.find(record => record.id === transactionId)
  const reported = useRef(false)
  useEffect(() => {
    if (record?.phase === 'saved' && !reported.current) { reported.current = true; onSaved() }
  }, [record?.phase, onSaved])
  async function submit() {
    if (working || record) return
    setWorking(true); setError('')
    const before = new Set(client.transactions.getSnapshot().transactions.map(record => record.id))
    let createdId: number | undefined
    try {
      const promise = client.restoreHistory(plan)
      const created = client.transactions.getSnapshot().transactions.find(record => !before.has(record.id))
      if (created) { createdId = created.id; setTransactionId(created.id) }
      await promise
    } catch (error) {
      // The transaction owns recoverable errors. Keeping another copy here would
      // leave an obsolete “unknown result” warning after its receipt is confirmed.
      if (!client.transactions.getSnapshot().transactions.some(record => record.id === createdId)) setError(errorText(error))
    } finally { setWorking(false) }
  }
  async function replan() {
    if (working || record?.phase === 'uncertain') return
    setWorking(true); setError('')
    try {
      if (record) await client.transactions.forget(record.id)
      setTransactionId(undefined)
      const { sequence, paths, skinEntryId, includeRelated } = plan.request
      const next = await planHistoryRestore(client, { sequence, paths, skinEntryId, includeRelated })
      setPlan(next)
    } catch (error) { setError(errorText(error)) } finally { setWorking(false) }
  }
  const unresolved = record && record.phase !== 'saved'
  return <section className="project-history-restore" aria-label="历史恢复计划">
    <header><div><strong>恢复预览 · 版本 #{plan.request.sequence}</strong><p>{plan.request.paths === null ? '整个工程' : plan.request.skinEntryId ? '单个皮肤条目及必要对象' : '所选文件'} · {plan.changes.length} 处变化</p></div><button type="button" onClick={onClose} disabled={working} aria-label="关闭恢复预览">×</button></header>
    {plan.changes.length ? <ul>{plan.changes.map(change => <li key={change.path}><span>{change.action === 'remove' ? '删除' : change.action === 'mkdir' ? '创建目录' : change.beforeVersion ? '覆盖' : '新增'}</span><code>{change.path}</code></li>)}</ul> : <p>目标内容与当前工程相同，无需恢复。</p>}
    {plan.warnings.map((warning, index) => <p key={index} className="project-history-warning">{warning}</p>)}
    <p>恢复会生成新的工程版本。已有历史保留；本窗口未提交的草稿不会被替换。</p>
    {transactionId !== undefined && <ResourceSaveStatus client={client} path="project.json" transactionId={transactionId} />}
    {error && <p role="alert" className="project-history-error">{error}</p>}
    <footer>{record?.phase === 'saved' ? <strong role="status">已恢复，新的版本已加入工程历史。</strong> : <>
      {(!record || record.phase === 'conflict' || record.phase === 'failed') && <button type="button" disabled={working || !client.writable} onClick={() => void replan()}>{record ? '放弃原恢复并重新预览' : '重新核对恢复计划'}</button>}
      <button type="button" className="primary" disabled={working || !!unresolved || !client.writable || !plan.changes.length} onClick={() => void submit()}>{working ? '正在处理…' : '确认恢复'}</button>
    </>}</footer>
  </section>
}

/** One project-wide entry point shared by every workspace. */
export function ProjectHistory({ client, onClose }: { client: ProjectClient | null; onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const first = dialog.current?.querySelector<HTMLElement>('button'); first?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return }
      // Editing shortcuts belong to this dialog while it is open. They must not
      // save or undo the workspace underneath a read-only history comparison.
      if ((event.ctrlKey || event.metaKey) && ['s', 'z', 'y'].includes(event.key.toLowerCase())) {
        event.stopPropagation()
        if (event.key.toLowerCase() === 's') event.preventDefault()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? [])].filter(element => element.getClientRects().length)
      const first = focusable[0], last = focusable.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    window.addEventListener('keydown', keydown, true)
    return () => { window.removeEventListener('keydown', keydown, true); previous?.focus() }
  }, [onClose])
  return <div className="project-history-backdrop"><div ref={dialog} className="project-history-dialog" role="dialog" aria-modal="true" aria-label="工程历史">
    {client ? <ConnectedHistory client={client} onClose={onClose} /> : <><header className="project-history-header"><div><h2>工程历史</h2><p>连接工程后，查看所有协作者共享的历史版本。</p></div><button type="button" onClick={onClose} aria-label="关闭工程历史">×</button></header><div className="project-history-empty"><p>尚未连接工程。</p><button type="button" onClick={exportLegacyHistory}>导出旧本地历史</button><p>旧历史仅存在本浏览器中，导出不会将其混入工程历史，也不会删除原数据。</p></div></>}
  </div></div>
}

function ConnectedHistory({ client, onClose }: { client: ProjectClient; onClose: () => void }) {
  useFileEditing(client)
  const [page, setPage] = useState<HistoryPage | null>(null)
  const [stats, setStats] = useState<HistoryStats | null>(null)
  const [filterInput, setFilterInput] = useState('')
  const [filter, setFilter] = useState('')
  const [left, setLeft] = useState<number | null>(null)
  const [right, setRight] = useState<number | null>(null)
  const [selectedPath, setSelectedPath] = useState('')
  const [historicalScope, setHistoricalScope] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)
  const [includeRelated, setIncludeRelated] = useState(true)
  const [restore, setRestore] = useState<HistoryRestorePlan | null>(null)
  const [skinEntries, setSkinEntries] = useState<{ entryId: string; name: string }[]>([])
  const [skinEntryId, setSkinEntryId] = useState(client.editing.focusEntryId ?? '')
  const requestEpoch = useRef(0)
  const loadedFilter = useRef<string | null>(null)
  const selected = page?.entries.find(entry => entry.sequence === right)
  const reload = useCallback(() => setTick(value => value + 1), [])
  useEffect(() => {
    let stopped = false
    const update = () => { void historyStats(client).then(stats => { if (!stopped) setStats(stats) }).catch(() => undefined) }
    update(); const timer = window.setInterval(update, 15000)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [client, tick])
  useEffect(() => {
    const epoch = ++requestEpoch.current
    setLoading(true); setError('')
    void listProjectHistory(client, null, filter).then(next => {
      if (requestEpoch.current !== epoch) return
      const filterChanged = loadedFilter.current !== filter
      loadedFilter.current = filter
      setPage(next)
      setRight(current => filterChanged ? next.entries[0]?.sequence ?? null : current ?? next.entries[0]?.sequence ?? null)
      setLeft(current => filterChanged ? next.entries[1]?.sequence ?? next.entries[0]?.sequence ?? null : current ?? next.entries[1]?.sequence ?? next.entries[0]?.sequence ?? null)
      if (filterChanged) setRestore(null)
    }).catch(error => { if (requestEpoch.current === epoch) setError(errorText(error)) }).finally(() => { if (requestEpoch.current === epoch) setLoading(false) })
    return () => { requestEpoch.current++ }
  }, [client, filter, tick])
  useEffect(() => { setName(selected?.label ?? '') }, [right, selected?.label])
  useEffect(() => {
    if (selectedPath !== SKIN_INDEX || right === null) { setSkinEntries([]); return }
    let stopped = false
    const parse = (text: string) => {
      try { const parsed = JSON.parse(text); return Array.isArray(parsed.entries) ? parsed.entries.filter((entry: { entryId?: string; name?: string }) => typeof entry?.entryId === 'string' && typeof entry.name === 'string') as { entryId: string; name: string }[] : [] } catch { return [] }
    }
    void Promise.all([
      historyContent(client, right, SKIN_INDEX).then(value => parse(new TextDecoder().decode(decodeHistoryContent(value)))).catch(() => []),
      client.read(SKIN_INDEX, false).then(file => file.text()).then(parse).catch(() => []),
    ]).then(([old, current]) => {
      if (stopped) return
      const entries = [...new Map([...current, ...old].map(entry => [entry.entryId, entry])).values()]
      setSkinEntries(entries)
      setSkinEntryId(value => entries.some(entry => entry.entryId === value) ? value : entries[0]?.entryId ?? '')
    })
    return () => { stopped = true }
  }, [client, selectedPath, right])
  const groups = useMemo(() => {
    const groups: HistoryEntry[][] = []
    for (const entry of page?.entries ?? []) {
      const last = groups.at(-1)
      if (last && last[0].groupId === entry.groupId && !entry.label && !last.some(item => item.label)) last.push(entry)
      else groups.push([entry])
    }
    return groups
  }, [page])
  const choices = useMemo(() => {
    const values = new Set((page?.entries ?? []).map(entry => entry.sequence))
    if (left !== null) values.add(left)
    if (right !== null) values.add(right)
    return [...values].sort((a, b) => b - a)
  }, [page, left, right])
  const knownPaths = [...new Set([...(page?.entries.flatMap(entry => entry.changes.map(change => change.path)) ?? []), ...client.tree.entries.filter(entry => entry.kind === 'file').map(entry => entry.path)])].sort()
  async function run(action: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError('')
    try { await action() } catch (error) { setError(errorText(error)) } finally { setBusy(false) }
  }
  async function more() {
    if (!page?.nextBefore || loading) return
    const epoch = requestEpoch.current
    setLoading(true); setError('')
    try {
      const next = await listProjectHistory(client, page.nextBefore, filter)
      if (requestEpoch.current === epoch) setPage(current => current ? { ...next, entries: [...current.entries, ...next.entries.filter(entry => !current.entries.some(previous => previous.sequence === entry.sequence))] } : next)
    } catch (error) { if (requestEpoch.current === epoch) setError(errorText(error)) } finally { if (requestEpoch.current === epoch) setLoading(false) }
  }
  function choose(entry: HistoryEntry) {
    setRight(entry.sequence)
    const older = page?.entries.find(item => item.sequence < entry.sequence)
    setLeft(older?.sequence ?? entry.sequence)
    setRestore(null)
  }
  async function preview(whole: boolean) {
    if (right === null || !whole && !selectedPath) return
    setRestore(await planHistoryRestore(client, { sequence: right, paths: whole ? null : [selectedPath], skinEntryId: !whole && selectedPath === SKIN_INDEX ? skinEntryId || null : null, includeRelated: !whole && includeRelated }))
  }
  const canRestore = client.writable && !busy && right !== null
  const binding = getProjectSession().binding
  const projectName = binding?.handle.client === client ? binding.manifest.name : client.snapshot.projectName
  return <>
    <header className="project-history-header"><div><h2>工程历史 <span>{projectName}</span></h2><p>每次成功修改都会记录，连续编辑合并为时段。命名版本固定保留当时的工程状态。</p></div><div className="project-history-header-actions"><button type="button" disabled={loading || !client.online} onClick={reload} aria-label="刷新工程历史">{stats && page && stats.head > page.head ? '有新历史 · 刷新' : '刷新'}</button><button type="button" onClick={onClose} aria-label="关闭工程历史">×</button></div></header>
    <div className="project-history-subheader"><span>{stats ? `${stats.revisions} 次内容修改 · ${stats.namedVersions} 个命名版本 · 历史内容 ${historyBytes(stats.storedBytes)}` : '正在读取历史…'}</span><button type="button" onClick={exportLegacyHistory}>导出旧本地历史</button></div>
    {error && <p role="alert" className="project-history-error project-history-top-error">{error}</p>}
    <div className="project-history-layout">
      <aside className="project-history-timeline" aria-label="工程历史时间线">
        <form className="project-history-filter" onSubmit={event => { event.preventDefault(); setFilter(filterInput.trim()) }}><label>文件或目录<input aria-label="筛选历史文件" value={filterInput} onChange={event => setFilterInput(event.target.value)} placeholder="全部工程" list="project-history-paths" /><datalist id="project-history-paths">{knownPaths.map(path => <option key={path} value={path} />)}</datalist></label><div><button type="submit" disabled={loading}>筛选</button>{filter && <button type="button" onClick={() => { setFilterInput(''); setFilter('') }}>全部历史</button>}<button type="button" disabled={!client.editing.focus || loading} onClick={() => { const path = client.editing.focus ?? ''; setFilterInput(path); setFilter(path) }}>当前资源</button></div></form>
        <div className="project-history-timeline-items">{groups.map(entries => {
          const latest = entries[0], earliest = entries.at(-1)!, authors = [...new Set(entries.map(entry => entry.actor?.name).filter(Boolean))]
          const paths = new Set(entries.flatMap(entry => entry.changes.map(change => change.path)))
          return <article key={latest.sequence} className={entries.some(entry => entry.sequence === right) ? 'selected' : ''}>
            <button type="button" className="project-history-session" aria-label={`查看版本 ${latest.sequence}`} aria-pressed={latest.sequence === right} onClick={() => choose(latest)}><span className="project-history-session-time">{dateTime(earliest.time)}{entries.length > 1 ? ` — ${timeOnly(latest.time)}` : ''}</span><strong>{latest.label || (entries.length > 1 ? '连续编辑' : kindName[latest.kind])}</strong><span>{authors.join('、') || (latest.kind === 'external' ? '外部工具' : '系统')} · {paths.size} 个路径</span><small>{entries.length} 次提交 · #{earliest.sequence}{latest.sequence !== earliest.sequence ? `–${latest.sequence}` : ''}</small></button>
            {entries.length > 1 && <details><summary>展开提交明细</summary>{entries.slice(1).map(entry => <button type="button" className="project-history-commit" key={entry.sequence} aria-label={`查看版本 ${entry.sequence}`} aria-pressed={entry.sequence === right} onClick={() => choose(entry)}><span>#{entry.sequence} · {timeOnly(entry.time)}</span><span>{entry.actor?.name ?? kindName[entry.kind]} · {entry.changes.length} 处变化</span></button>)}</details>}
          </article>
        })}{!loading && !groups.length && <p className="project-history-empty">{filter ? '这个路径尚无历史记录。' : '尚无工程历史。'}</p>}{loading && <p role="status">正在读取历史…</p>}{page?.nextBefore != null && <button type="button" className="project-history-more" onClick={() => void more()} disabled={loading}>加载更早历史</button>}</div>
      </aside>
      <main className="project-history-main">
        <div className="project-history-controls"><label>较早版本<select aria-label="较早版本" value={left ?? ''} onChange={event => { setLeft(Number(event.target.value)); setRestore(null) }}>{choices.map(sequence => <option key={sequence} value={sequence}>#{sequence}{page?.entries.find(entry => entry.sequence === sequence)?.label ? ` · ${page.entries.find(entry => entry.sequence === sequence)!.label}` : ''}</option>)}</select></label><span>→</span><label>较晚版本<select aria-label="较晚版本" value={right ?? ''} onChange={event => { setRight(Number(event.target.value)); setRestore(null) }}>{choices.map(sequence => <option key={sequence} value={sequence}>#{sequence}{page?.entries.find(entry => entry.sequence === sequence)?.label ? ` · ${page.entries.find(entry => entry.sequence === sequence)!.label}` : ''}</option>)}</select></label><form onSubmit={event => { event.preventDefault(); if (right !== null) void run(async () => { await nameHistoryVersion(client, right, name.trim() || null); reload() }) }}><label>版本名称<input aria-label="版本名称" maxLength={120} value={name} onChange={event => setName(event.target.value)} placeholder="例如：第一章验收" disabled={!client.writable} /></label><button type="submit" disabled={busy || !client.writable || right === null}>{name.trim() ? '命名此版本' : selected?.label ? '移除版本名称' : '命名此版本'}</button></form></div>
        {selected && <div className="project-history-version-info"><span>版本 #{selected.sequence} · {dateTime(selected.time)} · {selected.actor ? `${selected.actor.name} / ${selected.actor.clientName}` : kindName[selected.kind]}</span>{selected.moves?.map(move => <span key={`${move.from}:${move.to}`}>移动：{move.from} → {move.to}</span>)}</div>}
        {left !== null && right !== null ? <ProjectHistoryCompare key={filter} client={client} left={left} right={right} initialPath={filter || client.editing.focus || ''} scope={filter} onPathChange={setSelectedPath} onScopePath={setHistoricalScope} /> : <div className="project-history-empty">选择历史版本，查看两个工程状态之间的变化。</div>}
        {filter && historicalScope && historicalScope !== filter && <p className="project-history-rename-notice">此资源在所选版本使用旧路径。按历史路径恢复：<code>{selectedPath || historicalScope}</code>。当前名称下的文件不会因此改名或删除。</p>}
        <div className="project-history-restore-controls">
          {selectedPath === SKIN_INDEX ? <label>皮肤条目<select aria-label="历史皮肤条目" value={skinEntryId} onChange={event => { setSkinEntryId(event.target.value); setRestore(null) }}><option value="">选择一个条目</option>{skinEntries.map(entry => <option key={entry.entryId} value={entry.entryId}>{entry.name}</option>)}</select></label> : <label><input type="checkbox" checked={includeRelated} onChange={event => { setIncludeRelated(event.target.checked); setRestore(null) }} />包含所属语言与配音</label>}
          <button type="button" disabled={!canRestore || !selectedPath || selectedPath === SKIN_INDEX && !skinEntryId} onClick={() => void run(() => preview(false))}>{selectedPath === SKIN_INDEX ? '预览恢复皮肤条目' : '预览恢复当前文件'}</button>
          {client.snapshot.role === 'owner' && <button type="button" disabled={!canRestore} onClick={() => void run(() => preview(true))}>预览恢复整个工程</button>}
          {client.snapshot.role === 'viewer' && <span>只读访问，可查看和下载历史。</span>}
        </div>
        {restore && <HistoryRestore key={JSON.stringify(restore.request)} client={client} initial={restore} onSaved={reload} onClose={() => setRestore(null)} />}
      </main>
    </div>
  </>
}
