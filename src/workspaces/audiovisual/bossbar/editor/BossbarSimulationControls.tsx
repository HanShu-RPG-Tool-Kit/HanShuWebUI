import { useMemo, useState } from 'react'
import type { BossbarAnimation, BossbarDocument, BossbarPaint, BossbarUv } from '../protocol'
import { animationCycle, sampleAnimation, stepAnimationFrame } from '../rules/frames'
import { Button, SelectField } from './BossbarEditorUi'
import type { BossbarScenario } from './editorState'

/** 模拟控制直接驱动编辑画布，不创建第二个渲染视口。 */
export function BossbarSimulationControls({
  document,
  timeMs,
  playing,
  speed,
  issues,
  scenarios,
  onPlayingChange,
  onTimeChange,
  onSpeedChange,
  onScenario,
}: {
  document: BossbarDocument
  timeMs: number
  playing: boolean
  speed: number
  issues: string[]
  scenarios: BossbarScenario[]
  onPlayingChange: (playing: boolean) => void
  onTimeChange: (timeMs: number) => void
  onSpeedChange: (speed: number) => void
  onScenario: (scenario: BossbarScenario) => void
}) {
  const [animationTarget, setAnimationTarget] = useState('')
  const animations = useMemo(() => {
    const entries: { key: string; label: string; animation: BossbarAnimation; uv: BossbarUv }[] = []
    for (const component of document.components) {
      const add = (slot: string, paint: BossbarPaint) => {
        if (paint.kind === 'texture' && paint.animation) {
          entries.push({ key: component.id + '.' + slot, label: component.id + ' · ' + slot, animation: paint.animation, uv: paint.uv })
        }
      }
      if (component.type === 'background') add('背景', component.paint)
      if (component.type === 'bar') {
        add('填充', component.fill)
        if (component.trail) add('尾条', component.trail.paint)
      }
    }
    return entries
  }, [document.components])
  const selectedAnimation = animations.find((entry) => entry.key === animationTarget) ?? animations[0]
  const timelineLimit = Math.max(1, selectedAnimation ? animationCycle(selectedAnimation.animation) : 1000)
  const timelineTime = selectedAnimation?.animation.mode === 'once'
    ? Math.min(timeMs, timelineLimit)
    : timeMs % timelineLimit
  const frameInfo = selectedAnimation
    ? sampleAnimation(selectedAnimation.animation, selectedAnimation.uv, timeMs)
    : null

  const step = (direction: -1 | 1) => {
    onPlayingChange(false)
    onTimeChange(selectedAnimation
      ? stepAnimationFrame(selectedAnimation.animation, timeMs, direction)
      : Math.max(0, timeMs + direction * 100))
  }

  return (
    <div className="bb-simulation-controls" role="group" aria-label="画布模拟">
      <div className="bb-simulation-playback">
        <Button onClick={() => onPlayingChange(!playing)} variant={playing ? 'primary' : undefined}>
          {playing ? '暂停' : '播放'}
        </Button>
        <Button onClick={() => step(-1)} title="上一帧">◀ 帧</Button>
        <Button onClick={() => step(1)} title="下一帧">帧 ▶</Button>
        <Button onClick={() => { onPlayingChange(false); onTimeChange(0) }}>重置</Button>
      </div>
      <label className="bb-simulation-timeline">
        <span>时间轴</span>
        <input
          type="range" min={0} max={timelineLimit} step={1} value={timelineTime}
          onChange={(event) => { onPlayingChange(false); onTimeChange(Number(event.target.value)) }}
        />
        <output>{Math.round(timeMs)}ms</output>
      </label>
      <label className="bb-simulation-speed">
        <span>速度</span>
        <SelectField value={String(speed)} options={[...new Set([0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, speed])].sort((a, b) => a - b)
          .map((value) => ({ value: String(value), label: value + '×' }))}
          onCommit={(value) => onSpeedChange(Number(value))} />
      </label>
      <select
          className="bb-input bb-simulation-scenario" aria-label="模拟场景" value=""
          onChange={(event) => {
            const scenario = scenarios.find((entry) => entry.id === event.target.value)
            if (scenario) onScenario(scenario)
          }}
      >
        <option value="">场景…</option>
        {scenarios.map((scenario) => <option key={scenario.id} value={scenario.id}>{scenario.label}</option>)}
      </select>
      {selectedAnimation && <label className="bb-simulation-animation">
        <span>逐帧目标</span>
        <SelectField value={selectedAnimation.key} options={animations.map((entry) => ({ value: entry.key, label: entry.label }))}
          onCommit={setAnimationTarget} />
      </label>}
      {frameInfo && <span className="bb-tag">帧 {frameInfo.index + 1}/{selectedAnimation.animation.frames.length}</span>}
      {issues.length > 0 && <ul className="bb-problems bb-simulation-issues">
        {issues.slice(0, 6).map((issue, index) => <li key={index}>{issue}</li>)}
      </ul>}
    </div>
  )
}
