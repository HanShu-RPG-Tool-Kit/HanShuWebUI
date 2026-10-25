# core:region_present — satisfied while owner is currently inside the region.
RegionChangeEvent = java_type("mchhui.rpgtoolkit.core.region.tracking.RegionChangeEvent")
PlayerTickPost = java_type("net.neoforged.neoforge.event.tick.PlayerTickEvent$Post")
ServerPlayer = java_type("net.minecraft.server.level.ServerPlayer")
RegionTracker = java_type("mchhui.rpgtoolkit.core.region.tracking.RegionTracker")


@goal("core:region_present")
@config(
    field("region", "string", required=True, hint="region"),
)
@state(
    field("have", "int", default=0),
)
class RegionPresent(BaseGoalPy):
    def _set_inside(self, inside):
        st.have = 1 if inside else 0

    @subscribe(RegionChangeEvent)
    def on_region(self, instance, event):
        p = event.getPlayer()
        if not instanceof(p, ServerPlayer) or not instance.isOwner(p):
            return
        region = str(cfg.region)
        if event.getEntered().contains(region):
            self._set_inside(True)
        elif event.getLeft().contains(region):
            self._set_inside(False)
        else:
            self._set_inside(event.getRegions().contains(region))

    @subscribe(PlayerTickPost)
    def on_tick(self, instance, event):
        p = event.getEntity()
        if not instanceof(p, ServerPlayer) or not instance.isOwner(p) or int(p.tickCount) % 20 != 0:
            return
        tracker = RegionTracker.get(p.level().getServer())
        self._set_inside(tracker.regions(p).contains(str(cfg.region)))

    def update_state(self, instance):
        self.update_satisfied_state(instance, st.have >= 1)
