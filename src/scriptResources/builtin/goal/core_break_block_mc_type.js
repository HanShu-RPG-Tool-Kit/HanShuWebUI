/*
{
  "id": "core:break_block_mc_type",
  "labels": {
    "zh_cn": { "name": "挖掘方块", "description": "破坏指定原版方块类型的次数" },
    "en_us": { "name": "Break block", "description": "Count breaks of a vanilla block type" }
  },
  "params": {
    "count": {
      "labels": {
        "zh_cn": { "name": "数量", "description": "需要破坏的次数" },
        "en_us": { "name": "Count", "description": "Breaks required" }
      },
      "widget": { "editor": "number" }
    },
    "target": {
      "labels": {
        "zh_cn": { "name": "方块", "description": "方块 id，如 minecraft:stone" },
        "en_us": { "name": "Block", "description": "Block id, e.g. minecraft:stone" }
      },
      "widget": { "editor": "suggest", "type": "block_mc_type" }
    }
  },
  "localize": {
    "zh_cn": "挖掘 {target}（{have}/{count}）",
    "en_us": "Break {target} ({have}/{count})"
  }
}
*/

import BreakBlockEvent from "net.neoforged.neoforge.event.level.block.BreakBlockEvent"
import ServerPlayer from "net.minecraft.server.level.ServerPlayer"
import BuiltInRegistries from "net.minecraft.core.registries.BuiltInRegistries"
import GoalLabels from "mchhui.rpgtoolkit.feature.goal.GoalLabels"
import GoalInstance from "mchhui.rpgtoolkit.feature.goal.GoalInstance"

@goal("core:break_block_mc_type")
@config(field("count", "int", 1), field("target", "string", "minecraft:stone"))
@state(field("have", "int", 0))

@subscribe(BreakBlockEvent, {priority: "NORMAL", receiveCancelled: false})
function on_event(instance: GoalInstance, event: BreakBlockEvent): void {
    if (event.isCanceled()) {
        return;
    }
    var p = event.getPlayer();
    if ((!((p instanceof ServerPlayer)) || !(instance.isOwner(p)))) {
        return;
    }
    var wanted = (cfg.target ? String(cfg.target) : "");
    if (!(wanted)) {
        return;
    }
    var actual = String(BuiltInRegistries.BLOCK.getKey(event.getState().getBlock()));
    if ((actual !== wanted)) {
        return;
    }
    st.have += 1;
}

function update_state(instance: GoalInstance): void {
    update_satisfied_state(instance, (st.have >= cfg.count));
}

function localize(instance: GoalInstance, locale: string): string {
    var name = GoalLabels.minecraftBlock((cfg.target ? String(cfg.target) : ""), locale);
    return pick_locale(locale, {"zh_cn": ("挖掘 " + String(name) + "（" + String(st.have) + "/" + String(cfg.count) + "）"), "en_us": ("Break " + String(name) + " (" + String(st.have) + "/" + String(cfg.count) + ")")});
}
