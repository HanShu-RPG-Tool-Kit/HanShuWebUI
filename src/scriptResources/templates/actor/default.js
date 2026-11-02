// {{name}}

import ActorEvent from "mchhui.rpgtoolkit.feature.actor.hook.ActorEvent"

@hook("init")
function on_init(event: ActorEvent, blackboard: Blackboard): void {
    blackboard.ticks = 0;
}

@hook("tick")
function on_tick(event: ActorEvent, blackboard: Blackboard): void {
    blackboard.ticks += 1;
}
