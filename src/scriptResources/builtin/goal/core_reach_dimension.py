'''
{
  "id": "core:reach_dimension",
  "labels": {
    "zh_cn": { "name": "到达维度", "description": "进入指定维度（已在其中也会满足）" },
    "en_us": { "name": "Reach dimension", "description": "Enter the target dimension (also ok if already there)" }
  },
  "params": {
    "target": {
      "labels": {
        "zh_cn": { "name": "维度", "description": "维度 id，如 minecraft:the_nether" },
        "en_us": { "name": "Dimension", "description": "Dimension id, e.g. minecraft:the_nether" }
      },
      "widget": { "editor": "suggest", "type": "dimension_mc_type" }
    }
  },
  "localize": {
    "zh_cn": "到达 {target}",
    "en_us": "Reach {target}"
  }
}
'''
# core:reach_dimension — complete when owner is in the target dimension.
PlayerChangedDimension = java_type(
    "net.neoforged.neoforge.event.entity.player.PlayerEvent$PlayerChangedDimensionEvent"
)
PlayerTickPost = java_type("net.neoforged.neoforge.event.tick.PlayerTickEvent$Post")
ServerPlayer = java_type("net.minecraft.server.level.ServerPlayer")
GoalWorld = java_type("mchhui.rpgtoolkit.feature.goal.GoalWorld")
GoalLabels = java_type("mchhui.rpgtoolkit.feature.goal.GoalLabels")


@goal("core:reach_dimension")
@config(
    field("target", "string", default="minecraft:the_nether"),
)
@state(
    field("done", "int", default=0),
)
class ReachDimension(BaseGoalPy):
    @subscribe(PlayerChangedDimension)
    def on_dim(self, instance, event):
        p = event.getEntity()
        if not instanceof(p, ServerPlayer) or not instance.isOwner(p) or st.done >= 1:
            return
        wanted = str(cfg.target) if cfg.target else ""
        to_id = str(event.getTo().identifier())
        if wanted and to_id == wanted:
            st.done = 1

    @subscribe(PlayerTickPost)
    def on_tick(self, instance, event):
        if st.done >= 1:
            return
        p = event.getEntity()
        if not instanceof(p, ServerPlayer) or not instance.isOwner(p) or int(p.tickCount) % 20 != 0:
            return
        if GoalWorld.inDimension(p, str(cfg.target) if cfg.target else ""):
            st.done = 1

    def update_state(self, instance):
        if st.done >= 1:
            self.complete(instance)

    def localize(self, instance, locale):
        name = GoalLabels.minecraftDimension(str(cfg.target) if cfg.target else "", locale)
        return pick_locale(
            locale,
            {
                "zh_cn": f"到达 {name}",
                "en_us": f"Reach {name}",
            },
        )
