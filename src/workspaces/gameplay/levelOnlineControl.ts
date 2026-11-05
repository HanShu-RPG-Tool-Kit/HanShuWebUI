import {
  controlConnectionGeneration,
  controlRequest,
  isControlConnected,
  subscribeControlNotify,
} from '../../gameDevServer/controlHub'
import type { LevelOnlineTransport } from './levelOnline'

/** Adapter over the existing ControlHub request and notify registration. */
export function controlLevelTransport(): LevelOnlineTransport {
  return {
    request: (method, params) => controlRequest(method, params),
    subscribe: (listener) => subscribeControlNotify((note) => listener(note.method, note.params)),
    connected: () => isControlConnected(),
    generation: () => controlConnectionGeneration(),
  }
}
