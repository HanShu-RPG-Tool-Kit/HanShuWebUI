/*
{
  "id": "core:fish_item_mc_type",
  "labels": {
    "zh_cn": { "name": "钓鱼获得", "description": "钓鱼收杆获得指定原版物品" },
    "en_us": { "name": "Fish item", "description": "Catch a vanilla item with a fishing rod" }
  },
  "params": {
    "count": {
      "labels": {
        "zh_cn": { "name": "数量", "description": "需要钓到的物品总数" },
        "en_us": { "name": "Count", "description": "Total items to catch" }
      },
      "widget": { "editor": "number" }
    },
    "target": {
      "labels": {
        "zh_cn": { "name": "物品", "description": "物品 id，如 minecraft:cod" },
        "en_us": { "name": "Item", "description": "Item id, e.g. minecraft:cod" }
      },
      "widget": { "editor": "suggest", "type": "item_mc_type" }
    }
  },
  "localize": {
    "zh_cn": "钓到 {target}（{have}/{count}）",
    "en_us": "Fish {target} ({have}/{count})"
  }
}
*/

import ItemFishedEvent from "net.neoforged.neoforge.event.entity.player.ItemFishedEvent"
import ServerPlayer from "net.minecraft.server.level.ServerPlayer"
import GoalStacks from "mchhui.rpgtoolkit.feature.goal.GoalStacks"
import GoalLabels from "mchhui.rpgtoolkit.feature.goal.GoalLabels"
import GoalInstance from "mchhui.rpgtoolkit.feature.goal.GoalInstance"

@goal("core:fish_item_mc_type")
@config(field("count", "int", 1), field("target", "string", "minecraft:cod"))
@state(field("have", "int", 0))

@subscribe(ItemFishedEvent, {priority: "NORMAL", receiveCancelled: false})
function on_event(instance: GoalInstance, event: ItemFishedEvent): void {
    if (event.isCanceled()) {
        return;
    }
    var p = event.getEntity();
    if ((!((p instanceof ServerPlayer)) || !(instance.isOwner(p)))) {
        return;
    }
    var wanted = (cfg.target ? String(cfg.target) : "");
    var n = 0;
    for (var iterator = event.getDrops().iterator(); iterator.hasNext();) {
        var stack = iterator.next();
        n += GoalStacks.countMc(stack, wanted);
    }
    if ((n > 0)) {
        st.have += n;
    }
}

function update_state(instance: GoalInstance): void {
    update_satisfied_state(instance, (st.have >= cfg.count));
}

function localize(instance: GoalInstance, locale: string): string {
    var name = GoalLabels.minecraftItem((cfg.target ? String(cfg.target) : ""), locale);
    return pick_locale(locale, {"zh_cn": ("钓到 " + String(name) + "（" + String(st.have) + "/" + String(cfg.count) + "）"), "en_us": ("Fish " + String(name) + " (" + String(st.have) + "/" + String(cfg.count) + ")")});
}
