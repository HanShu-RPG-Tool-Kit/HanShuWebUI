import { type ReactNode } from 'react'
import {
  NAV_COORD_ABS_MAX,
  NAV_DISPLAY_ICON,
  NAV_DISPLAY_MAX_DISTANCE,
  NAV_DISPLAY_MIN_DISTANCE,
  NAV_DISPLAY_NAME,
  NAV_LABEL_MAX,
  NAV_TYPE_LABELS,
  NAV_TYPE_POS,
  stringifyNavigationPoint,
  validateNavigationPoint,
  type NavigationPoint,
  type NavTypeId,
} from './navigationPoint'
import { NAV_LABEL_KEY } from './progressLocale'
import './NavigationEditor.css'

function Section({ title, hint, action, children }: { title: string; hint?: string; action?: ReactNode; children: ReactNode }) {
  return <section className="nav-section">
    <header className="nav-section-head">
      <h3>{title}</h3>
      {hint && <span>{hint}</span>}
      {action && <div className="nav-section-action">{action}</div>}
    </header>
    <div className="nav-section-body">{children}</div>
  </section>
}

function Field({ label, hint, wide, children }: { label: string; hint?: string; wide?: boolean; children: ReactNode }) {
  return <label className={`nav-field${wide ? ' is-wide' : ''}`}>
    <span className="nav-field-label">{label}{hint && <em>{hint}</em>}</span>
    {children}
  </label>
}

export function NavigationEditor({ point, error, disabled, onChange, resolveText, setText, levelOptions }: {
  point: NavigationPoint
  error?: string
  disabled?: boolean
  onChange: (source: string) => void
  resolveText?: (key: string) => string
  setText?: (key: string, value: string) => void
  /** 可选的地图模板（.level 文件名，不含后缀） */
  levelOptions?: readonly { id: string; label: string }[]
}) {
  const update = (patch: Partial<NavigationPoint>) => onChange(stringifyNavigationPoint({ ...point, ...patch }))
  const custom = point.custom_data
  const displayName = typeof custom[NAV_DISPLAY_NAME] === 'string' ? String(custom[NAV_DISPLAY_NAME]) : ''
  const readText = (key: string) => resolveText?.(key) ?? key
  const writeLabel = (value: string) => {
    if (disabled) return
    if (setText) setText(displayName || NAV_LABEL_KEY, value)
    else update({ custom_data: { ...custom, [NAV_DISPLAY_NAME]: value } })
  }
  const setCustom = (key: string, value: unknown) => {
    const next = { ...custom }
    if (value === undefined || value === '') delete next[key]
    else next[key] = value
    update({ custom_data: next })
  }
  const issues = validateNavigationPoint(point)
  const preview = stringifyNavigationPoint(point).trimEnd()
  const levels = levelOptions ?? []

  return <div className="nav-editor">
    <div className="nav-page">
      {error && <p className="nav-banner is-error" role="alert">无法完整解析导航点草稿，已显示可编辑兜底。{error}</p>}

      <Section
        title="基本信息"
        hint="导航点只描述「指哪里」；维度由地图模板绑定决定"
        action={<span className={`nav-status${issues.length ? ' is-warn' : ' is-ok'}`}>{issues.length ? `${issues.length} 项待完善` : '可用'}</span>}
      >
        <div className="nav-row">
          <Field label="所属地图" hint="必填：level" wide>
            <select
              disabled={disabled}
              value={point.level}
              aria-label="所属地图模板"
              onChange={(event) => update({ level: event.target.value })}
            >
              <option value="">（未选择）</option>
              {levels.map((level) => <option key={level.id} value={level.id}>{level.label}</option>)}
              {point.level && !levels.some((level) => level.id === point.level) && <option value={point.level}>{point.level}（未找到模板）</option>}
            </select>
          </Field>
          <Field label="追踪类型" hint="类型注册表">
            <select
              disabled={disabled}
              value={point.type}
              aria-label="追踪类型"
              onChange={(event) => update({ type: event.target.value as NavTypeId })}
            >
              {Object.entries(NAV_TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </Field>
        </div>
        <p className="nav-hint">当前只支持 <code>{NAV_TYPE_POS}</code>。实体 / 标签类型等 Mod 侧开放后再加。</p>
      </Section>

      <Section title="坐标" hint={`绝对值 ≤ ${NAV_COORD_ABS_MAX.toLocaleString('en-US')}`}>
        <div className="nav-coords">
          {(['x', 'y', 'z'] as const).map((axis) => (
            <label key={axis} className={`nav-coord is-${axis}`}>
              <b>{axis.toUpperCase()}</b>
              <input
                type="number"
                step="any"
                disabled={disabled}
                value={point.param[axis]}
                aria-label={`${axis.toUpperCase()} 坐标`}
                onChange={(event) => update({ param: { ...point.param, [axis]: Number(event.target.value) } })}
              />
            </label>
          ))}
        </div>
      </Section>

      <Section title="展示" hint="display_* 只是提示，不是到达判定">
        <div className="nav-row">
          <Field label="display_name" hint={`显示名称，≤ ${NAV_LABEL_MAX}`} wide>
            <input
              type="text"
              disabled={disabled}
              value={readText(displayName || NAV_LABEL_KEY)}
              maxLength={NAV_LABEL_MAX}
              placeholder="例如：旧塔"
              aria-label="display_name"
              onChange={(event) => writeLabel(event.target.value)}
            />
          </Field>
          <Field label="display_icon" hint="资源 ID；客户端决定画成物品还是纹理" wide>
            <input
              className="nav-mono"
              type="text"
              spellCheck={false}
              disabled={disabled}
              placeholder="minecraft:compass"
              value={typeof custom[NAV_DISPLAY_ICON] === 'string' ? String(custom[NAV_DISPLAY_ICON]) : ''}
              aria-label="display_icon"
              onChange={(event) => setCustom(NAV_DISPLAY_ICON, event.target.value)}
            />
          </Field>
        </div>
        <div className="nav-row">
          <Field label="display_min_distance" hint="0 表示不限">
            <input
              type="number"
              min={0}
              step="any"
              disabled={disabled}
              value={typeof custom[NAV_DISPLAY_MIN_DISTANCE] === 'number' ? String(custom[NAV_DISPLAY_MIN_DISTANCE]) : ''}
              aria-label="display_min_distance"
              onChange={(event) => setCustom(NAV_DISPLAY_MIN_DISTANCE, event.target.value === '' ? undefined : Number(event.target.value))}
            />
          </Field>
          <Field label="display_max_distance" hint="0 表示不限">
            <input
              type="number"
              min={0}
              step="any"
              disabled={disabled}
              value={typeof custom[NAV_DISPLAY_MAX_DISTANCE] === 'number' ? String(custom[NAV_DISPLAY_MAX_DISTANCE]) : ''}
              aria-label="display_max_distance"
              onChange={(event) => setCustom(NAV_DISPLAY_MAX_DISTANCE, event.target.value === '' ? undefined : Number(event.target.value))}
            />
          </Field>
        </div>
      </Section>

      {issues.length > 0 && (
        <ul className="nav-issues" role="status">
          {issues.map((issue) => <li key={issue}>{issue}</li>)}
        </ul>
      )}

      <Section title="引擎 JSON" hint="寻路与完成判定由其它系统负责">
        <pre className="nav-preview">{preview}</pre>
      </Section>
    </div>
  </div>
}
