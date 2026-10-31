import { useState } from 'react'
import {
  createReputation,
  parseReputation,
  reputationBarRatio,
  reputationStanding,
  stringifyReputation,
  validateReputationBanner,
  type ReputationDocument,
} from './reputation'
import './ReputationEditor.css'

type RefOption = { ref: string; label: string }

const STANDING_LABEL = { hostile: '敌对', neutral: '中立', friendly: '友好' } as const

async function fileToBanner(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (const byte of buffer) binary += String.fromCharCode(byte)
  return validateReputationBanner(btoa(binary))
}

export function ReputationEditor({
  source, disabled, onChange, factionOptions = [], resolveText, setText,
}: {
  source: string
  disabled: boolean
  onChange(source: string): void
  factionOptions?: RefOption[]
  resolveText?(key: string): string
  setText?(key: string, value: string): void
}) {
  const [repair, setRepair] = useState<string | null>(null)
  const [repairError, setRepairError] = useState('')
  const [bannerError, setBannerError] = useState('')
  const [previewPoints, setPreviewPoints] = useState(0)
  let doc: ReputationDocument = createReputation(), error = ''
  try { doc = parseReputation(source) } catch (cause) { error = String(cause) }
  const update = (next: ReputationDocument) => { if (!disabled) onChange(stringifyReputation(next)) }
  const ratio = reputationBarRatio(doc, previewPoints)
  const standing = reputationStanding(doc, previewPoints)
  const visual = 0.06 + ratio * 0.88

  if (error || repair !== null) return <div className="flow-kit-pane">
    <p role="alert">{repairError || error || '编辑声誉阵营 JSON'}</p>
    <textarea aria-label="声誉阵营 JSON" disabled={disabled} value={repair ?? source} onChange={e => { setRepair(e.target.value); setRepairError('') }} rows={18} />
    <button disabled={disabled} onClick={() => { try { onChange(stringifyReputation(parseReputation(repair ?? source))); setRepair(null) } catch (cause) { setRepairError(String(cause)) } }}>应用 JSON</button>
  </div>

  return <div className="flow-kit-pane" aria-label="声誉阵营编辑器">
    <h2>声誉阵营</h2>
    <p className="flow-hint">阵营 ID 使用文件名。显示名与描述走 lang_rep，不写进 .rep。敌对关系单向；需要互敌时两边都声明。解绑 Actor 不会自动清除成员关系。</p>

    <h3>本地化</h3>
    <label>显示名<input aria-label="阵营显示名" disabled={disabled || !setText} value={resolveText?.('name') ?? ''} onChange={e => setText?.('name', e.target.value)} /></label>
    <label>描述<textarea aria-label="阵营描述" disabled={disabled || !setText} value={resolveText?.('description') ?? ''} onChange={e => setText?.('description', e.target.value)} rows={3} /></label>

    <h3>点数与阈值</h3>
    <label>默认点数<input aria-label="默认点数" type="number" disabled={disabled} value={doc.defaultPoints} onChange={e => update({ ...doc, defaultPoints: Number(e.target.value) })} /></label>
    <label>中立阈值<input aria-label="中立阈值" type="number" disabled={disabled} value={doc.neutralPoints} onChange={e => update({ ...doc, neutralPoints: Number(e.target.value) })} /></label>
    <label>友好阈值<input aria-label="友好阈值" type="number" disabled={disabled} value={doc.friendlyPoints} onChange={e => update({ ...doc, friendlyPoints: Number(e.target.value) })} /></label>
    {doc.neutralPoints > doc.friendlyPoints && <p role="alert">neutralPoints 不能大于 friendlyPoints</p>}
    {doc.neutralPoints === doc.friendlyPoints && <p className="flow-hint">中立与友好阈值相同：站位会从敌对直接跳到友好，没有中立区间。</p>}

    <h3>站位预览</h3>
    <label>预览点数<input aria-label="预览点数" type="number" value={previewPoints} onChange={e => setPreviewPoints(Number(e.target.value))} /></label>
    <p>当前站位：{STANDING_LABEL[standing]}（{standing}）</p>
    <div className="reputation-bar" aria-label="好感条预览" title={`${previewPoints}`}>
      <span className="reputation-bar-fill" style={{ width: `${visual * 100}%` }} />
      <span className="reputation-bar-mark is-neutral" style={{ left: '25%' }} title={`中立 ${doc.neutralPoints}`} />
      <span className="reputation-bar-mark is-friendly" style={{ left: '75%' }} title={`友好 ${doc.friendlyPoints}`} />
    </div>

    <h3>关系与行为</h3>
    <label><input type="checkbox" checked={doc.hidden} disabled={disabled} onChange={e => update({ ...doc, hidden: e.target.checked })} />隐藏（不出现在玩家声誉页）</label>
    <label><input type="checkbox" checked={doc.attackedByMobs} disabled={disabled} onChange={e => update({ ...doc, attackedByMobs: e.target.checked })} />吸引附近无目标敌对生物</label>
    <div>
      <span>单向敌对阵营</span>
      {doc.hostile.map(id => {
        const option = factionOptions.find(item => item.ref === id)
        return <div key={id}>
          <span>{id}{!option && '（引用缺失）'}</span>
          <button aria-label={`移除敌对 ${id}`} disabled={disabled} onClick={() => update({ ...doc, hostile: doc.hostile.filter(item => item !== id) })}>移除</button>
        </div>
      })}
      <select aria-label="添加敌对阵营" value="" disabled={disabled} onChange={e => {
        if (!e.target.value || doc.hostile.includes(e.target.value)) return
        update({ ...doc, hostile: [...doc.hostile, e.target.value] })
      }}>
        <option value="">选择阵营…</option>
        {factionOptions.filter(option => !doc.hostile.includes(option.ref)).map(option => <option key={option.ref} value={option.ref}>{option.label}</option>)}
      </select>
    </div>

    <h3>旗帜</h3>
    <p className="flow-hint">可选 Base64 PNG，解码后不超过 256 KiB。按 2:1 区域展示。</p>
    {bannerError && <p role="alert">{bannerError}</p>}
    {doc.banner ? <img alt="阵营旗帜预览" src={`data:image/png;base64,${doc.banner}`} style={{ maxWidth: 240, maxHeight: 120, objectFit: 'contain' }} /> : <p className="flow-hint">未设置旗帜</p>}
    <input aria-label="上传阵营旗帜" type="file" accept="image/png" disabled={disabled} onChange={async e => {
      const file = e.target.files?.[0]
      e.target.value = ''
      if (!file) return
      try {
        setBannerError('')
        update({ ...doc, banner: await fileToBanner(file) })
      } catch (cause) {
        setBannerError(String(cause))
      }
    }} />
    <button disabled={disabled || !doc.banner} onClick={() => update({ ...doc, banner: null })}>清除旗帜</button>

    <button disabled={disabled} onClick={() => setRepair(source)}>编辑 JSON</button>
  </div>
}
