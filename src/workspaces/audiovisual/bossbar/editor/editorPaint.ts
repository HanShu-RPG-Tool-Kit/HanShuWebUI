import type { BossbarPaint, BossbarUv } from '../protocol'

/** 第一帧与静态 UV 保持一致；后续帧只更新所选帧。 */
export function updatePaintUv(paint: BossbarPaint, uv: BossbarUv, frameIndex = 0): BossbarPaint {
  if (paint.kind !== 'texture') return paint
  if (frameIndex < 0 || !Number.isInteger(frameIndex)) return paint
  if (frameIndex > 0 && !paint.animation?.frames[frameIndex]) return paint
  return {
    ...paint,
    ...(frameIndex === 0 ? { uv } : {}),
    ...(paint.animation ? {
      animation: {
        ...paint.animation,
        frames: paint.animation.frames.map((frame, index) => index === frameIndex ? { ...frame, uv } : frame),
      },
    } : {}),
  }
}
