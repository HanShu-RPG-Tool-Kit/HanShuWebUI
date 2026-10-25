/* Registration module; editors are mounted by the common card host. */
/* oxlint-disable react/only-export-components */
import {useId,useState} from 'react'
import {readNbt,type ItemComponents,type NbtValue} from '../tnbtJson'
import {registerItemComponentEditor,type ComponentEditorProps} from './registry'
import {LocalizedTextField,type LocalizedTextFieldProps} from '../../../textComponent/LocalizedTextField'
import {readDisplayText,writeDisplayText,type GetTextLocalization} from '../displayTextNbt'
import {itemNameBaseStyle} from '../itemTooltip'
import {acceptsEnchantments,acceptsAttributes,identifier,stringTag,numeric,newAttribute,patchAttribute,renameEnchantment,operations,slots} from './complexModel'

const enchants={sharpness:'锋利',smite:'亡灵杀手',bane_of_arthropods:'节肢杀手',unbreaking:'耐久',mending:'经验修补',efficiency:'效率',fortune:'时运',silk_touch:'精准采集',protection:'保护',fire_protection:'火焰保护',blast_protection:'爆炸保护',projectile_protection:'弹射物保护',feather_falling:'摔落缓冲',power:'力量',punch:'冲击',flame:'火矢',infinity:'无限',looting:'抢夺',knockback:'击退',fire_aspect:'火焰附加',sweeping_edge:'横扫之刃',respiration:'水下呼吸',aqua_affinity:'水下速掘',thorns:'荆棘',depth_strider:'深海探索者',frost_walker:'冰霜行者',soul_speed:'灵魂疾行',swift_sneak:'迅捷潜行',loyalty:'忠诚',impaling:'穿刺',riptide:'激流',channeling:'引雷',multishot:'多重射击',quick_charge:'快速装填',piercing:'穿透',luck_of_the_sea:'海之眷顾',lure:'饵钓',binding_curse:'绑定诅咒',vanishing_curse:'消失诅咒',density:'致密',breach:'破甲',wind_burst:'风爆'}
const attributes={attack_damage:'攻击伤害',attack_speed:'攻击速度',armor:'护甲',armor_toughness:'护甲韧性',max_health:'最大生命值',movement_speed:'移动速度',knockback_resistance:'击退抗性',attack_knockback:'攻击击退',luck:'幸运',scale:'体型',block_interaction_range:'方块交互距离',entity_interaction_range:'实体交互距离',jump_strength:'跳跃力度',gravity:'重力'}
function Suggestions({id,entries}:{id:string;entries:Record<string,string>}) {return <datalist id={id}>{Object.entries(entries).map(([key,label])=><option key={key} value={`minecraft:${key}`}>{label}</option>)}</datalist>}

function CommitInput({value,disabled,label,list,validate,onCommit,placeholder}:{value:string;disabled?:boolean;label:string;list?:string;validate?:(text:string)=>string;onCommit:(text:string)=>void;placeholder?:string}) {
  const [edit,setEdit]=useState<{base:string;raw:string;error:string}|null>(null)
  const current=edit?.base===value?edit:null
  function commit(){const text=current?.raw ?? value;try{const message=validate?.(text);if(message)throw Error(message);if(text!==value)onCommit(text);setEdit(null)}catch(e){setEdit({base:value,raw:text,error:(e as Error).message})}}
  return <input className="item-complex-input" aria-label={label} aria-invalid={!!current?.error} title={current?.error} list={list} disabled={disabled} placeholder={placeholder}
    value={current?.raw ?? value} onChange={e=>setEdit({base:value,raw:e.target.value,error:''})} onBlur={commit} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();e.currentTarget.blur()}if(e.key==='Escape'){e.preventDefault();e.stopPropagation();setEdit(null)}}}/>
}
function NumberInput({value,onChange,disabled,label,min,max,integer=false}:{value:number|string;onChange:(value:string)=>void;disabled?:boolean;label:string;min?:number;max?:number;integer?:boolean}) {
  const source=String(value), [edit,setEdit]=useState<{base:string;raw:string;error:boolean}|null>(null)
  const current=edit?.base===source?edit:null
  return <input className="item-complex-input" type="number" step={integer?'1':'any'} min={min} max={max} aria-label={label} aria-invalid={current?.error ?? false} disabled={disabled} value={current?.raw ?? source}
    onChange={e=>{const raw=e.target.value,n=e.target.valueAsNumber;const valid=raw!==''&&Number.isFinite(n)&&(!integer||Number.isInteger(n))&&(min===undefined||n>=min)&&(max===undefined||n<=max);setEdit(valid?null:{base:source,raw,error:true});if(valid)onChange(raw)}}/>
}
function Enchantments({value,disabled,onChange}:ComponentEditorProps) {
  const suggestions=useId(),[adding,setAdding]=useState(false),[draft,setDraft]=useState(''),[level,setLevel]=useState('1'),[error,setError]=useState('')
  if(value.type!=='compound')return null
  function add(){if(disabled||value.type!=='compound')return;if(!identifier.test(draft)){setError('填写 namespace:id 格式的附魔 ID');return}if(Object.hasOwn(value.value,draft)){setError('该附魔已存在');return}const n=Number(level);if(!Number.isInteger(n)||n<1||n>255){setError('等级需为 1..255');return}onChange({...value,value:{...value.value,[draft]:{type:'int',value:n}}});setDraft('');setLevel('1');setError('');setAdding(false)}
  return <div className="item-complex-body"><Suggestions id={suggestions} entries={enchants}/>
    {Object.entries(value.value).length>0&&<div className="item-enchant-row item-complex-labels"><span>附魔</span><span>等级</span><span/></div>}
    {Object.entries(value.value).map(([id,n],i)=><div className="item-enchant-row" key={id}>
      <CommitInput value={id} disabled={disabled} label={`附魔 ID ${i+1}`} list={suggestions} validate={id=>!identifier.test(id)?'附魔 ID 无效':''} onCommit={next=>onChange(renameEnchantment(value,id,next))}/>
      <NumberInput value={numeric(n)!} disabled={disabled} label={`附魔等级 ${i+1}`} min={1} max={255} integer onChange={next=>onChange({...value,value:{...value.value,[id]:{type:'int',value:Number(next)}}})}/>
      <button type="button" className="item-complex-remove" aria-label={`移除附魔 ${id}`} disabled={disabled} onClick={()=>{const next={...value.value};delete next[id];onChange({...value,value:next})}}>×</button>
    </div>)}
    {adding?<div className="item-complex-add" onKeyDown={e=>{if(e.key==='Escape')setAdding(false)}}>
      <label>附魔 ID<input className="item-complex-input" autoFocus aria-label="新增附魔 ID" list={suggestions} value={draft} disabled={disabled} onChange={e=>{setDraft(e.target.value);setError('')}}/></label>
      <label>等级<input className="item-complex-input" type="number" min="1" max="255" step="1" aria-label="新增附魔等级" value={level} disabled={disabled} onChange={e=>setLevel(e.target.value)}/></label>
      <button type="button" className="item-complex-button" disabled={disabled} onClick={add}>添加</button><button type="button" className="item-complex-button" onClick={()=>setAdding(false)}>取消</button>
      {error&&<p className="item-complex-error" role="alert">{error}</p>}
    </div>:<button type="button" className="item-complex-button" disabled={disabled} onClick={()=>setAdding(true)}>＋ 添加附魔</button>}
    {!Object.keys(value.value).length&&!adding&&<p className="item-card-note">尚无附魔，可填写原版或模组附魔 ID。</p>}
  </div>
}

function AttributeModifiers({value,disabled,onChange}:ComponentEditorProps) {
  const suggestions=useId()
  if(value.type!=='list')return null
  const patch=(index:number,field:string,next:NbtValue)=>{if(!disabled)onChange(patchAttribute(value,index,{[field]:next}))}
  return <div className="item-complex-body"><Suggestions id={suggestions} entries={attributes}/>
    {value.value.map((entry,index)=>{if(entry.type!=='compound')return null;const n=entry.value;const id=String(n.id.value),attr=String(n.type.value),slot=n.slot?.type==='string'?n.slot.value:'any';return <div className="item-modifier-entry" key={index}>
      <div className="item-entry-heading"><span>修饰器 {index+1}</span><button type="button" className="item-complex-remove" aria-label={`移除修饰器 ${index+1}`} disabled={disabled} onClick={()=>onChange({...value,value:value.value.filter((_,i)=>i!==index)})}>×</button></div>
      <div className="item-modifier-grid">
        <label>属性<CommitInput value={attr} disabled={disabled} list={suggestions} label={`属性 ${index+1}`} validate={id=>!identifier.test(id)?'属性 ID 无效':''} onCommit={next=>patch(index,'type',stringTag(next))}/></label>
        <label>修饰器 ID<CommitInput value={id} disabled={disabled} label={`修饰器 ID ${index+1}`} validate={id=>!identifier.test(id)?'修饰器 ID 无效':''} onCommit={next=>patch(index,'id',stringTag(next))}/></label>
        <label>数值<NumberInput value={String(n.amount.value)} disabled={disabled} label={`修饰器数值 ${index+1}`} onChange={next=>patch(index,'amount',readNbt({type:'double',value:next}))}/></label>
        <label>运算方式<select className="item-complex-input" aria-label={`运算方式 ${index+1}`} disabled={disabled} value={String(n.operation.value)} onChange={e=>patch(index,'operation',stringTag(e.target.value))}>{Object.entries(operations).map(([v,t])=><option key={v} value={v}>{t}</option>)}</select></label>
        <label>生效槽位<select className="item-complex-input" aria-label={`生效槽位 ${index+1}`} disabled={disabled} value={slot} onChange={e=>patch(index,'slot',stringTag(e.target.value))}>{!Object.hasOwn(slots,slot)&&<option value={slot}>{slot}</option>}{Object.entries(slots).map(([v,t])=><option key={v} value={v}>{t}</option>)}</select></label>
      </div>
    </div>})}
    <button type="button" className="item-complex-button" disabled={disabled} onClick={()=>onChange({...value,value:[...value.value,newAttribute(value)]})}>＋ 添加属性修改器</button>
    {!value.value.length&&<p className="item-card-note">每条记录独立配置属性、运算方式和生效槽位。</p>}
  </div>
}

function AppearanceText({value,field,label,disabled,getTextLocalization,onChange,baseStyle}:{value:NbtValue|undefined;field:string;label:string;disabled:boolean;getTextLocalization?:GetTextLocalization;onChange:(value:NbtValue)=>void;baseStyle?:LocalizedTextFieldProps['baseStyle']}) {
  const component=readDisplayText(value)
  return <LocalizedTextField label={label} value={component} baseStyle={baseStyle} disabled={disabled} localization={getTextLocalization?.(field,component)} onChange={next=>onChange(writeDisplayText(next,value))}/>
}
const appearanceIds=['minecraft:item_name','minecraft:custom_name','minecraft:lore','minecraft:item_model','minecraft:rarity','minecraft:enchantment_glint_override']
function Appearance({components,disabled,onChange,getTextLocalization}:{components:ItemComponents;disabled:boolean;onChange:(next:ItemComponents,loreOrder?:readonly number[])=>void;getTextLocalization?:GetTextLocalization}) {
  const [draggedLore,setDraggedLore]=useState<number|null>(null)
  const [loreOrder,setLoreOrder]=useState(0)
  const set=(id:string,v:NbtValue,order?:readonly number[])=>{if(!disabled)onChange({...components,[id]:v},order)}
  const remove=(id:string)=>{if(disabled)return;const next={...components};delete next[id];onChange(next)}
  const lore=components['minecraft:lore'],model=components['minecraft:item_model'],rarity=components['minecraft:rarity'],glint=components['minecraft:enchantment_glint_override']
  const control=(id:string)=>Object.hasOwn(components,id)&&<button type="button" className="item-complex-remove" aria-label={`移除 ${id}`} disabled={disabled} onClick={()=>remove(id)}>×</button>
  const baseNameStyle=itemNameBaseStyle(components)
  const display=components['minecraft:tooltip_display']
  const hiddenLore=display?.type==='compound'&&display.value.hidden_components?.type==='list'&&display.value.hidden_components.value.some(v=>v.type==='string'&&v.value==='minecraft:lore')
  function moveLore(index:number,target:number){if(disabled||lore?.type!=='list'||index===target)return;const next=[...lore.value];next.splice(target,0,next.splice(index,1)[0]);setLoreOrder(value=>value+1);const order=lore.value.map((_,i)=>i);order.splice(target,0,order.splice(index,1)[0]);set('minecraft:lore',{...lore,value:next},order)}
  return <div className="item-complex-body">
    <div className="item-name-columns">
    {(['item_name','custom_name'] as const).map(id=><div className="item-appearance-text" key={id}><AppearanceText value={components[`minecraft:${id}`]} field={`item.${id}`} baseStyle={{...baseNameStyle,...(id==='custom_name'?{italic:true}:{})}} disabled={disabled} label={id==='item_name'?'基础显示名称（item_name）':'自定义名称（custom_name）'} getTextLocalization={getTextLocalization} onChange={next=>set(`minecraft:${id}`,next)}/>{control(`minecraft:${id}`)}</div>)}
    </div>
    <div className="item-entry-heading"><span>说明文本（lore）</span>{control('minecraft:lore')}</div>
    {hiddenLore&&<p className="item-card-note">说明文本已在提示框中隐藏。</p>}
    {!lore||lore.type==='list'?<div className="item-lore-list" role="list" aria-label="说明列表">
      {(lore?.type==='list'?lore.value:[]).map((line,index)=><div className={`item-lore-rich-row${draggedLore===index?' is-dragging':''}`} role="listitem" key={`${loreOrder}/${index}`} onDragOver={event=>{if(draggedLore!==null&&!disabled)event.preventDefault()}} onDrop={event=>{if(draggedLore===null||disabled)return;event.preventDefault();moveLore(draggedLore,index);setDraggedLore(null)}}><button type="button" className="item-lore-drag" draggable={!disabled} disabled={disabled} aria-label={`拖动说明 ${index+1}`} title="拖拽排序" onDragStart={event=>{event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',String(index));setDraggedLore(index)}} onDragEnd={()=>setDraggedLore(null)}>⠿</button><AppearanceText value={line} field={`item.lore.${index}`} baseStyle={{color:'#AA00AA',italic:true}} disabled={disabled} label={`说明文本 ${index+1}`} getTextLocalization={getTextLocalization} onChange={next=>{if(lore?.type==='list')set('minecraft:lore',{...lore,value:lore.value.map((v,i)=>i===index?next:v)},lore.value.map((_,i)=>i))}}/><div className="item-lore-actions"><button type="button" aria-label={`上移说明 ${index+1}`} disabled={disabled||index===0} onClick={()=>moveLore(index,index-1)}>↑</button><button type="button" aria-label={`下移说明 ${index+1}`} disabled={disabled||index===(lore?.type==='list'?lore.value.length:0)-1} onClick={()=>moveLore(index,index+1)}>↓</button><button type="button" className="item-complex-remove" aria-label={`移除说明 ${index+1}`} disabled={disabled} onClick={()=>{if(lore?.type==='list')set('minecraft:lore',{...lore,value:lore.value.filter((_,i)=>i!==index)},lore.value.map((_,i)=>i).filter(i=>i!==index))}}>×</button></div></div>)}
      <button type="button" className="item-complex-button" disabled={disabled||(lore?.type==='list'&&lore.value.length>=256)} onClick={()=>set('minecraft:lore',{type:'list',value:[...(lore?.type==='list'?lore.value:[]),stringTag('')]})}>＋ 添加说明行</button>
    </div>:<p className="item-card-note">此说明格式请在组件树中编辑。</p>}
    <div className="item-appearance-options">
      <label>稀有度{!rarity||rarity.type==='string'?<select className="item-complex-input" aria-label="物品稀有度" disabled={disabled} value={rarity?.type==='string'?rarity.value:''} onChange={e=>e.target.value?set('minecraft:rarity',stringTag(e.target.value)):remove('minecraft:rarity')}><option value="">未设置</option>{rarity?.type==='string'&&!['common','uncommon','rare','epic'].includes(rarity.value)&&<option value={rarity.value}>{rarity.value}</option>}<option value="common">普通</option><option value="uncommon">罕见</option><option value="rare">稀有</option><option value="epic">史诗</option></select>:<span className="item-card-note">此数据格式请在下方组件树中编辑。</span>}</label>
      <label>附魔光效{!glint||(glint.type==='byte'&&(glint.value===0||glint.value===1))?<select className="item-complex-input" aria-label="附魔光效" disabled={disabled} value={glint?.type==='byte'?String(glint.value):''} onChange={e=>e.target.value?set('minecraft:enchantment_glint_override',{type:'byte',value:Number(e.target.value)}):remove('minecraft:enchantment_glint_override')}><option value="">未设置</option><option value="1">开启</option><option value="0">关闭</option></select>:<span className="item-card-note">此数据格式请在下方组件树中编辑。</span>}</label>
    </div>
    <div className="item-appearance-field"><span>物品模型</span>{!model||model.type==='string'?<CommitInput label="物品模型" value={model?.type==='string'?model.value:''} disabled={disabled} placeholder="namespace:item/model" validate={v=>!identifier.test(v)?'填写 namespace:path 格式的模型 ID':''} onCommit={next=>set('minecraft:item_model',stringTag(next))}/>:<span className="item-card-note">此模型数据请在组件树中编辑。</span>}{control('minecraft:item_model')}</div>
  </div>
}
function acceptsTooltipDisplay(value:NbtValue){return value.type==='compound'&&(!value.value.hide_tooltip||(value.value.hide_tooltip.type==='byte'&&[0,1].includes(value.value.hide_tooltip.value)))&&(!value.value.hidden_components||(value.value.hidden_components.type==='list'&&value.value.hidden_components.value.every(entry=>entry.type==='string')))}
function TooltipDisplay({value,disabled,onChange}:ComponentEditorProps){
  if(value.type!=='compound')return null
  const hidden=value.value.hidden_components?.type==='list'?value.value.hidden_components.value:[]
  const write=(key:string,next:NbtValue)=>{if(!disabled)onChange({...value,value:{...value.value,[key]:next}})}
  return <div className="item-complex-body"><label className="item-tooltip-toggle">隐藏整个提示框<input type="checkbox" role="switch" aria-label="隐藏整个提示框" disabled={disabled} checked={value.value.hide_tooltip?.value===1} onChange={e=>write('hide_tooltip',{type:'byte',value:e.target.checked?1:0})}/></label><label className="item-tooltip-hidden">隐藏组件（hidden_components）<CommitInput label="隐藏组件" value={hidden.map(v=>String(v.value)).join(', ')} disabled={disabled} placeholder="minecraft:lore, minecraft:enchantments" validate={raw=>raw.split(/[,，]/).map(v=>v.trim()).filter(Boolean).every(v=>identifier.test(v))?'':'填写以逗号分隔的 namespace:id'} onCommit={raw=>write('hidden_components',{type:'list',value:[...new Set(raw.split(/[,，]/).map(v=>v.trim()).filter(Boolean))].map(stringTag)})}/></label></div>
}
const disposers: Array<()=>void> = []
disposers.push(registerItemComponentEditor({kind:'group',id:'hanshu:tooltip_display',title:'提示框显示策略',caption:'',tone:'steel',alwaysVisible:true,order:1,componentIds:['minecraft:tooltip_display'],createComponents:()=>({}),Editor:({components,disabled,onChange})=>{
  const value=components['minecraft:tooltip_display']??{type:'compound' as const,value:{}}
  return acceptsTooltipDisplay(value)?<TooltipDisplay value={value} disabled={disabled} onChange={next=>onChange({...components,'minecraft:tooltip_display':next})}/>:<p className="item-card-note">此显示策略请在组件树中编辑。</p>
}}))
for(const [id,title] of [['minecraft:enchantments','附魔'],['minecraft:stored_enchantments','存储附魔']] as const)disposers.push(registerItemComponentEditor({id,title,tone:'violet',wide:true,order:id==='minecraft:enchantments'?10:11,createValue:()=>({type:'compound',value:{}}),accepts:acceptsEnchantments,Editor:Enchantments}))
disposers.push(registerItemComponentEditor({id:'minecraft:attribute_modifiers',title:'属性修改器',tone:'amber',wide:true,order:20,createValue:()=>({type:'list',value:[]}),accepts:acceptsAttributes,Editor:AttributeModifiers}))
disposers.push(registerItemComponentEditor({kind:'group',alwaysVisible:true,id:'hanshu:appearance',title:'外观',caption:'',tone:'steel',order:0,componentIds:appearanceIds,createComponents:()=>({'minecraft:rarity':stringTag('common')}),Editor:Appearance}))

if(import.meta.hot)import.meta.hot.dispose(()=>disposers.forEach(remove=>remove()))
