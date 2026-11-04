import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { LevelRegion } from './levelDoc'
import type { LevelDraftRecord } from './levelLayoutModel'
import { controlRequest, isControlConnected } from '../../gameDevServer/controlHub'
import {
  REGION_EFFECT_CONTROLS, EFFECT_NAMES, cloneEffectValue, effectColor, effectSections, effectFingerprint,
  fullShader, readRegionEffects, shaderInfo, toggleChannel, volumeProblem, withRegionEffects,
  type EffectChannel, type EffectControls, type EffectField, type RegionEffectSections, type ShaderRef,
} from './regionEffects'
import { EffectValue } from './EffectValue'
import { RegionEffectAssets, type EffectEditRequest } from './RegionEffectAssets'
import { useProjectSession } from '../../project/projectSession'
import { projectEffectSources } from './effectResourceProject'
import { effectResourceChoice, referencedEffects, type EffectResource } from './effectResources'
import './regionEffectsPanel.css'

type Props = { region: LevelRegion; disabled?: boolean; onChange: (effects: RegionEffectSections) => void; onDraft: (id: string, draft: LevelDraftRecord | null) => void; onAudition?: (effects: RegionEffectSections | null, audio: boolean, sources?: EffectResource[]) => Promise<void>; online?: boolean; resourceEpoch?: number; channel?: EffectChannel; onChannel?: (channel: EffectChannel) => void }
const CHANNELS: EffectChannel[] = ['fog', 'sky', 'post', 'music']
const glyphs = { fog: '≋', sky: '☼', post: '◐', music: '♫' }

export function RegionEffectsPanel(props: Props) {
  const client = useProjectSession().binding?.handle.client
  const source = effectFingerprint(props.region)
  const [resourceRequest, setResourceRequest] = useState<EffectEditRequest | null>(null)
  const customResources = useRef<EffectResource[]>([])
  const editResource = (kind: EffectEditRequest['kind'], id?: string) => setResourceRequest({ sequence: Date.now(), kind, id })
  useEffect(() => { if (props.resourceEpoch) editResource('post') }, [props.resourceEpoch])
  const [draft, setDraft] = useState<RegionEffectSections>(() => cloneEffectValue(effectSections(props.region)))
  const [baseline, setBaseline] = useState(source)
  const [localChannel, setChannel] = useState<EffectChannel>('fog')
  const channel = props.channel ?? localChannel
  const [controls, setControls] = useState(REGION_EFFECT_CONTROLS)
  const [previewing, setPreviewing] = useState(false), [audio, setAudio] = useState(false)
  const [status, setStatus] = useState(''), [resources, setResources] = useState(false)
  const [conflict, setConflict] = useState(false)
  const disabledValues = useRef(new Map<EffectChannel, unknown>())
  const refs = useRef(props); refs.current = props
  const draftRef = useRef(draft); draftRef.current = draft
  const pending = effectFingerprint(draft) !== source
  let issue = ''
  try { readRegionEffects(draft as Record<string, unknown>, props.region.areas, '区域效果') } catch (error) { issue = (error as Error).message }
  const enabled = (kind: EffectChannel) => kind === 'music' ? !!draft.music : !!draft.environment?.effects[kind]
  function enable(kind: EffectChannel, on: boolean) {
    if (!on) disabledValues.current.set(kind, cloneEffectValue(kind === 'music' ? draft.music : draft.environment?.effects[kind]))
    const next = toggleChannel(draft, kind, on)
    if (on && disabledValues.current.has(kind)) {
      if (kind === 'music') next.music = cloneEffectValue(disabledValues.current.get(kind)) as NonNullable<typeof next.music>
      else next.environment!.effects[kind] = cloneEffectValue(disabledValues.current.get(kind)) as NonNullable<NonNullable<typeof next.environment>['effects'][typeof kind]>
    }
    setDraft(next)
  }

  useEffect(() => {
    if (source === baseline) return
    if (effectFingerprint(draftRef.current) === source || effectFingerprint(draftRef.current) === baseline) {
      setDraft(cloneEffectValue(effectSections(refs.current.region))); setBaseline(source); setConflict(false)
    } else setConflict(true)
  }, [source, baseline])
  useEffect(() => {
    if (!pending && !issue) { refs.current.onDraft('effects', null); return }
    const effects = cloneEffectValue(draft), original = baseline, regionId = props.region.id
    refs.current.onDraft('effects', { order: 4, pending, message: issue || (conflict ? '区域效果已从另一端更新，请重载或保留当前输入' : null), reduce: issue || conflict ? null : doc => {
      const region = doc.regions.find(r => r.id === regionId)
      if (!region || effectFingerprint(region) !== original) return { blocked: '区域效果已更新，当前输入保留，请先重载效果' }
      return { ...doc, regions: doc.regions.map(r => r.id === regionId ? withRegionEffects(r, effects) : r) }
    } })
  }, [draft, pending, issue, conflict, baseline, props.region.id])
  useEffect(() => () => { refs.current.onDraft('effects', null); void refs.current.onAudition?.(null, false).catch(() => {}) }, [])

  async function loadResources() {
    if (!isControlConnected()) { setResources(false); return }
    try {
      const response = await controlRequest('level.effects.library', {}) as EffectControls
      if (response.v !== 1 || !Array.isArray(response.shaders)) throw Error('效果库格式不匹配')
      setControls({ ...REGION_EFFECT_CONTROLS, shaders: [...response.shaders.filter(s => !customResources.current.some(r => r.kind === s.kind && r.id === s.id)), ...customResources.current.map(effectResourceChoice)], sounds: response.sounds }); setResources(true); setStatus('')
    } catch { setStatus('暂未读取到游戏效果库，继续使用内置效果；连接游戏后可刷新。') }
  }
  useEffect(() => {
    if (!client) return
    let live = true
    void projectEffectSources(client, referencedEffects(effectSections(props.region))).then(sources => {
      if (!live) return
      customResources.current = sources
      setControls(previous => ({ ...previous, shaders: [...previous.shaders.filter(s => !sources.some(r => r.kind === s.kind && r.id === s.id)), ...sources.map(effectResourceChoice)] }))
    }).catch(error => { if (live) setStatus(`工程效果资源暂不可用：${(error as Error).message}`) })
    return () => { live = false }
  }, [client, source])
  useEffect(() => { void loadResources() }, [props.online])
  useEffect(() => {
    if (!previewing) { void refs.current.onAudition?.(null, false).catch(() => {}); return }
    if (issue || conflict) return
    let live = true
    const run = () => { void refs.current.onAudition?.(cloneEffectValue(draftRef.current), audio).then(() => { if (live) setStatus('') }).catch(error => { if (live) { setStatus(`预览未生效：${String(error instanceof Error ? error.message : error)}`); setPreviewing(false) } }) }
    const delay = setTimeout(run, 160), heartbeat = setInterval(run, 3000)
    return () => { live = false; clearTimeout(delay); clearInterval(heartbeat) }
  }, [previewing, audio, draft, issue, conflict, props.online])

  function update(change: (next: RegionEffectSections) => void) { setDraft(previous => { const next = cloneEffectValue(previous); change(next); return next }) }
  function parameter(key: string, value: unknown) {
    update(next => {
      if (channel === 'music') { if (next.music) { const music = next.music as unknown as Record<string, unknown>; if (value === undefined) delete music[key]; else music[key] = value }; return }
      const effect = next.environment?.effects[channel]; if (!effect) return
      if (value === undefined) delete effect.parameters[key]; else effect.parameters[key] = value
      if (channel === 'fog' && key === 'distance_mode') {
        effect.parameters.start = 0; effect.parameters.end = value === 'blocks' ? 96 : 1
        delete effect.parameters.extinction; delete effect.parameters.mean_free_path
      }
      if (channel === 'fog' && key === 'extinction' && value !== undefined) delete effect.parameters.mean_free_path
      if (channel === 'fog' && key === 'mean_free_path' && value !== undefined) delete effect.parameters.extinction
      if (channel === 'fog' && key === 'color' && value === undefined) delete effect.parameters.night_color
      if (channel === 'fog' && key === 'night_color' && value !== undefined) effect.parameters.color ??= '#A9C4D0'
    })
  }
  function apply() {
    if (issue || conflict || props.disabled) return
    refs.current.onDraft('effects', null); props.onChange(cloneEffectValue(draft)); setBaseline(effectFingerprint(draft)); setStatus('效果已应用到草稿；保存后写入工程。')
  }
  const p = channel === 'music' ? draft.music as unknown as Record<string, unknown> | undefined : draft.environment?.effects[channel]?.parameters
  return <section className="region-effects" aria-label="区域效果">
    <div className="region-effects-intro"><strong>让这个区域有自己的氛围</strong><p>效果作用于整个区域，包括其中的所有体积。</p></div>
    <div className="region-effect-tabs" role="tablist" aria-label="区域效果分类">{CHANNELS.map(kind => <button key={kind} type="button" role="tab" aria-selected={channel === kind} onClick={() => { setChannel(kind); props.onChannel?.(kind) }}>
      <span aria-hidden="true">{glyphs[kind]}</span><span>{EFFECT_NAMES[kind]}</span><small>{enabled(kind) ? '已配置' : '未启用'}</small>
    </button>)}</div>
    <div className="region-effect-title"><h3>{EFFECT_NAMES[channel]}</h3><label className="region-effect-enable"><input type="checkbox" aria-label={`启用${EFFECT_NAMES[channel]}`} checked={enabled(channel)} disabled={props.disabled} onChange={e => { enable(channel, e.target.checked); if (channel === 'music' && !e.target.checked) setAudio(false) }} />启用</label></div>
    {!enabled(channel) && <div className="region-effect-empty"><span aria-hidden="true">{glyphs[channel]}</span><p>{channel === 'fog' ? '用颜色、距离和流动纹理塑造空间。' : channel === 'sky' ? '叠加天空图层，调整云、日月和星空。' : channel === 'post' ? '组合调色、晕影、泛光等画面效果。' : '玩家进入区域后，按优先级选择背景音乐。'}</p><button type="button" disabled={props.disabled} onClick={() => setDraft(toggleChannel(draft, channel, true))}>添加{EFFECT_NAMES[channel]}</button></div>}
    {p && channel === 'fog' && <>
      <div className="region-effect-presets" aria-label="雾效预设">{[
        { name: '清晨薄雾', color: '#C3D7D5', start: 12, end: 128, density: .7, mode: 'height', height: 64, height_range: 32 },
        { name: '洞穴冷雾', color: '#30495E', start: 0, end: 48, density: 1.4, mode: 'cave' },
        { name: '流动体积雾', color: '#A8B8C4', start: 0, end: 96, density: 1, volumetric: true, noise_amount: .4, wind_x: .2 },
      ].map(({ name, ...preset }) => <button type="button" key={name} disabled={props.disabled} onClick={() => update(next => { Object.assign(next.environment!.effects.fog!.parameters, preset) })}><i style={{ background: preset.color }} />{name}</button>)}</div>
      <label className="region-effect-scope">作用方式<select aria-label="雾的作用方式" disabled={props.disabled} value={draft.environment?.effects.fog?.scope ?? 'player'} onChange={e => update(next => { const effect = next.environment!.effects.fog!; effect.scope = e.target.value as 'player' | 'volume'; if (effect.scope === 'volume') { effect.parameters.volumetric = true; next.environment!.on_exit = 'restore' } })}><option value="player">玩家进入后改变环境</option><option value="volume" disabled={!!volumeProblem(props.region.areas)}>有边界的空间雾（区域外也可见）</option></select></label>
      {volumeProblem(props.region.areas) && <p className="level-hint">{volumeProblem(props.region.areas)}，可先使用玩家环境。</p>}
      <FogDistancePreview parameters={p} />
      {controls.fog.map((group, i) => <details className="region-effect-group" key={group.key} open={i < 2}><summary>{group.label}</summary>{group.fields.map(field => <EffectValue key={field.key} field={field.key === 'affect_sky' ? { ...field, default: !!p.volumetric } : field.key === 'start' || field.key === 'end' ? { ...field, max: p.distance_mode === 'render_distance' ? 4 : field.max, unit: p.distance_mode === 'render_distance' ? '倍' : '格' } : field} value={p[field.key]} disabled={props.disabled} onChange={value => parameter(field.key, value)} />)}</details>)}
      <Lights values={Array.isArray(p.lights) ? p.lights as Record<string, unknown>[] : []} fields={controls.lights} position={lightOrigin(props.region)} disabled={props.disabled} onChange={value => parameter('lights', value)} />
    </>}
    {p && (channel === 'sky' || channel === 'post') && <>
      <ShaderStack kind={channel} parameters={p} controls={controls} disabled={props.disabled} onChange={parameter} onEdit={editResource} />
      {channel === 'sky' && <details className="region-effect-group"><summary>云层</summary>{controls.clouds.map(field => <EffectValue key={field.key} field={field} value={(p.clouds as Record<string, unknown> | undefined)?.[field.key]} disabled={props.disabled} onChange={value => { const next = { ...(p.clouds as Record<string, unknown> ?? {}) }; if (value === undefined) delete next[field.key]; else next[field.key] = value; parameter('clouds', next) }} />)}</details>}
      <Transition value={p.transition as ShaderRef | undefined} controls={controls} inheritedTicks={draft.environment?.transition_ticks ?? 40} onEdit={editResource} disabled={props.disabled} onChange={value => parameter('transition', value)} />
    </>}
    {p && channel === 'music' && <>
      <MusicPicker value={String(p.sound ?? '')} sounds={controls.sounds} disabled={props.disabled} onChange={value => parameter('sound', value)} />
      <EffectValue field={{ key: 'priority', label: '音乐优先级', type: 'number', default: 0, min: -2147483648, max: 2147483647, step: 1 }} value={p.priority} disabled={props.disabled} onChange={value => parameter('priority', value)} />
      <p className="level-hint">重叠时选择优先级最高的区域音乐。离开后恢复原版选曲；音量和播放间隔跟随游戏音乐设置。</p>
      <button className="region-music-play" type="button" disabled={!!issue || props.disabled || !props.online} onClick={() => { setAudio(!audio); setPreviewing(true) }}>{audio ? '■ 停止试听音乐' : '▶ 在游戏客户端试听'}</button>
      {!props.online && <p className="level-hint">连接游戏并开启在线预览后，可在游戏客户端试听实际资源。</p>}
    </>}
    {draft.environment && <details className="region-effect-group region-effect-policy"><summary>进入、离开与优先级</summary>{controls.policy.map(field => <EffectValue key={field.key} field={field} value={(draft.environment as unknown as Record<string, unknown>)[field.key]} disabled={props.disabled} onChange={value => update(next => { const env = next.environment as unknown as Record<string, unknown>; if (value === undefined) delete env[field.key]; else env[field.key] = value })} />)}<p className="level-hint">20 tick = 1 秒。各环境通道独立比较优先级，音乐使用自己的优先级。</p></details>}
    {(issue || conflict) && <p className="level-field-error" role="alert">{issue || '区域效果已从另一端更新。当前输入保留，请重载效果后继续。'}</p>}
    <div className="region-effects-actions"><button type="button" disabled={props.disabled || !!issue || conflict || !pending} onClick={apply}>应用效果</button><button type="button" disabled={props.disabled || !pending && !conflict} onClick={() => { setDraft(cloneEffectValue(effectSections(props.region))); setBaseline(source); setConflict(false); setAudio(false); setStatus(''); refs.current.onDraft('effects', null) }}>重载效果</button></div>
    <div className="region-effects-preview"><button type="button" aria-pressed={previewing} disabled={!!issue || conflict || props.disabled} onClick={() => { setPreviewing(!previewing); if (previewing) setAudio(false) }}>{previewing ? '■ 停止预览并恢复' : props.online ? '▶ 在游戏画面中预览' : '▶ 在离线场景中预览'}</button><p>{previewing ? props.online ? '正在预览选中区域 · 未发布到服务器' : '离线示意预览 · 游戏着色器请在线确认' : '预览只影响当前客户端，不移动玩家。'}</p></div>
    <RegionEffectAssets effects={draft} areas={props.region.areas} disabled={props.disabled} online={props.online} request={resourceRequest} onChange={setDraft} onStop={() => { setPreviewing(false); void refs.current.onAudition?.(null, false).catch(() => {}) }}
      onResource={resource => { customResources.current = [...customResources.current.filter(r => r.kind !== resource.kind || r.id !== resource.id), resource]; setControls(previous => ({ ...previous, shaders: [...previous.shaders.filter(s => s.kind !== resource.kind || s.id !== resource.id), effectResourceChoice(resource)] })) }}
      onPending={dirty => refs.current.onDraft('effect-resource', dirty ? { order: 5, pending: true, message: '着色器窗口有未保存资源，请先保存资源或明确关闭窗口', reduce: null } : null)}
      onPreview={async (effects, sources) => { if (!props.online || !refs.current.onAudition) throw Error('请连接游戏并开启在线视口'); await refs.current.onAudition(effects, false, sources) }} />
    {status && <p className="level-hint" role="status">{status}</p>}
    <div className="region-effect-library-state"><span>{resources ? '来自当前游戏资源库' : '内置效果库'}</span><button type="button" onClick={() => { void loadResources() }}>刷新资源</button></div>
  </section>
}


function FogDistancePreview({ parameters: p }: { parameters: Record<string, unknown> }) {
  const color = effectColor(p.color)?.hex ?? '#A9C4D0', density = Number(p.density ?? 1)
  return <div className="region-fog-distance" aria-label="雾距离示意" style={{ '--fog-color': color, '--fog-opacity': Math.min(1, density / 2) } as CSSProperties}><div className="region-distance-landscape"><i /><i /><i /><span /></div><div className="region-distance-labels"><span>镜头</span><span>开始 {String(p.start ?? 0)}</span><span>遮蔽 {String(p.end ?? (p.distance_mode === 'render_distance' ? 1 : 96))}</span></div><small>距离与染色示意</small></div>
}

function ShaderStack({ kind, parameters, controls, disabled, onChange, onEdit }: { kind: 'sky' | 'post'; parameters: Record<string, unknown>; controls: EffectControls; disabled?: boolean; onChange: (key: string, value: unknown) => void; onEdit: (kind: 'sky' | 'post', id?: string) => void }) {
  const key = kind === 'sky' ? 'layers' : 'filters', list = parameters[key] as ShaderRef[] ?? []
  const [adding, setAdding] = useState(list.length === 0)
  function change(i: number, value: ShaderRef) { const next = [...list]; next[i] = value; onChange(key, next) }
  return <div className="region-shader-stack">
    <p className="level-hint">{kind === 'sky' ? '从下到上叠加天空图层，原版天空只能放在最底层。' : '从上到下依次处理画面，可以调整顺序和每个滤镜的强度。'}</p>
    {list.map((ref, i) => {
      const data = fullShader(ref), info = shaderInfo(kind, ref, controls), vanilla = ['vanilla', 'rpgtoolkit:vanilla'].includes(data.shader)
      return <details className="region-shader-entry" key={`${i}:${data.shader}`} open><summary><span>{i + 1}</span>{info?.label ?? data.shader}<small>{kind === 'sky' ? '图层' : '滤镜'}</small></summary><div className="region-shader-order"><button type="button" aria-label={`上移${info?.label ?? data.shader}`} disabled={disabled || i === 0 || vanilla || kind === 'sky' && i === 1 && ['vanilla', 'rpgtoolkit:vanilla'].includes(fullShader(list[0]).shader)} onClick={() => { const next = [...list]; [next[i - 1], next[i]] = [next[i], next[i - 1]]; onChange(key, next) }}>↑</button><button type="button" aria-label={`下移${info?.label ?? data.shader}`} disabled={disabled || i === list.length - 1 || vanilla} onClick={() => { const next = [...list]; [next[i + 1], next[i]] = [next[i], next[i + 1]]; onChange(key, next) }}>↓</button><button type="button" disabled={disabled} onClick={() => onChange(key, list.filter((_, at) => at !== i))}>移除此{kind === 'sky' ? '图层' : '滤镜'}</button></div>
        {info?.error && <p className="level-field-error">当前游戏资源加载失败：{info.error}</p>}
        {!vanilla && <EffectValue field={{ key: kind === 'sky' ? 'opacity' : 'strength', label: kind === 'sky' ? '图层可见度' : '滤镜强度', type: 'number', default: 1, min: 0, max: 1, step: .01 }} value={data[kind === 'sky' ? 'opacity' : 'strength']} disabled={disabled} onChange={value => { const next = { ...data }; const k = kind === 'sky' ? 'opacity' : 'strength'; if (value === undefined) delete next[k]; else next[k] = Number(value); change(i, next) }} />}
        {kind === 'sky' && !vanilla && <EffectValue field={{ key: 'blend', label: '混合方式', type: 'choice', default: 'normal', choices: [{ value: 'normal', label: '正常' }, { value: 'add', label: '叠加发光' }, { value: 'multiply', label: '正片叠底' }, { value: 'screen', label: '滤色' }] }} value={data.blend} disabled={disabled} onChange={value => change(i, { ...data, blend: String(value ?? 'normal') })} />}
        {info?.params.map(field => <EffectValue key={field.key} field={field} value={data.params?.[field.key]} disabled={disabled} onChange={value => { const params = { ...data.params }; if (value === undefined) delete params[field.key]; else params[field.key] = value; change(i, { ...data, params }) }} />)}
        {!vanilla && <button type="button" disabled={disabled} onClick={() => onEdit(kind, data.shader)}>编辑资源／制作副本</button>}
        {!info && <p className="level-hint">请连接游戏并刷新效果库以编辑此资源的类型化参数；原参数会完整保留。</p>}
      </details>
    })}
    <button type="button" disabled={disabled} onClick={() => onEdit(kind)}>＋ 制作自定义{kind === 'sky' ? '天空' : '滤镜'}</button>
    <button type="button" className="region-add-effect" disabled={disabled || list.length >= 8} onClick={() => setAdding(!adding)}>＋ 添加{kind === 'sky' ? '天空图层' : '画面滤镜'} <small>{list.length}/8</small></button>
    {adding && <div className="region-shader-picker" aria-label={kind === 'sky' ? '选择天空图层' : '选择画面滤镜'}>{controls.shaders.filter(s => s.kind === kind && (s.id !== 'rpgtoolkit:vanilla' || list.length === 0)).map(s => <button type="button" key={s.id} disabled={disabled || list.length >= 8 || !!s.error} onClick={() => { onChange(key, [...list, { shader: s.id, params: {} }]); setAdding(false) }}><EffectThumbnail shader={s.id} /><span>{s.label}</span></button>)}</div>}
  </div>
}
function EffectThumbnail({ shader }: { shader: string }) {
  return <span className={`region-effect-thumbnail effect-${shader.split(':').pop()}`} aria-hidden="true"><i /><b /></span>
}
function Transition({ value, controls, disabled, onChange, inheritedTicks, onEdit }: { value?: ShaderRef; controls: EffectControls; disabled?: boolean; onChange: (value: ShaderRef | undefined) => void; inheritedTicks: number; onEdit: (kind: 'transition', id?: string) => void }) {
  const data = value ? fullShader(value) : undefined, info = value ? shaderInfo('transition', value, controls) : undefined
  return <details className="region-effect-group"><summary>切换转场</summary><label className="region-effect-scope">转场效果<select aria-label="转场效果" disabled={disabled} value={data?.shader ?? ''} onChange={e => onChange(e.target.value ? { shader: e.target.value, params: {} } : undefined)}><option value="">跟随默认交叉淡化</option>{controls.shaders.filter(s => s.kind === 'transition').map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>{data && <><EffectValue field={{ key: 'ticks', label: '转场时长', type: 'number', default: inheritedTicks, min: 0, max: 1200, step: 1, unit: 'tick', optional: true }} value={data.ticks} disabled={disabled} onChange={value => { const next = { ...data }; if (value === undefined) delete next.ticks; else next.ticks = Number(value); onChange(next) }} />{info?.params.map(field => <EffectValue key={field.key} field={field} value={data.params?.[field.key]} disabled={disabled} onChange={value => { const params = { ...data.params }; if (value === undefined) delete params[field.key]; else params[field.key] = value; onChange({ ...data, params }) }} />)}<button type="button" disabled={disabled} onClick={() => onEdit('transition', data.shader)}>编辑转场资源</button></>}</details>
}
function lightOrigin(region: LevelRegion): number[] {
  const area = region.areas[0], y = area.y === 'all' ? 64 : (area.y[0] + area.y[1] + 1) / 2
  if (area.kind === 'rect') return [(area.x[0] + area.x[1] + 1) / 2, y, (area.z[0] + area.z[1] + 1) / 2]
  if (area.kind === 'circle') return [area.center[0] + .5, y, area.center[1] + .5]
  return [area.points.reduce((v, p) => v + p[0], 0) / area.points.length + .5, y, area.points.reduce((v, p) => v + p[1], 0) / area.points.length + .5]
}
function Lights({ values, fields, position, disabled, onChange }: { values: Record<string, unknown>[]; fields: EffectField[]; position: number[]; disabled?: boolean; onChange: (value: Record<string, unknown>[]) => void }) {
  return <details className="region-effect-group"><summary>雾中灯光 <small>{values.length}/4</small></summary>{values.map((light, i) => <details className="region-shader-entry" key={i} open><summary><span style={{ color: effectColor(light.color)?.hex ?? '#fff' }}>●</span>灯光 {i + 1} · {light.direction ? '聚光' : '点光'}</summary>{fields.map(field => <EffectValue key={field.key} field={field} value={light[field.key]} disabled={disabled} onChange={value => { const next = cloneEffectValue(values); if (value === undefined) { if (field.key === 'position') next[i].position = position; else delete next[i][field.key] } else next[i][field.key] = value; onChange(next) }} />)}<button type="button" disabled={disabled} onClick={() => onChange(values.filter((_, at) => at !== i))}>移除灯光 {i + 1}</button></details>)}<button type="button" disabled={disabled || values.length >= 4} onClick={() => onChange([...values, { position, color: '#FFFFFF', intensity: 10, range: 16 }])}>＋ 添加灯光</button></details>
}
function MusicPicker({ value, sounds, disabled, onChange }: { value: string; sounds: EffectControls['sounds']; disabled?: boolean; onChange: (id: string) => void }) {
  const [query, setQuery] = useState(''), [options, setOptions] = useState(sounds), [message, setMessage] = useState('')
  useEffect(() => {
    let active = true
    const timer = setTimeout(() => {
      if (!isControlConnected()) { setOptions(sounds.filter(s => `${s.id} ${s.label}`.toLowerCase().includes(query.toLowerCase()))); return }
      void controlRequest('sounds.list', { query: query || 'music', limit: 64 }).then(raw => {
        if (!active) return
        const result = raw as { items: { id: string }[] }; setOptions(result.items.map(s => ({ id: s.id, label: sounds.find(v => v.id === s.id)?.label ?? s.id }))); setMessage('')
      }).catch(() => { if (active) setMessage('声音列表暂不可用，已保留当前曲目。') })
    }, 200)
    return () => { active = false; clearTimeout(timer) }
  }, [query, sounds])
  return <div className="region-music-picker"><label>查找曲目<input type="search" aria-label="查找区域音乐" placeholder="名称或声音事件" value={query} onChange={e => setQuery(e.target.value)} /></label><div className="region-music-options" role="listbox" aria-label="区域音乐曲目">{options.map(s => <button type="button" role="option" aria-selected={value === s.id} key={s.id} disabled={disabled} onClick={() => onChange(s.id)}><span>♫ {s.label}</span>{s.label !== s.id && <small>{s.id}</small>}</button>)}</div><label>当前声音事件<input type="text" aria-label="音乐声音事件" value={value} disabled={disabled} onChange={e => onChange(e.target.value)} /></label>{message && <p className="level-hint">{message}</p>}</div>
}
