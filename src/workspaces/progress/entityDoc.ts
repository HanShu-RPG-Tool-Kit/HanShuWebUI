import {readNbt,type NbtValue} from './tnbtJson'
import {parseJsonValue} from '../../utils/strictJson'
export type EntityDocument={format:'rpgtoolkit:entity-template';version:1;dataFormat:'tnbt-json-v1';tags:string[];entity:{id:string;data:Extract<NbtValue,{type:'compound'}>}}
export const createEntity=():EntityDocument=>({format:'rpgtoolkit:entity-template',version:1,dataFormat:'tnbt-json-v1',tags:[],entity:{id:'minecraft:pig',data:{type:'compound',value:{}}}})
function noBindings(value:NbtValue):void{if(value.type==='compound'){if(Object.hasOwn(value.value,'rpgtoolkit:item_template'))throw Error('实体装备不能绑定 .it 模板');Object.values(value.value).forEach(noBindings)}else if(value.type==='list')value.value.forEach(noBindings)}
export function parseEntity(source:string):EntityDocument{
 if(new TextEncoder().encode(source).length>1024*1024)throw Error('实体模板不能超过 1 MiB')
 const raw=parseJsonValue(source) as EntityDocument
 if(!raw||raw.format!=='rpgtoolkit:entity-template'||raw.version!==1||raw.dataFormat!=='tnbt-json-v1'||Object.keys(raw).some(k=>!['format','version','dataFormat','tags','entity'].includes(k)))throw Error('不支持的实体模板格式')
 if(!Array.isArray(raw.tags)||raw.tags.some(tag=>typeof tag!=='string'||!tag.trim()))throw Error('标签需要非空字符串数组')
 if(!raw.entity||Object.keys(raw.entity).some(k=>!['id','data'].includes(k))||typeof raw.entity.id!=='string'||!/^[-a-z0-9_.]+:[-a-z0-9_./]+$/.test(raw.entity.id)||raw.entity.id==='minecraft:player')throw Error('实体类型 ID 无效或为玩家')
 const data=readNbt(raw.entity.data);if(data.type!=='compound')throw Error('实体数据需要 compound');if(Object.hasOwn(data.value,'Passengers')||Object.hasOwn(data.value,'RootVehicle'))throw Error('第一版不支持实体乘客关系');noBindings(data)
 return {...raw,tags:[...new Set(raw.tags)],entity:{id:raw.entity.id,data}}
}
export const stringifyEntity=(doc:EntityDocument)=>JSON.stringify(doc,null,2)+'\n'
