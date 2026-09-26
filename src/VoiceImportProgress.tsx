/**
 * 「音频导入」进度条（置顶）。
 *
 * 需求里写死的几条：
 * - 进度条**前 2/3 是处理、后 1/3 是写入**（两种颜色分段，写入段从 2/3 处开始长出来）
 * - 过程中**底下页面变暗且不可交互**：整屏 backdrop 吃掉一切指针事件
 * - 右上角有叉，点了就请求中断（工作流返回 `Import workflow interrupted unexpectedly.`）
 */

export type VoiceImportPhase = 'process' | 'write'

export type VoiceImportProgressProps = {
  /** 总进度 0..1 */
  progress: number
  /** 当前阶段 */
  phase: VoiceImportPhase
  /** 源音频路径（显示用） */
  sourcePath: string
  /** 对等目标路径（显示用） */
  targetPath: string
  /** 点 ×：请求中断 */
  onCancel(): void
}

export function VoiceImportProgress({
  progress,
  phase,
  sourcePath,
  targetPath,
  onCancel,
}: VoiceImportProgressProps) {
  const ratio = Math.max(0, Math.min(1, progress))
  const percent = Math.round(ratio * 100)
  // 前 2/3 归处理，后 1/3 归写入
  const processWidth = Math.min(ratio, 2 / 3) * 100
  const writeWidth = Math.max(0, ratio - 2 / 3) * 100

  return (
    <div
      className="voice-import-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="音频导入"
    >
      <div className="voice-import">
        <div className="voice-import-header">
          <span className="voice-import-title">音频导入</span>
          <button
            type="button"
            className="voice-import-close"
            onClick={onCancel}
            title="中断导入"
            aria-label="中断导入"
          >
            ×
          </button>
        </div>

        <div className="voice-import-body">
          <div className="voice-import-row">
            <span className="voice-import-label">源</span>
            <span className="voice-import-value" title={sourcePath}>
              {sourcePath}
            </span>
          </div>
          <div className="voice-import-row">
            <span className="voice-import-label">目标</span>
            <span className="voice-import-value" title={targetPath}>
              {targetPath}
            </span>
          </div>

          <div
            className="voice-import-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <div
              className="voice-import-bar-process"
              style={{ width: `${processWidth}%` }}
            />
            <div
              className="voice-import-bar-write"
              style={{ width: `${writeWidth}%` }}
            />
          </div>

          <div className="voice-import-hint">
            {phase === 'process'
              ? '正在处理为单通道 Ogg Vorbis…'
              : '正在写入（.new → 删旧 → 改名）…'}
            <span className="voice-import-percent">{percent}%</span>
          </div>
        </div>
      </div>
    </div>
  )
}
