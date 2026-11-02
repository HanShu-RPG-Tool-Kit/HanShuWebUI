/*
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
*/

import LivingDeathEvent from "net.neoforged.neoforge.event.entity.living.LivingDeathEvent"
import ServerPlayer from "net.minecraft.server.level.ServerPlayer"
import BuiltInRegistries from "net.minecraft.core.registries.BuiltInRegistries"
import GoalLabels from "mchhui.rpgtoolkit.feature.goal.GoalLabels"
import GoalInstance from "mchhui.rpgtoolkit.feature.goal.GoalInstance"

@goal("core:kill_mc_type")
@config(field("count", "int", 1), field("target", "string", "minecraft:zombie"))
@state(field("have", "int", 0))

@subscribe(LivingDeathEvent, {priority: "NORMAL", receiveCancelled: false})
function on_event(instance: GoalInstance, event: LivingDeathEvent): void {
    var k = event.getSource().getEntity();
    if ((!((k instanceof ServerPlayer)) || !(instance.isOwner(k)))) {
        return;
    }
    var wanted = (cfg.target ? String(cfg.target) : "");
    if (!(wanted)) {
        return;
    }
    var actual = String(BuiltInRegistries.ENTITY_TYPE.getKey(event.getEntity().getType()));
    if ((actual !== wanted)) {
        return;
    }
    st.have += 1;
}

function update_state(instance: GoalInstance): void {
    update_satisfied_state(instance, (st.have >= cfg.count));
}

function localize(instance: GoalInstance, locale: string): string {
    var name = GoalLabels.minecraftEntityType((cfg.target ? String(cfg.target) : ""), locale);
    return pick_locale(locale, {"zh_cn": ("击杀 " + String(name) + "（" + String(st.have) + "/" + String(cfg.count) + "）"), "en_us": ("Kill " + String(name) + " (" + String(st.have) + "/" + String(cfg.count) + ")")});
}
