/**
 * 语言文本的「本地草稿」薄逻辑（阶段 2 / 修正草案 D1）。
 *
 * 口径：`write_lang` / `parse_hs` / `delete_lang_keys` **不再立即写工程文件（S）**，
 * 而是与编辑器手改同一条通道：`transactions.stageWrite` 草稿 + IndexedDB 镜像。
 * 读取反过来：**staged 草稿优先**，其次才是工程文件 / 本机镜像；返回体必须带
 * `draft` / `saved` 标记，不能把草稿伪装成已保存。
 *
 * 这里只做「可测的薄逻辑」：真正的 IDB / 工作区投影由调用方作为 `mirror` 注入，
 * 便于 node 侧用假对象验收。
 */

import { parseTextFile, stringifyTextFile } from './textMap'

/** 已保存内容的读取结果（工程文件或本机镜像） */
export type LangSavedRead = {
  text: string | null
  /** 工程文件内容哈希；null = 不是 S 里的已保存版本（本机镜像 / 文件不存在） */
  version: string | null
}

export type LangDraftRead = {
  map: Record<string, string>
  /**
   * S 里**已保存版本**的内容哈希：即使存在本地草稿也照实返回（null = 没有已保存版本）。
   * 草稿是否生效看 `draft`，不要把 savedVersion 当成"当前生效内容"的版本。
   */
  savedVersion: string | null
  /** 工程里是否已有已保存的语言文件（**与草稿无关**，用于 localeExists / hasSaved） */
  hasSaved: boolean
  /** true = 内容来自本地 staged 草稿（尚未保存进工程文件） */
  draft: boolean
}

/**
 * 草稿优先读取语言文本：stagedText 有内容就用它（draft=true，map 取草稿），
 * 但**仍读一次已保存内容**，因为「工程文件是否存在」与「当前生效内容来自哪里」
 * 是两件事——有草稿不代表没有已保存文件（B8）。
 *
 * `stagedText` 由调用方注入（要同时兼容 `handle.resolve()` 后的路径与原始路径），
 * 这样这个函数在 node 里可以直接用假函数测。
 */
export async function readLangDraft(
  stagedText: (path: string) => string | undefined,
  path: string,
  readSaved: () => Promise<LangSavedRead>,
): Promise<LangDraftRead> {
  const staged = stagedText(path)
  const saved = await readSaved()
  const hasSaved = saved.text !== null
  const map =
    staged !== undefined
      ? parseTextFile(staged)
      : hasSaved
        ? parseTextFile(saved.text as string)
        : {}
  return {
    map,
    savedVersion: saved.version,
    hasSaved,
    draft: staged !== undefined,
  }
}

/** 草稿事务层的最小接口（与项目 EditTransactions 同构，便于注入假对象） */
export type LangDraftTransactions = {
  stageWrite(
    edit: { op: 'write'; path: string; data: string },
    mirror?: () => void | Promise<void>,
  ): unknown
  discardDraftPaths?(paths: string[]): void
}

/**
 * 撤掉一个语言文件的 staged 草稿（回滚 `create` 条目用）。
 *
 * 事务里的 key 可能是原始资产路径，也可能是 `handle.resolve()` 后的工程内路径；
 * 两种都传进来，由 EditTransactions 按路径删除（幂等：路径不存在时是空操作）。
 */
export function discardLangDraft(
  transactions: Pick<LangDraftTransactions, 'discardDraftPaths'>,
  paths: readonly string[],
): void {
  const unique = [...new Set(paths.filter((path) => path.length > 0))]
  if (unique.length === 0) return
  transactions.discardDraftPaths?.(unique)
}

/**
 * 把一份语言映射写成本地草稿：`stageWrite` + 镜像回调。
 *
 * 镜像回调负责 IndexedDB 落盘（`putAssetBlob` 会提升 `assetCacheEpoch`）与工作区投影；
 * 完成后调用 `syncAssetEpoch` 把 `client.assetEpochs` 对齐到当前缓存 epoch ——
 * 否则保存前的 dirty 判断会把「镜像已经写进去」误判成资源被别的端改过（P0 假 dirty）。
 */
export function stageLangDraft(
  transactions: LangDraftTransactions,
  path: string,
  map: Record<string, string>,
  mirror: () => void | Promise<void>,
  syncAssetEpoch?: () => void,
): Promise<void> {
  const prepared = transactions.stageWrite(
    { op: 'write', path, data: stringifyTextFile(map) },
    async () => {
      try {
        await mirror()
      } finally {
        syncAssetEpoch?.()
      }
    },
  )
  return Promise.resolve(prepared).then(() => undefined)
}

/** 语言草稿写入要用的绑定客户端能力（真实 ProjectClient 可直接满足） */
export type LangDraftClient = {
  readonly writable: boolean
  readonly online: boolean
  resolvePath(path: string): string
  transactions: LangDraftTransactions
  assetEpochs: { set(path: string, epoch: number): void }
}

export type WriteLangDraftOptions = {
  /** null = 未绑定工程（虚拟工作区）：只写 IDB / 工作区，返回 localOnly */
  client: LangDraftClient | null
  /** 工程相对路径，如 `assets/zh_cn/lang_hs/序章.lang` */
  path: string
  map: Record<string, string>
  /** IDB 镜像 + 工作区投影（`putAssetBlob` 在这里提升缓存 epoch） */
  mirror: () => Promise<void>
  /** 当前 IDB 缓存 epoch，通常是 `assetCacheEpoch(pkgId, path)` */
  cacheEpoch: () => number
  /**
   * 回滚回放专用：工程暂时不可写（断线 / viewer）时仍允许改本地草稿。
   * 工具写入不放宽（写一份永远保存不了的草稿没有意义）。
   */
  allowUnwritable?: boolean
}

export type WriteLangDraftResult =
  | { ok: true; localOnly: boolean; draft: true; saved: false; version: null }
  | { ok: false; error: string }

/**
 * 语言写入的统一分支：绑定工程 → staged 草稿；未绑定 → 只写本机；不可写 → 明确失败。
 *
 * 返回 `ok:true` 只表示**草稿已写**，`saved` 永远是 false（保存由用户显式触发）。
 */
export async function writeLangDraft(
  options: WriteLangDraftOptions,
): Promise<WriteLangDraftResult> {
  const { client, path, map, mirror, cacheEpoch } = options
  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

  if (client === null) {
    try {
      await mirror()
    } catch (error) {
      return { ok: false, error: `failed to mirror the language draft locally: ${errorText(error)}` }
    }
    return { ok: true, localOnly: true, draft: true, saved: false, version: null }
  }

  if (!client.writable && options.allowUnwritable !== true) {
    return {
      ok: false,
      error: client.online
        ? 'current role has read-only access; language draft was not written'
        : 'service is offline; language draft was not written',
    }
  }

  const stagedPath = client.resolvePath(path)
  try {
    await stageLangDraft(client.transactions, stagedPath, map, mirror, () => {
      client.assetEpochs.set(path, cacheEpoch())
    })
  } catch (error) {
    // 镜像失败时把刚建的草稿撤掉，避免「返回失败但后续读取读到半份草稿」
    try {
      client.transactions.discardDraftPaths?.([stagedPath])
    } catch {
      // 有在途提交时清不掉：交给保存/恢复流程处理，不掩盖原始错误
    }
    return { ok: false, error: `failed to write the language draft: ${errorText(error)}` }
  }

  return { ok: true, localOnly: false, draft: true, saved: false, version: null }
}
