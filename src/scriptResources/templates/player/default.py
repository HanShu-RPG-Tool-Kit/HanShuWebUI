# {{name}}
from __future__ import annotations
from mchhui.rpgtoolkit.feature.script.player import PlayerEvent


@hook("join")
def on_join(event: PlayerEvent, blackboard: Blackboard) -> None:
    pass


@hook("tick")
def on_tick(event: PlayerEvent, blackboard: Blackboard) -> None:
    pass
