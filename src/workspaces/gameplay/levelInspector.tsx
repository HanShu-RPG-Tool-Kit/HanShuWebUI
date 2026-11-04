import { useEffect, useRef, useState, type ComponentProps } from 'react'
import type { LevelArea, LevelCustomData, LevelDocument, LevelLandmark, LevelRegion, LevelY } from './levelDoc'
import {
  LANDMARK_FORM_KEYS,
  applyAreaDraft,
  applyPointDraft,
  areaShapeLabel,
  buildAreaDraft,
  buildDisplayDraft,
  buildPointDraft,
  deletePlan,
  planRename,
  type LevelDraftRecord,
} from './levelLayoutModel'
import { LevelCustomData as LevelCustomDataEditor } from './levelCustomData'
import { setLandmarkCustom, setRegionCustom } from './levelEdit'
import {
  NAV_DISPLAY_ICON,
  NAV_DISPLAY_MAX_DISTANCE,
  NAV_DISPLAY_MIN_DISTANCE,
  NAV_DISPLAY_NAME,
  NAV_LABEL_MAX,
} from './navigationPoint'
import type { LevelSelection } from './levelVolumeEdit'
import { RegionEffectsPanel } from './regionEffectsPanel'
import type { EffectResource } from './effectResources'
import type { EffectChannel, RegionEffectSections } from './regionEffects'
export type RegionInspectorView = { tab: 'geometry' | 'effects'; setTab: (tab: 'geometry' | 'effects') => void; channel: EffectChannel; setChannel: (channel: EffectChannel) => void }

export function LevelInspector(props: {
  shown: LevelDocument
  selection: LevelSelection
  disabled?: boolean
  onArea: (area: LevelArea) => void
  onY: (y: LevelY) => void
  onLandmarkParam: (param: { x: number; y: number; z: number }) => void
  onRegionCustom: (custom: LevelCustomData) => void
  onRegionEffects?: (effects: RegionEffectSections) => void
  onEffectAudition?: (effects: RegionEffectSections | null, audio: boolean, sources?: EffectResource[]) => Promise<void>
  resourceEpoch?: number
  effectsOnline?: boolean
  view?: RegionInspectorView
  onLandmarkCustom: (custom: LevelCustomData) => void
  onRenameRegion: (raw: string) => string | null
  onRenameLandmark: (raw: string) => string | null
  onDeleteVolume: () => void
  onDeleteRegion: () => void
  onDeleteLandmark: () => void
  onDraft: (id: string, draft: LevelDraftRecord | null) => void
  onRenameFollow?: (kind: 'region' | 'landmark', id: string) => void
  onDiscard: () => void
  pending?: boolean
}) {
  const region = props.selection?.kind === 'region'
    ? props.shown.regions.find((item) => item.id === props.selection?.id)
    : undefined
  const area = region && props.selection?.kind === 'region' ? region.areas[props.selection.area] : undefined
  const landmark = props.selection?.kind === 'landmark'
    ? props.shown.landmarks.find((item) => item.id === props.selection?.id)
    : undefined
  return (
    <div className="level-inspector-scroll">
      {props.disabled && props.pending && (
        <button type="button" className="level-discard" onClick={props.onDiscard}>放弃未写入草稿</button>
      )}
      {!area && !landmark && (
        <div className="level-empty">
          <p>未选中体积或地标。</p>
          <p>点左侧编号，或直接点视图里的形状。重叠的体积以树中的编号为准。</p>
        </div>
      )}
      {area && region && props.selection?.kind === 'region' && (
        <RegionPanel
          key={`${region.id}:${props.selection.area}:${area.kind}`}
          region={region}
          area={area}
          index={props.selection.area}
          disabled={props.disabled}
          onArea={props.onArea}
          onY={props.onY}
          onRename={props.onRenameRegion}
          onCustom={props.onRegionCustom}
          onEffects={props.onRegionEffects}
          onAudition={props.onEffectAudition}
          effectsOnline={props.effectsOnline}
          resourceEpoch={props.resourceEpoch}
          view={props.view}
          onDeleteVolume={props.onDeleteVolume}
          onDeleteRegion={props.onDeleteRegion}
          onDraft={props.onDraft}
          onApplied={(id) => props.onRenameFollow?.('region', id)}
        />
      )}
      {landmark && props.selection?.kind === 'landmark' && (
        <LandmarkPanel
          key={landmark.id}
          point={landmark}
          disabled={props.disabled}
          onParam={props.onLandmarkParam}
          onRename={props.onRenameLandmark}
          onCustom={props.onLandmarkCustom}
          onDelete={props.onDeleteLandmark}
          onDraft={props.onDraft}
          onApplied={(id) => props.onRenameFollow?.('landmark', id)}
        />
      )}
    </div>
  )
}

function RegionPanel({
  region, area, index, disabled, onArea, onY, onRename, onCustom, onEffects, onAudition, effectsOnline, resourceEpoch, view, onDeleteVolume, onDeleteRegion, onDraft, onApplied,
}: {
  region: LevelRegion
  area: LevelArea
  index: number
  disabled?: boolean
  onArea: (area: LevelArea) => void
  onY: (y: LevelY) => void
  onRename: (raw: string) => string | null
  onCustom: (custom: LevelCustomData) => void
  onEffects?: (effects: RegionEffectSections) => void
  onAudition?: (effects: RegionEffectSections | null, audio: boolean, sources?: EffectResource[]) => Promise<void>
  resourceEpoch?: number
  effectsOnline?: boolean
  view?: RegionInspectorView
  onDeleteVolume: () => void
  onDeleteRegion: () => void
  onDraft: (id: string, draft: LevelDraftRecord | null) => void
  onApplied: (id: string) => void
}) {
  const [localTab, setLocalTab] = useState<'geometry' | 'effects'>('geometry')
  const tab = view?.tab ?? localTab
  const setTab = (value: 'geometry' | 'effects') => { setLocalTab(value); view?.setTab(value) }
  const [texts, setTexts] = useState<Record<string, string>>({})
  const [blurred, setBlurred] = useState<Record<string, boolean>>({})
  const draft = buildAreaDraft(area, texts)
  const plan = deletePlan(region.id, index, area.kind, region.areas.length)
  const textRef = useRef(texts)
  const onDraftRef = useRef(onDraft)
  textRef.current = texts
  onDraftRef.current = onDraft
  useEffect(() => {
    const live = buildAreaDraft(area, textRef.current)
    if (!live.pending && !live.message) {
      onDraftRef.current('geometry', null)
      return
    }
    onDraftRef.current('geometry', {
      order: 2,
      pending: true,
      message: live.message,
      reduce: live.message ? null : (doc, shown) => applyAreaDraft(doc, shown, region.id, index, buildAreaDraft(area, textRef.current).area),
    })
    return () => onDraftRef.current('geometry', null)
  }, [area, draft.message, draft.pending, index, region.id])

  function edit(key: string, raw: string) {
    setTexts((current) => ({ ...current, [key]: raw }))
  }
  function blur(key: string) {
    setBlurred((current) => ({ ...current, [key]: true }))
    const live = buildAreaDraft(area, { ...texts, [key]: texts[key] ?? '' })
    if (!disabled && !live.message && live.pending) onArea(live.area)
  }
  const showError = draft.message && (draft.message !== '数字未完成' || Object.keys(blurred).length > 0)

  return (
    <>
      <header className="level-inspector-head">
        <p className="level-kicker">{areaShapeLabel(area.kind)} · 体积 {index + 1}</p>
        <h2 title={region.id}>{region.id}</h2>
      </header>
      <div className="region-inspector-tabs" role="tablist" aria-label="区域属性分类"><button type="button" role="tab" aria-selected={tab === 'geometry'} onClick={() => setTab('geometry')}>范围与高度</button><button type="button" role="tab" aria-selected={tab === 'effects'} onClick={() => setTab('effects')}>环境与音乐</button></div>
      <div className="region-geometry-scroll" hidden={tab !== 'geometry'}>
      <RenameField id={region.id} label="区域 id" disabled={disabled} onRename={onRename} onDraft={onDraft} onApplied={onApplied} kind="region" />

      <section className="level-group">
        <h3>范围 <span className="level-unit">方块</span></h3>
        <GeometryFields area={area} texts={texts} disabled={disabled} onEdit={edit} onBlur={blur} />
        {area.kind === 'rect' && <p className="level-hint">起止均包含在区域内；整数 0…0 表示一个方块。</p>}
        {showError && <p className="level-field-error" role="alert">{draft.message}</p>}
      </section>
      <section className="level-group">
        <h3>高度 <span className="level-unit">方块</span></h3>
        <div className="level-choice" role="radiogroup" aria-label="高度">
          <label><input type="radio" name={`level-y-${region.id}`} checked={area.y === 'all'} disabled={disabled} onChange={() => onY('all')} />全部高度</label>
          <label><input type="radio" name={`level-y-${region.id}`} checked={area.y !== 'all'} disabled={disabled} onChange={() => { if (area.y === 'all') onY([0, 256]) }} />限定高度</label>
        </div>
        {area.y !== 'all' && (
          <div className="level-axes" role="group" aria-label="Y">
            <span />
            <span className="level-axis-caption">最小</span>
            <span className="level-axis-caption">最大</span>
            <span className="axis-y">Y</span>
            <NumberBox label="Y 最小" value={area.y[0]} raw={texts.y0} disabled={disabled} onEdit={(raw) => edit('y0', raw)} onBlur={() => blur('y0')} />
            <NumberBox label="Y 最大" value={area.y[1]} raw={texts.y1} disabled={disabled} onEdit={(raw) => edit('y1', raw)} onBlur={() => blur('y1')} />
          </div>
        )}
      </section>
      <ExtensionDataEditor
        custom={region.custom_data}
        disabled={disabled}
        order={5}
        readCustom={(doc) => doc.regions.find((item) => item.id === region.id)?.custom_data ?? {}}
        writeCustom={(doc, custom) => setRegionCustom(doc, region.id, custom)}
        onChange={onCustom}
        onDraft={(record) => onDraft('custom', record)}
      />
      <section className="level-group level-danger">
        {plan.mode === 'single' ? (
          <button type="button" disabled={disabled} onClick={onDeleteVolume}>{plan.label}</button>
        ) : (
          <>
            <button type="button" disabled={disabled} onClick={onDeleteVolume}>{plan.volumeLabel}</button>
            <details>
              <summary>删除整个区域</summary>
              <p>去掉「{region.id}」里的 {plan.count} 个体积。这是一次草稿操作，可以撤销。</p>
              <button type="button" disabled={disabled} onClick={onDeleteRegion}>{plan.regionLabel}</button>
            </details>
          </>
        )}
      </section>
      </div>
      <div className="region-effects-body" hidden={tab !== 'effects'}><RegionEffectsPanel resourceEpoch={resourceEpoch} region={region} disabled={disabled} onChange={effects => onEffects?.(effects)} onDraft={onDraft} onAudition={onAudition} online={effectsOnline} channel={view?.channel} onChannel={view?.setChannel} /></div>
    </>
  )
}

function LandmarkPanel({
  point, disabled, onParam, onRename, onCustom, onDelete, onDraft, onApplied,
}: {
  point: LevelLandmark
  disabled?: boolean
  onParam: (param: { x: number; y: number; z: number }) => void
  onRename: (raw: string) => string | null
  onCustom: (custom: LevelCustomData) => void
  onDelete: () => void
  onDraft: (id: string, draft: LevelDraftRecord | null) => void
  onApplied: (id: string) => void
}) {
  const [texts, setTexts] = useState<Record<string, string>>({})
  const [display, setDisplay] = useState<Record<string, string>>({})
  const [blurred, setBlurred] = useState(false)
  const pointDraft = buildPointDraft(point.param, texts)
  const displayDraft = buildDisplayDraft(point.custom_data, display)
  const textRef = useRef(texts)
  const displayRef = useRef(display)
  const onDraftRef = useRef(onDraft)
  textRef.current = texts
  displayRef.current = display
  onDraftRef.current = onDraft

  useEffect(() => {
    const live = buildPointDraft(point.param, textRef.current)
    if (!live.pending && !live.message) {
      onDraftRef.current('point', null)
      return
    }
    onDraftRef.current('point', {
      order: 2,
      pending: true,
      message: live.message,
      reduce: live.message ? null : (doc, shown) => applyPointDraft(doc, shown, point.id, buildPointDraft(point.param, textRef.current).param),
    })
    return () => onDraftRef.current('point', null)
  }, [point, pointDraft.message, pointDraft.pending])

  useEffect(() => {
    const live = buildDisplayDraft(point.custom_data, displayRef.current)
    if (!live.pending && !live.message) {
      onDraftRef.current('display', null)
      return
    }
    onDraftRef.current('display', {
      order: 4,
      pending: true,
      message: live.message,
      reduce: live.message ? null : (doc) => {
        const current = doc.landmarks.find((item) => item.id === point.id)?.custom_data ?? {}
        const built = buildDisplayDraft(current, displayRef.current)
        if (built.message) return { blocked: built.message }
        return setLandmarkCustom(doc, point.id, built.custom)
      },
    })
    return () => onDraftRef.current('display', null)
  }, [displayDraft.message, displayDraft.pending, point])

  function blurPoint() {
    setBlurred(true)
    const live = buildPointDraft(point.param, texts)
    if (!disabled && !live.message && live.pending) onParam(live.param)
  }

  const name = typeof point.custom_data[NAV_DISPLAY_NAME] === 'string' ? String(point.custom_data[NAV_DISPLAY_NAME]) : ''
  const icon = typeof point.custom_data[NAV_DISPLAY_ICON] === 'string' ? String(point.custom_data[NAV_DISPLAY_ICON]) : ''
  const min = typeof point.custom_data[NAV_DISPLAY_MIN_DISTANCE] === 'number' ? String(point.custom_data[NAV_DISPLAY_MIN_DISTANCE]) : ''
  const max = typeof point.custom_data[NAV_DISPLAY_MAX_DISTANCE] === 'number' ? String(point.custom_data[NAV_DISPLAY_MAX_DISTANCE]) : ''

  function commitDisplay() {
    const live = buildDisplayDraft(point.custom_data, displayRef.current)
    if (disabled || live.message || !live.pending) return
    onCustom(live.custom)
    setDisplay({})
  }

  return (
    <>
      <header className="level-inspector-head">
        <p className="level-kicker">地标 · {point.kind}</p>
        <h2 title={point.id}>{point.id}</h2>
      </header>
      <RenameField id={point.id} label="地标 id" disabled={disabled} onRename={onRename} onDraft={onDraft} onApplied={onApplied} kind="landmark" />
      <section className="level-group">
        <h3>坐标 <span className="level-unit">方块</span></h3>
        <div className="level-axes level-axes-xyz">
          {(['x', 'y', 'z'] as const).map((axis) => (
            <span key={axis} className="level-axis-line">
              <span className={`axis-${axis}`}>{axis.toUpperCase()}</span>
              <NumberBox
                label={`地标 ${axis.toUpperCase()}`}
                value={point.param[axis]}
                raw={texts[axis]}
                disabled={disabled}
                onEdit={(raw) => setTexts((current) => ({ ...current, [axis]: raw }))}
                onBlur={blurPoint}
              />
            </span>
          ))}
        </div>
        {blurred && pointDraft.message && <p className="level-field-error" role="alert">{pointDraft.message}</p>}
      </section>
      <section className="level-group">
        <h3>显示</h3>
        <label className="level-line">名称文本键
          <input
            aria-label="名称文本键"
            maxLength={NAV_LABEL_MAX}
            disabled={disabled}
            value={display[NAV_DISPLAY_NAME] ?? name}
            onChange={(event) => setDisplay((current) => ({ ...current, [NAV_DISPLAY_NAME]: event.target.value }))}
            onBlur={commitDisplay}
          />
        </label>
        <p className="level-hint">在下方「地标本地化」填写这个名称的中文或其他语言译文。</p>
        <label className="level-line">图标
          <input
            aria-label="地标图标"
            disabled={disabled}
            value={display[NAV_DISPLAY_ICON] ?? icon}
            placeholder="namespace:path"
            onChange={(event) => setDisplay((current) => ({ ...current, [NAV_DISPLAY_ICON]: event.target.value }))}
            onBlur={commitDisplay}
          />
        </label>
        <div className="level-pair">
          <label>最小距离
            <input
              aria-label="最小显示距离"
              inputMode="decimal"
              disabled={disabled}
              value={display[NAV_DISPLAY_MIN_DISTANCE] ?? min}
              onChange={(event) => setDisplay((current) => ({ ...current, [NAV_DISPLAY_MIN_DISTANCE]: event.target.value }))}
              onBlur={commitDisplay}
            />
          </label>
          <label>最大距离
            <input
              aria-label="最大显示距离"
              inputMode="decimal"
              disabled={disabled}
              value={display[NAV_DISPLAY_MAX_DISTANCE] ?? max}
              onChange={(event) => setDisplay((current) => ({ ...current, [NAV_DISPLAY_MAX_DISTANCE]: event.target.value }))}
              onBlur={commitDisplay}
            />
          </label>
        </div>
        {displayDraft.message && <p className="level-field-error" role="alert">{displayDraft.message}</p>}
      </section>
      <ExtensionDataEditor
        custom={point.custom_data}
        reservedKeys={LANDMARK_FORM_KEYS}
        disabled={disabled}
        order={5}
        readCustom={(doc) => doc.landmarks.find((item) => item.id === point.id)?.custom_data ?? {}}
        writeCustom={(doc, custom) => setLandmarkCustom(doc, point.id, custom)}
        onChange={onCustom}
        onDraft={(record) => onDraft('custom', record)}
      />
      <section className="level-group level-danger">
        <button type="button" disabled={disabled} onClick={onDelete}>删除地标「{point.id}」</button>
      </section>
    </>
  )
}

/** Arbitrary extension keys have no built-in meaning; ordinary properties stay in their business forms above. */
function ExtensionDataEditor(props: ComponentProps<typeof LevelCustomDataEditor>) {
  const [pending, setPending] = useState(false)
  const details = useRef<HTMLDetailsElement>(null)
  const notify = useRef(props.onDraft)
  notify.current = props.onDraft
  const count = Object.keys(props.custom).filter(key => !props.reservedKeys?.includes(key)).length
  return <details ref={details} className="level-extension-data" onToggle={event => {
    if (pending && !event.currentTarget.open) event.currentTarget.open = true
  }}>
    <summary><span>高级扩展数据</span><small>{count} 项{pending ? ' · 未完成' : ''}</small></summary>
    <p className="level-hint">由脚本或附属功能定义的字段。</p>
    <LevelCustomDataEditor {...props} onDraft={record => {
      const next = !!record && (record.pending || !!record.message)
      setPending(previous => previous === next ? previous : next)
      if (next && details.current) details.current.open = true
      notify.current(record)
    }} />
  </details>
}

function RenameField({
  id, label, disabled, onRename, onDraft, onApplied, kind,
}: {
  id: string
  label: string
  disabled?: boolean
  onRename: (raw: string) => string | null
  onDraft: (slot: string, draft: LevelDraftRecord | null) => void
  onApplied: (id: string) => void
  kind: 'region' | 'landmark'
}) {
  const [text, setText] = useState(id)
  const [message, setMessage] = useState<string | null>(null)
  const textRef = useRef(text)
  const onDraftRef = useRef(onDraft)
  const onAppliedRef = useRef(onApplied)
  textRef.current = text
  onDraftRef.current = onDraft
  onAppliedRef.current = onApplied
  useEffect(() => {
    setText(id)
    setMessage(null)
  }, [id])
  const pending = text.trim() !== id || !!message
  useEffect(() => {
    if (!pending) {
      onDraftRef.current('rename', null)
      return
    }
    onDraftRef.current('rename', {
      order: 8,
      pending: true,
      message,
      reduce: message ? null : (doc) => {
        const plan = planRename(doc, kind, id, textRef.current)
        if (!plan.ok) return { blocked: plan.message }
        if (!plan.unchanged) onAppliedRef.current(plan.id)
        return plan.unchanged ? doc : plan.doc
      },
    })
    return () => onDraftRef.current('rename', null)
  }, [id, kind, message, pending])

  return (
    <section className="level-group">
      <h3>基本</h3>
      <label className="level-line">{label}
        <input
          aria-label={label}
          disabled={disabled}
          aria-invalid={message ? true : undefined}
          value={text}
          onChange={(event) => {
            setText(event.target.value)
            setMessage(null)
          }}
          onBlur={() => {
            const error = onRename(text)
            setMessage(error)
            if (!error) setText(id)
          }}
        />
      </label>
      {message && <p className="level-field-error" role="alert">{message}</p>}
    </section>
  )
}

function GeometryFields({
  area, texts, disabled, onEdit, onBlur,
}: {
  area: LevelArea
  texts: Record<string, string>
  disabled?: boolean
  onEdit: (key: string, raw: string) => void
  onBlur: (key: string) => void
}) {
  if (area.kind === 'rect') {
    return (
      <div className="level-axes">
        <span />
        <span className="level-axis-caption">最小</span>
        <span className="level-axis-caption">最大</span>
        <span className="axis-x">X</span>
        <NumberBox label="矩形 X 最小" value={area.x[0]} raw={texts.x0} disabled={disabled} onEdit={(raw) => onEdit('x0', raw)} onBlur={() => onBlur('x0')} />
        <NumberBox label="矩形 X 最大" value={area.x[1]} raw={texts.x1} disabled={disabled} onEdit={(raw) => onEdit('x1', raw)} onBlur={() => onBlur('x1')} />
        <span className="axis-z">Z</span>
        <NumberBox label="矩形 Z 最小" value={area.z[0]} raw={texts.z0} disabled={disabled} onEdit={(raw) => onEdit('z0', raw)} onBlur={() => onBlur('z0')} />
        <NumberBox label="矩形 Z 最大" value={area.z[1]} raw={texts.z1} disabled={disabled} onEdit={(raw) => onEdit('z1', raw)} onBlur={() => onBlur('z1')} />
      </div>
    )
  }
  if (area.kind === 'circle') {
    return (
      <div className="level-axes level-axes-xyz">
        <span className="level-axis-line"><span className="axis-x">X</span><NumberBox label="圆心 X" value={area.center[0]} raw={texts.cx} disabled={disabled} onEdit={(raw) => onEdit('cx', raw)} onBlur={() => onBlur('cx')} /></span>
        <span className="level-axis-line"><span className="axis-z">Z</span><NumberBox label="圆心 Z" value={area.center[1]} raw={texts.cz} disabled={disabled} onEdit={(raw) => onEdit('cz', raw)} onBlur={() => onBlur('cz')} /></span>
        <span className="level-axis-line"><span>R</span><NumberBox label="半径" value={area.radius} raw={texts.r} disabled={disabled} onEdit={(raw) => onEdit('r', raw)} onBlur={() => onBlur('r')} /></span>
      </div>
    )
  }
  return (
    <div className="level-poly">
      {area.points.map((point, index) => (
        <div key={index} className="level-axes">
          <span className="level-axis-caption">{index + 1}</span>
          <NumberBox label={`顶点 ${index + 1} X`} value={point[0]} raw={texts[`p${index}x`]} disabled={disabled} onEdit={(raw) => onEdit(`p${index}x`, raw)} onBlur={() => onBlur(`p${index}x`)} />
          <NumberBox label={`顶点 ${index + 1} Z`} value={point[1]} raw={texts[`p${index}z`]} disabled={disabled} onEdit={(raw) => onEdit(`p${index}z`, raw)} onBlur={() => onBlur(`p${index}z`)} />
        </div>
      ))}
    </div>
  )
}

function NumberBox({
  label, value, raw, disabled, onEdit, onBlur,
}: {
  label: string
  value: number
  raw?: string
  disabled?: boolean
  onEdit: (raw: string) => void
  onBlur: () => void
}) {
  return (
    <input
      aria-label={label}
      inputMode="decimal"
      disabled={disabled}
      value={raw ?? String(value)}
      onChange={(event) => onEdit(event.target.value)}
      onBlur={onBlur}
    />
  )
}
