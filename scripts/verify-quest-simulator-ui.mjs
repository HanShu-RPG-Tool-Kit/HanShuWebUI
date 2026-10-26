import assert from 'node:assert/strict'
import {mkdir} from 'node:fs/promises'
import {createServer} from 'vite'
import {chromium} from 'playwright'
const server=await createServer({cacheDir:'node_modules/.cache/quest-sim-ui',server:{host:'127.0.0.1',port:0,hmr:false},optimizeDeps:{include:['react','react-dom/client','react/jsx-dev-runtime','@xyflow/react']}})
await server.listen();const base=`http://127.0.0.1:${server.httpServer.address().port}`
const browser=await chromium.launch({headless:true,...process.platform==='win32'?{channel:'msedge'}:{}})
try{
 const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[]
 page.on('pageerror',error=>errors.push(error.message))
 const transformed=await(await fetch(base+'/src/nodeEditor/Example.tsx')).text(),react=transformed.match(/"([^" ]*deps\/react\.js[^" ]*)"/)[1],dom=react.replace(/react\.js.*$/,'react-dom_client.js')+new URL(react,base).search
 await page.route('**/__quest-simulator',route=>route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><style>body{margin:0;background:#242424}.gameplay-workspace{height:100vh}</style><script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script><div id="root"></div><script type="module">
 import React from '${react}';import DOM from '${dom}';import {ProgressGraph} from '/src/workspaces/gameplay/ProgressGraph.tsx';import * as M from '/src/workspaces/gameplay/model.ts';import * as C from '/src/workspaces/gameplay/canvas.ts';
 let f=M.createFlow('调试示例');f.progress[f.start].title={text:'启程'};let a=C.createProgressNode(f,{x:420,y:0});f=a.flow;f.progress[a.id].title={text:'寻找线索'};let b=C.createProgressNode(f,{x:420,y:230});f=b.flow;f.progress[b.id].title={text:'探索营地'};let e=C.createEndNode(f,{x:790,y:0});f=e.flow;f.ends[e.id].title={text:'调查完成'};
 f=C.moveCanvasNodes(f,{[f.start]:{x:60,y:100}});f=M.connectNodes(f,f.start,a.id,'input','output').flow;f=M.connectNodes(f,f.start,b.id,'input','output').flow;f=M.connectNodes(f,a.id,e.id,'input','output').flow;f=M.connectNodes(f,a.id,e.id,'input2','output').flow;
 window.ids={start:f.start,a:a.id,b:b.id,end:e.id};window.commits=0;
 function App(){const [flow,F]=React.useState(f),[selection,S]=React.useState({kind:'flow'});window.flow=flow;window.refreshUnchanged=()=>F(previous=>structuredClone(previous));return React.createElement('div',{className:'gameplay-workspace'},React.createElement(ProgressGraph,{flow,selection,onSelect:S,active:true,definitions:[],onCreate:()=>{},onChangeFlow:F,onMove:p=>{window.commits++;F(prev=>C.moveCanvasNodes(prev,p))},onGroup:()=>null,onUngroup:()=>{},onRenameGroup:()=>{},onDelete:()=>{},onDeleteMany:()=>{},onArrange:()=>{},onUpdateNote:()=>{},onConnect:()=>{},onDisconnect:()=>{},onCut:()=>{}}))}DOM.createRoot(document.getElementById('root')).render(React.createElement(App));</script>`}))
 await page.goto(base+'/__quest-simulator');await page.locator('.signal-debugger').waitFor();await page.waitForTimeout(300);await page.getByRole('button',{name:'显示全部',exact:true}).click();await page.waitForTimeout(300)
 const ids=await page.evaluate(()=>window.ids),node=id=>page.locator(`[data-canvas-node="${id}"]`)
 assert.equal(await page.locator('.node-editor-wire-badge:not(.is-reverse)').count(),4)
 await page.getByRole('button',{name:'初始化任务',exact:true}).click()
 await node(ids.start).click({modifiers:['Control']})
 const queue=page.getByRole('list',{name:'待投递信号',exact:true})
 await page.waitForFunction(()=>document.querySelectorAll('[aria-label="待投递信号"] [role="listitem"]').length===2)
 assert.equal(await node(ids.a).locator('[data-progress-state]').getAttribute('data-progress-state'),'inactive')
 await page.getByRole('button',{name:'单步',exact:true}).click()
 await page.waitForFunction(id=>document.querySelector(`[data-canvas-node="${id}"] [data-progress-state]`)?.getAttribute('data-progress-state')==='running',ids.a)
 assert.equal(await node(ids.a).locator('[data-progress-state]').getAttribute('data-progress-state'),'running')
 assert.equal(await node(ids.b).locator('[data-progress-state]').getAttribute('data-progress-state'),'inactive')
 assert.match(await queue.innerText(),/C/)
 console.log('PASS one signal step updates exactly one receiver and appends generated signals')
 await page.getByLabel('信号播放速度').selectOption('1200');await page.getByRole('button',{name:'播放',exact:true}).click()
 await page.waitForTimeout(230)
 const particle=page.locator('.node-editor-wire-signal')
 assert.equal(await particle.count(),1)
 const distance=await particle.evaluate(el=>getComputedStyle(el).offsetDistance)
 assert(parseFloat(distance)>0,`particle must travel: ${distance}`)
 await page.getByRole('button',{name:'暂停',exact:true}).click()
 const rowsBefore=await queue.innerText();await page.evaluate(()=>window.refreshUnchanged());await page.waitForTimeout(300);assert.equal(await queue.innerText(),rowsBefore)
 assert.equal(await node(ids.b).locator('[data-progress-state]').getAttribute('data-progress-state'),'inactive')
 const box=await node(ids.a).boundingBox();await page.mouse.move(box.x+60,box.y+14);await page.mouse.down();await page.mouse.move(box.x+130,box.y+50,{steps:5});await page.mouse.up();assert.equal(await page.evaluate(()=>window.commits),0)
 await mkdir('node_modules/.cache/quest-simulator',{recursive:true});await page.screenshot({path:'node_modules/.cache/quest-simulator/paused.png'})
 console.log('PASS visible moving signal, pause preserves queue, initialized graph blocks mutation')
 await page.getByRole('button',{name:'单步',exact:true}).click();await page.locator('.node-editor-wire-signal[data-signal="C"]').waitFor();assert.equal(await page.locator('.node-editor-wire-signal').evaluate(el=>getComputedStyle(el).animationDirection),'reverse')
 await page.getByLabel('信号播放速度').selectOption('180');await page.getByRole('button',{name:'播放',exact:true}).click()
 await page.waitForFunction(()=>document.querySelector('[aria-label="信号调试器"] [role="status"]').textContent==='等待事件')
 assert.equal(await node(ids.b).locator('[data-progress-state]').getAttribute('data-progress-state'),'running')
 await node(ids.a).click({modifiers:['Control']});await page.getByRole('button',{name:'单步',exact:true}).click()
 await page.waitForFunction(()=>document.querySelector('[aria-label="信号调试器"] [role="status"]').textContent.includes('任务成功'))
 await page.waitForFunction(id=>document.querySelector(`[data-canvas-node="${id}"] [data-progress-state]`)?.getAttribute('data-progress-state')==='terminated',ids.b)
 assert.equal(await node(ids.b).locator('[data-progress-state]').getAttribute('data-progress-state'),'terminated')
 assert.equal(await queue.getByRole('listitem').count(),0)
 await page.getByRole('button',{name:'已丢弃 1',exact:true}).click();assert.match(await page.getByRole('list',{name:'丢弃信号',exact:true}).innerText(),/任务已结束/)
 await page.screenshot({path:'node_modules/.cache/quest-simulator/terminal.png'})
 assert(await page.getByRole('button',{name:'单步',exact:true}).isDisabled())
 console.log('PASS terminal locks outcome, terminates sibling, visibly discards queued failure')
 await page.getByRole('button',{name:'重置模拟',exact:true}).click();assert.match(await page.getByRole('region',{name:'信号调试器'}).innerText(),/未初始化/)
 await page.waitForFunction(id=>document.querySelector(`[data-canvas-node="${id}"] [data-progress-state]`)?.getAttribute('data-progress-state')==='inactive',ids.a)
 assert.equal(await node(ids.a).locator('[data-progress-state]').getAttribute('data-progress-state'),'inactive')
 assert.deepEqual(errors,[])
 console.log('PASS reset releases simulation and browser has no runtime errors')
}finally{await browser.close();await server.close()}
