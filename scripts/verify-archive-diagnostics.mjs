import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {readFile,writeFile} from 'node:fs/promises'
import {spawnSync} from 'node:child_process'
import {join,resolve} from 'node:path'
import {harness} from './collaboration-harness.mjs'

const h=await harness()
const binary=resolve('src-tauri/target/debug',process.platform==='win32'?'project-server.exe':'project-server')
const archive=id=>{const hash=createHash('sha256').update(id).digest('hex');return join(h.root,'.hanshu/service/file-transactions/archive',hash.slice(0,2),`${hash}.json.gz`)}
try {
 let owner=await h.login(h.credential,'archive diagnosis')
 const request=await h.prepare(owner.token,[{path:'assets/receipt-test.txt',content:'exactly once'}])
 await h.api(owner.token,'/api/files/commit','POST',request)
 await h.release(owner.token)
 const semantic={transactionId:randomUUID(),changes:[{op:'progress-command',path:'src/quest/example.quest',version:null,leaseId:'',content:Buffer.from(JSON.stringify({command:'apply',documentId:'progress-test',changes:[{target:{kind:'field',field:'abandonable'},expected:{present:true,value:true},value:{present:true,value:false}}]})).toString('base64')}]}
 await h.api(owner.token,'/api/files/commit','POST',semantic)
 const revision=(await h.files(owner.token)).revision
 await h.stop()
 for(const id of [request.transactionId,semantic.transactionId])await writeFile(archive(id),'truncated archive evidence')
 const inspect=()=>{
   const result=spawnSync(binary,['--project',h.root,'--archive-check'],{encoding:'utf8',windowsHide:true})
   assert.equal(result.status,2,result.stderr)
   return JSON.parse(result.stdout)
 }
 const before=inspect()
 assert.equal(before.stats.corruptCount,2)
 for(const id of [request.transactionId,semantic.transactionId])assert.equal(await readFile(archive(id),'utf8'),'truncated archive evidence')
 console.log('PASS offline CLI diagnoses corrupt archives without moving evidence')
 await h.start()
 owner=await h.login(h.credential,'archive after restart')
 assert((await h.files(owner.token)).revision>=revision,'quarantine must not roll revision backwards')
 for(const id of [request.transactionId,semantic.transactionId]){
   const error=await h.api(owner.token,`/api/files/transactions/${id}`,'GET',undefined,500)
   assert.equal(error.code,'receipt_quarantined')
 }
 const retry=await h.api(owner.token,'/api/files/commit','POST',request,500)
 assert.equal(retry.code,'receipt_quarantined')
 const undo={transactionId:randomUUID(),changes:[{...semantic.changes[0],content:Buffer.from(JSON.stringify({command:'revert',transactionId:semantic.transactionId})).toString('base64')}]}
 const undoResult=await h.api(owner.token,'/api/files/commit','POST',undo,500)
 assert.equal(undoResult.code,'receipt_quarantined')
 assert.equal(await readFile(join(h.root,'assets/receipt-test.txt'),'utf8'),'exactly once')
 assert.equal(JSON.parse(await readFile(join(h.root,'src/quest/example.quest'),'utf8')).abandonable,false)
 console.log('PASS HTTP query/retry/undo report quarantine and never reexecute or mutate originals')
 await h.commit(owner.token,[{path:'assets/unrelated.txt',content:'still usable'}])
 assert((await h.files(owner.token)).revision>revision)
 const after=inspect()
 assert.equal(after.stats.quarantinedCount,2)
 console.log('PASS unrelated transactions continue with monotonic revision; CLI reports retained quarantine')
}finally{await h.stop()}
