/**
 * library.json schema v5 — 内存库 + 查询过滤
 * 标签为条目自由字符串；listTags 从条目自动收集。
 */

import type {
  CollectedTag,
  FolderNode,
  FolderWithStats,
  LibraryEntry,
  LibraryPage,
  LibraryQuery,
  LicenseInfo,
  Provenance,
} from '../contracts/types'
import { SCHEMA_VERSION } from './paths'

export type LibraryFile = {
  schemaVersion: number
  revision: number
  folders: FolderNode[]
  entries: LibraryEntry[]
}

type LegacyTagNode = {
  tagId?: string
  name?: string
  parentId?: string | null
  sortOrder?: number
}

type LegacyEntry = Partial<LibraryEntry> & {
  tagIds?: string[]
  tags?: string[] | unknown
}

export function emptyLibrary(): LibraryFile {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 1,
    folders: [],
    entries: [],
  }
}

export function emptyLicense(): LicenseInfo {
  return { status: 'unspecified', name: null, url: null, note: null }
}

export function emptyProvenance(): Provenance {
  return {
    author: null,
    sourceName: null,
    sourceUrl: null,
    sourceNote: null,
    originalCreatedAt: null,
  }
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** NFC + trim; empty → null. */
export function normalizeTagName(name: string): string | null {
  const n = name.trim().normalize('NFC')
  return n.length > 0 ? n : null
}

/** Dedupe case-insensitively while preserving first-seen casing. */
export function normalizeTagList(input: Iterable<string>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    const n = normalizeTagName(raw)
    if (!n) continue
    const key = n.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(n)
  }
  return out
}

function tagPathsToNames(paths: string[][] | undefined): string[] {
  if (!paths?.length) return []
  return normalizeTagList(paths.map((p) => (p.length ? p[p.length - 1]! : '')).filter(Boolean))
}

export function resolveEntryTags(opts: {
  tags?: string[]
  tagPaths?: string[][]
}): string[] {
  if (opts.tags?.length) return normalizeTagList(opts.tags)
  return tagPathsToNames(opts.tagPaths)
}

export function parseLibraryJson(raw: string): LibraryFile {
  const data = JSON.parse(raw) as {
    schemaVersion?: number
    revision?: number
    tags?: LegacyTagNode[]
    folders?: FolderNode[]
    entries?: LegacyEntry[]
  }
  const schemaVersion = Number(data.schemaVersion ?? 5)
  const registry = new Map<string, string>()
  for (const t of Array.isArray(data.tags) ? data.tags : []) {
    if (t.tagId && typeof t.name === 'string') {
      const n = normalizeTagName(t.name)
      if (n) registry.set(t.tagId, n)
    }
  }

  const folders = (Array.isArray(data.folders) ? data.folders : []).map((f) => ({
    ...f,
    parentId: f.parentId ?? null,
    name: typeof f.name === 'string' ? f.name : '',
  }))

  const entries: LibraryEntry[] = (Array.isArray(data.entries) ? data.entries : []).map((e) => {
    let tags: string[] = []
    if (Array.isArray(e.tags) && e.tags.every((t) => typeof t === 'string')) {
      tags = normalizeTagList(e.tags as string[])
    } else if (Array.isArray(e.tagIds)) {
      tags = normalizeTagList(
        e.tagIds.map((id) => registry.get(id) ?? '').filter(Boolean),
      )
    }
    return {
      entryId: e.entryId!,
      skinId: e.skinId!,
      name: e.name ?? '',
      active: e.active !== false,
      tags,
      folderId: e.folderId ?? null,
      favorite: Boolean(e.favorite),
      model: e.model ?? 'classic',
      source: e.source ?? { kind: 'png-file' },
      provenance: e.provenance ?? emptyProvenance(),
      license: e.license ?? emptyLicense(),
      note: e.note ?? '',
      createdAt: e.createdAt ?? nowIso(),
      updatedAt: e.updatedAt ?? e.createdAt ?? nowIso(),
      revision: Number(e.revision ?? 1) || 1,
    }
  })

  return {
    schemaVersion: SCHEMA_VERSION,
    revision: Number(data.revision ?? 1) || 1,
    folders,
    entries,
  }
}

export function normalizeFolderName(name: string): string {
  return name.trim().normalize('NFC')
}

/**
 * Merge sibling folders that share the same NFC name.
 * Entries and child folders of duplicates are moved onto the keeper; repeats
 * until stable. Returns true when the library was modified.
 */
export function repairDuplicateSiblingFolders(lib: LibraryFile): boolean {
  let changed = false

  for (const f of lib.folders) {
    const norm = normalizeFolderName(f.name)
    if (!norm) {
      f.name = '未命名文件夹'
      changed = true
    } else if (f.name !== norm) {
      f.name = norm
      changed = true
    }
  }

  let guard = 0
  while (guard++ < 64) {
    const groups = new Map<string, FolderNode[]>()
    for (const f of lib.folders) {
      const parent = f.parentId ?? null
      const key = `${parent ?? ''}::${normalizeFolderName(f.name)}`
      const list = groups.get(key) ?? []
      list.push(f)
      groups.set(key, list)
    }

    let mergedThisPass = false
    for (const group of groups.values()) {
      if (group.length < 2) continue
      group.sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
        return a.folderId.localeCompare(b.folderId)
      })
      const keeper = group[0]!
      const dupIds = new Set(group.slice(1).map((f) => f.folderId))
      for (const e of lib.entries) {
        if (e.folderId && dupIds.has(e.folderId)) {
          e.folderId = keeper.folderId
          changed = true
        }
      }
      for (const f of lib.folders) {
        if (f.parentId && dupIds.has(f.parentId)) {
          f.parentId = keeper.folderId
          changed = true
        }
      }
      const before = lib.folders.length
      lib.folders = lib.folders.filter((f) => !dupIds.has(f.folderId))
      if (lib.folders.length !== before) {
        changed = true
        mergedThisPass = true
      }
    }
    if (!mergedThisPass) break
  }

  return changed
}

function folderDescendants(
  folders: FolderNode[],
  rootId: string,
): Set<string> {
  const kids = new Map<string | null, string[]>()
  for (const f of folders) {
    const p = f.parentId ?? null
    const list = kids.get(p) ?? []
    list.push(f.folderId)
    kids.set(p, list)
  }
  const out = new Set<string>([rootId])
  const stack = [rootId]
  while (stack.length) {
    const id = stack.pop()!
    for (const c of kids.get(id) ?? []) {
      if (!out.has(c)) {
        out.add(c)
        stack.push(c)
      }
    }
  }
  return out
}

function entryHasTag(entry: LibraryEntry, want: string): boolean {
  const key = want.toLowerCase()
  return entry.tags.some((t) => t.toLowerCase() === key)
}

export function queryEntries(
  lib: LibraryFile,
  query: LibraryQuery,
): LibraryPage {
  let list = [...lib.entries]
  const search = query.search?.trim().toLowerCase()
  if (search) {
    list = list.filter(
      (e) =>
        e.name.toLowerCase().includes(search) ||
        e.skinId.includes(search) ||
        (e.provenance.author ?? '').toLowerCase().includes(search) ||
        e.tags.some((t) => t.toLowerCase().includes(search)),
    )
  }
  if (query.favorite === true) list = list.filter((e) => e.favorite)
  if (query.active === true) list = list.filter((e) => e.active)
  if (query.active === false) list = list.filter((e) => !e.active)
  if (query.models?.length) {
    const set = new Set(query.models)
    list = list.filter((e) => set.has(e.model))
  }
  if (query.untagged) list = list.filter((e) => e.tags.length === 0)
  if (query.tags?.length) {
    const want = query.tags
    const match = query.tagMatch === 'any' ? 'any' : 'all'
    list = list.filter((e) =>
      match === 'any'
        ? want.some((t) => entryHasTag(e, t))
        : want.every((t) => entryHasTag(e, t)),
    )
  }
  if (query.excludeTags?.length) {
    list = list.filter((e) => !query.excludeTags!.some((t) => entryHasTag(e, t)))
  }
  if (query.author) {
    const a = query.author.toLowerCase()
    list = list.filter((e) =>
      (e.provenance.author ?? '').toLowerCase().includes(a),
    )
  }
  if (query.licenseUnspecified === true) {
    list = list.filter((e) => e.license.status === 'unspecified')
  }
  if (query.licenseUnspecified === false) {
    list = list.filter((e) => e.license.status === 'declared')
  }
  if (query.includeLicenseNames?.length) {
    const names = query.includeLicenseNames.map((n) => n.toLowerCase())
    list = list.filter((e) =>
      names.some((n) => (e.license.name ?? '').toLowerCase().includes(n)),
    )
  }
  if (query.scope === 'unfiled') {
    list = list.filter((e) => e.folderId == null)
  } else if (query.scope === 'folder') {
    if (query.folderId) {
      list = list.filter((e) => e.folderId === query.folderId)
    } else {
      list = list.filter((e) => e.folderId == null)
    }
  }

  const sortBy = query.sortBy ?? 'createdAt'
  const dir = query.sortDirection === 'asc' ? 1 : -1
  list.sort((a, b) => {
    let cmp = 0
    if (sortBy === 'name') cmp = a.name.localeCompare(b.name, 'zh-CN')
    else if (sortBy === 'author') {
      cmp = (a.provenance.author ?? '').localeCompare(
        b.provenance.author ?? '',
        'zh-CN',
      )
    } else if (sortBy === 'updatedAt') {
      cmp = a.updatedAt.localeCompare(b.updatedAt)
    } else {
      cmp = a.createdAt.localeCompare(b.createdAt)
    }
    return cmp * dir
  })

  const page = Math.max(1, query.page ?? 1)
  const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 48))
  const total = list.length
  const start = (page - 1) * pageSize
  return {
    entries: list.slice(start, start + pageSize),
    total,
    page,
    pageSize,
    revision: lib.revision,
  }
}

/** Collect unique tags from all entries (auto inventory). */
export function collectTags(lib: LibraryFile): CollectedTag[] {
  const counts = new Map<string, { name: string; count: number }>()
  for (const e of lib.entries) {
    for (const raw of e.tags) {
      const n = normalizeTagName(raw)
      if (!n) continue
      const key = n.toLowerCase()
      const cur = counts.get(key)
      if (cur) cur.count += 1
      else counts.set(key, { name: n, count: 1 })
    }
  }
  return [...counts.values()].sort((a, b) =>
    a.name.localeCompare(b.name, 'zh-Hans-CN'),
  )
}

export function renameTagInLibrary(
  lib: LibraryFile,
  from: string,
  to: string,
): number {
  const fromKey = normalizeTagName(from)?.toLowerCase()
  const toName = normalizeTagName(to)
  if (!fromKey || !toName) return 0
  let affected = 0
  for (const e of lib.entries) {
    if (!e.tags.some((t) => t.toLowerCase() === fromKey)) continue
    e.tags = normalizeTagList(
      e.tags.map((t) => (t.toLowerCase() === fromKey ? toName : t)),
    )
    e.updatedAt = nowIso()
    e.revision += 1
    affected += 1
  }
  return affected
}

export function deleteTagInLibrary(lib: LibraryFile, name: string): number {
  const key = normalizeTagName(name)?.toLowerCase()
  if (!key) return 0
  let affected = 0
  for (const e of lib.entries) {
    const next = e.tags.filter((t) => t.toLowerCase() !== key)
    if (next.length === e.tags.length) continue
    e.tags = next
    e.updatedAt = nowIso()
    e.revision += 1
    affected += 1
  }
  return affected
}

export function foldersWithStats(lib: LibraryFile): FolderWithStats[] {
  const pathOf = (id: string): string[] => {
    const parts: string[] = []
    let cur: string | null = id
    const guard = new Set<string>()
    while (cur && !guard.has(cur)) {
      guard.add(cur)
      const node = lib.folders.find((f) => f.folderId === cur)
      if (!node) break
      parts.unshift(node.name)
      cur = node.parentId
    }
    return parts
  }
  return lib.folders.map((f) => {
    const desc = folderDescendants(lib.folders, f.folderId)
    const direct = lib.entries.filter((e) => e.folderId === f.folderId).length
    const subtree = lib.entries.filter(
      (e) => e.folderId != null && desc.has(e.folderId),
    ).length
    return {
      ...f,
      directCount: direct,
      subtreeCount: subtree,
      path: pathOf(f.folderId),
    }
  })
}
