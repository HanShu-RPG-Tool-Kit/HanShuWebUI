/*
{
  "id": "core:reach_structure",
  "labels": {
    "zh_cn": { "name": "到达结构", "description": "站在指定结构的生成范围内（含结构件）" },
    "en_us": { "name": "Reach structure", "description": "Stand inside a generated structure (with pieces)" }
  },
  "params": {
    "target": {
      "labels": {
        "zh_cn": { "name": "结构", "description": "结构 id，如 minecraft:village_plains" },
        "en_us": { "name": "Structure", "description": "Structure id, e.g. minecraft:village_plains" }
      },
      "widget": { "editor": "suggest", "type": "structure_mc_type" }
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

@goal("core:reach_structure")
@config(field("target", "string", "minecraft:village_plains"))
@state(field("done", "int", 0))

@subscribe(PlayerTickPost, {priority: "NORMAL", receiveCancelled: false})
function on_event(instance: GoalInstance, event: PlayerTickPost): void {
    if ((st.done >= 1)) {
        return;
    }
    var p = event.getEntity();
    if ((!((p instanceof ServerPlayer)) || !(instance.isOwner(p)) || ((Number(p.tickCount) % 20) !== 0))) {
        return;
    }
    if (GoalWorld.inStructure(p, (cfg.target ? String(cfg.target) : ""))) {
        st.done = 1;
    }
}

function update_state(instance: GoalInstance): void {
    if ((st.done >= 1)) {
        complete(instance);
    }
}

function localize(instance: GoalInstance, locale: string): string {
    var name = GoalLabels.minecraftStructure((cfg.target ? String(cfg.target) : ""), locale);
    return pick_locale(locale, {"zh_cn": ("到达 " + String(name)), "en_us": ("Reach " + String(name))});
}
