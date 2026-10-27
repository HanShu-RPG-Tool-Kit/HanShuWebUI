import { TextField } from './Fields'
import { flowSubmissionIssue, type FlowSubmission } from './model'

/** Both progress and objective own one entry; embedded goals never own entries. */
export function SubmissionField({ value, required = false, progress = false, disabled = false, onChange }: {
  value?: FlowSubmission
  required?: boolean
  progress?: boolean
  disabled?: boolean
  onChange: (value: FlowSubmission | undefined) => void
}) {
  const issue = value ? flowSubmissionIssue(value) : required ? '需要交付，必须配置提交方式。' : null
  return <section className="node-form-section">
    <header><h2>提交</h2></header>
    <label className="flow-field"><span>提交方式</span><select aria-label="提交方式" disabled={disabled} value={value?.submit_type ?? ''} onChange={event => {
      const type = event.target.value
      onChange(type === 'ui' ? { submit_type: 'ui', param: null } : type === 'dialogue_injection' ? { submit_type: 'dialogue_injection', param: '' } : undefined)
    }}>
      <option value="">无需提交</option><option value="ui">UI</option><option value="dialogue_injection">对话注入点</option>
    </select></label>
    {value?.submit_type === 'dialogue_injection' && <TextField label="对话注入点" value={value.param} placeholder="例如 quest_submit，不带 @" disabled={disabled} onChange={param => onChange({ submit_type: 'dialogue_injection', param })} />}
    {value?.submit_type === 'ui' && <p className="flow-hint">由任务 UI 提供提交入口，无参数。</p>}
    <p className="flow-hint">{progress ? '进度只配置一个提交入口；提交进度时提交它的全部 goal，不按 goal 分别配置。' : '此提交入口只负责本目标持有的 goal。'}{value ? ' 条件满足后仍需实际提交成功才完成，提交未成功可以重试。' : ''}</p>
    {issue && <p className="progress-inline-warning" role="alert">{issue}</p>}
  </section>
}
