/*
{
  "id": "core:item_mc_type_max",
  "labels": {
    "zh_cn": { "name": "最大收集（MC 物品）", "description": "背包中指定原版物品数量达到要求即完成" },
    "en_us": { "name": "Max collect (MC item)", "description": "Complete when the player holds enough of a vanilla item" }
  },
  "params": {
    "count": {
      "labels": {
        "zh_cn": { "name": "数量", "description": "需要持有的数量" },
        "en_us": { "name": "Count", "description": "Required amount" }
      },
      "widget": { "editor": "number" }
    },
    "target": {
      "labels": {
        "zh_cn": { "name": "物品", "description": "原版物品 id，如 minecraft:diamond" },
        "en_us": { "name": "Item", "description": "Vanilla item id, e.g. minecraft:diamond" }
      },
      "widget": { "editor": "suggest", "type": "item_mc_type" }
    }
  },
  "localize": {
    "zh_cn": "持有 {target}（{have}/{count}）",
    "en_us": "Hold {target} ({have}/{count})"
  }
}
*/

import PlayerTickPost from "net.neoforged.neoforge.event.tick.PlayerTickEvent$Post"
import ServerPlayer from "net.minecraft.server.level.ServerPlayer"
import GoalItems from "mchhui.rpgtoolkit.feature.goal.GoalItems"
import GoalLabels from "mchhui.rpgtoolkit.feature.goal.GoalLabels"
import GoalInstance from "mchhui.rpgtoolkit.feature.goal.GoalInstance"

@goal("core:item_mc_type_max")
@config(field("count", "int", 1), field("target", "string", "minecraft:diamond"))
@state(field("have", "int", 0))

@subscribe(PlayerTickPost, {priority: "NORMAL", receiveCancelled: false})
function on_event(instance: GoalInstance, event: PlayerTickPost): void {
    var p = event.getEntity();
    if ((!((p instanceof ServerPlayer)) || !(instance.isOwner(p)) || ((Number(p.tickCount) % 10) !== 0))) {
        return;
    }
    st.have = GoalItems.countMc(p, (cfg.target ? String(cfg.target) : ""));
}

function update_state(instance: GoalInstance): void {
    if ((st.have >= cfg.count)) {
        complete(instance);
    }
}

function localize(instance: GoalInstance, locale: string): string {
    var name = GoalLabels.minecraftItem((cfg.target ? String(cfg.target) : ""), locale);
    return pick_locale(locale, {"zh_cn": ("持有 " + String(name) + "（" + String(st.have) + "/" + String(cfg.count) + "）"), "en_us": ("Hold " + String(name) + " (" + String(st.have) + "/" + String(cfg.count) + ")")});
}
