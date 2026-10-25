'''
{
  "id": "core:dialog",
  "labels": {
    "zh_cn": { "name": "对话注入点", "description": "Talk 越过指定 @inject 后满足（与读过标记同时机）" },
    "en_us": { "name": "Talk inject", "description": "Satisfy when Talk visits an @inject (same moment as read flag)" }
  },
  "params": {
    "inject": {
      "labels": {
        "zh_cn": { "name": "注入点", "description": "全局 @inject id" },
        "en_us": { "name": "Inject", "description": "Global @inject id" }
      },
      "widget": { "editor": "suggest", "type": "talk_inject" }
    }
  },
  "localize": {
    "zh_cn": "对话 @{inject}",
    "en_us": "Talk @{inject}"
  }
}
'''
# core:dialog — sticky satisfy when Talk visits cfg.inject (same timing as TalkReads.markRead).
PlayerTalkInjectEvent = java_type("mchhui.rpgtoolkit.feature.talk.PlayerTalkInjectEvent")
PlayerTickPost = java_type("net.neoforged.neoforge.event.tick.PlayerTickEvent$Post")
ServerPlayer = java_type("net.minecraft.server.level.ServerPlayer")
TalkReads = java_type("mchhui.rpgtoolkit.feature.talk.TalkReads")


@goal("core:dialog")
@config(
    field("inject", "string", required=True),
)
@state(
    field("have", "int", default=0),
)
class Dialog(BaseGoalPy):
    @subscribe(PlayerTalkInjectEvent)
    def on_inject(self, instance, event):
        p = event.getPlayer()
        if not instanceof(p, ServerPlayer) or not instance.isOwner(p):
            return
        if str(cfg.inject) != str(event.getInject()):
            return
        st.have = 1

    @subscribe(PlayerTickPost)
    def on_tick(self, instance, event):
        # Catch injects already marked read before this goal was created.
        if st.have >= 1:
            return
        p = event.getEntity()
        if not instanceof(p, ServerPlayer) or not instance.isOwner(p) or int(p.tickCount) % 20 != 0:
            return
        if TalkReads.isRead(p.level().getServer(), p.getUUID(), str(cfg.inject)):
            st.have = 1

    def update_state(self, instance):
        self.update_satisfied_state(instance, st.have >= 1)

    def localize(self, instance, locale):
        return pick_locale(
            locale,
            {
                "zh_cn": f"对话 @{cfg.inject}",
                "en_us": f"Talk @{cfg.inject}",
            },
        )
