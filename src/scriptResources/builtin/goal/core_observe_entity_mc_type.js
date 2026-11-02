/*
{
  "id": "core:observe_entity_mc_type",
  "labels": {
    "zh_cn": { "name": "观察生物", "description": "视线对准指定原版实体类型（不被更近的方块挡住）" },
    "en_us": { "name": "Observe entity", "description": "Look at a vanilla entity type (not blocked by a nearer block)" }
  },
  "params": {
    "target": {
      "labels": {
        "zh_cn": { "name": "实体类型", "description": "实体类型 id，如 minecraft:villager" },
        "en_us": { "name": "Entity type", "description": "Entity type id, e.g. minecraft:villager" }
      },
      "widget": { "editor": "suggest", "type": "entity_mc_type" }
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

@goal("core:observe_entity_mc_type")
@config(field("target", "string", "minecraft:villager"), field("range", "double", 5.0))
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
    if (GoalLooks.lookingAtEntity(p, (cfg.target ? String(cfg.target) : ""), Number(cfg.range))) {
        st.done = 1;
    }
}

function update_state(instance: GoalInstance): void {
    if ((st.done >= 1)) {
        complete(instance);
    }
}

function localize(instance: GoalInstance, locale: string): string {
    var name = GoalLabels.minecraftEntityType((cfg.target ? String(cfg.target) : ""), locale);
    return pick_locale(locale, {"zh_cn": ("观察 " + String(name)), "en_us": ("Observe " + String(name))});
}
