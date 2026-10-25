'''
{
  "id": "core:xp_level_reach",
  "labels": {
    "zh_cn": { "name": "达到等级", "description": "经验等级达到或超过指定值" },
    "en_us": { "name": "Reach level", "description": "Reach or exceed a target experience level" }
  },
  "params": {
    "level": {
      "labels": {
        "zh_cn": { "name": "目标等级", "description": "需要达到的经验等级" },
        "en_us": { "name": "Target level", "description": "Experience level to reach" }
      },
      "widget": { "editor": "number" }
    }
  },
  "localize": {
    "zh_cn": "达到 {level} 级（当前 {have}）",
    "en_us": "Reach level {level} (now {have})"
  }
}
'''
# core:xp_level_reach — complete when experienceLevel >= level.
LevelChange = java_type("net.neoforged.neoforge.event.entity.player.PlayerXpEvent$LevelChange")
PlayerTickPost = java_type("net.neoforged.neoforge.event.tick.PlayerTickEvent$Post")
ServerPlayer = java_type("net.minecraft.server.level.ServerPlayer")


@goal("core:xp_level_reach")
@config(
    field("level", "int", default=30),
)
@state(
    field("have", "int", default=0),
    field("done", "int", default=0),
)
class XpLevelReach(BaseGoalPy):
    def _sample(self, player):
        st.have = int(player.experienceLevel)
        if st.have >= int(cfg.level):
            st.done = 1

    @subscribe(LevelChange)
    def on_level(self, instance, event):
        p = event.getEntity()
        if not instanceof(p, ServerPlayer) or not instance.isOwner(p) or st.done >= 1:
            return
        # Event carries the delta; projected level covers giveExperienceLevels path.
        projected = int(p.experienceLevel) + int(event.getLevels())
        st.have = max(int(p.experienceLevel), projected)
        if st.have >= int(cfg.level):
            st.done = 1

    @subscribe(PlayerTickPost)
    def on_tick(self, instance, event):
        if st.done >= 1:
            return
        p = event.getEntity()
        if not instanceof(p, ServerPlayer) or not instance.isOwner(p) or int(p.tickCount) % 20 != 0:
            return
        self._sample(p)

    def update_state(self, instance):
        if st.done >= 1:
            self.complete(instance)

    def localize(self, instance, locale):
        return pick_locale(
            locale,
            {
                "zh_cn": f"达到 {cfg.level} 级（当前 {st.have}）",
                "en_us": f"Reach level {cfg.level} (now {st.have})",
            },
        )
