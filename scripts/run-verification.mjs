/** Tests importing bundled goal scripts need Vite's import.meta.glob transform, not a CDN runner. */
import { createServer } from 'vite'
const scripts = process.argv.slice(2)
if (scripts.length === 0) throw new Error('Expected at least one repository verification script')
for (const path of scripts) {
  if (!/^scripts\/verify-[a-z-]+\.ts$/.test(path ?? '')) throw new Error(`Expected a repository verification script, got: ${path}`)
}
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } })
try {
  // 同一 Vite 实例里顺序跑，避免每个脚本都重新起一次服务器
  for (const path of scripts) await server.ssrLoadModule(`/${path}`)
} finally {
  await server.close()
}
