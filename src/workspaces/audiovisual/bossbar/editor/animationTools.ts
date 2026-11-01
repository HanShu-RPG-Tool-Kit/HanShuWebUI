import type { BossbarAnimationFrame, BossbarUv } from '../protocol'

export function gridAnimationFrames(
  first: BossbarUv,
  texture: { width: number; height: number },
  options: { columns: number; rows: number; count: number; order: 'rows' | 'columns'; durationMs: number },
): BossbarAnimationFrame[] | null {
  const { columns, rows, count, order, durationMs } = options
  if (![columns, rows, count, durationMs].every(Number.isInteger) || columns < 1 || rows < 1 ||
    count < 1 || count > 256 || count > columns * rows || durationMs < 16 || durationMs > 60000) return null
  const frames = Array.from({ length: count }, (_, index) => {
    const column = order === 'rows' ? index % columns : Math.floor(index / rows)
    const row = order === 'rows' ? Math.floor(index / columns) : index % rows
    return { uv: { ...first, x: first.x + column * first.width, y: first.y + row * first.height }, durationMs }
  })
  if (frames.some(({ uv }) => uv.x < 0 || uv.y < 0 || uv.x + uv.width > texture.width || uv.y + uv.height > texture.height)) return null
  return frames
}

/** 按累计时间舍入，避免 60 FPS 等非整数毫秒帧率在长序列中累积误差。 */
export function animationFramesAtFps(frames: readonly BossbarAnimationFrame[], fps: number): BossbarAnimationFrame[] | null {
  if (!Number.isFinite(fps) || fps <= 0 || fps > 62.5) return null
  const result = frames.map((frame, index) => ({
    ...frame,
    durationMs: Math.round((index + 1) * 1000 / fps) - Math.round(index * 1000 / fps),
  }))
  return result.every((frame) => frame.durationMs >= 16 && frame.durationMs <= 60000) ? result : null
}
