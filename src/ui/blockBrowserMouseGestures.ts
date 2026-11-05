import { useEffect, type RefObject } from 'react'

const GESTURE_EVENTS = [
  'pointerdown',
  'mousedown',
  'mouseup',
  'contextmenu',
  'auxclick',
  'dragstart',
  'selectstart',
] as const

const ALWAYS_BLOCK = new Set(['contextmenu', 'dragstart', 'selectstart'])

function isRightButton(event: Event): boolean {
  return 'button' in event && (event as MouseEvent).button === 2
}

function shouldBlock(event: Event): boolean {
  return ALWAYS_BLOCK.has(event.type) || isRightButton(event)
}

/**
 * Block browser mouse gestures / context menu on a pan surface.
 *
 * React onContextMenu / onPointerDown.preventDefault is too late: Edge/Chrome
 * start back-forward gestures in the native capture phase. Listen here with
 * {capture:true, passive:false}. Do not stopPropagation on pointer/mouse
 * down-up, or the React pan handler never runs.
 */
export function useBlockBrowserMouseGestures(
  ref: RefObject<HTMLElement | null>,
  active = true,
): void {
  useEffect(() => {
    const node = ref.current
    if (!node || !active) return

    const onEvent = (event: Event) => {
      if (!shouldBlock(event)) return
      event.preventDefault()
      if (ALWAYS_BLOCK.has(event.type)) event.stopPropagation()
    }
    const options: AddEventListenerOptions = { capture: true, passive: false }
    for (const type of GESTURE_EVENTS) {
      node.addEventListener(type, onEvent, options)
    }
    return () => {
      for (const type of GESTURE_EVENTS) {
        node.removeEventListener(type, onEvent, true)
      }
    }
  }, [ref, active])
}
