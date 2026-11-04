import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useProjectSession, getProjectSession } from '../../project/projectSession'
import { ResourceSaveStatus } from '../../project/ResourceSaveStatus'
import { controlRequest, isControlConnected } from '../../gameDevServer/controlHub'
import { cloneEffectValue, readRegionEffects, toggleChannel, fullShader, type RegionEffectSections } from './regionEffects'
import { createEffectResource, EFFECT_PRESETS_PATH, readEffectPresets, type EffectPreset, type EffectResource, type EffectResourceKind } from './effectResources'
import { readEffectResource, readEffectText, saveEffectPresets, type EffectResourceSnapshot } from './effectResourceProject'
import { EffectResourceEditor } from './EffectResourceEditor'
import type { LevelArea } from './levelDoc'

export type EffectEditRequest = { sequence: number; kind: EffectResourceKind; id?: string; target?: 'sky' | 'post' }
export function RegionEffectAssets({ effects, areas, disabled, online, request, onChange, onResource, onPending, onPreview, onStop }: {
  effects: RegionEffectSections; areas: LevelArea[]; disabled?: boolean; online?: boolean; request: EffectEditRequest | null
  onChange: (effects: RegionEffectSections) => void; onResource: (resource: EffectResource) => void; onPending: (dirty: boolean) => void
  onStop: () => void; onPreview: (effects: RegionEffectSections, sources: EffectResource[]) => Promise<void>
}) {
  const client = useProjectSession().binding?.handle.client
  const [library, setLibrary] = useState<{ presets: EffectPreset[]; text: string | null; version: string | null } | null>(null)
  const [title, setTitle] = useState(''), [selected, setSelected] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const [editing, setEditing] = useState<{ resource: EffectResource; snapshot?: EffectResourceSnapshot; target?: 'sky' | 'post' } | null>(null)
  const refs = useRef({ effects, areas, onChange, onResource, onPreview, onPending }); refs.current = { effects, areas, onChange, onResource, onPreview, onPending }
  const writable = !disabled && !!client?.writable
  async function refresh() {
    if (!client) return
    setBusy(true)
    try { const snapshot = await readEffectText(client, EFFECT_PRESETS_PATH); const presets = readEffectPresets(snapshot.text); if (getProjectSession().binding?.handle.client !== client) return; setLibrary({ ...snapshot, presets }); setMessage('') }
    catch (error) { setMessage((error as Error).message) } finally { setBusy(false) }
  }
  useEffect(() => { setLibrary(null); void refresh() }, [client])
  useEffect(() => {
    if (!request) return
    let live = true
    async function open() {
      const seed = { ...createEffectResource(request!.kind), ...(request!.id ? { id: request!.id } : {}) }
      if (!request!.id) { setEditing({ resource: seed, target: request!.target }); return }
      setBusy(true); setMessage('')
      try {
        if (!client) throw Error('请先打开工程')
        const snapshot = await readEffectResource(client, seed)
        if (!snapshot.versions.some(Boolean) && isControlConnected()) {
          const game = await controlRequest('level.effects.source', { kind: seed.kind, id: seed.id }) as EffectResource
          snapshot.resource = { ...game, id: `project:${game.id.split(':')[1]}` }
          if (live) { setEditing({ resource: snapshot.resource, target: request!.target }); setMessage('已复制游戏资源。请保存工程副本后应用，原资源不变。') }
        } else if (live) setEditing({ resource: snapshot.resource, snapshot })
      } catch (error) { if (live) setMessage((error as Error).message) } finally { if (live) setBusy(false) }
    }
    void open(); return () => { live = false }
  }, [request, client])
  const withResource = (resource: EffectResource) => {
    let next = cloneEffectValue(refs.current.effects)
    if (resource.kind === 'transition') {
      const kind = editing?.target ?? 'post'
      next = toggleChannel(next, kind, true); const p = next.environment!.effects[kind]!.parameters; const old = p.transition as import('./regionEffects').ShaderRef | undefined; if (!old || fullShader(old).shader !== resource.id) p.transition = { shader: resource.id, params: {} }
    } else {
      next = toggleChannel(next, resource.kind, true)
      const p = next.environment!.effects[resource.kind]!.parameters, key = resource.kind === 'sky' ? 'layers' : 'filters'
      const list = (p[key] ?? []) as import('./regionEffects').ShaderRef[]
      if (!list.some(ref => fullShader(ref).shader === resource.id)) {
        if (list.length >= 8) throw Error('当前效果栈已达到8层，请先移除一层')
        p[key] = [...list, { shader: resource.id, params: {} }]
      }
    }
    return next
  }
  async function persist(presets: EffectPreset[]) {
    if (!client || !library || !writable) return
    setBusy(true); setMessage('')
    try {
      await saveEffectPresets(client, presets, library.version, library.text)
      if (getProjectSession().binding?.handle.client !== client) return
      const snap = await readEffectText(client, EFFECT_PRESETS_PATH)
      setLibrary({ ...snap, presets: readEffectPresets(snap.text) }); setMessage('方案库已保存到工程。')
    } catch (error) { setMessage(`方案库未保存，名称及当前效果保留。${(error as Error).message}`) } finally { setBusy(false) }
  }
  return <details className="region-effect-group region-custom-assets"><summary>我的效果方案与资源</summary>
    <p className="level-hint">保存当前区域的环境与音乐组合，在其他区域直接复用。着色器资源随工程一起打包。</p>
    <label>方案名称<input aria-label="自定义方案名称" placeholder="例如：林地夜雨" value={title} maxLength={80} disabled={!writable || busy} onChange={e => setTitle(e.target.value)} /></label>
    <button type="button" disabled={!writable || busy || !library || !title.trim() || !Object.keys(effects).length} onClick={() => { const id = crypto.randomUUID(); void persist([...library!.presets, { id, title: title.trim(), effects: cloneEffectValue(effects) }]); setSelected(id) }}>保存为新方案</button>
    <label>工程方案<select aria-label="工程效果方案" value={selected} onChange={e => setSelected(e.target.value)}><option value="">选择可复用的方案</option>{library?.presets.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>
    <div className="region-effects-actions"><button type="button" disabled={!writable || !selected} onClick={() => { try { const preset = library?.presets.find(p => p.id === selected); if (!preset) return; readRegionEffects(preset.effects as Record<string, unknown>, refs.current.areas, '方案'); onChange(cloneEffectValue(preset.effects)); setMessage('方案已填入参数面板，应用或保存后写入区域。') } catch (error) { setMessage((error as Error).message) } }}>使用方案</button><button type="button" disabled={!writable || busy || !selected} onClick={() => { void persist(library!.presets.filter(p => p.id !== selected)); setSelected('') }}>删除方案</button><button type="button" disabled={busy || !client} onClick={() => { void refresh() }}>刷新方案库</button></div>
    <button type="button" disabled={!writable || busy} onClick={() => setEditing({ resource: createEffectResource() })}>＋ 制作自定义着色器</button>
    {!online && <p className="level-hint">离线可编辑并保存源码与参数；连接游戏后可编译并查看实际效果。</p>}
    {message && <p role="status" className="level-hint">{message}</p>}
    {client && <ResourceSaveStatus client={client} path={EFFECT_PRESETS_PATH} compact />}
    {editing && createPortal(<EffectResourceEditor initial={editing.resource} initialSnapshot={editing.snapshot} disabled={disabled} onClose={() => { setEditing(null); onPending(false); onStop() }} onPending={onPending} onStop={onStop} onResource={resource => { onResource(resource); onChange(withResource(resource)) }} onPreview={async resource => { const next = withResource(resource); await refs.current.onPreview(next, [resource]) }} />, document.body)}
  </details>
}
