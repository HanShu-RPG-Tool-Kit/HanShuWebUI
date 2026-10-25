'''
{
  "id": "core:fish_item_mc_type",
  "labels": {
    "zh_cn": { "name": "钓鱼获得", "description": "钓鱼收杆获得指定原版物品" },
    "en_us": { "name": "Fish item", "description": "Catch a vanilla item with a fishing rod" }
  },
  "params": {
    "count": {
      "labels": {
        "zh_cn": { "name": "数量", "description": "需要钓到的物品总数" },
        "en_us": { "name": "Count", "description": "Total items to catch" }
      },
      "widget": { "editor": "number" }
    },
    "target": {
      "labels": {
        "zh_cn": { "name": "物品", "description": "物品 id，如 minecraft:cod" },
        "en_us": { "name": "Item", "description": "Item id, e.g. minecraft:cod" }
      },
      "widget": { "editor": "suggest", "type": "item_mc_type" }
    }
  },
  "localize": {
    "zh_cn": "钓到 {target}（{have}/{count}）",
    "en_us": "Fish {target} ({have}/{count})"
  }
}
'''
# core:fish_item_mc_type — ItemFishedEvent drops (skip cancelled).
ItemFishedEvent = java_type("net.neoforged.neoforge.event.entity.player.ItemFishedEvent")
ServerPlayer = java_type("net.minecraft.server.level.ServerPlayer")
GoalStacks = java_type("mchhui.rpgtoolkit.feature.goal.GoalStacks")
GoalLabels = java_type("mchhui.rpgtoolkit.feature.goal.GoalLabels")


@goal("core:fish_item_mc_type")
@config(
    field("count", "int", default=1),
    field("target", "string", default="minecraft:cod"),
)
@state(
    field("have", "int", default=0),
)
class FishItemMcType(BaseGoalPy):
    @subscribe(ItemFishedEvent, priority="LOWEST")
    def on_fish(self, instance, event):
        if event.isCanceled():
            return
        p = event.getEntity()
        if not instanceof(p, ServerPlayer) or not instance.isOwner(p):
            return
        wanted = str(cfg.target) if cfg.target else ""
        n = 0
        for stack in event.getDrops():
            n += GoalStacks.countMc(stack, wanted)
        if n > 0:
            st.have += n

    def update_state(self, instance):
        self.update_satisfied_state(instance, st.have >= cfg.count)

    def localize(self, instance, locale):
        name = GoalLabels.minecraftItem(str(cfg.target) if cfg.target else "", locale)
        return pick_locale(
            locale,
            {
                "zh_cn": f"钓到 {name}（{st.have}/{cfg.count}）",
                "en_us": f"Fish {name} ({st.have}/{cfg.count})",
            },
        )
