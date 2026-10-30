import { parseJsonValue } from '../../utils/strictJson'
import { isObject } from './model'

export type ActorDocument = {
  format: 'rpgtoolkit:actor-template'
  version: 1
  scripts: string[]
  tags: string[]
  freezeAi: boolean
}
export const createActor = (): ActorDocument => ({ format: 'rpgtoolkit:actor-template', version: 1, scripts: [], tags: [], freezeAi: false })
export const stringifyActor = (doc: ActorDocument) => JSON.stringify(doc, null, 2)
export function parseActor(source: string): ActorDocument {
  const raw = parseJsonValue(source)
  if (!isObject(raw) || raw.format !== 'rpgtoolkit:actor-template' || raw.version !== 1) throw new Error('需要 rpgtoolkit:actor-template version 1 演员模板')
  if (Object.keys(raw).sort().join(',') !== 'format,freezeAi,scripts,tags,version') throw new Error('演员模板只允许 format、version、scripts、tags、freezeAi 五个字段')
  if (typeof raw.freezeAi !== 'boolean') throw new Error('freezeAi 必须是布尔值')
  if (!Array.isArray(raw.scripts) || raw.scripts.some(id => typeof id !== 'string')) throw new Error('演员脚本引用必须是字符串列表')
  const scripts = (raw.scripts as string[]).map(id => id.trim().normalize('NFC'))
  if (scripts.some(id => !id || id === '.' || id === '..' || /[/\\:]/.test(id) || [...id].some(c => c.charCodeAt(0) < 32 || (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159)))) throw new Error('演员脚本引用必须是 actor 类型的扁平脚本 ID')
  if (new Set(scripts).size !== scripts.length) throw new Error('演员脚本不能重复绑定')
  if (!Array.isArray(raw.tags) || raw.tags.some(tag => typeof tag !== 'string' || !tag.trim())) throw new Error('标签必须是非空字符串列表')
  return { format: raw.format, version: 1, scripts, tags: [...new Set((raw.tags as string[]).map(tag => tag.trim()))], freezeAi: raw.freezeAi }
}
