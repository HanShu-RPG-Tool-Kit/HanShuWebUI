import {
  BOSSBAR_LIMITS,
  BOSSBAR_VARIABLE_TYPES,
  bossbarDiagnostic,
  defaultValueOf,
  isValueCompatible,
  type BossbarDiagnostic,
  type BossbarDocument,
  type BossbarValue,
  type BossbarValueMap,
  type BossbarVariable,
} from '../protocol'

/**
 * 变量取值。
 *
 * 输入是服务端发来的带类型标签的值。缺失、类型不符、
 * long 超范围、字符串超长一律回落到声明默认值，并发出一条诊断（调用方负责限频）。
 * 客户端只按声明读取，不做隐式类型转换。
 */

function isTypedValue(raw: unknown): raw is BossbarValue {
  if (!raw || typeof raw !== 'object') return false
  const record = raw as Record<string, unknown>
  if (typeof record.type !== 'string') return false
  if (!(BOSSBAR_VARIABLE_TYPES as readonly string[]).includes(record.type)) return false
  if (record.type === 'bool') return typeof record.value === 'boolean'
  if (record.type === 'double') return typeof record.value === 'number'
  return typeof record.value === 'string'
}

export function coerceValue(
  variable: BossbarVariable,
  raw: unknown,
): { value: BossbarValue; issue: BossbarDiagnostic | null } {
  const fallback = defaultValueOf(variable)
  if (raw === undefined || raw === null) {
    return {
      value: fallback,
      issue: bossbarDiagnostic('value_missing', '', '缺少值，使用默认值', 'warning'),
    }
  }
  if (!isTypedValue(raw)) {
    return {
      value: fallback,
      issue: bossbarDiagnostic('value_shape', '', '不是带类型标签的值，使用默认值', 'warning'),
    }
  }
  if (!isValueCompatible(variable, raw)) {
    return {
      value: fallback,
      issue: bossbarDiagnostic('value_type', '', '类型或长度与声明不符，使用默认值', 'warning'),
    }
  }
  return { value: raw, issue: null }
}

export type ResolvedValues = {
  values: BossbarValueMap
  issues: BossbarDiagnostic[]
}

/** 把所有声明变量补齐成一份完整投影；未声明的键被忽略（声明本身就是白名单） */
export function resolveValues(
  document: BossbarDocument,
  provided: Record<string, unknown> = {},
): ResolvedValues {
  const values: BossbarValueMap = {}
  const issues: BossbarDiagnostic[] = []
  for (const [name, variable] of Object.entries(document.variables ?? {})) {
    const result = coerceValue(variable, provided[name])
    values[name] = result.value
    if (result.issue) {
      issues.push({
        ...result.issue,
        path: 'variables.' + name,
        message: name + '：' + result.issue.message,
      })
    }
  }
  return { values, issues }
}

/** 单实例最坏快照大小估算：按声明 maxLength 与 long 定点宽度计算 */
export function estimateSnapshotBytes(document: BossbarDocument): {
  worstBytes: number
  perValue: { name: string; bytes: number }[]
} {
  const perValue: { name: string; bytes: number }[] = []
  for (const [name, variable] of Object.entries(document.variables ?? {})) {
    const nameBytes = new TextEncoder().encode(name).length
    let valueBytes = 0
    if (variable.type === 'string') valueBytes = variable.maxLength * 4
    else if (variable.type === 'long') valueBytes = 20
    else if (variable.type === 'double') valueBytes = 8
    else valueBytes = 1
    perValue.push({ name, bytes: nameBytes + valueBytes + 6 })
  }
  const worstBytes = perValue.reduce((sum, entry) => sum + entry.bytes, 32)
  return { worstBytes, perValue }
}

export { BOSSBAR_LIMITS }
