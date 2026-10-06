/**
 * 进度工作区本地化：文档内存语义键，译文在
 * `assets/<locale>/lang_<ext>/<逻辑路径>.lang`（与 `.hs` 同布局，键不用 hex）。
 *
 * 例：`quest.progress` → `assets/zh_cn/lang_progress/quest.lang`
 * `{ "name": "驿站任务", "description": "……" }`
 * `spot.nav` → `assets/zh_cn/lang_nav/spot.lang`（键 `label`）
 * `starter.kit` → `assets/zh_cn/lang_kit/starter.lang`（键 `name` / `feedback.*`）
 */

import { text, type FlowText, type ProgressFlow } from './model'
import type { ProgressDocument } from './progressDoc'
import type { KitDocument } from './kit'
import type { NavigationPoint } from './navigationPoint'

export const PROGRESS_NAME_KEY = 'name'
export const PROGRESS_DESCRIPTION_KEY = 'description'

export const NAV_LABEL_KEY = 'label'

export const KIT_NAME_KEY = 'name'
export const KIT_FEEDBACK_MESSAGE_KEY = 'feedback.message'
export const KIT_FEEDBACK_TITLE_KEY = 'feedback.title'
export const KIT_FEEDBACK_SUBTITLE_KEY = 'feedback.subtitle'

/** 语义键：点分路径，段内字母数字下划线连字符 */
export const PROGRESS_LOCALE_KEY_RE =
  /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*$/i

export function isProgressLocaleKey(value: string): boolean {
  return PROGRESS_LOCALE_KEY_RE.test(value.trim())
}

export function flowEntryTitleKey(): string {
  return 'entry.title'
}

export function flowEntryDescriptionKey(): string {
  return 'entry.description'
}

export function flowNodeFieldKey(
  collection:
    | 'nodes'
    | 'goals'
    | 'predicates'
    | 'transitions'
    | 'conditionals'
    | 'diffs'
    | 'merges'
    | 'swaps',
  id: string,
  field: 'title' | 'description',
): string {
  return `${collection}.${id}.${field}`
}

export function localizedText(
  keyOrPlain: string,
  resolve: ((key: string) => string | null) | null | undefined,
): string {
  if (!resolve) return keyOrPlain
  const hit = resolve(keyOrPlain)
  if (hit !== null) return hit
  return isProgressLocaleKey(keyOrPlain) ? '' : keyOrPlain
}

export function displayLocalized(
  value: FlowText,
  resolve?: ((key: string) => string | null) | null,
): string {
  return localizedText(value.text, resolve)
}

function takePlainAsSeed(
  current: string,
  canonical: string,
  seeds: Record<string, string>,
): string {
  if (current === canonical) return canonical
  if (current.trim()) seeds[canonical] = current
  return canonical
}

/** 把 `.progress` 的 name/description 收成固定语义键，明文当默认语种子 */
export function ensureProgressLocaleKeys(doc: ProgressDocument): {
  doc: ProgressDocument
  seeds: Record<string, string>
} {
  const seeds: Record<string, string> = {}
  const name = takePlainAsSeed(doc.name, PROGRESS_NAME_KEY, seeds)
  const description = takePlainAsSeed(
    doc.description,
    PROGRESS_DESCRIPTION_KEY,
    seeds,
  )
  if (name === doc.name && description === doc.description) {
    return { doc, seeds }
  }
  return { doc: { ...doc, name, description }, seeds }
}

function migrateFlowText(
  field: FlowText,
  canonical: string,
  seeds: Record<string, string>,
): FlowText {
  const next = takePlainAsSeed(field.text, canonical, seeds)
  return next === field.text ? field : text(next)
}

/** 把 `.hflow` 玩家可见 FlowText 收成语义键 */
export function ensureFlowLocaleKeys(flow: ProgressFlow): {
  flow: ProgressFlow
  seeds: Record<string, string>
} {
  const seeds: Record<string, string> = {}
  const next: ProgressFlow = {
    ...flow,
    entry: {
      ...flow.entry,
      title: migrateFlowText(flow.entry.title, flowEntryTitleKey(), seeds),
      description: migrateFlowText(
        flow.entry.description,
        flowEntryDescriptionKey(),
        seeds,
      ),
    },
    nodes: { ...flow.nodes },
  }

  for (const [id, node] of Object.entries(flow.nodes)) {
    next.nodes[id] = {
      ...node,
      title: migrateFlowText(node.title, flowNodeFieldKey('nodes', id, 'title'), seeds),
      description: migrateFlowText(
        node.description,
        flowNodeFieldKey('nodes', id, 'description'),
        seeds,
      ),
    }
  }

  const collections = [
    'goals',
    'predicates',
    'transitions',
    'conditionals',
    'diffs',
    'merges',
    'swaps',
  ] as const

  for (const collection of collections) {
    const bag = flow[collection]
    if (!bag) continue
    const copy: Record<string, (typeof bag)[string]> = { ...bag }
    for (const [id, node] of Object.entries(bag)) {
      copy[id] = {
        ...node,
        title: migrateFlowText(
          node.title,
          flowNodeFieldKey(collection, id, 'title'),
          seeds,
        ),
        description: migrateFlowText(
          node.description,
          flowNodeFieldKey(collection, id, 'description'),
          seeds,
        ),
      }
    }
    ;(next as ProgressFlow)[collection] = copy as never
  }

  return { flow: next, seeds }
}

export function defaultProgressLocaleSeeds(
  title = '新建进度',
): Record<string, string> {
  return {
    [PROGRESS_NAME_KEY]: title,
    [PROGRESS_DESCRIPTION_KEY]: '',
  }
}

export function defaultFlowLocaleSeeds(
  title = '新的进度流程',
): Record<string, string> {
  return {
    [flowEntryTitleKey()]: title,
    [flowEntryDescriptionKey()]: '',
  }
}

export function flowNodeLocaleSeeds(
  collection:
    | 'nodes'
    | 'goals'
    | 'predicates'
    | 'transitions'
    | 'conditionals'
    | 'diffs'
    | 'merges'
    | 'swaps',
  id: string,
  title: string,
  description = '',
): Record<string, string> {
  return {
    [flowNodeFieldKey(collection, id, 'title')]: title,
    [flowNodeFieldKey(collection, id, 'description')]: description,
  }
}

/** 节点 ID 重命名时，.lang 内键的搬家列表 */
export function flowNodeLocaleKeyMoves(
  oldId: string,
  newId: string,
): Array<[string, string]> {
  const collections = [
    'nodes',
    'goals',
    'predicates',
    'transitions',
    'conditionals',
    'diffs',
    'merges',
    'swaps',
  ] as const
  const moves: Array<[string, string]> = []
  for (const collection of collections) {
    moves.push([
      flowNodeFieldKey(collection, oldId, 'title'),
      flowNodeFieldKey(collection, newId, 'title'),
    ])
    moves.push([
      flowNodeFieldKey(collection, oldId, 'description'),
      flowNodeFieldKey(collection, newId, 'description'),
    ])
  }
  return moves
}

/** 把 `.nav` 的 label 收成固定语义键 */
export function ensureNavLocaleKeys(point: NavigationPoint): {
  point: NavigationPoint
  seeds: Record<string, string>
} {
  const seeds: Record<string, string> = {}
  const label = takePlainAsSeed(point.label, NAV_LABEL_KEY, seeds)
  if (label === point.label) return { point, seeds }
  return { point: { ...point, label }, seeds }
}

export function defaultNavLocaleSeeds(label = '新导航点'): Record<string, string> {
  return { [NAV_LABEL_KEY]: label.trim() || '新导航点' }
}

/**
 * 把 `.kit` 玩家可见文案收成语义键。
 * `name` 始终成键；`feedback.message/title/subtitle` 仅在非空时成键（空串表示未设，便于继承）。
 * `feedback.sound` 不本地化。
 */
export function ensureKitLocaleKeys(kit: KitDocument): {
  kit: KitDocument
  seeds: Record<string, string>
} {
  const seeds: Record<string, string> = {}
  const name = takePlainAsSeed(kit.name, KIT_NAME_KEY, seeds)
  const migrateFeedback = (current: string, canonical: string) => {
    if (!current.trim()) return current
    return takePlainAsSeed(current, canonical, seeds)
  }
  const feedback = {
    ...kit.feedback,
    message: migrateFeedback(kit.feedback.message, KIT_FEEDBACK_MESSAGE_KEY),
    title: migrateFeedback(kit.feedback.title, KIT_FEEDBACK_TITLE_KEY),
    subtitle: migrateFeedback(kit.feedback.subtitle, KIT_FEEDBACK_SUBTITLE_KEY),
  }
  if (
    name === kit.name &&
    feedback.message === kit.feedback.message &&
    feedback.title === kit.feedback.title &&
    feedback.subtitle === kit.feedback.subtitle
  ) {
    return { kit, seeds }
  }
  return { kit: { ...kit, name, feedback }, seeds }
}

export function defaultKitLocaleSeeds(name = '新礼包'): Record<string, string> {
  return { [KIT_NAME_KEY]: name.trim() || '新礼包' }
}
