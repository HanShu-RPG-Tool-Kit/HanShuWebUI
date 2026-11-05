import { parseJsonValue } from '../../utils/strictJson'
import { randomId } from '../../project/crypto'
import { isQuestCatalogFileName } from '../../workspace'
import { parseFlatResourceId } from './actor'
import { isObject } from './model'

export const QUEST_CATALOG_FORMAT = 'hanshu.quest-catalog' as const
export const QUEST_CATALOG_FILE_NAME = 'catalog.json'
export const QUEST_CATALOG_PATH = 'src/quest/catalog.json'
export const QUEST_CATALOG_DOCUMENT_KEY = 'builtin:quest-catalog'
export const QUEST_CATALOG_LABEL = '任务分类'
/** 本地化身份：落在 `lang_quest/catalog.lang`，与磁盘 `catalog.json` 解耦。 */
export const QUEST_CATALOG_LOCALE_NAME = 'catalog.quest'

export type QuestCatalogDirectory = {
  id: string
  /** 语义键 `directories.<id>.title` */
  title: string
  /** 无序去重集合；落盘时排序保证稳定 */
  quests: string[]
}

export type QuestCatalogDocument = {
  format: typeof QUEST_CATALOG_FORMAT
  version: 1
  directories: QuestCatalogDirectory[]
}

export { isQuestCatalogFileName }

export const isQuestCatalogDocumentKey = (key: string) => key === QUEST_CATALOG_DOCUMENT_KEY

export const questCatalogTitleKey = (id: string) => `directories.${id}.title`

export const createQuestCatalog = (): QuestCatalogDocument => ({
  format: QUEST_CATALOG_FORMAT,
  version: 1,
  directories: [],
})

export function createQuestCatalogDirectory(seedTitle = '新建目录'): {
  directory: QuestCatalogDirectory
  localeSeeds: Record<string, string>
} {
  const id = randomId()
  const title = questCatalogTitleKey(id)
  return {
    directory: { id, title, quests: [] },
    localeSeeds: { [title]: seedTitle },
  }
}

function uniqueSorted(ids: string[]): string[] {
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b, 'en'))
}

export function stringifyQuestCatalog(doc: QuestCatalogDocument): string {
  return `${JSON.stringify({
    format: QUEST_CATALOG_FORMAT,
    version: 1,
    directories: doc.directories.map(directory => ({
      id: directory.id,
      title: directory.title,
      quests: uniqueSorted(directory.quests),
    })),
  }, null, 2)}\n`
}

export function parseQuestCatalog(source: string): QuestCatalogDocument {
  const raw = parseJsonValue(
    source.trim()
      ? source
      : `{"format":"${QUEST_CATALOG_FORMAT}","version":1,"directories":[]}`,
  )
  if (!isObject(raw) || raw.format !== QUEST_CATALOG_FORMAT || raw.version !== 1) {
    throw new Error('需要 hanshu.quest-catalog version 1 任务分类')
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'format' && key !== 'version' && key !== 'directories') {
      throw new Error(`未知任务分类字段：${key}`)
    }
  }
  if (!Array.isArray(raw.directories)) throw new Error('任务分类 directories 必须是数组')
  const seenIds = new Set<string>()
  const directories: QuestCatalogDirectory[] = []
  for (const [index, entry] of raw.directories.entries()) {
    if (!isObject(entry)) throw new Error(`任务分类目录 #${index + 1} 必须是对象`)
    for (const key of Object.keys(entry)) {
      if (key !== 'id' && key !== 'title' && key !== 'quests') {
        throw new Error(`任务分类目录未知字段：${key}`)
      }
    }
    const id = parseFlatResourceId(String(entry.id ?? ''), '任务分类目录 id')
    if (seenIds.has(id)) throw new Error(`任务分类目录 id 重复：${id}`)
    seenIds.add(id)
    if (typeof entry.title !== 'string' || !entry.title.trim()) {
      throw new Error(`任务分类目录 ${id} 的 title 必须是非空字符串`)
    }
    const expected = questCatalogTitleKey(id)
    if (entry.title !== expected) {
      throw new Error(`任务分类目录 ${id} 的 title 必须是 ${expected}`)
    }
    if (!Array.isArray(entry.quests) || entry.quests.some(item => typeof item !== 'string')) {
      throw new Error(`任务分类目录 ${id} 的 quests 必须是字符串数组`)
    }
    const quests = (entry.quests as string[]).map(item => parseFlatResourceId(item, '任务分类任务引用'))
    if (new Set(quests).size !== quests.length) {
      throw new Error(`任务分类目录 ${id} 不能重复引用同一任务`)
    }
    directories.push({ id, title: entry.title, quests: uniqueSorted(quests) })
  }
  return { format: QUEST_CATALOG_FORMAT, version: 1, directories }
}

export function readQuestCatalogSource(source: string): {
  doc: QuestCatalogDocument | null
  error: string
} {
  try {
    return { doc: parseQuestCatalog(source), error: '' }
  } catch (cause) {
    return { doc: null, error: cause instanceof Error ? cause.message : String(cause) }
  }
}

/** 工程内 `.quest` 基名（无后缀），供候选与缺失校验。 */
export function questCatalogCandidateIds(
  documents: readonly { name: string; package?: string }[],
): Set<string> {
  return new Set(
    documents
      .filter(document => document.name.toLowerCase().endsWith('.quest'))
      .map(document => document.name.replace(/\.quest$/i, '')),
  )
}
