import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { createKit, createKitItem, createKitItemLink, stringifyKit, parseKit, resolveKit } from '../src/workspaces/progress/kit'

const kit = createKit()
kit.tags = ['Test', 'test', '礼包']
kit.modifiers = [{id:'share',label:'平分',expr:'floor(x / distributionCount) + step(distributionId, x - floor(x / distributionCount) * distributionCount, 1, 0)'}]
kit.items = [{...createKitItemLink('kit_blade',10),mods:{count:'share'}}]
kit.pools = [{rolls:3,entries:[{weight:1,items:[createKitItem('minecraft:diamond',1)]},{weight:2,items:[createKitItem('minecraft:emerald',2)]}]}]
kit.effects = [{id:'minecraft:speed',amplifier:0,duration:0,particles:false}]
kit.experience = {kind:'points',amount:7}
kit.commands = ['tag @s add kit_command_ran']
kit.feedback = {message:'feedback.message',title:'',subtitle:'',sound:''}
kit.script = `import math
from net.minecraft.network.chat import Component
assert 'seen' not in globals()
seen = True
assert isinstance(kit.param('distributionId'), int)
assert len(players) == kit.param('distributionCount')
assert 0 <= random() < 1
assert kit.expr('round(2.5)') == 3
assert kit.tags == ('Test', '礼包')
assert kit.param('difficulty') == 0
player.addTag('kit_script_ran')
if kit.param('distributionId') == 0:
    raise RuntimeError('expected first-recipient failure')
player.sendSystemMessage(Component.literal('kit-script-ok'))
`
const source=stringifyKit(kit)
const roundtrip=parseKit(source)
assert.deepEqual(roundtrip.tags,['Test','礼包'])
assert.equal(roundtrip.items[0].item,'kit_blade')
const resolved=resolveKit(roundtrip,{distributionCount:3,distributionId:0})
assert.equal(resolved.items[0].count,4)
// Serialization preserves authored values; runtime must distribute 10 as 4/3/3.
assert.equal(JSON.parse(source).items[0].count,10)
if(process.env.KIT_RUNTIME_EXPORT_PATH)await writeFile(process.env.KIT_RUNTIME_EXPORT_PATH,source)
console.log('通过：kit 运行时夹具使用 WebUI 实际序列化器生成，保留模板链接、修饰器和完整奖励类型')
