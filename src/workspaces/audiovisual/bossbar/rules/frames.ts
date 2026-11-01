import type { BossbarAnimation, BossbarAnimationFrame, BossbarUv } from '../protocol'

/**
 * UV 动画取帧。
 *
 * 传进来的 clock 是**实例时间**（毫秒），`phaseMs` 在内部加上，调用方不要再加一次。
 * 取帧区间左闭右开；loop 取模，once 停末帧，pingpong 为 0…n-1,n-2…1（端点不重复）。
 * 帧只切换源 UV，目标组件 box 恒定。
 */

export type BossbarFrameSample = {
  index: number
  uv: BossbarUv
  offsetMs: number
  durationMs: number
}

export function animationDuration(animation: BossbarAnimation): number {
  return animation.frames.reduce((sum, frame) => sum + Math.max(0, frame.durationMs), 0)
}

/** 一个完整循环的长度（pingpong 不含重复的端点） */
export function animationCycle(animation: BossbarAnimation): number {
  const count = animation.frames.length
  if (count <= 1) return count === 1 ? Math.max(0, animation.frames[0].durationMs) : 0
  const total = animationDuration(animation)
  if (animation.mode !== 'pingpong') return total
  return Math.max(
    0,
    2 * total - animation.frames[0].durationMs - animation.frames[count - 1].durationMs,
  )
}

function mod(value: number, span: number): number {
  if (!(span > 0)) return 0
  const rest = value % span
  return rest < 0 ? rest + span : rest
}

function frameAt(animation: BossbarAnimation, timeMs: number): BossbarFrameSample {
  const frames = animation.frames
  let offset = timeMs
  for (let index = 0; index < frames.length; index += 1) {
    const duration = Math.max(0, frames[index].durationMs)
    if (offset < duration) {
      return { index, uv: frames[index].uv, offsetMs: offset, durationMs: duration }
    }
    offset -= duration
  }
  const last = frames.length - 1
  return {
    index: last,
    uv: frames[last].uv,
    offsetMs: Math.max(0, frames[last].durationMs),
    durationMs: frames[last].durationMs,
  }
}

/** 没有 animation 时恒定显示 paint.uv */
export function sampleAnimation(
  animation: BossbarAnimation | undefined,
  uv: BossbarUv,
  clockMs: number,
): BossbarFrameSample {
  if (!animation || !animation.frames.length) {
    return { index: 0, uv, offsetMs: 0, durationMs: 0 }
  }
  const frames = animation.frames
  if (frames.length === 1) {
    return { index: 0, uv: frames[0].uv, offsetMs: 0, durationMs: frames[0].durationMs }
  }
  const time = clockMs + animation.phaseMs
  if (animation.mode === 'once') {
    const total = animationDuration(animation)
    return frameAt(animation, Math.min(Math.max(0, time), total))
  }
  if (animation.mode === 'pingpong') {
    const cycle = animationCycle(animation)
    if (!(cycle > 0)) return { index: 0, uv: frames[0].uv, offsetMs: 0, durationMs: frames[0].durationMs }
    const total = animationDuration(animation)
    const t = mod(time, cycle)
    if (t < total) return frameAt(animation, t)
    let offset = t - total
    for (let index = frames.length - 2; index >= 1; index -= 1) {
      const duration = Math.max(0, frames[index].durationMs)
      if (offset < duration) {
        return { index, uv: frames[index].uv, offsetMs: offset, durationMs: duration }
      }
      offset -= duration
    }
    const fallback = Math.max(1, frames.length - 2)
    return {
      index: fallback,
      uv: frames[fallback].uv,
      offsetMs: 0,
      durationMs: frames[fallback].durationMs,
    }
  }
  const total = animationDuration(animation)
  if (!(total > 0)) return { index: 0, uv: frames[0].uv, offsetMs: 0, durationMs: frames[0].durationMs }
  return frameAt(animation, mod(time, total))
}

/** 动画里出现过的所有 UV（校验与编辑器用） */
export function animationUvs(animation: BossbarAnimation): BossbarUv[] {
  return animation.frames.map((frame: BossbarAnimationFrame) => frame.uv)
}

/** 前后移动一个帧区间，按播放顺序处理不等时长、相位和 pingpong 的返程。 */
export function stepAnimationFrame(animation: BossbarAnimation, clockMs: number, direction: -1 | 1): number {
  const count = animation.frames.length
  if (count <= 1) return Math.max(0, clockMs)
  const order = Array.from({ length: count }, (_, index) => index)
  if (animation.mode === 'pingpong') {
    for (let index = count - 2; index >= 1; index -= 1) order.push(index)
  }
  const starts: number[] = []
  let duration = 0
  for (const index of order) {
    starts.push(duration)
    duration += animation.frames[index].durationMs
  }
  if (!(duration > 0)) return Math.max(0, clockMs)
  const time = Math.max(0, clockMs) + animation.phaseMs
  let cycle = animation.mode === 'once' ? 0 : Math.floor(time / duration)
  const local = animation.mode === 'once' ? Math.min(time, duration) : mod(time, duration)
  let current = starts.length - 1
  while (current > 0 && starts[current] > local) current -= 1
  if (animation.mode === 'once' && direction === 1 && current === starts.length - 1) return Math.max(0, clockMs)
  let next = current + direction
  if (animation.mode === 'once') next = Math.max(0, Math.min(starts.length - 1, next))
  else if (next < 0) { next = starts.length - 1; cycle -= 1 }
  else if (next >= starts.length) { next = 0; cycle += 1 }
  return Math.max(0, cycle * duration + starts[next] - animation.phaseMs)
}
