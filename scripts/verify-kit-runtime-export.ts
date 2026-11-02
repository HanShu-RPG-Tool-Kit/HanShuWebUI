import {join,dirname} from 'node:path'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { createKit, createKitItem, createKitItemLink, stringifyKit, parseKit, resolveKit } from '../src/workspaces/gameplay/kit'

const kit = createKit()
kit.tags = ['Test', 'test', '礼包']
kit.modifiers = [{id:'share',label:'平分',expr:'floor(x / distributionCount) + step(distributionId, x - floor(x / distributionCount) * distributionCount, 1, 0)'}]
kit.items = [{...createKitItemLink('kit_blade',10),mods:{count:'share'}}]
kit.pools = [{rolls:3,entries:[{weight:1,items:[createKitItem('minecraft:diamond',1)]},{weight:2,items:[createKitItem('minecraft:emerald',2)]}]}]
kit.effects = [{id:'minecraft:speed',amplifier:0,duration:0,particles:false}]
kit.experience = {kind:'points',amount:7}
kit.commands = ['tag @s add kit_command_ran']
kit.feedback = {message:'feedback.message',title:'',subtitle:'',sound:''}
kit.script = [{ref:'web-reward'}]
const script = `require helper from "helper"
import Kits from "mchhui.rpgtoolkit.feature.kit.Kits"
import Map from "java.util.Map"
import Component from "net.minecraft.network.chat.Component"
function check(value: boolean): void { if (!value) throw new Error("kit fixture failed"); }
check(helper.marker() === "library-ok");
helper.calls = 10;
var nested = Kits.get().grant(player, "inner", Map.of());
check(String(nested.status()) === "SUCCESS");
require restored from "helper"
check(restored === helper && restored.calls === 10);
check(typeof seen === "undefined");
var seen = true;
check(Number(kit.param("distributionId")) % 1 === 0);
check(players.length === Number(kit.param("distributionCount")));
var draw = random(); check(draw >= 0 && draw < 1);
check(kit.expr("round(2.5)") === 3);
check(String(kit.tags[0]) === "Test" && kit.tags.length === 2);
check(Number(kit.param("difficulty")) === 0);
player.addTag("kit_script_ran");
if (Number(kit.param("distributionId")) === 0) throw new Error("expected first-recipient failure");
player.sendSystemMessage(Component.literal("kit-script-ok"));
`
const source=stringifyKit(kit)
const roundtrip=parseKit(source)
assert.deepEqual(roundtrip.tags,['Test','礼包'])
assert.equal(roundtrip.items[0].item,'kit_blade')
const resolved=resolveKit(roundtrip,{distributionCount:3,distributionId:0})
assert.equal(resolved.items[0].count,4)
// Serialization preserves authored values; runtime must distribute 10 as 4/3/3.
assert.equal(JSON.parse(source).items[0].count,10)
assert.deepEqual(roundtrip.script,[{ref:'web-reward'}])
if(process.env.KIT_RUNTIME_EXPORT_PATH){await writeFile(process.env.KIT_RUNTIME_EXPORT_PATH,source);await writeFile(join(dirname(process.env.KIT_RUNTIME_EXPORT_PATH),'web-reward.js'),script)}
console.log('通过：kit 运行时夹具使用 WebUI 实际序列化器生成，保留模板链接、修饰器和完整奖励类型')
