/**
 * 供游戏开发服务器（mod ControlHub）查询当前工程物品库的方法实现。
 * 读自 C 侧工程会话镜像；未打开工程或没有 .item 时返回空列表 / not_found。
 */

import { getProjectSession } from '../project/projectSession'
import { getExtension, sourcePathOf } from '../workspace'
import { parseItem, type ItemDocument } from '../workspaces/quest/itemDoc'
import { getCachedDisplaySync } from '../workspaces/quest/itemSnapshotCache'
import { itemFingerprint, type ItemStackDisplay } from '../workspaces/quest/itemstack'
import {
  itemRefFromFileName,
  normalizeItemRef,
} from '../workspaces/quest/kit'

export type ItemLibraryEntry = {
  /** 物品库引用名（文件名无 .item） */
  ref: string
  /** 工程内文件名 */
  name: string
  /** 包相对路径 */
  path: string
  /** 游戏物品 id */
  id: string
  tags: string[]
  /** 展示名（若有快照） */
  displayName?: string
  componentCount: number
}

export type ItemLibraryItem = ItemLibraryEntry & {
  item: ItemDocument['item']
  display?: ItemStackDisplay
  format: string
  schemaVersion: number
}

function displayNameOf(item: ItemDocument['item']): string | undefined {
  const cached = getCachedDisplaySync(itemFingerprint(item))
  const parts = cached?.name
  if (!parts?.length) return undefined
  const texts = parts.map((p) => p.text).filter(Boolean)
  return texts.length ? texts.join('') : undefined
}

function collectParsedItems(): {
  ref: string
  name: string
  path: string
  doc: ItemDocument
}[] {
  const { workspace } = getProjectSession()
  const out: { ref: string; name: string; path: string; doc: ItemDocument }[] = []
  for (const pkg of workspace.packages) {
    for (const source of pkg.scripts) {
      if (getExtension(source.name).toLowerCase() !== '.item') continue
      try {
        const doc = parseItem(source.content)
        const rel = sourcePathOf(source)
        out.push({
          ref: itemRefFromFileName(source.name),
          name: source.name,
          path: pkg.id ? `${pkg.id}/${rel}` : rel,
          doc,
        })
      } catch {
        /* 非法 .item 跳过，不影响其它条目 */
      }
    }
  }
  return out
}

function toEntry(row: {
  ref: string
  name: string
  path: string
  doc: ItemDocument
}): ItemLibraryEntry {
  const displayName = displayNameOf(row.doc.item)
  return {
    ref: row.ref,
    name: row.name,
    path: row.path,
    id: row.doc.item.id,
    tags: [...row.doc.tags],
    ...(displayName ? { displayName } : {}),
    componentCount: Object.keys(row.doc.item.components).length,
  }
}

function toFull(row: {
  ref: string
  name: string
  path: string
  doc: ItemDocument
}): ItemLibraryItem {
  const display = getCachedDisplaySync(itemFingerprint(row.doc.item))
  return {
    ...toEntry(row),
    format: row.doc.format,
    schemaVersion: row.doc.schemaVersion,
    item: {
      id: row.doc.item.id,
      components: { ...row.doc.item.components },
    },
    ...(display ? { display } : {}),
  }
}

function tagMatch(tags: string[], want: string): boolean {
  const key = want.trim().toLowerCase()
  if (!key) return false
  return tags.some((t) => t.toLowerCase() === key)
}

export function handleItemControlMethod(
  method: string,
  params: unknown,
): { ok: true; result: unknown } | { ok: false; error: string } {
  const p =
    params && typeof params === 'object' ? (params as Record<string, unknown>) : {}

  if (method === 'ping') {
    return { ok: true, result: { pong: true } }
  }

  if (method === 'items.list') {
    const items = collectParsedItems().map(toEntry)
    return { ok: true, result: { items, count: items.length } }
  }

  if (method === 'items.get') {
    const ref =
      typeof p.ref === 'string'
        ? normalizeItemRef(p.ref)
        : typeof p.name === 'string'
          ? normalizeItemRef(p.name)
          : ''
    const id = typeof p.id === 'string' ? p.id.trim() : ''
    if (!ref && !id) return { ok: false, error: 'missing_ref_or_id' }
    const rows = collectParsedItems()
    const hit = ref
      ? rows.find((r) => r.ref.toLowerCase() === ref.toLowerCase())
      : rows.find((r) => r.doc.item.id === id)
    if (!hit) return { ok: false, error: 'not_found' }
    return { ok: true, result: toFull(hit) }
  }

  if (method === 'items.query') {
    const id = typeof p.id === 'string' ? p.id.trim() : ''
    const tag = typeof p.tag === 'string' ? p.tag : ''
    const tags = Array.isArray(p.tags)
      ? p.tags.filter((t): t is string => typeof t === 'string')
      : []
    const rows = collectParsedItems().filter((row) => {
      if (id && row.doc.item.id !== id) return false
      if (tag && !tagMatch(row.doc.tags, tag)) return false
      for (const t of tags) {
        if (!tagMatch(row.doc.tags, t)) return false
      }
      return true
    })
    const items = rows.map(toEntry)
    return { ok: true, result: { items, count: items.length } }
  }

  return { ok: false, error: 'unknown_method' }
}
