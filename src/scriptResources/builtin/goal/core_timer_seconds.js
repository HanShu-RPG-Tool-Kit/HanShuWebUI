/*
{
  "id": "core:timer_seconds",
  "labels": {
    "zh_cn": { "name": "计时器（秒）", "description": "在线倒计时，离线暂停；未到期为已满足，到 0 失败。任务失败元素，不会自行完成" },
    "en_us": { "name": "Timer (seconds)", "description": "Countdown while online; pauses offline; SATISFIED until 0 then FAILED. Fail element — never self-completes" }
  },
  "params": {
    "seconds": {
      "labels": {
        "zh_cn": { "name": "秒数", "description": "在线累计秒数" },
        "en_us": { "name": "Seconds", "description": "Online seconds before fail" }
      },
      "widget": { "editor": "number" }
    }
  },
  "localize": {
    "zh_cn": "限时剩余 {remain}s",
    "en_us": "Time left {remain}s"
  }
}
*/

import PlayerTickPost from "net.neoforged.neoforge.event.tick.PlayerTickEvent$Post"
import ServerPlayer from "net.minecraft.server.level.ServerPlayer"
import GoalClocks from "mchhui.rpgtoolkit.feature.goal.GoalClocks"
import GoalInstance from "mchhui.rpgtoolkit.feature.goal.GoalInstance"

@goal("core:timer_seconds")
@config(field("seconds", "int", 60))
@state(field("primed", "int", 0), field("remain_ticks", "int", 0), field("expired", "int", 0))

@subscribe(PlayerTickPost, {priority: "NORMAL", receiveCancelled: false})
function on_event(instance: GoalInstance, event: PlayerTickPost): void {
    if ((st.expired >= 1)) {
        return;
    }
    var p = event.getEntity();
    if ((!((p instanceof ServerPlayer)) || !(instance.isOwner(p)))) {
        return;
    }
    if ((st.primed < 1)) {
        st.remain_ticks = GoalClocks.secondsToTicks(Number(cfg.seconds));
        st.primed = 1;
        if ((st.remain_ticks <= 0)) {
            st.expired = 1;
        }
        return;
    }
    st.remain_ticks = (Number(st.remain_ticks) - 1);
    if ((st.remain_ticks <= 0)) {
        st.remain_ticks = 0;
        st.expired = 1;
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
    var remain = ((st.primed >= 1) ? GoalClocks.ticksToSecondsCeil(Number(st.remain_ticks)) : Number(cfg.seconds));
    return pick_locale(locale, {"zh_cn": ("限时剩余 " + String(remain) + "s"), "en_us": ("Time left " + String(remain) + "s")});
}
