// {{name}}
// 跟踪只修改 st；外部要求交付时再调用 deliver（未实现则 no-op）。
import PlayerTickPost from "net.neoforged.neoforge.event.tick.PlayerTickEvent$Post"
import GoalInstance from "mchhui.rpgtoolkit.feature.goal.GoalInstance"

@goal("custom:{{name}}")
@config(field("count", "int", 1))
@state(field("have", "int", 0))

@subscribe(PlayerTickPost)
function on_tick(instance: GoalInstance, event: PlayerTickPost): void {
    var player = event.getEntity();
    if (instance.isOwner(player) && player.tickCount % 20 === 0) {
        st.have = Math.min(cfg.count, st.have + 1);
    }
}

function update_state(instance: GoalInstance): void {
    update_satisfied_state(instance, st.have >= cfg.count);
}

function localize(instance: GoalInstance, locale: string): string {
    return pick_locale(locale, {zh_cn: "进度 " + st.have + "/" + cfg.count, en_us: "Progress " + st.have + "/" + cfg.count});
}
