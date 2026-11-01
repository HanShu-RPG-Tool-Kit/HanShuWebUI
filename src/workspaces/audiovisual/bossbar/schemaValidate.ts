/**
 * 极小的 JSON Schema 子集校验器，只为 BossBar v2 服务。
 *
 * 需要它而不是引一个通用实现的原因：错误信息要直接给人看（中文、带字段路径），
 * 而项目里没有 JSON Schema 依赖。支持的字段就是 `schema.ts` 用到的那些；
 * 遇到没实现的构造会直接抛错，避免"看起来通过"。
 */

export type SchemaIssue = {
  /** 文档内字段路径，例如 components[2].box.width */
  path: string
  code: string
  message: string
}

type SchemaNode = boolean | Record<string, unknown>

function joinPath(path: string, key: string | number): string {
  if (typeof key === 'number') return path + '[' + key + ']'
  return path ? path + '.' + key : key
}

function typeNameOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return '数组'
  if (typeof value === 'number') return Number.isInteger(value) ? '整数' : '数值'
  if (typeof value === 'string') return '字符串'
  if (typeof value === 'boolean') return '布尔值'
  if (typeof value === 'object') return '对象'
  return typeof value
}

function describeSchema(schema: Record<string, unknown>): string {
  if (typeof schema.title === 'string') return schema.title
  if (schema.const !== undefined) return JSON.stringify(schema.const)
  if (Array.isArray(schema.enum)) return schema.enum.map((v) => String(v)).join(' / ')
  if (typeof schema.type === 'string') {
    return schema.type === 'integer' ? '整数' : String(schema.type)
  }
  if (schema.oneOf) return '规定的形式之一'
  return '规定的形式'
}

function matchesType(value: unknown, type: unknown): boolean {
  switch (type) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      throw new Error('不支持的 schema type: ' + String(type))
  }
}

export function validateAgainstSchema(
  value: unknown,
  schema: SchemaNode,
  basePath = '',
): SchemaIssue[] {
  if (schema === true) return []
  if (schema === false) return [{ path: basePath, code: 'forbidden', message: '该字段不允许出现' }]
  if (typeof schema !== 'object') throw new Error('非法 schema 节点')

  const issues: SchemaIssue[] = []
  const node = schema as Record<string, unknown>

  if (node.$ref !== undefined) throw new Error('本校验器不支持 $ref')

  if (node.type !== undefined && !matchesType(value, node.type)) {
    issues.push({
      path: basePath,
      code: 'type',
      message: '必须是' + describeSchema(node) + '，实际是' + typeNameOf(value),
    })
    return issues
  }

  if (node.const !== undefined && value !== node.const) {
    issues.push({
      path: basePath,
      code: 'const',
      message: '必须是 ' + JSON.stringify(node.const),
    })
  }

  if (Array.isArray(node.enum) && !node.enum.some((entry) => entry === value)) {
    issues.push({
      path: basePath,
      code: 'enum',
      message:
        '必须是 ' + node.enum.map((v) => String(v)).join(' / ') + ' 之一，实际是 ' + JSON.stringify(value),
    })
  }

  if (typeof value === 'number') {
    if (typeof node.minimum === 'number' && value < node.minimum) {
      issues.push({ path: basePath, code: 'minimum', message: '不能小于 ' + node.minimum })
    }
    if (typeof node.maximum === 'number' && value > node.maximum) {
      issues.push({ path: basePath, code: 'maximum', message: '不能大于 ' + node.maximum })
    }
    if (typeof node.exclusiveMinimum === 'number' && value <= node.exclusiveMinimum) {
      issues.push({
        path: basePath,
        code: 'exclusiveMinimum',
        message: '必须大于 ' + node.exclusiveMinimum,
      })
    }
    if (typeof node.exclusiveMaximum === 'number' && value >= node.exclusiveMaximum) {
      issues.push({
        path: basePath,
        code: 'exclusiveMaximum',
        message: '必须小于 ' + node.exclusiveMaximum,
      })
    }
  }

  if (typeof value === 'string') {
    const length = [...value].length
    if (typeof node.minLength === 'number' && length < node.minLength) {
      issues.push({ path: basePath, code: 'minLength', message: '长度不能少于 ' + node.minLength })
    }
    if (typeof node.maxLength === 'number' && length > node.maxLength) {
      issues.push({ path: basePath, code: 'maxLength', message: '长度不能超过 ' + node.maxLength })
    }
    if (typeof node.pattern === 'string' && !new RegExp(node.pattern, 'u').test(value)) {
      issues.push({
        path: basePath,
        code: 'pattern',
        message: '格式不正确（应匹配 ' + node.pattern + '）',
      })
    }
  }

  if (Array.isArray(value)) {
    if (typeof node.minItems === 'number' && value.length < node.minItems) {
      issues.push({ path: basePath, code: 'minItems', message: '至少需要 ' + node.minItems + ' 项' })
    }
    if (typeof node.maxItems === 'number' && value.length > node.maxItems) {
      issues.push({ path: basePath, code: 'maxItems', message: '最多只能有 ' + node.maxItems + ' 项' })
    }
    if (node.items !== undefined) {
      const itemSchema = node.items as SchemaNode
      value.forEach((entry, index) => {
        issues.push(...validateAgainstSchema(entry, itemSchema, joinPath(basePath, index)))
      })
    }
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
    if (typeof node.minProperties === 'number' && keys.length < node.minProperties) {
      issues.push({
        path: basePath,
        code: 'minProperties',
        message: '至少需要 ' + node.minProperties + ' 个字段',
      })
    }
    if (typeof node.maxProperties === 'number' && keys.length > node.maxProperties) {
      issues.push({
        path: basePath,
        code: 'maxProperties',
        message: '最多只能有 ' + node.maxProperties + ' 个字段',
      })
    }
    const propertyNames = node.propertyNames as Record<string, unknown> | undefined
    if (propertyNames && typeof propertyNames.pattern === 'string') {
      const pattern = new RegExp(propertyNames.pattern, 'u')
      for (const key of keys) {
        if (!pattern.test(key)) {
          issues.push({
            path: joinPath(basePath, key),
            code: 'propertyNames',
            message: '字段名不合法（应匹配 ' + propertyNames.pattern + '）',
          })
        }
      }
    }
    if (Array.isArray(node.required)) {
      for (const key of node.required as string[]) {
        if (!(key in record)) {
          issues.push({
            path: joinPath(basePath, key),
            code: 'required',
            message: '缺少必需字段 ' + key,
          })
        }
      }
    }
    const properties = (node.properties ?? {}) as Record<string, SchemaNode>
    for (const [key, childSchema] of Object.entries(properties)) {
      if (!(key in record)) continue
      issues.push(...validateAgainstSchema(record[key], childSchema, joinPath(basePath, key)))
    }
    if (node.additionalProperties !== undefined) {
      const extra = (node.additionalProperties ?? true) as SchemaNode
      for (const key of keys) {
        if (key in properties) continue
        if (extra === false) {
          issues.push({
            path: joinPath(basePath, key),
            code: 'unknown_field',
            message: '未知字段 ' + key,
          })
        } else {
          issues.push(...validateAgainstSchema(record[key], extra, joinPath(basePath, key)))
        }
      }
    }
  }

  if (Array.isArray(node.allOf)) {
    for (const branch of node.allOf as SchemaNode[]) {
      issues.push(...validateAgainstSchema(value, branch, basePath))
    }
  }

  if (Array.isArray(node.anyOf)) {
    const branches = node.anyOf as SchemaNode[]
    if (!branches.some((branch) => validateAgainstSchema(value, branch, basePath).length === 0)) {
      issues.push(...bestBranch(value, branches, basePath, 'anyOf', node))
    }
  }

  if (Array.isArray(node.oneOf)) {
    const branches = node.oneOf as SchemaNode[]
    const matches = branches.filter(
      (branch) => validateAgainstSchema(value, branch, basePath).length === 0,
    )
    if (matches.length === 0) {
      issues.push(...bestBranch(value, branches, basePath, 'oneOf', node))
    } else if (matches.length > 1) {
      issues.push({
        path: basePath,
        code: 'oneOf',
        message: '同时匹配了多种形式，请只保留一种',
      })
    }
  }

  if (node.not !== undefined) {
    if (validateAgainstSchema(value, node.not as SchemaNode, basePath).length === 0) {
      issues.push({ path: basePath, code: 'not', message: '不允许这种取值' })
    }
  }

  return issues
}

/** 分支全部失败时，优先抛出最接近的那个分支的具体错误，而不是笼统的"形式之一" */
function bestBranch(
  value: unknown,
  branches: SchemaNode[],
  basePath: string,
  keyword: string,
  node: Record<string, unknown>,
): SchemaIssue[] {
  let best: SchemaIssue[] | null = null
  for (const branch of branches) {
    const issues = validateAgainstSchema(value, branch, basePath)
    if (!issues.length) continue
    if (!best || issues.length < best.length) best = issues
  }
  if (best && best.length <= 3) return best
  return [
    {
      path: basePath,
      code: keyword,
      message:
        '必须是以下形式之一：' +
        branches.map((branch) => describeSchema(branch as Record<string, unknown>)).join('、') +
        '（' +
        (node.title ? String(node.title) : JSON.stringify(value).slice(0, 60)) +
        '）',
    },
  ]
}
