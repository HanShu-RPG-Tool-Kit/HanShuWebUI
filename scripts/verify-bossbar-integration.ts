import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import JSZip from 'jszip'
import { createProject, sourcePathOf, type SourceFile, type Workspace } from '../src/workspace'
import { collectProjectChanges, type BoundProject } from '../src/project/projectFs'
import { createBossbar, stringifyBossbar } from '../src/workspaces/audiovisual/bossbar'
import { exportPaks } from '../src/export/pack/exportPaks'

const document = { ...createBossbar('hanshu:integration'), priority: 42 }
const source: SourceFile = {
  id: 'bossbar-integration', name: 'integration.bossbar',
  content: stringifyBossbar(document), updatedAt: 0,
}
const project = createProject('BossBar integration', [source])
const workspace: Workspace = { packages: [project], activeScriptId: source.id, activeAssetId: null }
const binding = {
  manifest: { version: 1, id: project.id, name: project.name },
  handle: { client: { texts: new Map<string, string>() } },
} as unknown as BoundProject

const validEdits = await collectProjectChanges(binding, workspace)
assert.equal(validEdits.length, 1)
assert.equal(validEdits[0].path, sourcePathOf(source))
assert.equal(validEdits[0].data, source.content, '保存正文不混入模拟值或规范化改写')

const invalidSources = [
  '{broken json',
  JSON.stringify({ ...document, texture: undefined }),
  JSON.stringify({ ...document, components: [] }),
  JSON.stringify({ ...document, texture: 'not a PNG' }),
]
for (const content of invalidSources) {
  const draft = { ...workspace, packages: [{ ...project, scripts: [{ ...source, content }] }] }
  await assert.rejects(collectProjectChanges(binding, draft), /integration\.bossbar 无法保存/)
  assert.equal(draft.packages[0].scripts[0].content, content, '校验失败保留原始草稿')
}
assert.deepEqual(binding.handle.client.texts, new Map(), '收集写入不改变服务器基线')
console.log('通过：合法正文原样保存，非法 BossBar 阻止提交并保留草稿')

const exported = await exportPaks(workspace, { targets: ['client', 'server', 'combined'] })
assert.equal(exported.diagnostics.filter(diagnostic => diagnostic.severity === 'error').length, 0)
const hashes: string[] = []
for (const pack of exported.packs) {
  const zip = await JSZip.loadAsync(await pack.blob.arrayBuffer())
  const entry = zip.file('bossbars/integration.bossbar')
  if (pack.target === 'server') {
    assert.equal(entry, null, 'server 包不含客户端 BossBar 模板')
    assert.ok(!Object.values(zip.files).some(file => !file.dir && file.name.endsWith('.bossbar')))
    continue
  }
  assert.ok(entry, pack.target + ' 含有 client BossBar')
  const bytes = await entry.async('uint8array')
  assert.equal(new TextDecoder().decode(bytes), stringifyBossbar(document))
  assert.equal(JSON.parse(new TextDecoder().decode(bytes)).priority, 42, '客户端产物保留根级优先级')
  hashes.push(createHash('sha256').update(bytes).digest('hex'))
  assert.ok(!Object.values(zip.files).some(file => !file.dir && /\.(png|jpe?g|webp)$/i.test(file.name)), '图集不生成外链图片')
}
assert.equal(hashes.length, 2)
assert.equal(new Set(hashes).size, 1, 'client 与 combined 包的 BossBar 字节与 SHA-256 相同')
console.log('通过：server 包无模板，client/combined 实际解包字节与 hash 一致：' + hashes[0])

const other = createProject('Other package', [{ ...source, id: 'other', name: 'other.bossbar' }])
await assert.rejects(exportPaks({ ...workspace, packages: [project, other] }), /模板 ID.*重复/)
other.scripts[0].content = stringifyBossbar({ ...document, id: 'HANSHU:integration' })
const distinct = await exportPaks({ ...workspace, packages: [project, other] })
assert.ok(!distinct.diagnostics.some(diagnostic => diagnostic.severity === 'error'), '模板 ID 区分大小写')
const combined = await JSZip.loadAsync(await distinct.packs[0].blob.arrayBuffer())
assert.ok(combined.file('bossbars/integration.bossbar'))
assert.ok(combined.file('bossbars/other.bossbar'))
console.log('通过：跨包重复模板 ID 阻止导出，不同大小写 ID 独立保留')

const overlaid = createProject('Overlay', [{ ...source, id: 'overlay', content: stringifyBossbar({ ...document, id: 'hanshu:overlay' }) }])
const base = { ...project, scripts: [source, { ...source, id: 'retained', name: 'retained.bossbar' }] }
const overlayExport = await exportPaks({ ...workspace, packages: [base, overlaid] })
const overlayZip = await JSZip.loadAsync(await overlayExport.packs[0].blob.arrayBuffer())
assert.equal(JSON.parse(await overlayZip.file('bossbars/integration.bossbar')!.async('string')).id, 'hanshu:overlay')
assert.equal(JSON.parse(await overlayZip.file('bossbars/retained.bossbar')!.async('string')).id, document.id)
overlaid.scripts[0].content = source.content
await exportPaks({ ...workspace, packages: [project, overlaid] })
console.log('通过：同路径覆盖遵循包顺序，只检查最终有效路径中的重复 ID')
console.log('PASS verify-bossbar-integration')
