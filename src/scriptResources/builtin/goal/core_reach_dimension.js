/*
{
  "id": "core:reach_dimension",
  "labels": {
    "zh_cn": { "name": "到达维度", "description": "进入指定维度（已在其中也会满足）" },
    "en_us": { "name": "Reach dimension", "description": "Enter the target dimension (also ok if already there)" }
  },
  "params": {
    "target": {
      "labels": {
        "zh_cn": { "name": "维度", "description": "维度 id，如 minecraft:the_nether" },
        "en_us": { "name": "Dimension", "description": "Dimension id, e.g. minecraft:the_nether" }
      },
      "widget": { "editor": "suggest", "type": "dimension_mc_type" }
    }
  },
  "localize": {
    "zh_cn": "到达 {target}",
    "en_us": "Reach {target}"
  }
}
*/

import PlayerChangedDimension from "net.neoforged.neoforge.event.entity.player.PlayerEvent$PlayerChangedDimensionEvent"
import PlayerTickPost from "net.neoforged.neoforge.event.tick.PlayerTickEvent$Post"
import ServerPlayer from "net.minecraft.server.level.ServerPlayer"
import GoalWorld from "mchhui.rpgtoolkit.feature.goal.GoalWorld"
import GoalLabels from "mchhui.rpgtoolkit.feature.goal.GoalLabels"
import GoalInstance from "mchhui.rpgtoolkit.feature.goal.GoalInstance"

@goal("core:reach_dimension")
@config(field("target", "string", "minecraft:the_nether"))
@state(field("done", "int", 0))

@subscribe(PlayerChangedDimension, {priority: "NORMAL", receiveCancelled: false})
function on_event_1(instance: GoalInstance, event: PlayerChangedDimension): void {
    var p = event.getEntity();
    if ((!((p instanceof ServerPlayer)) || !(instance.isOwner(p)) || (st.done >= 1))) {
        return;
    }
    var wanted = (cfg.target ? String(cfg.target) : "");
    var to_id = String(event.getTo().identifier());
    if ((wanted && (to_id === wanted))) {
        st.done = 1;
    }
}

@subscribe(PlayerTickPost, {priority: "NORMAL", receiveCancelled: false})
function on_event_2(instance: GoalInstance, event: PlayerTickPost): void {
    if ((st.done >= 1)) {
        return;
    }
    var p = event.getEntity();
    if ((!((p instanceof ServerPlayer)) || !(instance.isOwner(p)) || ((Number(p.tickCount) % 20) !== 0))) {
        return;
    }
    if (GoalWorld.inDimension(p, (cfg.target ? String(cfg.target) : ""))) {
        st.done = 1;
    }
}

function update_state(instance: GoalInstance): void {
    if ((st.done >= 1)) {
        complete(instance);
    }
}

function localize(instance: GoalInstance, locale: string): string {
    var name = GoalLabels.minecraftDimension((cfg.target ? String(cfg.target) : ""), locale);
    return pick_locale(locale, {"zh_cn": ("到达 " + String(name)), "en_us": ("Reach " + String(name))});
}
