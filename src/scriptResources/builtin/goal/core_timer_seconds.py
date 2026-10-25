'''
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
'''
# core:timer_seconds — online countdown; SATISFIED while remaining, FAILED at 0.
PlayerTickPost = java_type("net.neoforged.neoforge.event.tick.PlayerTickEvent$Post")
ServerPlayer = java_type("net.minecraft.server.level.ServerPlayer")
GoalClocks = java_type("mchhui.rpgtoolkit.feature.goal.GoalClocks")


@goal("core:timer_seconds")
@config(
    field("seconds", "int", default=60),
)
@state(
    field("primed", "int", default=0),
    field("remain_ticks", "int", default=0),
    field("expired", "int", default=0),
)
class TimerSeconds(BaseGoalPy):
    @subscribe(PlayerTickPost)
    def on_tick(self, instance, event):
        if st.expired >= 1:
            return
        p = event.getEntity()
        if not instanceof(p, ServerPlayer) or not instance.isOwner(p):
            return
        if st.primed < 1:
            st.remain_ticks = GoalClocks.secondsToTicks(int(cfg.seconds))
            st.primed = 1
            if st.remain_ticks <= 0:
                st.expired = 1
            return
        st.remain_ticks = int(st.remain_ticks) - 1
        if st.remain_ticks <= 0:
            st.remain_ticks = 0
            st.expired = 1

    def update_state(self, instance):
        if st.expired >= 1:
            self.fail(instance)
        elif st.primed >= 1:
            self.update_satisfied_state(instance, True)

    def localize(self, instance, locale):
        remain = GoalClocks.ticksToSecondsCeil(int(st.remain_ticks)) if st.primed >= 1 else int(cfg.seconds)
        return pick_locale(
            locale,
            {
                "zh_cn": f"限时剩余 {remain}s",
                "en_us": f"Time left {remain}s",
            },
        )
