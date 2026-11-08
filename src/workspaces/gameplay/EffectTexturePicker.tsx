import { useProjectSession } from '../../project/projectSession'

/** Pick namespaced project textures; game-pack IDs remain an explicit alternative. */
export function EffectTexturePicker({ label, value, disabled, onChange }: { label: string; value: string; disabled?: boolean; onChange: (value: string) => void }) {
  const session = useProjectSession()
  const ids = [...new Set(session.workspace.packages.flatMap(p=>p.assets.map(asset=>{
    const match=/^assets\/([a-z0-9_.-]+)\/(textures\/[a-z0-9_./-]+\.png)$/.exec(asset.path)
    return match?`${match[1]}:${match[2]}`:null
  }).filter((id):id is string=>!!id)))].sort()
  return <div className="effect-texture-picker">
    <select aria-label={`选择${label}`} disabled={disabled} value={ids.includes(value)?value:''} onChange={e=>{if(e.target.value)onChange(e.target.value)}}>
      <option value="">{ids.length?'从工程图片中选择':'工程中尚无可用贴图'}</option>
      {ids.map(id=><option key={id} value={id}>{id.split('/').pop()} · {id.split(':')[0]}</option>)}
    </select>
    <details><summary>使用游戏资源包中的贴图</summary><label>贴图资源 ID<input aria-label={label} value={value} disabled={disabled} onChange={e=>onChange(e.target.value)}/></label>
      <p className="region-field-hint">填写资源包提供的标识，例如 minecraft:textures/block/stone.png。工程图片放在 assets/命名空间/textures/ 下后可在上方选择。</p>
    </details>
  </div>
}
