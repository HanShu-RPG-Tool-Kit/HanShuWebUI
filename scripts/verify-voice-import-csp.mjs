import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import * as esbuild from 'esbuild'
import { chromium } from 'playwright'

/**
 * 打包版桌面应用里，配音导入会在转码阶段失败，界面只报
 * `Import workflow interrupted unexpectedly.`（见 `src/i18n/voiceImport.ts`）。
 *
 * 原因：`@audio/encode-ogg` 把 WASM 以 `data:` URI 内联，运行时走
 * `WebAssembly.instantiateStreaming(fetch(data:...))`。开发期前端由 Vite devUrl
 * 直接提供、不套 Tauri CSP；打包后 WebView2 应用 `src-tauri/tauri.conf.json` 的
 * CSP，缺少下面两项就会在**录音 / TTS / 拖拽**共用同一条导入链路时全部失败：
 *
 * - `script-src 'wasm-unsafe-eval'`：允许编译 WebAssembly；
 * - `connect-src ... data:`：允许 fetch 内联的 wasm data URI。
 *
 * 本脚本读取真实配置里的 CSP，用同引擎浏览器（Windows 用 Edge，即 WebView2 的
 * Chromium）跑一遍**完整导入工作流**（真实解码 + 真实 WASM 编码），把这条约束钉住。
 */

const root = resolve(import.meta.dirname, '..')
const cache = resolve(root, 'node_modules/.cache/voice-import-csp')
const configPath = resolve(root, 'src-tauri/tauri.conf.json')
const targetPath = 'assets/zh_cn/voice_hs/story/line.ogg'

const config = JSON.parse(await readFile(configPath, 'utf8'))
const csp = config?.app?.security?.csp

assert.ok(typeof csp === 'string' && csp.trim(), `${configPath} 缺少 app.security.csp`)
function directive(name) {
  const found = csp
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.toLowerCase().startsWith(`${name} `))
  return found ?? ''
}
assert.ok(
  /(^|\s)'wasm-unsafe-eval'(\s|$)/.test(directive('script-src')),
  `打包版 CSP 的 script-src 缺少 'wasm-unsafe-eval'，WebAssembly 编码器会在打包后被拒绝（录音 / TTS 导入都会报中断）`,
)
assert.ok(
  /(^|\s)data:(\s|$)/.test(directive('connect-src')),
  `打包版 CSP 的 connect-src 缺少 data:，@audio/encode-ogg 内联 wasm 的 fetch 会被拒绝（录音 / TTS 导入都会报中断）`,
)

await mkdir(cache, { recursive: true })
const asImportPath = (path) => path.replace(/\\/g, '/')
const entry = resolve(cache, 'entry.ts')
await writeFile(
  entry,
  [
    `export { runVoiceImport, VOICE_IMPORT_RESULT } from ${JSON.stringify(asImportPath(resolve(root, 'src/i18n/voiceImport.ts')))}`,
    `export { createVoiceProcessor } from ${JSON.stringify(asImportPath(resolve(root, 'src/i18n/voiceTranscode.ts')))}`,
    `export { isMonoVorbisOgg } from ${JSON.stringify(asImportPath(resolve(root, 'src/i18n/voiceBytes.ts')))}`,
  ].join('\n'),
)
const bundlePath = resolve(cache, 'bundle.js')
await esbuild.build({
  entryPoints: [entry],
  outfile: bundlePath,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome105',
  logLevel: 'silent',
})
const bundle = await readFile(bundlePath)

// 页面脚本在 CSP 生效的文档里跑：先合成一段真实的 WAV 源字节，再走
// `runVoiceImport`（与录音棚 / TTS 导入同一个入口），最后校验产物是单声道 Vorbis。
const pageJs = `
import { runVoiceImport, createVoiceProcessor, isMonoVorbisOgg } from '/bundle.js'

function wavBytes(seconds = 0.5) {
  const ctx = new OfflineAudioContext(1, Math.ceil(44100 * seconds), 44100)
  const osc = ctx.createOscillator()
  osc.frequency.value = 440
  osc.connect(ctx.destination)
  osc.start()
  return ctx.startRendering().then((buffer) => {
    const pcm = buffer.getChannelData(0)
    const out = new DataView(new ArrayBuffer(44 + pcm.length * 2))
    const write = (at, value) => {
      for (let i = 0; i < value.length; i += 1) out.setUint8(at + i, value.charCodeAt(i))
    }
    write(0, 'RIFF')
    out.setUint32(4, 36 + pcm.length * 2, true)
    write(8, 'WAVE')
    write(12, 'fmt ')
    out.setUint32(16, 16, true)
    out.setUint16(20, 1, true)
    out.setUint16(22, 1, true)
    out.setUint32(24, 44100, true)
    out.setUint32(28, 88200, true)
    out.setUint16(32, 2, true)
    out.setUint16(34, 16, true)
    write(36, 'data')
    out.setUint32(40, pcm.length * 2, true)
    for (let i = 0; i < pcm.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, pcm[i]))
      out.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
    }
    return new Uint8Array(out.buffer)
  })
}

window.runImportWorkflow = async (targetPath) => {
  const outcome = { phases: [], progress: 0, written: null }
  try {
    const source = { kind: 'file', name: 'unit-test.wav', bytes: await wavBytes() }
    const run = runVoiceImport(
      { source, targetPath },
      {
        read: async () => null,
        write: async (_path, bytes) => {
          outcome.written = Array.from(bytes)
        },
      },
      createVoiceProcessor(),
      {
        onPhase: (phase) => outcome.phases.push(phase),
        onProgress: (ratio) => {
          outcome.progress = ratio
        },
      },
    )
    const report = await run.result
    const bytes = outcome.written ? Uint8Array.from(outcome.written) : null
    outcome.ok = report.ok
    outcome.outcome = report.outcome
    outcome.message = report.message
    outcome.detail = report.detail ?? null
    outcome.progress = Number(outcome.progress.toFixed(4))
    outcome.writtenBytes = bytes ? bytes.byteLength : 0
    outcome.monoVorbis = bytes ? isMonoVorbisOgg(bytes) : false
  } catch (error) {
    outcome.ok = false
    outcome.error = error instanceof Error ? error.message : String(error)
  }
  delete outcome.written
  return outcome
}
window.harnessReady = true
`

const html = `<!doctype html><html><body><script type="module" src="/page.js"></script></body></html>`

const server = http.createServer((request, response) => {
  const headers = { 'content-security-policy': csp, 'cache-control': 'no-store' }
  if (request.url === '/page.js') {
    response.writeHead(200, { ...headers, 'content-type': 'text/javascript' })
    response.end(pageJs)
    return
  }
  if (request.url === '/bundle.js') {
    response.writeHead(200, { ...headers, 'content-type': 'text/javascript' })
    response.end(bundle)
    return
  }
  response.writeHead(200, { ...headers, 'content-type': 'text/html' })
  response.end(html)
})

let browser
try {
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === 'win32' ? { channel: 'msedge' } : {}),
  })
  const page = await browser.newPage()
  const consoleErrors = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  await page.goto(origin)
  await page.waitForFunction(() => window.harnessReady === true, null, { timeout: 30000 })
  const result = await page.evaluate((path) => window.runImportWorkflow(path), targetPath)

  if (!result.ok) {
    const cspErrors = consoleErrors.filter((line) => /Content Security Policy/i.test(line))
    assert.fail(
      `打包版 CSP 下配音导入失败：${result.detail ?? result.error ?? result.message ?? result.outcome}` +
        (cspErrors.length ? `\nCSP 报错：${cspErrors[0]}` : ''),
    )
  }
  assert.equal(result.outcome, 'success', `导入结果应为 success，实际 ${result.outcome}`)
  assert.ok(result.writtenBytes > 0, '导入工作流必须写出非空 ogg')
  assert.ok(result.monoVorbis, '写出的产物必须是单声道 Vorbis ogg')
  assert.deepEqual(result.phases, ['process', 'write'], `阶段顺序错误：${result.phases.join(' → ')}`)
  assert.equal(result.progress, 1, `导入应完成到 100%，实际 ${result.progress}`)
  assert.equal(
    consoleErrors.filter((line) => /Content Security Policy/i.test(line)).length,
    0,
    '打包版 CSP 下不应出现 CSP 拦截',
  )

  console.log(
    'Voice import under packaged CSP passed: ' +
      `script-src 'wasm-unsafe-eval' + connect-src data: allow the real decode → WASM encode → .ogg write workflow ` +
      `(${result.writtenBytes} bytes).`,
  )
} finally {
  await browser?.close()
  await new Promise((resolveClose) => server.close(resolveClose))
}