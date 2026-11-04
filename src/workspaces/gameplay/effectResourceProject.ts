import { ServiceError } from '../../collab/protocol'
import { getProjectSession, setProjectSession } from '../../project/projectSession'
import { refreshServiceProject } from '../../project/projectFs'
import type { ProjectClient } from '../../project/serviceClient'
import { EFFECT_PRESETS_PATH, effectResourcePaths, readEffectPresets, validateEffectResource, type EffectPreset, type EffectResource, type EffectResourceKind } from './effectResources'
export type EffectResourceSnapshot = { resource: EffectResource; versions: [string | null, string | null]; originals: [string | null, string | null] }
export async function readEffectText(client: ProjectClient, path: string): Promise<{ text: string | null; version: string | null }> {
  try { const snap = await client.readSnapshot(path, false); return { text: await snap.file.text(), version: snap.version } }
  catch (error) { if (error instanceof ServiceError && error.code === 'not_found') return { text: null, version: null }; throw error }
}
export async function readEffectResource(client: ProjectClient, seed: EffectResource): Promise<EffectResourceSnapshot> {
  const [manifest, source] = await Promise.all(effectResourcePaths(seed.kind, seed.id).map(path => readEffectText(client, path)))
  const resource = { ...seed, manifest: manifest.text === null ? seed.manifest : JSON.parse(manifest.text), source: source.text ?? seed.source }; validateEffectResource(resource)
  return { resource, versions: [manifest.version, source.version], originals: [manifest.text, source.text] }
}
export async function saveEffectResource(client: ProjectClient, snapshot: EffectResourceSnapshot, editorOwner?: string): Promise<void> {
  validateEffectResource(snapshot.resource)
  const paths = effectResourcePaths(snapshot.resource.kind, snapshot.resource.id)
  if (paths.some(path => client.transactions.hasDraft(path, editorOwner)) || client.transactions.getSnapshot().transactions.some(t => t.phase !== 'saved' && t.paths.some(path => paths.includes(path)))) throw Error('此资源已有其他草稿或未完成事务，请先在协作面板核对原提交')
  await client.apply(paths.map((path, i) => ({ op: 'write', path, version: snapshot.versions[i], baseData: snapshot.originals[i] ?? undefined, data: i === 0 ? JSON.stringify(snapshot.resource.manifest, null, 2) + '\n' : snapshot.resource.source })), '保存自定义着色器效果')
  const current = getProjectSession()
  if (current.binding?.handle.client !== client) return
  const next = await refreshServiceProject(current.binding, current.workspace)
  if (getProjectSession().binding?.handle.client === client) setProjectSession({ workspace: next })
}
export async function projectEffectSources(client: ProjectClient, references?: Set<string>, overrides: EffectResource[] = []): Promise<EffectResource[]> {
  await client.refresh()
  const overrideKeys = new Set(overrides.map(r => `${r.kind}/${r.id}`))
  const found = client.tree.entries.filter(e => {
    const m = /^assets\/([^/]+)\/rpgtoolkit\/effects\/(sky|post|transition)\/(.+)\.json$/.exec(e.path)
    const key = m ? `${m[2]}/${m[1]}:${m[3]}` : ''
    return e.kind === 'file' && !!m && !overrideKeys.has(key) && (!references || references.has(key))
  })
  if (found.length > 24) throw Error('单次预览最多包含24份工程效果资源，请发布资源包后使用')
  const sources = await Promise.all(found.map(async e => {
    const match = /^assets\/([^/]+)\/rpgtoolkit\/effects\/(sky|post|transition)\/(.+)\.json$/.exec(e.path)!
    const kind = match[2] as EffectResourceKind, id = match[1] + ':' + match[3], paths = effectResourcePaths(kind, id)
    const sourceEntry = client.entry(paths[1]); if (!sourceEntry) throw Error(`自定义效果缺少GLSL源码：${id}`)
    const [manifest, source] = await Promise.all([client.readSnapshot(paths[0], false, e.version), client.readSnapshot(paths[1], false, sourceEntry.version)])
    const resource = { kind, id, manifest: JSON.parse(await manifest.file.text()), source: await source.file.text() }; validateEffectResource(resource); return resource
  }))
  return [...sources, ...overrides.filter(r => !references || references.has(`${r.kind}/${r.id}`))]
}
export async function saveEffectPresets(client: ProjectClient, presets: EffectPreset[], version: string | null, original: string | null): Promise<void> {
  const text = JSON.stringify({ v: 1, presets }, null, 2) + '\n'; readEffectPresets(text)
  if (client.transactions.hasDraft(EFFECT_PRESETS_PATH) || client.transactions.getSnapshot().transactions.some(t => t.phase !== 'saved' && t.paths.includes(EFFECT_PRESETS_PATH))) throw Error('方案库已有未完成事务，请在协作面板核对原提交')
  await client.apply([{ op: 'write', path: EFFECT_PRESETS_PATH, data: text, version, baseData: original ?? undefined }], '保存区域效果方案')
  const current = getProjectSession()
  if (current.binding?.handle.client === client) setProjectSession({ workspace: { ...current.workspace, packages: current.workspace.packages.map(p => p.id === current.binding!.manifest.id ? { ...p, regionEffectPresets: text } : p) } })
}
