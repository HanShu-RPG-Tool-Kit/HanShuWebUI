import { isObject } from './model'
import { isScriptDocument, parseSectionFolderKey, sectionFolderKey, ensurePackageSections } from './library'
import { stampDocument, type FlowDocument, type FlowWorkspaceState } from './storage'

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
    const after = text.slice(match.index + match[0].length)
    const fields = parseConfigBlock(after)
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
    ?? /@config\(\s*([\s\S]*?)\)\s*(?:@|\bclass\b)/.exec(afterGoal)
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

/**
 * 目标定义管理器：扫描工作区「目标定义」下的 .py，解析为 kind 目录。
 * 同 kind 后者覆盖前者，并记一条错误。
 */
export function buildGoalDefinitionCatalog(state: FlowWorkspaceState): GoalDefinitionCatalog {
  const definitions: GoalDefinition[] = []
  const errors: GoalDefinitionCatalog['errors'] = []
  const byKind = new Map<string, GoalDefinition>()

  for (const document of state.documents) {
    if (!isGoalDefinitionDocument(state, document)) continue
    try {
      const parsed = parseGoalDefinitionsFromSource(document.source, {
        sourceKey: document.key,
        sourceName: document.name,
      })
      if (!parsed.length) {
        errors.push({ sourceKey: document.key, sourceName: document.name, message: '未找到 @goal(…) 声明' })
        continue
      }
      for (const def of parsed) {
        if (byKind.has(def.kind)) {
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

  for (const def of byKind.values()) definitions.push(def)
  definitions.sort((a, b) => a.kind.localeCompare(b.kind, 'en'))
  return { definitions, byKind, errors }
}

export function lookupGoalDefinition(catalog: GoalDefinitionCatalog, kind: string): GoalDefinition | undefined {
  return catalog.byKind.get(kind)
}

/** 内置样例脚本：仅在「目标定义」下还没有任何 .py 时写入，可改可删。 */
export const BUILTIN_GOAL_DEFINITION_SCRIPTS: { name: string; source: string }[] = [
  {
    name: 'core_dialogue_choice.py',
    source: `# core:dialogue_choice — satisfy when a specific dialogue choice id is accepted.
PlayerDialogueEvent = java_type("mchhui.rpgtoolkit.feature.talk.PlayerDialogueEvent")
ServerPlayer = java_type("net.minecraft.server.level.ServerPlayer")


@goal("core:dialogue_choice")
@config(
    field("choice", "string", required=True, hint="dialogue_choice"),
    field("node", "string", default="", hint="dialogue_node"),
)
@state(
    field("have", "int", default=0),
)
class DialogueChoiceGoal(BaseGoalPy):
    @subscribe(PlayerDialogueEvent)
    def on_dialogue(self, instance, event):
        p = event.getPlayer()
        if not instanceof(p, ServerPlayer) or not instance.isOwner(p):
            return
        if str(cfg.choice) != str(event.getChoiceId()):
            return
        if cfg.node and str(cfg.node) != str(event.getNodeId()):
            return
        st.have = 1

    def update_state(self, instance):
        self.update_satisfied_state(instance, st.have >= 1)
`,
  },
  {
    name: 'core_manual.py',
    source: `# core:manual — author / GM marks satisfied.

@goal("core:manual")
@config()
class ManualGoal(BaseGoalPy):
    def update_state(self, instance):
        self.update_satisfied_state(instance, False)
`,
  },
  {
    name: 'core_counter.py',
    source: `# core:counter — reach a numeric target (event wiring is engine-side).

@goal("core:counter")
@config(
    field("event", "string", required=True, hint="event_id"),
    field("target", "int", default=1),
)
@state(
    field("count", "int", default=0),
)
class CounterGoal(BaseGoalPy):
    def update_state(self, instance):
        self.update_satisfied_state(instance, st.count >= int(cfg.target))
`,
  },
]

/** 若目标定义分区下尚无脚本，生成内置样例（写入本机草稿库）。 */
export function ensureBuiltinGoalDefinitions(state: FlowWorkspaceState): FlowWorkspaceState {
  const next = ensurePackageSections(state)
  const section = sectionFolderKey('script', 'goal-def')
  const hasGoalScript = next.documents.some((document) => isGoalDefinitionDocument(next, document))
  if (hasGoalScript) return next
  const documents = [...next.documents]
  for (const item of BUILTIN_GOAL_DEFINITION_SCRIPTS) {
    if (documents.some((document) => document.package === 'script' && document.name === item.name)) continue
    documents.push(stampDocument({
      key: crypto.randomUUID(),
      name: item.name,
      source: item.source,
      package: 'script',
      folderId: section,
    }))
  }
  return { ...next, documents }
}

export function isGoalDefinitionCatalog(value: unknown): value is GoalDefinitionCatalog {
  return isObject(value) && Array.isArray(value.definitions) && value.byKind instanceof Map
}
