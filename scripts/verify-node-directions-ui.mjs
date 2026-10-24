import assert from 'node:assert/strict'
import {createServer} from 'vite'
import {chromium} from 'playwright'
const server=await createServer({cacheDir:'node_modules/.cache/node-directions-ui',server:{host:'127.0.0.1',port:0,hmr:false},optimizeDeps:{include:['react','react-dom/client','react/jsx-dev-runtime','@xyflow/react']}})
await server.listen();server.config.server.port=server.httpServer.address().port
const base=`http://127.0.0.1:${server.httpServer.address().port}`,browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})})
try{
 const page=await browser.newPage({viewport:{width:1200,height:850}}),errors=[];page.on('pageerror',e=>errors.push(e.message))
 const source=await(await fetch(base+'/src/nodeEditor/DirectionalExample.tsx')).text(),react=source.match(/"([^" ]*deps\/react\.js[^" ]*)"/)[1],dom=react.replace(/react\.js.*$/,'react-dom_client.js')+new URL(react,base).search
 await page.route('**/__directions',route=>route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><style>body{margin:0}</style><script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script><div id="root"></div><script type="module">import React from '${react}';import DOM from '${dom}';import {DirectionalExample} from '/src/nodeEditor/DirectionalExample.tsx';DOM.createRoot(document.getElementById('root')).render(React.createElement(DirectionalExample));</script>`}))
 await page.goto(base+'/__directions');await page.locator('[data-canvas-node="root"]').waitFor()
 const socket=(id,port)=>page.locator(`[data-node-id="${id}"][data-flow-socket="${port}"]`)
 const values=async locator=>(await locator.getAttribute('d')).match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi).map(Number)
 const normal={top:[0,-1],bottom:[0,1],left:[-1,0],right:[1,0]}
 const check=async(locator,from,to)=>{const n=await values(locator),a=normal[from],b=normal[to];assert((n[2]-n[0])*a[0]+(n[3]-n[1])*a[1]>0);assert((n[4]-n[6])*b[0]+(n[5]-n[7])*b[1]>0);assert(Math.abs((n[2]-n[0])*a[1]-(n[3]-n[1])*a[0])<.01);assert(Math.abs((n[4]-n[6])*b[1]-(n[5]-n[7])*b[0])<.01)}
 const edge=page.locator('[data-editor-edge="first"]')
 for(const [direction,from,to]of [['down','bottom','top'],['up','top','bottom'],['right','right','left'],['left','left','right']]){
  await page.getByLabel('布局方向').selectOption(direction);await page.getByRole('button',{name:'显示全部'}).click();await page.waitForTimeout(100)
  assert((await socket('root','out').getAttribute('class')).includes('react-flow__handle-'+from));await check(edge,from,to)
 }
 await page.getByLabel('布局方向').selectOption('down');await page.getByRole('button',{name:'显示全部'}).click();await page.waitForTimeout(100)
 // Input-first drag previews and commits the same normalized source->target curve.
 const start=await socket('b','in').boundingBox(),end=await socket('root','out').boundingBox()
 await page.mouse.move(start.x+start.width/2,start.y+start.height/2);await page.mouse.down();await page.mouse.move(end.x+end.width/2,end.y+end.height/2,{steps:10});await page.waitForTimeout(50)
 await check(page.locator('.react-flow__connection-path'),'bottom','top');await page.mouse.up();await page.locator('[data-editor-edge="second"]').waitFor()
 await check(page.locator('[data-editor-edge="second"]'),'bottom','top')
 const before=await values(edge);await page.getByRole('button',{name:'移动端口'}).click();await page.waitForTimeout(100);const after=await values(edge)
 assert(Math.abs(after[0]-before[0]+40)<.1);assert(Math.abs(after[6]-before[6]+40)<.1,'both endpoints refresh after x offset change')
 await page.getByRole('button',{name:'交换端口方位'}).click();await page.waitForTimeout(100);await check(edge,'top','bottom')
 assert((await socket('root','out').getAttribute('class')).includes('react-flow__handle-top'))
 await page.getByRole('button',{name:'交换端口方位'}).click();await page.getByRole('button',{name:'移动端口'}).click();await page.waitForTimeout(100)
 await page.screenshot({path:'node_modules/.cache/node-directions-ui/down.png'})
 assert.deepEqual(errors,[]);console.log('PASS directional UI: four orientations, reverse-input preview/connection, live side and offset refresh')
}finally{await browser.close();await server.close()}
