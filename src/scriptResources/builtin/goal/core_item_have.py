# core:item_have — satisfied while owner holds enough of an item (main inventory).
PlayerTickPost = java_type("net.neoforged.neoforge.event.tick.PlayerTickEvent$Post")
ServerPlayer = java_type("net.minecraft.server.level.ServerPlayer")
BuiltInRegistries = java_type("net.minecraft.core.registries.BuiltInRegistries")
Identifier = java_type("net.minecraft.resources.Identifier")
ItemStack = java_type("net.minecraft.world.item.ItemStack")

MAIN_SLOTS = 36


@goal("core:item_have")
@config(
    field("count", "int", default=1),
    field("item", "string", default="minecraft:wheat", hint="item"),
)
@state(
    field("have", "int", default=0),
)
class ItemHave(BaseGoalPy):
    @subscribe(PlayerTickPost)
    def on_tick(self, instance, event):
        p = event.getEntity()
        if not instanceof(p, ServerPlayer) or not instance.isOwner(p) or int(p.tickCount) % 5 != 0:
            return
        key = Identifier.tryParse(str(cfg.item))
        if key is None:
            st.have = 0
            return
        sample = ItemStack(BuiltInRegistries.ITEM.getValue(key))
        if sample.isEmpty():
            st.have = 0
            return
        n = 0
        inv = p.getInventory()
        for slot in range(MAIN_SLOTS):
            stack = inv.getItem(slot)
            if ItemStack.isSameItemSameComponents(stack, sample):
                n += int(stack.getCount())
        st.have = n

    def update_state(self, instance):
        self.update_satisfied_state(instance, st.have >= cfg.count)
