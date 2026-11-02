/*
{
  "id": "core:item_mc_type_hold",
  "labels": {
    "zh_cn": { "name": "持有（MC 物品）", "description": "数量足够即为已满足；扣除仅在进度交付或目标节点提交时发生" },
    "en_us": { "name": "Hold (MC item)", "description": "Enough → SATISFIED; take only on progress deliver" }
  },
  "params": {
    "count": {
      "labels": {
        "zh_cn": { "name": "数量", "description": "需要持有／扣除的数量" },
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
    },
    "consume": {
      "labels": {
        "zh_cn": { "name": "消耗", "description": "交付时是否从背包扣除" },
        "en_us": { "name": "Consume", "description": "Whether deliver removes items from inventory" }
      }
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
import GoalDeliverContext from "mchhui.rpgtoolkit.feature.goal.GoalDeliverContext"

@goal("core:item_mc_type_hold", {requires_delivery: true})
@config(field("count", "int", 1), field("target", "string", "minecraft:diamond"), field("consume", "bool", true))
@state(field("have", "int", 0), field("delivered", "int", 0))

@subscribe(PlayerTickPost, {priority: "NORMAL", receiveCancelled: false})
function on_event(instance: GoalInstance, event: PlayerTickPost): void {
    var p = event.getEntity();
    if ((!((p instanceof ServerPlayer)) || !(instance.isOwner(p)) || ((Number(p.tickCount) % 10) !== 0))) {
        return;
    }
    st.have = GoalItems.countMc(p, (cfg.target ? String(cfg.target) : ""));
}

function update_state(instance: GoalInstance): void {
    update_satisfied_state(instance, (st.have >= cfg.count));
}

function deliver(instance: GoalInstance, context: GoalDeliverContext): boolean {
    if ((st.delivered >= 1)) {
        return true;
    }
    if (!(Boolean(cfg.consume))) {
        st.delivered = 1;
        return true;
    }
    var actor = ((context !== null) ? context.actor() : null);
    if (!((actor instanceof ServerPlayer))) {
        return false;
    }
    var target = (cfg.target ? String(cfg.target) : "");
    if (!(GoalItems.takeMc(actor, target, Number(cfg.count)))) {
        return false;
    }
    st.have = GoalItems.countMc(actor, target);
    st.delivered = 1;
    return true;
}

function localize(instance: GoalInstance, locale: string): string {
    var name = GoalLabels.minecraftItem((cfg.target ? String(cfg.target) : ""), locale);
    return pick_locale(locale, {"zh_cn": ("持有 " + String(name) + "（" + String(st.have) + "/" + String(cfg.count) + "）"), "en_us": ("Hold " + String(name) + " (" + String(st.have) + "/" + String(cfg.count) + ")")});
}
