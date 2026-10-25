/** Script type is a storage/runtime contract; user folders are presentation only. */
export const SCRIPT_TYPES=['common','goal','kit','item','entity','enchantment','player'] as const
export type ScriptType=typeof SCRIPT_TYPES[number]
export const SCRIPT_TYPE_NAMES:Record<ScriptType,string>={common:'通用脚本',goal:'目标定义脚本',kit:'礼包脚本',item:'物品脚本',entity:'实体脚本',enchantment:'附魔定义脚本',player:'玩家脚本'}
export function scriptType(value?:string|null):ScriptType{return SCRIPT_TYPES.includes(value as ScriptType)?value as ScriptType:'common'}
export const scriptSection=(type:ScriptType)=>type==='goal'?'goal-def':type
export const scriptTypeFromSection=(section:string)=>section==='goal-def'?'goal':scriptType(section)
export const scriptResourceKey=(type:ScriptType,name:string)=>`${type}/${name.normalize('NFC').toLowerCase()}`
