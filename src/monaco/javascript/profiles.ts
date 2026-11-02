import type {ScriptType} from '../../scriptResources'
import {javaModule} from './stubs'
export const PLAYER_EVENT='mchhui.rpgtoolkit.feature.script.player.PlayerEvent'
export const ACTOR_EVENT='mchhui.rpgtoolkit.feature.actor.hook.ActorEvent'
export function javascriptProfile(type:ScriptType){
 const event=type==='player'?PLAYER_EVENT:type==='actor'?ACTOR_EVENT:''
 let source='interface Blackboard {[key:string]:any} declare var exports:any;\n'
 if(type==='kit'||type==='shop')source+=`declare const player: ${javaModule('net.minecraft.server.level.ServerPlayer')}.ServerPlayer;\n`
 if(type==='kit')source+=`declare const players: ReadonlyArray<typeof player>; declare function random():number; declare const kit:{readonly id:string;readonly tags:string[];param(name:string):any;mod(name:string,x:number):number;expr(source:string):number};\n`
 if(type==='shop')source+=`interface ShopEntry {readonly id:string; readonly tags:string[]; readonly quantity:number; readonly delta:number; readonly current:number; readonly initialCapacity:number; readonly maxCapacity:number; adjustDelta(amount:number):void} declare const shop:{readonly id:string;readonly tags:string[];param(name:string):any;mod(name:string,x:number):number;expr(source:string):number;condition(source:string):boolean;entry(id:string):ShopEntry;entries(tag?:string):ShopEntry[]};\n`
 if(type==='goal')source+=`type GoalInstance=${javaModule('mchhui.rpgtoolkit.feature.goal.GoalInstance')}.GoalInstance; type GoalDeliverContext=${javaModule('mchhui.rpgtoolkit.feature.goal.GoalDeliverContext')}.GoalDeliverContext; declare const cfg: {[key:string]:any}; declare const st: {[key:string]:any}; declare function update_satisfied_state(instance:GoalInstance,value:boolean):void; declare function complete(instance:GoalInstance):void; declare function fail(instance:GoalInstance):void; declare function pick_locale(locale:string,texts:{[key:string]:string},fallback?:string):string;\n`
 return {source,requiredClasses:event?[event]:type==='goal'?['mchhui.rpgtoolkit.feature.goal.GoalInstance','mchhui.rpgtoolkit.feature.goal.GoalDeliverContext']:type==='kit'||type==='shop'?['net.minecraft.server.level.ServerPlayer']:[]}
}
