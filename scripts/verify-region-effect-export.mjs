import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import JSZip from 'jszip'

const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, optimizeDeps: { include: ['jszip'] } })
let browser
try {
  await server.listen(); browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`)
  const result = await page.evaluate(async () => {
    const { createProject } = await import('/src/workspace.ts')
    const { putAssetBlob } = await import('/src/assets/idb.ts')
    const { createEffectResource, effectResourcePaths } = await import('/src/workspaces/gameplay/effectResources.ts')
    const { buildProjectPackZip } = await import('/src/export/projectPack.ts')
    const { exportPaks } = await import('/src/export/pack/exportPaks.ts')
    const pkg = createProject('effect-export'), source = createEffectResource('post'), paths = effectResourcePaths(source.kind, source.id)
    pkg.regionEffectPresets = JSON.stringify({ v: 1, presets: [] })
    source.manifest.params.image = { type: 'texture', label: '纹理', default: 'project:textures/sky/test.png' }
    for (const [path, body] of [[paths[0],JSON.stringify(source.manifest)],[paths[1],source.source],['assets/project/textures/sky/test.png','image-bytes'],['assets/project/rpgtoolkit/effects/include/common.glsl','float author_value(){return 1.;}']]) {
      const blob = new Blob([body]); pkg.assets.push({ id: path, path, mime: 'application/octet-stream', size: blob.size, updatedAt: 0 }); await putAssetBlob(pkg.id, path, blob)
    }
    const ws = { packages: [pkg], activePackageId: pkg.id, activeScriptId: null }
    const packs = await exportPaks(ws, { targets: ['combined','client','server'] })
    const project = await buildProjectPackZip(ws)
    const encoded = async blob => [...new Uint8Array(await blob.arrayBuffer())]
    return { packs: await Promise.all(packs.packs.map(async p => ({ target:p.target, bytes:await encoded(p.blob) }))), project:await encoded(project.blob), paths }
  })
  for (const pack of result.packs) {
    const zip = await JSZip.loadAsync(Uint8Array.from(pack.bytes))
    for (const path of [...result.paths, 'assets/project/textures/sky/test.png', 'assets/project/rpgtoolkit/effects/include/common.glsl']) assert.equal(!!zip.file(path), pack.target !== 'server', `${pack.target}: ${path}`)
    assert.ok(!zip.file('meta/region-effect-presets.json'))
  }
  const project = await JSZip.loadAsync(Uint8Array.from(result.project))
  assert.ok(Object.keys(project.files).some(p => p.endsWith('/meta/region-effect-presets.json')))
  for (const path of result.paths) assert.ok(Object.keys(project.files).some(p => p.endsWith('/'+path)))
  console.log('PASS real browser asset cache to client/combined PAK: paired GLSL, definitions, includes, textures; recipes remain in engineering ZIP only')
} finally { await browser?.close(); await server.close() }
