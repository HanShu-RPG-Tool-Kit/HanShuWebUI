/*
{
  "id": "core:xp_gain",
  "labels": {
    "zh_cn": { "name": "获取经验", "description": "累计获得指定点数的经验（仅正数增量）" },
    "en_us": { "name": "Gain XP", "description": "Accumulate experience points gained (positive only)" }
  },
  "params": {
    "count": {
      "labels": {
        "zh_cn": { "name": "经验点", "description": "需要累计获得的经验点" },
        "en_us": { "name": "XP points", "description": "Experience points to gain" }
      },
      "widget": { "editor": "number" }
    }
  },
  "localize": {
    "zh_cn": "获取经验（{have}/{count}）",
    "en_us": "Gain XP ({have}/{count})"
  }
}
*/

import XpChange from "net.neoforged.neoforge.event.entity.player.PlayerXpEvent$XpChange"
import ServerPlayer from "net.minecraft.server.level.ServerPlayer"
import GoalInstance from "mchhui.rpgtoolkit.feature.goal.GoalInstance"

@goal("core:xp_gain")
@config(field("count", "int", 100))
@state(field("have", "int", 0))

@subscribe(XpChange, {priority: "NORMAL", receiveCancelled: false})
function on_event(instance: GoalInstance, event: XpChange): void {
    var p = event.getEntity();
    if ((!((p instanceof ServerPlayer)) || !(instance.isOwner(p)))) {
        return;
    }
    var amount = Number(event.getAmount());
    if ((amount > 0)) {
        st.have += amount;
    }
}

function update_state(instance: GoalInstance): void {
    update_satisfied_state(instance, (st.have >= cfg.count));
}

function localize(instance: GoalInstance, locale: string): string {
    return pick_locale(locale, {"zh_cn": ("获取经验（" + String(st.have) + "/" + String(cfg.count) + "）"), "en_us": ("Gain XP (" + String(st.have) + "/" + String(cfg.count) + ")")});
}
