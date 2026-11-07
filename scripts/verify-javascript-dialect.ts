import assert from 'node:assert/strict'
import {pakScriptMetadata,transformDialect} from '../src/monaco/javascript/dialect'
import {planJavaImport} from '../src/monaco/javascript/javaImportPlan'
const input='import Player from "net.minecraft.server.level.ServerPlayer"\r\nrequire fx from "effects"\r\n@hook("tick", {cancellable:false})\r\nfunction tick(event: PlayerEvent, board: Blackboard): void {\r\n  fx.spark(event.player());\r\n}\r\n'
const output=transformDialect(input)
assert.deepEqual(output.diagnostics,[])
assert.equal(output.source.split('\n').length,input.split('\n').length)
assert.equal(transformDialect(input,'editor').source.split('\n').length,input.split('\n').length)
assert(transformDialect(input,'editor').source.includes('function tick(event: PlayerEvent, board: Blackboard): void'))
assert(!output.source.includes(': PlayerEvent'))
assert(!transformDialect(input,'editor').source.includes('@param'))
assert.equal(output.source.split('\n')[2],'//@hook("tick", {cancellable:false})\r')
assert.deepEqual(output.hooks,[{hook:'tick',function:'tick',line:3,functionLine:4,eventType:'PlayerEvent',cancellable:false,priority:'NORMAL',receiveCancelled:false}])
assert.deepEqual(pakScriptMetadata(output.hooks,output.goal),{version:2,hooks:[{hook:'tick',function:'tick',line:3,cancellable:false,priority:'NORMAL',receiveCancelled:false}],goal:null})
assert.equal(output.aliases.Player,'net.minecraft.server.level.ServerPlayer')
for(const bad of ['import {X} from "a.b"','import X from "./a"','import X from "common"','require fx from "../fx"','require fx from "net.foo.Bar"','require("fx")','load("a.js")','loadWithNewGlobal("a")','@hook(\n"tick")\nfunction f(e,b){}','@hook("tick")\n\nfunction f(e,b){}','@hook("tick")\nfunction f(e){}','function f(){\nimport X from "a.b"\n}','@hook("tick", {bad:true})\nfunction f(e,b){}'])assert(transformDialect(bad).diagnostics.length,`Gate accepted: ${bad}`)
assert.deepEqual(transformDialect('/* import X from "./bad"\n@hook("bad")\n*/\nvar text="load(123)"; // require("bad")').diagnostics,[])
const entry={name:'net.minecraft.world.item.ItemStack',symbol:'ItemStack',packageName:'net.minecraft.world.item',origin:'Minecraft'}
assert.equal(planJavaImport('',entry).text,'import ItemStack from "net.minecraft.world.item.ItemStack"\n')
assert.equal(planJavaImport('var ItemStack = 1;',entry).binding,'ItemStack2')
assert(planJavaImport('import ItemStack from "net.minecraft.world.item.ItemStack"',entry).reused)
console.log('PASS JS dialect: line identity, CRLF, hook metadata, import gates, comments and Java import planning')
