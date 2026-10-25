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
    <div id="root" class="flow-kit-pane" style="width:340px;height:auto;position:absolute;bottom:20px;right:20px;overflow:hidden;padding:16px;gap:12px;border:1px solid #484848"></div>
    <script type="module">
    import React from '${react}';import DOM from '${dom}';
    import '/src/index.css';import '/src/App.css';import '/src/workspaces/GameplayWorkspace.css';import '/src/workspaces/gameplay/KitEditor.css';
    import {GameResourceInput,GameCommandInput} from '/src/gameDevServer/EditingAssistance.tsx';
    import {reconnectGameDevControlNow,disconnectGameDevControl} from '/src/gameDevServer/controlHub.ts';window.disconnectGame=disconnectGameDevControl;
    window.calls=[];
    window.WebSocket=class {static OPEN=1;static CONNECTING=0;readyState=0;
      constructor(){window.socket=this;setTimeout(()=>{this.readyState=1;this.onopen?.({})},10)}
      close(){this.readyState=3;this.onclose?.({code:1000})}
      send(text){const r=JSON.parse(text);window.calls.push(r);let result;
        if(r.method==='commands.complete')result={version:1,items:[{text:'give',start:0,end:r.params.cursor}]};
        else if(r.method==='sounds.preview')result={version:1,previewId:'one'};
        else if(r.method==='sounds.list'){const all=Array.from({length:260},(_,i)=>({id:i?'minecraft:music.test_'+i:'minecraft:music.menu'}));result={version:1,total:260,items:all.slice(r.params.offset,r.params.offset+r.params.limit)}}
        else result={version:1,total:1,items:[{id:'minecraft:speed',name:'速度'}]};
        setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:'response',id:r.id,ok:true,result})}),20)
      }};
    reconnectGameDevControlNow();
    function App(){let [e,E]=React.useState(''),[s,S]=React.useState(''),[c,C]=React.useState(''),[disabled,D]=React.useState(false);window.setReadonly=D;window.values={e,s,c};return React.createElement(React.Fragment,null,
      React.createElement('label',{className:'kit-field'},React.createElement('span',null,'药水'),React.createElement(GameResourceInput,{kind:'effects',value:e,onChange:E,label:'药水',disabled})),
      React.createElement('label',{className:'kit-field'},React.createElement('span',null,'音效'),React.createElement(GameResourceInput,{kind:'sounds',value:s,onChange:S,label:'音效',disabled})),
      React.createElement(GameCommandInput,{value:c,onChange:C,label:'指令',disabled}));}
    DOM.createRoot(document.getElementById('root')).render(React.createElement(App));</script>` }))
  await page.goto(base + '/__assist')
  await page.getByRole('combobox', { name: '药水', exact: true }).click()
  await page.getByRole('option', { name: /速度/ }).click()
  assert.equal(await page.getByRole('combobox', { name: '药水', exact: true }).inputValue(), 'minecraft:speed')
  await page.getByRole('combobox', { name: '药水', exact: true }).fill('速度')
  await page.waitForFunction(() => window.calls.some(c => c.method === 'effects.list' && c.params.query === '速度'))
  await page.waitForFunction(() => !document.querySelector('.game-assist-choice').disabled)
  await page.getByRole('combobox', { name: '药水', exact: true }).press('ArrowDown')
  await page.getByRole('combobox', { name: '药水', exact: true }).press('Enter')
  assert.equal(await page.getByRole('combobox', { name: '药水', exact: true }).inputValue(), 'minecraft:speed')
  await page.getByRole('combobox', { name: '音效', exact: true }).click()
  await page.getByRole('option', { name: 'minecraft:music.menu', exact: true }).waitFor()
  const box = await page.locator('.game-assist-picker').boundingBox()
  assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= 700 && box.y + box.height <= 500, JSON.stringify(box))
  const anchor = await page.getByRole('combobox', { name: '音效', exact: true }).boundingBox()
  assert(box.y + box.height <= anchor.y || box.y >= anchor.y + anchor.height, 'picker must not cover its input')
  await page.waitForFunction(() => document.querySelectorAll('.game-assist-play').length === 260)
  assert.equal(await page.getByRole('button', {name:'加载更多',exact:true}).count(),0)
  assert.equal(await page.getByRole('option', {name:'minecraft:music.test_259',exact:true}).count(),1)
  assert(await page.locator('.game-assist-picker').evaluate(node => node.scrollHeight > node.clientHeight && getComputedStyle(node).scrollbarWidth === 'thin'))
  await page.screenshot({path:'node_modules/.cache/assistance-ui/sound-picker.png'})
  await page.getByRole('button', { name: '试听 minecraft:music.menu', exact: true }).click()
  assert.equal(await page.getByRole('combobox', { name: '音效', exact: true }).inputValue(), '')
  assert(await page.locator('.game-assist-picker').isVisible())
  await page.waitForFunction(() => window.calls.some(c => c.method === 'sounds.preview' && c.params.id === 'minecraft:music.menu'))
  await page.getByRole('option', { name: 'minecraft:music.menu', exact: true }).click()
  assert.equal(await page.getByRole('combobox', { name: '音效', exact: true }).inputValue(), 'minecraft:music.menu')
  assert.equal(await page.getByRole('button', { name: /选择药水|选择音效|在游戏中播放/ }).count(), 0)
  await page.getByRole('textbox', { name: '指令', exact: true }).fill('gi')
  await page.getByRole('option', { name: 'give', exact: true }).waitFor()
  await page.getByRole('textbox', { name: '指令', exact: true }).press('Tab')
  assert.equal(await page.getByRole('textbox', { name: '指令', exact: true }).inputValue(), 'give')
  assert.equal(await page.getByRole('button', { name: /停止/ }).count(), 0)
  await page.getByRole('combobox', { name: '药水', exact: true }).click()
  await page.evaluate(() => window.setReadonly(true))
  await page.locator('.game-assist-picker').waitFor({ state: 'detached' })
  assert(await page.getByRole('combobox', { name: '药水', exact: true }).isDisabled())
  await page.evaluate(() => { window.setReadonly(false); window.disconnectGame() })
  await page.getByRole('combobox', { name: '药水', exact: true }).click()
  assert.equal(await page.locator('.game-assist-picker').count(), 0)
  await page.getByRole('combobox', { name: '药水', exact: true }).fill('example:manual')
  assert.equal(await page.getByRole('combobox', { name: '药水', exact: true }).inputValue(), 'example:manual')
  assert.deepEqual(errors, [])
  await page.screenshot({path:'node_modules/.cache/assistance-ui/result.png'})
  console.log('PASS: focus/search combobox, independent row preview, keyboard selection, viewport-safe popup, readonly revocation, offline manual input; mocked MC transport')
} finally { await browser.close(); await server.close() }
