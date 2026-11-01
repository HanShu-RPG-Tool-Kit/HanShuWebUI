import {
  isDisplayRegion,
  type BossbarDocument,
  type BossbarValueMap,
} from '../protocol'
import { resolveProgress } from '../rules/range'
import type { BossbarBarView } from './scene'

/**
 * 条的平滑与尾条动画（设计文档 5.5 节）。
 *
 * - 首次显示直接取真实值；
 * - 之后从当前显示比例线性过渡到新比例，新值从当前显示比例重新起算；
 * - 掉血时尾条保留旧比例，延迟 delayMs 后线性追到目标；连续掉血从当前尾条位置重新计时；
 * - 回血时尾条立即对齐当前填充。
 *
 * 文本显示最新真实值，不走这里。
 */

export type BossbarBarAnimation = {
  from: number
  target: number
  changedAt: number
  trailFrom: number
  trailStartedAt: number | null
}

export type BossbarAnimationState = {
  startedAt: number
  bars: Record<string, BossbarBarAnimation>
}

export function createAnimationState(startedAt = 0): BossbarAnimationState {
  return { startedAt, bars: {} }
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * Math.max(0, Math.min(1, t))
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

function displayed(animation: BossbarBarAnimation, smoothMs: number, nowMs: number): number {
  if (!(smoothMs > 0)) return animation.target
  return lerp(animation.from, animation.target, clamp01((nowMs - animation.changedAt) / smoothMs))
}

function trailValue(
  animation: BossbarBarAnimation,
  config: { delayMs: number; durationMs: number },
  nowMs: number,
  fallback: number,
): number {
  if (animation.trailStartedAt === null) return fallback
  const elapsed = nowMs - animation.trailStartedAt - config.delayMs
  if (elapsed < 0) return animation.trailFrom
  if (!(config.durationMs > 0)) return animation.target
  return lerp(animation.trailFrom, animation.target, clamp01(elapsed / config.durationMs))
}

export type BossbarEvaluateResult = {
  state: BossbarAnimationState
  view: Record<string, BossbarBarView>
}

export function evaluateBars(
  previous: BossbarAnimationState | null,
  document: BossbarDocument,
  values: BossbarValueMap,
  nowMs: number,
): BossbarEvaluateResult {
  const bars: Record<string, BossbarBarAnimation> = {}
  const view: Record<string, BossbarBarView> = {}

  for (const component of document.components) {
    if (isDisplayRegion(component) || component.type !== 'bar') continue
    const ratio = resolveProgress(component.progress, document.variables, values)
    const prev = previous?.bars[component.id]
    let animation: BossbarBarAnimation
    if (!prev) {
      animation = { from: ratio, target: ratio, changedAt: nowMs, trailFrom: ratio, trailStartedAt: null }
    } else {
      animation = { ...prev }
      if (prev.target !== ratio) {
        const displayedNow = displayed(prev, component.smoothMs, nowMs)
        const trailNow = component.trail
          ? trailValue(prev, component.trail, nowMs, displayedNow)
          : displayedNow
        animation.from = displayedNow
        animation.changedAt = nowMs
        if (ratio < prev.target) {
          animation.trailFrom = Math.max(trailNow, ratio)
          animation.trailStartedAt = nowMs
        } else {
          animation.trailFrom = ratio
          animation.trailStartedAt = null
        }
        animation.target = ratio
      }
    }
    bars[component.id] = animation
    const fill = displayed(animation, component.smoothMs, nowMs)
    const trail = component.trail ? trailValue(animation, component.trail, nowMs, fill) : fill
    view[component.id] = { value: fill, trail: Math.max(fill, trail) }
  }

  return { state: { startedAt: previous?.startedAt ?? nowMs, bars }, view }
}
