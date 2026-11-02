import { useState } from 'react'
import {
  BOSSBAR_ANIMATION_MODES,
  BOSSBAR_FITS,
  type BossbarAnimation,
  type BossbarAnimationFrame,
  type BossbarPaint,
  type BossbarUv,
} from '../protocol'
import { Button, NumberField, Row, SelectField, TextField, ColorField, ToggleField } from './BossbarEditorUi'
import { animationFramesAtFps, gridAnimationFrames } from './animationTools'

const FIT_LABELS: Record<(typeof BOSSBAR_FITS)[number], string> = {
  stretch: '拉伸',
  contain: '留边',
  cover: '裁切',
  'nine-slice': '九宫格',
}

const MODE_LABELS: Record<(typeof BOSSBAR_ANIMATION_MODES)[number], string> = {
  loop: '循环',
  once: '一次',
  pingpong: '往复',
}

function UvRows({
  uv,
  texture,
  readOnly,
  onChange,
}: {
  uv: BossbarUv
  texture: { width: number; height: number }
  readOnly: boolean
  onChange: (uv: BossbarUv) => void
}) {
  const fields: { key: keyof BossbarUv; label: string; min: number; max: number }[] = [
    { key: 'x', label: 'UV X', min: 0, max: Math.max(0, texture.width - 1) },
    { key: 'y', label: 'UV Y', min: 0, max: Math.max(0, texture.height - 1) },
    { key: 'width', label: 'UV 宽', min: 1, max: texture.width },
    { key: 'height', label: 'UV 高', min: 1, max: texture.height },
  ]
  return (
    <>
      {fields.map((field) => (
        <Row key={field.key} label={field.label}>
          <NumberField
            value={uv[field.key]}
            min={field.min}
            max={field.max}
            disabled={readOnly}
            onCommit={(next) => onChange({ ...uv, [field.key]: Math.round(next) })}
          />
        </Row>
      ))}
    </>
  )
}

/** 背景/条的画笔：纯色或唯一图集上的 UV（可带 UV 动画） */
export function BossbarPaintEditor({
  paint,
  texture,
  allowAnimation,
  fillOnly,
  readOnly,
  onChange,
  onRequestUv,
}: {
  paint: BossbarPaint
  texture: { width: number; height: number }
  allowAnimation: boolean
  fillOnly: boolean
  readOnly: boolean
  onChange: (paint: BossbarPaint) => void
  /** 把当前画笔设为图集面板的 UV 目标 */
  onRequestUv?: (frameIndex?: number) => void
}) {
  const kind = paint.kind
  return (
    <div className="bb-paint">
      <Row label="类型">
        <SelectField
          disabled={readOnly}
          value={kind}
          options={[
            { value: 'solid', label: '纯色' },
            { value: 'texture', label: '图集纹理' },
          ]}
          onCommit={(next) => {
            if (next === kind) return
            if (next === 'solid') {
              onChange({ kind: 'solid', color: '#FFFFFFFF' })
              return
            }
            onChange({
              kind: 'texture',
              uv: { x: 0, y: 0, width: Math.min(texture.width, 8), height: Math.min(texture.height, 8) },
              fit: 'stretch',
            })
          }}
        />
      </Row>
      {paint.kind === 'solid' ? (
        <Row label="颜色">
          <ColorField disabled={readOnly} value={paint.color} onCommit={(color) => onChange({ ...paint, color })} />
        </Row>
      ) : (
        <>
          <UvRows
            uv={paint.uv}
            texture={texture}
            readOnly={readOnly}
            onChange={(uv) => {
              const next: BossbarPaint = paint.animation
                ? { ...paint, uv, animation: { ...paint.animation, frames: retargetFirstUv(paint.animation.frames, uv) } }
                : { ...paint, uv }
              onChange(next)
            }}
          />
          <Row label="框选">
            <Button variant="ghost" disabled={readOnly} onClick={() => onRequestUv?.()}>
              在图集上框选 UV
            </Button>
          </Row>
          <Row label="填充方式">
            <SelectField
              disabled={readOnly || fillOnly}
              value={paint.fit}
              options={(fillOnly ? (['stretch'] as const) : BOSSBAR_FITS).map((fit) => ({
                value: fit,
                label: FIT_LABELS[fit],
              }))}
              onCommit={(fit) => {
                if (fit === 'nine-slice') {
                  onChange({ ...paint, fit, insets: paint.insets ?? [8, 8, 8, 8] })
                  return
                }
                const { insets: _insets, ...rest } = paint
                void _insets
                onChange({ ...rest, fit })
              }}
            />
          </Row>
          {paint.fit === 'nine-slice' &&
            (['左', '上', '右', '下'] as const).map((label, index) => {
              const values = paint.insets ?? [8, 8, 8, 8]
              return (
                <Row key={label} label={label}>
                  <NumberField
                    value={values[index]}
                    min={0}
                    disabled={readOnly}
                    onCommit={(next) => {
                      const copy: [number, number, number, number] = [...values]
                      copy[index] = Math.round(next)
                      onChange({ ...paint, insets: copy })
                    }}
                  />
                </Row>
              )
            })}
          {allowAnimation && (
            <Row label="UV 动画">
              <ToggleField
                label="启用"
                checked={Boolean(paint.animation)}
                disabled={readOnly}
                onCommit={(enabled) => {
                  if (!enabled) {
                    const { animation: _animation, ...rest } = paint
                    void _animation
                    onChange(rest)
                    return
                  }
                  const frame: BossbarAnimationFrame = { uv: paint.uv, durationMs: 100 }
                  onChange({ ...paint, animation: { mode: 'loop', phaseMs: 0, frames: [frame] } })
                }}
              />
            </Row>
          )}
          {allowAnimation && paint.animation && (
            <AnimationEditor
              animation={paint.animation}
              texture={texture}
              readOnly={readOnly}
              onRequestUv={onRequestUv}
              onChange={(animation) => onChange({ ...paint, animation, uv: animation.frames[0]?.uv ?? paint.uv })}
            />
          )}
        </>
      )}
    </div>
  )
}

function retargetFirstUv(frames: BossbarAnimationFrame[], uv: BossbarUv): BossbarAnimationFrame[] {
  if (!frames.length) return frames
  return frames.map((frame, index) => (index === 0 ? { ...frame, uv } : frame))
}

function AnimationEditor({
  animation,
  texture,
  readOnly,
  onChange,
  onRequestUv,
}: {
  animation: BossbarAnimation
  texture: { width: number; height: number }
  readOnly: boolean
  onChange: (animation: BossbarAnimation) => void
  onRequestUv?: (frameIndex?: number) => void
}) {
  const first = animation.frames[0]
  const [columns, setColumns] = useState(1)
  const [rows, setRows] = useState(1)
  const [count, setCount] = useState(animation.frames.length)
  const [order, setOrder] = useState<'rows' | 'columns'>('rows')
  const [fps, setFps] = useState(10)
  const [problem, setProblem] = useState('')
  const applyFrames = (frames: BossbarAnimationFrame[] | null, error: string) => {
    if (!frames) { setProblem(error); return }
    setProblem('')
    onChange({ ...animation, frames })
  }
  return (
    <div className="bb-animation">
      <Row label="播放方式">
        <SelectField
          disabled={readOnly}
          value={animation.mode}
          options={BOSSBAR_ANIMATION_MODES.map((mode) => ({ value: mode, label: MODE_LABELS[mode] }))}
          onCommit={(mode) => onChange({ ...animation, mode })}
        />
      </Row>
      <Row label="相位偏移">
        <NumberField
          value={animation.phaseMs}
          min={0}
          step={10}
          suffix="ms"
          disabled={readOnly}
          onCommit={(phaseMs) => onChange({ ...animation, phaseMs: Math.round(phaseMs) })}
        />
      </Row>
      <Row label="网格列 / 行">
        <NumberField value={columns} min={1} max={256} disabled={readOnly} onCommit={(value) => setColumns(Math.round(value))} />
        <NumberField value={rows} min={1} max={256} disabled={readOnly} onCommit={(value) => setRows(Math.round(value))} />
      </Row>
      <Row label="帧数 / 顺序">
        <NumberField value={count} min={1} max={256} disabled={readOnly} onCommit={(value) => setCount(Math.round(value))} />
        <SelectField value={order} disabled={readOnly} options={[{ value: 'rows', label: '逐行' }, { value: 'columns', label: '逐列' }]} onCommit={setOrder} />
      </Row>
      <Button disabled={readOnly} onClick={() => applyFrames(gridAnimationFrames(first.uv, texture,
        { columns, rows, count, order, durationMs: first.durationMs }), '网格帧数无效或 UV 超出图集，请调整行列和帧数。')}>
        从首帧展开网格
      </Button>
      <Row label="FPS">
        <NumberField value={fps} min={0.1} max={62.5} step={0.5} disabled={readOnly} onCommit={setFps} />
        <Button disabled={readOnly} onClick={() => applyFrames(animationFramesAtFps(animation.frames, fps), '帧时长须在 16–60000ms 内。')}>
          应用到全部帧
        </Button>
      </Row>
      {problem && <p className="bb-warn">{problem}</p>}
      <div className="bb-frames">
        <div className="bb-frames-head">
          <span>帧（UV / 时长）</span>
          <Button
            disabled={readOnly || animation.frames.length >= 256}
            onClick={() =>
              onChange({
                ...animation,
                frames: [...animation.frames, { uv: { ...first.uv }, durationMs: first.durationMs }],
              })
            }
          >
            + 帧
          </Button>
        </div>
        {animation.frames.map((frame, index) => (
          <div className="bb-frame-row" key={index}>
            <span className="bb-frame-index">{index + 1}</span>
            <TextField
              mono
              disabled={readOnly}
              value={uvText(frame.uv)}
              onCommit={(text) => {
                const parsed = parseUvText(text)
                if (!parsed) return
                const frames = animation.frames.map((entry, entryIndex) =>
                  entryIndex === index ? { ...entry, uv: parsed } : entry,
                )
                onChange({ ...animation, frames })
              }}
            />
            <NumberField
              value={frame.durationMs}
              min={16}
              max={60000}
              step={10}
              suffix="ms"
              disabled={readOnly}
              onCommit={(durationMs) =>
                onChange({
                  ...animation,
                  frames: animation.frames.map((entry, entryIndex) =>
                    entryIndex === index ? { ...entry, durationMs: Math.round(durationMs) } : entry,
                  ),
                })
              }
            />
            <span className="bb-frame-actions">
              <button type="button" disabled={readOnly} title={'框选第 ' + (index + 1) + ' 帧 UV'}
                onClick={() => onRequestUv?.(index)}>框选</button>
              <button type="button" disabled={readOnly || animation.frames.length >= 256} title={'复制第 ' + (index + 1) + ' 帧'}
                onClick={() => onChange({ ...animation, frames: [
                  ...animation.frames.slice(0, index + 1),
                  { ...frame, uv: { ...frame.uv } },
                  ...animation.frames.slice(index + 1),
                ] })}>复制</button>
              <button
                type="button"
                disabled={readOnly || index === 0}
                title="上移"
                onClick={() => onChange({ ...animation, frames: move(animation.frames, index, index - 1) })}
              >
                ↑
              </button>
              <button
                type="button"
                disabled={readOnly || index === animation.frames.length - 1}
                title="下移"
                onClick={() => onChange({ ...animation, frames: move(animation.frames, index, index + 1) })}
              >
                ↓
              </button>
              <button
                type="button"
                disabled={readOnly || animation.frames.length <= 1}
                title="删除"
                onClick={() =>
                  onChange({ ...animation, frames: animation.frames.filter((_, entryIndex) => entryIndex !== index) })
                }
              >
                ×
              </button>
            </span>
          </div>
        ))}
        <p className="bb-hint">
          UV：<code>x,y,宽,高</code>，各帧尺寸须一致。
        </p>
      </div>
    </div>
  )
}

function move<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

function uvText(uv: BossbarUv): string {
  return uv.x + ',' + uv.y + ',' + uv.width + ',' + uv.height
}

export function parseUvText(text: string): BossbarUv | null {
  const parts = text.split(',').map((part) => Number(part.trim()))
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return null
  const [x, y, width, height] = parts.map((value) => Math.round(value))
  if (x < 0 || y < 0 || width <= 0 || height <= 0) return null
  return { x, y, width, height }
}
