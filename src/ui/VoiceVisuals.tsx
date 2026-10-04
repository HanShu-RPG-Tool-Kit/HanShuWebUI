import { VOICE_EXTRA_GLYPHS, type VoiceGlyphPart } from './voiceIcons'

/**
 * 音频相关的共用可视化件（几何一律来自 `ui/voiceIcons`）。
 *
 * 抽出来的原因：录音棚（预览窗、候选音频、录音）与资产浏览器要画同一套图标与波形，
 * 各自抄一份就必然漂移。
 */

/** 按 24×24 的 path 段拼一个 svg 图标 */
export function VoiceGlyph({ parts }: { parts: VoiceGlyphPart[] }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {parts.map((part, index) =>
        part.mode === 'fill' ? (
          <path key={index} d={part.d} fill="currentColor" opacity={part.opacity} />
        ) : (
          <path
            key={index}
            d={part.d}
            fill="none"
            stroke="currentColor"
            strokeWidth={part.width ?? 2}
            strokeLinecap="round"
            opacity={part.opacity}
          />
        ),
      )}
    </svg>
  )
}

/** 空预览：一个框 + 内部一个叉（没选音频时占位） */
export function VoiceEmptyGlyph() {
  return <VoiceGlyph parts={VOICE_EXTRA_GLYPHS.emptyBox} />
}

/**
 * 音频形状：对称柱状波形（由解码后的峰值画）。
 * `progress` 给 0..1 时，已播过的那段用另一个 class 标出来（录音棚的进度条）。
 */
export function VoiceWaveform({
  peaks,
  progress,
}: {
  peaks: number[]
  progress?: number
}) {
  const count = peaks.length || 1
  const slot = 100 / count
  const ratio = progress == null ? null : Math.max(0, Math.min(1, progress))
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      role="img"
      aria-label="音频形状"
    >
      {peaks.map((peak, index) => {
        const height = Math.max(peak * 94, 1)
        const played = ratio != null && index / count < ratio
        return (
          <rect
            key={index}
            className={played ? 'is-played' : undefined}
            x={index * slot + slot * 0.18}
            y={50 - height / 2}
            width={slot * 0.64}
            height={height}
            fill="currentColor"
            opacity={played ? 1 : 0.9}
          />
        )
      })}
    </svg>
  )
}
