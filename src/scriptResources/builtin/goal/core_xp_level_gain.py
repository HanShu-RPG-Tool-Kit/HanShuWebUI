'''
{
  "id": "core:xp_level_gain",
  "labels": {
    "zh_cn": { "name": "升级等级数", "description": "累计提升指定数量的经验等级（仅正数增量）" },
    "en_us": { "name": "Gain levels", "description": "Accumulate experience levels gained (positive only)" }
  },
  "params": {
    "count": {
      "labels": {
        "zh_cn": { "name": "等级数", "description": "需要累计提升的等级" },
        "en_us": { "name": "Levels", "description": "Levels to gain" }
      },
      "widget": { "editor": "number" }
    }
  },
  "localize": {
    "zh_cn": "升级（{have}/{count}）",
    "en_us": "Gain levels ({have}/{count})"
  }
}
'''
# core:xp_level_gain — accumulate PlayerXpEvent.LevelChange positive deltas.
LevelChange = java_type("net.neoforged.neoforge.event.entity.player.PlayerXpEvent$LevelChange")
ServerPlayer = java_type("net.minecraft.server.level.ServerPlayer")


@goal("core:xp_level_gain")
@config(
    field("count", "int", default=1),
)
@state(
    field("have", "int", default=0),
)
class XpLevelGain(BaseGoalPy):
    @subscribe(LevelChange)
    def on_level(self, instance, event):
        p = event.getEntity()
        if not instanceof(p, ServerPlayer) or not instance.isOwner(p):
            return
        delta = int(event.getLevels())
        if delta > 0:
            st.have += delta

    def update_state(self, instance):
        self.update_satisfied_state(instance, st.have >= cfg.count)

    def localize(self, instance, locale):
        return pick_locale(
            locale,
            {
                "zh_cn": f"升级（{st.have}/{cfg.count}）",
                "en_us": f"Gain levels ({st.have}/{cfg.count})",
            },
        )
