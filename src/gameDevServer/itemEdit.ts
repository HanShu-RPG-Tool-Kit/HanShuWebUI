import {prepareTextEditing,applyTextEditing,supportsTextEditing,type TextSession} from './displayTextEditing'
/**
 * 物品编辑（IBE）：`items.edit.open` / `items.edit.done`
 *
 * open 与 done 是两条独立消息：open 成功即结束；done 是之后的 notify。
 * uuid/editId 绑定原工程会话；源文档和语言按 open 时版本原子提交。
 */

import { randomId } from '../project/crypto'
import { notify } from '../activity'
import { itemFingerprint } from '../workspaces/gameplay/itemstack'
import { readComponents } from '../workspaces/gameplay/tnbtJson'
import { parseItem, stringifyItem, type ItemData } from '../workspaces/gameplay/itemDoc'
import { prepareDisplayLocalization, supportsDisplayLocalization, commitLocalizedResult, localizedResultEdits, legacyLocalizedResultEdits, preserveReadOnlyDisplayText, type LocalizationSession } from './displayLocalization'
import {
  controlRequest,
  isControlConnected,
  subscribeControlNotify,
} from './controlHub'

const OPEN_TIMEOUT_MS = 15000

export type ItemEditPending = {
  documentKey: string
  hash: string
  uuid: string
  openedAt: number
}

export type ItemEditDoneEvent = {
  uuid: string
  hash: string
  item: ItemData
  /** open 时登记的文档；找不到则为 null */
  documentKey: string | null
  /** 本地当前指纹已不等于 hash */
  conflict: boolean
}

type Pending = ItemEditPending & { session: LocalizationSession; version: number; text?:TextSession; receiving?: boolean }

const pendingByUuid = new Map<string, Pending>()
const doneListeners = new Set<(event: ItemEditDoneEvent) => void>()
let notifyStarted = false

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readItemData(value: unknown): ItemData | null {
  if (!isObject(value)) return null
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  if (!id) return null
  try {
    return { id, components: readComponents(value.components) }
  } catch {
    return null
  }
}

function hintUuid(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    /* fall through */
  }
  return randomId()
}

/** Shared wire payload builder; validates the complete TNBT set before sending. */
export function itemEditOpenParams(uuid: string, hash: string, item: ItemData) {
  return {
    componentFormat: 'tnbt-json-v1',
    componentMode: 'complete',
    uuid,
    hash,
    item: { id: item.id.trim(), components: readComponents(item.components) },
  }
}

export function isItemEditControlOnline(): boolean {
  return isControlConnected()
}

/**
 * open 请求成功后结束运输层请求；本地保留冻结的编辑会话供独立 done 校验。
 */
export async function openItemEditInGame(
  documentKey: string,
  item: ItemData,
): Promise<{ uuid: string; hash: string }> {
  if (!isControlConnected()) {
    throw new Error('control_not_connected')
  }
  const id = item.id.trim()
  if (!id) throw new Error('missing_id')

  const uuid = hintUuid()
  const hash = itemFingerprint(item)
  const source = await prepareDisplayLocalization(documentKey, 'item', {format:'rpgtoolkit:item',schemaVersion:2,tags:[],item})
  if (itemFingerprint(parseItem(source.source).item) !== hash) throw Error('物品草稿已改变，请重试')
  const textCapable=await supportsTextEditing(controlRequest)
  const text=textCapable?prepareTextEditing(source,parseItem(source.source)):undefined
  const capable = !textCapable&&await supportsDisplayLocalization(controlRequest)
  const version = capable||text ? 2 : 1
  if (!capable && !text && source.localization.readOnlyFields?.length) notify('游戏端 IBE 版本不支持工程本地化编辑；绑定与高级文本只读，相关修改不会保存', {kind:'warning',source:'items'})
  const params = {...itemEditOpenParams(uuid, hash, { ...item, id }), ...(text?{version:2,editId:uuid,receiver:uuid,displayText:text.open}:capable ? {version:2,editId:uuid,receiver:uuid,localization:source.localization} : {})}
  if (pendingByUuid.size >= 64) throw Error('待接收的游戏编辑过多')
  pendingByUuid.set(uuid,{documentKey,hash,uuid,openedAt:Date.now(),session:source,version,text})
  let raw: unknown
  try { raw = await controlRequest('items.edit.open', params, OPEN_TIMEOUT_MS) } catch(error) {pendingByUuid.delete(uuid);throw error}
  if (!isObject(raw) || raw.componentFormat !== 'tnbt-json-v1' || raw.componentMode !== 'complete' || raw.opened !== true || ((capable||text) && (raw.version !== 2 || raw.editId !== uuid))) {
    pendingByUuid.delete(uuid)
    throw new Error('editor_open_failed')
  }

  return { uuid, hash }
}

export function subscribeItemEditDone(
  listener: (event: ItemEditDoneEvent) => void,
): () => void {
  doneListeners.add(listener)
  return () => {
    doneListeners.delete(listener)
  }
}

/** 供写回前再比对：本地当前版是否仍是该 hash */
export function peekItemEditPending(hash: string): ItemEditPending | undefined {
  return [...pendingByUuid.values()].find(entry=>entry.hash===hash)
}

function emitDone(event: ItemEditDoneEvent): void {
  for (const listener of doneListeners) {
    try {
      listener(event)
    } catch (err) {
      console.error('items.edit.done listener failed', err)
    }
  }
}

async function handleEditDoneNotify(params: unknown): Promise<void> {
  if (!isObject(params)) return
  if (params.componentFormat !== 'tnbt-json-v1' || params.componentMode !== 'complete') {
    notify('游戏物品编辑结果的组件格式不受支持', { kind: 'warning', source: 'items' })
    return
  }
  const uuid = typeof params.uuid === 'string' ? params.uuid : ''
  const hash = typeof params.hash === 'string' ? params.hash : ''
  const item = readItemData(params.item)
  if (!hash || !item) {
    notify('收到无效的游戏物品编辑结果', { kind: 'warning', source: 'items' })
    return
  }

  const pending = pendingByUuid.get(uuid)
  if (!pending || pending.hash !== hash || pending.receiving) return
  if (pending.version === 2 && (params.version !== 2 || params.editId !== uuid || params.receiver !== uuid)) return
  pending.receiving = true
  try {
    const old = parseItem(pending.session.source)
    const incoming = parseItem(stringifyItem({...old,item}))
    const textResult=pending.text?applyTextEditing(pending.session,pending.text,incoming,params.displayText):undefined
    const candidate = textResult?textResult.document as import('../workspaces/gameplay/itemDoc').ItemDocument:pending.version === 2 ? incoming : preserveReadOnlyDisplayText(pending.session,incoming,true)
    const edits = textResult?textResult.edits:pending.version === 2 ? localizedResultEdits(pending.session,candidate,params.localization) : legacyLocalizedResultEdits(pending.session,candidate)
    const preserved = textResult?candidate:preserveReadOnlyDisplayText(pending.session,candidate,pending.version !== 2)
    await commitLocalizedResult(pending.session,stringifyItem(preserved),edits)
    emitDone({uuid,hash,item:preserved.item,documentKey:pending.documentKey,conflict:false})
    notify('已保存游戏中的物品与本地化编辑', {kind:'success',source:'items'})
  } catch (error) {
    notify(`游戏物品编辑未写回：${String(error)}；提交冲突可在协作面板中恢复`,{kind:'warning',source:'items'})
  } finally { pendingByUuid.delete(uuid) }

}

export function ensureItemEditNotifyStarted(): void {
  if (notifyStarted) return
  notifyStarted = true
  subscribeControlNotify((note) => {
    if (note.method === 'items.edit.done') void handleEditDoneNotify(note.params)
  })
}
