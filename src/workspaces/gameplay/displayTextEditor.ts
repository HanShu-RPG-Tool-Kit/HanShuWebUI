/** Authoring state only: never emitted into Minecraft components or entity NBT. */
export type DisplayTextState = { localized: boolean; reference?: unknown; literal?: unknown }
export type DisplayTextEditor = Record<string, DisplayTextState>
const fieldPattern=/^(?:item\.(?:item_name|custom_name|lore\.(?:0|[1-9]\d*))|entity\.custom_name)$/
export function readDisplayTextEditor(value:unknown):DisplayTextEditor|undefined {
  if(value===undefined)return undefined
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>258)throw Error('显示文本编辑信息无效')
  for(const [field,raw] of Object.entries(value)){
    if(!fieldPattern.test(field)||!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('显示文本编辑字段无效')
    const state=raw as Record<string,unknown>
    if(typeof state.localized!=='boolean'||Object.keys(state).some(key=>!['localized','reference','literal'].includes(key)))throw Error('显示文本模式无效')
    if(state.reference!==undefined&&(!state.reference||typeof state.reference!=='object'||Array.isArray(state.reference)||!/^hanshu\.(item|entity)\.[a-z0-9_-]+\.display\.(item_name|custom_name|lore\.[a-z0-9_-]+)$/.test(String((state.reference as Record<string,unknown>).translate))))throw Error('停用的本地化引用无效')
  }
  return value as DisplayTextEditor
}
/** Explicit list operations carry identities even when two fixed rows have identical content. */
export function reorderDisplayTextEditor(editor:DisplayTextEditor|undefined,order:readonly number[]):DisplayTextEditor|undefined {
  if(!editor)return editor
  const next=Object.fromEntries(Object.entries(editor).filter(([field])=>!field.startsWith('item.lore.')))
  order.forEach((old,index)=>{const state=editor[`item.lore.${old}`];if(state)next[`item.lore.${index}`]=state})
  return next
}

/** Raw tree edits have no explicit order: match unchanged rows before positional edits. */
export function inferDisplayTextOrder(before:readonly unknown[],after:readonly unknown[]):number[]{
  const used=new Set<number>(),keys=before.map(value=>JSON.stringify(value)),nextKeys=after.map(value=>JSON.stringify(value))
  const order=nextKeys.map((key,i)=>{if(keys[i]===key){used.add(i);return i}return -1})
  nextKeys.forEach((key,i)=>{if(order[i]>=0)return;const index=keys.findIndex((candidate,j)=>candidate===key&&!used.has(j));if(index>=0){used.add(index);order[i]=index}})
  return order.map((index,i)=>{if(index>=0)return index;if(before.length===after.length&&!used.has(i)){used.add(i);return i}return -1})
}
