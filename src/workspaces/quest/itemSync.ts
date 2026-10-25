import { type ItemComponents, type NbtValue } from './tnbtJson'

export const TEMPLATE_COMPONENT = 'rpgtoolkit:item_template'
export type ItemSync = {
  allowExtraComponents: boolean
  instanceComponents: string[]
  instanceFields: { component: string; path: string[] }[]
}
export const defaultItemSync = (): ItemSync => ({ allowExtraComponents: false, instanceComponents: [], instanceFields: [] })
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const componentId = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9_.-]+:[a-z0-9/._-]+$/.test(v) && v !== TEMPLATE_COMPONENT
export const pathContains = (parent: string[], child: string[]) => parent.length <= child.length && parent.every((key, i) => key === child[i])
export function readItemSync(value: unknown): ItemSync {
  if (value === undefined) return defaultItemSync()
  if (!object(value) || Object.keys(value).some(k => !['allowExtraComponents','instanceComponents','instanceFields'].includes(k))) throw Error('sync 需要同步规则对象')
  if (typeof value.allowExtraComponents !== 'boolean' || !Array.isArray(value.instanceComponents) || !Array.isArray(value.instanceFields)) throw Error('sync 缺少额外组件策略或实例规则列表')
  if (value.instanceComponents.length + value.instanceFields.length > 1024) throw Error('同步规则不能超过 1024 条')
  const components = value.instanceComponents
  if (!components.every(componentId)) throw Error('实例组件需要有效组件 ID，且不能开放模板绑定组件')
  const fields = value.instanceFields.map(raw => {
    if (!object(raw) || Object.keys(raw).some(k => !['component','path'].includes(k)) || !componentId(raw.component) || !Array.isArray(raw.path) || raw.path.length < 1 || raw.path.length > 32 || !raw.path.every(k => typeof k === 'string')) throw Error('实例字段需要组件 ID 和 1..32 层 compound 字段路径')
    return {component:raw.component, path:raw.path as string[]}
  })
  return {
    allowExtraComponents:value.allowExtraComponents,
    instanceComponents:[...new Set(components)],
    instanceFields:fields.filter((rule,i) => !components.includes(rule.component) && !fields.some((other,j) => other.component===rule.component && pathContains(other.path,rule.path) && (other.path.length<rule.path.length || j<i))),
  }
}
export function syncRuleErrors(sync: ItemSync, components: ItemComponents): string[] {
  const errors: string[] = []
  if (Object.hasOwn(components,TEMPLATE_COMPONENT)) errors.push('模板绑定组件由引擎管理，不能写入模板初始组件')
  for (const rule of sync.instanceFields) {
    let node: NbtValue | undefined = components[rule.component]
    for (const key of rule.path) node = node?.type === 'compound' && Object.hasOwn(node.value,key) ? node.value[key] : undefined
    if (!node) errors.push(`${rule.component} / ${rule.path.map(k=>JSON.stringify(k)).join(' / ')}：模板字段不存在或父节点不是 compound`)
  }
  return errors
}
/** Reference implementation for preview/tests. Creation uses template values; synchronization preserves absence. */
export function synchronizeComponents(template: ItemComponents, instance: ItemComponents, raw: ItemSync): ItemComponents {
  const sync=readItemSync(raw), errors=syncRuleErrors(sync,template)
  if(errors.length) throw Error(errors.join('；'))
  const result=structuredClone(template)
  for(const [id,value] of Object.entries(instance)) if(id!==TEMPLATE_COMPONENT && sync.allowExtraComponents && !Object.hasOwn(template,id)) result[id]=structuredClone(value)
  for(const id of sync.instanceComponents) {
    if(Object.hasOwn(instance,id)) result[id]=structuredClone(instance[id]); else delete result[id]
  }
  for(const rule of sync.instanceFields) {
    let target=result[rule.component], source: NbtValue|undefined=instance[rule.component]
    for(const key of rule.path.slice(0,-1)) {
      if(target.type!=='compound') throw Error('invalid target')
      target=target.value[key]
      source=source?.type==='compound' && Object.hasOwn(source.value,key)?source.value[key]:undefined
    }
    if(target.type!=='compound') throw Error('invalid target')
    const key=rule.path.at(-1)!
    if(source?.type==='compound' && Object.hasOwn(source.value,key)) Object.defineProperty(target.value,key,{value:structuredClone(source.value[key]),enumerable:true,configurable:true,writable:true})
    else delete target.value[key]
  }
  return result
}
