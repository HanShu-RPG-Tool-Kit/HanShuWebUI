import { effectColor, readRegionEffects, type EffectField, type RegionEffectSections, type ShaderChoice } from './regionEffects'
export type EffectResourceKind = 'sky' | 'post' | 'transition'
export type EffectParam = { type: string; label?: string; default: unknown; min?: number; max?: number; filter?: string; wrap?: string }
export type EffectResource = { kind: EffectResourceKind; id: string; manifest: { description?: string; params?: Record<string, EffectParam>; targets?: unknown; passes?: unknown }; source: string }
export const EFFECT_PRESETS_PATH = 'meta/region-effect-presets.json'
export type EffectPreset = { id: string; title: string; effects: RegionEffectSections }
export const EFFECT_SOURCE_MAX = 65536
export function effectResourcePaths(kind: EffectResourceKind, id: string): [string, string] {
  if (!['sky', 'post', 'transition'].includes(kind) || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(id) || id.length > 256 || id === 'rpgtoolkit:vanilla' || id.startsWith('rpgtoolkit_editor:')) throw Error('资源ID应为 namespace:path，不能使用原版天空或编辑器临时ID')
  const [ns, path] = id.split(':')
  if ([ns, ...path.split('/')].some(p => !p || p === '.' || p === '..' || p.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw Error('资源路径含保留名称或无效目录')
  const base = `assets/${ns}/rpgtoolkit/effects/${kind}/${path}`
  return [base + '.json', base + '.glsl']
}
export function createEffectResource(kind: EffectResourceKind = 'post'): EffectResource {
  return { kind, id: `project:custom_${kind}`, manifest: { description: kind === 'sky' ? '自定义天空' : kind === 'post' ? '自定义画面滤镜' : '自定义转场', params: kind === 'transition'
    ? { curve: { type: 'float', label: '过渡曲线', default: 1, min: .1, max: 4 } }
    : { tint: { type: 'color', label: '效果染色', default: '#9ecbff' }, amount: { type: 'float', label: '混合强度', default: .5, min: 0, max: 1 } } }, source: kind === 'sky'
    ? '// 框架提供 GLSL 版本、常用变量和参数，直接编写 sky。\nvec4 sky(vec3 dir) {\n    float horizon = pow(1.0 - abs(dir.y), 2.0);\n    return vec4(mix(tint.rgb * 0.25, tint.rgb, horizon), amount);\n}\n'
    : kind === 'post' ? '// rpg_scene 读取当前世界画面。\nvec4 process(vec2 uv) {\n    vec4 scene = rpg_scene(uv);\n    return vec4(mix(scene.rgb, scene.rgb * tint.rgb, amount), scene.a);\n}\n'
      : '// progress 从 0 过渡到 1。\nvec4 transition(vec2 uv) {\n    return mix(getFromColor(uv), getToColor(uv), pow(progress, curve));\n}\n' }
}
export function validateEffectResource(value: EffectResource): void {
  effectResourcePaths(value.kind, value.id)
  if (!value.source.trim() || value.source.length > EFFECT_SOURCE_MAX) throw Error('GLSL源码限1–65536字符')
  const m = value.manifest
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw Error('参数定义应为对象')
  for (const key of Object.keys(m)) if (!['description', 'params', 'targets', 'passes'].includes(key)) throw Error(`未知效果定义字段：${key}`)
  if (JSON.stringify(m).length > 32767) throw Error('效果定义超过32767字符')
  if (m.description !== undefined && (typeof m.description !== 'string' || m.description.length > 2048)) throw Error('显示名称需要文本，最多2048字符')
  const params = m.params ?? {}
  if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).length > 16) throw Error('最多16个参数')
  for (const [name, p] of Object.entries(params)) {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(name) || name.startsWith('rpg') || name.startsWith('gl_')) throw Error(`参数名 ${name} 无效，请使用小写字母、数字和下划线`)
    if (!p || typeof p !== 'object' || !['float', 'vec2', 'vec3', 'vec4', 'color', 'bool', 'texture'].includes(p.type)) throw Error(`参数 ${name} 类型无效`)
    for (const key of Object.keys(p)) if (!['type','label','default','min','max','filter','wrap'].includes(key)) throw Error(`未知参数定义字段：${name}.${key}`)
    if (p.filter !== undefined && (p.type !== 'texture' || !['linear','nearest'].includes(p.filter)) || p.wrap !== undefined && (p.type !== 'texture' || !['clamp','repeat'].includes(p.wrap))) throw Error(`${name} 贴图采样方式无效`)
    if (p.label !== undefined && (typeof p.label !== 'string' || !p.label.trim() || p.label.length > 80)) throw Error('参数中文标签需要1–80个字符')
    if (p.type === 'float' && (typeof p.default !== 'number' || !Number.isFinite(p.default))) throw Error(`${name} 默认值需要有限数字`)
    if (p.type === 'bool' && typeof p.default !== 'boolean') throw Error(`${name} 默认值需要开关`)
    if (p.type === 'color' && !effectColor(p.default)) throw Error(`${name} 默认颜色无效`)
    if (p.type === 'texture' && (typeof p.default !== 'string' || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(p.default))) throw Error(`${name} 贴图资源ID无效`)
    if (p.type.startsWith('vec') && (!Array.isArray(p.default) || p.default.length !== Number(p.type.slice(3)) || p.default.some(n => typeof n !== 'number' || !Number.isFinite(n)))) throw Error(`${name} 默认向量无效`)
    if (p.min !== undefined && !Number.isFinite(p.min) || p.max !== undefined && !Number.isFinite(p.max) || p.min !== undefined && p.max !== undefined && p.min > p.max) throw Error(`${name} 范围无效`)
    if (['float', 'vec2', 'vec3', 'vec4'].includes(p.type)) for (const n of Array.isArray(p.default) ? p.default : [p.default]) if (p.min !== undefined && Number(n) < p.min || p.max !== undefined && Number(n) > p.max) throw Error(`${name} 默认值超出范围`)
    if (!['float', 'vec2', 'vec3', 'vec4'].includes(p.type) && (p.min !== undefined || p.max !== undefined)) throw Error(`${name} 的类型不使用数字范围`)
  }
  if (Object.values(params).filter(p=>p.type==='texture').length>4) throw Error('最多4个贴图参数')
  validatePipeline(value)
}
function validatePipeline(value: EffectResource) {
  const { targets, passes } = value.manifest
  if (targets===undefined&&passes===undefined) return
  if (value.kind!=='post') throw Error('只有画面滤镜可以配置渲染步骤和缓冲图')
  const object = (v: unknown): v is Record<string,unknown> => !!v&&typeof v==='object'&&!Array.isArray(v)
  const buffers = targets??{}
  if (!object(buffers)||Object.keys(buffers).length>4) throw Error('最多4个中间缓冲图')
  const validName = (s: unknown) => typeof s==='string'&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)&&!s.includes('__')&&!/^(rpg|gl_)/i.test(s)
  for(const [name,target] of Object.entries(buffers)){
    if(!validName(name)||value.manifest.params?.[name])throw Error(`缓冲图名称 ${name} 无效或与参数重名`)
    if(!object(target)||Object.keys(target).some(k=>k!=='scale'))throw Error(`缓冲图 ${name} 定义无效`)
    const scale=target.scale??1
    if(typeof scale!=='number'||!Number.isFinite(scale)||scale<.0625||scale>1)throw Error(`${name} 分辨率比例需在 0.0625–1 之间`)
  }
  if(passes===undefined){if(Object.keys(buffers).length)throw Error('添加缓冲图后需要配置处理步骤');return}
  if(!Array.isArray(passes)||!passes.length||passes.length>8)throw Error('需要1–8个处理步骤')
  for(const [i,pass] of passes.entries()){
    const label=`步骤 ${i+1}`
    if(!object(pass)||Object.keys(pass).some(k=>!['entry','inputs','output'].includes(k)))throw Error(`${label} 定义无效`)
    if(!validName(pass.entry)||Object.hasOwn(buffers,String(pass.entry))||value.manifest.params?.[String(pass.entry)])throw Error(`${label} 入口函数名称无效或重名`)
    const inputs=pass.inputs??[]
    if(!Array.isArray(inputs)||inputs.some(n=>typeof n!=='string'||!Object.hasOwn(buffers,n))||new Set(inputs).size!==inputs.length)throw Error(`${label} 读取的缓冲图不存在或重复`)
    if(i===passes.length-1){if(pass.output!==undefined)throw Error('最后一步必须输出最终画面')}
    else if(typeof pass.output!=='string'||!Object.hasOwn(buffers,pass.output))throw Error(`${label} 需要选择输出缓冲图`)
    if(pass.output!==undefined&&inputs.includes(pass.output))throw Error(`${label} 不能同时读写同一缓冲图`)
  }
}
export function effectResourceChoice(resource: EffectResource): ShaderChoice {
  return { id: resource.id, kind: resource.kind, label: resource.manifest.description || resource.id, params: Object.entries(resource.manifest.params ?? {}).map(([key, p]) => ({ ...p, key, label: p.label || `资源参数 · ${key}`, type: p.type === 'float' ? 'number' : p.type === 'bool' ? 'boolean' : p.type, step: .01 } as EffectField)) }
}
export function readEffectPresets(raw: string | null): EffectPreset[] {
  if (raw === null) return []
  if (raw.length > 262144) throw Error('自定义方案库超过256KiB')
  const data = JSON.parse(raw) as { v?: number; presets?: EffectPreset[] }
  if (data.v !== 1 || !Array.isArray(data.presets) || data.presets.length > 100) throw Error('自定义方案库格式无效（最多100个）')
  const ids = new Set<string>()
  for (const p of data.presets) {
    if (!p || typeof p.id !== 'string' || !p.id || ids.has(p.id) || typeof p.title !== 'string' || !p.title.trim() || p.title.length > 80) throw Error('自定义方案名称或标识无效')
    ids.add(p.id); readRegionEffects(p.effects as Record<string, unknown>, [{ kind: 'rect', x: [0, 1], z: [0, 1], y: [0, 1] }], p.title)
  }
  return data.presets
}

/** Only referenced sources enter an audition bundle. Unrelated broken drafts cannot block a region. */
export function referencedEffects(effects: RegionEffectSections): Set<string> {
  const result = new Set<string>()
  const add = (kind: EffectResourceKind, ref: unknown) => {
    const id = typeof ref === 'string' ? ref : (ref as { shader?: string } | null)?.shader
    if (id) result.add(`${kind}/${id.includes(':') ? id : `rpgtoolkit:${id}`}`)
  }
  for (const kind of ['sky', 'post'] as const) {
    const p = effects.environment?.effects[kind]?.parameters
    for (const ref of (p?.[kind === 'sky' ? 'layers' : 'filters'] ?? []) as unknown[]) add(kind, ref)
    add('transition', p?.transition)
  }
  return result
}
