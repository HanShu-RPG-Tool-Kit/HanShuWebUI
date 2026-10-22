import {projectMenu,waitProject} from './project-ui-helpers.mjs'
import assert from 'node:assert/strict'
import { createServer as netServer } from 'node:net'
import { networkInterfaces } from 'node:os'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createServer, preview } from 'vite'
import { chromium } from 'playwright'
import { harness } from './collaboration-harness.mjs'

const output = resolve('../output/local-project-opening')
await mkdir(output, { recursive: true })
const workspace = await mkdtemp(join(output, 'proxy-'))
const lan = Object.values(networkInterfaces()).flat().find(address => address?.family === 'IPv4' && !address.internal)?.address
assert.ok(lan, 'This integration check requires a real non-loopback IPv4 interface')
async function port() {
  const server = netServer(); await new Promise(resolve => server.listen(0, '0.0.0.0', resolve))
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port
}
const devPort = await port(), previewPort = await port()
const bases = [`http://127.0.0.1:${devPort}`, `http://127.0.0.1:${previewPort}`]
const h = await harness({ root: join(workspace, 'default'), localProjects: true, origins: bases })
let dev, built, browser
const results = []
const passed = name => { results.push(name); console.log(`通过：${name}`) }
const proxy = { '/__project': { target: h.base, ws: true, rewrite: path => path.replace(/^\/__project/, '') } }
try {
  dev = await createServer({ cacheDir: join(workspace, 'vite-cache'), server: { host: '0.0.0.0', port: devPort, strictPort: true, proxy } })
  await dev.listen()
  built = await preview({ preview: { host: '0.0.0.0', port: previewPort, strictPort: true, proxy } })
  for (const [index, portNumber] of [devPort, previewPort].entries()) {
    const local = await fetch(bases[index] + '/__project/api/local/bootstrap')
    assert.equal(local.status, 200)
    assert.equal((await local.json()).service, 'hanshu-local-projects')
    const remote = `http://${lan}:${portNumber}`
    for (const path of ['/__project/api/local/bootstrap', '/__project//api/local/bootstrap', '/__project/api/%6cocal/bootstrap', '/__project/api/share/firewall', '/__project/api/share/%66irewall']) {
      const denied = await fetch(remote + path, { headers: { Origin: bases[index] } })
      assert.equal(denied.status, 403, `${remote}${path} exposed a host capability through Vite`)
      assert.equal((await denied.json()).code, 'forbidden')
    }
    assert.equal((await fetch(remote + '/__project/health')).status, 200)
    passed(`${index ? 'Preview' : 'Dev'} 本机请求可用，真实LAN经代理访问目录入口被拒绝，普通工程API仍可用`)
  }

  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
  const page = await browser.newPage()
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto(bases[0])
  await projectMenu(page,'打开工程…')
  const form = page.getByRole('form', { name: '打开工程', exact: true })
  await form.getByRole('button', { name: '打开本机工程…', exact: true }).click()
  const picker = page.getByRole('region', { name: '选择本机工程目录', exact: true })
  await picker.getByRole('button', { name: '默认工程', exact: true }).click()
  await picker.getByRole('button', { name: '打开此文件夹', exact: true }).click()
  await waitProject(page,'统一工程验收')
  assert.deepEqual(errors, [])
  passed('实际Vite开发页面通过目录选择自动连接S，无需手填凭证，跨端口认证与WebSocket可用')
  await writeFile(join(output, 'proxy-acceptance.json'), JSON.stringify({ checks: results.length, results, physicalHosts: 1, realLanAddress: lan, pageErrors: errors }, null, 2))
} finally {
  await browser?.close()
  await dev?.close()
  if (built) { built.httpServer.closeAllConnections(); await new Promise(resolve => built.httpServer.close(resolve)) }
  await h.stop()
}
