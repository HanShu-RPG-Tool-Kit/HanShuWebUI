# core:kill — count owner kills of a target entity type.
LivingDeathEvent = java_type("net.neoforged.neoforge.event.entity.living.LivingDeathEvent")
ServerPlayer = java_type("net.minecraft.server.level.ServerPlayer")
BuiltInRegistries = java_type("net.minecraft.core.registries.BuiltInRegistries")


@goal("core:kill")
@config(
    field("count", "int", default=1),
    field("target", "string", default="minecraft:zombie", hint="entity_type"),
)
@state(
    field("have", "int", default=0),
)
class Kill(BaseGoalPy):
    @subscribe(LivingDeathEvent)
    def on_death(self, instance, event):
        k = event.getSource().getEntity()
        t = str(BuiltInRegistries.ENTITY_TYPE.getKey(event.getEntity().getType()))
        if not instanceof(k, ServerPlayer) or not instance.isOwner(k) or (cfg.target and cfg.target != t):
            return
        st.have += 1

    def update_state(self, instance):
        self.update_satisfied_state(instance, st.have >= cfg.count)
