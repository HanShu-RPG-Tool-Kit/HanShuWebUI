import { isObject } from './model'
import {
  isScriptDocument,
  parseSectionFolderKey,
  sectionFolderKey,
  ensurePackageSections,
  BUILTIN_GOAL_FOLDER_KEY,
  builtinGoalDocumentKey,
  isBuiltinGoalDocumentKey,
  isBuiltinGoalFolder,
} from './library'
import { stampDocument, type FlowDocument, type FlowFolder, type FlowWorkspaceState } from './storage'
import { BUILTIN_GOAL_DEFINITION_SCRIPTS } from './builtinGoals'

export {
  BUILTIN_GOAL_FOLDER_KEY,
  builtinGoalDocumentKey,
  isBuiltinGoalDocumentKey,
  isBuiltinGoalFolder,
} from './library'

export { BUILTIN_GOAL_DEFINITION_SCRIPTS } from './builtinGoals'

export type GoalConfigFieldType = 'string' | 'int' | 'float' | 'bool'
export type GoalConfigValue = string | number | boolean

/** 对应脚本里 field("key", "type", ...) */
export type GoalConfigField = {
  key: string
  type: GoalConfigFieldType
  required: boolean
  default?: GoalConfigValue
  hint?: string
  label?: string
}

export type GoalDefinition = {
  /** @goal("…") 的唯一标识 */
  kind: string
  /** 展示名：优先类名，否则 kind */
  label: string
  fields: GoalConfigField[]
  /** 来源脚本文档 key；内置种子可为 null */
  sourceKey: string | null
  sourceName: string
  error?: string
}

export type GoalDefinitionCatalog = {
  definitions: GoalDefinition[]
  byKind: Map<string, GoalDefinition>
  errors: { sourceKey: string; sourceName: string; message: string }[]
}

const GOAL_TYPES: GoalConfigFieldType[] = ['string', 'int', 'float', 'bool']

function isFieldType(value: string): value is GoalConfigFieldType {
  return (GOAL_TYPES as string[]).includes(value)
}

/**
 * 从目标定义 py 源码抽出 @goal / @config(field…)。
 * 只做装饰器表层解析，不跑 Python。
 */
export function parseGoalDefinitionsFromSource(source: string, meta: { sourceKey: string | null; sourceName: string }): GoalDefinition[] {
  const text = source.replace(/\r\n/g, '\n')
  const defs: GoalDefinition[] = []
  const goalRe = /@goal\(\s*(['"])([^'"\n]+)\1\s*\)/g
  let match: RegExpExecArray | null
  while ((match = goalRe.exec(text))) {
    const kind = match[2]!.trim()
    if (!kind) continue
    const after = text.slice(match.index + match[0].length).split(/@goal\s*\(/, 1)[0]!
    const fields = parseConfigBlock(after.split(/\bclass\s+/, 1)[0]!)
    const className = /^[\s\S]*?\bclass\s+([A-Za-z_][\w]*)/.exec(after)?.[1]
    const label = className
      ? className.replace(/Goal$/, '').replace(/([a-z])([A-Z])/g, '$1 $2')
      : kind
    defs.push({
      kind,
      label,
      fields,
      sourceKey: meta.sourceKey,
      sourceName: meta.sourceName,
    })
  }
  return defs
}

function parseConfigBlock(afterGoal: string): GoalConfigField[] {
  const configMatch = /@config\(\s*([\s\S]*?)\n\s*\)/.exec(afterGoal)
    ?? /@config\(\s*([\s\S]*?)\)\s*(?:@|$)/.exec(afterGoal)
  if (!configMatch) return []
  const body = configMatch[1] ?? ''
  const fields: GoalConfigField[] = []
  const fieldRe = /field\(\s*(['"])([^'"\n]+)\1\s*,\s*(['"])([^'"\n]+)\3\s*([^)]*)\)/g
  let fieldMatch: RegExpExecArray | null
  while ((fieldMatch = fieldRe.exec(body))) {
    const key = fieldMatch[2]!.trim()
    const typeRaw = fieldMatch[4]!.trim()
    if (!key || !isFieldType(typeRaw)) continue
    const kwargs = fieldMatch[5] ?? ''
    const required = /\brequired\s*=\s*True\b/.test(kwargs)
    const hint = readKwString(kwargs, 'hint')
    const label = readKwString(kwargs, 'label')
    const defaultValue = readKwDefault(kwargs, typeRaw)
    fields.push({
      key,
      type: typeRaw,
      required,
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      ...(hint ? { hint } : {}),
      ...(label ? { label } : { label: key }),
    })
  }
  return fields
}

function readKwString(kwargs: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(['"])([^'"\\n]*)\\1`).exec(kwargs)
  return match ? match[2] : undefined
}

function readKwDefault(kwargs: string, type: GoalConfigFieldType): GoalConfigValue | undefined {
  if (!/\bdefault\s*=/.test(kwargs)) return undefined
  if (/\bdefault\s*=\s*True\b/.test(kwargs)) return true
  if (/\bdefault\s*=\s*False\b/.test(kwargs)) return false
  const str = readKwString(kwargs, 'default')
  if (str !== undefined) return str
  const num = /\bdefault\s*=\s*(-?\d+(?:\.\d+)?)\b/.exec(kwargs)
  if (num) {
    const value = Number(num[1])
    return type === 'int' ? Math.trunc(value) : value
  }
  if (/\bdefault\s*=\s*None\b/.test(kwargs)) return type === 'string' ? '' : type === 'bool' ? false : 0
  return undefined
}

export function defaultConfigFromFields(fields: GoalConfigField[]): Record<string, GoalConfigValue> {
  const config: Record<string, GoalConfigValue> = {}
  for (const field of fields) {
    if (field.default !== undefined) config[field.key] = field.default
    else if (field.type === 'bool') config[field.key] = false
    else if (field.type === 'int' || field.type === 'float') config[field.key] = 0
    else config[field.key] = ''
  }
  return config
}

/** 文档是否落在「脚本 / 目标定义」及其子文件夹下。 */
export function isGoalDefinitionDocument(state: FlowWorkspaceState, document: FlowDocument): boolean {
  if (document.package !== 'script' || !isScriptDocument(document)) return false
  let current = document.folderId ?? null
  while (current) {
    if (parseSectionFolderKey(current)?.sectionId === 'goal-def') return true
    current = state.folders.find((folder) => folder.key === current)?.parentId ?? null
  }
  return false
}

/** 「目标定义 / 内置」虚拟文件夹（稳定键，不进 UI 持久化）。 */
export function builtinGoalDefinitionFolder(): FlowFolder {
  return {
    key: BUILTIN_GOAL_FOLDER_KEY,
    name: '内置',
    parentId: sectionFolderKey('script', 'goal-def'),
    package: 'script',
  }
}

export function builtinGoalDefinitionDocuments(): FlowDocument[] {
  return BUILTIN_GOAL_DEFINITION_SCRIPTS.map((item) => stampDocument({
    key: builtinGoalDocumentKey(item.name),
    name: item.name,
    source: item.source,
    package: 'script',
    folderId: BUILTIN_GOAL_FOLDER_KEY,
  }))
}

/** 把虚拟内置文件夹与脚本叠进工作区视图（不落盘）。 */
export function withBuiltinGoalDefinitions(state: FlowWorkspaceState): FlowWorkspaceState {
  const next = ensurePackageSections(state)
  const folder = builtinGoalDefinitionFolder()
  const builtins = builtinGoalDefinitionDocuments()
  const folders = next.folders.some((item) => item.key === folder.key)
    ? next.folders
    : [...next.folders, folder]
  const existing = new Set(next.documents.map((document) => document.key))
  const documents = [
    ...next.documents,
    ...builtins.filter((document) => !existing.has(document.key)),
  ]
  return { ...next, folders, documents }
}

/** 去掉虚拟内置项，避免写入工程 / UI 状态。 */
export function stripBuiltinGoalDefinitions(state: FlowWorkspaceState): FlowWorkspaceState {
  return {
    ...state,
    documents: state.documents.filter((document) => !isBuiltinGoalDocumentKey(document.key)),
    folders: state.folders.filter((folder) => !isBuiltinGoalFolder(folder.key)),
  }
}

/**
 * 目标定义管理器：扫描「目标定义」下的 .py（含虚拟内置），解析为 kind 目录。
 * 先收内置，再收工程脚本 —— 同 kind 时工程侧覆盖内置。
 */
export function buildGoalDefinitionCatalog(state: FlowWorkspaceState): GoalDefinitionCatalog {
  const view = withBuiltinGoalDefinitions(state)
  const definitions: GoalDefinition[] = []
  const errors: GoalDefinitionCatalog['errors'] = []
  const byKind = new Map<string, GoalDefinition>()

  const ingest = (document: FlowDocument) => {
    try {
      const parsed = parseGoalDefinitionsFromSource(document.source, {
        sourceKey: document.key,
        sourceName: document.name,
      })
      if (!parsed.length) {
        errors.push({ sourceKey: document.key, sourceName: document.name, message: '未找到 @goal(…) 声明' })
        return
      }
      for (const def of parsed) {
        if (byKind.has(def.kind) && !isBuiltinGoalDocumentKey(document.key)) {
          errors.push({
            sourceKey: document.key,
            sourceName: document.name,
            message: `goal kind「${def.kind}」重复，已用较后的定义覆盖`,
          })
        }
        byKind.set(def.kind, def)
      }
    } catch (error) {
      errors.push({
        sourceKey: document.key,
        sourceName: document.name,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // 内置先入；工程脚本后入以覆盖同 kind
  for (const document of view.documents) {
    if (!isBuiltinGoalDocumentKey(document.key)) continue
    if (!isGoalDefinitionDocument(view, document)) continue
    ingest(document)
  }
  for (const document of view.documents) {
    if (isBuiltinGoalDocumentKey(document.key)) continue
    if (!isGoalDefinitionDocument(view, document)) continue
    ingest(document)
  }

  for (const def of byKind.values()) definitions.push(def)
  definitions.sort((a, b) => a.kind.localeCompare(b.kind, 'en'))
  return { definitions, byKind, errors }
}

export function lookupGoalDefinition(catalog: GoalDefinitionCatalog, kind: string): GoalDefinition | undefined {
  return catalog.byKind.get(kind)
}

export function isGoalDefinitionCatalog(value: unknown): value is GoalDefinitionCatalog {
  return isObject(value) && Array.isArray(value.definitions) && value.byKind instanceof Map
}
