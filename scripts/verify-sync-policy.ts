import assert from 'node:assert/strict'
import { partitionSyncEdits } from '../src/project/syncPolicy'
import { EditTransactions } from '../src/project/editTransactions'
import type { ProjectFileTree } from '../src/collab/generated'
import type { FileEdit } from '../src/project/serviceClient'
const tree=(versions:Record<string,string>):ProjectFileTree=>({revision:1,entries:Object.entries(versions).map(([path,version])=>({path,version,kind:'file',size:1}))})
const write=(path:string,version:string|null):FileEdit=>({op:'write',path,version,data:'local'})
const identity=(path:string)=>path
let result=partitionSyncEdits([write('a','old'),write('b','base')],tree({a:'new',b:'base'}),identity)
assert.deepEqual(result.safe.map(g=>g.map(e=>e.path)),[['b']]);assert.deepEqual(result.conflicting.map(g=>g.map(e=>e.path)),[['a']])
result=partitionSyncEdits([write('src/hanshu/a.hs','old'),write('assets/zh_cn/lang_hs/a.lang','base'),write('b','base')],tree({'src/hanshu/a.hs':'new','assets/zh_cn/lang_hs/a.lang':'base',b:'base'}),p=>p.endsWith('a.lang')?'src/hanshu/a.hs':p)
assert.equal(result.conflicting[0].length,2);assert.equal(result.safe[0][0].path,'b')
result=partitionSyncEdits([{op:'move',path:'a',destination:'b',version:'a-base',destinationVersion:null},write('b',null)],tree({a:'a-base',b:'occupied'}),identity)
assert.equal(result.safe.length,0);assert.equal(result.conflicting[0].length,2)
result=partitionSyncEdits([write('new',null)],tree({new:'peer-created'}),identity);assert.equal(result.conflicting.length,1)
const original=write('a','same');result=partitionSyncEdits([original],tree({a:'same'}),identity);assert.equal(result.safe[0][0],original);assert.equal(original.version,'same')
const tx=new EditTransactions(e=>e,async()=>undefined)
tx.stageWrite({op:'write',path:'assets/a.lang',data:'old'})
tx.stageWrite({op:'write',path:'assets/a.lang',data:'new'})
tx.clearSubmittedDrafts([{op:'write',path:'assets/a.lang',data:'old'}]);assert.equal(tx.stagedText('assets/a.lang'),'new')
tx.clearSubmittedDrafts([{op:'write',path:'assets/a.lang',data:'new'}]);assert.equal(tx.stagedWrites().length,0)
console.log('通过：同步分组保留独立修改、归属和移动链；原 CAS 不变；成功清理不吞后续语言草稿。')
