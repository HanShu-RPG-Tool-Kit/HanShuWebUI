/*
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
*/

import LivingDeathEvent from "net.neoforged.neoforge.event.entity.living.LivingDeathEvent"
import ServerPlayer from "net.minecraft.server.level.ServerPlayer"
import EntityTemplates from "mchhui.rpgtoolkit.feature.entity.EntityTemplates"
import GoalLabels from "mchhui.rpgtoolkit.feature.goal.GoalLabels"
import GoalInstance from "mchhui.rpgtoolkit.feature.goal.GoalInstance"

@goal("core:kill_rpgtk_type")
@config(field("count", "int", 1), field("target", "string"))
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
    var victim = event.getEntity();
    var level = victim.level();
    var server = ((level !== null) ? level.getServer() : null);
    if ((server === null)) {
        return;
    }
    if (!(EntityTemplates.get().isFromTemplate(victim, wanted))) {
        return;
    }
    st.have += 1;
}

function update_state(instance: GoalInstance): void {
    update_satisfied_state(instance, (st.have >= cfg.count));
}

function localize(instance: GoalInstance, locale: string): string {
    var name = GoalLabels.rpgtkTemplate((cfg.target ? String(cfg.target) : ""), locale);
    return pick_locale(locale, {"zh_cn": ("击杀 " + String(name) + "（" + String(st.have) + "/" + String(cfg.count) + "）"), "en_us": ("Kill " + String(name) + " (" + String(st.have) + "/" + String(cfg.count) + ")")});
}
