'''
{
  "id": "core:kill_mc_type",
  "labels": {
    "zh_cn": { "name": "击杀实体类型", "description": "统计主体击杀指定原版实体类型的次数" },
    "en_us": { "name": "Kill entity type", "description": "Count owner kills of a vanilla entity type" }
  },
  "params": {
    "count": {
      "labels": {
        "zh_cn": { "name": "数量", "description": "需要击杀的次数" },
        "en_us": { "name": "Count", "description": "Kills required" }
      },
      "widget": { "editor": "number" }
    },
    "target": {
      "labels": {
        "zh_cn": { "name": "实体类型", "description": "原版实体类型 id，如 minecraft:zombie" },
        "en_us": { "name": "Entity type", "description": "Vanilla entity type id, e.g. minecraft:zombie" }
      },
      "widget": { "editor": "suggest", "type": "entity_mc_type" }
    }
  },
  "localize": {
    "zh_cn": "击杀 {target}（{have}/{count}）",
    "en_us": "Kill {target} ({have}/{count})"
  }
}
'''
# core:kill_mc_type — count owner kills matching a vanilla entity type id.
LivingDeathEvent = java_type("net.neoforged.neoforge.event.entity.living.LivingDeathEvent")
ServerPlayer = java_type("net.minecraft.server.level.ServerPlayer")
BuiltInRegistries = java_type("net.minecraft.core.registries.BuiltInRegistries")
GoalLabels = java_type("mchhui.rpgtoolkit.feature.goal.GoalLabels")


@goal("core:kill_mc_type")
@config(
    field("count", "int", default=1),
    field("target", "string", default="minecraft:zombie"),
)
@state(
    field("have", "int", default=0),
)
class KillMcType(BaseGoalPy):
    @subscribe(LivingDeathEvent)
    def on_death(self, instance, event):
        k = event.getSource().getEntity()
        if not instanceof(k, ServerPlayer) or not instance.isOwner(k):
            return
        wanted = str(cfg.target) if cfg.target else ""
        if not wanted:
            return
        actual = str(BuiltInRegistries.ENTITY_TYPE.getKey(event.getEntity().getType()))
        if actual != wanted:
            return
        st.have += 1

    def update_state(self, instance):
        self.update_satisfied_state(instance, st.have >= cfg.count)

    def localize(self, instance, locale):
        name = GoalLabels.minecraftEntityType(str(cfg.target) if cfg.target else "", locale)
        return pick_locale(
            locale,
            {
                "zh_cn": f"击杀 {name}（{st.have}/{cfg.count}）",
                "en_us": f"Kill {name} ({st.have}/{cfg.count})",
            },
        )
