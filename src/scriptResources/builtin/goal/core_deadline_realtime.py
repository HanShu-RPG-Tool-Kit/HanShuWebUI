'''
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
'''
# core:deadline_realtime — wall clock; SATISFIED until due, then FAILED.
PlayerTickPost = java_type("net.neoforged.neoforge.event.tick.PlayerTickEvent$Post")
ServerPlayer = java_type("net.minecraft.server.level.ServerPlayer")
GoalClocks = java_type("mchhui.rpgtoolkit.feature.goal.GoalClocks")


@goal("core:deadline_realtime")
@config(
    field("at", "string", default="2099-01-01 00:00:00"),
)
@state(
    field("primed", "int", default=0),
    field("remain_sec", "int", default=0),
    field("expired", "int", default=0),
)
class DeadlineRealtime(BaseGoalPy):
    @subscribe(PlayerTickPost)
    def on_tick(self, instance, event):
        if st.expired >= 1:
            return
        p = event.getEntity()
        if not instanceof(p, ServerPlayer) or not instance.isOwner(p):
            return
        if st.primed >= 1 and int(p.tickCount) % 20 != 0:
            return
        at = str(cfg.at) if cfg.at else ""
        try:
            ms = GoalClocks.remainRealtimeMs(at)
            st.remain_sec = int(ms // 1000)
            st.primed = 1
            if GoalClocks.realtimeReached(at):
                st.expired = 1
                st.remain_sec = 0
        except Exception:
            st.primed = 1
            st.expired = 1
            st.remain_sec = 0

    def update_state(self, instance):
        if st.expired >= 1:
            self.fail(instance)
        elif st.primed >= 1:
            self.update_satisfied_state(instance, True)

    def localize(self, instance, locale):
        at = str(cfg.at) if cfg.at else ""
        remain = int(st.remain_sec)
        return pick_locale(
            locale,
            {
                "zh_cn": f"活动截止 {at}（剩余约 {remain}s）",
                "en_us": f"Due {at} (~{remain}s left)",
            },
        )
