/** HanShu Typed NBT JSON, version 1. This is a value format, not a component schema. */
export const NBT_TYPES = ['byte', 'short', 'int', 'long', 'float', 'double', 'string', 'list', 'compound', 'byte_array', 'int_array', 'long_array'] as const
export type NbtType = typeof NBT_TYPES[number]
export type NbtValue =
  | { type: 'byte' | 'short' | 'int'; value: number }
  | { type: 'long' | 'float' | 'double' | 'string'; value: string }
  | { type: 'list'; value: NbtValue[] }
  | { type: 'compound'; value: Record<string, NbtValue> }
  | { type: 'byte_array' | 'int_array'; value: number[] }
  | { type: 'long_array'; value: string[] }
export type ItemComponents = Record<string, NbtValue>
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const ranges = {byte: [-128, 127], short: [-32768, 32767], int: [-2147483648, 2147483647]} as const
const decimal = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/
export function defaultNbt(type: NbtType): NbtValue {
  if (type === 'compound') return {type, value: {}}
  if (type === 'list' || type.endsWith('_array')) return {type, value: []} as NbtValue
  if (type === 'string') return {type, value: ''}
  return {type, value: ['long','float','double'].includes(type) ? '0' : 0} as NbtValue
}
export function readNbt(value: unknown, path = 'nbt', depth = 0): NbtValue {
  const fail = (message: string): never => { throw new Error(`${path}: ${message}`) }
  if (depth > 32) fail('NBT 嵌套超过 32 层')
  if (!object(value) || !NBT_TYPES.includes(value.type as NbtType) || !Object.hasOwn(value, 'value') || Object.keys(value).some(k => k !== 'type' && k !== 'value')) return fail('需要 TNBT JSON {type, value}')
  const type = value.type as NbtType, raw = value.value
  switch (type) {
    case 'byte': case 'short': case 'int': {
      const [min,max] = ranges[type]
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) return fail(`${type} 需要 ${min}..${max} 的整数`)
      return {type, value: raw}
    }
    case 'long':
      if (typeof raw !== 'string' || raw.length > 20 || !/^-?(?:0|[1-9]\d*)$/.test(raw)) return fail('long 需要十进制整数字符串')
      if (BigInt(raw) < -9223372036854775808n || BigInt(raw) > 9223372036854775807n) return fail('long 超出有符号 64 位范围')
      return {type, value: BigInt(raw).toString()}
    case 'float': case 'double': {
      if (typeof raw !== 'string' || (!decimal.test(raw) && !['NaN','Infinity','-Infinity'].includes(raw))) return fail(`${type} 需要数值字符串`)
      const n = Number(raw), rounded = type === 'float' ? Math.fround(n) : n
      if (decimal.test(raw) && !Number.isFinite(rounded)) return fail(`${type} 数值溢出，请明确使用 Infinity`)
      return {type, value: Object.is(rounded,-0) ? '-0' : String(rounded)}
    }
    case 'string':
      if (typeof raw !== 'string') return fail('string 需要字符串')
      return {type,value:raw}
    case 'compound':
      if (!object(raw)) return fail('compound 需要对象')
      return {type, value:Object.fromEntries(Object.entries(raw).map(([k,v])=>[k,readNbt(v,`${path}.${k}`,depth+1)]))}
    case 'list':
      if (!Array.isArray(raw)) return fail('list 需要数组')
      return {type,value:raw.map((v,i)=>readNbt(v,`${path}[${i}]`,depth+1))}
    default: {
      if (!Array.isArray(raw)) return fail(`${type} 需要数组`)
      const element = type === 'byte_array' ? 'byte' : type === 'int_array' ? 'int' : 'long'
      return {type,value:raw.map((v,i)=>readNbt({type:element,value:v},`${path}[${i}]`,depth+1).value)} as NbtValue
    }
  }
}
export function readComponents(value: unknown, path = 'components'): ItemComponents {
  if (!object(value)) throw new Error(`${path} 应为完整组件集合对象`)
  return Object.fromEntries(Object.entries(value).map(([id,v])=> {
    if (!/^[a-z0-9_.-]+:[a-z0-9/._-]+$/.test(id)) throw new Error(`${path}.${id}: 需要完整的命名空间组件 ID`)
    return [id,readNbt(v,`${path}.${id}`)]
  }))
}
/** Display-only projection. Never use it for saving or runtime conversion. */
export function nbtDisplayValue(value: unknown): unknown {
  if (!object(value) || typeof value.type !== 'string') return value
  if (value.type === 'compound' && object(value.value)) return Object.fromEntries(Object.entries(value.value).map(([k,v])=>[k,nbtDisplayValue(v)]))
  if (value.type === 'list' && Array.isArray(value.value)) return value.value.map(nbtDisplayValue)
  return value.value
}
