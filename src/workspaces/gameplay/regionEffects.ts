import generated from './regionEffectControls.generated.json'
import type { LevelArea, LevelRegion } from './levelDoc'

export type EffectField = { key: string; label: string; type: string; default: unknown; min?: number; max?: number; step?: number; integer?: boolean; opaque?: boolean; unit?: string; optional?: boolean; choices?: { value: string; label: string }[] }
export type ShaderChoice = { kind: string; id: string; label: string; params: EffectField[]; error?: string }
export type EffectControls = { v: number; fog: { key: string; label: string; fields: EffectField[] }[]; policy: EffectField[]; clouds: EffectField[]; lights: EffectField[]; shaders: ShaderChoice[]; sounds: { id: string; label: string }[] }
export const REGION_EFFECT_CONTROLS = generated as EffectControls
export type RegionMusic = { sound: string; priority?: number }
export type ShaderRef = string | { shader: string; params?: Record<string, unknown>; opacity?: number; blend?: string; strength?: number; ticks?: number }
export type RegionEnvironment = { priority?: number; transition_ticks?: number; on_exit?: 'restore' | 'retain'; effects: Partial<Record<'fog' | 'sky' | 'post', { scope?: 'player' | 'volume'; parameters: Record<string, unknown> }>> }
export type RegionEffectSections = { music?: RegionMusic; environment?: RegionEnvironment }
export type EffectChannel = 'fog' | 'sky' | 'post' | 'music'
export const EFFECT_NAMES: Record<EffectChannel, string> = { fog: '环境雾', sky: '天空与云', post: '画面滤镜', music: '区域音乐' }
export const cloneEffectValue = <T,>(value: T): T => structuredClone(value)
export function effectFingerprint(value: RegionEffectSections): string {
  const ordered = (v: unknown): unknown => Array.isArray(v) ? v.map(ordered) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, item]) => [k, ordered(item)])) : v
  return JSON.stringify(ordered(effectSections(value)))
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown) => typeof value === 'string' && value.length <= 256 && /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(value)
const shaderId = (value: unknown) => !(typeof value === 'string' && value.startsWith('rpgtoolkit_editor:')) && id(typeof value === 'string' && !value.includes(':') ? `rpgtoolkit:${value}` : value)
function fail(path: string, reason: string): never { throw new Error(`${path}：${reason}`) }
function keys(value: unknown, allowed: string[], path: string): asserts value is Record<string, unknown> {
  if (!object(value)) fail(path, '应为对象')
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(path, `未知字段 ${key}`)
}
function number(value: unknown, min: number, max: number, path: string, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || integer && !Number.isInteger(value)) fail(path, `需要 ${min}…${max} 内的${integer ? '整数' : '数字'}`)
}
export function effectColor(value: unknown): { hex: string; alpha: number } | null {
  if (typeof value === 'string') {
    let s = value.trim()
    if (/^#[\da-f]{3,4}$/i.test(s)) s = '#' + [...s.slice(1)].map(c => c + c).join('')
    if (/^#[\da-f]{6}([\da-f]{2})?$/i.test(s)) return { hex: s.slice(0, 7), alpha: s.length === 9 ? parseInt(s.slice(7), 16) / 255 : 1 }
    const fn = /^(rgb|rgba)\s*\(([^()]*)\)$/i.exec(s)
    if (fn) { const channels = fn[2].split(',').map(s => s.trim()); if (channels.length !== (fn[1].toLowerCase() === 'rgba' ? 4 : 3) || channels.some(s => !s)) return null; return effectColor(channels.map(Number)) }
  }
  if (Array.isArray(value) && (value.length === 3 || value.length === 4)) {
    if (value.slice(0, 3).some(n => typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 255)) return null
    const a = value.length === 4 ? value[3] : 1
    if (typeof a !== 'number' || !Number.isFinite(a) || a < 0 || a > 1) return null
    return { hex: '#' + value.slice(0, 3).map(n => n.toString(16).padStart(2, '0')).join(''), alpha: a }
  }
  return null
}
export function colorWithAlpha(hex: string, alpha: number): unknown {
  if (alpha === 1) return hex
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), alpha]
}
export function fullShader(ref: ShaderRef): Exclude<ShaderRef, string> { return typeof ref === 'string' ? { shader: ref } : cloneEffectValue(ref) }
export function shaderInfo(kind: string, ref: ShaderRef, controls = REGION_EFFECT_CONTROLS) {
  const raw = typeof ref === 'string' ? ref : ref.shader
  return controls.shaders.find(s => s.kind === kind && s.id === (raw.includes(':') ? raw : `rpgtoolkit:${raw}`))
}
export function effectSections(region: RegionEffectSections): RegionEffectSections {
  return { ...(region.music ? { music: region.music } : {}), ...(region.environment ? { environment: region.environment } : {}) }
}
export function withRegionEffects(region: LevelRegion, effects: RegionEffectSections): LevelRegion {
  const next = { ...region }; delete next.environment; delete next.music
  return { ...next, ...cloneEffectValue(effectSections(effects)) }
}
export function volumeProblem(areas: LevelArea[]): string | null {
  return areas.length > 4 ? '空间雾最多使用 4 个体积' : areas.some(a => a.y === 'all') ? '空间雾需要限定高度，请先调整选区高度' : areas.some(a => a.kind === 'polygon') ? '空间雾支持矩形和圆形体积' : null
}
function checkField(value: unknown, field: EffectField, path: string) {
  if (field.type === 'number') number(value, field.min ?? -Number.MAX_VALUE, field.max ?? Number.MAX_VALUE, path, !!field.integer)
  else if (field.type === 'boolean' && typeof value !== 'boolean') fail(path, '需要开关值')
  else if (field.type === 'choice' && !field.choices?.some(c => c.value === value)) fail(path, '选项无效')
  else if (field.type === 'color' && !effectColor(value)) fail(path, '颜色无效')
  else if (field.type.startsWith('vec')) {
    if (!Array.isArray(value) || value.length !== Number(field.type.slice(3))) fail(path, '向量分量数量无效')
    value.forEach((n, i) => number(n, field.min ?? -Number.MAX_VALUE, field.max ?? Number.MAX_VALUE, `${path}[${i}]`))
  }
}
function checkParams(value: unknown, path: string) {
  if (!object(value) || Object.keys(value).length > 16) fail(path, '最多 16 个资源参数')
  for (const [key, v] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(key) || key.startsWith('rpg') || key.startsWith('gl_')) fail(path, `参数名无效：${key}`)
    if (typeof v === 'number') number(v, -Number.MAX_VALUE, Number.MAX_VALUE, path + '.' + key)
    else if (typeof v === 'string') { if (!v || v.length > 256) fail(path, '参数文本长度应为 1…256') }
    else if (Array.isArray(v) && v.length >= 2 && v.length <= 4) v.forEach(n => number(n, -Number.MAX_VALUE, Number.MAX_VALUE, path))
    else if (typeof v !== 'boolean') fail(path, '参数仅接受数字、开关、文本或 2…4 维向量')
  }
}
function checkShader(value: unknown, kind: string, path: string, transition = false) {
  if (typeof value === 'string') { if (!shaderId(value)) fail(path, '资源 ID 无效'); return }
  keys(value, transition ? ['shader', 'params', 'ticks'] : kind === 'sky' ? ['shader', 'params', 'opacity', 'blend'] : ['shader', 'params', 'strength'], path)
  if (!shaderId(value.shader)) fail(path, '资源 ID 无效')
  if ('params' in value) checkParams(value.params, path + '.params')
  for (const key of ['opacity', 'strength']) if (key in value) number(value[key], 0, 1, path + '.' + key)
  if ('ticks' in value) number(value.ticks, 0, 1200, path + '.ticks', true)
  if ('blend' in value && !['normal', 'add', 'multiply', 'screen'].includes(value.blend as string)) fail(path, '混合方式无效')
}
export function readRegionEffects(value: Record<string, unknown>, areas: LevelArea[], path: string): RegionEffectSections {
  if ('music' in value) {
    keys(value.music, ['sound', 'priority'], path + '.music')
    if (!id(value.music.sound)) fail(path + '.music', '请选择有效的声音事件')
    if ('priority' in value.music) number(value.music.priority, -2147483648, 2147483647, path + '.music.priority', true)
  }
  if ('environment' in value) {
    const env = value.environment; keys(env, ['priority', 'transition_ticks', 'on_exit', 'effects'], path + '.environment')
    for (const field of REGION_EFFECT_CONTROLS.policy) if (field.key in env) checkField(env[field.key], field, path + '.' + field.label)
    const effects = env.effects; keys(effects, ['fog', 'sky', 'post'], path + '.effects')
    if (!Object.keys(effects).length) fail(path, '环境至少需要一个效果')
    for (const [kind, raw] of Object.entries(effects)) {
      const at = path + '.' + (EFFECT_NAMES[kind as EffectChannel] ?? kind)
      keys(raw, ['scope', 'parameters'], at)
      const scope = raw.scope ?? 'player'
      if (!['player', 'volume'].includes(scope as string) || scope === 'volume' && kind !== 'fog') fail(at, '此效果只支持玩家环境')
      const p = raw.parameters
      if (kind === 'fog') {
        const fields = REGION_EFFECT_CONTROLS.fog.flatMap(g => g.fields)
        keys(p, [...fields.map(f => f.key), 'lights'], at)
        for (const field of fields) if (field.key in p) checkField(p[field.key], field, at + '.' + field.label)
        const units = p.distance_mode ?? 'blocks', start = p.start ?? 0, end = p.end ?? (units === 'blocks' ? 96 : 1)
        if (units === 'render_distance') { number(start, 0, 4, at + '.开始距离'); number(end, .01, 4, at + '.完全遮蔽距离') }
        if ((start as number) >= (end as number)) fail(at, '开始距离必须小于完全遮蔽距离')
        if ('extinction' in p && 'mean_free_path' in p) fail(at, '消光系数和平均自由程只能选一个')
        if (units !== 'blocks' && ('extinction' in p || 'mean_free_path' in p)) fail(at, '光学参数需要方块距离单位')
        if ('night_color' in p && !('color' in p)) fail(at, '夜晚雾色需要先设置白天雾色')
        for (const key of ['albedo', 'emission']) if (key in p && effectColor(p[key])?.alpha !== 1) fail(at, '散射和自发光颜色不接受透明度')
        if ('lights' in p) {
          if (!Array.isArray(p.lights) || p.lights.length > 4) fail(at, '最多设置 4 盏灯光')
          for (const light of p.lights) {
            keys(light, REGION_EFFECT_CONTROLS.lights.map(f => f.key), at + '.灯光')
            if (!('position' in light)) fail(at, '灯光需要位置')
            for (const field of REGION_EFFECT_CONTROLS.lights) if (field.key in light) checkField(light[field.key], field, at + '.' + field.label)
            if (light.direction && (light.direction as number[]).every(n => n === 0)) fail(at, '聚光方向不能为零')
            if (Number(light.inner_angle ?? 20) > Number(light.outer_angle ?? 35)) fail(at, '内锥角不能大于外锥角')
            if ('color' in light && effectColor(light.color)?.alpha !== 1) fail(at, '灯光颜色不接受透明度')
          }
        }
        if (scope === 'volume') {
          if (p.volumetric !== true) fail(at, '空间雾需要启用体积光散射')
          if ((env.on_exit ?? 'restore') !== 'restore') fail(at, '空间雾离开后必须恢复')
          const issue = volumeProblem(areas); if (issue) fail(at, issue)
        }
      } else {
        const listKey = kind === 'sky' ? 'layers' : 'filters'
        keys(p, kind === 'sky' ? ['layers', 'clouds', 'transition'] : ['filters', 'transition'], at)
        const list = p[listKey] ?? []
        if (!Array.isArray(list) || list.length > 8) fail(at, '最多 8 个图层或滤镜')
        list.forEach((ref, i) => {
          checkShader(ref, kind, `${at}[${i}]`)
          if (kind === 'sky' && ['vanilla', 'rpgtoolkit:vanilla'].includes(typeof ref === 'string' ? ref : ref.shader)) {
            if (i !== 0 || object(ref) && ((ref.opacity ?? 1) !== 1 || (ref.blend ?? 'normal') !== 'normal')) fail(at, '原版天空只能作为第一层，混合方式保持正常且可见度为 1')
          }
        })
        if (kind === 'sky' && 'clouds' in p) {
          keys(p.clouds, ['tint', 'opacity', 'height'], at + '.云')
          for (const field of REGION_EFFECT_CONTROLS.clouds) if (field.key in p.clouds) checkField(p.clouds[field.key], field, at + '.' + field.label)
          if ('tint' in p.clouds && effectColor(p.clouds.tint)?.alpha !== 1) fail(at, '云颜色不接受透明度，请调整云层可见度')
        }
        if ('transition' in p) checkShader(p.transition, 'transition', at + '.转场', true)
      }
      if (JSON.stringify(p).length > 32767) fail(at, '单个效果参数过长')
    }
  }
  return cloneEffectValue(effectSections(value as RegionEffectSections))
}

export function defaultChannel(channel: EffectChannel): RegionMusic | { scope: 'player'; parameters: Record<string, unknown> } {
  if (channel === 'music') return { sound: 'minecraft:music.overworld.forest', priority: 0 }
  return { scope: 'player', parameters: channel === 'fog' ? { color: '#A9C4D0', start: 8, end: 96 } : channel === 'sky' ? { layers: ['rpgtoolkit:vanilla'], clouds: {} } : { filters: [{ shader: 'rpgtoolkit:color_grade', params: {} }] } }
}
export function toggleChannel(source: RegionEffectSections, channel: EffectChannel, enabled: boolean): RegionEffectSections {
  const next = cloneEffectValue(source)
  if (channel === 'music') { if (enabled) next.music ??= defaultChannel('music') as RegionMusic; else delete next.music; return next }
  if (enabled) { next.environment ??= { effects: {} }; next.environment.effects[channel] ??= defaultChannel(channel) as { scope: 'player'; parameters: Record<string, unknown> } }
  else if (next.environment) { delete next.environment.effects[channel]; if (!Object.keys(next.environment.effects).length) delete next.environment }
  return next
}
