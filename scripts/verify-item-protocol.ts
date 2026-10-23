import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {parseItemStack,stringifyItemStack} from '../src/workspaces/progress/itemstack'
import {itemFromItemStack} from '../src/workspaces/progress/itemDoc'
import {drainSnapshotQueueForTests} from '../src/gameDevServer/itemSnapshotRefresh'
import {markSnapshotNeeded,getCachedDisplaySync,resetItemSnapshotCacheForTests,useMemoryItemSnapshotStore as installMemorySnapshotStore} from '../src/workspaces/progress/itemSnapshotCache'
import {itemFingerprint} from '../src/workspaces/progress/itemstack'

const fixture=process.env.TNBT_MOD_EXPORT ?? 'scripts/fixtures/itemstack-tnbt-v3.json'
const parsed=parseItemStack(await readFile(fixture,'utf8'))
const doc=itemFromItemStack(parsed)
assert.equal(parsed.schemaVersion,3)
assert.equal(doc.schemaVersion,2)
assert.equal(parsed.item.count,3)
const custom=doc.item.components['minecraft:custom_data']
assert.equal(custom.type,'compound')
if(custom.type!=='compound')throw Error('compound expected')
assert.equal(custom.value.long.value,'9223372036854775807')
assert.equal(custom.value.negative_zero.value,'-0')
assert.deepEqual(custom.value.list,{type:'list',value:[{type:'int',value:1},{type:'string',value:'mixed'}]})
assert.deepEqual(parseItemStack(stringifyItemStack(parsed)).item,parsed.item)
if(process.env.TNBT_EXPORT_PATH)await writeFile(process.env.TNBT_EXPORT_PATH,stringifyItemStack(parsed))
console.log('通过：'+fixture+' → WebUI 导入/导出，完整集合和 NBT 类型保持')

installMemorySnapshotStore();resetItemSnapshotCacheForTests()
const item=doc.item,key=itemFingerprint(item)
markSnapshotNeeded(item)
const display={name:[{text:'TNBT snapshot'}]}
for(const wrong of [{},{componentFormat:'tnbt-json-v1',componentMode:'patch'}]) {
  await drainSnapshotQueueForTests(async (_method,params)=>{
    const p=params as {componentFormat:string;componentMode:string;items:unknown[]}
    assert.equal(p.componentFormat,'tnbt-json-v1');assert.equal(p.componentMode,'complete')
    return {...wrong,snapshots:[{key,ok:true,display}]}
  })
  assert.equal(getCachedDisplaySync(key),undefined,'旧格式/错误集合语义不能写入快照缓存')
}
await drainSnapshotQueueForTests(async (method,params)=> {
  assert.equal(method,'items.renderSnapshots')
  const p=params as {componentFormat:string;componentMode:string;items:{key:string;components:unknown}[]}
  assert.deepEqual(p.items[0].components,item.components)
  return {componentFormat:p.componentFormat,componentMode:p.componentMode,snapshots:[{key,ok:true,display}]}
})
assert.equal(getCachedDisplaySync(key)?.name?.[0].text,'TNBT snapshot')
resetItemSnapshotCacheForTests()
console.log('通过：生产快照 drain 验证双向格式与完整集合标记，拒绝旧响应并接受新响应')
