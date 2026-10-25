import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { chromium } from 'playwright'
const server=await createServer({cacheDir:'node_modules/.cache/goal-views-ui',server:{host:'127.0.0.1',port:0,hmr:false},optimizeDeps:{include:['react','react-dom/client','react/jsx-dev-runtime','@xyflow/react']}})
await server.listen();server.config.server.port=server.httpServer.address().port
const base=`http://127.0.0.1:${server.httpServer.address().port}`
const browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})})
try {
 const page=await browser.newPage({viewport:{width:1280,height:1100}}),errors=[]
 page.on('pageerror',e=>errors.push(e.message))
 const transformed=await(await fetch(base+'/src/workspaces/quest/ProgressEditor.tsx')).text(),react=transformed.match(/"([^" ]*deps\/react\.js[^" ]*)"/)[1],dom=react.replace(/react\.js.*$/,'react-dom_client.js')+new URL(react,base).search
 await page.route('**/__goal-views',r=>r.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><style>body{margin:0}#root{display:flex;height:100vh}</style><script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script><div id="root"></div><script type="module">
 import React from '${react}';import DOM from '${dom}';import {ProgressEditor} from '/src/workspaces/quest/ProgressEditor.tsx';import {createProgress,parseProgress} from '/src/workspaces/quest/progressDoc.ts';
 const definitions=[1,4,2].map((count,i)=>({kind:'type'+i,label:['击杀','收集','对话'][i],fields:Array.from({length:count},(_,j)=>({key:'f'+j,type:'int',label:'数量'+j,required:false,default:1})),sourceKey:null,sourceName:'fixture'})),catalog={definitions,byKind:new Map(definitions.map(d=>[d.kind,d])),errors:[]};
 let seed=createProgress();seed.goals=Array.from({length:7},(_,i)=>({id:'g'+i,kind:'type'+i%3,config:{}}));window.edits=0;
 function App(){const [doc,D]=React.useState(seed);window.doc=doc;return React.createElement(ProgressEditor,{doc,goalCatalog:catalog,onChange:source=>{window.edits++;D(parseProgress(source))}})}DOM.createRoot(document.getElementById('root')).render(React.createElement(App));
 </script>`}))
 await page.goto(base+'/__goal-views');const cards=page.locator('.progress-goal')
 await cards.first().waitFor();await page.waitForTimeout(100)
 assert.equal(await page.getByRole('button',{name:'紧凑',exact:true}).getAttribute('aria-pressed'),'true')
 assert.equal(await page.locator('.progress-drag').count(),0)
 const layout=()=>cards.evaluateAll(nodes=>nodes.map(n=>{const b=n.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height}}))
 const disjoint=async()=>{const boxes=await layout();for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){const a=boxes[i],b=boxes[j];assert(a.x+a.w<=b.x+1||b.x+b.w<=a.x+1||a.y+a.h<=b.y+1||b.y+b.h<=a.y+1,`cards ${i}/${j} overlap`)}}
 let boxes=await layout();assert.equal(new Set(boxes.slice(0,3).map(b=>Math.round(b.x))).size,3,'wide editor has three automatic columns');assert(boxes[1].h>boxes[0].h)
 await disjoint()
 // Invalid integer draft must survive view changes even though blur cannot commit it.
 const input=cards.first().getByRole('spinbutton',{name:'数量0',exact:true});await input.fill('1.25')
 await page.getByRole('button',{name:'列表',exact:true}).click();assert.equal(await input.inputValue(),'1.25')
 assert.equal(await page.locator('.progress-drag').count(),7)
 assert.equal(await page.evaluate(()=>window.edits),0,'view changes do not write .quest')
 boxes=await layout();assert.equal(new Set(boxes.map(b=>Math.round(b.x))).size,1)
 await input.press('Escape')
 // Collapse state survives both layouts, resize and remeasurement.
 await cards.nth(1).locator('.progress-goal-open').click()
 await page.getByRole('button',{name:'紧凑',exact:true}).click();assert.equal(await cards.nth(1).locator('.progress-goal-open').getAttribute('aria-expanded'),'false');await page.waitForTimeout(100);await disjoint()
 await page.setViewportSize({width:480,height:1100});await page.waitForTimeout(100)
 boxes=await layout();assert.equal(new Set(boxes.map(b=>Math.round(b.x))).size,1,'narrow editor has one column');await disjoint()
 assert(await page.locator('.progress-form-scroll').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'no horizontal overflow')
 await page.setViewportSize({width:1280,height:1100});await page.getByRole('button',{name:'列表',exact:true}).click()
 await cards.first().scrollIntoViewIfNeeded();const first=await cards.first().locator('.progress-drag').boundingBox(),second=await cards.nth(1).boundingBox()
 await page.mouse.move(first.x+first.width/2,first.y+first.height/2);await page.mouse.down();await page.mouse.move(first.x+first.width/2,second.y+second.height-2,{steps:8});await page.mouse.up()
 await page.waitForFunction(()=>window.doc.goals[0].id==='g1')
 assert.equal(await page.evaluate(()=>window.edits),1,'one reorder is one document change')
 assert.equal(await page.evaluate(()=>JSON.stringify(window.doc).includes('goalView')),false)
 await page.reload();await cards.first().waitFor();assert.equal(await page.getByRole('button',{name:'列表',exact:true}).getAttribute('aria-pressed'),'true','local preference survives reload')
 await page.getByRole('button',{name:'紧凑',exact:true}).click();await page.locator('.progress-objectives').scrollIntoViewIfNeeded();await page.waitForTimeout(100)
 await page.screenshot({path:'node_modules/.cache/goal-views-ui/compact.png'})
 assert.deepEqual(errors,[])
 console.log('PASS goal views: automatic columns, variable heights, no overlap/overflow, retained drafts/folds, list-only reorder and local-only preference')
} finally {await browser.close();await server.close()}
