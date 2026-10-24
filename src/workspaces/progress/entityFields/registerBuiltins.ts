import {registerEntityFieldEditor} from './registry'
import {AppearanceFields,AttributeFields,EquipmentFields} from './builtins'
const dispose=[
registerEntityFieldEditor({id:'hanshu:appearance',title:'外观与行为',tone:'violet',order:0,fields:['CustomName', 'CustomNameVisible', 'Invulnerable', 'NoAI', 'Silent', 'PersistenceRequired'],Editor:AppearanceFields}),
registerEntityFieldEditor({id:'hanshu:attributes',title:'基础属性',tone:'green',order:10,fields:['attributes'],Editor:AttributeFields}),
registerEntityFieldEditor({id:'hanshu:equipment',title:'装备 · 内嵌物品',tone:'amber',order:20,fields:['equipment'],Editor:EquipmentFields})
]
if(import.meta.hot)import.meta.hot.dispose(()=>dispose.forEach(remove=>remove()))
