import { useEffect, useRef } from 'react'

/**
 * 导入结果浮窗。
 *
 * - 内容 = 工作流即将返回的那条消息（`ok` 决定配色：成功=默认，失败=红）
 * - "特效"交给 CSS 动画：淡入 + 轻微上浮，停留后淡出，退出动画结束即卸载
 * - 另挂一个兜底定时器：用户开了"减少动态效果"时动画不跑，`animationend`
 *   永远不来，只靠动画会卡住不消失
 *
 * 换一条通知时由外层换 `key` 重新挂载，所以这里只管自己这一条的生命周期。
 */

/** 停留时长（不含出现/退出动画）；CSS 用它当退出动画的延迟 */
const TOAST_HOLD_MS = 2200
/** 兜底移除时间：出现 + 停留 + 退出，再留余量 */
const TOAST_TOTAL_MS = TOAST_HOLD_MS + 900

export type VoiceToastProps = {
  message: string
  ok: boolean
  onDone(): void
}

export function VoiceToast({ message, ok, onDone }: VoiceToastProps) {
  const doneRef = useRef(onDone)
  useEffect(() => {
    doneRef.current = onDone
  }, [onDone])

  useEffect(() => {
    const timer = window.setTimeout(() => doneRef.current(), TOAST_TOTAL_MS)
    return () => window.clearTimeout(timer)
  }, [])

  return (
    <div
      className={`voice-toast${ok ? '' : ' is-error'}`}
      style={{ '--toast-hold': `${TOAST_HOLD_MS}ms` } as React.CSSProperties}
      role="status"
      aria-live="polite"
      onAnimationEnd={(event) => {
        if (event.animationName === 'voice-toast-out') doneRef.current()
      }}
    >
      <span className="voice-toast-dot" aria-hidden />
      <span className="voice-toast-text">{message}</span>
    </div>
  )
}
