import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { chromium } from 'playwright'
const server=await createServer({cacheDir:'node_modules/.cache/completion-ui',server:{host:'127.0.0.1',port:0,hmr:false},optimizeDeps:{include:['react','react-dom/client','react/jsx-dev-runtime','@xyflow/react']}})
await server.listen();server.config.server.port=server.httpServer.address().port
const base=`http://127.0.0.1:${server.httpServer.address().port}`
const browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})})
try {
 const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[]
 page.on('pageerror',e=>errors.push(e.message))
 const transformed=await(await fetch(base+'/src/workspaces/gameplay/ProgressEditor.tsx')).text(),react=transformed.match(/"([^" ]*deps\/react\.js[^" ]*)"/)[1],dom=react.replace(/react\.js.*$/,'react-dom_client.js')+new URL(react,base).search
 await page.route('**/__completion',r=>r.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><style>body{margin:0}#root{display:flex;height:100vh}</style><script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script><div id="root"></div><script type="module">
 import React from '${react}';import DOM from '${dom}';import {ProgressEditor} from '/src/workspaces/gameplay/ProgressEditor.tsx';import {createProgress,parseProgress,stringifyProgress} from '/src/workspaces/gameplay/progressDoc.ts';
 const definitions=['kill','collect'].map(kind=>({kind,label:kind==='kill'?'击杀':'收集',fields:[],sourceKey:null,sourceName:'fixture'})),catalog={definitions,byKind:new Map(definitions.map(d=>[d.kind,d])),errors:[]};
 let seed=createProgress();seed.goals=['kill','collect','kill'].map((kind,i)=>({id:'uuid-goal-'+i,kind,config:{}}));seed.completionGraph={nodes:[{id:'ref-a',type:'goal',goalId:'uuid-goal-0'},{id:'ref-b',type:'goal',goalId:'uuid-goal-1'},{id:'logic',type:'logic',op:'and'},{id:'output',type:'output'}],links:[{id:'edge-a',from:'ref-a',to:'logic'},{id:'edge-b',from:'ref-b',to:'logic'},{id:'edge-o',from:'logic',to:'output'}]};window.edits=0;
 function App(){const [doc,D]=React.useState(seed),[disabled,B]=React.useState(false);window.doc=doc;window.freeze=B;window.reorder=()=>D(p=>({...p,goals:[p.goals[1],p.goals[0],p.goals[2]]}));window.reload=()=>{const next=parseProgress(stringifyProgress(doc));next.id='reopened';D(next)};return React.createElement(ProgressEditor,{doc,goalCatalog:catalog,disabled,onChange:source=>{window.edits++;D(parseProgress(source))}})}DOM.createRoot(document.getElementById('root')).render(React.createElement(App));
 </script>`}))
 await page.goto(base+'/__completion');await page.getByRole('button',{name:'自定义完成',exact:true}).click()
 const graph=page.getByRole('region',{name:'自定义完成节点编辑器'})
 await graph.scrollIntoViewIfNeeded();await graph.locator('[data-canvas-node="output"]').waitFor();await page.waitForTimeout(200)
 assert.deepEqual(await page.locator('.progress-goal-alias').allTextContents(),['A1','B1','A2'])
 assert.equal(await graph.locator('[data-canvas-node="ref-a"] .node-header-title').textContent(),'Goal · A1')
 const before=await page.evaluate(()=>window.edits),node=graph.locator('[data-canvas-node="ref-a"]')
 let box=await node.boundingBox();await page.mouse.move(box.x+60,box.y+12);await page.mouse.down();await page.mouse.move(box.x+90,box.y+32,{steps:5});await page.mouse.up();assert.equal(await page.evaluate(()=>window.edits),before,'moving layout does not save document')
 const moved=await node.boundingBox()
 await page.getByRole('button',{name:'完成任一',exact:true}).click();await page.getByRole('button',{name:'自定义完成',exact:true}).click();await graph.scrollIntoViewIfNeeded()
 assert.equal(await page.evaluate(()=>window.doc.completionGraph.links.length),3,'switch preserves custom expression')
 assert(Math.abs((await node.boundingBox()).x-moved.x)<2,'switch preserves session layout')
 await graph.getByRole('combobox',{name:'逻辑运算'}).selectOption('not')
 assert.equal(await page.evaluate(()=>window.doc.completionGraph.nodes.find(n=>n.id==='logic').op),'and','cannot silently drop wires on arity change')
 await graph.getByRole('combobox',{name:'逻辑运算'}).selectOption('xor')
 assert.equal(await page.evaluate(()=>window.doc.completionGraph.nodes.find(n=>n.id==='logic').op),'xor')
 // Cut/delete is the common editor interaction and only updates semantic links.
 await graph.locator('[data-editor-edge="edge-b"]').click({force:true});await page.keyboard.press('Delete')
 await page.waitForFunction(()=>window.doc.completionGraph.links.length===2)
 assert((await graph.locator('.completion-footer').textContent()).includes('二元异或的输入未接完整'))
 const socket=(id,port)=>graph.locator(`[data-node-id="${id}"][data-flow-socket="${port}"]`)
 const connect=async(from,to)=>{const a=await socket(from,'out').boundingBox(),b=await socket(to,'in').boundingBox();await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:8});await page.mouse.up()}
 await connect('ref-b','logic');await page.waitForFunction(()=>window.doc.completionGraph.links.length===3)
 await graph.locator('[data-canvas-node="output"]').click();await page.keyboard.press('Delete');assert.equal(await graph.locator('[data-canvas-node="output"]').count(),1)
 await page.evaluate(()=>window.reorder());await page.waitForTimeout(80)
 assert.deepEqual(await page.locator('.progress-goal-alias').allTextContents(),['A1','B1','B2'])
 assert.equal(await graph.locator('[data-canvas-node="ref-a"] .node-header-title').textContent(),'Goal · B1')
 await page.evaluate(()=>window.reload());await page.waitForTimeout(100)
 assert.equal(await page.evaluate(()=>JSON.stringify(window.doc.completionGraph).includes('position')),false)
 await page.screenshot({path:'node_modules/.cache/completion-ui/editor.png'})
 await page.evaluate(()=>window.freeze(true));const frozen=await page.evaluate(()=>window.edits)
 assert.equal(await graph.getByRole('button',{name:'＋ Goal',exact:true}).isDisabled(),true)
 await graph.locator('[data-canvas-node="logic"]').click({force:true});await page.keyboard.press('Delete');assert.equal(await page.evaluate(()=>window.edits),frozen)
 assert.deepEqual(errors,[])
 console.log('PASS custom completion UI: mode preservation, aliases, local layout, arity edits, actual handle connection, protected output, readonly and roundtrip')
} finally {await browser.close();await server.close()}
