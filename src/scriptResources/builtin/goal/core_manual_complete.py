'''
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
'''
# core:manual_complete — GoalPulseEvent (from signal goal.pulse) increments have → complete.
GoalPulseEvent = java_type("mchhui.rpgtoolkit.feature.goal.GoalPulseEvent")
ServerPlayer = java_type("net.minecraft.server.level.ServerPlayer")


@goal("core:manual_complete")
@config(
    field("token", "string", required=True),
    field("count", "int", default=1),
)
@state(
    field("have", "int", default=0),
)
class ManualComplete(BaseGoalPy):
    @subscribe(GoalPulseEvent)
    def on_pulse(self, instance, event):
        if str(cfg.token) != str(event.getToken()):
            return
        p = event.getPlayer()
        if p is not None and (not instanceof(p, ServerPlayer) or not instance.isOwner(p)):
            return
        st.have += 1

    def update_state(self, instance):
        if st.have >= cfg.count:
            self.complete(instance)

    def localize(self, instance, locale):
        return pick_locale(
            locale,
            {
                "zh_cn": f"手动 {cfg.token}（{st.have}/{cfg.count}）",
                "en_us": f"Manual {cfg.token} ({st.have}/{cfg.count})",
            },
        )
