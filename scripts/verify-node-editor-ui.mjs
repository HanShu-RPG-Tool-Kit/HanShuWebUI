import { readdir,readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { chromium } from 'playwright'
for(const file of await readdir('src/nodeEditor'))if(/\.tsx?$/.test(file)){const source=await readFile(`src/nodeEditor/${file}`,'utf8');assert(!/from\s+['"][^'"]*(?:workspaces|project\/|collab\/)/.test(source),`node editor imports business/storage: ${file}`)}
const server=await createServer({cacheDir:'node_modules/.cache/node-editor-ui',server:{host:'127.0.0.1',port:0,hmr:false},optimizeDeps:{include:['react','react-dom/client','react/jsx-dev-runtime','@xyflow/react']}})
await server.listen();server.config.server.port=server.httpServer.address().port
const base=`http://127.0.0.1:${server.httpServer.address().port}`
const browser=await chromium.launch({headless:true,args:['--disable-features=LocalNetworkAccessChecks'],...(process.platform==='win32'?{channel:'msedge'}:{})})
try{
 const page=await browser.newPage({viewport:{width:1200,height:800}}),errors=[]
 page.on('pageerror',error=>{errors.push(error.message);console.error(error.message)})
 const transformed=await(await fetch(base+'/src/nodeEditor/Example.tsx')).text(),react=transformed.match(/"([^" ]*deps\/react\.js[^" ]*)"/)[1],dom=react.replace(/react\.js.*$/,'react-dom_client.js')+new URL(react,base).search
 await page.route('**/__node-editor',route=>route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><style>body{margin:0}</style><script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script><div id="root"></div><script type="module">import React from '${react}';import DOM from '${dom}';import {NodeEditorExample} from '/src/nodeEditor/Example.tsx';DOM.createRoot(document.getElementById('root')).render(React.createElement(NodeEditorExample));</script>`}))
 await page.goto(base+'/__node-editor')
 const node=id=>page.locator(`.react-flow__node[data-id="${id}"]`)
 await node('a').waitFor();await page.waitForTimeout(250)
 const initial=await node('a').boundingBox()
 await page.mouse.move(initial.x+70,initial.y+15);await page.mouse.down();await page.mouse.move(initial.x+140,initial.y+65,{steps:6})
 assert.equal(await page.getByLabel('移动提交次数').textContent(),'0','drag only previews')
 await page.mouse.up();await page.waitForTimeout(100)
 assert.equal(await page.getByLabel('移动提交次数').textContent(),'1','one drag commits once')
 let box=await node('a').boundingBox();assert(Math.abs(box.x-initial.x-70)<3)
 // Connect through real React Flow handles, then cut with double-press drag.
 const socket=(id,port)=>page.locator(`[data-node-id="${id}"][data-flow-socket="${port}"]`)
 const source=await socket('c','out').boundingBox(),target=await socket('b','in').boundingBox()
 await page.mouse.move(source.x+source.width/2,source.y+source.height/2);await page.mouse.down();await page.mouse.move(target.x+target.width/2,target.y+target.height/2,{steps:10});await page.mouse.up()
 await page.waitForFunction(()=>document.querySelectorAll('[data-editor-edge]').length===2)
 const stroke=await page.locator('[data-editor-edge]').last().evaluate(path=>{
   const length=path.getTotalLength(),matrix=path.getScreenCTM(),a=path.getPointAtLength(length/2-1),b=path.getPointAtLength(length/2+1),p=path.getPointAtLength(length/2)
   const center=new DOMPoint(p.x,p.y).matrixTransform(matrix),pa=new DOMPoint(a.x,a.y).matrixTransform(matrix),pb=new DOMPoint(b.x,b.y).matrixTransform(matrix),dx=pb.x-pa.x,dy=pb.y-pa.y,n=Math.hypot(dx,dy)
   return {x:center.x,y:center.y,nx:-dy/n*35,ny:dx/n*35}
 })
 await page.mouse.click(stroke.x-stroke.nx,stroke.y-stroke.ny);await page.mouse.move(stroke.x-stroke.nx,stroke.y-stroke.ny);await page.mouse.down();await page.mouse.move(stroke.x+stroke.nx,stroke.y+stroke.ny,{steps:10});await page.mouse.up()
 await page.waitForFunction(()=>document.querySelectorAll('[data-editor-edge]').length===1)
 // Multi-select and group through the generic context menu.
 await node('a').click();await node('b').click({modifiers:['Shift']})
 await node('b').click({button:'right'})
 await page.getByRole('menuitem',{name:/Group · 2/}).click()
 const heading=page.locator('.node-editor-group-heading');await heading.waitFor()
 await heading.dblclick();await page.getByRole('textbox',{name:'Group 名称'}).fill('可复用分组');await page.getByRole('textbox',{name:'Group 名称'}).press('Enter')
 await page.waitForFunction(()=>document.querySelector('.node-editor-group-heading').textContent.includes('可复用分组'))
 const a=await node('a').boundingBox(),b=await node('b').boundingBox(),g=await heading.boundingBox()
 await page.mouse.move(g.x+25,g.y+10);await page.mouse.down();await page.mouse.move(g.x+65,g.y+50,{steps:5});await page.mouse.up();await page.waitForTimeout(100)
 const aa=await node('a').boundingBox(),bb=await node('b').boundingBox();assert(Math.abs(aa.x-a.x-40)<3);assert(Math.abs(bb.y-b.y-40)<3)
 // Reusable note editing and resizing do not create position commits.
 await page.locator('.node-editor-note').dblclick()
 await page.getByRole('textbox',{name:'注释内容'}).fill('通用注释已修改')
 await page.getByRole('textbox',{name:'注释内容'}).press('Control+Enter')
 await page.waitForFunction(()=>document.querySelector('.node-editor-note p')?.textContent==='通用注释已修改')
 const noteBefore=await node('note').boundingBox(),handle=page.locator('.node-editor-note-resize').last()
 await node('note').click();await handle.waitFor()
 const resize=await handle.boundingBox(),movesBeforeResize=await page.getByLabel('移动提交次数').textContent()
 await page.mouse.move(resize.x+resize.width/2,resize.y+resize.height/2);await page.mouse.down();await page.mouse.move(resize.x+50,resize.y+40,{steps:4});await page.mouse.up();await page.waitForTimeout(100)
 const noteAfter=await node('note').boundingBox();assert(noteAfter.width>noteBefore.width+30);assert.equal(await page.getByLabel('移动提交次数').textContent(),movesBeforeResize)
 // Wheel zoom and right-button pan change view only.
 const beforeMoves=await page.getByLabel('移动提交次数').textContent()
 await page.mouse.move(1000,650);await page.mouse.down({button:'right'});await page.mouse.move(1060,690,{steps:5});await page.mouse.up({button:'right'});await page.waitForTimeout(150)
 assert.equal(await page.getByRole('menu').count(),0,'right drag must not open menu')
 await page.mouse.wheel(0,-100);await page.waitForTimeout(300)
 assert.equal(await page.getByLabel('移动提交次数').textContent(),beforeMoves)
 // Readonly protects data even through Delete and drag.
 await page.getByRole('button',{name:'切换只读'}).click();const frozen=await node('a').boundingBox()
 await page.mouse.move(frozen.x+40,frozen.y+10);await page.mouse.down();await page.mouse.move(frozen.x+90,frozen.y+50,{steps:4});await page.mouse.up();await page.keyboard.press('Delete')
 assert.equal(await node('a').count(),1);assert.equal(await page.getByLabel('移动提交次数').textContent(),beforeMoves)
 await page.route('**/__progress-graph',route=>route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><style>body{margin:0}</style><script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script><div id="root" class="flow-workspace" style="height:100vh"></div><script type="module">
 import React from '${react}';import DOM from '${dom}';import {ProgressGraph} from '/src/workspaces/gameplay/ProgressGraph.tsx';import * as M from '/src/workspaces/gameplay/model.ts';import * as C from '/src/workspaces/gameplay/canvas.ts';import '/src/index.css';import '/src/App.css';import '/src/workspaces/GameplayWorkspace.css';
 let f=M.createFlow('migration-test');const t=C.createTransitionNode(f,{x:300,y:80});f=t.flow;const p1=C.createProgressNode(f,{x:600,y:80});f=p1.flow;const end=C.createEndNode(f,{x:900,y:80});f=end.flow;f=M.connectNodes(f,f.start,t.id,'input','output').flow;f=M.connectNodes(f,t.id,p1.id,'input','output').flow;f.layout.positions[f.start]={x:64,y:80};window.ids={start:f.start,t:t.id,p1:p1.id,end:end.id};window.edits=[];
 function App(){const [flow,F]=React.useState(f),[selection,S]=React.useState({kind:'flow'});window.flow=flow;return React.createElement(ProgressGraph,{flow,selection,onSelect:S,active:true,definitions:[],kitOptions:[],
 onCreate:(position,type)=>F(prev=>{const r=type==='note'?C.createCanvasNote(prev,position):type==='predicate'?C.createPredicateNode(prev,position):type==='transition'?C.createTransitionNode(prev,position):type==='end'?C.createEndNode(prev,position):C.createProgressNode(prev,position);return r.flow}),
 onChangeFlow:next=>F(next),onMove:p=>F(prev=>C.moveCanvasNodes(prev,p)),onGroup:ids=>{F(prev=>C.groupCanvasNodes(prev,ids).flow);return 'group'},onUngroup:()=>{},onRenameGroup:()=>{},onDelete:id=>F(prev=>C.removeCanvasItems(prev,[id])),onDeleteMany:ids=>F(prev=>C.removeCanvasItems(prev,ids)),onArrange:()=>{},onUpdateNote:(id,patch)=>F(prev=>C.updateCanvasNote(prev,id,patch)),onConnect:(from,to,port,fromPort)=>F(prev=>M.connectNodes(prev,from,to,port,fromPort).flow),onDisconnect:()=>{},onCut:()=>{}})}DOM.createRoot(document.getElementById('root')).render(React.createElement(App));</script>`}))
 await page.goto(base+'/__progress-graph');await page.locator('[data-progress-state]').first().waitFor();await page.waitForTimeout(250)
 const ids=await page.evaluate(()=>window.ids)
 const startNode=page.locator(`[data-canvas-node="${ids.start}"]`),before=await startNode.boundingBox()
 await page.mouse.move(before.x+80,before.y+12);await page.mouse.down();await page.mouse.move(before.x+120,before.y+42,{steps:6});await page.mouse.up()
 await page.waitForFunction(id=>window.flow.layout.positions[id].x>90,ids.start)
 const out=await socket(ids.p1,'output').boundingBox(),into=await socket(ids.end,'input').boundingBox()
 await page.mouse.move(out.x+out.width/2,out.y+out.height/2);await page.mouse.down();await page.mouse.move(into.x+into.width/2,into.y+into.height/2,{steps:10});await page.mouse.up()
 await page.waitForFunction(id=>window.flow.logic.links.some(link=>link.to===id&&link.port==='input'),ids.end)
 await page.getByRole('button',{name:'初始化任务',exact:true}).click()
 await page.waitForFunction(id=>document.querySelector(`[data-canvas-node="${id}"]`)?.getAttribute('data-progress-state')==='running',ids.start)
 await startNode.click({modifiers:['Control']})
 await page.waitForFunction(id=>document.querySelector(`[data-canvas-node="${id}"]`)?.getAttribute('data-progress-state')==='running',ids.p1)
 const p1Node=page.locator(`[data-canvas-node="${ids.p1}"]`)
 await p1Node.dblclick();await page.locator('.node-form-view').waitFor()
 await p1Node.dblclick();await page.waitForTimeout(150)
 assert.equal(await page.locator('.node-form-view').count(),1,'one form view per node')
 await page.getByRole('button',{name:'关闭表单'}).click()
 await page.waitForFunction(()=>!document.querySelector('.node-form-view'))
 await startNode.click();await page.keyboard.press('Delete')
 assert.equal(await page.locator(`[data-canvas-node="${ids.start}"]`).count(),1,'start progress cannot be deleted')
 assert.equal(await page.evaluate(()=>window.flow.format),'hanshu.progress-tree')
 assert.equal(await page.evaluate(()=>Object.hasOwn(window.flow,'edges')),false,'React Flow state never becomes document schema')
 await page.screenshot({path:'node_modules/.cache/node-editor-ui/progress.png'})
 console.log('PASS progress v2: native schema, drag, socket connect, start→transition→progress, inline form view, undeletable start')

 // Two independent providers, large graphs, repeated transactions and caller-owned history.
 await page.route('**/__stress',route=>route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><style>body{margin:0}#root{display:flex;height:100vh}.pane{display:flex;flex-direction:column;width:50%;min-width:0}</style><script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script><div id="root"></div><script type="module">
 import React from '${react}';import DOM from '${dom}';import {NodeEditor,NodeFrame,NodeHeader,PortLabel} from '/src/nodeEditor/index.ts';
 const count=600,seed=Array.from({length:count},(_,i)=>({id:'n'+i,type:'card',position:{x:(i%30)*260,y:Math.floor(i/30)*140},width:216,height:108,label:'Node '+i,ports:[{id:'in',direction:'input',label:'In',y:65},{id:'out',direction:'output',label:'Out',y:65}],data:{}}));
 const edges=seed.slice(1).map((n,i)=>({id:'e'+i,source:'n'+i,target:n.id,sourcePort:'out',targetPort:'in'}));
 function Card({node,selected}){return React.createElement(NodeFrame,{selected},React.createElement(NodeHeader,{title:node.label}),node.ports.map(p=>React.createElement(PortLabel,{key:p.id,direction:p.direction,y:p.y},p.label)))}const registry={card:{component:Card}};window.stress={};
 function Pane({id}){const editor=React.useRef(null);const [history,H]=React.useState([seed]),[cursor,C]=React.useState(0);const nodes=history[cursor];window.stress[id]={x:nodes[0].position.x,cursor,length:history.length};const commit=p=>{H(previous=>[...previous.slice(0,cursor+1),nodes.map(n=>p[n.id]?{...n,position:p[n.id]}:n)]);C(cursor+1)};return React.createElement('section',{className:'pane','data-pane':id},React.createElement('div',null,React.createElement('button',{onClick:()=>C(c=>Math.max(0,c-1))},'Undo'),React.createElement('button',{onClick:()=>C(c=>Math.min(history.length-1,c+1))},'Redo'),React.createElement('button',{onClick:()=>editor.current.focus('n8')},'Focus distant')),React.createElement(NodeEditor,{ref:editor,documentId:id,nodes,edges,registry,onMove:commit,groups:[{id:'g',name:'Group',nodes:['n0','n1']}]}))}
 DOM.createRoot(document.getElementById('root')).render(React.createElement(React.Fragment,null,React.createElement(Pane,{id:'left'}),React.createElement(Pane,{id:'right'})));
 </script>`}))
 const started=performance.now();await page.goto(base+'/__stress');await page.waitForFunction(()=>document.querySelectorAll('[data-canvas-node]').length>0);await page.waitForTimeout(300)
 console.log('MEASURE 2 × 600 nodes / 599 edges mounted:',Math.round(performance.now()-started),'ms')
 const left=page.locator('[data-pane="left"]'),right=page.locator('[data-pane="right"]')
 for(let i=0;i<12;i++){
   const heading=await left.locator('.node-editor-group-heading').boundingBox()
   await page.mouse.move(heading.x+20,heading.y+10);await page.mouse.down();await page.mouse.move(heading.x+24,heading.y+10,{steps:2});await page.mouse.up()
   await page.waitForFunction(i=>window.stress.left.cursor===i+1,i)
 }
 assert.equal(await page.evaluate(()=>window.stress.right.cursor),0,'other pane cannot receive edits')
 assert.equal(await page.evaluate(()=>window.stress.left.length),13,'one history step per group drag')
 for(let i=0;i<12;i++)await left.getByRole('button',{name:'Undo',exact:true}).click()
 await page.waitForFunction(()=>window.stress.left.x===0)
 for(let i=0;i<12;i++)await left.getByRole('button',{name:'Redo',exact:true}).click()
 await page.waitForFunction(()=>window.stress.left.cursor===12)
 assert.equal(await page.evaluate(()=>window.stress.left.x),48)
 assert.equal(await page.evaluate(()=>window.stress.right.x),0)
 const visible=await left.locator('[data-canvas-node]').count();assert(visible<600,'large graphs cull offscreen nodes')
 await left.getByRole('button',{name:'Focus distant'}).click();await left.locator('[data-canvas-node="n8"]').waitFor()

 const rightTransform=await right.locator('.react-flow__viewport').getAttribute('style')
 await page.mouse.move(450,600);await page.mouse.wheel(0,-100);await page.waitForTimeout(250)
 assert.equal(await right.locator('.react-flow__viewport').getAttribute('style'),rightTransform,'pane viewports isolated')
 console.log('PASS stress: 1200 nodes, 1198 edges, repeated group moves, 12 undo/redo steps, independent panes and viewports')
 assert.deepEqual(errors,[])
 await page.screenshot({path:'node_modules/.cache/node-editor-ui/example.png'})
 console.log('PASS reusable React Flow editor: atomic drag, multiselect, group rename/move, right pan, zoom, readonly; no progress imports')
}finally{await browser.close();await server.close()}
