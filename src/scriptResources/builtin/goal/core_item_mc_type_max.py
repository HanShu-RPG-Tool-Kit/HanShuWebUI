'''
{
  "id": "core:item_mc_type_max",
  "labels": {
    "zh_cn": { "name": "最大收集（MC 物品）", "description": "背包中指定原版物品数量达到要求即完成" },
    "en_us": { "name": "Max collect (MC item)", "description": "Complete when the player holds enough of a vanilla item" }
  },
  "params": {
    "count": {
      "labels": {
        "zh_cn": { "name": "数量", "description": "需要持有的数量" },
        "en_us": { "name": "Count", "description": "Required amount" }
      },
      "widget": { "editor": "number" }
    },
    "target": {
      "labels": {
        "zh_cn": { "name": "物品", "description": "原版物品 id，如 minecraft:diamond" },
        "en_us": { "name": "Item", "description": "Vanilla item id, e.g. minecraft:diamond" }
      },
      "widget": { "editor": "suggest", "type": "item_mc_type" }
    }
  },
  "localize": {
    "zh_cn": "持有 {target}（{have}/{count}）",
    "en_us": "Hold {target} ({have}/{count})"
  }
}
'''
# core:item_mc_type_max — complete when inventory count >= count (no consume).
PlayerTickPost = java_type("net.neoforged.neoforge.event.tick.PlayerTickEvent$Post")
ServerPlayer = java_type("net.minecraft.server.level.ServerPlayer")
GoalItems = java_type("mchhui.rpgtoolkit.feature.goal.GoalItems")
GoalLabels = java_type("mchhui.rpgtoolkit.feature.goal.GoalLabels")


@goal("core:item_mc_type_max")
@config(
    field("count", "int", default=1),
    field("target", "string", default="minecraft:diamond"),
)
@state(
    field("have", "int", default=0),
)
class ItemMcTypeMax(BaseGoalPy):
    @subscribe(PlayerTickPost)
    def on_tick(self, instance, event):
        p = event.getEntity()
        if not instanceof(p, ServerPlayer) or not instance.isOwner(p) or int(p.tickCount) % 10 != 0:
            return
        st.have = GoalItems.countMc(p, str(cfg.target) if cfg.target else "")

    def update_state(self, instance):
        if st.have >= cfg.count:
            self.complete(instance)

    def localize(self, instance, locale):
        name = GoalLabels.minecraftItem(str(cfg.target) if cfg.target else "", locale)
        return pick_locale(
            locale,
            {
                "zh_cn": f"持有 {name}（{st.have}/{cfg.count}）",
                "en_us": f"Hold {name} ({st.have}/{cfg.count})",
            },
        )
