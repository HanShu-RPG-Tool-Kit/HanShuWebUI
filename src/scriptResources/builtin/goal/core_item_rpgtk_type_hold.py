'''
{
  "id": "core:item_rpgtk_type_hold",
  "labels": {
    "zh_cn": { "name": "持有（RTK 物品）", "description": "数量足够即为已满足；扣除仅在进度交付时发生" },
    "en_us": { "name": "Hold (RTK item)", "description": "Enough → SATISFIED; take only on progress deliver" }
  },
  "params": {
    "count": {
      "labels": {
        "zh_cn": { "name": "数量", "description": "需要持有／扣除的数量" },
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
    },
    "consume": {
      "labels": {
        "zh_cn": { "name": "消耗", "description": "交付时是否从背包扣除" },
        "en_us": { "name": "Consume", "description": "Whether deliver removes items from inventory" }
      }
    }
  },
  "localize": {
    "zh_cn": "持有 {target}（{have}/{count}）",
    "en_us": "Hold {target} ({have}/{count})"
  }
}
'''
# core:item_rpgtk_type_hold — track only; side effects in deliver().
PlayerTickPost = java_type("net.neoforged.neoforge.event.tick.PlayerTickEvent$Post")
ServerPlayer = java_type("net.minecraft.server.level.ServerPlayer")
GoalItems = java_type("mchhui.rpgtoolkit.feature.goal.GoalItems")
GoalLabels = java_type("mchhui.rpgtoolkit.feature.goal.GoalLabels")


@goal("core:item_rpgtk_type_hold")
@config(
    field("count", "int", default=1),
    field("target", "string", required=True),
    field("consume", "bool", default=True),
)
@state(
    field("have", "int", default=0),
    field("delivered", "int", default=0),
)
class ItemRpgtkTypeHold(BaseGoalPy):
    @subscribe(PlayerTickPost)
    def on_tick(self, instance, event):
        p = event.getEntity()
        if not instanceof(p, ServerPlayer) or not instance.isOwner(p) or int(p.tickCount) % 10 != 0:
            return
        st.have = GoalItems.countRpgtk(p, str(cfg.target) if cfg.target else "")

    def update_state(self, instance):
        self.update_satisfied_state(instance, st.have >= cfg.count)

    def deliver(self, instance, context):
        if st.delivered >= 1:
            return True
        if not bool(cfg.consume):
            st.delivered = 1
            return True
        actor = context.actor() if context is not None else None
        if not instanceof(actor, ServerPlayer):
            return False
        target = str(cfg.target) if cfg.target else ""
        if not GoalItems.takeRpgtk(actor, target, int(cfg.count)):
            return False
        st.have = GoalItems.countRpgtk(actor, target)
        st.delivered = 1
        return True

    def localize(self, instance, locale):
        name = GoalLabels.rpgtkItemTemplate(str(cfg.target) if cfg.target else "", locale)
        return pick_locale(
            locale,
            {
                "zh_cn": f"持有 {name}（{st.have}/{cfg.count}）",
                "en_us": f"Hold {name} ({st.have}/{cfg.count})",
            },
        )
