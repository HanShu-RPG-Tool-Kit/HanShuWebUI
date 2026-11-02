/*
{
  "id": "core:smelt_item_mc_type",
  "labels": {
    "zh_cn": { "name": "熔炼取出", "description": "从熔炉类结果格取出指定原版物品" },
    "en_us": { "name": "Smelt take", "description": "Take a vanilla item from a furnace-like result slot" }
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
        "zh_cn": { "name": "物品", "description": "物品 id，如 minecraft:iron_ingot" },
        "en_us": { "name": "Item", "description": "Item id, e.g. minecraft:iron_ingot" }
      },
      "widget": { "editor": "suggest", "type": "item_mc_type" }
    }
  },
  "localize": {
    "zh_cn": "熔炼取出 {target}（{have}/{count}）",
    "en_us": "Take smelted {target} ({have}/{count})"
  }
}
*/

import ItemSmeltedEvent from "net.neoforged.neoforge.event.entity.player.PlayerEvent$ItemSmeltedEvent"
import ServerPlayer from "net.minecraft.server.level.ServerPlayer"
import GoalStacks from "mchhui.rpgtoolkit.feature.goal.GoalStacks"
import GoalLabels from "mchhui.rpgtoolkit.feature.goal.GoalLabels"
import GoalInstance from "mchhui.rpgtoolkit.feature.goal.GoalInstance"

@goal("core:smelt_item_mc_type")
@config(field("count", "int", 1), field("target", "string", "minecraft:iron_ingot"))
@state(field("have", "int", 0))

@subscribe(ItemSmeltedEvent, {priority: "NORMAL", receiveCancelled: false})
function on_event(instance: GoalInstance, event: ItemSmeltedEvent): void {
    var p = event.getEntity();
    if ((!((p instanceof ServerPlayer)) || !(instance.isOwner(p)))) {
        return;
    }
    if (!(GoalStacks.isMc(event.getSmelting(), (cfg.target ? String(cfg.target) : "")))) {
        return;
    }
    var n = Number(event.getAmountRemoved());
    if ((n > 0)) {
        st.have += n;
    }
}

function update_state(instance: GoalInstance): void {
    update_satisfied_state(instance, (st.have >= cfg.count));
}

function localize(instance: GoalInstance, locale: string): string {
    var name = GoalLabels.minecraftItem((cfg.target ? String(cfg.target) : ""), locale);
    return pick_locale(locale, {"zh_cn": ("熔炼取出 " + String(name) + "（" + String(st.have) + "/" + String(cfg.count) + "）"), "en_us": ("Take smelted " + String(name) + " (" + String(st.have) + "/" + String(cfg.count) + ")")});
}
