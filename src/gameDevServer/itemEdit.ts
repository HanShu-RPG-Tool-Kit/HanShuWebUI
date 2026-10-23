/**
 * 物品编辑（IBE）：`items.edit.open` / `items.edit.done`
 *
 * open 与 done 是两条独立消息：open 成功即结束；done 是之后的 notify。
 * 写回只认 hash（版本令牌）；uuid 仅日志 hint。
 */

import { randomId } from '../project/crypto'
import { notify } from '../activity'
import { itemFingerprint } from '../workspaces/progress/itemstack'
import type { ItemData } from '../workspaces/progress/itemDoc'
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

type Pending = ItemEditPending

const pendingByHash = new Map<string, Pending>()
const doneListeners = new Set<(event: ItemEditDoneEvent) => void>()
let notifyStarted = false

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readItemData(value: unknown): ItemData | null {
  if (!isObject(value)) return null
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  if (!id) return null
  let components: Record<string, unknown> = {}
  if (value.components !== undefined) {
    if (!isObject(value.components)) return null
    components = { ...value.components }
  }
  return { id, components }
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

export function isItemEditControlOnline(): boolean {
  return isControlConnected()
}

/**
 * 出站 `items.edit.open`：成功即完，不持有协议会话。
 * 本地只短暂记住 hash → documentKey，供之后的 done 写回比对。
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
  const params = {
    uuid,
    hash,
    item: { id, components: item.components },
  }

  const raw = await controlRequest('items.edit.open', params, OPEN_TIMEOUT_MS)
  if (!isObject(raw) || raw.opened !== true) {
    throw new Error('editor_open_failed')
  }

  pendingByHash.set(hash, {
    documentKey,
    hash,
    uuid,
    openedAt: Date.now(),
  })
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
  return pendingByHash.get(hash)
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

function handleEditDoneNotify(params: unknown): void {
  if (!isObject(params)) return
  const uuid = typeof params.uuid === 'string' ? params.uuid : ''
  const hash = typeof params.hash === 'string' ? params.hash : ''
  const item = readItemData(params.item)
  if (!hash || !item) {
    notify('收到无效的游戏物品编辑结果', { kind: 'warning', source: 'items' })
    return
  }

  const pending = pendingByHash.get(hash)
  pendingByHash.delete(hash)

  emitDone({
    uuid,
    hash,
    item,
    documentKey: pending?.documentKey ?? null,
    conflict: false,
  })
}

export function ensureItemEditNotifyStarted(): void {
  if (notifyStarted) return
  notifyStarted = true
  subscribeControlNotify((note) => {
    if (note.method === 'items.edit.done') handleEditDoneNotify(note.params)
  })
}
