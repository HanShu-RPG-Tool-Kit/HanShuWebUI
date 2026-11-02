/*
{
  "id": "core:instant_complete",
  "labels": {
    "zh_cn": { "name": "立即完成", "description": "创建后下一 tick 即结算为已完成" },
    "en_us": { "name": "Instant complete", "description": "Completes on the next tick after create" }
  },
  "params": {},
  "localize": {
    "zh_cn": "已完成",
    "en_us": "Done"
  }
}
*/

import PlayerTickPost from "net.neoforged.neoforge.event.tick.PlayerTickEvent$Post"
import ServerPlayer from "net.minecraft.server.level.ServerPlayer"
import GoalInstance from "mchhui.rpgtoolkit.feature.goal.GoalInstance"

@goal("core:instant_complete")
@config()
@state(field("done", "int", 0))

@subscribe(PlayerTickPost, {priority: "NORMAL", receiveCancelled: false})
function on_event(instance: GoalInstance, event: PlayerTickPost): void {
    if ((st.done >= 1)) {
        return;
    }
    var p = event.getEntity();
    if ((!((p instanceof ServerPlayer)) || !(instance.isOwner(p)))) {
        return;
    }
    st.done = 1;
}

function update_state(instance: GoalInstance): void {
    if ((st.done >= 1)) {
        complete(instance);
    }
}

function localize(instance: GoalInstance, locale: string): string {
    return pick_locale(locale, {"zh_cn": "已完成", "en_us": "Done"});
}
