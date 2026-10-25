'''
{
  "id": "core:reach_structure",
  "labels": {
    "zh_cn": { "name": "到达结构", "description": "站在指定结构的生成范围内（含结构件）" },
    "en_us": { "name": "Reach structure", "description": "Stand inside a generated structure (with pieces)" }
  },
  "params": {
    "target": {
      "labels": {
        "zh_cn": { "name": "结构", "description": "结构 id，如 minecraft:village_plains" },
        "en_us": { "name": "Structure", "description": "Structure id, e.g. minecraft:village_plains" }
      },
      "widget": { "editor": "suggest", "type": "structure_mc_type" }
    }
  },
  "localize": {
    "zh_cn": "到达 {target}",
    "en_us": "Reach {target}"
  }
}
'''
# core:reach_structure — complete when owner is inside the named structure start.
PlayerTickPost = java_type("net.neoforged.neoforge.event.tick.PlayerTickEvent$Post")
ServerPlayer = java_type("net.minecraft.server.level.ServerPlayer")
GoalWorld = java_type("mchhui.rpgtoolkit.feature.goal.GoalWorld")
GoalLabels = java_type("mchhui.rpgtoolkit.feature.goal.GoalLabels")


@goal("core:reach_structure")
@config(
    field("target", "string", default="minecraft:village_plains"),
)
@state(
    field("done", "int", default=0),
)
class ReachStructure(BaseGoalPy):
    @subscribe(PlayerTickPost)
    def on_tick(self, instance, event):
        if st.done >= 1:
            return
        p = event.getEntity()
        if not instanceof(p, ServerPlayer) or not instance.isOwner(p) or int(p.tickCount) % 20 != 0:
            return
        if GoalWorld.inStructure(p, str(cfg.target) if cfg.target else ""):
            st.done = 1

    def update_state(self, instance):
        if st.done >= 1:
            self.complete(instance)

    def localize(self, instance, locale):
        name = GoalLabels.minecraftStructure(str(cfg.target) if cfg.target else "", locale)
        return pick_locale(
            locale,
            {
                "zh_cn": f"到达 {name}",
                "en_us": f"Reach {name}",
            },
        )
