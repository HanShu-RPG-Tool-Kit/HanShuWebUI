// 钓竿抓钩（参考脚本，不自动加载）。
// 原理：抛出浮标后再次右键收杆时，use_item 仍能读到 player.fishing；
// 把玩家朝浮标方向拉一段动量（上限 MAX_POWER）。门控用原版钓竿，不读 NBT。
// 拷进内容包 script/player/grappling_hook.js，并写入 script/player/load.json。

import ServerPlayer from "net.minecraft.server.level.ServerPlayer"
import FishingHook from "net.minecraft.world.entity.projectile.FishingHook"
import Items from "net.minecraft.world.item.Items"
import PlayerUseItemEvent from "mchhui.rpgtoolkit.feature.script.player.PlayerEvent$UseItem"
import ParticleTypes from "net.minecraft.core.particles.ParticleTypes"
import SoundEvents from "net.minecraft.sounds.SoundEvents"
import SoundSource from "net.minecraft.sounds.SoundSource"
var MAX_POWER = 1.5;

function _fx(player: ServerPlayer): void {
    // level.playSound(null, ...) 包含当前玩家；Player.playSound 会排除自身。
    var level = player.level();
    var x = player.getX();
    var y = player.getY();
    var z = player.getZ();
    level.playSound(null, x, y, z, SoundEvents.FISHING_BOBBER_RETRIEVE, SoundSource.PLAYERS, 1.0, 1.15);
    level.sendParticles(ParticleTypes.CLOUD, x, (y + 0.1), z, 10, 0.25, 0.08, 0.25, 0.02);
}

function _pull_toward(player: ServerPlayer, hook: FishingHook, maxPower: number): void {
    var dx = (hook.getX() - player.getX());
    var dy = (hook.getY() - player.getY());
    var dz = (hook.getZ() - player.getZ());
    var len = Math.sqrt((((dx * dx) + (dy * dy)) + (dz * dz)));
    if (len < 0.001) {
        return;
    }
    if (len > maxPower) {
        var scale = (maxPower / len);
        dx = (dx * scale);
        dy = (dy * scale);
        dz = (dz * scale);
    }
    player.setDeltaMovement(dx, dy, dz);
    player.hurtMarked = true;
    player.resetFallDistance();
}

@hook("use_item")
function on_use_item(event: PlayerUseItemEvent, board: Blackboard): void {
    var player = event.player();
    if (player.isSpectator()) {
        return;
    }
    var stack = event.stack();
    if ((stack.isEmpty() || !(stack.is(Items.FISHING_ROD)))) {
        return;
    }
    var hook = player.fishing;
    if (hook == null) {
        // 第一次右键是抛竿，此时还没有浮标可拉。
        return;
    }
    _pull_toward(player, hook, MAX_POWER);
    _fx(player);
}
