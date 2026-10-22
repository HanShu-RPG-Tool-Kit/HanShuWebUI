import { useState, useSyncExternalStore } from 'react'
import type { ProjectClient } from './serviceClient'
import { getProjectSession, setProjectSession } from './projectSession'
import { saveProjectToDirectory } from './projectFs'
import { setBoundProject } from './bindingBus'
import type { TransactionPhase } from './editTransactions'
import { inspectConflict, isSkinSemanticEdit, type ConflictInspection } from './editConflicts'
import { EditConflictDialog } from './EditConflictDialog'
import { skinTransactionDescription } from './skinTransactionPresentation'
import { synchronizeProject } from './syncProject'

const labels: Record<TransactionPhase, string> = {
  preparing: '准备修改', submitting: '正在提交', saved: '已保存', failed: '提交失败', conflict: '提交冲突', uncertain: '结果待确认',
}
export function EditTransactionPanel({ client }: { client: ProjectClient }) {
  const state = useSyncExternalStore(client.transactions.subscribe, client.transactions.getSnapshot)
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState('')
  const [conflict,setConflict] = useState<ConflictInspection|null>(null)
  const [syncing,setSyncing] = useState(false)
  const [syncMessage,setSyncMessage] = useState('')
  async function synchronize() {
    if(syncing || !window.confirm('放弃与服务器冲突的本机修改，提交其余可提交修改，并同步服务器状态。结果待确认的提交会先查询。是否继续？'))return
    setSyncing(true);setSyncMessage('');setError('')
    try {setSyncMessage(await synchronizeProject(client))} catch(e) {setError(e instanceof Error?e.message:String(e))} finally {setSyncing(false)}
  }
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
  async function abandonSkinOperation(id: number) {
    // Refresh first: if disconnected, the original command remains recoverable.
    await client.refresh()
    await client.transactions.forget(id)
    const binding = getProjectSession().binding
    if (binding?.handle.client === client) {
      const next = { ...binding }
      setProjectSession({ binding: next }); setBoundProject(next)
    }
  }
  return <section className="project-edit-state" aria-label="工程提交状态">
    <div className="project-edit-summary">
      <span role="status" className={failures.length ? 'project-service-error' : ''}>{message}</span>
      <button onClick={() => void run(save)} disabled={!client.writable || state.queued > 0 || (!state.pendingPaths.length && !failures.length)}>保存修改</button>
      <button onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>提交记录{failures.length ? ` · ${failures.length}` : ''}</button>
      <button disabled={!client.writable||state.queued>0||syncing} onClick={()=>void synchronize()}>放弃冲突修改并同步修改</button>
      {state.preparing > 0 && <span>正在整理本地草稿…</span>}
    </div>
    {state.journalError && <p role="alert">{state.journalError}</p>}
    {syncMessage&&<p role="status">{syncMessage}</p>}
    {error&&<p role="alert">{error}</p>}
    {syncing&&<div className="project-connect-backdrop" onKeyDown={e=>{e.preventDefault();e.stopPropagation()}}><section role="dialog" aria-modal="true" aria-label="正在同步修改" className="project-connect-dialog"><h2>正在同步修改</h2><p>查询提交结果、去掉冲突修改并保存其余修改。请稍候。</p><button autoFocus aria-disabled="true">正在同步…</button></section></div>}
    {(expanded || failures.length > 0) && <div className="project-edit-records">
      {state.transactions.length === 0 && <p>尚无提交记录。语言修改随正文一起保存。</p>}
      {[...(expanded ? state.transactions : failures)].reverse().map(t => {
        const submission = client.transactions.submission(t.id)
        const skinOperation = skinTransactionDescription(submission)
        const semantic = submission.some(isSkinSemanticEdit)
        const history = submission.some(edit => edit.op === 'history-restore')
        const progress = submission.some(edit => edit.op === 'progress-command')
        const needsNewOperation = (!!skinOperation || history || progress) && t.phase === 'conflict' && t.code !== 'locked'
        return <article key={t.id}>
        <div><strong>{t.label}</strong><span>{labels[t.phase]}</span></div>
        {skinOperation && <p>{skinOperation}</p>}
        <ul>{t.paths.map(path => <li key={path}>{path}</li>)}</ul>
        {t.message && t.phase !== 'saved' && <p>{t.message}</p>}
        {t.phase === 'conflict' && <p>{t.code === 'locked' ? '请等待持有者释放写权，再重试原提交。' : history ? '工程已变化。请在历史版本中放弃原恢复并重新预览范围，原草稿保留。' : skinOperation ? '操作涉及的皮肤、文件夹或范围已有变化。原操作已保留；请放弃原操作并刷新皮肤库，再核对对象重新操作。不能用整份索引覆盖他人的修改。' : semantic ? '皮肤条目已有更新。请在对应皮肤的详情面板对照远端版本，选择保留修改或采用远端。' : '原版本已过期。打开冲突处理，对照原始版本、服务器版本和本次修改。'}</p>}
        {skinOperation && t.phase === 'uncertain' && <p>服务器可能已经完成此操作。请查询结果或重试原提交，确认前不要重新创建同一项。</p>}
        {['failed', 'conflict', 'uncertain'].includes(t.phase) && <footer>
          {t.phase === 'uncertain' && <button disabled={state.queued>0} onClick={()=>void run(()=>client.transactions.confirm(t.id))}>查询提交结果</button>}
          {t.phase === 'conflict' && t.code !== 'locked' && !semantic && !history && !progress && <button disabled={!client.online||state.queued>0} onClick={()=>void run(async()=>setConflict(await inspectConflict(client,t.id)))}>处理冲突</button>}
          {progress && t.phase === 'conflict' && t.code !== 'locked' && <span>请在进度表单中对照并处理字段冲突。</span>}
          {!needsNewOperation && <button disabled={!client.writable || state.queued > 0} onClick={() => void run(async () => { if (t.phase !== 'uncertain') await client.assertEditingIntent(submission); return client.transactions.retry(t.id) })}>重试原提交</button>}
          <button onClick={() => void run(() => download(t.id))}>导出此提交</button>
          {t.phase!=='uncertain' && <button disabled={state.queued > 0 || (!!skinOperation && !client.online)} onClick={() => void run(()=>skinOperation ? abandonSkinOperation(t.id) : client.transactions.forget(t.id))}>{skinOperation ? '放弃原操作，刷新皮肤库' : '移除记录，保留草稿'}</button>}
        </footer>}
      </article>})}
    </div>}
    {conflict&&<EditConflictDialog client={client} initial={conflict} onClose={()=>setConflict(null)}/>}
  </section>
}
