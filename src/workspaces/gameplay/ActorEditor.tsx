import { useState } from 'react'
import { KitTagField } from './KitEditor'
import { createActor, parseActor, stringifyActor, type ActorDocument } from './actor'

type ScriptOption = { ref: string; label: string; key?: string }
export function ActorEditor({ source, disabled, onChange, scriptOptions, onOpenScript }: {
  source: string; disabled: boolean; onChange(source: string): void
  scriptOptions: ScriptOption[]; onOpenScript(key: string): void
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
  return <div className="flow-kit-pane" aria-label="演员模板编辑器">
    <h2>演员模板</h2>
    <p className="flow-hint">模板 ID 使用文件名。脚本按列表顺序执行，共享同一实例黑板；重新绑定或重载会重建会话。</p>
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
    <button disabled={disabled} onClick={() => setRepair(source)}>编辑 JSON</button>
  </div>
}
