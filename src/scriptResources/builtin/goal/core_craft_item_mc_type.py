'''
{
  "id": "core:craft_item_mc_type",
  "labels": {
    "zh_cn": { "name": "合成物品", "description": "从合成结果格取出指定原版物品" },
    "en_us": { "name": "Craft item", "description": "Take a vanilla item from a crafting result slot" }
  },
  "params": {
    "count": {
      "labels": {
        "zh_cn": { "name": "数量", "description": "需要取出的物品总数" },
        "en_us": { "name": "Count", "description": "Total items to take" }
      },
      "widget": { "editor": "number" }
    },
    "target": {
      "labels": {
        "zh_cn": { "name": "物品", "description": "物品 id，如 minecraft:stick" },
        "en_us": { "name": "Item", "description": "Item id, e.g. minecraft:stick" }
      },
      "widget": { "editor": "suggest", "type": "item_mc_type" }
    }
  },
  "localize": {
    "zh_cn": "合成 {target}（{have}/{count}）",
    "en_us": "Craft {target} ({have}/{count})"
  }
}
'''
# core:craft_item_mc_type — PlayerEvent.ItemCraftedEvent (crafting table / 2x2 result).
ItemCraftedEvent = java_type(
    "net.neoforged.neoforge.event.entity.player.PlayerEvent$ItemCraftedEvent"
)
ServerPlayer = java_type("net.minecraft.server.level.ServerPlayer")
GoalStacks = java_type("mchhui.rpgtoolkit.feature.goal.GoalStacks")
GoalLabels = java_type("mchhui.rpgtoolkit.feature.goal.GoalLabels")


@goal("core:craft_item_mc_type")
@config(
    field("count", "int", default=1),
    field("target", "string", default="minecraft:stick"),
)
@state(
    field("have", "int", default=0),
)
class CraftItemMcType(BaseGoalPy):
    @subscribe(ItemCraftedEvent)
    def on_craft(self, instance, event):
        p = event.getEntity()
        if not instanceof(p, ServerPlayer) or not instance.isOwner(p):
            return
        n = GoalStacks.countMc(event.getCrafting(), str(cfg.target) if cfg.target else "")
        if n > 0:
            st.have += n

    def update_state(self, instance):
        self.update_satisfied_state(instance, st.have >= cfg.count)

    def localize(self, instance, locale):
        name = GoalLabels.minecraftItem(str(cfg.target) if cfg.target else "", locale)
        return pick_locale(
            locale,
            {
                "zh_cn": f"合成 {name}（{st.have}/{cfg.count}）",
                "en_us": f"Craft {name} ({st.have}/{cfg.count})",
            },
        )
