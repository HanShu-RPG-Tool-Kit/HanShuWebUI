/*
{
  "id": "core:smith_item_mc_type",
  "labels": {
    "zh_cn": { "name": "锻造取出", "description": "从锻造台结果格取出指定原版物品" },
    "en_us": { "name": "Smith take", "description": "Take a vanilla item from a smithing table result" }
  },
  "params": {
    "count": {
      "labels": {
        "zh_cn": { "name": "数量", "description": "需要取出的物品总数" },
        "en_us": { "name": "Count", "description": "Total items to take" }
      },
      "widget": { "editor": "number" }
    },
    "target": {
      "labels": {
        "zh_cn": { "name": "物品", "description": "物品 id，如 minecraft:netherite_sword" },
        "en_us": { "name": "Item", "description": "Item id, e.g. minecraft:netherite_sword" }
      },
      "widget": { "editor": "suggest", "type": "item_mc_type" }
    }
  },
  "localize": {
    "zh_cn": "锻造 {target}（{have}/{count}）",
    "en_us": "Smith {target} ({have}/{count})"
  }
}
*/

import GoalSmithTakenEvent from "mchhui.rpgtoolkit.feature.goal.GoalSmithTakenEvent"
import GoalStacks from "mchhui.rpgtoolkit.feature.goal.GoalStacks"
import GoalLabels from "mchhui.rpgtoolkit.feature.goal.GoalLabels"
import GoalInstance from "mchhui.rpgtoolkit.feature.goal.GoalInstance"

@goal("core:smith_item_mc_type")
@config(field("count", "int", 1), field("target", "string", "minecraft:netherite_sword"))
@state(field("have", "int", 0))

@subscribe(GoalSmithTakenEvent, {priority: "NORMAL", receiveCancelled: false})
function on_event(instance: GoalInstance, event: GoalSmithTakenEvent): void {
    var p = event.getPlayer();
    if (!(instance.isOwner(p))) {
        return;
    }
    var n = GoalStacks.countMc(event.getStack(), (cfg.target ? String(cfg.target) : ""));
    if ((n > 0)) {
        st.have += n;
    }
}

function update_state(instance: GoalInstance): void {
    update_satisfied_state(instance, (st.have >= cfg.count));
}

function localize(instance: GoalInstance, locale: string): string {
    var name = GoalLabels.minecraftItem((cfg.target ? String(cfg.target) : ""), locale);
    return pick_locale(locale, {"zh_cn": ("锻造 " + String(name) + "（" + String(st.have) + "/" + String(cfg.count) + "）"), "en_us": ("Smith " + String(name) + " (" + String(st.have) + "/" + String(cfg.count) + ")")});
}
