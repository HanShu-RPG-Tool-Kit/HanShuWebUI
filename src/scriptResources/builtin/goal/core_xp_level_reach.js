/*
{
  "id": "core:xp_level_reach",
  "labels": {
    "zh_cn": { "name": "达到等级", "description": "经验等级达到或超过指定值" },
    "en_us": { "name": "Reach level", "description": "Reach or exceed a target experience level" }
  },
  "params": {
    "level": {
      "labels": {
        "zh_cn": { "name": "目标等级", "description": "需要达到的经验等级" },
        "en_us": { "name": "Target level", "description": "Experience level to reach" }
      },
      "widget": { "editor": "number" }
    }
  },
  "localize": {
    "zh_cn": "达到 {level} 级（当前 {have}）",
    "en_us": "Reach level {level} (now {have})"
  }
}
*/

import LevelChange from "net.neoforged.neoforge.event.entity.player.PlayerXpEvent$LevelChange"
import PlayerTickPost from "net.neoforged.neoforge.event.tick.PlayerTickEvent$Post"
import ServerPlayer from "net.minecraft.server.level.ServerPlayer"
import GoalInstance from "mchhui.rpgtoolkit.feature.goal.GoalInstance"

@goal("core:xp_level_reach")
@config(field("level", "int", 30))
@state(field("have", "int", 0), field("done", "int", 0))

@subscribe(LevelChange, {priority: "NORMAL", receiveCancelled: false})
function on_event_1(instance: GoalInstance, event: LevelChange): void {
    var p = event.getEntity();
    if ((!((p instanceof ServerPlayer)) || !(instance.isOwner(p)) || (st.done >= 1))) {
        return;
    }
    var projected = (Number(p.experienceLevel) + Number(event.getLevels()));
    st.have = Math.max(Number(p.experienceLevel), projected);
    if ((st.have >= Number(cfg.level))) {
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
    _sample(p);
}

function _sample(player: ServerPlayer): void {
    st.have = Number(player.experienceLevel);
    if ((st.have >= Number(cfg.level))) {
        st.done = 1;
    }
}

function update_state(instance: GoalInstance): void {
    if ((st.done >= 1)) {
        complete(instance);
    }
}

function localize(instance: GoalInstance, locale: string): string {
    return pick_locale(locale, {"zh_cn": ("达到 " + String(cfg.level) + " 级（当前 " + String(st.have) + "）"), "en_us": ("Reach level " + String(cfg.level) + " (now " + String(st.have) + ")")});
}
