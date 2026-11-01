import { javaModule } from './stubs'

// Python-owned injection from PlayerPython. Java members stay reflection-owned.
export const PLAYER_EVENT_CLASS = 'mchhui.rpgtoolkit.feature.script.player.PlayerEvent'
export const PLAYER_API_CLASS = 'mchhui.rpgtoolkit.feature.script.player.PlayerScriptApi'
export function playerContext(hooks: readonly string[] | null = null) {
  return `from typing import Any, Callable, Literal, Never, TypeVar
from ${javaModule(PLAYER_EVENT_CLASS)} import PlayerEvent
_F = TypeVar("_F", bound=Callable[..., Any])
class Blackboard:
    def __getattr__(self, name: str) -> Any: ...
    def __setattr__(self, name: str, value: Any) -> None: ...
def hook(name: ${hooks === null ? 'str' : hooks.length ? `Literal[${hooks.map(id => JSON.stringify(id)).join(', ')}]` : 'Never'}, *, cancellable: bool | None = None) -> Callable[[_F], _F]: ...
`
}
