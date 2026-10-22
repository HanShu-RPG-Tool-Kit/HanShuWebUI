import { useState, useSyncExternalStore } from 'react'
import type { ProjectClient } from './serviceClient'
import { useFileEditing } from './useFileEditing'
import { resourceDirty, resourceSaveState, resourceTransactions, type ResourceScope } from './resourceStatus'
import { inspectConflict, isSkinSemanticEdit, type ConflictInspection } from './editConflicts'
import { EditConflictDialog } from './EditConflictDialog'
import { getProjectSession, setProjectSession } from './projectSession'
import { setBoundProject } from './bindingBus'
import './file-presence.css'

export type ResourceSaveStatusProps = ResourceScope & { client: ProjectClient; dirty?: boolean; compact?: boolean }

/** A local recovery entry point for the SAME frozen transaction shown globally. */
export function ResourceSaveStatus({ client, dirty = false, compact = false, ...scope }: ResourceSaveStatusProps) {
  useFileEditing(client)
  const transactions = useSyncExternalStore(client.transactions.subscribe, client.transactions.getSnapshot)
  const unsaved = resourceDirty(client, scope, transactions, dirty)
  const state = resourceSaveState(resourceTransactions(client, scope, transactions), unsaved)
  const record = state.record
  const exactRecord = scope.transactionId === undefined ? undefined : transactions.transactions.find(item => item.id === scope.transactionId)
  const text = scope.transactionId !== undefined && !record ? exactRecord?.phase === 'saved' ? '已保存' : '原操作已移除，尚未重新提交' : state.text
  const key = JSON.stringify([scope.path, scope.entryId, scope.transactionId, record?.id])
  const [error, setError] = useState<{ client: ProjectClient; key: string; message: string } | null>(null)
  const [working, setWorking] = useState<{ client: ProjectClient; key: string; token: symbol } | null>(null)
  const [conflict, setConflict] = useState<{ client: ProjectClient; key: string; inspection: ConflictInspection } | null>(null)
  const edits = record ? client.transactions.submission(record.id) : []
  const semantic = edits.some(isSkinSemanticEdit)
  const management = edits.some(edit => edit.op === 'skin-library-command')
  const history = edits.some(edit => edit.op === 'history-restore')
  const progress = edits.some(edit => edit.op === 'progress-command')
  const failed = record && ['failed', 'conflict', 'uncertain'].includes(record.phase)
  const conflicting = record?.phase === 'conflict' && record.code !== 'locked'
  const disabled = working?.client === client && working.key === key || transactions.queued > 0
  async function run(action: () => Promise<void>) {
    const token = Symbol('resource recovery')
    setWorking({ client, key, token }); setError(null)
    try { await action() }
    catch (error) { setError({ client, key, message: error instanceof Error ? error.message : String(error) }) }
    finally { setWorking(current => current?.token === token ? null : current) }
  }
  async function abandon(id: number) {
    await client.refresh()
    await client.transactions.forget(id)
    const binding = getProjectSession().binding
    if (binding?.handle.client === client) {
      const next = { ...binding }
      setProjectSession({ binding: next }); setBoundProject(next)
    }
  }
  const explanation = !record ? !client.online && dirty ? '修改留在本窗口，恢复连接后再保存。' : ''
    : record.phase === 'uncertain' ? '服务可能已经保存。原提交已保留，请先查询结果，避免重复操作。'
      : record.code === 'locked' ? '写权暂被占用，输入和原提交已保留。释放后可重试原提交。'
        : conflicting ? history ? '工程已经变化，请在历史版本中重新预览恢复范围；当前输入保留。'
          : progress ? '同一字段已有更新。请在进度表单中对照并处理，后续输入仍保留。'
          : management ? '操作范围已经变化。放弃原操作并刷新后，重新核对对象；当前输入保留。'
          : semantic ? '条目已经变化，本地输入已保留。请在皮肤详情中对照并处理。'
            : '服务器内容已经变化，本地修改已保留。请对照版本后处理冲突。'
          : failed ? '输入和原提交已保留。可以修复原因后重试原提交。' : ''
  return <section className={`resource-save-status${compact ? ' is-compact' : ''}${failed ? ' has-error' : ''}`} aria-label="当前资源保存状态" data-entry-id={scope.entryId ?? undefined} data-transaction-id={record?.id}>
    <div className="resource-save-summary">
      <span className={`resource-save-badge is-${record?.phase ?? (unsaved ? 'dirty' : 'clean')}`} role="status">{text}</span>
      {failed && <span className="resource-save-operation">{record.label}</span>}
      {failed && <div className="resource-save-actions">
        {record.phase === 'uncertain' && <button type="button" disabled={disabled || !client.online} onClick={() => void run(() => client.transactions.confirm(record.id))}>查询提交结果</button>}
        {(!conflicting || record.phase === 'uncertain') && <button type="button" disabled={disabled || !client.writable} onClick={() => void run(() => client.transactions.retry(record.id))}>重试原提交</button>}
        {conflicting && !semantic && !history && !progress && <button type="button" disabled={disabled || !client.online} onClick={() => void run(async () => setConflict({ client, key, inspection: await inspectConflict(client, record.id) }))}>处理冲突</button>}
        {management && record.phase !== 'uncertain' && <button type="button" disabled={disabled || !client.online} onClick={() => void run(() => abandon(record.id))}>放弃原操作并刷新</button>}
      </div>}
    </div>
    {explanation && <p>{explanation}</p>}
    {failed && record.message && <p className="resource-save-error">{record.message}</p>}
    {error?.client === client && error.key === key && <p role="alert" className="resource-save-error">{error.message}</p>}
    {conflict?.client === client && conflict.key === key && <EditConflictDialog client={conflict.client} initial={conflict.inspection} onClose={() => setConflict(null)} />}
  </section>
}
