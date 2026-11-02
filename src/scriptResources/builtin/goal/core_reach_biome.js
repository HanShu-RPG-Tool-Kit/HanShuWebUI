/*
{
  "id": "core:reach_biome",
  "labels": {
    "zh_cn": { "name": "到达群系", "description": "站在指定群系中（脚下方块所在群系）" },
    "en_us": { "name": "Reach biome", "description": "Stand in the target biome (at the player's feet)" }
  },
  "params": {
    "target": {
      "labels": {
        "zh_cn": { "name": "群系", "description": "群系 id，如 minecraft:desert" },
        "en_us": { "name": "Biome", "description": "Biome id, e.g. minecraft:desert" }
      },
      "widget": { "editor": "suggest", "type": "biome_mc_type" }
    }
  },
  "localize": {
    "zh_cn": "到达 {target}",
    "en_us": "Reach {target}"
  }
}
*/

import PlayerTickPost from "net.neoforged.neoforge.event.tick.PlayerTickEvent$Post"
import ServerPlayer from "net.minecraft.server.level.ServerPlayer"
import GoalWorld from "mchhui.rpgtoolkit.feature.goal.GoalWorld"
import GoalLabels from "mchhui.rpgtoolkit.feature.goal.GoalLabels"
import GoalInstance from "mchhui.rpgtoolkit.feature.goal.GoalInstance"

@goal("core:reach_biome")
@config(field("target", "string", "minecraft:desert"))
@state(field("done", "int", 0))

@subscribe(PlayerTickPost, {priority: "NORMAL", receiveCancelled: false})
function on_event(instance: GoalInstance, event: PlayerTickPost): void {
    if ((st.done >= 1)) {
        return;
    }
    var p = event.getEntity();
    if ((!((p instanceof ServerPlayer)) || !(instance.isOwner(p)) || ((Number(p.tickCount) % 10) !== 0))) {
        return;
    }
    if (GoalWorld.inBiome(p, (cfg.target ? String(cfg.target) : ""))) {
        st.done = 1;
    }
}

function update_state(instance: GoalInstance): void {
    if ((st.done >= 1)) {
        complete(instance);
    }
}

function localize(instance: GoalInstance, locale: string): string {
    var name = GoalLabels.minecraftBiome((cfg.target ? String(cfg.target) : ""), locale);
    return pick_locale(locale, {"zh_cn": ("到达 " + String(name)), "en_us": ("Reach " + String(name))});
}
