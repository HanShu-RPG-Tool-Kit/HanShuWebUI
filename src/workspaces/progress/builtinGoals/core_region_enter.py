# core:region_enter — sticky satisfy on MOVE into region, or initial=satisfy when already inside.
RegionChangeEvent = java_type("mchhui.rpgtoolkit.core.region.tracking.RegionChangeEvent")
PlayerTickPost = java_type("net.neoforged.neoforge.event.tick.PlayerTickEvent$Post")
ServerPlayer = java_type("net.minecraft.server.level.ServerPlayer")
RegionTracker = java_type("mchhui.rpgtoolkit.core.region.tracking.RegionTracker")
Cause = java_type("mchhui.rpgtoolkit.core.region.tracking.RegionChange$Cause")


@goal("core:region_enter")
@config(
    field("region", "string", required=True, hint="region"),
    field("initial", "string", default="ignore", hint="enum:ignore|satisfy"),
)
@state(
    field("have", "int", default=0),
    field("inside", "int", default=0),
)
class RegionEnter(BaseGoalPy):
    def _sample(self, instance, player):
        if st.have >= 1:
            return
        tracker = RegionTracker.get(player.level().getServer())
        inside = tracker.regions(player).contains(str(cfg.region))
        st.inside = 1 if inside else 0
        if inside and str(cfg.initial) == "satisfy":
            st.have = 1

    @subscribe(RegionChangeEvent)
    def on_region(self, instance, event):
        p = event.getPlayer()
        if not instanceof(p, ServerPlayer) or not instance.isOwner(p):
            return
        region = str(cfg.region)
        entered = event.getEntered().contains(region)
        left = event.getLeft().contains(region)
        if entered:
            st.inside = 1
        elif left:
            st.inside = 0
        else:
            st.inside = 1 if event.getRegions().contains(region) else 0
        if st.have >= 1:
            return
        cause = event.getCause()
        if entered and cause == Cause.MOVE:
            st.have = 1
        elif st.inside and str(cfg.initial) == "satisfy":
            st.have = 1

    @subscribe(PlayerTickPost)
    def on_tick(self, instance, event):
        p = event.getEntity()
        if not instanceof(p, ServerPlayer) or not instance.isOwner(p) or int(p.tickCount) % 20 != 0:
            return
        self._sample(instance, p)

    def update_state(self, instance):
        self.update_satisfied_state(instance, st.have >= 1)
