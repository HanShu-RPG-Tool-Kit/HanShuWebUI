/*
{
  "id": "core:manual_complete",
  "labels": {
    "zh_cn": { "name": "手动完成", "description": "收到指定 token 的 goal.pulse 信号达到次数后完成" },
    "en_us": { "name": "Manual complete", "description": "Complete after receiving goal.pulse for token enough times" }
  },
  "params": {
    "token": {
      "labels": {
        "zh_cn": { "name": "令牌", "description": "与 goal.pulse 第一个参数匹配" },
        "en_us": { "name": "Token", "description": "Matches the first arg of goal.pulse" }
      },
      "widget": { "editor": "text" }
    },
    "count": {
      "labels": {
        "zh_cn": { "name": "次数", "description": "需要收到的脉冲次数" },
        "en_us": { "name": "Count", "description": "Pulses required" }
      },
      "widget": { "editor": "number" }
    }
  },
  "localize": {
    "zh_cn": "手动 {token}（{have}/{count}）",
    "en_us": "Manual {token} ({have}/{count})"
  }
}
*/

import GoalPulseEvent from "mchhui.rpgtoolkit.feature.goal.GoalPulseEvent"
import ServerPlayer from "net.minecraft.server.level.ServerPlayer"
import GoalInstance from "mchhui.rpgtoolkit.feature.goal.GoalInstance"

@goal("core:manual_complete")
@config(field("token", "string"), field("count", "int", 1))
@state(field("have", "int", 0))

@subscribe(GoalPulseEvent, {priority: "NORMAL", receiveCancelled: false})
function on_event(instance: GoalInstance, event: GoalPulseEvent): void {
    if ((String(cfg.token) !== String(event.getToken()))) {
        return;
    }
    var p = event.getPlayer();
    if (((p !== null) && (!((p instanceof ServerPlayer)) || !(instance.isOwner(p))))) {
        return;
    }
    st.have += 1;
}

function update_state(instance: GoalInstance): void {
    if ((st.have >= cfg.count)) {
        complete(instance);
    }
}

function localize(instance: GoalInstance, locale: string): string {
    return pick_locale(locale, {"zh_cn": ("手动 " + String(cfg.token) + "（" + String(st.have) + "/" + String(cfg.count) + "）"), "en_us": ("Manual " + String(cfg.token) + " (" + String(st.have) + "/" + String(cfg.count) + ")")});
}
