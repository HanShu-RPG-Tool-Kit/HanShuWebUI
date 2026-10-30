# {{name}}
from __future__ import annotations
from mchhui.rpgtoolkit.feature.actor.hook import ActorEvent


@hook("init")
def on_init(event: ActorEvent, blackboard: Blackboard) -> None:
    blackboard.ticks = 0


@hook("tick")
def on_tick(event: ActorEvent, blackboard: Blackboard) -> None:
    blackboard.ticks += 1
