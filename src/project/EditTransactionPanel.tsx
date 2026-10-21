import { useState, useSyncExternalStore } from 'react'
import type { ProjectClient } from './serviceClient'
import { getProjectSession, setProjectSession } from './projectSession'
import { saveProjectToDirectory } from './projectFs'
import { setBoundProject } from './bindingBus'
import type { TransactionPhase } from './editTransactions'
import { inspectConflict, type ConflictInspection } from './editConflicts'
import { EditConflictDialog } from './EditConflictDialog'

const labels: Record<TransactionPhase, string> = {
  preparing: '准备修改', submitting: '正在提交', saved: '已保存', failed: '提交失败', conflict: '提交冲突', uncertain: '结果待确认',
}
export function EditTransactionPanel({ client }: { client: ProjectClient }) {
  const state = useSyncExternalStore(client.transactions.subscribe, client.transactions.getSnapshot)
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState('')
  const [conflict,setConflict] = useState<ConflictInspection|null>(null)
  const failures = state.transactions.filter(t => ['failed', 'conflict', 'uncertain'].includes(t.phase))
  const current = state.transactions.find(t => t.phase === 'submitting') ?? state.transactions.find(t => t.phase === 'preparing')
  const message = current ? labels[current.phase] : failures.length ? `${failures.length} 次提交待处理` : state.pendingPaths.length ? `${state.pendingPaths.length} 个文件待保存` : '修改已保存'
  async function run(action: () => Promise<void>) {
    setError('')
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : String(e)); setExpanded(true) }
  }
  async function save() {
    const live = getProjectSession()
    if (live.binding?.handle.client !== client) return
    const binding = await saveProjectToDirectory(live.binding, live.workspace)
    if (getProjectSession().binding?.handle.client !== client) return
    setProjectSession({ binding }); setBoundProject(binding)
  }
  async function download(id: number) {
    const blob = await client.transactions.backup(id)
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a'); link.href = url; link.download = `hanshu-edit-${id}.json`; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <section className="project-edit-state" aria-label="工程提交状态">
    <div className="project-edit-summary">
      <span role="status" className={failures.length ? 'project-service-error' : ''}>{message}</span>
      <button onClick={() => void run(save)} disabled={!client.writable || state.queued > 0 || (!state.pendingPaths.length && !failures.length)}>保存修改</button>
      <button onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>提交记录{failures.length ? ` · ${failures.length}` : ''}</button>
      {state.preparing > 0 && <span>正在整理本地草稿…</span>}
    </div>
    {state.journalError && <p role="alert">{state.journalError}</p>}
    {(expanded || failures.length > 0) && <div className="project-edit-records">
      {error && <p role="alert">{error}</p>}
      {state.transactions.length === 0 && <p>尚无提交记录。语言修改随正文一起保存。</p>}
      {[...state.transactions].reverse().map(t => <article key={t.id}>
        <div><strong>{t.label}</strong><span>{labels[t.phase]}</span></div>
        <ul>{t.paths.map(path => <li key={path}>{path}</li>)}</ul>
        {t.message && t.phase !== 'saved' && <p>{t.message}</p>}
        {t.phase === 'conflict' && <p>{t.code === 'locked' ? '请等待持有者释放写权，再重试原提交。' : '原版本已过期。打开冲突处理，对照原始版本、服务器版本和本次修改。'}</p>}
        {['failed', 'conflict', 'uncertain'].includes(t.phase) && <footer>
          {t.phase === 'uncertain' && <button disabled={state.queued>0} onClick={()=>void run(()=>client.transactions.confirm(t.id))}>查询提交结果</button>}
          {t.phase === 'conflict' && t.code !== 'locked' && <button disabled={!client.online||state.queued>0} onClick={()=>void run(async()=>setConflict(await inspectConflict(client,t.id)))}>处理冲突</button>}
          <button disabled={!client.writable || state.queued > 0} onClick={() => void run(() => { if (t.phase !== 'uncertain') client.assertEditingIntent(client.transactions.submission(t.id)); return client.transactions.retry(t.id) })}>重试原提交</button>
          <button onClick={() => void run(() => download(t.id))}>导出此提交</button>
          {t.phase!=='uncertain' && <button disabled={state.queued > 0} onClick={() => void run(()=>client.transactions.forget(t.id))}>移除记录，保留草稿</button>}
        </footer>}
      </article>)}
    </div>}
    {conflict&&<EditConflictDialog client={client} initial={conflict} onClose={()=>setConflict(null)}/>}
  </section>
}
