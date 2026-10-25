'''
{
  "id": "core:reach_biome",
  "labels": {
    "zh_cn": { "name": "到达群系", "description": "站在指定群系中（脚下方块所在群系）" },
    "en_us": { "name": "Reach biome", "description": "Stand in the target biome (at the player's feet)" }
  },
  "params": {
    "target": {
      "labels": {
        "zh_cn": { "name": "群系", "description": "群系 id，如 minecraft:desert" },
        "en_us": { "name": "Biome", "description": "Biome id, e.g. minecraft:desert" }
      },
      "widget": { "editor": "suggest", "type": "biome_mc_type" }
    }
  },
  "localize": {
    "zh_cn": "到达 {target}",
    "en_us": "Reach {target}"
  }
}
'''
# core:reach_biome — complete when owner stands in the target biome.
PlayerTickPost = java_type("net.neoforged.neoforge.event.tick.PlayerTickEvent$Post")
ServerPlayer = java_type("net.minecraft.server.level.ServerPlayer")
GoalWorld = java_type("mchhui.rpgtoolkit.feature.goal.GoalWorld")
GoalLabels = java_type("mchhui.rpgtoolkit.feature.goal.GoalLabels")


@goal("core:reach_biome")
@config(
    field("target", "string", default="minecraft:desert"),
)
@state(
    field("done", "int", default=0),
)
class ReachBiome(BaseGoalPy):
    @subscribe(PlayerTickPost)
    def on_tick(self, instance, event):
        if st.done >= 1:
            return
        p = event.getEntity()
        if not instanceof(p, ServerPlayer) or not instance.isOwner(p) or int(p.tickCount) % 10 != 0:
            return
        if GoalWorld.inBiome(p, str(cfg.target) if cfg.target else ""):
            st.done = 1

    def update_state(self, instance):
        if st.done >= 1:
            self.complete(instance)

    def localize(self, instance, locale):
        name = GoalLabels.minecraftBiome(str(cfg.target) if cfg.target else "", locale)
        return pick_locale(
            locale,
            {
                "zh_cn": f"到达 {name}",
                "en_us": f"Reach {name}",
            },
        )
