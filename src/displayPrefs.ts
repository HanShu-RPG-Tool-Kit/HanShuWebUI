/**
 * 应用显示偏好(方案 §11):
 *   - 界面比例默认 125%(首次使用),可调 100/110/125/150%,持久保存
 *   - 已存在显式偏好时优先保留,更新不强制覆盖
 *   - 通过 :root 上的 --app-ui-scale 生效;字体/间距按 token × scale 计算,
 *     不在 body 上套 transform: scale()
 *   - 偏好与业务数据分离:不进 skinId、不改变条目 revision
 */

export type UiScale = 100 | 110 | 125 | 150

export const UI_SCALES: UiScale[] = [100, 110, 125, 150]
export const DEFAULT_UI_SCALE: UiScale = 125
const STORAGE_KEY = 'hanshu.display.uiScale'

export function loadUiScale(): UiScale {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return DEFAULT_UI_SCALE
    const v = Number.parseInt(raw, 10)
    if (UI_SCALES.includes(v as UiScale)) return v as UiScale
    return DEFAULT_UI_SCALE
  } catch {
    return DEFAULT_UI_SCALE
  }
}

export function saveUiScale(scale: UiScale): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(scale))
  } catch {
    /* private mode */
  }
}

/** Apply the scale to the document root as a CSS variable. */
export function applyUiScale(scale: UiScale): void {
  const root = document.documentElement
  root.style.setProperty('--app-ui-scale', String(scale / 100))
  root.dataset.uiScale = String(scale)
}
