import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ProjectClient } from '../../project/serviceClient'
import { textAssetPath } from '../../i18n/localeLayout'
import { parseProgress } from './progressDoc'
import type { GoalDefinitionCatalog } from './goalDefinitions'
import { ProgressEditor } from './ProgressEditor'
import { getProgressEditor,progressEditorSession } from './progressEditRegistry'
import { downloadFlowFile } from './storage'
import { progressSlot, type ProgressEffect } from './progressOperations'
import './ProgressEditor.css'

function fieldName(effect: ProgressEffect) {
  const target = effect.target
  if (target.kind === 'locale') return `${target.locale} · ${target.key === 'name' ? '标题' : target.key === 'description' ? '描述' : target.key}`
  if (target.kind === 'field') return ({ completion: '完成规则', completionGraph: '自定义完成图', authorNotes: '作者备注', tags: '标签', visibility: '可见性条件', acceptance: '可承接条件', abandonable: '可放弃', autoStartWhenAcceptable: '可承接时自动开始', repeat: '周期', rewardKits: '完成奖励', name: '标题键', description: '描述键' })[target.field]
  return target.kind === 'goal-config' ? `目标参数 · ${target.key}` : target.kind === 'goal-order' ? '目标顺序' : '目标'
}

type Props = {
  detached?:boolean; client: ProjectClient; path: string; name: string; source: string; locale: string; goalCatalog: GoalDefinitionCatalog
  kitOptions: { ref: string; label: string; key?: string }[]; disabled: boolean
  initialSeeds?: Record<string, string>; onCreated?: () => void
  onOpenKit?: (documentKey: string) => void
}
export function ProgressCollaborativeEditor(props: Props) {
  const [created, setCreated] = useState(Boolean(props.client.entry(props.path)))
  if (!created && !props.client.entry(props.path) && !props.detached && !progressEditorSession(props.client,props.path)) return <ProgressCreateDocument {...props} onCreated={() => { props.onCreated?.(); setCreated(true) }} />
  return <ProgressLiveEditor {...props} />
}
function ProgressCreateDocument({ client, path, name, source, locale, initialSeeds, onCreated, disabled }: Props) {
  const [error, setError] = useState('')
  const started = useRef(false)
  useEffect(() => {
    if (started.current || disabled || !client.writable) return
    started.current = true
    const edits = [{ op: 'write' as const, path, data: source, version: null }, ...(initialSeeds ? [{ op: 'write' as const, path: textAssetPath(locale, name), data: JSON.stringify(initialSeeds, null, 2) + '\n', version: null }] : [])]
    void client.apply(edits, '创建进度').then(() => onCreated?.()).catch(error => setError(String(error)))
  }, [client, disabled, initialSeeds, locale, name, onCreated, path, source])
  useSyncExternalStore(client.transactions.subscribe, client.transactions.getSnapshot)
  useEffect(() => { if (client.entry(path)) onCreated?.() }, [client, client.tree.revision, onCreated, path])
  return <div className="progress-autosave-error" role="status">{error || (disabled ? '请使用有编辑权限的连接创建进度。' : '正在创建进度及当前语言…')}{error && <p>原文件和输入已保留，请在保存状态中重试原提交。</p>}</div>
}
function ProgressLiveEditor({ client, path, name, source, locale, goalCatalog, kitOptions, disabled, onOpenKit }: Props) {
  const record = getProgressEditor(client, path, name, source, locale)
  const session = record.session
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const transactions = useSyncExternalStore(client.transactions.subscribe, client.transactions.getSnapshot)
  const [error, setError] = useState('')
  async function run(action: () => Promise<void>) { setError(''); try { await action() } catch (error) { setError(error instanceof Error ? error.message : String(error)) } }
  useEffect(() => {
    void record.start().catch(error => setError(String(error)))
  }, [record, session])
  useEffect(() => {
    if (!state.ready) return
    void session.refresh().catch(error => setError(String(error)))
  }, [client.remoteEpoch, source, locale, session, state.ready])
  const active = state.active && transactions.transactions.find(item => item.id === state.active!.id)
  const knownFailure = state.active && !state.saving && active && ['failed', 'conflict'].includes(active.phase)
  let doc
  try { doc = parseProgress(state.view.source) } catch (error) { return <p role="alert">{String(error)}</p> }
  return <div className="progress-collaborative-editor">
    <div className="progress-autosave-bar" aria-label="进度自动保存">
      <span role="status">{state.location==='changing'?'正在更新资源位置…':state.location==='missing'?'资源已移除 · 草稿保留':!state.ready ? '正在读取进度…' : state.resolving ? '正在处理冲突…' : state.saving ? '正在保存…' : state.error ? '自动保存已暂停 · 草稿保留' : state.dirty ? '等待保存…' : '修改已保存'}</span>
      <button type="button" title="包含当前源文件、语言文本、原始前提与未完成提交" onClick={() => downloadFlowFile(`${name}.draft.json`, JSON.stringify({ ...session.backup(), projectId: client.snapshot.projectId, path }, null, 2) + '\n')}>导出草稿</button>
      <button type="button" disabled={disabled || state.location!=='ready' || !state.ready || state.replaced || state.resolving || state.saving || !!state.active || !state.canUndo} onClick={() => void run(() => session.undo())}>撤销</button>
      <button type="button" disabled={disabled || state.location!=='ready' || !state.ready || state.replaced || state.resolving || state.saving || !!state.active || !state.canRedo} onClick={() => void run(() => session.undo(true))}>重做</button>
    </div>
    {(state.error || error) && <div className="progress-autosave-error" role="alert">
      <p>{error || state.error}</p>
      {state.replaced && <button type="button" disabled={!client.online || state.resolving || state.saving || !!(active && !['saved', 'failed', 'conflict'].includes(active.phase))} onClick={() => void run(() => session.openReplacement())}>{state.dirty ? '舍弃本地草稿并打开替换后的进度' : '打开替换后的进度'}</button>}
      {knownFailure && !state.replaced && <>
        <p>后续输入仍留在本窗口。重新提交只处理本次修改的字段。</p>
        {!!state.conflicts.length && <ul>{state.conflicts.map((effect, i) => <li key={i}><strong>{fieldName(effect)}</strong><span>服务器：{progressSlot(state.server, effect.target).present ? JSON.stringify(progressSlot(state.server, effect.target).value) : '未填写'}</span><span>原值：{effect.expected.present ? JSON.stringify(effect.expected.value) : '未填写'}</span><span>我的修改：{effect.value.present ? JSON.stringify(effect.value.value) : '清除'}</span></li>)}</ul>}
        <div className="progress-autosave-actions">{state.active?.mode === 'edit' ? <><button type="button" disabled={disabled || state.resolving} onClick={() => void run(() => session.resolveFailure(true))}>保留我的修改并重试</button><button type="button" disabled={!client.online || state.resolving} onClick={() => void run(() => session.resolveFailure(false))}>采用服务器版本</button></> : <button type="button" disabled={!client.online || state.resolving} onClick={() => void run(() => session.resolveFailure(false))}>取消本次{state.active?.mode === 'redo' ? '重做' : '撤销'}</button>}</div>
      </>}
      {!state.ready && <button type="button" onClick={() => void run(() => session.initialize())}>重新加载进度</button>}
    </div>}
    <ProgressEditor doc={doc} goalCatalog={goalCatalog} kitOptions={kitOptions} disabled={disabled || state.location!=='ready' || !state.ready || state.replaced || state.resolving}
      locale={locale}
      resolveText={key => state.view.languages[locale]?.[key] ?? ''}
      setText={(key, value) => session.editText(locale, key, value)}
      onChange={(source, immediate) => session.editSource(source, immediate)}
      onFlush={() => session.finishText()} onComposition={active => session.composition(active)}
      onOpenKit={onOpenKit} />
  </div>
}
