import { javaModule } from './stubs'

// Python-owned injection from ActorPython.SDK. Java members stay reflection-owned.
export const ACTOR_EVENT_CLASS = 'mchhui.rpgtoolkit.feature.actor.hook.ActorEvent'
export const ACTOR_API_CLASS = 'mchhui.rpgtoolkit.feature.actor.script.ActorScriptApi'
export function actorContext(hooks: readonly string[] | null = null) { return `from typing import Any, Callable, Literal, Never, TypeVar
from ${javaModule(ACTOR_EVENT_CLASS)} import ActorEvent
_F = TypeVar("_F", bound=Callable[..., Any])
class Blackboard:
    def __getattr__(self, name: str) -> Any: ...
    def __setattr__(self, name: str, value: Any) -> None: ...
def hook(name: ${hooks === null ? 'str' : hooks.length ? `Literal[${hooks.map(id => JSON.stringify(id)).join(', ')}]` : 'Never'}, *, cancellable: bool | None = None) -> Callable[[_F], _F]: ...
`
}
