/*
{
  "id": "core:observe_block_mc_type",
  "labels": {
    "zh_cn": { "name": "观察方块", "description": "视线对准指定原版方块类型" },
    "en_us": { "name": "Observe block", "description": "Look at a vanilla block type" }
  },
  "params": {
    "target": {
      "labels": {
        "zh_cn": { "name": "方块", "description": "方块 id，如 minecraft:diamond_ore" },
        "en_us": { "name": "Block", "description": "Block id, e.g. minecraft:diamond_ore" }
      },
      "widget": { "editor": "suggest", "type": "block_mc_type" }
    },
    "range": {
      "labels": {
        "zh_cn": { "name": "距离", "description": "射线检测距离（格）" },
        "en_us": { "name": "Range", "description": "Raycast distance in blocks" }
      },
      "widget": { "editor": "number" }
    }
  },
  "localize": {
    "zh_cn": "观察 {target}",
    "en_us": "Observe {target}"
  }
}
*/

import PlayerTickPost from "net.neoforged.neoforge.event.tick.PlayerTickEvent$Post"
import ServerPlayer from "net.minecraft.server.level.ServerPlayer"
import GoalLooks from "mchhui.rpgtoolkit.feature.goal.GoalLooks"
import GoalLabels from "mchhui.rpgtoolkit.feature.goal.GoalLabels"
import GoalInstance from "mchhui.rpgtoolkit.feature.goal.GoalInstance"

@goal("core:observe_block_mc_type")
@config(field("target", "string", "minecraft:diamond_ore"), field("range", "double", 5.0))
@state(field("done", "int", 0))

@subscribe(PlayerTickPost, {priority: "NORMAL", receiveCancelled: false})
function on_event(instance: GoalInstance, event: PlayerTickPost): void {
    if ((st.done >= 1)) {
        return;
    }
    var p = event.getEntity();
    if ((!((p instanceof ServerPlayer)) || !(instance.isOwner(p)) || ((Number(p.tickCount) % 5) !== 0))) {
        return;
    }
    if (GoalLooks.lookingAtBlock(p, (cfg.target ? String(cfg.target) : ""), Number(cfg.range))) {
        st.done = 1;
    }
}

function update_state(instance: GoalInstance): void {
    if ((st.done >= 1)) {
        complete(instance);
    }
}

function localize(instance: GoalInstance, locale: string): string {
    var name = GoalLabels.minecraftBlock((cfg.target ? String(cfg.target) : ""), locale);
    return pick_locale(locale, {"zh_cn": ("观察 " + String(name)), "en_us": ("Observe " + String(name))});
}
