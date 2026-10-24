import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {chromium} from 'playwright'
import {harness} from './collaboration-harness.mjs'
import {loginProject} from './project-ui-helpers.mjs'
const h=await harness({web:true});let browser
try{
 const owner=await h.login(h.credential,'entity workbench setup'),account=await h.api(owner.token,'/api/subjects','POST',{name:'entity author',kind:'account',role:'editor'})
 browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})})
 const page=await browser.newPage({viewport:{width:1500,height:1100}}),errors=[],calls=[],waits=new Map(),counts=new Map();let socket,receiver,edit
 page.on('pageerror',e=>errors.push(e.message))
 await page.route('http://127.0.0.1:8765/**',r=>r.fulfill({contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:'{"ok":true,"subscribers":1,"methods":[]}'}))
 await page.routeWebSocket('ws://127.0.0.1:8765/**',ws=>{socket=ws;ws.onMessage(text=>{
  const r=JSON.parse(String(text));if(r.type==='response'){counts.set(r.id,(counts.get(r.id)??0)+1);waits.get(r.id)?.(r);waits.delete(r.id);return}calls.push(r)
  let result={version:1};if(r.method==='entities.receiver.bind'){receiver=r.params.receiver;result.active=true}
  if(r.method==='entities.list')result.items=[{id:'minecraft:pig',name:'猪'},{id:'minecraft:zombie',name:'僵尸'}]
  if(r.method==='entities.edit.open'){edit=r.params;result={version:1,opened:true,editId:r.params.editId}}
  ws.send(JSON.stringify({type:'response',id:r.id,ok:true,result}))
 })})
 const template=(health,name='守卫')=>({format:'rpgtoolkit:entity-template',version:1,dataFormat:'tnbt-json-v1',tags:['test'],entity:{id:'minecraft:zombie',data:{type:'compound',value:{Health:{type:'float',value:String(health)},CustomName:{type:'string',value:name}}}}})
 async function ready(){for(let i=0;i<100&&!receiver;i++)await page.waitForTimeout(50);assert(receiver&&socket,'receiver not bound')}
 function capture(name,doc,target=receiver){const id=randomUUID(),request={type:'request',id,method:'entities.import',params:{version:1,requestId:id,receiver:target,name,template:doc}};return {id,request,result:new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('capture acknowledgement timeout')),10000);waits.set(id,r=>{clearTimeout(timer);resolve(r)});socket.send(JSON.stringify(request))})}}
 const file=join(h.root,'src/entities/卫兵.entity'),read=async()=>JSON.parse(await readFile(file,'utf8'))
 await loginProject(page,h.base,account.credential,'entity workbench');await ready();await page.getByRole('tab',{name:'进度流程',exact:true}).click()
 let incoming=capture('卫兵',template(35));assert.equal((await incoming.result).ok,true);assert.equal((await read()).entity.data.value.Health.value,'35')
 page.once('dialog',d=>{assert(d.message().includes('已存在'));void d.dismiss()});incoming=capture('卫兵',template(20));assert.equal((await incoming.result).result.cancelled,true);assert.equal((await read()).entity.data.value.Health.value,'35')
 page.once('dialog',d=>void d.accept());incoming=capture('卫兵',template(20));assert.equal((await incoming.result).ok,true);assert.equal((await read()).entity.data.value.Health.value,'20')
 // Retransmission of the same request never opens a second dialog or submits twice.
 let extraDialog=false;const onDialog=d=>{extraDialog=true;void d.dismiss()};page.on('dialog',onDialog);socket.send(JSON.stringify(incoming.request));await page.waitForTimeout(150);assert.equal(extraDialog,false);assert.equal(counts.get(incoming.id),2);page.off('dialog',onDialog)
 const pane=page.locator('.app-workspace-pane.active');await pane.getByLabel('筛选资源',{exact:true}).fill('卫兵.entity');await pane.locator('[role=treeitem][title="卫兵.entity"]').click();await pane.getByRole('button',{name:'发送到游戏内编辑',exact:true}).click()
 for(let i=0;i<100&&!edit;i++)await page.waitForTimeout(30);assert(edit)
 socket.send(JSON.stringify({type:'notify',method:'entities.edit.done',params:{version:1,editId:edit.editId,hash:edit.hash,receiver:edit.receiver,template:template(90,'IBE守卫')}}))
 await page.waitForFunction(()=>Array.from(document.querySelectorAll('input')).some(i=>i.getAttribute('aria-label')==='实体名称'&&i.value==='IBE守卫'))
 assert.equal((await read()).entity.data.value.CustomName.value,'守卫','IBE should update a draft, not directly write disk')
 // Local edits made while IBE is open stay intact; the game result becomes another draft.
 edit=null;await pane.getByRole('button',{name:'发送到游戏内编辑',exact:true}).click();for(let i=0;i<100&&!edit;i++)await page.waitForTimeout(30)
 await pane.getByLabel('实体名称',{exact:true}).fill('本机继续改')
 socket.send(JSON.stringify({type:'notify',method:'entities.edit.done',params:{version:1,editId:edit.editId,hash:edit.hash,receiver:edit.receiver,template:template(60,'游戏继续改')}}));await page.waitForTimeout(200)
 assert.equal(await pane.getByLabel('实体名称',{exact:true}).inputValue(),'本机继续改')
 await pane.getByLabel('筛选资源',{exact:true}).fill('游戏编辑结果');await pane.locator('[role=treeitem]').filter({hasText:'卫兵-游戏编辑结果.entity'}).waitFor()
 // Read version before confirmation; an intervening S write must not be overwritten after acceptance.
 let dialogWork
 page.once('dialog',d=>{assert(d.message().includes('未保存'));dialogWork=(async()=>{await h.commit(owner.token,[{path:'src/entities/卫兵.entity',content:JSON.stringify(template(100,'远端修改'))}]);await h.release(owner.token);await d.accept()})()})
 incoming=capture('卫兵',template(10));const conflict=await incoming.result;await dialogWork;assert.equal(conflict.ok,false);assert.equal((await read()).entity.data.value.Health.value,'100')
 // A second subscribed window must not respond to an import addressed to the first.
 const other=await browser.newPage();let otherSocket,otherReceiver,otherResponses=0,otherDialogs=0
 other.on('dialog',d=>{otherDialogs++;void d.dismiss()})
 await other.route('http://127.0.0.1:8765/**',r=>r.fulfill({contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:'{"ok":true,"subscribers":2,"methods":[]}'}))
 await other.routeWebSocket('ws://127.0.0.1:8765/**',ws=>{otherSocket=ws;ws.onMessage(text=>{const r=JSON.parse(String(text));if(r.type==='response'){otherResponses++;return}if(r.method==='entities.receiver.bind')otherReceiver=r.params.receiver;ws.send(JSON.stringify({type:'response',id:r.id,ok:true,result:{version:1,active:true}}))})})
 await loginProject(other,h.base,account.credential,'other entity window');for(let i=0;i<100&&!otherReceiver;i++)await other.waitForTimeout(30);assert(otherReceiver&&otherReceiver!==receiver)
 incoming=capture('多人定向',template(25));otherSocket.send(JSON.stringify(incoming.request));assert.equal((await incoming.result).ok,true);await page.waitForTimeout(150);assert.equal(otherResponses,0);assert.equal(otherDialogs,0);assert.equal(counts.get(incoming.id),1);await other.close()
 assert.deepEqual(errors,[])
 console.log('PASS entity workbench against real S: import, duplicate confirmation/cancel, replay, IBE draft roundtrip/conflict preservation and CAS after confirmation')
}finally{await browser?.close();await h.stop()}
