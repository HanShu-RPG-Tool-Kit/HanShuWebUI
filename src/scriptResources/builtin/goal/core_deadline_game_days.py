'''
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
'''
# core:deadline_game_days — overworld gameTime deadline → FAILED.
# Clock advances while offline; subject unload means fail() runs on next online tick.
PlayerTickPost = java_type("net.neoforged.neoforge.event.tick.PlayerTickEvent$Post")
ServerPlayer = java_type("net.minecraft.server.level.ServerPlayer")
GoalClocks = java_type("mchhui.rpgtoolkit.feature.goal.GoalClocks")


def _deadline_long(raw):
    if raw is None or raw == "":
        return 0
    return int(str(raw))


@goal("core:deadline_game_days")
@config(
    field("days", "int", default=1),
)
@state(
    field("primed", "int", default=0),
    field("deadline", "string", default=""),
    field("remain", "int", default=0),
    field("expired", "int", default=0),
)
class DeadlineGameDays(BaseGoalPy):
    @subscribe(PlayerTickPost)
    def on_tick(self, instance, event):
        if st.expired >= 1:
            return
        p = event.getEntity()
        if not instanceof(p, ServerPlayer) or not instance.isOwner(p):
            return
        if st.primed < 1:
            dl = GoalClocks.deadlineGameTime(p, int(cfg.days))
            st.deadline = str(dl)
            st.primed = 1
        elif int(p.tickCount) % 20 != 0:
            return
        dl = _deadline_long(st.deadline)
        st.remain = GoalClocks.remainGameDays(p, dl)
        if GoalClocks.gameTimeReached(p, dl):
            st.expired = 1
            st.remain = 0

    def update_state(self, instance):
        if st.expired >= 1:
            self.fail(instance)
        elif st.primed >= 1:
            self.update_satisfied_state(instance, True)

    def localize(self, instance, locale):
        remain = int(st.remain) if st.primed >= 1 else int(cfg.days)
        return pick_locale(
            locale,
            {
                "zh_cn": f"游戏日剩余约 {remain} 天",
                "en_us": f"About {remain} game day(s) left",
            },
        )
