import assert from 'node:assert/strict'
import {prepareTextEditing,applyTextEditing,rowValue,DISPLAY_TEXT_PROTOCOL} from '../src/gameDevServer/displayTextEditing'
import type {LocalizationSession} from '../src/gameDevServer/displayLocalization'
import {createItem} from '../src/workspaces/gameplay/itemDoc'
import {createEntity} from '../src/workspaces/gameplay/entityDoc'
import {writeDisplayText,readDisplayText} from '../src/workspaces/gameplay/displayTextNbt'
import {displayTextRuntimeKey} from '../src/workspaces/gameplay/displayTextLocale'
const doc=createItem(),a=displayTextRuntimeKey('item','display.lore.a','a'),b=displayTextRuntimeKey('item','display.lore.b','b')
doc.item.components['minecraft:lore']={type:'list',value:[writeDisplayText('same'),writeDisplayText('same')]}
doc.displayTextEditor={'item.lore.0':{localized:false,reference:{translate:a}},'item.lore.1':{localized:false,reference:{translate:b}}}
const session={kind:'item',localization:{activeLocale:'zh_cn',availableLocales:['zh_cn','en_us']},tables:new Map(['zh_cn','en_us'].map(locale=>[locale,{path:`assets/${locale}/lang_item/test.lang`,version:'1',content:JSON.stringify({'display.lore.a':'A','display.lore.b':'B',unrelated:'keep'}),values:{'display.lore.a':'A','display.lore.b':'B',unrelated:'keep'}}]))} as LocalizationSession
const text=prepareTextEditing(session,doc),rows=text.open.rows.map(rowValue)
const run=(value=rows,candidate=doc)=>applyTextEditing(session,text,candidate,{protocol:DISPLAY_TEXT_PROTOCOL,rows:value})
assert.deepEqual(run().document,doc,'no-op must retain missing names, raw text and editor state')
const reordered=run([rows[0],rows[1],rows[3],rows[2]]).document as typeof doc
assert.equal((reordered.displayTextEditor?.['item.lore.0'].reference as {translate:string}).translate,b)
assert.equal((reordered.displayTextEditor?.['item.lore.1'].reference as {translate:string}).translate,a)
const enabled=structuredClone(rows);enabled[2].localized=true
const restored=run(enabled).document as typeof doc
assert.deepEqual(readDisplayText(restored.item.components['minecraft:lore'].type==='list'?restored.item.components['minecraft:lore'].value[0]:undefined),{translate:a})
const copied=run([...rows,{...structuredClone(rows[2]),rowId:'new:copy',field:'item.lore',localized:true,copyOf:rows[2].rowId}])
const copyDoc=copied.document as typeof doc,copyLore=copyDoc.item.components['minecraft:lore'];assert.equal(copyLore.type,'list')
if(copyLore.type==='list'){const copy=readDisplayText(copyLore.value[2]) as {translate:string};assert.notEqual(copy.translate,a);assert.notEqual(copy.translate,b)}
const deleted=run(rows.slice(0,2));assert.equal((deleted.document as typeof doc).item.components['minecraft:lore'].value.length,0)
assert(deleted.edits.every(edit=>edit.adopt),'deleting a row must retain its stored language values')
assert.throws(()=>run([...rows,rows[2]]),/身份/)
assert.throws(()=>run([...rows,{...rows[2],rowId:'forged'}]),/未授权/)
assert.throws(()=>run(rows.slice(1)),/名称行/)
assert.throws(()=>run(rows.map((r,i)=>i===2?{...r,translations:{fr_fr:'bad'}}:r)),/语言/)
const rawChanged=structuredClone(doc);rawChanged.item.components['minecraft:lore']={type:'list',value:[writeDisplayText('bypass')]}
assert.deepEqual(run(rows,rawChanged).document,doc,'raw NBT cannot bypass the text form')
const e=createEntity();e.entity.data.value.CustomName=writeDisplayText({translate:displayTextRuntimeKey('entity','display.custom_name','name')})
const es={...session,kind:'entity',tables:new Map([...session.tables].map(([l,t])=>[l,{...t,values:{'display.custom_name':'Name'}}]))} as LocalizationSession
const et=prepareTextEditing(es,e),er=et.open.rows.map(rowValue);er[0].localized=false;er[0].literal={text:'Fixed',color:'red'}
const fixed=applyTextEditing(es,et,e,{protocol:DISPLAY_TEXT_PROTOCOL,rows:er}).document as typeof e
assert.deepEqual(readDisplayText(fixed.entity.data.value.CustomName),{text:'Fixed',color:'red'})
assert.equal(fixed.displayTextEditor?.['entity.custom_name'].localized,false)
console.log('PASS IBE display text: stable duplicate-row identities, reorder/restore, independent copies, delete, absent names, entity modes, frozen authority and raw-tree isolation')

const fixedCopy=run([...rows,{...structuredClone(rows[2]),rowId:'new:fixed-copy',field:'item.lore',copyOf:rows[2].rowId}])
const fixedCopyDoc=fixedCopy.document as typeof doc
assert(fixedCopyDoc.displayTextEditor?.['item.lore.2'].reference,'fixed copies must retain independently restorable translations')
assert(fixedCopy.edits.some(edit=>!edit.adopt))
