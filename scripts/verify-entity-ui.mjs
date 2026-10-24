import assert from 'node:assert/strict'
import {createServer} from 'vite'
import {chromium} from 'playwright'
const server=await createServer({cacheDir:'node_modules/.cache/entity-ui',server:{host:'127.0.0.1',port:0,hmr:false},optimizeDeps:{include:['react','react-dom/client','react/jsx-dev-runtime','@xyflow/react']}});await server.listen();server.config.server.port=server.httpServer.address().port
const base=`http://127.0.0.1:${server.httpServer.address().port}`,browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})})
try{
 const page=await browser.newPage({viewport:{width:1300,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message))
 const text=await(await fetch(base+'/src/workspaces/progress/EntityEditor.tsx')).text(),react=text.match(/"([^" ]*deps\/react\.js[^" ]*)"/)[1],dom=react.replace(/react\.js.*$/,'react-dom_client.js')+new URL(react,base).search
 await page.route('http://127.0.0.1:8765/**',r=>r.fulfill({contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:'{"ok":true,"subscribers":1}'}))
 await page.route('**/__entity',r=>r.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><style>body{margin:0}#root{display:flex;height:100vh}</style><script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script><div id="root"></div><script type="module">
 import React from '${react}';import DOM from '${dom}';import {EntityEditor} from '/src/workspaces/progress/EntityEditor.tsx';import {createEntity,parseEntity,stringifyEntity} from '/src/workspaces/progress/entityDoc.ts';import {reconnectGameDevControlNow,disconnectGameDevControl} from '/src/gameDevServer/controlHub.ts';window.disconnectGame=disconnectGameDevControl;
 window.calls=[];window.WebSocket=class {static OPEN=1;static CONNECTING=0;readyState=0;constructor(url){this.stream=String(url).includes('/ws/stream');setTimeout(()=>{this.readyState=1;this.onopen?.({});if(this.stream)this.timer=setInterval(()=>{const b=new ArrayBuffer(32+64*48*4),v=new DataView(b);v.setUint32(0,0x52505346,true);v.setUint16(4,32,true);v.setUint16(6,1,true);v.setUint32(8,64,true);v.setUint32(12,48,true);v.setUint32(16,256,true);const pixels=new Uint8Array(b,32);for(let i=0;i<pixels.length;i+=4){pixels[i]=72;pixels[i+1]=99;pixels[i+2]=85;pixels[i+3]=255}this.onmessage?.({data:b})},30)},10)}close(){clearInterval(this.timer);this.readyState=3;this.onclose?.({code:1000})}send(text){const r=JSON.parse(text);window.calls.push(r);let result={version:1};if(r.method==='entities.list')result.items=[{id:'minecraft:pig',name:'猪'},{id:'minecraft:zombie',name:'僵尸'}];if(r.method==='entities.preview.open')result={version:1,sessionId:'owned-session',streamPath:'/ws/stream'};if(r.method==='entities.capture'){const t=createEntity();t.entity.id='minecraft:zombie';result.template=t;}setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:'response',id:r.id,ok:true,result})}),20)}};
 reconnectGameDevControlNow();function App(){const [source,S]=React.useState(stringifyEntity(createEntity())),[active,A]=React.useState(true),[disabled,D]=React.useState(false);window.doc=parseEntity(source);window.hide=()=>A(false);window.freeze=()=>D(true);return React.createElement(EntityEditor,{source,active,disabled,onChange:S})}DOM.createRoot(document.getElementById('root')).render(React.createElement(App));
 </script>`}))
 await page.goto(base+'/__entity');await page.getByRole('button',{name:'开启在线预览'}).waitFor();await page.waitForFunction(()=>window.calls.some(c=>c.method==='entities.list'))
 await page.getByLabel('实体名称',{exact:true}).fill('守卫')
 await page.getByRole('switch',{name:'无敌',exact:true}).check()
 await page.getByLabel('最大生命',{exact:true}).fill('50');await page.getByLabel('最大生命',{exact:true}).press('Tab')
 assert.equal(await page.evaluate(()=>window.doc.entity.data.value.attributes.value[0].value.base.value),'50')
 await page.getByLabel('添加装备槽位').selectOption('mainhand');await page.getByLabel('mainhand 物品 ID').fill('minecraft:diamond_sword')
 assert.equal(await page.evaluate(()=>window.doc.entity.data.value.equipment.value.mainhand.value.id.value),'minecraft:diamond_sword')
 await page.getByRole('button',{name:'开启在线预览'}).click();const canvas=page.getByLabel('实体串流画面');await canvas.waitFor();await page.waitForFunction(()=>document.querySelector('canvas')?.width===64)
 const box=await canvas.boundingBox();await page.mouse.move(box.x+40,box.y+40);await page.mouse.down();await page.mouse.move(box.x+100,box.y+80,{steps:5});await page.mouse.up()
 await page.waitForFunction(()=>window.calls.some(c=>c.method==='entities.preview.input'&&c.params.action==='rotate'))
 await page.getByRole('button',{name:'自动取景',exact:true}).click();await page.getByLabel('预览动画').selectOption('walk');await page.getByRole('button',{name:'刷新预览'}).click()
 await page.getByRole('button',{name:'关闭',exact:true}).click();await page.getByAltText('实体展示快照').waitFor()
 assert(await page.evaluate(()=>window.calls.some(c=>c.method==='entities.preview.close'&&c.params.sessionId==='owned-session')))
 await page.getByRole('button',{name:'捕获游戏中指向的实体'}).click();await page.waitForFunction(()=>window.doc.entity.id==='minecraft:zombie')
 await page.getByRole('button',{name:'开启在线预览'}).click();await canvas.waitFor();await page.evaluate(()=>window.hide());await page.waitForFunction(()=>!document.querySelector('canvas'))
 await page.evaluate(()=>window.freeze());assert(await page.getByLabel('实体名称',{exact:true}).isDisabled())
 await page.screenshot({path:'node_modules/.cache/entity-ui/editor.png'})
 assert.deepEqual(errors,[]);console.log('PASS entity UI with mock MC transport: fields, attributes, inline equipment, RPSF drawing, input RPC, snapshots, capture, inactive cleanup and readonly')
}finally{await browser.close();await server.close()}
