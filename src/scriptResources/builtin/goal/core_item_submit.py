# core:item_submit — satisfy when owner successfully delivers matching items via core.inventory.
PlayerDeliveredEvent = java_type("mchhui.rpgtoolkit.core.inventory.PlayerDeliveredEvent")
ServerPlayer = java_type("net.minecraft.server.level.ServerPlayer")


@goal("core:item_submit")
@config(
    field("count", "int", default=1),
    field("item", "string", default="minecraft:wheat", hint="item"),
    field("context", "string", default="", hint="deliver_context"),
)
@state(
    field("have", "int", default=0),
)
class ItemSubmit(BaseGoalPy):
    @subscribe(PlayerDeliveredEvent)
    def on_delivered(self, instance, event):
        p = event.getPlayer()
        if not instanceof(p, ServerPlayer) or not instance.isOwner(p):
            return
        wanted_ctx = str(cfg.context) if cfg.context else ""
        if wanted_ctx:
            actual_ctx = str(event.getContext())
            if actual_ctx != wanted_ctx and not actual_ctx.startswith(wanted_ctx):
                return
        taken = 0
        for line in event.getItems():
            if str(line.itemId()) == str(cfg.item):
                taken += int(line.count())
        if taken <= 0:
            return
        st.have = min(int(st.have) + taken, int(cfg.count))

    def update_state(self, instance):
        self.update_satisfied_state(instance, st.have >= cfg.count)
