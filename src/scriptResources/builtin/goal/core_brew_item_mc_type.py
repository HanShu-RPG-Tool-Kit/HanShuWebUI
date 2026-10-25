'''
{
  "id": "core:brew_item_mc_type",
  "labels": {
    "zh_cn": { "name": "炼药取出", "description": "从酿造台取出带药水成分的物品（按物品 id）" },
    "en_us": { "name": "Brew take", "description": "Take a potion-bearing item from a brewing stand (by item id)" }
  },
  "params": {
    "count": {
      "labels": {
        "zh_cn": { "name": "数量", "description": "需要取出的次数／数量" },
        "en_us": { "name": "Count", "description": "Takes / items required" }
      },
      "widget": { "editor": "number" }
    },
    "target": {
      "labels": {
        "zh_cn": { "name": "物品", "description": "物品 id，如 minecraft:potion / splash_potion / lingering_potion" },
        "en_us": { "name": "Item", "description": "Item id, e.g. minecraft:potion / splash_potion / lingering_potion" }
      },
      "widget": { "editor": "suggest", "type": "item_mc_type" }
    }
  },
  "localize": {
    "zh_cn": "炼药取出 {target}（{have}/{count}）",
    "en_us": "Brew take {target} ({have}/{count})"
  }
}
'''
# core:brew_item_mc_type — NeoForge PlayerBrewedPotionEvent (stand bottle onTake).
PlayerBrewedPotionEvent = java_type(
    "net.neoforged.neoforge.event.brewing.PlayerBrewedPotionEvent"
)
ServerPlayer = java_type("net.minecraft.server.level.ServerPlayer")
GoalStacks = java_type("mchhui.rpgtoolkit.feature.goal.GoalStacks")
GoalLabels = java_type("mchhui.rpgtoolkit.feature.goal.GoalLabels")


@goal("core:brew_item_mc_type")
@config(
    field("count", "int", default=1),
    field("target", "string", default="minecraft:potion"),
)
@state(
    field("have", "int", default=0),
)
class BrewItemMcType(BaseGoalPy):
    @subscribe(PlayerBrewedPotionEvent)
    def on_brew(self, instance, event):
        p = event.getEntity()
        if not instanceof(p, ServerPlayer) or not instance.isOwner(p):
            return
        n = GoalStacks.countMc(event.getStack(), str(cfg.target) if cfg.target else "")
        if n > 0:
            st.have += n

    def update_state(self, instance):
        self.update_satisfied_state(instance, st.have >= cfg.count)

    def localize(self, instance, locale):
        name = GoalLabels.minecraftItem(str(cfg.target) if cfg.target else "", locale)
        return pick_locale(
            locale,
            {
                "zh_cn": f"炼药取出 {name}（{st.have}/{cfg.count}）",
                "en_us": f"Brew take {name} ({st.have}/{cfg.count})",
            },
        )
