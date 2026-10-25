import { useSyncExternalStore } from 'react'

/** Monaco 字号随界面比例变化：125% 时与主脚本编辑器一致（18px）。 */
const BASE_FONT = 14.4

function readScale(): number {
  const value = Number.parseInt(document.documentElement.dataset.uiScale ?? '', 10)
  return Number.isFinite(value) && value > 0 ? value / 100 : 1.25
}

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ui-scale'] })
  return () => observer.disconnect()
}

export function useEditorFontSize(): number {
  const scale = useSyncExternalStore(subscribe, readScale, () => 1.25)
  return Math.round(BASE_FONT * scale)
}
