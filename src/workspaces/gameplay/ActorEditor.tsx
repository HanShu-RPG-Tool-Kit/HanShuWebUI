import { useState } from 'react'
import { KitTagField } from './KitEditor'
import {
  createActor,
  parseActor,
  stringifyActor,
  type ActorDialogueCondition,
  type ActorDialogueEntry,
  type ActorDocument,
  type ActorInteractService,
} from './actor'

type RefOption = { ref: string; label: string; key?: string }

function nextCondition(kind: ActorDialogueCondition['kind']): ActorDialogueCondition {
  return kind === 'always' ? { kind: 'always' } : { kind, inject: '' }
}

export function ActorEditor({
  source, disabled, onChange, scriptOptions, reputationOptions = [], shopOptions = [], injectOptions = [], onOpenScript,
}: {
  source: string
  disabled: boolean
  onChange(source: string): void
  scriptOptions: RefOption[]
  reputationOptions?: RefOption[]
  shopOptions?: RefOption[]
  injectOptions?: RefOption[]
  onOpenScript(key: string): void
}) {
  const [repair, setRepair] = useState<string | null>(null)
  const [repairError, setRepairError] = useState('')
  let doc: ActorDocument = createActor(), error = ''
  try { doc = parseActor(source) } catch (cause) { error = String(cause) }
  const update = (next: ActorDocument) => { if (!disabled) onChange(stringifyActor(next)) }
  if (error || repair !== null) return <div className="flow-kit-pane">
    <p role="alert">{repairError || error || '编辑演员模板 JSON'}</p>
    <textarea aria-label="演员模板 JSON" disabled={disabled} value={repair ?? source} onChange={e => { setRepair(e.target.value); setRepairError('') }} rows={18} />
    <button disabled={disabled} onClick={() => { try { onChange(stringifyActor(parseActor(repair ?? source))); setRepair(null) } catch (cause) { setRepairError(String(cause)) } }}>应用 JSON</button>
  </div>

  const move = (index: number, delta: number) => {
    const scripts = [...doc.scripts], target = index + delta
    ;[scripts[index], scripts[target]] = [scripts[target], scripts[index]]
    update({ ...doc, scripts })
  }
  const display = doc.display ?? null
  const dialogue = doc.dialogue ?? null
  const service = doc.interactService ?? null
  const setDisplay = (next: ActorDocument['display']) => update({ ...doc, display: next })
  const setDialogue = (next: ActorDocument['dialogue']) => update({ ...doc, dialogue: next })
  const setService = (next: ActorDocument['interactService']) => update({ ...doc, interactService: next })
  const setEntries = (entries: ActorDialogueEntry[]) => {
    if (!dialogue) return
    setDialogue({ ...dialogue, entries })
  }
  const moveEntry = (index: number, delta: number) => {
    if (!dialogue) return
    const entries = [...dialogue.entries], target = index + delta
    ;[entries[index], entries[target]] = [entries[target], entries[index]]
    setEntries(entries)
  }
  const patchEntry = (index: number, patch: Partial<ActorDialogueEntry>) => {
    if (!dialogue) return
    setEntries(dialogue.entries.map((entry, i) => i === index ? { ...entry, ...patch } : entry))
  }
  const patchCondition = (entryIndex: number, conditionIndex: number, next: ActorDialogueCondition) => {
    if (!dialogue) return
    const entries = dialogue.entries.map((entry, i) => {
      if (i !== entryIndex) return entry
      const when = entry.when.map((condition, j) => j === conditionIndex ? next : condition)
      return { ...entry, when }
    })
    setEntries(entries)
  }
  const changeServiceType = (type: ActorInteractService['type']) => {
    setService(type === 'shop' ? { type: 'shop', param: { template: '' } } : { type: 'vault', param: {} })
  }

  return <div className="flow-kit-pane" aria-label="演员模板编辑器">
    <h2>演员模板</h2>
    <p className="flow-hint">模板 ID 使用文件名。脚本按列表顺序执行，共享同一实例黑板；重新绑定或重载会重建会话。有脚本时在会话 init 写入名牌与声誉成员，无脚本时在绑定时写入；解绑不会回滚这两项。</p>
    <label><input type="checkbox" checked={doc.freezeAi} disabled={disabled} onChange={e => update({ ...doc, freezeAi: e.target.checked })} />软冻结原版 AI（保留导航与控制）</label>
    <KitTagField label="演员标签" tags={doc.tags} disabled={disabled} onChange={tags => update({ ...doc, tags })} />

    <h3>演员脚本（有序）</h3>
    {doc.scripts.map((id, index) => {
      const option = scriptOptions.find(s => s.ref === id)
      return <div key={id}>
        <span>{index + 1}. {id}{!option && '（引用缺失）'}</span>
        {option?.key && <button onClick={() => onOpenScript(option.key!)}>打开脚本</button>}
        <button aria-label={`上移 ${id}`} disabled={disabled || index === 0} onClick={() => move(index, -1)}>↑</button>
        <button aria-label={`下移 ${id}`} disabled={disabled || index === doc.scripts.length - 1} onClick={() => move(index, 1)}>↓</button>
        <button aria-label={`移除 ${id}`} disabled={disabled} onClick={() => update({ ...doc, scripts: doc.scripts.filter(s => s !== id) })}>移除</button>
      </div>
    })}
    <select aria-label="添加演员脚本" value="" disabled={disabled} onChange={e => { if (e.target.value) update({ ...doc, scripts: [...doc.scripts, e.target.value] }) }}>
      <option value="">选择演员脚本…</option>
      {scriptOptions.filter(s => !doc.scripts.includes(s.ref)).map(s => <option key={s.ref} value={s.ref}>{s.label}</option>)}
    </select>

    <h3>显示名牌</h3>
    <p className="flow-hint">启用后整板写入；两行皆空会清除名牌。未启用不改名牌。支持魔杖兼容的 &amp; 颜色码。Boss 血条请用脚本 api.bossBar()，不要写进模板。</p>
    <label><input type="checkbox" aria-label="启用显示名牌" checked={display != null} disabled={disabled} onChange={e => setDisplay(e.target.checked ? { title: '', subtitle: '' } : null)} />启用显示名牌</label>
    {display && <>
      <label>主标题<input aria-label="名牌主标题" disabled={disabled} value={display.title} onChange={e => setDisplay({ ...display, title: e.target.value })} /></label>
      <label>副标题<input aria-label="名牌副标题" disabled={disabled} value={display.subtitle} onChange={e => setDisplay({ ...display, subtitle: e.target.value })} /></label>
    </>}

    <h3>声誉成员</h3>
    <p className="flow-hint">绑定时写入实体声誉成员关系；解绑不会清除。阵营 ID 对应 reputations/&lt;id&gt;.rep。</p>
    <label>阵营
      <select aria-label="声誉阵营" disabled={disabled} value={doc.reputation ?? ''} onChange={e => update({ ...doc, reputation: e.target.value || null })}>
        <option value="">不设置</option>
        {reputationOptions.map(option => <option key={option.ref} value={option.ref}>{option.label}</option>)}
        {doc.reputation && !reputationOptions.some(option => option.ref === doc.reputation) && <option value={doc.reputation}>{doc.reputation}（引用缺失）</option>}
      </select>
    </label>

    <h3>对话路由</h3>
    <p className="flow-hint">右键时在脚本 interact 之后匹配；首条 when 全满足的 entry 生效。条件为 AND；空 when 恒真。</p>
    <label><input type="checkbox" aria-label="启用对话路由" checked={dialogue != null} disabled={disabled} onChange={e => setDialogue(e.target.checked ? { talkId: '', playerRole: '玩家', entries: [] } : null)} />启用对话路由</label>
    {dialogue && <>
      <label>角色 ID<input aria-label="对话角色 ID" disabled={disabled} value={dialogue.talkId} onChange={e => setDialogue({ ...dialogue, talkId: e.target.value })} /></label>
      <label>玩家角色 ID<input aria-label="对话玩家角色 ID" disabled={disabled} value={dialogue.playerRole} onChange={e => setDialogue({ ...dialogue, playerRole: e.target.value })} /></label>
      {dialogue.entries.map((entry, entryIndex) => <div key={entryIndex} className="actor-dialogue-entry">
        <div>
          <strong>条目 {entryIndex + 1}</strong>
          <button aria-label={`上移对话条目 ${entryIndex + 1}`} disabled={disabled || entryIndex === 0} onClick={() => moveEntry(entryIndex, -1)}>↑</button>
          <button aria-label={`下移对话条目 ${entryIndex + 1}`} disabled={disabled || entryIndex === dialogue.entries.length - 1} onClick={() => moveEntry(entryIndex, 1)}>↓</button>
          <button aria-label={`移除对话条目 ${entryIndex + 1}`} disabled={disabled} onClick={() => setEntries(dialogue.entries.filter((_, i) => i !== entryIndex))}>移除</button>
        </div>
        <label>注入点
          <select aria-label={`对话条目 ${entryIndex + 1} 注入点`} disabled={disabled} value={entry.inject} onChange={e => patchEntry(entryIndex, { inject: e.target.value })}>
            <option value="">选择 @inject…</option>
            {injectOptions.map(option => <option key={option.ref} value={option.ref}>{option.label}</option>)}
            {entry.inject && !injectOptions.some(option => option.ref === entry.inject) && <option value={entry.inject}>{entry.inject}（未索引）</option>}
          </select>
        </label>
        <div>
          <span>条件</span>
          <button disabled={disabled} onClick={() => patchEntry(entryIndex, { when: [...entry.when, { kind: 'always' }] })}>添加条件</button>
        </div>
        {entry.when.map((condition, conditionIndex) => <div key={conditionIndex}>
          <select aria-label={`对话条目 ${entryIndex + 1} 条件 ${conditionIndex + 1} 类型`} disabled={disabled} value={condition.kind} onChange={e => patchCondition(entryIndex, conditionIndex, nextCondition(e.target.value as ActorDialogueCondition['kind']))}>
            <option value="always">always</option>
            <option value="talk_read">talk_read</option>
            <option value="talk_unread">talk_unread</option>
          </select>
          {condition.kind !== 'always' && <select aria-label={`对话条目 ${entryIndex + 1} 条件 ${conditionIndex + 1} 注入点`} disabled={disabled} value={condition.inject} onChange={e => patchCondition(entryIndex, conditionIndex, { kind: condition.kind, inject: e.target.value })}>
            <option value="">选择 @inject…</option>
            {injectOptions.map(option => <option key={option.ref} value={option.ref}>{option.label}</option>)}
            {condition.inject && !injectOptions.some(option => option.ref === condition.inject) && <option value={condition.inject}>{condition.inject}（未索引）</option>}
          </select>}
          <button aria-label={`移除对话条目 ${entryIndex + 1} 条件 ${conditionIndex + 1}`} disabled={disabled} onClick={() => patchEntry(entryIndex, { when: entry.when.filter((_, i) => i !== conditionIndex) })}>移除条件</button>
        </div>)}
      </div>)}
      <button disabled={disabled} onClick={() => setEntries([...dialogue.entries, { when: [], inject: '' }])}>添加对话条目</button>
    </>}

    <h3>交互服务</h3>
    <p className="flow-hint">对话未命中后打开商店或本地仓库。商店仅支持无限库存模板；有限库存请用脚本打开。</p>
    <label><input type="checkbox" aria-label="启用交互服务" checked={service != null} disabled={disabled} onChange={e => setService(e.target.checked ? { type: 'shop', param: { template: '' } } : null)} />启用交互服务</label>
    {service && <>
      <label>类型
        <select aria-label="交互服务类型" disabled={disabled} value={service.type} onChange={e => changeServiceType(e.target.value as ActorInteractService['type'])}>
          <option value="shop">商店</option>
          <option value="vault">本地仓库</option>
        </select>
      </label>
      {service.type === 'shop' && <label>商店模板
        <select aria-label="商店模板" disabled={disabled} value={service.param.template} onChange={e => setService({ type: 'shop', param: { template: e.target.value } })}>
          <option value="">选择商店…</option>
          {shopOptions.map(option => <option key={option.ref} value={option.ref}>{option.label}</option>)}
          {service.param.template && !shopOptions.some(option => option.ref === service.param.template) && <option value={service.param.template}>{service.param.template}（引用缺失）</option>}
        </select>
      </label>}
    </>}

    <button disabled={disabled} onClick={() => setRepair(source)}>编辑 JSON</button>
  </div>
}
