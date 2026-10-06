# core:item_collect — accumulate pickups of an item id.
ItemPickupPost = java_type("net.neoforged.neoforge.event.entity.player.ItemEntityPickupEvent$Post")
ServerPlayer = java_type("net.minecraft.server.level.ServerPlayer")
BuiltInRegistries = java_type("net.minecraft.core.registries.BuiltInRegistries")


@goal("core:item_collect")
@config(
    field("count", "int", default=1),
    field("item", "string", default="minecraft:wheat", hint="item"),
)
@state(
    field("have", "int", default=0),
)
class ItemCollect(BaseGoalPy):
    @subscribe(ItemPickupPost)
    def on_pickup(self, instance, event):
        p = event.getPlayer()
        if not instanceof(p, ServerPlayer) or not instance.isOwner(p):
            return
        item_id = str(BuiltInRegistries.ITEM.getKey(event.getOriginalStack().getItem()))
        if cfg.item and cfg.item != item_id:
            return
        taken = int(event.getOriginalStack().getCount()) - int(event.getCurrentStack().getCount())
        if taken > 0:
            st.have += taken

    def update_state(self, instance):
        self.update_satisfied_state(instance, st.have >= cfg.count)
