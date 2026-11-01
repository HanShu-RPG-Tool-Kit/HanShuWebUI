import { useState } from 'react'
import {
  BOSSBAR_LIMITS,
  BOSSBAR_NAME_PATTERN,
  BOSSBAR_VARIABLE_TYPES,
  type BossbarDocument,
  type BossbarValue,
  type BossbarValueMap,
  type BossbarVariable,
  type BossbarVariableType,
} from '../protocol'
import { removeVariable, renameVariable, upsertVariable, variableReferences } from '../document'
import { Button, Empty, NumberField, Row, Section, SelectField, TextField } from './BossbarEditorUi'
import { parseVariableInput, simulateVariable, variableSimulationMode, VARIABLE_TYPE_LABELS } from './editorState'
import { estimateSnapshotBytes } from '../rules/values'

/**
 * 变量面板。
 *
 * 声明服务端变量名、类型和默认值，
 * 并给出本机模拟值。long 用十进制文本输入，不经过浏览器数值控件。
 */

const TYPE_OPTIONS = BOSSBAR_VARIABLE_TYPES.map((type) => ({ value: type, label: VARIABLE_TYPE_LABELS[type] }))

function emptyVariable(type: BossbarVariableType): BossbarVariable {
  if (type === 'long') return { type: 'long', default: '0' }
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

  const commit = (next: BossbarDocument, errors: string[] = []) => {
    setProblems(errors)
    if (!errors.length) onDocumentChange(next)
  }

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
    commit(result.document)
    setPendingName('')
    const nextValues = { ...values }
    onValuesChange(nextValues)
  }

  return (
    <div className="bb-variables">
      <Section title="新增变量">
        <Row label="变量名">
          <TextField value={pendingName} onCommit={setPendingName} placeholder="healthProgress" disabled={readOnly} />
        </Row>
        <Row label="类型">
          <SelectField value={pendingType} options={TYPE_OPTIONS} onCommit={setPendingType} disabled={readOnly} />
        </Row>
        <Button disabled={readOnly} variant="primary" onClick={addVariable}>
          添加
        </Button>
      </Section>

      {problems.length > 0 && (
        <ul className="bb-problems">
          {problems.map((problem, index) => (
            <li key={index}>{problem}</li>
          ))}
        </ul>
      )}

      {names.length === 0 && <Empty>暂无变量</Empty>}

      {names.map((name) => (
        <VariableRow
          key={name}
          document={document}
          values={values}
          name={name}
          variable={document.variables[name]}
          value={values[name]}
          readOnly={readOnly}
          onDocumentChange={onDocumentChange}
          onValuesChange={onValuesChange}
          onSelectComponent={onSelectComponent}
          onProblems={setProblems}
        />
      ))}

      {names.length > 0 && <div className="bb-variable-budget">
        <span>数据预算</span>
        <span>{snapshot.worstBytes} / {BOSSBAR_LIMITS.upsertBudgetBytes} 字节</span>
      </div>}
    </div>
  )
}

function VariableRow({
  document,
  values,
  name,
  variable,
  value,
  readOnly,
  onDocumentChange,
  onValuesChange,
  onSelectComponent,
  onProblems,
}: {
  document: BossbarDocument
  values: BossbarValueMap
  name: string
  variable: BossbarVariable
  value: BossbarValue | undefined
  readOnly: boolean
  onDocumentChange: (next: BossbarDocument) => void
  onValuesChange: (values: BossbarValueMap) => void
  onSelectComponent: (id: string) => void
  onProblems: (problems: string[]) => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const references = variableReferences(document, name)

  const replace = (patch: Partial<BossbarVariable>) => {
    const next = { ...document, variables: { ...document.variables, [name]: { ...variable, ...patch } as BossbarVariable } }
    onDocumentChange(next)
  }

  const changeType = (type: BossbarVariableType) => {
    const target = emptyVariable(type)
    onDocumentChange({ ...document, variables: { ...document.variables, [name]: target } })
  }

  const simulationMode = variableSimulationMode(variable, value)

  const simulatedText = value
    ? value.type === 'long'
      ? value.value
      : value.type === 'double'
        ? String(value.value)
        : value.type === 'bool'
          ? String(value.value)
          : value.value
    : ''

  return (
    <div className="bb-variable">
      <div className="bb-variable-head">
        {renaming ? (
          <TextField
            value={name}
            disabled={readOnly}
            onCommit={(next) => {
              const trimmed = next.trim()
              if (trimmed && trimmed !== name) {
                const result = renameVariable(document, name, trimmed)
                if (!result.ok) {
                  onProblems(result.diagnostics.map((entry) => entry.path + '：' + entry.message))
                  return
                }
                onDocumentChange(result.document)
              }
              setRenaming(false)
            }}
          />
        ) : (
          <button type="button" className="bb-variable-name" onClick={() => !readOnly && setRenaming(true)}>
            {name}
            <em>{VARIABLE_TYPE_LABELS[variable.type]}</em>
          </button>
        )}
        <span className="bb-variable-refs">{references.length} 处引用</span>
      </div>
      <Row label="类型">
        <SelectField
          disabled={readOnly}
          value={variable.type}
          options={TYPE_OPTIONS}
          onCommit={changeType}
        />
      </Row>
      <Row label="默认值">
        {variable.type === 'bool' ? (
          <SelectField
            disabled={readOnly}
            value={variable.default ? 'true' : 'false'}
            options={[
              { value: 'false', label: 'false' },
              { value: 'true', label: 'true' },
            ]}
            onCommit={(next) => replace({ default: next === 'true' } as Partial<BossbarVariable>)}
          />
        ) : variable.type === 'long' ? (
          <TextField
            mono
            disabled={readOnly}
            value={variable.default}
            onCommit={(next) => {
              const parsed = parseVariableInput(variable, next)
              if (!parsed || parsed.type !== 'long') {
                onProblems(['long 默认值必须是 int64 范围内的十进制字符串'])
                return
              }
              replace({ default: parsed.value } as Partial<BossbarVariable>)
            }}
          />
        ) : variable.type === 'double' ? (
          <NumberField
            disabled={readOnly}
            value={variable.default}
            onCommit={(next) => replace({ default: next } as Partial<BossbarVariable>)}
          />
        ) : (
          <TextField
            disabled={readOnly}
            value={variable.default}
            onCommit={(next) => replace({ default: next } as Partial<BossbarVariable>)}
          />
        )}
      </Row>
      {variable.type === 'string' && (
        <Row label="最长字符数">
          <NumberField
            value={variable.maxLength}
            min={1}
            max={BOSSBAR_LIMITS.stringMaxLength}
            disabled={readOnly}
            onCommit={(maxLength) => replace({ maxLength: Math.round(maxLength) } as Partial<BossbarVariable>)}
          />
        </Row>
      )}
      <Row label="模拟状态">
        <SelectField
          value={simulationMode}
          options={[
            { value: 'value', label: '正常值' },
            { value: 'missing', label: '缺失变量' },
            { value: 'wrong-type', label: '类型不符' },
          ]}
          onCommit={(mode) => onValuesChange(simulateVariable(values, name, variable, mode))}
        />
      </Row>
      {simulationMode === 'value' ? <Row label="模拟值">
        <TextField
          mono
          value={simulatedText}
          onCommit={(next) => {
            const parsed = parseVariableInput(variable, next)
            if (!parsed) {
              onProblems(['模拟值与声明类型 ' + variable.type + ' 不符'])
              return
            }
            onValuesChange({ ...values, [name]: parsed })
          }}
        />
      </Row> : <p className="bb-hint">{simulationMode === 'missing' ? '服务端未提供此变量' : '传入类型与声明不符'}，预览使用默认值。</p>}
      {references.length > 0 && (
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
      )}
      <div className="bb-variable-actions">
        {confirmDelete ? (
          <>
            <span className="bb-warn">被 {references.length} 处引用，替换为同类型常量后删除？</span>
            <Button
              variant="danger"
              disabled={readOnly}
              onClick={() => {
                const replacement =
                  variable.type === 'long'
                    ? { long: '0' }
                    : variable.type === 'double'
                      ? { double: 0 }
                      : variable.type === 'bool'
                        ? { bool: false }
                        : { string: '' }
                const result = removeVariable(document, name, replacement)
                if (!result.ok) {
                  onProblems(result.diagnostics.map((entry) => entry.message))
                  return
                }
                onDocumentChange(result.document)
                setConfirmDelete(false)
              }}
            >
              替换后删除
            </Button>
            <Button onClick={() => setConfirmDelete(false)}>取消</Button>
          </>
        ) : (
          <Button
            variant="danger"
            disabled={readOnly}
            onClick={() => {
              if (references.length) {
                setConfirmDelete(true)
                return
              }
              const result = removeVariable(document, name)
              if (!result.ok) {
                onProblems(result.diagnostics.map((entry) => entry.message))
                return
              }
              onDocumentChange(result.document)
            }}
          >
            删除变量
          </Button>
        )}
      </div>
    </div>
  )
}
