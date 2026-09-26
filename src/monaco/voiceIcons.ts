/**
 * 配音按钮的图标（自绘 SVG，24×24 视口）。
 *
 * 几何只在这里定义一次：覆盖层（命令式 DOM）把它拼成 `<svg>` 字符串，
 * React 侧（选择器弹窗）直接按 `mode` 渲染 `path`，两边不会画歪。
 *
 * 颜色一律用 `currentColor`：四种形态的底色/前景色由 CSS 决定，
 * 图标本身不带颜色（缺失红 / 无效紫 / 可用黄 / 播放中蓝）。
 */

export type VoiceButtonState = 'missing' | 'invalid' | 'ready' | 'playing'

export type VoiceGlyphPart = {
  /** path 的 d */
  d: string
  /** 实心 or 描边 */
  mode: 'fill' | 'stroke'
  /** 描边宽度（mode = 'stroke'） */
  width?: number
  /** 透明度（选填，用于"喇叭淡一点、叉更醒目"） */
  opacity?: number
}

/** 喇叭本体（含纸盆） */
const SPEAKER: VoiceGlyphPart = { d: 'M4 9h3l4-4v14l-4-4H4z', mode: 'fill' }
/** 近处声波 */
const WAVE_NEAR: VoiceGlyphPart = {
  d: 'M15.2 9.4a3.6 3.6 0 0 1 0 5.2',
  mode: 'stroke',
  width: 1.9,
}
/** 远处声波 */
const WAVE_FAR: VoiceGlyphPart = {
  d: 'M17.8 6.8a7.2 7.2 0 0 1 0 10.4',
  mode: 'stroke',
  width: 1.9,
}
/** 叉（两笔） */
const CROSS_A: VoiceGlyphPart = { d: 'M14.2 6.8l6 6', mode: 'stroke', width: 2.1 }
const CROSS_B: VoiceGlyphPart = { d: 'M20.2 6.8l-6 6', mode: 'stroke', width: 2.1 }
/** 暂停（两根竖条） */
const PAUSE_A: VoiceGlyphPart = { d: 'M8.6 6.6h2.7v10.8H8.6z', mode: 'fill' }
const PAUSE_B: VoiceGlyphPart = { d: 'M12.7 6.6h2.7v10.8h-2.7z', mode: 'fill' }

/** 四态对应的图形 */
export const VOICE_GLYPHS: Record<VoiceButtonState, VoiceGlyphPart[]> = {
  // 缺失：喇叭淡一点 + 一个叉（红色底由 CSS 给）
  missing: [{ ...SPEAKER, opacity: 0.5 }, CROSS_A, CROSS_B],
  // 无效：同上（紫色底由 CSS 给）—— 语义靠底色区分
  invalid: [{ ...SPEAKER, opacity: 0.5 }, CROSS_A, CROSS_B],
  // 可用：喇叭发声
  ready: [SPEAKER, WAVE_NEAR, WAVE_FAR],
  // 播放中：典型暂停键
  playing: [PAUSE_A, PAUSE_B],
}

/** 别处要用的图形 */
export const VOICE_EXTRA_GLYPHS = {
  /** 播放三角（选择器顶部播放键） */
  play: [{ d: 'M8 5.6v12.8L19 12z', mode: 'fill' }] as VoiceGlyphPart[],
  /** 空预览：一个框 + 内部一个叉 */
  emptyBox: [
    { d: 'M3.6 3.6h16.8v16.8H3.6z', mode: 'stroke', width: 1.6 },
    { d: 'M7.8 7.8l8.4 8.4', mode: 'stroke', width: 1.8 },
    { d: 'M16.2 7.8l-8.4 8.4', mode: 'stroke', width: 1.8 },
  ] as VoiceGlyphPart[],
}

/** 四态的中文名（tooltip / 无障碍标签） */
export const VOICE_STATE_LABEL: Record<VoiceButtonState, string> = {
  missing: '音频缺失',
  invalid: '音频无效',
  ready: '音频可用',
  playing: '播放中',
}

/** 把一段几何拼成 svg 片段（坐标一律 24×24） */
export function voiceGlyphSvg(parts: VoiceGlyphPart[]): string {
  const body = parts
    .map((part) => {
      const opacity = part.opacity != null ? ` opacity="${part.opacity}"` : ''
      if (part.mode === 'fill') {
        return `<path d="${part.d}" fill="currentColor"${opacity}/>`
      }
      return `<path d="${part.d}" fill="none" stroke="currentColor" stroke-width="${part.width ?? 2}" stroke-linecap="round"${opacity}/>`
    })
    .join('')
  return `<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true" focusable="false">${body}</svg>`
}

/** 配音按钮用的完整 svg 字符串 */
export function voiceButtonSvg(state: VoiceButtonState): string {
  return voiceGlyphSvg(VOICE_GLYPHS[state])
}
