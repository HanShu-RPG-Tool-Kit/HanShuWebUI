import {
  BOSSBAR_BAR_DIRECTIONS,
  BOSSBAR_LIMITS,
  BOSSBAR_TEXT_ALIGNS,
  BOSSBAR_TEXT_VERTICAL_ALIGNS,
  isDisplayRegion,
  type BossbarBackgroundComponent,
  type BossbarBarComponent,
  type BossbarDocument,
  type BossbarTextAlign,
  type BossbarTextComponent,
  type BossbarTextRun,
  type BossbarTextVerticalAlign,
} from '../protocol'
import { clampBoxToRegion } from '../document'
import { Button, ColorField, Empty, NumberField, Row, Section, SelectField, TextField, ToggleField } from './BossbarEditorUi'
import { BossbarPaintEditor } from './BossbarPaintEditor'
import { BossbarProgressEditor } from './BossbarProgressEditor'

/** 右侧属性面板：显示区域、背景、条、文本的完整编辑 */

const ALIGN_LABELS: Record<BossbarTextAlign, string> = { left: '左对齐', center: '居中', right: '右对齐' }
const VERTICAL_LABELS: Record<BossbarTextVerticalAlign, string> = { top: '顶部', middle: '垂直居中', bottom: '底部' }
const DIRECTION_LABELS: Record<(typeof BOSSBAR_BAR_DIRECTIONS)[number], string> = {
  'left-to-right': '从左到右',
  'right-to-left': '从右到左',
  'bottom-to-top': '从下到上',
  'top-to-bottom': '从上到下',
}

export function BossbarInspector({
  document,
  selection,
  texture,
  readOnly,
  onChange,
  onMoveAll,
  onFitRegion,
  onFocusRegion,
  onPickUv,
}: {
  document: BossbarDocument
  selection: readonly string[]
  texture: { width: number; height: number }
  readOnly: boolean
  onChange: (document: BossbarDocument) => void
  onMoveAll: (dx: number, dy: number) => void
  onFitRegion: () => void
  onFocusRegion: () => void
  onPickUv?: (slot: BossbarPaintSlot, frameIndex?: number) => void
}) {
  const component = selection.length === 1
    ? document.components.find((entry) => entry.id === selection[0]) ?? null
    : null
  const region = document.components.find(isDisplayRegion) ?? null

  if (!component) {
    return (
      <div className="bb-inspector">
        <DisplaySettings document={document} readOnly={readOnly} onChange={onChange} />
        <Section title="显示区域">
          {region ? (
            <RegionFields document={document} region={region} readOnly={readOnly} onChange={onChange} />
          ) : (
            <Empty>缺少显示区域，请在 JSON 中修复。</Empty>
          )}
        </Section>
        <Section title="整体移动">
          <MoveAll readOnly={readOnly} onMoveAll={onMoveAll} />
          <Button disabled={readOnly} onClick={onFitRegion}>
            适配到全部组件
          </Button>
          <Button disabled={readOnly} onClick={onFocusRegion}>
            定位显示区域
          </Button>
        </Section>
        <Empty>
          {selection.length > 1 ? '已选多个组件' : '选择组件以编辑属性'}
        </Empty>
      </div>
    )
  }

  if (isDisplayRegion(component)) {
    return (
      <div className="bb-inspector">
        <DisplaySettings document={document} readOnly={readOnly} onChange={onChange} />
        <Section title="显示区域">
          <RegionFields document={document} region={component} readOnly={readOnly} onChange={onChange} />
        </Section>
        <Section title="整体移动">
          <MoveAll readOnly={readOnly} onMoveAll={onMoveAll} />
          <Button disabled={readOnly} onClick={onFitRegion}>
            适配到全部组件
          </Button>
          <Button disabled={readOnly} onClick={onFocusRegion}>
            定位显示区域
          </Button>
        </Section>
      </div>
    )
  }

  const update = (patch: Partial<typeof component>) => {
    const next = {
      ...document,
      components: document.components.map((entry) =>
        entry.id === component.id ? { ...entry, ...patch } : entry,
      ),
    } as BossbarDocument
    onChange(next)
  }

  return (
    <div className="bb-inspector">
      <Section title={'组件 ' + component.id} extra={<span className="bb-tag">{component.type}</span>}>
        <GeometryFields document={document} box={component.box} readOnly={readOnly} onChange={(box) => update({ box })} />
      </Section>
      <Section title="显示">
        <Row label="显隐">
          <VisibilityEditor
            document={document}
            visible={component.visible}
            readOnly={readOnly}
            onChange={(visible) => update({ visible })}
          />
        </Row>
        <Row label="不透明度">
          <NumberField
            value={component.opacity}
            min={0}
            max={1}
            step={0.05}
            disabled={readOnly}
            onCommit={(opacity) => update({ opacity })}
          />
        </Row>
      </Section>
      {component.type === 'background' && (
        <Section title="背景">
          <BossbarPaintEditor
            paint={(component as BossbarBackgroundComponent).paint}
            texture={texture}
            allowAnimation
            fillOnly={false}
            readOnly={readOnly}
            onRequestUv={(frameIndex) => onPickUv?.('paint', frameIndex)}
            onChange={(paint) => update({ paint } as Partial<BossbarBackgroundComponent>)}
          />
        </Section>
      )}
      {component.type === 'bar' && (
        <BarFields
          document={document}
          component={component as BossbarBarComponent}
          texture={texture}
          readOnly={readOnly}
          update={update}
          onPickUv={onPickUv}
        />
      )}
      {component.type === 'text' && (
        <TextFields
          document={document}
          component={component as BossbarTextComponent}
          readOnly={readOnly}
          update={update}
        />
      )}
    </div>
  )
}

function DisplaySettings({ document, readOnly, onChange }: {
  document: BossbarDocument
  readOnly: boolean
  onChange: (document: BossbarDocument) => void
}) {
  return (
    <Section title="显示设置">
      <Row label="优先级">
        <NumberField value={document.priority} min={BOSSBAR_LIMITS.priority.min} max={BOSSBAR_LIMITS.priority.max} disabled={readOnly}
          onCommit={(priority) => onChange({ ...document, priority: Math.trunc(priority) })} />
      </Row>
      <Row label="缩放">
        <NumberField value={document.layout.scale} min={BOSSBAR_LIMITS.layout.minScale} max={BOSSBAR_LIMITS.layout.maxScale}
          step={0.1} disabled={readOnly} onCommit={(scale) => onChange({ ...document, layout: { ...document.layout, scale } })} />
      </Row>
      <Row label="安全边距">
        <NumberField value={document.layout.safeMargin} min={0} max={BOSSBAR_LIMITS.layout.maxSafeMargin} disabled={readOnly}
          onCommit={(safeMargin) => onChange({ ...document, layout: { ...document.layout, safeMargin } })} />
      </Row>
    </Section>
  )
}

function GeometryFields({
  document,
  box,
  readOnly,
  onChange,
}: {
  document: BossbarDocument
  box: { x: number; y: number; width: number; height: number }
  readOnly: boolean
  onChange: (box: { x: number; y: number; width: number; height: number }) => void
}) {
  const region = document.components.find(isDisplayRegion)?.box ?? null
  const commit = (patch: Partial<typeof box>) => {
    const raw = { ...box, ...patch }
    onChange(region ? clampBoxToRegion(region, raw) : raw)
  }
  return (
    <>
      <Row label="X">
        <NumberField value={box.x} disabled={readOnly} onCommit={(x) => commit({ x })} />
      </Row>
      <Row label="Y">
        <NumberField value={box.y} disabled={readOnly} onCommit={(y) => commit({ y })} />
      </Row>
      <Row label="宽">
        <NumberField value={box.width} min={1} disabled={readOnly} onCommit={(width) => commit({ width })} />
      </Row>
      <Row label="高">
        <NumberField value={box.height} min={1} disabled={readOnly} onCommit={(height) => commit({ height })} />
      </Row>
    </>
  )
}

function RegionFields({
  document,
  region,
  readOnly,
  onChange,
}: {
  document: BossbarDocument
  region: { id: string; box: { x: number; y: number; width: number; height: number } }
  readOnly: boolean
  onChange: (document: BossbarDocument) => void
}) {
  const commit = (patch: Partial<typeof region.box>) => {
    const raw = { ...region.box, ...patch }
    if (raw.width < 1 || raw.height < 1) return
    // 收缩/移动显示区域不能把已有组件挤出去
    const left = Math.min(raw.x, ...document.components.filter((entry) => !isDisplayRegion(entry)).map((entry) => entry.box.x), raw.x)
    const top = Math.min(raw.y, ...document.components.filter((entry) => !isDisplayRegion(entry)).map((entry) => entry.box.y), raw.y)
    const right = Math.max(
      raw.x + raw.width,
      ...document.components.filter((entry) => !isDisplayRegion(entry)).map((entry) => entry.box.x + entry.box.width),
      raw.x + raw.width,
    )
    const bottom = Math.max(
      raw.y + raw.height,
      ...document.components.filter((entry) => !isDisplayRegion(entry)).map((entry) => entry.box.y + entry.box.height),
      raw.y + raw.height,
    )
    onChange({
      ...document,
      components: document.components.map((entry) =>
        entry.id === region.id
          ? { ...entry, box: { x: left, y: top, width: right - left, height: bottom - top } }
          : entry,
      ),
    } as BossbarDocument)
  }
  return (
    <>
      <Row label="X">
        <NumberField value={region.box.x} disabled={readOnly} onCommit={(x) => commit({ x })} />
      </Row>
      <Row label="Y">
        <NumberField value={region.box.y} disabled={readOnly} onCommit={(y) => commit({ y })} />
      </Row>
      <Row label="宽">
        <NumberField value={region.box.width} min={1} max={4096} disabled={readOnly} onCommit={(width) => commit({ width })} />
      </Row>
      <Row label="高">
        <NumberField value={region.box.height} min={1} max={1024} disabled={readOnly} onCommit={(height) => commit({ height })} />
      </Row>
    </>
  )
}

function MoveAll({ readOnly, onMoveAll }: { readOnly: boolean; onMoveAll: (dx: number, dy: number) => void }) {
  return (
    <div className="bb-move-all">
      <Button disabled={readOnly} onClick={() => onMoveAll(-16, 0)}>
        ← 16
      </Button>
      <Button disabled={readOnly} onClick={() => onMoveAll(16, 0)}>
        16 →
      </Button>
      <Button disabled={readOnly} onClick={() => onMoveAll(0, -16)}>
        ↑ 16
      </Button>
      <Button disabled={readOnly} onClick={() => onMoveAll(0, 16)}>
        ↓ 16
      </Button>
    </div>
  )
}

function VisibilityEditor({
  document,
  visible,
  readOnly,
  onChange,
}: {
  document: BossbarDocument
  visible: boolean | { var: string }
  readOnly: boolean
  onChange: (visible: boolean | { var: string }) => void
}) {
  const boolNames = Object.entries(document.variables)
    .filter(([, variable]) => variable.type === 'bool')
    .map(([name]) => name)
  const mode = typeof visible === 'boolean' ? 'const' : 'var'
  return (
    <span className="bb-visibility">
      <SelectField
        disabled={readOnly}
        value={mode}
        options={[
          { value: 'const', label: '常量' },
          { value: 'var', label: '绑定 bool 变量' },
        ]}
        onCommit={(next) => {
          if (next === mode) return
          if (next === 'var') {
            if (!boolNames.length) return
            onChange({ var: boolNames[0] })
            return
          }
          onChange(true)
        }}
      />
      {mode === 'const' ? (
        <ToggleField
          label={visible === true ? '显示' : '隐藏'}
          checked={visible === true}
          disabled={readOnly}
          onCommit={onChange}
        />
      ) : (
        <SelectField
          disabled={readOnly}
          value={(visible as { var: string }).var}
          options={boolNames.length ? boolNames.map((name) => ({ value: name, label: name })) : [{ value: (visible as { var: string }).var, label: '（没有 bool 变量）' }]}
          onCommit={(name) => onChange({ var: name })}
        />
      )}
    </span>
  )
}

function BarFields({
  document,
  component,
  texture,
  readOnly,
  update,
  onPickUv,
}: {
  document: BossbarDocument
  component: BossbarBarComponent
  texture: { width: number; height: number }
  readOnly: boolean
  update: (patch: Partial<BossbarBarComponent>) => void
  onPickUv?: (slot: BossbarPaintSlot, frameIndex?: number) => void
}) {
  return (
    <>
      <Section title="进度">
        <BossbarProgressEditor
          progress={component.progress}
          variables={document.variables}
          readOnly={readOnly}
          onChange={(progress) => update({ progress })}
        />
        <Row label="方向">
          <SelectField
            disabled={readOnly}
            value={component.direction}
            options={BOSSBAR_BAR_DIRECTIONS.map((direction) => ({ value: direction, label: DIRECTION_LABELS[direction] }))}
            onCommit={(direction) => update({ direction })}
          />
        </Row>
        <Row label="平滑">
          <NumberField
            value={component.smoothMs}
            min={0}
            max={1000}
            step={20}
            suffix="ms"
            disabled={readOnly}
            onCommit={(smoothMs) => update({ smoothMs })}
          />
        </Row>
      </Section>
      <Section title="填充">
        <BossbarPaintEditor
          paint={component.fill}
          texture={texture}
          allowAnimation
          fillOnly
          readOnly={readOnly}
          onRequestUv={(frameIndex) => onPickUv?.('fill', frameIndex)}
          onChange={(fill) => update({ fill })}
        />
      </Section>
      <Section
        title="滞后条"
        extra={
          <ToggleField
            label="启用"
            checked={Boolean(component.trail)}
            disabled={readOnly}
            onCommit={(enabled) => {
              if (!enabled) {
                const { trail: _trail, ...rest } = component
                void _trail
                update(rest)
                return
              }
              update({
                trail: {
                  paint: { kind: 'solid', color: '#FFB349FF' },
                  delayMs: 250,
                  durationMs: 350,
                },
              })
            }}
          />
        }
      >
        {component.trail && (
          <>
            <BossbarPaintEditor
              paint={component.trail.paint}
              texture={texture}
              allowAnimation
              fillOnly
              readOnly={readOnly}
              onRequestUv={(frameIndex) => onPickUv?.('trail', frameIndex)}
              onChange={(paint) => update({ trail: { ...component.trail!, paint } })}
            />
            <Row label="延迟">
              <NumberField
                value={component.trail.delayMs}
                min={0}
                max={60000}
                step={50}
                suffix="ms"
                disabled={readOnly}
                onCommit={(delayMs) => update({ trail: { ...component.trail!, delayMs: Math.round(delayMs) } })}
              />
            </Row>
            <Row label="追赶时长">
              <NumberField
                value={component.trail.durationMs}
                min={0}
                max={60000}
                step={50}
                suffix="ms"
                disabled={readOnly}
                onCommit={(durationMs) => update({ trail: { ...component.trail!, durationMs: Math.round(durationMs) } })}
              />
            </Row>
          </>
        )}
      </Section>
    </>
  )
}

function TextFields({
  document,
  component,
  readOnly,
  update,
}: {
  document: BossbarDocument
  component: BossbarTextComponent
  readOnly: boolean
  update: (patch: Partial<BossbarTextComponent>) => void
}) {
  return (
    <>
      <Section title="字体">
        <Row label="字号">
          <NumberField
            value={component.fontSize}
            min={4}
            max={512}
            disabled={readOnly}
            onCommit={(fontSize) => update({ fontSize })}
          />
        </Row>
        <Row label="颜色">
          <ColorField disabled={readOnly} value={component.color} onCommit={(color) => update({ color })} />
        </Row>
        <Row label="水平">
          <SelectField
            disabled={readOnly}
            value={component.align}
            options={BOSSBAR_TEXT_ALIGNS.map((align) => ({ value: align, label: ALIGN_LABELS[align] }))}
            onCommit={(align) => update({ align })}
          />
        </Row>
        <Row label="垂直">
          <SelectField
            disabled={readOnly}
            value={component.verticalAlign}
            options={BOSSBAR_TEXT_VERTICAL_ALIGNS.map((align) => ({ value: align, label: VERTICAL_LABELS[align] }))}
            onCommit={(verticalAlign) => update({ verticalAlign })}
          />
        </Row>
        <Row label="阴影">
          <ToggleField label="开启" checked={component.shadow} disabled={readOnly} onCommit={(shadow) => update({ shadow })} />
        </Row>
      </Section>
      <Section
        title="文本片段"
        extra={
          <Button
            disabled={readOnly}
            onClick={() => update({ runs: [...component.runs, { text: '' }] })}
          >
            + 片段
          </Button>
        }
      >
        {component.runs.length === 0 && <Empty>暂无文字片段</Empty>}
        {component.runs.map((run, index) => (
          <RunEditor
            key={index}
            document={document}
            run={run}
            readOnly={readOnly}
            onChange={(next) => update({ runs: component.runs.map((entry, entryIndex) => (entryIndex === index ? next : entry)) })}
            onRemove={() => update({ runs: component.runs.filter((_, entryIndex) => entryIndex !== index) })}
            onMove={(direction) => {
              const target = index + direction
              if (target < 0 || target >= component.runs.length) return
              const next = [...component.runs]
              const [item] = next.splice(index, 1)
              next.splice(target, 0, item)
              update({ runs: next })
            }}
          />
        ))}
      </Section>
    </>
  )
}

function RunEditor({
  document,
  run,
  readOnly,
  onChange,
  onRemove,
  onMove,
}: {
  document: BossbarDocument
  run: BossbarTextRun
  readOnly: boolean
  onChange: (run: BossbarTextRun) => void
  onRemove: () => void
  onMove: (direction: -1 | 1) => void
}) {
  const kind = 'text' in run ? 'text' : 'var'
  const names = Object.keys(document.variables)
  const color = run.color === undefined ? {} : { color: run.color }
  return (
    <div className="bb-run">
      <div className="bb-run-head">
        <SelectField
          disabled={readOnly}
          value={kind}
          options={[
            { value: 'text', label: '文本' },
            ...(names.length || kind === 'var' ? [{ value: 'var' as const, label: '变量' }] : []),
          ]}
          onCommit={(next) => {
            if (next === kind) return
            if (next === 'text') onChange({ ...color, text: '' })
            else if (names.length) onChange({ ...color, var: names[0] })
          }}
        />
        <span className="bb-run-actions">
          <button type="button" disabled={readOnly} onClick={() => onMove(-1)} title="上移">↑</button>
          <button type="button" disabled={readOnly} onClick={() => onMove(1)} title="下移">↓</button>
          <button type="button" disabled={readOnly} onClick={onRemove} title="删除">×</button>
        </span>
      </div>
      {'text' in run ? (
        <Row label="文本">
          <TextField disabled={readOnly} value={run.text} onCommit={(text) => onChange({ ...run, text })} />
        </Row>
      ) : (
        <Row label="变量">
          <SelectField disabled={readOnly} value={run.var}
            options={names.map((name) => ({ value: name, label: name }))}
            onCommit={(name) => onChange({ ...run, var: name })} />
        </Row>
      )}
      {run.color !== undefined && (
        <Row label="片段颜色">
          <ColorField disabled={readOnly} value={run.color} onCommit={(next) => onChange({ ...run, color: next })} />
        </Row>
      )}
    </div>
  )
}

export type BossbarPaintSlot = 'paint' | 'fill' | 'trail'
