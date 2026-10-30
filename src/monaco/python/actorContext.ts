import { javaModule } from './stubs'

// Python-owned injection from ActorPython.SDK. Java members stay reflection-owned.
export const ACTOR_EVENT_CLASS = 'mchhui.rpgtoolkit.feature.actor.hook.ActorEvent'
export const ACTOR_API_CLASS = 'mchhui.rpgtoolkit.feature.actor.script.ActorScriptApi'
export const ACTOR_HOOKS = ['init', 'aistep', 'tick', 'hurt', 'join', 'leave', 'remove', 'died', 'interact', 'attack', 'target', 'kill', 'dimension', 'heal', 'effect', 'collide', 'ridden', 'leash'] as const
export const ACTOR_CONTEXT = `from typing import Any, Callable, Literal, TypeVar
from ${javaModule(ACTOR_EVENT_CLASS)} import ActorEvent
_F = TypeVar("_F", bound=Callable[..., Any])
class Blackboard:
    def __getattr__(self, name: str) -> Any: ...
    def __setattr__(self, name: str, value: Any) -> None: ...
def hook(name: Literal[${ACTOR_HOOKS.map(id => JSON.stringify(id)).join(', ')}], *, cancellable: bool | None = None) -> Callable[[_F], _F]: ...
`
