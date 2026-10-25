'''
{
  "id": "core:break_block_mc_type",
  "labels": {
    "zh_cn": { "name": "挖掘方块", "description": "破坏指定原版方块类型的次数" },
    "en_us": { "name": "Break block", "description": "Count breaks of a vanilla block type" }
  },
  "params": {
    "count": {
      "labels": {
        "zh_cn": { "name": "数量", "description": "需要破坏的次数" },
        "en_us": { "name": "Count", "description": "Breaks required" }
      },
      "widget": { "editor": "number" }
    },
    "target": {
      "labels": {
        "zh_cn": { "name": "方块", "description": "方块 id，如 minecraft:stone" },
        "en_us": { "name": "Block", "description": "Block id, e.g. minecraft:stone" }
      },
      "widget": { "editor": "suggest", "type": "block_mc_type" }
    }
  },
  "localize": {
    "zh_cn": "挖掘 {target}（{have}/{count}）",
    "en_us": "Break {target} ({have}/{count})"
  }
}
'''
# core:break_block_mc_type — count BlockEvent.BreakEvent for matching block type.
BreakEvent = java_type("net.neoforged.neoforge.event.level.BlockEvent$BreakEvent")
ServerPlayer = java_type("net.minecraft.server.level.ServerPlayer")
BuiltInRegistries = java_type("net.minecraft.core.registries.BuiltInRegistries")
GoalLabels = java_type("mchhui.rpgtoolkit.feature.goal.GoalLabels")


@goal("core:break_block_mc_type")
@config(
    field("count", "int", default=1),
    field("target", "string", default="minecraft:stone"),
)
@state(
    field("have", "int", default=0),
)
class BreakBlockMcType(BaseGoalPy):
    @subscribe(BreakEvent, priority="LOWEST")
    def on_break(self, instance, event):
        if event.isCanceled():
            return
        p = event.getPlayer()
        if not instanceof(p, ServerPlayer) or not instance.isOwner(p):
            return
        wanted = str(cfg.target) if cfg.target else ""
        if not wanted:
            return
        actual = str(BuiltInRegistries.BLOCK.getKey(event.getState().getBlock()))
        if actual != wanted:
            return
        st.have += 1

    def update_state(self, instance):
        self.update_satisfied_state(instance, st.have >= cfg.count)

    def localize(self, instance, locale):
        name = GoalLabels.minecraftBlock(str(cfg.target) if cfg.target else "", locale)
        return pick_locale(
            locale,
            {
                "zh_cn": f"挖掘 {name}（{st.have}/{cfg.count}）",
                "en_us": f"Break {name} ({st.have}/{cfg.count})",
            },
        )
