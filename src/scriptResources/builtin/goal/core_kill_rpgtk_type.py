'''
{
  "id": "core:kill_rpgtk_type",
  "labels": {
    "zh_cn": { "name": "击杀 RTK 实体", "description": "统计主体击杀指定实体模板 id 的次数" },
    "en_us": { "name": "Kill RTK entity", "description": "Count owner kills of a given entity template id" }
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
        "zh_cn": { "name": "实体模板", "description": "RTK 实体模板 id（EntityTemplateOrigin）" },
        "en_us": { "name": "Entity template", "description": "RTK entity template id (EntityTemplateOrigin)" }
      },
      "widget": { "editor": "suggest", "type": "entity_rpgtk_type" }
    }
  },
  "localize": {
    "zh_cn": "击杀 {target}（{have}/{count}）",
    "en_us": "Kill {target} ({have}/{count})"
  }
}
'''
# core:kill_rpgtk_type — count owner kills from a given EntityTemplate id.
LivingDeathEvent = java_type("net.neoforged.neoforge.event.entity.living.LivingDeathEvent")
ServerPlayer = java_type("net.minecraft.server.level.ServerPlayer")
EntityTemplates = java_type("mchhui.rpgtoolkit.feature.entity.EntityTemplates")
GoalLabels = java_type("mchhui.rpgtoolkit.feature.goal.GoalLabels")


@goal("core:kill_rpgtk_type")
@config(
    field("count", "int", default=1),
    field("target", "string", required=True),
)
@state(
    field("have", "int", default=0),
)
class KillRpgtkType(BaseGoalPy):
    @subscribe(LivingDeathEvent)
    def on_death(self, instance, event):
        k = event.getSource().getEntity()
        if not instanceof(k, ServerPlayer) or not instance.isOwner(k):
            return
        wanted = str(cfg.target) if cfg.target else ""
        if not wanted:
            return
        victim = event.getEntity()
        level = victim.level()
        server = level.getServer() if level is not None else None
        if server is None:
            return
        if not EntityTemplates.forServer(server).isFromTemplate(victim, wanted):
            return
        st.have += 1

    def update_state(self, instance):
        self.update_satisfied_state(instance, st.have >= cfg.count)

    def localize(self, instance, locale):
        name = GoalLabels.rpgtkTemplate(str(cfg.target) if cfg.target else "", locale)
        return pick_locale(
            locale,
            {
                "zh_cn": f"击杀 {name}（{st.have}/{cfg.count}）",
                "en_us": f"Kill {name} ({st.have}/{cfg.count})",
            },
        )
