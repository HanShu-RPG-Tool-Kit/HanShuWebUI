'''
{
  "id": "core:smelt_item_mc_type",
  "labels": {
    "zh_cn": { "name": "熔炼取出", "description": "从熔炉类结果格取出指定原版物品" },
    "en_us": { "name": "Smelt take", "description": "Take a vanilla item from a furnace-like result slot" }
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
        "zh_cn": { "name": "物品", "description": "物品 id，如 minecraft:iron_ingot" },
        "en_us": { "name": "Item", "description": "Item id, e.g. minecraft:iron_ingot" }
      },
      "widget": { "editor": "suggest", "type": "item_mc_type" }
    }
  },
  "localize": {
    "zh_cn": "熔炼取出 {target}（{have}/{count}）",
    "en_us": "Take smelted {target} ({have}/{count})"
  }
}
'''
# core:smelt_item_mc_type — PlayerEvent.ItemSmeltedEvent (amountRemoved is authoritative).
ItemSmeltedEvent = java_type(
    "net.neoforged.neoforge.event.entity.player.PlayerEvent$ItemSmeltedEvent"
)
ServerPlayer = java_type("net.minecraft.server.level.ServerPlayer")
GoalStacks = java_type("mchhui.rpgtoolkit.feature.goal.GoalStacks")
GoalLabels = java_type("mchhui.rpgtoolkit.feature.goal.GoalLabels")


@goal("core:smelt_item_mc_type")
@config(
    field("count", "int", default=1),
    field("target", "string", default="minecraft:iron_ingot"),
)
@state(
    field("have", "int", default=0),
)
class SmeltItemMcType(BaseGoalPy):
    @subscribe(ItemSmeltedEvent)
    def on_smelt(self, instance, event):
        p = event.getEntity()
        if not instanceof(p, ServerPlayer) or not instance.isOwner(p):
            return
        if not GoalStacks.isMc(event.getSmelting(), str(cfg.target) if cfg.target else ""):
            return
        n = int(event.getAmountRemoved())
        if n > 0:
            st.have += n

    def update_state(self, instance):
        self.update_satisfied_state(instance, st.have >= cfg.count)

    def localize(self, instance, locale):
        name = GoalLabels.minecraftItem(str(cfg.target) if cfg.target else "", locale)
        return pick_locale(
            locale,
            {
                "zh_cn": f"熔炼取出 {name}（{st.have}/{cfg.count}）",
                "en_us": f"Take smelted {name} ({st.have}/{cfg.count})",
            },
        )
