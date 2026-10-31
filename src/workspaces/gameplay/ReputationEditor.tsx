import { useState } from 'react'
import { Panel, RemoveButton } from './KitEditor'
import { JsonRepairPane, PendingBanner, RefBadge, SheetField, SheetToggle, errorText, useSheetDraft } from './SheetParts'
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
/** Client bar keeps a small inset at both ends; ratios map into the inner 88%. */
const barPercent = (ratio: number) => (0.06 + ratio * 0.88) * 100

async function fileToBanner(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (const byte of buffer) binary += String.fromCharCode(byte)
  return validateReputationBanner(btoa(binary))
}

/** Accept raw Base64 or `data:image/png;base64,...` paste. */
function pasteToBanner(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, '')
  const payload = trimmed.replace(/^data:image\/png;base64,/i, '')
  if (!payload) throw new Error('请粘贴 PNG 的 Base64 文本')
  return validateReputationBanner(payload)
}

const bannerBytes = (base64: string) => Math.floor(base64.length * 3 / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0)
const readInt = (raw: string) => raw.trim() === '' ? Number.NaN : Number(raw)
const shownInt = (value: number) => Number.isFinite(value) ? value : ''

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
  const [repairing, setRepairing] = useState(false)
  const [bannerError, setBannerError] = useState('')
  const [bannerPaste, setBannerPaste] = useState('')
  const [pasteOpen, setPasteOpen] = useState(false)
  const [previewOverride, setPreviewOverride] = useState<number | null>(null)
  const { pending, commit, discard } = useSheetDraft(source, disabled, parseReputation, stringifyReputation, onChange)
  let parsed: ReputationDocument = createReputation(), error = ''
  try { parsed = parseReputation(source) } catch (cause) { error = errorText(cause) }
  if (error || repairing) return <JsonRepairPane
    key={error ? 'invalid' : 'manual'}
    title="声誉阵营"
    label="声誉阵营 JSON"
    source={source}
    error={error}
    disabled={disabled}
    apply={text => { onChange(stringifyReputation(parseReputation(text))); setRepairing(false) }}
    onCancel={error ? undefined : () => setRepairing(false)}
  />

  const doc = pending?.doc ?? parsed
  const update = (patch: Partial<ReputationDocument>) => commit({ ...doc, ...patch })
  const textEditable = !disabled && !!setText
  const thresholdsInverted = doc.neutralPoints > doc.friendlyPoints
  const thresholdsEqual = doc.neutralPoints === doc.friendlyPoints
  const scale = Number.isFinite(doc.neutralPoints) && Number.isFinite(doc.friendlyPoints) && !thresholdsInverted ? doc : parsed
  const defaultPoints = Number.isFinite(doc.defaultPoints) ? doc.defaultPoints : parsed.defaultPoints
  const previewPoints = previewOverride ?? defaultPoints
  const standing = reputationStanding(scale, previewPoints)
  const fill = barPercent(reputationBarRatio(scale, previewPoints))
  const defaultMark = barPercent(reputationBarRatio(scale, defaultPoints))
  const outer = Math.max(1, Math.trunc((scale.friendlyPoints - scale.neutralPoints) / 2))
  const availableFactions = factionOptions.filter(option => !doc.hostile.includes(option.ref))

  const pointField = (key: 'defaultPoints' | 'neutralPoints' | 'friendlyPoints', label: string, hint: string) => {
    const invalid = !Number.isInteger(doc[key]) || (key !== 'defaultPoints' && thresholdsInverted)
    return <SheetField label={label} hint={hint} invalid={invalid} className={`rep-point is-${key}`}>
      <input aria-label={label} type="number" step="1" aria-invalid={invalid} disabled={disabled} value={shownInt(doc[key])} onChange={e => update({ [key]: readInt(e.target.value) })} />
    </SheetField>
  }

  return <div className="flow-kit-pane sheet-editor rep-editor" aria-label="声誉阵营编辑器"><div className="kit-editor"><div className="kit-page sheet-page">
    <header className="kit-header sheet-header rep-header">
      <label className="kit-name-field">
        <span className="kit-name-label" title="写入 lang_rep，不写进 .rep">显示名</span>
        <input className="kit-title" aria-label="阵营显示名" placeholder="未命名阵营" disabled={!textEditable} value={resolveText?.('name') ?? ''} onChange={e => setText?.('name', e.target.value)} />
      </label>
      <div className="sheet-header-actions">
        <span className={`rep-standing-pill is-${standing}`} title="按预览点数计算">{STANDING_LABEL[standing]}</span>
        <span className="sheet-kind">.rep</span>
        <button type="button" className="sheet-btn is-quiet" disabled={disabled} onClick={() => { discard(); setRepairing(true) }}>编辑 JSON</button>
      </div>
    </header>
    <SheetField label="描述" className="rep-description" hint={setText ? '显示名与描述写入 lang_rep；阵营 ID 使用文件名。' : '聚焦此文件后可编辑本地化文本。'}>
      <textarea aria-label="阵营描述" disabled={!textEditable} value={resolveText?.('description') ?? ''} placeholder="玩家声誉页中显示的阵营介绍" onChange={e => setText?.('description', e.target.value)} rows={2} />
    </SheetField>
    {pending && <PendingBanner issue={pending.issue} onDiscard={discard} />}

    <Panel title="点数与阈值" subtitle="点数 < 中立阈值为敌对，≥ 友好阈值为友好" className="rep-points">
      <div className="sheet-panel-body">
        <div className="rep-point-grid">
          {pointField('defaultPoints', '默认点数', '玩家首次接触时的点数')}
          {pointField('neutralPoints', '中立阈值', '达到即脱离敌对')}
          {pointField('friendlyPoints', '友好阈值', '达到即转为友好')}
        </div>
        {thresholdsInverted && <p className="kit-banner" role="alert">中立阈值（neutralPoints）不能大于友好阈值（friendlyPoints），修正前不会保存。</p>}
        {!thresholdsInverted && thresholdsEqual && <p className="rep-warning" role="alert">中立与友好阈值相同：站位会从敌对直接跳到友好，没有中立区间。</p>}

        <div className="rep-preview">
          <div className="rep-preview-head">
            <span className="rep-preview-title">站位预览</span>
            <label className="rep-preview-points">
              <span>预览点数</span>
              <input aria-label="预览点数" type="number" step="1" value={previewPoints} onChange={e => { const n = readInt(e.target.value); setPreviewOverride(Number.isFinite(n) ? n : null) }} />
            </label>
            <input className="rep-preview-range" type="range" aria-hidden tabIndex={-1}
              min={thresholdsEqual ? scale.neutralPoints - 10 : scale.neutralPoints - outer}
              max={thresholdsEqual ? scale.friendlyPoints + 10 : scale.friendlyPoints + outer}
              value={previewPoints} onChange={e => setPreviewOverride(Number(e.target.value))} />
            <button type="button" className="sheet-btn is-quiet" disabled={previewOverride === null} onClick={() => setPreviewOverride(null)}>回到默认点数</button>
          </div>
          <div className="rep-bar" role="img" aria-label="好感条预览" title={`${previewPoints} · ${STANDING_LABEL[standing]}`}>
            <span className="rep-bar-zone is-hostile" style={{ left: 0, width: `${barPercent(0.25)}%` }} />
            <span className="rep-bar-zone is-neutral" style={{ left: `${barPercent(0.25)}%`, width: `${barPercent(0.75) - barPercent(0.25)}%` }} />
            <span className="rep-bar-zone is-friendly" style={{ left: `${barPercent(0.75)}%`, right: 0 }} />
            <span className={`rep-bar-fill is-${standing}`} style={{ width: `${fill}%` }} />
            <span className="rep-bar-mark" style={{ left: `${barPercent(0.25)}%` }} />
            <span className="rep-bar-mark" style={{ left: `${barPercent(0.75)}%` }} />
            <span className="rep-bar-default" style={{ left: `${defaultMark}%` }} title={`默认 ${defaultPoints}`} />
          </div>
          <div className="rep-bar-scale" aria-hidden>
            {!thresholdsEqual && <span style={{ left: `${barPercent(0)}%` }}>≤{scale.neutralPoints - outer}</span>}
            <span className="is-neutral" style={{ left: `${barPercent(0.25)}%` }}>中立 {scale.neutralPoints}</span>
            <span className="is-friendly" style={{ left: `${barPercent(0.75)}%` }}>友好 {scale.friendlyPoints}</span>
            {!thresholdsEqual && <span style={{ left: `${barPercent(1)}%` }}>≥{scale.friendlyPoints + outer}</span>}
          </div>
          <p className="rep-preview-result">{previewPoints} 点 → <b className={`is-${standing}`}>{STANDING_LABEL[standing]}</b><small>（{standing}）</small><span>▾ 为默认点数</span></p>
        </div>
      </div>
    </Panel>

    <div className="sheet-columns">
      <Panel title="单向敌对" subtitle="需要互敌时两边都声明" count={doc.hostile.length} className="rep-hostile"
        action={<select className="sheet-select rep-add-select" aria-label="添加敌对阵营" value="" disabled={disabled} onChange={e => {
          if (!e.target.value || doc.hostile.includes(e.target.value)) return
          update({ hostile: [...doc.hostile, e.target.value] })
        }}>
          <option value="">{availableFactions.length ? '+ 添加阵营…' : factionOptions.length ? '已全部添加' : '没有其他阵营'}</option>
          {availableFactions.map(option => <option key={option.ref} value={option.ref}>{option.label}</option>)}
        </select>}>
        {doc.hostile.length === 0
          ? <p className="kit-empty">不主动敌视任何阵营</p>
          : <ul className="rep-chips">
            {doc.hostile.map(id => {
              const missing = !factionOptions.some(item => item.ref === id)
              return <li key={id} className={`rep-chip${missing ? ' is-missing' : ''}`}>
                <code>{id}</code>
                <RefBadge missing={missing} />
                <RemoveButton label={`移除敌对 ${id}`} disabled={disabled} onClick={() => update({ hostile: doc.hostile.filter(item => item !== id) })} />
              </li>
            })}
          </ul>}
      </Panel>
      <Panel title="行为" className="rep-flags">
        <div className="sheet-panel-body">
          <SheetToggle label="隐藏阵营" hint="不出现在玩家声誉页" checked={doc.hidden} disabled={disabled} onChange={hidden => update({ hidden })} />
          <SheetToggle label="吸引敌对生物" hint="附近无目标的敌对生物会攻击本阵营成员" checked={doc.attackedByMobs} disabled={disabled} onChange={attackedByMobs => update({ attackedByMobs })} />
        </div>
      </Panel>
    </div>

    <Panel title="旗帜" subtitle="可选 · 竖旗 PNG（游戏内 ≤24×40）" className="rep-banner">
      <div className="rep-media">
        <div className={`rep-media-frame${doc.banner ? '' : ' is-empty'}`}>
          {doc.banner ? <img alt="阵营旗帜预览" src={`data:image/png;base64,${doc.banner}`} /> : <span>竖旗预览<br />24×40</span>}
        </div>
        <div className="rep-media-info">
          <p className="sheet-note">游戏声誉页以<strong>竖旗</strong>展示（最长边缩进 ≤24×40，保持像素比）；任意分辨率 PNG 均可，解码后不超过 256 KiB。{doc.banner && <> 当前 <b>{(bannerBytes(doc.banner) / 1024).toFixed(1)} KiB</b>。</>}</p>
          {bannerError && <p className="kit-banner" role="alert">{bannerError}</p>}
          <div className="rep-media-actions">
            <label className={`sheet-btn rep-upload${disabled ? ' is-disabled' : ''}`}>
              <input aria-label="上传阵营旗帜" type="file" accept="image/png" disabled={disabled} onChange={async e => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (!file) return
                try {
                  setBannerError('')
                  setBannerPaste('')
                  update({ banner: await fileToBanner(file) })
                } catch (cause) {
                  setBannerError(errorText(cause))
                }
              }} />
              {doc.banner ? '替换 PNG' : '上传 PNG'}
            </label>
            <button type="button" className="sheet-btn is-quiet" disabled={disabled} aria-expanded={pasteOpen} onClick={() => { setPasteOpen(open => !open); setBannerError('') }}>
              {pasteOpen ? '收起 Base64' : '粘贴 Base64'}
            </button>
            <button type="button" className="sheet-btn is-quiet" disabled={disabled || !doc.banner} onClick={() => { setBannerError(''); setBannerPaste(''); update({ banner: null }) }}>清除旗帜</button>
          </div>
          {pasteOpen && <div className="rep-banner-paste">
            <SheetField label="Base64" hint="可粘贴纯 Base64，或 data:image/png;base64,…">
              <textarea aria-label="阵营旗帜 Base64" disabled={disabled} value={bannerPaste} rows={4} placeholder="iVBORw0KGgo…" spellCheck={false} onChange={e => { setBannerPaste(e.target.value); setBannerError('') }} />
            </SheetField>
            <div className="rep-media-actions">
              <button type="button" className="sheet-btn" disabled={disabled || !bannerPaste.trim()} onClick={() => {
                try {
                  const next = pasteToBanner(bannerPaste)
                  setBannerError('')
                  setBannerPaste('')
                  setPasteOpen(false)
                  update({ banner: next })
                } catch (cause) {
                  setBannerError(errorText(cause))
                }
              }}>应用 Base64</button>
              <button type="button" className="sheet-btn is-quiet" disabled={disabled || !bannerPaste} onClick={() => setBannerPaste('')}>清空输入</button>
            </div>
          </div>}
        </div>
      </div>
    </Panel>
  </div></div></div>
}
