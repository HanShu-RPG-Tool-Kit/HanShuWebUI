import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({ cacheDir: 'node_modules/.cache/assistance-ui', server: { host: '127.0.0.1', port: 0, hmr: false }, optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-dev-runtime'] } })
await server.listen()
server.config.server.port = server.httpServer.address().port
const base = `http://127.0.0.1:${server.httpServer.address().port}`
const browser = await chromium.launch({ headless: true, args: ['--disable-features=LocalNetworkAccessChecks'], ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
try {
  const transformed = await (await fetch(base + '/src/gameDevServer/EditingAssistance.tsx')).text()
  const react = transformed.match(/"([^"]*deps\/react\.js[^"]*)"/)[1]
  const dom = react.replace(/react\.js.*$/, 'react-dom_client.js') + new URL(react, base).search
  const page = await browser.newPage({ viewport: { width: 700, height: 500 } })
  const errors = []
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message) })
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()) })
  await page.route('http://127.0.0.1:8765/**', route => route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"ok":true,"subscribers":1}' }))
  await page.route('**/__assist', route => route.fulfill({ contentType: 'text/html', body: `
    <meta charset="utf-8"><script type="module">import R from '/@react-refresh'; R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>
    <div id="root" style="width:300px;position:absolute;bottom:20px;right:20px;overflow:hidden"></div>
    <script type="module">
    import React from '${react}';import DOM from '${dom}';
    import {GameResourceInput,GameCommandInput} from '/src/gameDevServer/EditingAssistance.tsx';
    import {reconnectGameDevControlNow,disconnectGameDevControl} from '/src/gameDevServer/controlHub.ts';window.disconnectGame=disconnectGameDevControl;
    window.calls=[];
    window.WebSocket=class {static OPEN=1;static CONNECTING=0;readyState=0;
      constructor(){window.socket=this;setTimeout(()=>{this.readyState=1;this.onopen?.({})},10)}
      close(){this.readyState=3;this.onclose?.({code:1000})}
      send(text){const r=JSON.parse(text);window.calls.push(r);let result;
        if(r.method==='commands.complete')result={version:1,items:[{text:'give',start:0,end:r.params.cursor}]};
        else if(r.method==='sounds.preview')result={version:1,previewId:'one'};
        else result={version:1,total:1,items:[{id:r.method==='effects.list'?'minecraft:speed':'minecraft:music.menu',name:r.method==='effects.list'?'速度':undefined}]};
        setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:'response',id:r.id,ok:true,result})}),20)
      }};
    reconnectGameDevControlNow();
    function App(){let [e,E]=React.useState(''),[s,S]=React.useState(''),[c,C]=React.useState(''),[disabled,D]=React.useState(false);window.setReadonly=D;window.values={e,s,c};return React.createElement(React.Fragment,null,
      React.createElement(GameResourceInput,{kind:'effects',value:e,onChange:E,label:'药水',disabled}),
      React.createElement(GameResourceInput,{kind:'sounds',value:s,onChange:S,label:'音效',disabled}),
      React.createElement(GameCommandInput,{value:c,onChange:C,label:'指令',disabled}));}
    DOM.createRoot(document.getElementById('root')).render(React.createElement(App));</script>` }))
  await page.goto(base + '/__assist')
  await page.getByRole('button', { name: '选择药水', exact: true }).click()
  await page.getByRole('button', { name: /速度/ }).click()
  assert.equal(await page.getByRole('textbox', { name: '药水', exact: true }).inputValue(), 'minecraft:speed')
  await page.getByRole('button', { name: '选择音效', exact: true }).click()
  await page.getByRole('button', { name: 'minecraft:music.menu', exact: true }).waitFor()
  const box = await page.locator('.game-assist-picker').boundingBox()
  assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= 700 && box.y + box.height <= 500, JSON.stringify(box))
  await page.getByRole('button', { name: 'minecraft:music.menu', exact: true }).click()
  await page.getByRole('button', { name: /在游戏中播放/ }).click()
  await page.waitForFunction(() => window.calls.some(c => c.method === 'sounds.preview'))
  await page.getByRole('textbox', { name: '指令', exact: true }).fill('gi')
  await page.getByRole('option', { name: 'give', exact: true }).waitFor()
  await page.getByRole('textbox', { name: '指令', exact: true }).press('Tab')
  assert.equal(await page.getByRole('textbox', { name: '指令', exact: true }).inputValue(), 'give')
  assert.equal(await page.getByRole('button', { name: /停止/ }).count(), 0)
  await page.getByRole('button', { name: '选择药水', exact: true }).click()
  await page.evaluate(() => window.setReadonly(true))
  await page.locator('.game-assist-picker').waitFor({ state: 'detached' })
  assert(await page.getByRole('textbox', { name: '药水', exact: true }).isDisabled())
  await page.evaluate(() => { window.setReadonly(false); window.disconnectGame() })
  assert(await page.getByRole('button', { name: '选择药水', exact: true }).isDisabled())
  await page.getByRole('textbox', { name: '药水', exact: true }).fill('example:manual')
  assert.equal(await page.getByRole('textbox', { name: '药水', exact: true }).inputValue(), 'example:manual')
  assert.deepEqual(errors, [])
  console.log('PASS: effects selection, sound preview RPC, cursor-range command completion, viewport-safe floating panel, readonly revocation, offline manual input; mocked MC transport')
} finally { await browser.close(); await server.close() }
