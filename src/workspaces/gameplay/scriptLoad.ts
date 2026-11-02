import { parseJsonValue } from '../../utils/strictJson'
import { isScriptLoadFileName } from '../../workspace'
import { parseFlatResourceId } from './actor'
import { isObject } from './model'

/** 需要有序启动列表的脚本类型（通用／玩家）。 */
export const SCRIPT_LOAD_TYPES = ['common', 'player'] as const
export type ScriptLoadType = (typeof SCRIPT_LOAD_TYPES)[number]

export type ScriptLoadDocument = {
  format: 'rpgtoolkit:script-load'
  version: 1
  scripts: string[]
}

export const SCRIPT_LOAD_FILE_NAME = 'load.json'
/** 按脚本类型区分的虚入口显示名（资源树／页签）。 */
export const SCRIPT_LOAD_LABELS = {
  common: '通用启动列表',
  player: '玩家启动列表',
} as const satisfies Record<ScriptLoadType, string>
export const scriptLoadLabel = (type: ScriptLoadType) => SCRIPT_LOAD_LABELS[type]
/** @deprecated 请用 scriptLoadLabel(type)；保留作泛称。 */
export const SCRIPT_LOAD_LABEL = '启动列表'

export const isScriptLoadType = (value: string | null | undefined): value is ScriptLoadType =>
  SCRIPT_LOAD_TYPES.includes(value as ScriptLoadType)

export { isScriptLoadFileName }

export const scriptLoadPath = (type: ScriptLoadType) => `src/script/${type}/${SCRIPT_LOAD_FILE_NAME}`

export const scriptLoadDocumentKey = (type: ScriptLoadType) => `builtin:script-load:${type}`

export const isScriptLoadDocumentKey = (key: string) => key.startsWith('builtin:script-load:')

export function scriptLoadTypeOfKey(key: string): ScriptLoadType | null {
  if (!isScriptLoadDocumentKey(key)) return null
  const type = key.slice('builtin:script-load:'.length)
  return isScriptLoadType(type) ? type : null
}

export function scriptLoadTypeOfSource(source: { name: string; srcKind?: string | null }): ScriptLoadType | null {
  if (!isScriptLoadFileName(source.name)) return null
  return isScriptLoadType(source.srcKind) ? source.srcKind : null
}

export const createScriptLoad = (): ScriptLoadDocument => ({
  format: 'rpgtoolkit:script-load',
  version: 1,
  scripts: [],
})

export function stringifyScriptLoad(doc: ScriptLoadDocument): string {
  return `${JSON.stringify({
    format: 'rpgtoolkit:script-load',
    version: 1,
    scripts: doc.scripts,
  }, null, 2)}\n`
}

export function parseScriptLoad(source: string): ScriptLoadDocument {
  const raw = parseJsonValue(source.trim() ? source : '{"format":"rpgtoolkit:script-load","version":1,"scripts":[]}')
  if (!isObject(raw) || raw.format !== 'rpgtoolkit:script-load' || raw.version !== 1) {
    throw new Error('需要 rpgtoolkit:script-load version 1 启动列表')
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'format' && key !== 'version' && key !== 'scripts') throw new Error(`未知启动列表字段：${key}`)
  }
  if (!Array.isArray(raw.scripts) || raw.scripts.some(id => typeof id !== 'string')) {
    throw new Error('启动列表 scripts 必须是字符串数组')
  }
  const scripts = (raw.scripts as string[]).map(id => parseFlatResourceId(id, '启动脚本引用'))
  if (new Set(scripts).size !== scripts.length) throw new Error('启动列表不能重复引用同一脚本')
  return { format: 'rpgtoolkit:script-load', version: 1, scripts }
}

export function readScriptLoadSource(source: string): { doc: ScriptLoadDocument | null; error: string } {
  try {
    return { doc: parseScriptLoad(source), error: '' }
  } catch (cause) {
    return { doc: null, error: cause instanceof Error ? cause.message : String(cause) }
  }
}

/** 工程＋有效内置脚本 id（无 .js），供启动列表候选与缺失校验。 */
export function scriptLoadCandidateIds(
  type: ScriptLoadType,
  scripts: readonly { name: string; srcKind?: string | null }[],
): Set<string> {
  return new Set(
    scripts
      .filter(script => script.srcKind === type && script.name.toLowerCase().endsWith('.js'))
      .map(script => script.name.slice(0, -3)),
  )
}
