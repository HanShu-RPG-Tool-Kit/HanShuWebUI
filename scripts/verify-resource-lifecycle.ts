import assert from 'node:assert/strict'
import {ResourceLifecycle} from '../src/project/resourceLifecycle'
let passed=0
async function test(name:string,run:()=>Promise<void>){await run();console.log('PASS',name);passed++}
function fixture(){
 const lifecycle=new ResourceLifecycle(),events:string[]=[]
 lifecycle.register('src/a.quest',{prepare:async()=>{events.push('prepare');return 'fresh source'},cancel:()=>{events.push('cancel')},committed:path=>{events.push(`committed:${path}`)},missing:()=>events.push('missing')})
 return {lifecycle,events}
}
await test('confirmed move migrates registrations; old path cannot flush again',async()=>{
 const {lifecycle,events}=fixture(),change=await lifecycle.prepare([{path:'src/a.quest',destination:'src/b.quest'}])
 assert.equal(change.contents[0].content,'fresh source');change.submitted(1)
 await lifecycle.committed([{op:'move',path:'src/a.quest',destination:'src/b.quest'}])
 assert.equal((await lifecycle.prepare([{path:'src/a.quest',destination:null}])).contents.length,0)
 const next=await lifecycle.prepare([{path:'src/b.quest',destination:null}]);next.cancel()
 assert.deepEqual(events,['prepare','committed:src/b.quest','prepare','cancel'])
})
await test('uncertain outcome stays suspended; rejection resumes exactly once',async()=>{
 const {lifecycle,events}=fixture(),change=await lifecycle.prepare([{path:'src/a.quest',destination:null}]);change.submitted(4)
 lifecycle.settle([{id:4,phase:'uncertain'}]);lifecycle.observe(new Set())
 await assert.rejects(lifecycle.prepare([{path:'src/a.quest',destination:null}]),/尚未完成/)
 assert.deepEqual(events,['prepare']);lifecycle.settle([{id:4,phase:'conflict'}]);lifecycle.settle([{id:4,phase:'conflict'}])
 assert.deepEqual(events,['prepare','cancel'])
})
await test('deletion and remote disappearance unregister stale editor callbacks',async()=>{
 const a=fixture();await a.lifecycle.committed([{op:'remove',path:'src/a.quest'}]);a.lifecycle.observe(new Set());assert.deepEqual(a.events,['committed:null'])
 const b=fixture();b.lifecycle.observe(new Set());b.lifecycle.observe(new Set());assert.deepEqual(b.events,['missing'])
 assert.equal((await b.lifecycle.prepare([{path:'src/a.quest',destination:null}])).contents.length,0)
})
await test('failed preparation releases all editor gates without any structural write',async()=>{
 const {lifecycle,events}=fixture()
 lifecycle.register('src/other.quest',{prepare:async()=>{throw Error('save failed')},cancel:()=>events.push('other cancel'),committed:()=>{},missing:()=>{}})
 await assert.rejects(lifecycle.prepare([{path:'src',destination:null}]),/save failed/)
 assert.deepEqual(events,['prepare','cancel','other cancel'])
})
console.log(`${passed} lifecycle checks passed`)
