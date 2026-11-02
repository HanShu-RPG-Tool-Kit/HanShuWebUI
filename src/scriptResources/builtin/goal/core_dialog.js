/*
{
  "id": "core:dialog",
  "labels": {
    "zh_cn": { "name": "对话注入点", "description": "Talk 越过指定 @inject 后满足（与读过标记同时机）" },
    "en_us": { "name": "Talk inject", "description": "Satisfy when Talk visits an @inject (same moment as read flag)" }
  },
  "params": {
    "inject": {
      "labels": {
        "zh_cn": { "name": "注入点", "description": "全局 @inject id" },
        "en_us": { "name": "Inject", "description": "Global @inject id" }
      },
      "widget": { "editor": "suggest", "type": "talk_inject" }
    }
  },
  "localize": {
    "zh_cn": "对话 @{inject}",
    "en_us": "Talk @{inject}"
  }
}
*/

import PlayerTalkInjectEvent from "mchhui.rpgtoolkit.feature.talk.PlayerTalkInjectEvent"
import PlayerTickPost from "net.neoforged.neoforge.event.tick.PlayerTickEvent$Post"
import ServerPlayer from "net.minecraft.server.level.ServerPlayer"
import TalkReads from "mchhui.rpgtoolkit.feature.talk.TalkReads"
import GoalInstance from "mchhui.rpgtoolkit.feature.goal.GoalInstance"

@goal("core:dialog")
@config(field("inject", "string"))
@state(field("have", "int", 0))

@subscribe(PlayerTalkInjectEvent, {priority: "NORMAL", receiveCancelled: false})
function on_event_1(instance: GoalInstance, event: PlayerTalkInjectEvent): void {
    var p = event.getPlayer();
    if ((!((p instanceof ServerPlayer)) || !(instance.isOwner(p)))) {
        return;
    }
    if ((String(cfg.inject) !== String(event.getInject()))) {
        return;
    }
    st.have = 1;
}

@subscribe(PlayerTickPost, {priority: "NORMAL", receiveCancelled: false})
function on_event_2(instance: GoalInstance, event: PlayerTickPost): void {
    if ((st.have >= 1)) {
        return;
    }
    var p = event.getEntity();
    if ((!((p instanceof ServerPlayer)) || !(instance.isOwner(p)) || ((Number(p.tickCount) % 20) !== 0))) {
        return;
    }
    if (TalkReads.isRead(p.level().getServer(), p.getUUID(), String(cfg.inject))) {
        st.have = 1;
    }
}

function update_state(instance: GoalInstance): void {
    update_satisfied_state(instance, (st.have >= 1));
}

function localize(instance: GoalInstance, locale: string): string {
    return pick_locale(locale, {"zh_cn": ("对话 @" + String(cfg.inject)), "en_us": ("Talk @" + String(cfg.inject))});
}
