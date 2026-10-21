import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { harness } from './collaboration-harness.mjs'
const h=await harness();const sockets=[]
try {
  await h.api('','/api/project','GET',undefined,401)
  const owner=await h.login(h.credential,'owner')
  const person=await h.api(owner.token,'/api/subjects','POST',{name:'editor',kind:'account',role:'editor'})
  const observer=await h.api(owner.token,'/api/subjects','POST',{name:'reader',kind:'agent',role:'viewer'})
  const a=await h.login(person.credential,'A');const b=await h.login(person.credential,'B');const viewer=await h.login(observer.credential,'V')
  assert.equal(a.session.subjectId,b.session.subjectId);assert.notEqual(a.session.id,b.session.id)
  const tree=await h.files(a.token);assert.ok(tree.entries.some(e=>e.path==='src/hanshu/story.hs'));assert.ok(!JSON.stringify(tree).includes('owner-key'))
  await h.api(viewer.token,'/api/files/leases','POST',{paths:['src/hanshu/story.hs']},403)
  const denied=await h.api(viewer.token,'/api/files/commit','POST',{transactionId:randomUUID(),changes:[]})
  assert.equal(denied.status,'rejected');assert.equal(denied.error.code,'forbidden')
  for(const path of ['../outside','.hanshu/service/owner-key','assets/../../secret','C:/outside'])await h.api(a.token,`/api/files/content?path=${encodeURIComponent(path)}`,'GET',undefined,path==='C:/outside'||path.includes('..')?400:403)
  await h.api(a.token,'/api/files','GET',undefined,403,'https://untrusted.example')
  const snapshots=[];const ws=new WebSocket(h.base.replace('http:','ws:')+'/api/events');sockets.push(ws);ws.addEventListener('message',e=>snapshots.push(JSON.parse(e.data).data));await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true})});ws.send(JSON.stringify({token:viewer.token}))
  const before=tree.entries.find(e=>e.path==='src/hanshu/story.hs').version
  await h.commit(a.token,[{path:'src/hanshu/story.hs',content:'标题：服务端保存后的剧本\n'}])
  assert.equal(await readFile(join(h.root,'src/hanshu/story.hs'),'utf8'),'标题：服务端保存后的剧本\n')
  await h.api(b.token,'/api/files/leases','POST',{paths:['src/hanshu/story.hs']},423)
  await h.commit(b.token,[{path:'meta/docs/notes.md',content:'# 独立文件并行保存'}])
  const lease=await h.api(owner.token,'/api/files/leases','POST',{paths:['src/hanshu/story.hs'],force:true})
  const lostLease=await h.api(a.token,'/api/files/commit','POST',{transactionId:randomUUID(),changes:[{op:'write',path:'src/hanshu/story.hs',version:before,content:Buffer.from('stale').toString('base64'),leaseId:lease[0].id}]})
  assert.equal(lostLease.status,'rejected');assert.equal(lostLease.error.code,'locked')
  await h.commit(owner.token,[{path:'src/hanshu/story.hs',content:'stale',version:before}],409)
  await h.release(owner.token)
  for(const path of ['src/story/flow.hflow','src/items/test.item','src/gift/test.kit','src/navigator/test.nav','assets/audio.ogg','.hanshu/skinmanager/tmp/state.json'])await h.commit(b.token,[{path,content:'server owns these bytes'}])
  await h.release(b.token)
  const plan=await h.api(owner.token,'/api/files/source-plan?path=src/progress/example.progress&destination=src/progress/renamed.progress')
  assert.ok(plan.some(p=>p.path==='assets/zh_cn/lang_progress/example.lang'))
  await h.commit(owner.token,plan.map(p=>({op:'move',path:p.path,destination:p.destination})))
  assert.equal(await readFile(join(h.root,'assets/zh_cn/lang_progress/renamed.lang'),'utf8'),h.fixtures['assets/zh_cn/lang_progress/example.lang'])
  assert.ok((await h.files(viewer.token)).entries.some(e=>e.path==='src/progress/renamed.progress'))
  await h.api(owner.token,`/api/subjects/${person.subject.id}`,'PATCH',{role:'viewer',enabled:false})
  await h.api(b.token,'/api/files','GET',undefined,401)
  await new Promise(r=>setTimeout(r,100));assert.ok(snapshots.some(s=>s.filesRevision>1))
  assert.ok(!JSON.stringify(snapshots).includes(h.credential))
  sockets.forEach(s=>s.close());await h.stop();await h.start()
  await h.api(owner.token,'/api/files','GET',undefined,401)
  const restored=await h.login(h.credential,'restart')
  assert.equal((await h.api(restored.token,'/api/project')).leases.length,0)
  assert.equal(await readFile(join(h.root,'src/hanshu/story.hs'),'utf8'),'标题：服务端保存后的剧本\n')
  console.log('通过：普通工程目录、多文件类型、两个同主体会话、独立文件并行写入、只读与越权拒绝、版本冲突、接管、服务端关联改名、广播与重启。')
} finally {sockets.forEach(s=>s.close());await h.stop()}
