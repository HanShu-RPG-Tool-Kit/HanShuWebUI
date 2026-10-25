'''
{
  "id": "core:xp_gain",
  "labels": {
    "zh_cn": { "name": "获取经验", "description": "累计获得指定点数的经验（仅正数增量）" },
    "en_us": { "name": "Gain XP", "description": "Accumulate experience points gained (positive only)" }
  },
  "params": {
    "count": {
      "labels": {
        "zh_cn": { "name": "经验点", "description": "需要累计获得的经验点" },
        "en_us": { "name": "XP points", "description": "Experience points to gain" }
      },
      "widget": { "editor": "number" }
    }
  },
  "localize": {
    "zh_cn": "获取经验（{have}/{count}）",
    "en_us": "Gain XP ({have}/{count})"
  }
}
'''
# core:xp_gain — accumulate PlayerXpEvent.XpChange positive amounts.
XpChange = java_type("net.neoforged.neoforge.event.entity.player.PlayerXpEvent$XpChange")
ServerPlayer = java_type("net.minecraft.server.level.ServerPlayer")


@goal("core:xp_gain")
@config(
    field("count", "int", default=100),
)
@state(
    field("have", "int", default=0),
)
class XpGain(BaseGoalPy):
    @subscribe(XpChange)
    def on_xp(self, instance, event):
        p = event.getEntity()
        if not instanceof(p, ServerPlayer) or not instance.isOwner(p):
            return
        amount = int(event.getAmount())
        if amount > 0:
            st.have += amount

    def update_state(self, instance):
        self.update_satisfied_state(instance, st.have >= cfg.count)

    def localize(self, instance, locale):
        return pick_locale(
            locale,
            {
                "zh_cn": f"获取经验（{st.have}/{cfg.count}）",
                "en_us": f"Gain XP ({st.have}/{cfg.count})",
            },
        )
