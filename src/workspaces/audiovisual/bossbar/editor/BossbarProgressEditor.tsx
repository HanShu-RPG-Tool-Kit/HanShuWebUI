import type { BossbarBarComponent, BossbarVariable } from '../protocol'
import { NumberField, Row, SelectField } from './BossbarEditorUi'

export function BossbarProgressEditor({
  progress,
  variables,
  onChange,
  readOnly,
}: {
  progress: BossbarBarComponent['progress']
  variables: Record<string, BossbarVariable>
  onChange: (progress: BossbarBarComponent['progress']) => void
  readOnly: boolean
}) {
  const names = Object.entries(variables).filter(([, variable]) => variable.type === 'double').map(([name]) => name)
  const mode = typeof progress === 'number' ? 'const' : 'var'
  return (
    <Row label="进度">
      <span className="bb-operand">
        <SelectField
          disabled={readOnly}
          value={mode}
          options={[
            { value: 'const', label: '固定值' },
            ...(names.length || mode === 'var' ? [{ value: 'var' as const, label: '变量' }] : []),
          ]}
          onCommit={(next) => {
            if (next === mode) return
            if (next === 'var' && names.length) onChange({ var: names[0] })
            else if (next === 'const') onChange(1)
          }}
        />
        {typeof progress === 'number' ? (
          <NumberField value={progress} min={0} max={1} step={0.01} disabled={readOnly} onCommit={onChange} />
        ) : (
          <SelectField
            disabled={readOnly}
            value={progress.var}
            options={names.length ? names.map((name) => ({ value: name, label: name })) : [{ value: progress.var, label: '没有 double 变量' }]}
            onCommit={(name) => onChange({ var: name })}
          />
        )}
      </span>
    </Row>
  )
}
