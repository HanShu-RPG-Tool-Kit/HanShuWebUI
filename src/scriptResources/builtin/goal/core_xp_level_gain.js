/*
{
  "id": "core:xp_level_gain",
  "labels": {
    "zh_cn": { "name": "升级等级数", "description": "累计提升指定数量的经验等级（仅正数增量）" },
    "en_us": { "name": "Gain levels", "description": "Accumulate experience levels gained (positive only)" }
  },
  "params": {
    "count": {
      "labels": {
        "zh_cn": { "name": "等级数", "description": "需要累计提升的等级" },
        "en_us": { "name": "Levels", "description": "Levels to gain" }
      },
      "widget": { "editor": "number" }
    }
  },
  "localize": {
    "zh_cn": "升级（{have}/{count}）",
    "en_us": "Gain levels ({have}/{count})"
  }
}
*/

import LevelChange from "net.neoforged.neoforge.event.entity.player.PlayerXpEvent$LevelChange"
import ServerPlayer from "net.minecraft.server.level.ServerPlayer"
import GoalInstance from "mchhui.rpgtoolkit.feature.goal.GoalInstance"

@goal("core:xp_level_gain")
@config(field("count", "int", 1))
@state(field("have", "int", 0))

@subscribe(LevelChange, {priority: "NORMAL", receiveCancelled: false})
function on_event(instance: GoalInstance, event: LevelChange): void {
    var p = event.getEntity();
    if ((!((p instanceof ServerPlayer)) || !(instance.isOwner(p)))) {
        return;
    }
    var delta = Number(event.getLevels());
    if ((delta > 0)) {
        st.have += delta;
    }
}

function update_state(instance: GoalInstance): void {
    update_satisfied_state(instance, (st.have >= cfg.count));
}

function localize(instance: GoalInstance, locale: string): string {
    return pick_locale(locale, {"zh_cn": ("升级（" + String(st.have) + "/" + String(cfg.count) + "）"), "en_us": ("Gain levels (" + String(st.have) + "/" + String(cfg.count) + ")")});
}
