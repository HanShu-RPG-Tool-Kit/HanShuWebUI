import { useState } from 'react'
import {
  BOSSBAR_LIMITS,
  BOSSBAR_NAME_PATTERN,
  BOSSBAR_VARIABLE_TYPES,
  isValueCompatible,
  type BossbarDocument,
  type BossbarValue,
  type BossbarValueMap,
  type BossbarVariable,
  type BossbarVariableType,
} from '../protocol'
import { removeVariable, renameVariable, upsertVariable, variableReferences } from '../document'
import { Button, Empty, NumberField, SelectField, TextField } from './BossbarEditorUi'
import { parseVariableInput } from './editorState'
import { estimateSnapshotBytes } from '../rules/values'

/**
 * 变量面板：紧凑列表，列 类型 | 名字 | 默认值 | 模拟值。
 * 前三列写文档；模拟值只写本机预览 values，只读成员也可改。
 */

const TYPE_OPTIONS = BOSSBAR_VARIABLE_TYPES.map((type) => ({
  value: type,
  label: type === 'double' ? '浮点' : type === 'bool' ? '布尔' : '文本',
}))
const BOOL_OPTIONS = [
  { value: 'false', label: 'false' },
  { value: 'true', label: 'true' },
] as const

function emptyVariable(type: BossbarVariableType): BossbarVariable {
  if (type === 'double') return { type: 'double', default: 0 }
  if (type === 'bool') return { type: 'bool', default: false }
  return { type: 'string', default: '', maxLength: 64 }
}

export function BossbarVariablesPanel({
  document,
  values,
  readOnly,
  onDocumentChange,
  onValuesChange,
  onSelectComponent,
}: {
  document: BossbarDocument
  values: BossbarValueMap
  readOnly: boolean
  onDocumentChange: (next: BossbarDocument) => void
  onValuesChange: (values: BossbarValueMap) => void
  onSelectComponent: (id: string) => void
}) {
  const [pendingName, setPendingName] = useState('')
  const [pendingType, setPendingType] = useState<BossbarVariableType>('double')
  const [problems, setProblems] = useState<string[]>([])

  const names = Object.keys(document.variables).sort()
  const snapshot = estimateSnapshotBytes(document)

  const addVariable = () => {
    const name = pendingName.trim()
    if (!BOSSBAR_NAME_PATTERN.test(name)) {
      setProblems(['变量名需匹配 [A-Za-z][A-Za-z0-9_]{0,63}'])
      return
    }
    if (name in document.variables) {
      setProblems(['变量名已存在：' + name])
      return
    }
    const result = upsertVariable(document, name, emptyVariable(pendingType))
    if (!result.ok) {
      setProblems(result.diagnostics.map((entry) => entry.message))
      return
    }
    setProblems([])
    onDocumentChange(result.document)
    setPendingName('')
  }

  return (
    <div className="bb-variables">
      {!readOnly && (
        <div className="bb-var-add">
          <SelectField label="新变量类型" value={pendingType} options={TYPE_OPTIONS} onCommit={setPendingType} />
          <TextField label="新变量名" value={pendingName} onCommit={setPendingName} placeholder="变量名" />
          <Button variant="primary" onClick={addVariable}>
            添加
          </Button>
        </div>
      )}

      {problems.length > 0 && (
        <ul className="bb-problems">
          {problems.map((problem, index) => (
            <li key={index}>{problem}</li>
          ))}
        </ul>
      )}

      {names.length === 0 ? (
        <Empty>暂无变量</Empty>
      ) : (
        <div className="bb-var-table" role="table" aria-label="变量列表">
          <div className="bb-var-row bb-var-header" role="row">
            <span role="columnheader">类型</span>
            <span role="columnheader">名字</span>
            <span role="columnheader">默认值</span>
            <span role="columnheader">模拟值</span>
            <span role="columnheader" />
          </div>
          {names.map((name) => (
            <VariableRow
              key={name}
              document={document}
              name={name}
              variable={document.variables[name]}
              value={values[name]}
              values={values}
              readOnly={readOnly}
              onDocumentChange={onDocumentChange}
              onValuesChange={onValuesChange}
              onSelectComponent={onSelectComponent}
              onProblems={setProblems}
            />
          ))}
        </div>
      )}

      {names.length > 0 && (
        <div className="bb-variable-budget">
          <span>数据预算</span>
          <span>
            {snapshot.worstBytes} / {BOSSBAR_LIMITS.upsertBudgetBytes} 字节
          </span>
        </div>
      )}
    </div>
  )
}

function VariableRow({
  document,
  name,
  variable,
  value,
  values,
  readOnly,
  onDocumentChange,
  onValuesChange,
  onSelectComponent,
  onProblems,
}: {
  document: BossbarDocument
  name: string
  variable: BossbarVariable
  value: BossbarValue | undefined
  values: BossbarValueMap
  readOnly: boolean
  onDocumentChange: (next: BossbarDocument) => void
  onValuesChange: (values: BossbarValueMap) => void
  onSelectComponent: (id: string) => void
  onProblems: (problems: string[]) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const references = variableReferences(document, name)
  const simulated = value && isValueCompatible(variable, value) ? value.value : variable.default

  const replace = (patch: Partial<BossbarVariable>) => {
    onDocumentChange({
      ...document,
      variables: { ...document.variables, [name]: { ...variable, ...patch } as BossbarVariable },
    })
  }

  const rename = (next: string) => {
    const trimmed = next.trim()
    if (!trimmed || trimmed === name) return
    const result = renameVariable(document, name, trimmed)
    if (!result.ok) {
      onProblems(result.diagnostics.map((entry) => entry.path + '：' + entry.message))
      return
    }
    onProblems([])
    onDocumentChange(result.document)
  }

  const simulate = (raw: string) => {
    const parsed = parseVariableInput(variable, raw)
    if (!parsed) {
      onProblems([name + ' 的模拟值与类型 ' + variable.type + ' 不符'])
      return
    }
    onProblems([])
    onValuesChange({ ...values, [name]: parsed })
  }

  const remove = (replaceReferences: boolean) => {
    const replacement =
      variable.type === 'double' ? { double: 0 } : variable.type === 'bool' ? { bool: false } : { string: '' }
    const result = replaceReferences ? removeVariable(document, name, replacement) : removeVariable(document, name)
    if (!result.ok) {
      onProblems(result.diagnostics.map((entry) => entry.message))
      return
    }
    onDocumentChange(result.document)
    setConfirmDelete(false)
  }

  return (
    <div className={'bb-var-item' + (expanded ? ' is-open' : '')}>
      <div className="bb-var-row" role="row">
        <SelectField
          label={name + ' 类型'}
          disabled={readOnly}
          value={variable.type}
          options={TYPE_OPTIONS}
          onCommit={(type) =>
            onDocumentChange({ ...document, variables: { ...document.variables, [name]: emptyVariable(type) } })
          }
        />
        <TextField label={name + ' 名字'} mono value={name} disabled={readOnly} onCommit={rename} />
        {variable.type === 'bool' ? (
          <SelectField
            label={name + ' 默认值'}
            disabled={readOnly}
            value={variable.default ? 'true' : 'false'}
            options={BOOL_OPTIONS}
            onCommit={(next) => replace({ default: next === 'true' } as Partial<BossbarVariable>)}
          />
        ) : variable.type === 'double' ? (
          <NumberField
            label={name + ' 默认值'}
            disabled={readOnly}
            value={variable.default}
            onCommit={(next) => replace({ default: next } as Partial<BossbarVariable>)}
          />
        ) : (
          <TextField
            label={name + ' 默认值'}
            disabled={readOnly}
            value={variable.default}
            onCommit={(next) => replace({ default: next } as Partial<BossbarVariable>)}
          />
        )}
        <span className="bb-var-sim">
          {variable.type === 'bool' ? (
            <SelectField label={name + ' 模拟值'} value={simulated ? 'true' : 'false'} options={BOOL_OPTIONS} onCommit={simulate} />
          ) : (
            <TextField label={name + ' 模拟值'} mono value={String(simulated)} onCommit={simulate} />
          )}
        </span>
        <button
          type="button"
          className={'bb-var-more' + (expanded ? ' is-open' : '') + (references.length ? ' has-refs' : '')}
          aria-expanded={expanded}
          title={references.length ? references.length + ' 处引用' : '更多'}
          onClick={() => setExpanded(!expanded)}
        >
          {references.length > 0 ? references.length : '⋯'}
        </button>
      </div>
      {expanded && (
        <div className="bb-var-detail">
          {variable.type === 'string' && (
            <label className="bb-var-inline">
              <span>最长字符</span>
              <NumberField
                value={variable.maxLength}
                min={1}
                max={BOSSBAR_LIMITS.stringMaxLength}
                disabled={readOnly}
                onCommit={(maxLength) => replace({ maxLength: Math.round(maxLength) } as Partial<BossbarVariable>)}
              />
            </label>
          )}
          {references.length > 0 ? (
            <ul className="bb-refs">
              {references.slice(0, 6).map((reference) => (
                <li key={reference.path}>
                  <button type="button" onClick={() => onSelectComponent(reference.componentId)}>
                    {reference.componentId}
                  </button>
                  <code>{reference.path}</code>
                </li>
              ))}
              {references.length > 6 && <li>…还有 {references.length - 6} 处</li>}
            </ul>
          ) : (
            <span className="bb-var-note">未被引用</span>
          )}
          {!readOnly && (
            <div className="bb-variable-actions">
              {confirmDelete ? (
                <>
                  <span className="bb-warn">被 {references.length} 处引用，替换为同类型常量后删除？</span>
                  <Button variant="danger" onClick={() => remove(true)}>
                    替换后删除
                  </Button>
                  <Button onClick={() => setConfirmDelete(false)}>取消</Button>
                </>
              ) : (
                <Button variant="danger" onClick={() => (references.length ? setConfirmDelete(true) : remove(false))}>
                  删除变量
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
