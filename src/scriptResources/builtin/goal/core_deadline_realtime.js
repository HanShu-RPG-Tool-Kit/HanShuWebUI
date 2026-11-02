/*
{
  "id": "core:deadline_realtime",
  "labels": {
    "zh_cn": { "name": "截止日期（现实时间）", "description": "墙钟绝对时刻；无偏移时按 UTC；未到期已满足，到期失败；离线照走" },
    "en_us": { "name": "Deadline (realtime)", "description": "Wall-clock instant; bare local form is UTC; SATISFIED until due then FAILED; advances offline" }
  },
  "params": {
    "at": {
      "labels": {
        "zh_cn": { "name": "截止时刻", "description": "ISO-8601（如 2026-10-26T12:00:00Z）或 yyyy-MM-dd HH:mm:ss（按 UTC）" },
        "en_us": { "name": "Deadline", "description": "ISO-8601 (e.g. 2026-10-26T12:00:00Z) or yyyy-MM-dd HH:mm:ss (UTC)" }
      },
      "widget": { "editor": "text" }
    }
  },
  "localize": {
    "zh_cn": "活动截止 {at}",
    "en_us": "Due {at}"
  }
}
*/

import PlayerTickPost from "net.neoforged.neoforge.event.tick.PlayerTickEvent$Post"
import ServerPlayer from "net.minecraft.server.level.ServerPlayer"
import GoalClocks from "mchhui.rpgtoolkit.feature.goal.GoalClocks"
import GoalInstance from "mchhui.rpgtoolkit.feature.goal.GoalInstance"

@goal("core:deadline_realtime")
@config(field("at", "string", "2099-01-01 00:00:00"))
@state(field("primed", "int", 0), field("remain_sec", "int", 0), field("expired", "int", 0))

@subscribe(PlayerTickPost, {priority: "NORMAL", receiveCancelled: false})
function on_event(instance: GoalInstance, event: PlayerTickPost): void {
    if ((st.expired >= 1)) {
        return;
    }
    var p = event.getEntity();
    if ((!((p instanceof ServerPlayer)) || !(instance.isOwner(p)))) {
        return;
    }
    if (((st.primed >= 1) && ((Number(p.tickCount) % 20) !== 0))) {
        return;
    }
    var at = (cfg.at ? String(cfg.at) : "");
    try {
        var ms = GoalClocks.remainRealtimeMs(at);
        st.remain_sec = Number(Math.floor(ms / 1000));
        st.primed = 1;
        if (GoalClocks.realtimeReached(at)) {
            st.expired = 1;
            st.remain_sec = 0;
        }
    } catch (error) {
        st.primed = 1;
        st.expired = 1;
        st.remain_sec = 0;
    }
}

function update_state(instance: GoalInstance): void {
    if ((st.expired >= 1)) {
        fail(instance);
    } else {
        if ((st.primed >= 1)) {
            update_satisfied_state(instance, true);
        }
    }
}

function localize(instance: GoalInstance, locale: string): string {
    var at = (cfg.at ? String(cfg.at) : "");
    var remain = Number(st.remain_sec);
    return pick_locale(locale, {"zh_cn": ("活动截止 " + String(at) + "（剩余约 " + String(remain) + "s）"), "en_us": ("Due " + String(at) + " (~" + String(remain) + "s left)")});
}
