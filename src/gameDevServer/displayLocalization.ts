import { getProjectSession, setProjectSession } from '../project/projectSession'
import type { FileEdit, ProjectClient } from '../project/serviceClient'
import { randomId } from '../project/crypto'
import { registerAsset, sourcePathOf } from '../workspace'
import { putAssetBlob } from '../assets/idb'
import { textAssetPath } from '../i18n/localeLayout'
import { stringifyTextFile, TEXT_ASSET_MIME } from '../i18n/textMap'
import { formatLocaleTag } from '../i18n/locales'
import { loadLocale } from '../storage'
import { displayTextBindings, displayTextFields, getDisplayText, type DisplayTextDocument, type DisplayTextKind } from '../workspaces/quest/displayTextLocale'
import { decodeTextComponent } from '../textComponent/codec'
import type { ItemDocument } from '../workspaces/quest/itemDoc'
import type { EntityDocument } from '../workspaces/quest/entityDoc'
import { LOCALIZATION_PROTOCOL, type LocalizationOpen } from './displayLocalizationProtocol'
export { LOCALIZATION_PROTOCOL, supportsDisplayLocalization, type LocalizationBinding, type LocalizationOpen } from './displayLocalizationProtocol'

export type LocaleTable = { path: string; content: string | null; version: string | null; values: Record<string, string>; staged?: boolean }
export type LocalizationSession = {
  client: ProjectClient; documentKey: string; sourcePath: string; source: string; sourceVersion: string | null
  kind: DisplayTextKind; tables: Map<string, LocaleTable>; localization: LocalizationOpen
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
/** Reject malformed assets rather than replacing them with an empty translation table. */
export function readLocaleTable(content: string | null): Record<string, string> {
  if (content === null) return {}
  const parsed: unknown = JSON.parse(content)
  if (!record(parsed) || Object.values(parsed).some(value => typeof value !== 'string')) throw Error('语言资产必须是字符串值 JSON 对象')
  return parsed as Record<string, string>
}
export function projectDisplayLocales(client: ProjectClient, activeLocale: string): string[] {
  const assets = getProjectSession().workspace.packages.flatMap(pkg => pkg.assets.map(asset => asset.path))
  const locales = [...client.tree.entries.map(entry => entry.path), ...assets, ...client.transactions.stagedWrites().map(edit => edit.path)]
    .flatMap(path => /^assets\/([^/]+)\/(?:lang|voice)_[^/]+\//.exec(path)?.[1] ?? [])
  return [...new Set([activeLocale, ...locales].map(formatLocaleTag).filter(Boolean))].sort()
}
export async function loadDisplayLocaleTables(client: ProjectClient, name: string, locales: readonly string[]): Promise<Map<string, LocaleTable>> {
  return new Map<string, LocaleTable>(await Promise.all(locales.map(async (locale): Promise<readonly [string, LocaleTable]> => {
    const path = textAssetPath(locale, name)
    const staged = client.transactions.stagedWrites().find(edit => edit.path === path)
    if (staged && typeof staged.data === 'string') return [locale, { path, content: staged.data, version: staged.version ?? null, values: readLocaleTable(staged.data), staged: true }] as const
    if (!client.entry(path)) return [locale, { path, content: null, version: null, values: {} }] as const
    const snapshot = await client.readSnapshot(path)
    const content = await snapshot.file.text()
    return [locale, { path, content, version: snapshot.version, values: readLocaleTable(content) }] as const
  })))
}
export async function mirrorDisplayLocale(client: ProjectClient, path: string, content: string) {
  // Keep drafts with the originating project; switching projects must never mirror into the new one.
  const initial = getProjectSession()
  if (initial.binding?.handle.client !== client) return
  const pkg = initial.workspace.packages[0]
  if (!pkg) return
  const blob = new Blob([content], { type: TEXT_ASSET_MIME })
  await putAssetBlob(pkg.id, path, blob)
  if (getProjectSession().binding?.handle.client !== client) return
  const result = registerAsset(getProjectSession().workspace, pkg.id, path, TEXT_ASSET_MIME, blob.size)
  if (result) setProjectSession({ workspace: result.workspace })
}
export function stageDisplayTranslation(client: ProjectClient, table: LocaleTable, key: string, value: string | undefined): LocaleTable {
  if (getProjectSession().binding?.handle.client !== client || !client.writable) throw Error('工程已切换、离线或只读，无法修改译文')
  const current = client.transactions.stagedText(table.path) ?? table.content
  const values = readLocaleTable(current)
  if (value === undefined) delete values[key]; else values[key] = value
  const content = stringifyTextFile(values)
  void client.transactions.stageWrite({ op: 'write', path: table.path, data: content, version: table.version }, () => mirrorDisplayLocale(client, table.path, content))
  return { ...table, content, values, staged: true }
}
export async function prepareDisplayLocalization(documentKey: string, kind: DisplayTextKind, document: DisplayTextDocument): Promise<LocalizationSession> {
  const session = getProjectSession(), client = session.binding?.handle.client
  if (!client?.writable) throw Error('请先打开可写工程')
  const source = session.workspace.packages.flatMap(pkg => pkg.scripts).find(source => source.id === documentKey)
  if (!source) throw Error('源文档不存在')
  const activeLocale = loadLocale(), availableLocales = projectDisplayLocales(client, activeLocale)
  const sourcePath = sourcePathOf(source)
  const sourceStage = client.transactions.stagedWrites().find(edit => edit.path === sourcePath)
  const sourceVersion = sourceStage ? sourceStage.version ?? null : client.baseline.get(sourcePath) ?? null
  const tables = await loadDisplayLocaleTables(client, source.name, availableLocales)
  if (getProjectSession().binding?.handle.client !== client) throw Error('工程已切换')
  const seen = new Set<string>()
  const semanticKeys = new Set<string>()
  const bindings = displayTextBindings(kind, document).map(binding => {
    if (seen.has(binding.runtimeKey) || semanticKeys.has(binding.semanticKey)) throw Error('多个显示字段引用了同一工程语义槽位，请先解除重复绑定')
    seen.add(binding.runtimeKey)
    semanticKeys.add(binding.semanticKey)
    return { bindingId: randomId(), field: binding.field, semanticKey: binding.semanticKey, runtimeKey: binding.runtimeKey,
      componentKind: 'translate' as const, translations: Object.fromEntries([...tables].flatMap(([locale, table]) => Object.hasOwn(table.values, binding.semanticKey) ? [[locale, table.values[binding.semanticKey]]] : [])) }
  })
  const readOnlyFields = displayTextFields(kind, document).filter(field => {
    const component = getDisplayText(kind, document, field)
    return component !== undefined && !decodeTextComponent(component).editable
  })
  const freezeLore = readOnlyFields.some(field => field.startsWith('item.lore.') && !bindings.some(binding => binding.field === field))
  return { client, documentKey, sourcePath, source: source.content, sourceVersion, kind, tables,
    localization: { protocol: LOCALIZATION_PROTOCOL, activeLocale, availableLocales, bindings, readOnlyFields, freezeLore } }
}

/** Restore only explicitly read-only source slots. Other candidate changes remain intact. */
export function preserveReadOnlyDisplayText<T extends DisplayTextDocument>(session: LocalizationSession, candidate: T, legacy = false): T {
  const original = JSON.parse(session.source) as DisplayTextDocument
  const fields = session.localization.readOnlyFields ?? displayTextFields(session.kind, original).filter(field => {
    const component = getDisplayText(session.kind, original, field)
    return component !== undefined && !decodeTextComponent(component).editable
  })
  if (!fields.length) return candidate
  const result = structuredClone(candidate)
  if (session.kind === 'entity') {
    if (fields.includes('entity.custom_name')) (result as EntityDocument).entity.data.value.CustomName = structuredClone((original as EntityDocument).entity.data.value.CustomName)
    return result
  }
  const from = (original as ItemDocument).item.components, to = (result as ItemDocument).item.components
  for (const field of fields.filter(field => !field.startsWith('item.lore.'))) {
    const key = `minecraft:${field.slice(5)}`
    to[key] = structuredClone(from[key])
  }
  const loreFields = fields.filter(field => field.startsWith('item.lore.'))
  if (!loreFields.length) return result
  if (legacy || session.localization.freezeLore) {
    to['minecraft:lore'] = structuredClone(from['minecraft:lore'])
    return result
  }
  const sourceLore = from['minecraft:lore'], targetLore = to['minecraft:lore']
  if (sourceLore?.type !== 'list' || targetLore?.type !== 'list') return result
  const references = displayTextBindings('item', result)
  for (const field of loreFields) {
    const binding = session.localization.bindings.find(binding => binding.field === field)
    const target = binding && references.find(reference => reference.runtimeKey === binding.runtimeKey)
    if (!target) continue // Direct bindings are validated before calling this helper.
    targetLore.value[Number(target.field.slice('item.lore.'.length))] = structuredClone(sourceLore.value[Number(field.slice('item.lore.'.length))])
  }
  return result
}

/** Pure validation; path authority comes only from the frozen open-session tables. */
export function localizedResultEdits(session: LocalizationSession, document: DisplayTextDocument, result: unknown): FileEdit[] {
  if (!record(result) || result.protocol !== LOCALIZATION_PROTOCOL || !Array.isArray(result.operations)) throw Error('本地化回包协议无效')
  const references = displayTextBindings(session.kind, document)
  for (const binding of session.localization.bindings) {
    if (references.filter(reference => reference.runtimeKey === binding.runtimeKey).length !== 1) throw Error('返回 Component 已替换或移除了翻译键；请在 WebUI 管理绑定')
  }
  const values = new Map([...session.tables].map(([locale, table]) => [locale, { ...table.values }]))
  const used = new Set<string>()
  for (const raw of result.operations) {
    if (!record(raw) || !['translation.set', 'translation.remove'].includes(String(raw.op)) || typeof raw.bindingId !== 'string' || typeof raw.locale !== 'string') throw Error('不支持的本地化操作')
    if (Object.keys(raw).some(key => !['op', 'bindingId', 'locale', 'expected', 'value'].includes(key))) throw Error('本地化操作包含未授权字段')
    const binding = session.localization.bindings.find(binding => binding.bindingId === raw.bindingId)
    const table = values.get(raw.locale)
    if (!binding || !table || !session.localization.availableLocales.includes(raw.locale)) throw Error('未授权的翻译绑定或语言')
    const identity = `${binding.bindingId}/${raw.locale}`
    if (used.has(identity)) throw Error('同一译文包含重复操作')
    used.add(identity)
    if (raw.expected !== (binding.translations[raw.locale] ?? null)) throw Error('译文原值不匹配')
    if (references.filter(reference => reference.runtimeKey === binding.runtimeKey).length !== 1) throw Error('返回 Component 已替换或移除了翻译键')
    if (raw.op === 'translation.set') {
      if (typeof raw.value !== 'string') throw Error('译文必须是字符串')
      table[binding.semanticKey] = raw.value
    } else delete table[binding.semanticKey]
  }
  return (session.localization.bindings.length ? [...session.tables] : []).map(([locale, table]) => {
    const changed = !!table.staged || JSON.stringify(values.get(locale)) !== JSON.stringify(table.values)
    const data = changed ? stringifyTextFile(values.get(locale)!) : table.content ?? undefined
    // Even untouched authorized locales participate in the compare-and-swap boundary.
    return { op: 'write', path: table.path, data, version: table.version, adopt: !changed }
  })
}

export function legacyLocalizedResultEdits(session: LocalizationSession, document: DisplayTextDocument): FileEdit[] {
  const references = displayTextBindings(session.kind, document)
  for (const original of displayTextBindings(session.kind, JSON.parse(session.source))) {
    const candidate = references.find(reference => reference.field === original.field)
    if (!candidate || JSON.stringify(candidate.component) !== JSON.stringify(original.component)) throw Error('旧版 IBE 修改了工程本地化引用，已拒绝回写')
  }
  return localizedResultEdits(session, document, { protocol: LOCALIZATION_PROTOCOL, operations: [] })
}

export function assertDisplaySessionUnchanged(session: LocalizationSession) {
  const live = getProjectSession()
  if (live.binding?.handle.client !== session.client || !session.client.writable) throw Error('工程已切换、离线或只读；游戏结果保留待恢复')
  const source = live.workspace.packages.flatMap(pkg => pkg.scripts).find(source => source.id === session.documentKey)
  if (!source || sourcePathOf(source) !== session.sourcePath || source.content !== session.source) throw Error('源文档草稿已改变；游戏结果保留待恢复')
  for (const table of session.tables.values()) {
    const staged = session.client.transactions.stagedText(table.path)
    if (staged !== undefined && staged !== table.content) throw Error('本地译文草稿已改变；游戏结果保留待恢复')
  }
}

export async function commitLocalizedResult(session: LocalizationSession, source: string, localeEdits: FileEdit[]) {
  const edits: FileEdit[] = [{ op: 'write', path: session.sourcePath, data: source, version: session.sourceVersion }, ...localeEdits]
  try { assertDisplaySessionUnchanged(session) }
  catch (error) {
    await session.client.transactions.retainConflict('游戏编辑结果待恢复', edits, String(error))
    throw error
  }
  // One durable submission owns source and every language version. Unknown outcomes use its original ID.
  await session.client.apply(edits, '应用游戏中的本地化编辑')
  session.client.transactions.clearSubmittedDrafts([...session.tables.values()].filter(table => table.content !== null && localeEdits.some(edit => edit.path === table.path)).map(table => ({op:'write',path:table.path,data:table.content!})))
  if (getProjectSession().binding?.handle.client === session.client) {
    session.client.remoteEpoch++
    const live = getProjectSession()
    setProjectSession({ workspace: { ...live.workspace, packages: live.workspace.packages.map(pkg => ({ ...pkg, scripts: pkg.scripts.map(row => row.id === session.documentKey && row.content === session.source ? { ...row, content: source, updatedAt: Date.now() } : row) })) } })
    for (const edit of localeEdits) if (!edit.adopt && typeof edit.data === 'string' && session.client.transactions.stagedText(edit.path) === undefined) await mirrorDisplayLocale(session.client, edit.path, edit.data)
  }
}
