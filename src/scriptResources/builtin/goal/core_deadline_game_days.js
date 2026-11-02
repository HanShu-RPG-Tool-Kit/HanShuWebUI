/*
{
  "id": "core:deadline_game_days",
  "labels": {
    "zh_cn": { "name": "截止日期（游戏日）", "description": "按主世界 gameTime；1 日=24000 tick；未到期已满足，到期失败；时间离线照走" },
    "en_us": { "name": "Deadline (game days)", "description": "Overworld gameTime; 1 day = 24000 ticks; SATISFIED until due then FAILED; advances offline" }
  },
  "params": {
    "days": {
      "labels": {
        "zh_cn": { "name": "游戏日", "description": "从激活起经过的自然日数（24000 tick/日）" },
        "en_us": { "name": "Game days", "description": "Natural days from activate (24000 ticks/day)" }
      },
      "widget": { "editor": "number" }
    }
  },
  "localize": {
    "zh_cn": "游戏日剩余约 {remain} 天",
    "en_us": "About {remain} game day(s) left"
  }
}
*/

import PlayerTickPost from "net.neoforged.neoforge.event.tick.PlayerTickEvent$Post"
import ServerPlayer from "net.minecraft.server.level.ServerPlayer"
import GoalClocks from "mchhui.rpgtoolkit.feature.goal.GoalClocks"
import Long from "java.lang.Long"
import GoalInstance from "mchhui.rpgtoolkit.feature.goal.GoalInstance"

@goal("core:deadline_game_days")
@config(field("days", "int", 1))
@state(field("primed", "int", 0), field("deadline", "string", ""), field("remain", "int", 0), field("expired", "int", 0))

function _deadline_long(raw: string): Long {
    return Long.valueOf(raw == null || raw === "" ? "0" : String(raw));
}

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
        var dl = GoalClocks.deadlineGameTime(p, Number(cfg.days));
        st.deadline = String(dl);
        st.primed = 1;
    } else {
        if (((Number(p.tickCount) % 20) !== 0)) {
            return;
        }
    }
    var dl = _deadline_long(st.deadline);
    st.remain = GoalClocks.remainGameDays(p, dl);
    if (GoalClocks.gameTimeReached(p, dl)) {
        st.expired = 1;
        st.remain = 0;
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
    var remain = ((st.primed >= 1) ? Number(st.remain) : Number(cfg.days));
    return pick_locale(locale, {"zh_cn": ("游戏日剩余约 " + String(remain) + " 天"), "en_us": ("About " + String(remain) + " game day(s) left")});
}
