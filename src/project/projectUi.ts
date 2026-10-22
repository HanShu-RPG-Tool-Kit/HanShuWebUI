export type ProjectUiAction = 'open' | 'create' | 'connect' | 'share' | 'collaboration' | 'close'
let handler: ((action: ProjectUiAction) => void) | null = null
export function registerProjectUi(next: (action: ProjectUiAction) => void) {
  handler = next
  return () => { if (handler === next) handler = null }
}
export function openProjectUi(action: ProjectUiAction) { handler?.(action) }
