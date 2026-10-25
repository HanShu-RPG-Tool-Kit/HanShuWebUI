'''
{
  "id": "core:smith_item_mc_type",
  "labels": {
    "zh_cn": { "name": "锻造取出", "description": "从锻造台结果格取出指定原版物品" },
    "en_us": { "name": "Smith take", "description": "Take a vanilla item from a smithing table result" }
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
        "zh_cn": { "name": "物品", "description": "物品 id，如 minecraft:netherite_sword" },
        "en_us": { "name": "Item", "description": "Item id, e.g. minecraft:netherite_sword" }
      },
      "widget": { "editor": "suggest", "type": "item_mc_type" }
    }
  },
  "localize": {
    "zh_cn": "锻造 {target}（{have}/{count}）",
    "en_us": "Smith {target} ({have}/{count})"
  }
}
'''
# core:smith_item_mc_type — GoalSmithTakenEvent (mixin on SmithingMenu.onTake).
GoalSmithTakenEvent = java_type("mchhui.rpgtoolkit.feature.goal.GoalSmithTakenEvent")
GoalStacks = java_type("mchhui.rpgtoolkit.feature.goal.GoalStacks")
GoalLabels = java_type("mchhui.rpgtoolkit.feature.goal.GoalLabels")


@goal("core:smith_item_mc_type")
@config(
    field("count", "int", default=1),
    field("target", "string", default="minecraft:netherite_sword"),
)
@state(
    field("have", "int", default=0),
)
class SmithItemMcType(BaseGoalPy):
    @subscribe(GoalSmithTakenEvent)
    def on_smith(self, instance, event):
        p = event.getPlayer()
        if not instance.isOwner(p):
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
                "zh_cn": f"锻造 {name}（{st.have}/{cfg.count}）",
                "en_us": f"Smith {name} ({st.have}/{cfg.count})",
            },
        )
