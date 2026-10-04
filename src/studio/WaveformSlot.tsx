/**
 * 波形占位：有波形就画波形，没有就按**为什么没有**给一个说法。
 *
 * 抽出来是因为同一段四路分支在面板里写了两遍（候选源那一格、本次录音那一格），
 * 而且文案已经开始分叉 —— 一处写"这个文件解不开"、另一处写"解不开"。
 * 状态由调用方判定（它才知道自己在等什么），这里只负责怎么显示。
 */

import { VoiceEmptyGlyph, VoiceWaveform } from '../ui/VoiceVisuals'

export type WaveformSlotState =
  /** 有可画的波形 */
  | { kind: 'ready'; peaks: number[]; progress: number }
  /** 正在解码（有源、结果还没回来） */
  | { kind: 'decoding' }
  /** 解不开：给出说明 */
  | { kind: 'failed'; caption?: string }
  /** 还没有任何源 */
  | { kind: 'empty' }

export function WaveformSlot({ state }: { state: WaveformSlotState }) {
  if (state.kind === 'ready') {
    return <VoiceWaveform peaks={state.peaks} progress={state.progress} />
  }
  if (state.kind === 'empty') return <VoiceEmptyGlyph />
  return (
    <div className="studio-wave-loading">
      <VoiceEmptyGlyph />
      <span>
        {state.kind === 'failed' ? (state.caption ?? '这个文件解不开') : '解码中…'}
      </span>
    </div>
  )
}
