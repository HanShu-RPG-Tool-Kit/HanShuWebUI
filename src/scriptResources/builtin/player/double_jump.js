// 二段跳（参考脚本，不自动加载）。
// 原理：tick 里临时打开 mayfly；玩家空中再按空格会进入 flying，
// 检测到 flying 后关掉飞行并施加朝向动量，落地再重置。
// 拷进内容包 script/player/double_jump.js，并写入 script/player/load.json。

import ServerPlayer from "net.minecraft.server.level.ServerPlayer"
import PlayerEvent from "mchhui.rpgtoolkit.feature.script.player.PlayerEvent"
import ParticleTypes from "net.minecraft.core.particles.ParticleTypes"
import SoundEvents from "net.minecraft.sounds.SoundEvents"
import SoundSource from "net.minecraft.sounds.SoundSource"
var FORWARD = 0.85;
var UP = 0.42;

function _survival(player: ServerPlayer): boolean {
    return (!(player.isCreative()) && !(player.isSpectator()));
}

function _look_forward(player: ServerPlayer, forward: number, up: number): number[] {
    var yaw = (player.getYRot() * Math.PI / 180);
    return [(-(Math.sin(yaw)) * forward), up, (Math.cos(yaw) * forward)];
}

function _fx(player: ServerPlayer): void {
    // 二段跳触发时的音效 + 脚下烟尘。
    // level.playSound(null, ...) 包含当前玩家；Player.playSound 会排除自身。
    var level = player.level();
    var x = player.getX();
    var y = player.getY();
    var z = player.getZ();
    level.playSound(null, x, y, z, SoundEvents.BREEZE_JUMP, SoundSource.PLAYERS, 0.85, 1.2);
    level.sendParticles(ParticleTypes.CLOUD, x, (y + 0.05), z, 14, 0.4, 0.05, 0.4, 0.02);
    level.sendParticles(ParticleTypes.POOF, x, (y + 0.15), z, 8, 0.25, 0.08, 0.25, 0.01);
}

@hook("join")
function on_join(event: PlayerEvent, board: Blackboard): void {
    board.used_double = false;
}

@hook("leave")
function on_leave(event: PlayerEvent, board: Blackboard): void {
    var player = event.player();
    if (!(_survival(player))) {
        return;
    }
    var abilities = player.getAbilities();
    abilities.mayfly = false;
    abilities.flying = false;
    player.onUpdateAbilities();
}

@hook("tick")
function on_tick(event: PlayerEvent, board: Blackboard): void {
    var player = event.player();
    if (!(_survival(player))) {
        return;
    }
    var abilities = player.getAbilities();
    if (player.onGround()) {
        board.used_double = false;
        if ((!(abilities.mayfly) || abilities.flying)) {
            abilities.mayfly = true;
            abilities.flying = false;
            player.onUpdateAbilities();
        }
        return;
    }
    if (!((board["used_double"] === undefined ? false : board["used_double"]))) {
        if (!(abilities.mayfly)) {
            abilities.mayfly = true;
            player.onUpdateAbilities();
        }
        if (abilities.flying) {
            board.used_double = true;
            abilities.flying = false;
            abilities.mayfly = false;
            player.onUpdateAbilities();
            var parts7 = _look_forward(player, FORWARD, UP);
            var vx = parts7[0];
            var vy = parts7[1];
            var vz = parts7[2];
            player.setDeltaMovement(vx, vy, vz);
            player.hurtMarked = true;
            player.resetFallDistance();
            _fx(player);
        }
    } else {
        if (abilities.flying) {
            abilities.flying = false;
            abilities.mayfly = false;
            player.onUpdateAbilities();
        }
    }
}
