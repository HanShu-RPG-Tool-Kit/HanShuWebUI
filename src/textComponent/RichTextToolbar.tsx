import {useState} from 'react'
import {FEEDBACK_COLOR_SWATCHES,type FeedbackStyleKey,type FeedbackStylePatch} from './model'

const STYLE_TOGGLES: {
  key: FeedbackStyleKey
  label: string
  title: string
}[] = [
  { key: 'bold', label: 'B', title: '粗体' },
  { key: 'italic', label: 'I', title: '斜体' },
  { key: 'underlined', label: 'U', title: '下划线' },
  { key: 'strikethrough', label: 'S', title: '删除线' },
  { key: 'obfuscated', label: '§k', title: '混淆' },
]

function colorInputValue(color: string | undefined): string {
  if (color && /^#[0-9a-fA-F]{6}$/.test(color)) return color
  return '#FFFFFF'
}

export function RichTextToolbar({label,active,applyPatch,clearStyles}:{
  label:string
  active:{color?:string}&Partial<Record<FeedbackStyleKey,boolean>>
  applyPatch:(patch:FeedbackStylePatch)=>void
  clearStyles:()=>void
}) {
  const [hexDraft, setHexDraft] = useState<string | null>(null)
  return (
            <div
              className="kit-feedback-toolbar"
              onPointerDown={(event) => {
                if ((event.target as HTMLElement).tagName !== 'INPUT') event.preventDefault()
              }}
            >
              <label className="kit-feedback-color" title="颜色（hex）">
                <input
                  type="color"
                  aria-label={`${label} 颜色`}
                  value={colorInputValue(active.color)}
                  onChange={(event) =>
                    applyPatch({ color: event.target.value.toUpperCase() })
                  }
                />
                <input
                  className="kit-feedback-hex"
                  aria-label={`${label} hex`}
                  value={hexDraft ?? active.color ?? ''}
                  onFocus={() => setHexDraft(active.color ?? '')}
                  placeholder="#FFFFFF"
                  spellCheck={false}
                  onChange={(event) => {
                    const draft = event.target.value
                    setHexDraft(draft)
                    const raw = draft.trim()
                    if (!raw) applyPatch({ color: null })
                    else if (/^#[0-9a-fA-F]{6}$/.test(raw)) applyPatch({ color: raw.toUpperCase() })
                  }}
                  onBlur={(event) => {
                    const raw = event.target.value.trim()
                    if (!raw) applyPatch({ color: null })
                    else if (/^#[0-9a-fA-F]{6}$/.test(raw)) applyPatch({ color: raw.toUpperCase() })
                    setHexDraft(null)
                  }}
                />
              </label>
              <div
                className="kit-feedback-swatches"
                role="listbox"
                aria-label="命名色"
              >
                {FEEDBACK_COLOR_SWATCHES.map((swatch) => (
                  <button
                    key={swatch.id}
                    type="button"
                    role="option"
                    className={`kit-feedback-swatch${
                      active.color?.toUpperCase() === swatch.hex
                        ? ' is-active'
                        : ''
                    }`}
                    title={`${swatch.label} ${swatch.hex}`}
                    aria-label={swatch.label}
                    style={{ background: swatch.hex }}
                    onClick={() => applyPatch({ color: swatch.hex })}
                  />
                ))}
              </div>
              <div
                className="kit-feedback-toggles"
                role="group"
                aria-label="样式"
              >
                {STYLE_TOGGLES.map((toggle) => (
                  <button
                    key={toggle.key}
                    type="button"
                    className={`kit-feedback-toggle${
                      active[toggle.key] ? ' is-on' : ''
                    }`}
                    aria-pressed={active[toggle.key] === undefined ? 'mixed' : active[toggle.key]}
                    title={`${toggle.title}：${active[toggle.key] === undefined ? '继承' : active[toggle.key] ? '开启' : '关闭'}`}
                    onClick={() =>
                      applyPatch({
                        [toggle.key]: active[toggle.key] === undefined ? true : active[toggle.key] ? false : null,
                      })
                    }
                  >
                    {toggle.label}
                  </button>
                ))}
                <button
                  type="button"
                  className="kit-feedback-clear"
                  title="清除选区样式（未选中则清除全文）"
                  onClick={clearStyles}
                >
                  清除样式
                </button>
              </div>
            </div>
  )
}
