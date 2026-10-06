import { type ReactNode } from 'react'
import {
  NAV_LABEL_MAX,
  NAV_RADIUS_MAX,
  NAV_RADIUS_MIN,
  NAV_SCAN_RADIUS_DEFAULT,
  NAV_SCAN_RADIUS_MAX,
  NAV_SCAN_RADIUS_MIN,
  NAV_TAG_MAX,
  stringifyNavigationPoint,
  validateNavigationPoint,
  type NavigationEntityMode,
  type NavigationPoint,
  type NavigationPointType,
} from './navigationPoint'
import './NavigationEditor.css'

const TYPE_OPTIONS: { value: NavigationPointType; label: string }[] = [
  { value: 'position', label: '固定坐标' },
  { value: 'entity', label: '绑定实体' },
]

const ENTITY_OPTIONS: { value: NavigationEntityMode; label: string }[] = [
  { value: 'tag', label: '实体 tag' },
  { value: 'uuid', label: '实体 UUID' },
]

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

export function NavigationEditor({ point, error, disabled, onChange }: {
  point: NavigationPoint
  error?: string
  disabled?: boolean
  onChange: (source: string) => void
}) {
  const update = (patch: Partial<NavigationPoint>) => onChange(stringifyNavigationPoint({ ...point, ...patch }))
  const issues = validateNavigationPoint(point)
  const preview = stringifyNavigationPoint(point).trimEnd()
  const isPosition = point.type === 'position'

  return <div className="nav-editor">
    <div className="nav-page">
      {error && <p className="nav-banner is-error" role="alert">无法完整解析导航点草稿，已显示可编辑兜底。{error}</p>}

      <Section
        title="基本信息"
        hint="导航点只描述「指哪里」"
        action={<span className={`nav-status${issues.length ? ' is-warn' : ' is-ok'}`}>{issues.length ? `${issues.length} 项待完善` : '可用'}</span>}
      >
        <div className="nav-row">
          <Field label="label" hint={`显示名称，≤ ${NAV_LABEL_MAX}`} wide>
            <input
              type="text"
              disabled={disabled}
              value={point.label}
              maxLength={NAV_LABEL_MAX}
              placeholder="例如：旧塔"
              aria-label="label"
              onChange={(event) => update({ label: event.target.value })}
            />
          </Field>
          <Field label="追踪类型" hint="可扩展">
            <select
              disabled={disabled}
              value={point.type}
              aria-label="追踪类型"
              onChange={(event) => update({ type: event.target.value as NavigationPointType })}
            >
              {TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </Field>
        </div>
      </Section>

      {isPosition ? (
        <Section title="坐标" hint="绝对值 ≤ 30,000,000">
          <Field label="维度" hint="必填" wide>
            <input
              className="nav-mono"
              type="text"
              spellCheck={false}
              disabled={disabled}
              placeholder="minecraft:overworld"
              value={point.dimension}
              onChange={(event) => update({ dimension: event.target.value })}
            />
          </Field>
          <div className="nav-coords">
            {(['x', 'y', 'z'] as const).map((axis) => (
              <label key={axis} className={`nav-coord is-${axis}`}>
                <b>{axis.toUpperCase()}</b>
                <input
                  type="number"
                  step="any"
                  disabled={disabled}
                  value={point[axis]}
                  aria-label={`${axis.toUpperCase()} 坐标`}
                  onChange={(event) => update({ [axis]: Number(event.target.value) })}
                />
              </label>
            ))}
          </div>
        </Section>
      ) : (
        <Section title="目标实体" hint="tag 与 UUID 二选一">
          <div className="nav-segment" role="radiogroup" aria-label="实体匹配方式">
            {ENTITY_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={point.entityMode === option.value}
                className={point.entityMode === option.value ? 'is-active' : ''}
                disabled={disabled}
                onClick={() => update({ entityMode: option.value })}
              >
                {option.label}
              </button>
            ))}
          </div>
          {point.entityMode === 'tag' ? (
            <>
              <Field label="entity_tag" hint={`原版实体命令 tag，≤ ${NAV_TAG_MAX} 字符；应全局唯一，否则会 AMBIGUOUS`} wide>
                <input
                  className="nav-mono"
                  type="text"
                  spellCheck={false}
                  disabled={disabled}
                  maxLength={NAV_TAG_MAX}
                  placeholder="quest_source:quartermaster"
                  value={point.entityTag}
                  onChange={(event) => update({ entityTag: event.target.value })}
                />
              </Field>
              <Field label="扫描半径" hint={`默认 ${NAV_SCAN_RADIUS_DEFAULT}；在周围 ${NAV_SCAN_RADIUS_MIN}–${NAV_SCAN_RADIUS_MAX} 格内找 tag`}>
                <div className="nav-radius">
                  <input
                    type="range"
                    min={NAV_SCAN_RADIUS_MIN}
                    max={NAV_SCAN_RADIUS_MAX}
                    step={1}
                    disabled={disabled}
                    value={point.scanRadius}
                    aria-label="扫描半径滑块"
                    onChange={(event) => update({ scanRadius: Number(event.target.value) })}
                  />
                  <input
                    className="nav-radius-num"
                    type="number"
                    min={NAV_SCAN_RADIUS_MIN}
                    max={NAV_SCAN_RADIUS_MAX}
                    step={1}
                    disabled={disabled}
                    value={point.scanRadius}
                    aria-label="扫描半径"
                    onChange={(event) => update({ scanRadius: Number(event.target.value) })}
                  />
                </div>
              </Field>
            </>
          ) : (
            <Field label="entity_uuid" hint="标准 UUID 格式" wide>
              <input
                className="nav-mono"
                type="text"
                spellCheck={false}
                disabled={disabled}
                placeholder="00000000-0000-0000-0000-000000000001"
                value={point.entityUuid}
                onChange={(event) => update({ entityUuid: event.target.value })}
              />
            </Field>
          )}
          <Field label="限定维度" hint="可选；留空则在所有维度查找" wide>
            <input
              className="nav-mono"
              type="text"
              spellCheck={false}
              disabled={disabled}
              placeholder="不限"
              value={point.dimension}
              onChange={(event) => update({ dimension: event.target.value })}
            />
          </Field>
        </Section>
      )}

      <Section title="展示">
        <div className="nav-row">
          <Field label="接近半径" hint={`${NAV_RADIUS_MIN}–${NAV_RADIUS_MAX} 格，仅客户端提示`}>
            <div className="nav-radius">
              <input
                type="range"
                min={NAV_RADIUS_MIN}
                max={NAV_RADIUS_MAX}
                step={1}
                disabled={disabled}
                value={point.radius}
                aria-label="接近半径滑块"
                onChange={(event) => update({ radius: Number(event.target.value) })}
              />
              <input
                className="nav-radius-num"
                type="number"
                min={NAV_RADIUS_MIN}
                max={NAV_RADIUS_MAX}
                step={1}
                disabled={disabled}
                value={point.radius}
                aria-label="接近半径"
                onChange={(event) => update({ radius: Number(event.target.value) })}
              />
            </div>
          </Field>
          <div className="nav-field">
            <span className="nav-field-label">公开<em>开启后普通玩家可自选</em></span>
            <button
              type="button"
              role="switch"
              aria-checked={point.public}
              className={`nav-switch${point.public ? ' is-on' : ''}`}
              disabled={disabled}
              onClick={() => update({ public: !point.public })}
            >
              <i aria-hidden />
              <span>{point.public ? '公开' : '不公开'}</span>
            </button>
          </div>
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
