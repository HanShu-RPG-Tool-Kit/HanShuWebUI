import { useEffect, useState } from 'react'
import { Panel, RemoveButton } from './KitEditor'
import { JsonRepairPane, PendingBanner, RefBadge, SheetField, SheetToggle, errorText, useSheetDraft } from './SheetParts'
import {
  createReputation,
  parseReputation,
  stringifyReputation,
  validateReputationBanner,
  type ReputationDocument,
} from './reputation'
import './ReputationEditor.css'

type RefOption = { ref: string; label: string }

/** In-game slot from ReputationStandingScreen. */
const BANNER_MAX_W = 24
const BANNER_MAX_H = 40
/** Editor-only integer zoom so the tiny in-game size stays readable. */
const BANNER_PREVIEW_ZOOM = 4

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

/** Same fit rule as the Mod client: shrink freely, enlarge only by integer scale. */
function gameBannerSize(naturalW: number, naturalH: number): { width: number; height: number; scale: number } {
  let scale = Math.min(BANNER_MAX_W / naturalW, BANNER_MAX_H / naturalH)
  if (scale >= 1) scale = Math.floor(scale)
  return {
    scale,
    width: Math.max(1, Math.round(naturalW * scale)),
    height: Math.max(1, Math.round(naturalH * scale)),
  }
}

function BannerPreview({ banner }: { banner: string }) {
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  useEffect(() => {
    let cancelled = false
    const image = new Image()
    image.onload = () => {
      if (!cancelled) setNatural({ w: image.naturalWidth, h: image.naturalHeight })
    }
    image.onerror = () => {
      if (!cancelled) setNatural(null)
    }
    image.src = `data:image/png;base64,${banner}`
    return () => { cancelled = true }
  }, [banner])
  const fitted = natural ? gameBannerSize(natural.w, natural.h) : null
  return <div className="rep-media-frame">
    {fitted
      ? <img
          alt="阵营旗帜预览"
          src={`data:image/png;base64,${banner}`}
          width={fitted.width * BANNER_PREVIEW_ZOOM}
          height={fitted.height * BANNER_PREVIEW_ZOOM}
          style={{ width: fitted.width * BANNER_PREVIEW_ZOOM, height: fitted.height * BANNER_PREVIEW_ZOOM }}
        />
      : <span>加载中…</span>}
    {natural && fitted && <span className="rep-media-meta">{natural.w}×{natural.h} → 游戏 {fitted.width}×{fitted.height}</span>}
  </div>
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
        <span className="sheet-kind">.rep</span>
        <button type="button" className="sheet-btn is-quiet" disabled={disabled} onClick={() => { discard(); setRepairing(true) }}>编辑 JSON</button>
      </div>
    </header>
    <SheetField label="描述" className="rep-description" hint={setText ? '显示名与描述写入 lang_rep；阵营 ID 使用文件名。' : '聚焦此文件后可编辑本地化文本。'}>
      <textarea aria-label="阵营描述" disabled={!textEditable} value={resolveText?.('description') ?? ''} placeholder="玩家声誉页中显示的阵营介绍" onChange={e => setText?.('description', e.target.value)} rows={10} />
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
        {doc.banner
          ? <BannerPreview banner={doc.banner} />
          : <div className="rep-media-frame is-empty"><span>竖旗<br />≤24×40</span></div>}
        <div className="rep-media-info">
          <p className="sheet-note">预览按游戏同款缩放：缩进 ≤24×40，放大只取整数倍；此处再 ×{BANNER_PREVIEW_ZOOM} 方便查看。解码后不超过 256 KiB。{doc.banner && <> 当前 <b>{(bannerBytes(doc.banner) / 1024).toFixed(1)} KiB</b>。</>}</p>
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
