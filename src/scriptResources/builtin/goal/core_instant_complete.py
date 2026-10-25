'''
{
  "id": "core:instant_complete",
  "labels": {
    "zh_cn": { "name": "立即完成", "description": "创建后下一 tick 即结算为已完成" },
    "en_us": { "name": "Instant complete", "description": "Completes on the next tick after create" }
  },
  "params": {},
  "localize": {
    "zh_cn": "已完成",
    "en_us": "Done"
  }
}
'''
# core:instant_complete — no config; first owner tick marks done → COMPLETED.
PlayerTickPost = java_type("net.neoforged.neoforge.event.tick.PlayerTickEvent$Post")
ServerPlayer = java_type("net.minecraft.server.level.ServerPlayer")


@goal("core:instant_complete")
@config()
@state(
    field("done", "int", default=0),
)
class InstantComplete(BaseGoalPy):
    @subscribe(PlayerTickPost)
    def on_tick(self, instance, event):
        if st.done >= 1:
            return
        p = event.getEntity()
        if not instanceof(p, ServerPlayer) or not instance.isOwner(p):
            return
        st.done = 1

    def update_state(self, instance):
        if st.done >= 1:
            self.complete(instance)

    def localize(self, instance, locale):
        return pick_locale(
            locale,
            {
                "zh_cn": "已完成",
                "en_us": "Done",
            },
        )
