'''
{
  "id": "core:item_rpgtk_type_max",
  "labels": {
    "zh_cn": { "name": "最大收集（RTK 物品）", "description": "背包中指定物品模板数量达到要求即完成" },
    "en_us": { "name": "Max collect (RTK item)", "description": "Complete when the player holds enough of an item template" }
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
        "zh_cn": { "name": "物品模板", "description": "RTK 物品模板 id" },
        "en_us": { "name": "Item template", "description": "RTK item template id" }
      },
      "widget": { "editor": "suggest", "type": "item_rpgtk_type" }
    }
  },
  "localize": {
    "zh_cn": "持有 {target}（{have}/{count}）",
    "en_us": "Hold {target} ({have}/{count})"
  }
}
'''
# core:item_rpgtk_type_max — complete when template-bound count >= count (no consume).
PlayerTickPost = java_type("net.neoforged.neoforge.event.tick.PlayerTickEvent$Post")
ServerPlayer = java_type("net.minecraft.server.level.ServerPlayer")
GoalItems = java_type("mchhui.rpgtoolkit.feature.goal.GoalItems")
GoalLabels = java_type("mchhui.rpgtoolkit.feature.goal.GoalLabels")


@goal("core:item_rpgtk_type_max")
@config(
    field("count", "int", default=1),
    field("target", "string", required=True),
)
@state(
    field("have", "int", default=0),
)
class ItemRpgtkTypeMax(BaseGoalPy):
    @subscribe(PlayerTickPost)
    def on_tick(self, instance, event):
        p = event.getEntity()
        if not instanceof(p, ServerPlayer) or not instance.isOwner(p) or int(p.tickCount) % 10 != 0:
            return
        st.have = GoalItems.countRpgtk(p, str(cfg.target) if cfg.target else "")

    def update_state(self, instance):
        if st.have >= cfg.count:
            self.complete(instance)

    def localize(self, instance, locale):
        name = GoalLabels.rpgtkItemTemplate(str(cfg.target) if cfg.target else "", locale)
        return pick_locale(
            locale,
            {
                "zh_cn": f"持有 {name}（{st.have}/{cfg.count}）",
                "en_us": f"Hold {name} ({st.have}/{cfg.count})",
            },
        )
