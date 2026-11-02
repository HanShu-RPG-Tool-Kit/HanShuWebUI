import {transformDialect} from '../../monaco/javascript/dialect'
import { isObject } from './model'
import {isScriptDocument,scriptTypeInFolder,isBuiltinScriptDocumentKey} from './library'
import {type FlowDocument,type FlowWorkspaceState} from './storage'
import {BUILTIN_SCRIPTS} from '../../scriptResources'
import {withBuiltinScripts} from './scriptResources'
import { parseGoalHeaderMeta } from './goalWidgets/header'
import type { GoalLocaleEntry } from './goalWidgets/locale'
import type { GoalWidgetSpec } from './goalWidgets/types'
import { pickGoalLocaleName } from './goalWidgets/locale'
export {isBuiltinScriptDocumentKey,isBuiltinScriptFolder} from './library'
export {withBuiltinScripts,stripBuiltinScripts} from './scriptResources'
export const BUILTIN_GOAL_DEFINITION_SCRIPTS=BUILTIN_SCRIPTS.filter(s=>s.type==='goal')

export type GoalConfigFieldType = 'string' | 'int' | 'float' | 'bool'
export type GoalConfigValue = string | number | boolean

/** 对应脚本里 field("key", "type", ...)；文案与 widget 来自文件头 JSON（可选）。 */
export type GoalConfigField = {
  key: string
  type: GoalConfigFieldType
  required: boolean
  default?: GoalConfigValue
  hint?: string
  label?: string
  labels?: Record<string, GoalLocaleEntry>
  widget?: GoalWidgetSpec
}

export type GoalDefinition = {
  /** @goal("…") 的唯一标识 */
  kind: string
  /** 展示名：优先类名，否则 kind；有文件头 labels 时由 UI 按 locale 覆盖 */
  label: string
  labels?: Record<string, GoalLocaleEntry>
  /** WebUI 预览模板；非运行时权威 */
  localize?: Record<string, string>
  fields: GoalConfigField[]
  /** Literal JavaScript declaration, not presentation metadata. */
  requiresDelivery?: boolean
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

function normalizeFieldType(value: string): GoalConfigFieldType | null {
  if (value === 'double') return 'float'
  return (GOAL_TYPES as string[]).includes(value) ? (value as GoalConfigFieldType) : null
}

export function localizedGoalDefinitionLabel(definition: GoalDefinition, locale: string): string {
  return pickGoalLocaleName(definition.labels, locale, definition.label || definition.kind)
}

/** Parse only dialect metadata. Author code is never evaluated by WebUI. */
export function parseGoalDefinitionsFromSource(source: string, meta: { sourceKey: string | null; sourceName: string }): GoalDefinition[] {
  const result = transformDialect(source)
  if (!result.goal) {
    if (result.diagnostics.length) throw Error(result.diagnostics.map(d => `第 ${d.line} 行：${d.message}`).join('；'))
    return []
  }
  const goal = result.goal
  const fields: GoalConfigField[] = goal.config.map(field => ({
    key: field.name,
    type: normalizeFieldType(field.type)!,
    required: field.required,
    label: field.name,
    ...(field.defaultValue !== null ? {default: field.defaultValue} : {}),
  }))
  return [applyGoalHeaderMeta({
    kind: goal.id, label: goal.id, fields, requiresDelivery: goal.requiresDelivery, ...meta,
    ...(result.diagnostics.length ? {error:result.diagnostics.map(d => `第 ${d.line} 行：${d.message}`).join('；')} : {}),
  }, parseGoalHeaderMeta(source))]
}

/** 把文件头 labels / widget / localize 叠到 config 字段上；头与配置声明不一致时仍保留运行时字段。 */
export function applyGoalHeaderMeta(definition: GoalDefinition, header: ReturnType<typeof parseGoalHeaderMeta>): GoalDefinition {
  if (!header) return definition
  const labels = header.labels
  const localize = header.localize
  const fields = definition.fields.map((field) => {
    const param = header.params?.[field.key]
    if (!param) return field
    return {
      ...field,
      ...(param.labels ? { labels: param.labels } : {}),
      ...(param.widget ? { widget: param.widget } : {}),
      ...(param.labels?.zh_cn?.name || param.labels?.en_us?.name
        ? { label: pickGoalLocaleName(param.labels, 'zh_cn', field.label || field.key) }
        : {}),
    }
  })
  return {
    ...definition,
    ...(labels ? { labels } : {}),
    ...(localize ? { localize } : {}),
    ...(labels ? { label: pickGoalLocaleName(labels, 'zh_cn', definition.label) } : {}),
    fields,
  }
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
  return scriptTypeInFolder(state,document.folderId??null)==='goal'
}

/**
 * 目标定义管理器：扫描「目标定义」下的 .js（含虚拟内置），解析为 kind 目录。
 * 先按类型和文件名应用工程整文件覆盖，再解析有效脚本；不同文件的类型 ID 冲突单独报告。
 */
export function buildGoalDefinitionCatalog(state: FlowWorkspaceState): GoalDefinitionCatalog {
  const view = withBuiltinScripts(state)
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
        errors.push({ sourceKey: document.key, sourceName: document.name, message: '未找到 @goal / @config / @state 文件级元数据块' })
        return
      }
      for (const def of parsed) {
        if (def.error) errors.push({ sourceKey: document.key, sourceName: document.name, message: `${def.kind}：${def.error}` })
        if (byKind.has(def.kind) && !isBuiltinScriptDocumentKey(document.key)) {
          def.error = `goal 类型「${def.kind}」在不同有效脚本中重复，请修改定义 ID`
          errors.push({
            sourceKey: document.key,
            sourceName: document.name,
            message: `goal 类型「${def.kind}」在不同有效脚本中重复，请修改定义 ID`,
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

  // 有效内置先入；工程定义后入，重复 ID 会保留诊断。
  for (const document of view.documents) {
    if (!isBuiltinScriptDocumentKey(document.key)) continue
    if (!isGoalDefinitionDocument(view, document)) continue
    ingest(document)
  }
  for (const document of view.documents) {
    if (isBuiltinScriptDocumentKey(document.key)) continue
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
