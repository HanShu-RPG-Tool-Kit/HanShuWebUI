/*
{
  "id": "core:brew_item_mc_type",
  "labels": {
    "zh_cn": { "name": "炼药取出", "description": "从酿造台取出带药水成分的物品（按物品 id）" },
    "en_us": { "name": "Brew take", "description": "Take a potion-bearing item from a brewing stand (by item id)" }
  },
  "params": {
    "count": {
      "labels": {
        "zh_cn": { "name": "数量", "description": "需要取出的次数／数量" },
        "en_us": { "name": "Count", "description": "Takes / items required" }
      },
      "widget": { "editor": "number" }
    },
    "target": {
      "labels": {
        "zh_cn": { "name": "物品", "description": "物品 id，如 minecraft:potion / splash_potion / lingering_potion" },
        "en_us": { "name": "Item", "description": "Item id, e.g. minecraft:potion / splash_potion / lingering_potion" }
      },
      "widget": { "editor": "suggest", "type": "item_mc_type" }
    }
  },
  "localize": {
    "zh_cn": "炼药取出 {target}（{have}/{count}）",
    "en_us": "Brew take {target} ({have}/{count})"
  }
}
*/

import PlayerBrewedPotionEvent from "net.neoforged.neoforge.event.brewing.PlayerBrewedPotionEvent"
import ServerPlayer from "net.minecraft.server.level.ServerPlayer"
import GoalStacks from "mchhui.rpgtoolkit.feature.goal.GoalStacks"
import GoalLabels from "mchhui.rpgtoolkit.feature.goal.GoalLabels"
import GoalInstance from "mchhui.rpgtoolkit.feature.goal.GoalInstance"

@goal("core:brew_item_mc_type")
@config(field("count", "int", 1), field("target", "string", "minecraft:potion"))
@state(field("have", "int", 0))

@subscribe(PlayerBrewedPotionEvent, {priority: "NORMAL", receiveCancelled: false})
function on_event(instance: GoalInstance, event: PlayerBrewedPotionEvent): void {
    var p = event.getEntity();
    if ((!((p instanceof ServerPlayer)) || !(instance.isOwner(p)))) {
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
    return pick_locale(locale, {"zh_cn": ("炼药取出 " + String(name) + "（" + String(st.have) + "/" + String(cfg.count) + "）"), "en_us": ("Brew take " + String(name) + " (" + String(st.have) + "/" + String(cfg.count) + ")")});
}
