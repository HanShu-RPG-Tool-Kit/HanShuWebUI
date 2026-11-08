import { type ReactNode } from 'react'
import { NAV_LABEL_KEY } from './progressLocale'
import {
  stringifyNavigationPoint,
  validateNavigationPoint,
  type NavigationPoint,
} from './navigationPoint'
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

export function NavigationEditor({ point, error, disabled, onChange, levelOptions, landmarkOptions, resolveText, setText }: {
  point: NavigationPoint
  error?: string
  disabled?: boolean
  onChange: (source: string) => void
  levelOptions?: readonly { id: string; label: string }[]
  /** 各地图模板里已有的地标。ref 为运行时 ID `<模板>$<地标>`。 */
  landmarkOptions?: readonly { level: string; ref: string; label: string }[]
  /** 显示名在 lang_nav，不写进 .nav。 */
  resolveText?: (key: string) => string
  setText?: (key: string, value: string) => void
}) {
  const update = (next: NavigationPoint) => onChange(stringifyNavigationPoint(next))
  const issues = validateNavigationPoint(point)
  const levels = levelOptions ?? []
  const landmarks = (landmarkOptions ?? []).filter((item) => item.level === point.level)
  const preview = stringifyNavigationPoint(point).trimEnd()

  return <div className="nav-editor">
    <div className="nav-page">
      {error && <p className="nav-banner is-error" role="alert">无法完整解析导航器，已显示可编辑兜底。{error}</p>}

      <Section
        title="追踪"
        hint="导航器只引用地标，坐标写在地图模板里"
        action={<span className={`nav-status${issues.length ? ' is-warn' : ' is-ok'}`}>{issues.length ? `${issues.length} 项待完善` : '可用'}</span>}
      >
        <div className="nav-row">
          {(resolveText || setText) && (
            <Field label="显示名" hint="lang_nav / display_name">
              <input
                type="text"
                disabled={disabled || !setText}
                aria-label="导航器显示名"
                value={resolveText?.(NAV_LABEL_KEY) ?? ''}
                onChange={(event) => setText?.(NAV_LABEL_KEY, event.target.value)}
              />
            </Field>
          )}
          <Field label="id" hint="建议与文件名一致">
            <input
              className="nav-mono"
              type="text"
              disabled={disabled}
              value={point.id}
              aria-label="导航器 id"
              onChange={(event) => update({ ...point, id: event.target.value })}
            />
          </Field>
          <Field label="所属地图" hint="必填：level" wide>
            <select
              disabled={disabled}
              value={point.level}
              aria-label="所属地图模板"
              onChange={(event) => {
                const level = event.target.value
                const ref = point.track.ref.startsWith(`${level}$`) ? point.track.ref : ''
                update({ ...point, level, track: { type: 'landmark', ref } })
              }}
            >
              <option value="">（未选择）</option>
              {levels.map((level) => <option key={level.id} value={level.id}>{level.label}</option>)}
              {point.level && !levels.some((level) => level.id === point.level) && <option value={point.level}>{point.level}（未找到模板）</option>}
            </select>
          </Field>
        </div>
        <Field label="地标" hint="track.ref" wide>
          <select
            disabled={disabled || !point.level}
            value={point.track.ref}
            aria-label="追踪的地标"
            onChange={(event) => update({ ...point, track: { type: 'landmark', ref: event.target.value } })}
          >
            <option value="">（未选择）</option>
            {landmarks.map((item) => <option key={item.ref} value={item.ref}>{item.label}</option>)}
            {point.track.ref && !landmarks.some((item) => item.ref === point.track.ref) && (
              <option value={point.track.ref}>{point.track.ref}（未找到地标）</option>
            )}
          </select>
        </Field>
        <p className="nav-hint">不能在这里写坐标。到没到由别的流程判断，导航只给出方向和距离。</p>
      </Section>

      {issues.length > 0 && (
        <ul className="nav-issues" role="status">
          {issues.map((issue) => <li key={issue}>{issue}</li>)}
        </ul>
      )}

      <Section title="作者 JSON" hint="只留在工程里，不写入 PAK">
        <pre className="nav-preview">{preview}</pre>
      </Section>
    </div>
  </div>
}
