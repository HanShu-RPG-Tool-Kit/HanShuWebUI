/*
{
  "id": "core:craft_item_mc_type",
  "labels": {
    "zh_cn": { "name": "合成物品", "description": "从合成结果格取出指定原版物品" },
    "en_us": { "name": "Craft item", "description": "Take a vanilla item from a crafting result slot" }
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
        "zh_cn": { "name": "物品", "description": "物品 id，如 minecraft:stick" },
        "en_us": { "name": "Item", "description": "Item id, e.g. minecraft:stick" }
      },
      "widget": { "editor": "suggest", "type": "item_mc_type" }
    }
  },
  "localize": {
    "zh_cn": "合成 {target}（{have}/{count}）",
    "en_us": "Craft {target} ({have}/{count})"
  }
}
*/

import ItemCraftedEvent from "net.neoforged.neoforge.event.entity.player.PlayerEvent$ItemCraftedEvent"
import ServerPlayer from "net.minecraft.server.level.ServerPlayer"
import GoalStacks from "mchhui.rpgtoolkit.feature.goal.GoalStacks"
import GoalLabels from "mchhui.rpgtoolkit.feature.goal.GoalLabels"
import GoalInstance from "mchhui.rpgtoolkit.feature.goal.GoalInstance"

@goal("core:craft_item_mc_type")
@config(field("count", "int", 1), field("target", "string", "minecraft:stick"))
@state(field("have", "int", 0))

@subscribe(ItemCraftedEvent, {priority: "NORMAL", receiveCancelled: false})
function on_event(instance: GoalInstance, event: ItemCraftedEvent): void {
    var p = event.getEntity();
    if ((!((p instanceof ServerPlayer)) || !(instance.isOwner(p)))) {
        return;
    }
    var n = GoalStacks.countMc(event.getCrafting(), (cfg.target ? String(cfg.target) : ""));
    if ((n > 0)) {
        st.have += n;
    }
}

function update_state(instance: GoalInstance): void {
    update_satisfied_state(instance, (st.have >= cfg.count));
}

function localize(instance: GoalInstance, locale: string): string {
    var name = GoalLabels.minecraftItem((cfg.target ? String(cfg.target) : ""), locale);
    return pick_locale(locale, {"zh_cn": ("合成 " + String(name) + "（" + String(st.have) + "/" + String(cfg.count) + "）"), "en_us": ("Craft " + String(name) + " (" + String(st.have) + "/" + String(cfg.count) + ")")});
}
