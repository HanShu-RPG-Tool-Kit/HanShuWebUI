import assert from 'node:assert/strict'
import {readDisplayText,writeDisplayText,localizedDisplayText} from '../src/workspaces/gameplay/displayTextNbt'
import {renderItemTooltip} from '../src/workspaces/gameplay/itemTooltip'
import {entityFieldEditors} from '../src/workspaces/gameplay/entityFields/registry'
import '../src/workspaces/gameplay/entityFields/registerBuiltins'
import type {NbtValue} from '../src/workspaces/gameplay/tnbtJson'
import type {TextLocalizationAdapter} from '../src/textComponent/LocalizedTextField'

assert.equal(readDisplayText(undefined),undefined)
assert.equal(readDisplayText({type:'string',value:''}),'')
const rich:NbtValue={type:'compound',value:{text:{type:'string',value:'名称'},bold:{type:'byte',value:1},italic:{type:'byte',value:0}}}
const decoded=readDisplayText(rich)
assert.deepEqual(decoded,{text:'名称',bold:true,italic:false})
assert.equal(writeDisplayText(decoded,rich),rich)
assert.deepEqual(writeDisplayText({text:'新名称',bold:true,italic:false},rich),{...rich,value:{...rich.value,text:{type:'string',value:'新名称'}}})
const advanced:NbtValue={type:'compound',value:{translate:{type:'string',value:'example.name'},with:{type:'list',value:[{type:'compound',value:{text:{type:'string',value:'参数'}}}]},'example:metadata':{type:'long',value:'9223372036854775807'}}}
assert.equal(writeDisplayText(readDisplayText(advanced),advanced),advanced)
const jsonLiteral:NbtValue={type:'string',value:'{"text":"保留括号","bold":false}'}
assert.equal(readDisplayText(jsonLiteral),jsonLiteral.value)
assert.equal(writeDisplayText(readDisplayText(jsonLiteral),jsonLiteral),jsonLiteral)
assert.equal(renderItemTooltip({id:'minecraft:stick',components:{'minecraft:custom_name':jsonLiteral}}).name[0].text,jsonLiteral.value)

const adapter:TextLocalizationAdapter={bound:true,activeLocale:'zh_cn',availableLocales:['zh_cn','en_us'],runtimeKey:'hanshu.demo.display.custom_name',semanticKey:'display.custom_name',translations:{zh_cn:'{"text":"本地名称","bold":true}'},onLocaleChange:()=>{},onTranslationChange:()=>{}}
const original={translate:adapter.runtimeKey,color:'gold',italic:false,extra:[{text:' 后缀'}]}
const projected=localizedDisplayText(original,adapter)
assert.equal(original.translate,adapter.runtimeKey)
assert.deepEqual(projected,{text:'',color:'gold',italic:false,extra:[{text:'本地名称',bold:true},{text:' 后缀'}]})
assert.equal(localizedDisplayText(original,{...adapter,activeLocale:'en_us'}),original)
const item={id:'minecraft:stick',components:{'minecraft:item_name':writeDisplayText('基础名称'),'minecraft:custom_name':writeDisplayText(projected),'minecraft:lore':{type:'list' as const,value:[writeDisplayText('保留的说明')]}}}
let tooltip=renderItemTooltip(item)
assert.equal(tooltip.name.map(v=>v.text).join(''),'本地名称 后缀')
assert.equal(tooltip.name[0].italic,undefined)
assert.equal(tooltip.tooltip.length,2)
const hidden=renderItemTooltip({...item,components:{...item.components,'minecraft:tooltip_display':{type:'compound',value:{hide_tooltip:{type:'byte',value:1},hidden_components:{type:'list',value:[{type:'string',value:'minecraft:lore'}]}}}}})
assert.equal(hidden.hidden,true)
assert.equal(hidden.tooltip.length,1)
assert.equal(item.components['minecraft:lore'].value.length,1)
const {'minecraft:custom_name':_custom,...baseComponents}=item.components;void _custom
tooltip=renderItemTooltip({...item,components:baseComponents})
assert.equal(tooltip.name.map(v=>v.text).join(''),'基础名称')
const appearance=entityFieldEditors().find(editor=>editor.id==='hanshu:appearance')!
for(const field of ['CustomName','CustomNameVisible','Invulnerable','Silent','NoGravity','Glowing','Health','Fire'])assert(appearance.fields.includes(field))
console.log('PASS display appearance: tri-state TNBT, unchanged advanced/literal preservation, localized preview, name priority, tooltip hiding and entity field capabilities')
