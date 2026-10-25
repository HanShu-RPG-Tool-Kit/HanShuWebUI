import {randomId} from '../project/crypto'
import type {FileEdit} from '../project/serviceClient'
import {stringifyTextFile} from '../i18n/textMap'
import type {LocalizationSession} from './displayLocalization'
import {decodeTextComponent} from '../textComponent/codec'
import {displayTextFields,getDisplayText,replaceDisplayText,displayTextSemanticKey,displayTextRuntimeKey,type DisplayTextDocument} from '../workspaces/gameplay/displayTextLocale'
import {writeDisplayText} from '../workspaces/gameplay/displayTextNbt'
import type {ItemDocument} from '../workspaces/gameplay/itemDoc'
import type {EntityDocument} from '../workspaces/gameplay/entityDoc'
export const DISPLAY_TEXT_PROTOCOL='ibe-display-text-v1'
export type TextRow={rowId:string;field:string;present:boolean;localized:boolean;literal:unknown;copyOf?:string;translations:Record<string,string>}
export type TextOpen={protocol:typeof DISPLAY_TEXT_PROTOCOL;activeLocale:string;availableLocales:string[];rows:(TextRow&{readOnly:boolean;source:unknown;reference:unknown})[]}
export type TextSession={open:TextOpen;original:DisplayTextDocument;references:Map<string,unknown>}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b)
export async function supportsTextEditing(request:(method:string,params:unknown,timeout?:number)=>Promise<unknown>):Promise<boolean>{try{const raw=await request('localization.capabilities',{},5000);return record(raw)&&Array.isArray(raw.protocols)&&raw.protocols.includes(DISPLAY_TEXT_PROTOCOL)}catch{return false}}
export function prepareTextEditing(session:LocalizationSession,document:DisplayTextDocument):TextSession{
 const original=structuredClone(document),references=new Map<string,unknown>()
 const rows=displayTextFields(session.kind,original).map(field=>{
  const source=getDisplayText(session.kind,original,field),state=original.displayTextEditor?.[field]
  const active=record(source)&&typeof source.translate==='string'&&displayTextSemanticKey(source.translate,session.kind)!==null
  const reference=active?source:state?.reference
  const key=record(reference)&&typeof reference.translate==='string'?displayTextSemanticKey(reference.translate,session.kind):null
  const rowId=randomId();if(key)references.set(rowId,reference)
  return {rowId,field,present:source!==undefined,localized:active||state?.localized!==false,literal:active?state?.literal??null:source??null,source:source??null,reference:reference??null,readOnly:source!==undefined&&!active&&!decodeTextComponent(source).editable,translations:key?Object.fromEntries([...session.tables].flatMap(([locale,table])=>Object.hasOwn(table.values,key)?[[locale,table.values[key]]]:[])):{} }
 })
 return {original,references,open:{protocol:DISPLAY_TEXT_PROTOCOL,activeLocale:session.localization.activeLocale,availableLocales:session.localization.availableLocales,rows}}
}
/** Ordered identities are authoritative; neither text equality nor array index identifies a row. */
export function applyTextEditing(session:LocalizationSession,text:TextSession,candidate:DisplayTextDocument,result:unknown):{document:DisplayTextDocument;edits:FileEdit[]}{
 if(!record(result)||result.protocol!==DISPLAY_TEXT_PROTOCOL||!Array.isArray(result.rows)||result.rows.length>258||Object.keys(result).some(key=>!['protocol','rows'].includes(key)))throw Error('显示文本回包无效')
 const originals=new Map(text.open.rows.map(row=>[row.rowId,row])),seen=new Set<string>(),rows:TextRow[]=[]
 const values=new Map([...session.tables].map(([locale,table])=>[locale,{...table.values}]))
 for(const raw of result.rows){
  if(!record(raw)||Object.keys(raw).some(key=>!['rowId','field','present','localized','literal','translations','copyOf'].includes(key))||typeof raw.rowId!=='string'||raw.rowId.length>128||typeof raw.field!=='string'||typeof raw.present!=='boolean'||typeof raw.localized!=='boolean'||!Object.hasOwn(raw,'literal')||!record(raw.translations)||seen.has(raw.rowId))throw Error('显示文本行身份或字段无效')
  seen.add(raw.rowId);const old=originals.get(raw.rowId)
  if(old?raw.field!==old.field:session.kind!=='item'||raw.field!=='item.lore'||!/^new:[a-z0-9_-]{1,100}$/.test(raw.rowId))throw Error('显示文本行未授权')
  if(raw.copyOf!==undefined&&(old||typeof raw.copyOf!=='string'||!originals.has(raw.copyOf)||originals.get(raw.copyOf)!.readOnly||!originals.get(raw.copyOf)!.field.startsWith('item.lore.')))throw Error('复制来源未授权')
  if((raw.field==='item.lore'||raw.field.startsWith('item.lore.'))&&!raw.present)throw Error('说明行必须存在或明确删除')
  for(const [locale,value] of Object.entries(raw.translations))if(!session.tables.has(locale)||typeof value!=='string'||value.length>262144||(value!==old?.translations[locale]&&!decodeTextComponent(parseText(value)).editable))throw Error('译文语言或内容无效')
  if(raw.literal!==null&&!decodeTextComponent(raw.literal).editable&&(!old||!same(raw.literal,old.literal)))throw Error('固定文本结构不可编辑')
  const row=raw as unknown as TextRow
  if(old?.readOnly&&!same(row,rowValue(old)))throw Error('只读文本行不能修改')
  rows.push(row)
 }
 for(const old of text.open.rows){if(!old.field.startsWith('item.lore.')&&!seen.has(old.rowId))throw Error('名称行身份缺失')}
 if(rows.filter(row=>row.field.startsWith('item.lore')).length>256)throw Error('说明不能超过 256 行')
 let document=structuredClone(candidate),editor={...text.original.displayTextEditor},lore:ReturnType<typeof writeDisplayText>[]=[]
 if(session.kind==='entity'){
  const old=(text.original as EntityDocument).entity.data.value.CustomName,to=(document as EntityDocument).entity.data.value
  if(old)to.CustomName=structuredClone(old);else delete to.CustomName
 }else{
  const from=(text.original as ItemDocument).item.components,to=(document as ItemDocument).item.components
  for(const key of ['minecraft:item_name','minecraft:custom_name','minecraft:lore']){if(from[key])to[key]=structuredClone(from[key]);else delete to[key]}
 }

 for(const field of Object.keys(editor))if(field.startsWith('item.lore.'))delete editor[field]
 let loreIndex=0
 for(const row of rows){
  const old=originals.get(row.rowId),isLore=row.field.startsWith('item.lore'),field=isLore?`item.lore.${loreIndex++}`:row.field
  if(old?.readOnly){if(isLore){const raw=(text.original as ItemDocument).item.components['minecraft:lore'];if(raw?.type==='list')lore.push(structuredClone(raw.value[Number(old.field.slice('item.lore.'.length))]))}else document=replaceDisplayText(session.kind,document,field,old.source);continue}
  const originalState=old?text.original.displayTextEditor?.[old.field]:undefined
  if(old&&same(row,rowValue(old))){
   if(originalState)editor[field]=structuredClone(originalState)
   if(isLore){const raw=(text.original as ItemDocument).item.components['minecraft:lore'];if(raw?.type==='list')lore.push(structuredClone(raw.value[Number(old.field.slice('item.lore.'.length))]))}
   else if(old.present)document=replaceDisplayText(session.kind,document,field,old.source)
   else if(session.kind==='entity')delete (document as EntityDocument).entity.data.value.CustomName
   else delete (document as ItemDocument).item.components[`minecraft:${field.slice(5)}`]
   continue
  }
  let reference=text.references.get(row.rowId),semantic=record(reference)&&typeof reference.translate==='string'?displayTextSemanticKey(reference.translate,session.kind):null
  if(row.present&&!reference&&(row.localized||Object.keys(row.translations).length>0)){
   semantic=isLore?`display.lore.${randomId()}`:`display.${row.field.split('.').at(-1)}`
   const source=row.copyOf?text.references.get(row.copyOf):undefined
   reference={...(record(source)?structuredClone(source):{}),translate:displayTextRuntimeKey(session.kind,semantic)}
  }
  if(semantic)for(const [locale,table] of values){const next=row.translations[locale],before=old?.translations[locale];if(next!==before){if(next===undefined)delete table[semantic];else table[semantic]=next}}
  let component=row.localized?reference:row.literal
  if(row.localized&&row.present&&semantic&&Object.keys(row.translations).length===0&&!text.references.has(row.rowId)){
   values.get(text.open.activeLocale)![semantic]=JSON.stringify(row.literal??{text:''})
  }
  // An untouched absent name must remain absent, rather than creating an empty Component.
  if(row.present&&component==null)component={text:''}
  if(isLore)lore.push(writeDisplayText(component))
  else if(row.present)document=replaceDisplayText(session.kind,document,field,component)
  else if(session.kind==='entity')delete (document as EntityDocument).entity.data.value.CustomName
  else delete (document as ItemDocument).item.components[`minecraft:${field.slice(5)}`]
  if(!old||!same(row,rowValue(old))||originalState)editor[field]={localized:row.localized,...(reference?{reference}:{}),...(row.literal!==null?{literal:row.literal}:{})}
 }
 if(session.kind==='item'){
  const old=(text.original as ItemDocument).item.components['minecraft:lore']
  if(lore.length||old){const target=(document as ItemDocument).item.components;target['minecraft:lore']={type:'list',value:lore}}
 }
 if(Object.keys(editor).length)document.displayTextEditor=editor
 const edits:FileEdit[]=[...session.tables].map(([locale,table])=>{const next=values.get(locale)!,changed=!!table.staged||!same(next,table.values);return {op:'write',path:table.path,data:changed?stringifyTextFile(next):table.content??undefined,version:table.version,adopt:!changed}})
 return {document,edits}
}
export function rowValue(row:TextOpen['rows'][number]):TextRow{const {readOnly:_r,source:_s,reference:_ref,...value}=row;void _r;void _s;void _ref;return structuredClone(value)}
function parseText(raw:string):unknown{try{return JSON.parse(raw)}catch{return {text:raw}}}
