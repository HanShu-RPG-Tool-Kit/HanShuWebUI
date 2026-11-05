import { getAssetBlob } from '../../../assets/idb'
import { effectResourcePaths, validateEffectResource, type EffectResourceKind } from '../../../workspaces/gameplay/effectResources'
import type { CompileArtifact, PackagePass } from '../types'

/** Custom effects are client resources, not author metadata or server scripts. */
export const regionEffectAssetsPass: PackagePass = {
  id: 'region-effect-assets',
  async run(prior, ctx) {
    const pkg = ctx.index.package, output: CompileArtifact[] = [], emitted = new Set(prior.map(a => a.path))
    async function copy(path: string) {
      if (emitted.has(path)) return
      const blob = await getAssetBlob(pkg.id, path)
      if (!blob) throw Error(`效果资产缓存缺失：${path}`)
      output.push({ path, bytes: new Uint8Array(await blob.arrayBuffer()), plane: 'client', packageName: pkg.name, sourcePath: path }); emitted.add(path)
    }
    const textures = new Set<string>()
    function texture(value: unknown) {
      if (typeof value === 'string' && /^[a-z0-9_.-]+:[a-z0-9_./-]+\.png$/.test(value)) textures.add(`assets/${value.replace(':','/')}`)
    }
    for (const asset of pkg.assets) {
      const m = /^assets\/([^/]+)\/rpgtoolkit\/effects\/(sky|post|transition)\/(.+)\.json$/.exec(asset.path)
      if (!m) continue
      const kind = m[2] as EffectResourceKind, id = `${m[1]}:${m[3]}`
      try {
        const paths = effectResourcePaths(kind, id)
        if (!ctx.index.assetsByPath.has(paths[1])) throw Error('缺少同名GLSL源码')
        const [manifestBlob, sourceBlob] = await Promise.all(paths.map(p => getAssetBlob(pkg.id, p)))
        if (!manifestBlob || !sourceBlob) throw Error('效果资产缓存缺失')
        const manifest = JSON.parse(await manifestBlob.text()), source = await sourceBlob.text()
        validateEffectResource({ kind, id, manifest, source })
        for (const param of Object.values(manifest.params ?? {}) as {type:string;default:unknown}[]) if (param.type === 'texture') texture(param.default)
        await copy(paths[0]); await copy(paths[1])
      } catch (error) { ctx.report({ severity: 'error', code: 'region_effect_resource', sourcePath: asset.path, message: (error as Error).message }) }
    }
    // Includes can be shared across effects; packing all declared include units preserves the normal resolver.
    for (const asset of pkg.assets) if (/^assets\/[^/]+\/rpgtoolkit\/effects\/include\/.+\.glsl$/.test(asset.path)) await copy(asset.path)
    for (const file of pkg.scripts.filter(s => s.name.endsWith('.level'))) {
      try { const json = JSON.parse(file.content); const walk = (value: unknown) => { texture(value); if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object') Object.values(value).forEach(walk) }; for (const region of json.regions ?? []) walk(region.environment) } catch { /* The level compiler reports syntax errors. */ }
    }
    for (const path of textures) if (ctx.index.assetsByPath.has(path)) await copy(path)
    return output
  },
}
