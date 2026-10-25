'''
{
  "id": "core:observe_entity_mc_type",
  "labels": {
    "zh_cn": { "name": "观察生物", "description": "视线对准指定原版实体类型（不被更近的方块挡住）" },
    "en_us": { "name": "Observe entity", "description": "Look at a vanilla entity type (not blocked by a nearer block)" }
  },
  "params": {
    "target": {
      "labels": {
        "zh_cn": { "name": "实体类型", "description": "实体类型 id，如 minecraft:villager" },
        "en_us": { "name": "Entity type", "description": "Entity type id, e.g. minecraft:villager" }
      },
      "widget": { "editor": "suggest", "type": "entity_mc_type" }
    },
    "range": {
      "labels": {
        "zh_cn": { "name": "距离", "description": "射线检测距离（格）" },
        "en_us": { "name": "Range", "description": "Raycast distance in blocks" }
      },
      "widget": { "editor": "number" }
    }
  },
  "localize": {
    "zh_cn": "观察 {target}",
    "en_us": "Observe {target}"
  }
}
'''
# core:observe_entity_mc_type — complete when owner looks at the entity type.
PlayerTickPost = java_type("net.neoforged.neoforge.event.tick.PlayerTickEvent$Post")
ServerPlayer = java_type("net.minecraft.server.level.ServerPlayer")
GoalLooks = java_type("mchhui.rpgtoolkit.feature.goal.GoalLooks")
GoalLabels = java_type("mchhui.rpgtoolkit.feature.goal.GoalLabels")


@goal("core:observe_entity_mc_type")
@config(
    field("target", "string", default="minecraft:villager"),
    field("range", "double", default=5.0),
)
@state(
    field("done", "int", default=0),
)
class ObserveEntityMcType(BaseGoalPy):
    @subscribe(PlayerTickPost)
    def on_tick(self, instance, event):
        if st.done >= 1:
            return
        p = event.getEntity()
        if not instanceof(p, ServerPlayer) or not instance.isOwner(p) or int(p.tickCount) % 5 != 0:
            return
        if GoalLooks.lookingAtEntity(p, str(cfg.target) if cfg.target else "", float(cfg.range)):
            st.done = 1

    def update_state(self, instance):
        if st.done >= 1:
            self.complete(instance)

    def localize(self, instance, locale):
        name = GoalLabels.minecraftEntityType(str(cfg.target) if cfg.target else "", locale)
        return pick_locale(
            locale,
            {
                "zh_cn": f"观察 {name}",
                "en_us": f"Observe {name}",
            },
        )
