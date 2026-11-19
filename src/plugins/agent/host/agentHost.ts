/**
 * Agent 插件的领域宿主（PR2）。
 *
 * 所有工程文本读写都走平台的 `ProjectHost`（编辑器缓冲 → 本地草稿 → 已保存内容），
 * 不再依赖 StageplayWorkspace 的 refs / 回调；package / 语言 / 配音 / 导出预检等
 * 只读元数据来自平台工程会话（`getProjectSession`）与领域库。
 */
import type { AgentHost, AgentOpResult, LangEntry } from '../core/tools'
import type { ProjectHost } from '../../../plugin-sdk/types'
import type { Project, SourceFile, Workspace } from '../../../workspace'
import { getProjectHost, getProjectSession } from '../../../platform'
import { indexForeignHsInjects } from '../../../hanshu/injectIndex'
import { parseTextSpans } from '../../../monaco/textSpans'
import { assessLangValueRisks, type InlineContext } from '../../../hanshu/inlineText'
import {
  ALLOWED_EXTENSIONS_LABEL,
  findScript,
  findScriptByName,
  normalizeResourceName,
  sourceKindOf,
} from '../../../workspace'
import { normalizeSourcePath, parseLocaleAssetPath } from '../../../i18n/localeLayout'
import { buildResourcePackZip } from '../../../export/resourcePack'
import { buildProjectPackZip } from '../../../export/projectPack'
import { getAssetBlob } from '../../../assets/idb'
import { COMMON_LOCALES, findLocale, resolveLocale, resolveLocaleTag } from '../../../i18n/locales'
import {
  applyTextEdit,
  collectMissingTranslationWarnings,
  collectOrphanKeys,
  collectSourceKeys,
  countUnparsedTexts,
  langAssetPathFor,
  listLocalesOf,
  paginateSource,
  parseSourceText,
  sourceNameFromLangPath,
  sourceOffsetError,
  translateExportWarning,
  unparseSourceText,
  validateLangKeys,
  validateSourceContent,
  voiceStatusOf,
} from '../core/agentOps'
import { stringifyTextFile } from '../../../i18n/textMap'
import { readLangDraft } from '../../../i18n/langDraft'

/** 插件宿主依赖：只需要当前界面语言；工程内容一律从平台宿主读取。 */
export type AgentHostDeps = { locale: string }

type AgentScriptHit = { pkg: Project; script: SourceFile }

/** 比较用的路径键：反斜杠转正斜杠、去 `./` 与前导斜杠、忽略大小写 */
const sourceKeyOf = (path: string): string =>
  path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .toLowerCase()

const baseNameOf = (path: string): string => {
  const parts = path.trim().replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] ?? ''
}

/** 只在 ProjectHost 里存在（工作区还没加载成 SourceFile）时的占位包 */
const syntheticPackage = (): Project => ({
  id: '',
  name: '',
  collapsed: false,
  assetsCollapsed: false,
  scripts: [],
  assets: [],
  assetFolders: [],
})

export function createAgentHost(deps: AgentHostDeps): AgentHost {
  /**
   * 界面语言的当前值。宿主是长期对象，而用户可能在运行中切换界面语言，
   * 所以每次现取 `ProjectHost.getLocale()`，取不到时才退回创建时的快照。
   */
  const currentLocale = (): string => getProjectHost()?.getLocale() ?? deps.locale

  /**
   * 元数据只读快照。工程内容本身**不**从这里读 —— 源码正文、草稿与写入一律走
   * ProjectHost，这样编辑器缓冲、语言 staged 草稿与 agent 写入始终是同一个世界。
   */
  const workspaceRef = {
    get current(): Workspace {
      return getProjectSession().workspace
    },
  }
  const hostOf = (): ProjectHost | null => getProjectHost()

  /** 由 `listFiles` 发现、但工作区还没有对应 SourceFile 的路径：逻辑 id → 工程路径 */
  const hostOnlyPaths = new Map<string, string>()
  const hostOnlyId = (path: string): string => 'project:' + path

  const hostPathOfScript = (scriptId: string): string => {
    const hit = findScript(workspaceRef.current, scriptId)
    return hit?.script.name ?? hostOnlyPaths.get(scriptId) ?? scriptId
  }

  const agentSourceContent = (scriptId: string): string | null => {
    const host = hostOf()
    if (!host) return null
    const hit = findScript(workspaceRef.current, scriptId)
    return host.readCurrentText(hostPathOfScript(scriptId)) ?? hit?.script.content ?? null
  }

  const applyAgentFileWrite = (
    scriptId: string,
    content: string,
  ): { file: string } | null => {
    const host = hostOf()
    if (!host) return null
    const path = hostPathOfScript(scriptId)
    try {
      host.writeDraft(path, content)
      return { file: path }
    } catch {
      return null
    }
  }

  const removeScriptSilent = (scriptId: string): void => {
    const host = hostOf()
    if (host) host.discardDraft(hostPathOfScript(scriptId))
  }

  const stagedLangText = (path: string): string | undefined =>
    hostOf()?.stagedAssetText(path)

  /** 已保存版本：绑定工程优先读 S（带内容哈希），读不到退回 ProjectHost 的 saved 视图 */
  const readLangSaved = async (
    path: string,
  ): Promise<{ text: string | null; version: string | null }> => {
    const binding = getProjectSession().binding
    const client = binding?.handle.client
    if (binding && client) {
      // 工程可能挂在 S 根的子目录下：优先读 resolve 后的真实工程内路径
      const resolved = binding.handle.resolve(path)
      const lookup = resolved !== path && client.entry(resolved) ? resolved : path
      if (client.entry(lookup)) {
        try {
          const { file, version } = await client.readSnapshot(lookup, false)
          return { text: await file.text(), version }
        } catch {
          /* 读不到就退回本机缓存，至少不要阻断工具 */
        }
      }
    }
    const host = hostOf()
    return { text: host ? await host.readSavedText(path) : null, version: null }
  }

  const readLangState = async (
    _pkgId: string,
    path: string,
  ): Promise<{
    map: Record<string, string>
    version: string | null
    draft: boolean
    saved: boolean
    hasLocalMirror: boolean
    localDraft: boolean
  }> => {
    const state = await readLangDraft(stagedLangText, path, () => readLangSaved(path))
    return {
      map: state.map,
      version: state.savedVersion,
      draft: state.draft,
      // R1：saved 只表示「S 里已有已保存版本」，本机镜像不算
      saved: state.hasSaved,
      hasLocalMirror: state.hasLocalMirror,
      localDraft: state.draft,
    }
  }

  /** 语言文本写入 = ProjectHost 的资产文本草稿通道（staged + 本机镜像） */
  const stageLangWrite = async (
    _pkgId: string,
    path: string,
    map: Record<string, string>,
    _options?: { allowUnwritable?: boolean },
  ): Promise<
    | { ok: true; localOnly: boolean; draft: true; saved: false; version: null }
    | { ok: false; error: string }
  > => {
    const host = hostOf()
    if (!host) return { ok: false, error: 'no project is open' }
    try {
      await host.stageAssetText(path, stringifyTextFile(map))
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
    const localOnly = getProjectSession().binding === null
    return { ok: true, localOnly, draft: true, saved: false, version: null }
  }

  /** 跨包同名时 `findScriptByName` 会抛异常：宿主统一转成稳定的英文错误，不再让异常逃逸 */
  const agentDuplicateNameError = (source: string): AgentOpResult => ({
    ok: false,
    reason: 'not_unique',
    error: `resource name is not unique: ${source}`,
    hint: 'pass the full project path (with directory) to disambiguate',
  })

  /**
   * 找源文件：工作区元数据优先；工程树里已有、但工作区还没加载的文件
   * （`ProjectHost.listFiles` 才看得到）用占位 SourceFile 顶替，正文仍从宿主读。
   */
  const findAgentScript = (
    source: string,
  ): { hit: AgentScriptHit } | { error: AgentOpResult; notFound?: boolean } => {
    try {
      const hit = findScriptByName(workspaceRef.current, source)
      if (hit) return { hit }
    } catch {
      return { error: agentDuplicateNameError(source) }
    }
    const wanted = sourceKeyOf(source)
    const file = hostOf()
      ?.listFiles()
      .find(
        (item) =>
          item.kind === 'source' &&
          (sourceKeyOf(item.path) === wanted || sourceKeyOf(baseNameOf(item.path)) === wanted),
      )
    if (file) {
      const id = hostOnlyId(file.path)
      hostOnlyPaths.set(id, file.path)
      return {
        hit: {
          pkg: workspaceRef.current.packages[0] ?? syntheticPackage(),
          script: { id, name: baseNameOf(file.path), content: '', updatedAt: 0 },
        },
      }
    }
    return {
      error: {
        ok: false,
        reason: 'not_found',
        error: `file not found: ${source}`,
      },
      notFound: true,
    }
  }


  /** 语言工具的目标：源文件 + 语言 → 所属包、资产路径与当前译文表 */
  const langTargetOf = async (sourceName: string, localeArg?: string) => {
    const found = findAgentScript(sourceName)
    if ('error' in found) return found
    const hit = found.hit
    const lang = localeArg?.trim() || currentLocale()
    const path = langAssetPathFor(hit.script.name, lang)
    const state = await readLangState(hit.pkg.id, path)
    return {
      hit,
      lang,
      path,
      map: state.map,
      version: state.version,
      draft: state.draft,
      saved: state.saved,
      hasLocalMirror: state.hasLocalMirror,
      localDraft: state.localDraft,
    }
  }

  /** Agent 写源文件名前的校验：`.lang` 不当普通文件写（走 write_lang） */
  const normalizeAgentSource = (
    raw: string,
  ): { name: string } | { error: AgentOpResult } => {
    const normalized = normalizeResourceName(raw)
    if (!normalized) {
      return {
        error: {
          ok: false,
          reason: 'invalid_arguments',
          error: `invalid file name; extensions allowed: ${ALLOWED_EXTENSIONS_LABEL}`,
        },
      }
    }
    if (normalized.toLowerCase().endsWith('.lang')) {
      return {
        error: {
          ok: false,
          reason: 'invalid_arguments',
          error: 'language text cannot be written as a normal file',
          hint: 'use list_lang_keys to inspect keys and write_lang to write translations (keys come from the source text)',
        },
      }
    }
    return { name: normalized }
  }

  /**
   * A2：agent 传来的逻辑文件名统一校验（`lock_source(creating)` / `create_source` 共用）。
   * 非法名（含路径分隔符 / `..` / 未知后缀）一律返回英文 invalid_arguments，**不抛异常**。
   */
  const invalidAgentSourceName = (name: string): {
    ok: false
    reason: 'invalid_arguments'
    error: string
    hint: string
  } => ({
    ok: false,
    reason: 'invalid_arguments',
    error: `invalid file name: ${name}; logical names cannot contain path separators or start with ".."`,
    hint: 'use a logical file name like chapter.hs (no directories, no leading "..")',
  })

  const validateAgentSourceName = (
    raw: string,
  ): { name: string } | { error: ReturnType<typeof invalidAgentSourceName> } => {
    try {
      const checked = normalizeAgentSource(raw)
      if ('error' in checked) return { error: invalidAgentSourceName(raw) }
      return checked
    } catch {
      return { error: invalidAgentSourceName(raw) }
    }
  }

  /**
   * 解析 agent 传来的 locale —— **工程优先**：工程里已有就沿用，其次按语言表规范化
   * （`en` → `en_us`、`ja` → `ja_jp`），最后才落地为自定义标签。
   * 裸语言码对应多个地区且都不常用（`de` → `de_de` / `de_at`）时不猜，回报候选。
   */
  const resolveAgentLocale = (
    raw?: string,
  ): { locale: string; note?: string } | { error: AgentOpResult } => {
    const requested = (raw ?? '').trim() || currentLocale()
    const projectLocales = listLocalesOf(workspaceRef.current).map(
      (item) => item.locale,
    )
    const exact = projectLocales.find(
      (item) => item.toLowerCase() === requested.toLowerCase(),
    )
    if (exact) return { locale: exact }

    const resolved = resolveLocaleTag(requested)
    if (!resolved.tag) {
      return {
        error: {
          ok: false,
          reason: 'invalid_arguments',
          error: `invalid locale tag: ${requested}`,
          hint: 'use a lowercase language-region tag such as zh_cn / en_us / ja_jp',
        },
      }
    }

    if (resolved.ambiguous) {
      return {
        error: {
          ok: false,
          reason: 'invalid_arguments',
          error: `ambiguous locale tag: ${requested}`,
          candidates: resolved.ambiguous,
          hint: 'pick one of the candidates and retry',
        },
      }
    }

    // 工程里已有等价标签（工程是 en_us、请求是 en）→ 一律以工程为准
    const equivalent = projectLocales.find(
      (item) => item.toLowerCase() === resolved.tag.toLowerCase(),
    )
    if (equivalent) {
      return { locale: equivalent, note: `${requested} → ${equivalent} (already in the project)` }
    }
    return { locale: resolved.tag, note: resolved.note }
  }

  /** P2：键名是文本哈希；同一 locale 重新 parse 会按该语言映射同文本复用键，换 locale 才重新哈希 */
  const LANG_KEY_IDENTITY_NOTE =
    'keys are text hashes; re-running parse_hs in the same locale reuses keys by matching text in that language\'s mapping, while parsing in another locale hashes the new text and creates new keys'

  /** P7：`assets/<locale>/voice_<ext>/<dir>/<key>.ogg|.ref` → 语言、源逻辑名、键名 */
  const voiceAssetTargetOf = (
    assetPath: string,
  ): { locale: string; source: string; key: string } | null => {
    const parsed = parseLocaleAssetPath(assetPath)
    if (!parsed || parsed.kind !== 'voice') return null
    const rest = parsed.rest.replace(/\\/g, '/')
    if (!/\.(ogg|ref)$/i.test(rest)) return null
    const withoutExt = rest.slice(0, rest.lastIndexOf('.'))
    const slash = withoutExt.lastIndexOf('/')
    if (slash <= 0) return null
    const key = withoutExt.slice(slash + 1)
    if (!key) return null
    return {
      locale: parsed.locale,
      source: `${withoutExt.slice(0, slash)}.${parsed.sourceExt}`,
      key,
    }
  }

  type OrphanVoiceAsset = {
    path: string
    locale: string
    source: string
    key: string
    reason: 'source_missing' | 'key_missing'
  }

  /** P7：工程里不属于任何现存源/键的配音资产 */
  const orphanVoiceAssetsOf = (targetWorkspace: Workspace): OrphanVoiceAsset[] => {
    const out: OrphanVoiceAsset[] = []
    const cache = new Map<string, Set<string> | null | 'ambiguous'>()
    for (const pkg of targetWorkspace.packages) {
      for (const asset of pkg.assets) {
        const target = voiceAssetTargetOf(asset.path)
        if (!target) continue
        if (!cache.has(target.source)) {
          try {
            const hit = findScriptByName(targetWorkspace, target.source)
            cache.set(
              target.source,
              hit
                ? new Set(
                    collectSourceKeys(hit.script.content, hit.script.name).map(
                      (item) => item.key,
                    ),
                  )
                : null,
            )
          } catch {
            cache.set(target.source, 'ambiguous')
          }
        }
        const keys = cache.get(target.source)
        // 跨包同名时无法判断归属：宁可不算 orphan，避免误报
        if (keys === 'ambiguous' || keys === undefined) continue
        if (keys === null) {
          out.push({ ...target, path: asset.path, reason: 'source_missing' })
          continue
        }
        if (!keys.has(target.key)) {
          out.push({ ...target, path: asset.path, reason: 'key_missing' })
        }
      }
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  }

  const agentHost: AgentHost = {
    /** A2：工具在 lock_source(creating) / create_source 前统一校验逻辑名 */
    validateSourceName: (name) => {
      try {
        const checked = normalizeAgentSource(name)
        if ('error' in checked) return invalidAgentSourceName(name)
        return { ok: true, name: checked.name }
      } catch {
        return invalidAgentSourceName(name)
      }
    },
    listSources: (packageName) => {
      const filter = packageName?.trim().toLowerCase()
      const workspace = workspaceRef.current
      const metadata = new Map<string, { pkg: Project; script: SourceFile }>()
      for (const pkg of workspace.packages) {
        for (const script of pkg.scripts) {
          metadata.set(sourceKeyOf(script.name), { pkg, script })
        }
      }
      const host = hostOf()
      const paths = host
        ? host.listFiles().filter((item) => item.kind === 'source').map((item) => item.path)
        : [...metadata.values()].map((item) => item.script.name)
      const files = paths
        .map((path) => {
          const meta = metadata.get(sourceKeyOf(path))
          const packageName = meta?.pkg.name ?? ''
          return {
            package: packageName,
            source: meta?.script.name ?? path,
            kind: sourceKindOf(meta?.script.name ?? path, meta?.script.srcKind),
            bytes: meta?.script.content.length ?? 0,
            updatedAt: meta?.script.updatedAt ?? 0,
            /** 已从工程移除、只剩本机恢复草稿的文件：可读，但不能再写 */
            detached: meta?.script.detached === true,
            order: meta?.pkg.id ?? '',
          }
        })
        .filter((file) => !filter || file.package.toLowerCase() === filter)
        .sort((a, b) =>
          a.order === b.order
            ? a.source < b.source
              ? -1
              : a.source > b.source
                ? 1
                : 0
            : a.order < b.order
              ? -1
              : 1,
        )
        .map(({ order: _order, ...file }) => file)
      return {
        ok: true,
        files,
        count: files.length,
        /** B12：工具看到的是工作区视角，包含未保存草稿 */
        includesDrafts: true,
      }
    },
    readSource: (source, offset, limit) => {
      const found = findAgentScript(source)
      if ('error' in found) return found.error
      const hit = found.hit
      const content = agentSourceContent(hit.script.id) ?? hit.script.content
      const totalLines = content.split('\n').length
      const offsetError = sourceOffsetError(totalLines, offset)
      if (offsetError) return { ...offsetError, reason: 'invalid_arguments' }
      const page = paginateSource(content, offset, limit)
      return {
        ok: true,
        source: hit.script.name,
        kind: sourceKindOf(hit.script.name, hit.script.srcKind),
        ...page,
      }
    },
    /** 锁协议要完整正文：版本哈希按全文算（截断会让锁校验错位） */
    readFullSource: (source) => {
      const found = findAgentScript(source)
      if ('error' in found) return found.error
      const hit = found.hit
      return {
        ok: true,
        source: hit.script.name,
        content: agentSourceContent(hit.script.id) ?? hit.script.content,
      }
    },
    /**
     * 人类是否正在改这个文件（文档 §8 human_editing）。
     *
     * 两种形态：
     * - 源文件：编辑器缓冲的归属就是判据 —— 归属匹配且缓冲内容与已提交正文不同；
     * - 语言文本（`.lang`）：语言编辑器的译文改动经 textSink `stageWrite` 登记进工程事务，
     *   所以看该语言文件有没有**未保存的工程草稿**（`transactions.hasDraft`）。
     *   以前这里按源逻辑名找脚本，`.lang` 永远找不到 → `lock_lang` 的 human_editing 永不触发。
     */
    isHumanDirty: (source) => {
      const normalized = normalizeSourcePath(source)
      if (parseLocaleAssetPath(normalized)?.kind === 'text') {
        return hostOf()?.isHumanDirty?.(normalized) ?? false
      }
      const found = findAgentScript(source)
      if ('error' in found) return false
      return hostOf()?.isHumanDirty?.(hostPathOfScript(found.hit.script.id)) ?? false
    },
    createSource: (source, content) => {
      // A2：`../evil.hs` / 带目录的名字一律 invalid_arguments，不能抛异常落到 host_error
      const checked = validateAgentSourceName(source)
      if ('error' in checked) return checked.error
      // 剧本工作区现在接受非剧本类资源（脚本 / 游戏性 / meta），但仍不许新建语言与配音映射
      if (checked.name.toLowerCase().endsWith('.voice')) {
        return {
          ok: false,
          reason: 'invalid_arguments',
          error: 'voice mapping files cannot be created with create_source',
          hint: 'use the UI or the write_voice workflow for voice mappings',
        }
      }
      const existing = findAgentScript(checked.name)
      if ('error' in existing && existing.notFound !== true) return existing.error
      if ('hit' in existing) {
        return {
          ok: false,
          reason: 'already_exists',
          error: `file already exists: ${checked.name}`,
          hint: 'Use write_source to overwrite the existing file, or edit_source for a partial edit.',
        }
      }
      const host = hostOf()
      if (!host) return { ok: false, reason: 'host_error', error: 'no project is open' }

      // 新建草稿走平台的写草稿通道：ProjectHost 负责把它挂进当前工程
      try {
        host.writeDraft(checked.name, content)
      } catch (error) {
        return {
          ok: false,
          reason: 'write_failed',
          error: error instanceof Error ? error.message : 'could not create the file',
        }
      }
      // 新建**不切换**当前打开的文件：agent 造文件不该动用户正在看的东西
      return { ok: true, source: checked.name, created: true, changed: true, activeUnchanged: true }
    },
    writeSource: (source, content) => {
      const checked = normalizeAgentSource(source)
      if ('error' in checked) return checked.error

      const found = findAgentScript(checked.name)
      if ('error' in found) {
        return found.notFound === true
          ? {
              ...found.error,
              hint: 'use create_source to create a new file; write_source only overwrites existing files',
            }
          : found.error
      }
      const existing = found.hit
      if (existing.script.detached === true) {
        return {
          ok: false,
          reason: 'detached',
          error: 'resource was removed from the project; ask the user to save it as a new file',
          hint: 'detached drafts can be read but not written; let the user save it as a new file first',
        }
      }
      // 版本前置条件不在这里校验：严格模式由锁协议保证（未持锁在 tools.ts 就被拒）
      const before = agentSourceContent(existing.script.id) ?? existing.script.content
      const written = applyAgentFileWrite(
        existing.script.id,
        content,
      )
      if (!written) {
        return {
          ok: false,
          reason: 'write_failed',
          error: 'write failed: could not apply the new content',
        }
      }
      return {
        ok: true,
        source: written.file,
        created: false,
        changed: content !== before,
      }
    },
    editSource: (source, oldText, newText, replaceAll) => {
      const found = findAgentScript(source)
      if ('error' in found) return found.error
      const hit = found.hit
      if (hit.script.detached === true) {
        return {
          ok: false,
          reason: 'detached',
          error: 'resource was removed from the project; ask the user to save it as a new file',
          hint: 'detached drafts can be read but not written; let the user save it as a new file first',
        }
      }
      const content = agentSourceContent(hit.script.id) ?? hit.script.content
      const edited = applyTextEdit(content, oldText, newText, replaceAll)
      if (!edited.ok) {
        return { ok: false, reason: 'invalid_arguments', error: edited.error }
      }
      const written = applyAgentFileWrite(
        hit.script.id,
        edited.content,
      )
      if (!written) {
        return {
          ok: false,
          reason: 'write_failed',
          error: 'edit failed: could not apply the edited content',
        }
      }
      return {
        ok: true,
        source: written.file,
        changed: edited.content !== content,
        replaced: edited.count,
      }
    },
    /**
     * 只从**本机工作区草稿**里移除文件（不写 S）：撤销日志回放「本 Run 新建的文件」。
     * 与界面删除不同：不删资产、不发结构事务，也不弹确认。
     */
    discardDraftSource: (source) => {
      const found = findAgentScript(source)
      if ('error' in found) return
      removeScriptSilent(found.hit.script.id)
    },
    validateSource: (source) => {
      const found = findAgentScript(source)
      if ('error' in found) {
        return found.error.reason === 'not_found'
          ? {
              ...found.error,
              hint: 'use list_sources to find the file; names are logical (no directories)',
            }
          : found.error
      }
      const hit = found.hit
      const content = agentSourceContent(hit.script.id) ?? hit.script.content
      const result = validateSourceContent(hit.script.name, content, {
        foreignInjects: indexForeignHsInjects(
          workspaceRef.current,
          hit.script.name,
        ),
      })
      // P10：编辑器诊断与 agent lint 分开；ok 只反映编译结果（lint 不再让 ok=false）
      const diagnostics = result.diagnostics.filter(
        (item) => item.kind !== 'agent-lint',
      )
      const agentLint = result.diagnostics.filter(
        (item) => item.kind === 'agent-lint',
      )
      return {
        ok: result.compileError === null,
        source: hit.script.name,
        diagnostics,
        agentLint,
        compileError: result.compileError,
      }
    },
    getActiveFilePath: () => {
      const path = hostOf()?.getActivePath() ?? null
      if (!path) return { ok: false, error: 'no file is currently open' }
      const found = findAgentScript(path)
      const localeAsset = parseLocaleAssetPath(path)
      return {
        ok: true,
        source: 'hit' in found ? found.hit.script.name : baseNameOf(path),
        kind: localeAsset ? 'asset' : sourceKindOf(path),
        path,
        hint: 'path is informational only; tool arguments still use the logical source name',
      }
    },
    listLocales: () => ({
      ok: true,
      active: currentLocale(),
      locales: listLocalesOf(workspaceRef.current).map((item) => {
        const entry = resolveLocale(item.locale)
        return {
          ...item,
          label: entry.nativeName,
          chineseName: entry.chineseName,
          inTable: Boolean(findLocale(item.locale)),
        }
      }),
      /** 新语言请从这些规范标签里挑，别再自己拼 */
      suggestions: COMMON_LOCALES.map((entry) => ({
        locale: entry.tag,
        label: entry.nativeName,
      })),
    }),
    /**
     * 源文件派生的语言资产目标（`lock_lang` 用，文档 D2）：
     * 省略 `locales` = 工程已有语言 + 当前语言；传入时按传入顺序/筛选解析。
     */
    derivedLangTargets: (source, locales) => {
      const found = findAgentScript(source)
      if ('error' in found) return []
      const hit = found.hit
      const projectLocales = listLocalesOf(workspaceRef.current).map((item) => item.locale)
      const tags: string[] = []
      const seen = new Set<string>()
      const push = (raw: string) => {
        const requested = raw.trim()
        if (!requested) return
        // 工程优先（与 resolveAgentLocale 同口径）：工程里有裸标签 `en` 时不能被
        // 语言表改写成 `en_us`，否则会锁到一个不存在的资产路径。
        const projectMatch = projectLocales.find(
          (tag) => tag.toLowerCase() === requested.toLowerCase(),
        )
        const resolved = projectMatch ?? resolveLocaleTag(requested).tag
        if (!resolved || seen.has(resolved)) return
        seen.add(resolved)
        tags.push(resolved)
      }
      if (locales && locales.length > 0) {
        for (const requested of locales) push(requested)
      } else {
        for (const tag of projectLocales) push(tag)
        if (currentLocale()) push(currentLocale())
      }
      return tags.map((tag) => ({ locale: tag, path: langAssetPathFor(hit.script.name, tag) }))
    },
    /** 读派生语言资产正文（S 权威优先）：锁版本与 write_lang 写前校验用 */
    readAssetText: async (path) => {
      // 草稿优先：锁版本 / noteWritten 必须看到 agent 刚写进 staged 的内容，
      // 否则写后版本会和锁表锚点对不上（下一轮误判 version_stale）。
      const staged = stagedLangText(path)
      if (staged !== undefined) return staged
      const binding = getProjectSession().binding
      const client = binding?.handle.client
      // 未绑定工程：工程内容只存在于本机通道，直接读宿主 saved 视图（不碰 IDB）
      if (!binding || !client) {
        const host = hostOf()
        return host ? host.readSavedText(path) : null
      }
      if (client.entry(path)) {
        try {
          const { file } = await client.readSnapshot(path, false)
          return await file.text()
        } catch {
          return null
        }
      }
      const packageId =
        client.assetPackageId ??
        binding.manifest.id ??
        workspaceRef.current.packages[0]?.id
      if (packageId) {
        const blob = await getAssetBlob(packageId, path)
        if (blob) return blob.text()
      }
      const host = hostOf()
      return host ? host.readSavedText(path) : null
    },
    /**
     * 撤销日志回放「语言草稿」（D3 / 阶段 4）：
     * - `content` 非空：把该 `.lang` 的 staged 草稿写回写前内容（同一 stageWrite 通道）；
     * - `content === null`：这个语言文件是本 Run 新建的 → 撤掉 staged 草稿，
     *   并把 agent 写进镜像 / 工作区的这份新建资产一并移除（否则保存会把它再写回去）。
     *
     * 由 runtime 在回滚时调用，必须幂等：重复调用只会落到同一份草稿 / 已是空操作。
     */
    writeLangDraft: async (path, content) => {
      const normalized = normalizeSourcePath(path)
      const host = hostOf()
      if (!host) {
        throw new Error(`language draft replay failed: no project available (${normalized})`)
      }

      if (content === null) {
        // 撤掉 staged 草稿；清镜像 / 工作区资产由 bridge 的 discardAssetText 负责
        try {
          await host.discardAssetText?.(normalized)
        } catch (error) {
          throw new Error(
            `language draft replay failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        return
      }

      try {
        await host.stageAssetText(normalized, content)
      } catch (error) {
        throw new Error(
          `language draft replay failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    },
    listLangKeys: async (source, localeArg, offset, limit) => {
      const resolved = resolveAgentLocale(localeArg)
      if ('error' in resolved) return resolved.error
      const target = await langTargetOf(source, resolved.locale)
      if ('error' in target) return target.error
      const content =
        agentSourceContent(target.hit.script.id) ?? target.hit.script.content
      const keys = collectSourceKeys(content, target.hit.script.name)
      const start = Math.max(1, Math.floor(offset ?? 1) || 1)
      // B2：与 read_source 对齐，越界不要返回 ok:true + 空 entries
      if (start > Math.max(1, keys.length)) {
        return {
          ok: false,
          reason: 'invalid_arguments',
          error: 'offset out of range',
          total: keys.length,
          hint: 'use offset <= total',
        }
      }
      const count = Math.min(Math.max(1, Math.floor(limit ?? 200) || 200), 1000)
      const page = keys.slice(start - 1, start - 1 + count)
      const entries = page.map((item) => {
        const hasEntry = item.key in target.map
        const text = hasEntry ? target.map[item.key]! : null
        return {
          key: item.key,
          line: item.line,
          /** 缺失条目为 null；空串条目保留 '' */
          text,
          hasEntry,
          /** 空串不算已翻译（与 check_export 的 trim 口径一致） */
          translated: text !== null && text.trim() !== '',
        }
      })
      // P9：map 里有、正文已经没有的键（翻译记忆残留）；截断 200，同时给总数
      const orphan = collectOrphanKeys(
        keys.map((item) => item.key),
        target.map,
      )
      const orphanLimit = 200
      // B6：正文里还能成键、但尚未成键的文本（只统计，不修改正文）
      const unparsed = countUnparsedTexts(content, target.hit.script.name)
      const localeInProject = listLocalesOf(workspaceRef.current).some(
        (item) => item.locale.toLowerCase() === target.lang.toLowerCase(),
      )
      return {
        ok: true,
        source: target.hit.script.name,
        locale: target.lang,
        /** 该源文件在该语言下的 `.lang` 是否已保存在工程里（只认 S 已保存版本） */
        localeExists: target.saved,
        /** 工程语言表里是否有该语言（其它源文件有该语言资产也算） */
        localeInProject,
        /** 是否是编辑器当前正在编辑的语言 */
        active: target.lang.toLowerCase() === currentLocale().toLowerCase(),
        path: target.path,
        /** 已保存工程文件里的内容哈希；null = S 里没有已保存版本 */
        version: target.version,
        /** B8：`version` 的显式别名，避免被误读成“当前生效内容版本” */
        savedVersion: target.version,
        /** true = 读到的内容来自本地未保存草稿（D1） */
        draft: target.draft,
        /** true = S 里已有已保存版本（有草稿也 true；本机镜像不算） */
        saved: target.saved,
        /** B8：语义自解释 —— 该 `.lang` 已保存到工程文件（本机镜像不算） */
        hasSaved: target.saved,
        /** R1：本机有镜像/缓存但 S 无已保存版本（新建工程渲染过该语言常见） */
        hasLocalMirror: target.hasLocalMirror,
        hasDraft: target.draft,
        /** 兼容旧字段名 */
        localDraft: target.localDraft,
        /** 正文里已不存在的译文键（orphan）；可用 delete_lang_keys 清理 */
        orphanKeys: orphan.slice(0, orphanLimit),
        orphanTotal: orphan.length,
        orphanTruncated: orphan.length > orphanLimit,
        /** 尚未成键的可本地化文本数量与样例（最多 3 条） */
        unparsedTextCount: unparsed.count,
        unparsedSamples: unparsed.samples.slice(0, 3),
        /** 本语言的正文键数量（不是 `.lang` 文件条目数） */
        total: keys.length,
        missing: keys.filter((item) => !(item.key in target.map)).length,
        offset: start,
        truncated: start - 1 + page.length < keys.length,
        entries,
      }
    },
    writeLang: async (source, translations) => {
      const found = findAgentScript(source)
      if ('error' in found) return found.error
      const hit = found.hit
      const plan: Array<{ locale: string; entries: LangEntry[] }> = []
      const notes: string[] = []
      for (const requested of Object.keys(translations)) {
        const entries = translations[requested] ?? []
        if (entries.length === 0) continue
        const resolved = resolveAgentLocale(requested)
        if ('error' in resolved) return resolved.error
        if (resolved.note) notes.push(resolved.note)
        const hit = plan.find((item) => item.locale === resolved.locale)
        if (hit) hit.entries.push(...entries)
        else plan.push({ locale: resolved.locale, entries: [...entries] })
      }
      if (plan.length === 0) {
        return { ok: false, reason: 'invalid_arguments', error: 'translations is empty' }
      }

      // D6：不做 trim / 小写归一化；键必须已存在于正文，且形态严格 8 位小写十六进制。
      // 任一键有问题都整次失败，不写半份草稿。
      const invalidKeys: string[] = []
      const duplicates: string[] = []
      for (const step of plan) {
        const check = validateLangKeys(step.entries.map((entry) => entry.key))
        invalidKeys.push(...check.invalidKeys)
        duplicates.push(...check.duplicates)
      }
      if (invalidKeys.length > 0 || duplicates.length > 0) {
        return {
          ok: false,
          reason: 'invalid_keys',
          error: 'invalid language keys; nothing was written',
          invalidKeys,
          duplicates,
          hint: 'keys must be exactly 8 lowercase hex characters generated from the source text',
        }
      }

      const content = agentSourceContent(hit.script.id) ?? hit.script.content
      const known = new Set(
        collectSourceKeys(content, hit.script.name).map((item) => item.key),
      )
      // A5：按正文 span 判断该键是普通对白 / 选项文案 / 选项回复，再评估译文能否安全写回正文
      const inlineContexts = new Map<string, InlineContext>()
      for (const span of parseTextSpans(content)) {
        const key = span.value.trim()
        if (!key || inlineContexts.has(key)) continue
        inlineContexts.set(
          key,
          span.kind === 'choice-label'
            ? 'optionText'
            : span.kind === 'choice-reply'
              ? 'optionReply'
              : 'dialogue',
        )
      }
      const riskWarnings: Array<{ locale: string; key: string; reasons: string[] }> = []
      for (const step of plan) {
        for (const entry of step.entries) {
          const reasons = assessLangValueRisks(
            entry.text,
            inlineContexts.get(entry.key) ?? 'dialogue',
          )
          if (reasons.length > 0) {
            riskWarnings.push({ locale: step.locale, key: entry.key, reasons })
          }
        }
      }
      const riskHint =
        'some values cannot be safely restored into the script by unparse_hs; edit the source text or avoid //, :, and leading structural characters'
      const results: Array<Record<string, unknown>> = []
      const writtenPaths: string[] = []
      const failures: string[] = []
      let writtenTotal = 0
      let failedTotal = 0
      let localOnly = false
      /** 所有被跳过（正文里不存在）的键；P8 用来区分“键不在正文”与“写失败” */
      const skippedAll = new Set<string>()

      for (const step of plan) {
        const locale = step.locale
        const path = langAssetPathFor(hit.script.name, locale)
        const state = await readLangState(hit.pkg.id, path)
        const next = { ...state.map }
        const written: string[] = []
        const skipped: string[] = []
        for (const entry of step.entries) {
          const key = entry.key
          if (!known.has(key)) {
            skipped.push(entry.key)
            skippedAll.add(entry.key)
            continue
          }
          next[key] = entry.text
          written.push(key)
        }
        if (written.length === 0) {
          results.push({
            locale,
            path,
            written,
            skipped,
            writtenCount: 0,
            fileTotal: Object.keys(next).length,
            /** 兼容旧字段：与 fileTotal 同值 */
            total: Object.keys(next).length,
            draft: false,
            saved: false,
          })
          continue
        }
        const staged = await stageLangWrite(hit.pkg.id, path, next)
        if (!staged.ok) {
          failedTotal += written.length
          failures.push(`${locale}: ${staged.error}`)
          results.push({
            locale,
            path,
            written,
            skipped,
            writtenCount: written.length,
            fileTotal: Object.keys(next).length,
            total: Object.keys(next).length,
            draft: false,
            saved: false,
            error: staged.error,
          })
          continue
        }
        writtenPaths.push(path)
        writtenTotal += written.length
        if (staged.localOnly) localOnly = true
        results.push({
          locale,
          path,
          written,
          skipped,
          writtenCount: written.length,
          fileTotal: Object.keys(next).length,
          total: Object.keys(next).length,
          /** D1：只是本地草稿，等用户保存工程才进文件 */
          draft: true,
          saved: false,
          version: null,
          ...(staged.localOnly ? { localOnly: true, savedToProject: false } : {}),
        })
      }

      if (writtenTotal === 0) {
        // P8：没有写失败、全是“正文里没有这个键”时，给模型一个明确的 reason，别再让它猜
        if (failedTotal === 0 && skippedAll.size > 0) {
          return {
            ok: false,
            error: 'none of the provided keys exist in the source text',
            reason: 'keys_not_in_source',
            missingKeys: [...skippedAll],
            locales: results,
            notes,
            writtenPaths,
            hint: 'run list_lang_keys to see the keys that exist in the source text, or parse_hs to create keys from new text',
          }
        }
        return {
          ok: false,
          reason: failedTotal > 0 ? 'write_failed' : 'invalid_arguments',
          error:
            failedTotal > 0
              ? `language drafts were not written: ${failures.join('; ')}`
              : 'no keys from the source text were provided',
          locales: results,
          notes,
          writtenPaths,
          ...(riskWarnings.length > 0
            ? { warnings: riskWarnings, warningCount: riskWarnings.length }
            : {}),
          hint:
            failedTotal > 0
              ? 'check write permission / network and retry; writing translations does not change the source text, but confirm the source keys exist in the draft or project file'
              : 'keys live in the source text (inline `narrator:7f3a91c2//`, or a key alone on its line inside a multi-line block); use list_lang_keys to inspect them, or run parse_hs first',
        }
      }
      return {
        ok: true,
        source: hit.script.name,
        locales: results,
        notes,
        /** 哪些 `.lang` 的**本地草稿**被写（工具层据此更新锁版本） */
        writtenPaths,
        draft: true,
        saved: false,
        version: null,
        ...(localOnly ? { localOnly: true } : {}),
        ...(failures.length > 0 ? { writeFailures: failures } : {}),
        ...(riskWarnings.length > 0
          ? {
              warnings: riskWarnings,
              warningCount: riskWarnings.length,
              hint: riskHint,
            }
          : {}),
      }
    },
    deleteLangKeys: async (source, keys, localeArg, force) => {
      const resolved = resolveAgentLocale(localeArg)
      if ('error' in resolved) return resolved.error
      const target = await langTargetOf(source, resolved.locale)
      if ('error' in target) return target.error
      // D6：键必须是 8 位小写十六进制；非法/重复整次失败，不写半份草稿
      const keyCheck = validateLangKeys(keys)
      if (keyCheck.invalidKeys.length > 0 || keyCheck.duplicates.length > 0) {
        return {
          ok: false,
          reason: 'invalid_keys',
          error: 'invalid language keys; nothing was deleted',
          invalidKeys: keyCheck.invalidKeys,
          duplicates: keyCheck.duplicates,
          hint: 'keys must be exactly 8 lowercase hex characters returned by list_lang_keys',
        }
      }
      // C3：默认不删正文仍在引用的键（force:true 才允许，用于清理/改名前的显式覆盖）
      const content =
        agentSourceContent(target.hit.script.id) ?? target.hit.script.content
      const known = new Set(
        collectSourceKeys(content, target.hit.script.name).map((item) => item.key),
      )
      const inUseKeys = keys.filter((key) => known.has(key))
      if (force !== true && inUseKeys.length > 0) {
        return {
          ok: false,
          reason: 'keys_in_use',
          error: 'keys are still referenced by the source text',
          inUseKeys,
          hint: 'remove or rename them in the text first, or pass force:true to delete anyway',
        }
      }
      // N1：键身份来自创建时文本哈希；删除后重新 parse 可能换键
      const deleteNote =
        'key identity comes from the text hash at creation time; re-running parse_hs in this language after deleting entries will hash the current text and may produce new keys, leaving the deleted ones orphan in other languages'
      const stillReferencedWarnings =
        force === true
          ? inUseKeys.map((key) => ({ reason: 'still-referenced', key }))
          : []
      const next = { ...target.map }
      const removed: string[] = []
      for (const key of keys) {
        if (!(key in next)) continue
        delete next[key]
        removed.push(key)
      }
      if (removed.length === 0) {
        return {
          ok: true,
          removed: [],
          total: Object.keys(next).length,
          draft: true,
          saved: false,
          version: null,
          note: deleteNote,
          ...(stillReferencedWarnings.length > 0
            ? { warnings: stillReferencedWarnings }
            : {}),
        }
      }

      const staged = await stageLangWrite(target.hit.pkg.id, target.path, next)
      if (!staged.ok) {
        return {
          ok: false,
          reason: 'write_failed',
          error: `language draft was not written: ${staged.error}`,
          source: target.hit.script.name,
          locale: target.lang,
          removed,
          total: Object.keys(target.map).length,
          hint: 'check write permission / network and retry',
        }
      }
      return {
        ok: true,
        source: target.hit.script.name,
        locale: target.lang,
        removed,
        total: Object.keys(next).length,
        writtenPaths: [target.path],
        draft: true,
        saved: false,
        version: null,
        note: deleteNote,
        ...(stillReferencedWarnings.length > 0
          ? { warnings: stillReferencedWarnings }
          : {}),
        ...(staged.localOnly ? { localOnly: true } : {}),
      }
    },
    listVoiceStatus: async (source, localeArg, offset, limit, orphanOnly) => {
      const found = findAgentScript(source)
      if ('error' in found) return found.error
      const hit = found.hit
      const content = agentSourceContent(hit.script.id) ?? hit.script.content
      const keys = collectSourceKeys(content, hit.script.name).map(
        (item) => item.key,
      )
      const resolved = resolveAgentLocale(localeArg)
      if ('error' in resolved) return resolved.error
      const lang = resolved.locale
      const start = Math.max(1, Math.floor(offset ?? 1) || 1)
      const count = Math.min(Math.max(1, Math.floor(limit ?? 100) || 100), 500)

      // P7：orphanOnly = 只看“不属于任何现存源/键”的配音；显式给 locale 时按语言筛选
      if (orphanOnly === true) {
        const explicitLocale = localeArg?.trim()
        const orphans = orphanVoiceAssetsOf(workspaceRef.current).filter(
          (item) =>
            !explicitLocale || item.locale.toLowerCase() === lang.toLowerCase(),
        )
        const page = orphans.slice(start - 1, start - 1 + count)
        return {
          ok: true,
          source: hit.script.name,
          locale: lang,
          orphan: true,
          note: 'these voice assets do not belong to any existing source/key; they may be leftovers from renamed or deleted text',
          total: orphans.length,
          missingCount: orphans.length,
          missingSample: orphans.slice(0, 10).map((item) => item.key),
          offset: start,
          truncated: start - 1 + page.length < orphans.length,
          entries: page.map((item) => ({ ...item, state: 'orphan' as const })),
        }
      }

      const allEntries = await voiceStatusOf(
        hit.pkg.id,
        hit.pkg.assets,
        hit.script.name,
        lang,
        keys,
      )
      // B3：分页；不再回传完整 missing 数组，只给数量 + 最多 10 个样例
      const page = allEntries.slice(start - 1, start - 1 + count)
      const missing = allEntries.filter((item) => item.state === 'missing')
      return {
        ok: true,
        source: hit.script.name,
        locale: lang,
        total: allEntries.length,
        missingCount: missing.length,
        missingSample: missing.slice(0, 10).map((item) => item.key),
        offset: start,
        truncated: start - 1 + page.length < allEntries.length,
        entries: page,
      }
    },
    parseHs: async (source, localeArg) => {
      const found = findAgentScript(source)
      if ('error' in found) return found.error
      const hit = found.hit
      const resolved = resolveAgentLocale(localeArg)
      if ('error' in resolved) return resolved.error
      const lang = resolved.locale
      const path = langAssetPathFor(hit.script.name, lang)
      const state = await readLangState(hit.pkg.id, path)
      const map = state.map
      const before = agentSourceContent(hit.script.id) ?? hit.script.content
      const parsed = parseSourceText(before, map, hit.script.name)
      // 同文件重复文本会复用同一个键：entries 已去重，replaced 是实际替换语句数
      const parsedNote =
        parsed.replaced > parsed.entries.length
          ? `${LANG_KEY_IDENTITY_NOTE}; duplicate text in this script reuses the same key`
          : LANG_KEY_IDENTITY_NOTE

      if (parsed.entries.length === 0) {
        return {
          ok: true,
          source: hit.script.name,
          locale: lang,
          created: 0,
          replaced: parsed.replaced,
          changed: false,
          skipped: parsed.skipped,
          note: parsedNote,
          hint: 'no localizable text left to key (everything is already keyed, or it is after #stopparse)',
        }
      }

      // 自动成键生成的键也必须是 8 位小写十六进制（防御：解析器若漂移，不要写出非法 .lang）
      const parsedKeys = validateLangKeys(parsed.entries.map(([key]) => key))
      if (parsedKeys.invalidKeys.length > 0 || parsedKeys.duplicates.length > 0) {
        return {
          ok: false,
          reason: 'invalid_keys',
          error: 'parse_hs generated invalid language keys; nothing was written',
          invalidKeys: parsedKeys.invalidKeys,
          duplicates: parsedKeys.duplicates,
          hint: 'this is unexpected; the source text was not changed — report it with the script name',
        }
      }

      // 先把译文写进本地草稿，再改正文草稿：正文写入失败最多留下孤儿译文，
      // 不会出现"正文有键、语言草稿没有"（那正是导出预检和编辑器全红的状态）
      const next = { ...map }
      for (const [key, text] of parsed.entries) next[key] = text
      const staged = await stageLangWrite(hit.pkg.id, path, next)
      if (!staged.ok) {
        return {
          ok: false,
          reason: 'write_failed',
          error: `keying failed: ${staged.error}`,
          source: hit.script.name,
          locale: lang,
          created: 0,
          skipped: parsed.skipped,
          hint: 'the source text was not changed; check write permission / network and retry',
        }
      }

      const written = applyAgentFileWrite(
        hit.script.id,
        parsed.content,
      )
      if (!written) {
        return {
          ok: false,
          reason: 'write_failed',
          error: 'failed to update the source draft after writing translations',
          hint: 'the language draft was written; retry edit_source or ask the user to save',
        }
      }
      return {
        ok: true,
        source: written.file,
        locale: lang,
        created: parsed.entries.length,
        replaced: parsed.replaced,
        skipped: parsed.skipped,
        keys: parsed.entries.map(([key]) => key),
        note: parsedNote,
        writtenPaths: [path],
        draft: true,
        saved: false,
        version: null,
        ...(staged.localOnly ? { localOnly: true } : {}),
      }
    },
    unparseHs: async (source, localeArg) => {
      const found = findAgentScript(source)
      if ('error' in found) return found.error
      const hit = found.hit
      const resolved = resolveAgentLocale(localeArg)
      if ('error' in resolved) return resolved.error
      const lang = resolved.locale
      const path = langAssetPathFor(hit.script.name, lang)
      const state = await readLangState(hit.pkg.id, path)
      const map = state.map
      const before = agentSourceContent(hit.script.id) ?? hit.script.content
      const unparsed = unparseSourceText(before, map, hit.script.name)

      if (unparsed.replaced === 0) {
        const blocked =
          unparsed.multiline.length > 0 || unparsed.unrepresentable.length > 0
        return {
          ok: false,
          reason: 'invalid_arguments',
          error: 'no reversible keys found',
          source: hit.script.name,
          locale: lang,
          missing: unparsed.missing,
          multiline: unparsed.multiline,
          unrepresentable: unparsed.unrepresentable,
          hint: blocked
            ? 'multi-line keys were left as key names and values that cannot be inlined were skipped; use edit_source to edit those blocks, or unparse in the baseline language'
            : 'use list_lang_keys to confirm this locale has translations; multi-line translations cannot be unparsed yet',
        }
      }

      const written = applyAgentFileWrite(
        hit.script.id,
        unparsed.content,
      )
      if (!written) {
        return {
          ok: false,
          reason: 'write_failed',
          error: 'failed to update the source draft while removing keys',
          hint: 'edit_source can retry; the language draft was not changed',
        }
      }
      const blocked =
        unparsed.multiline.length > 0 || unparsed.unrepresentable.length > 0
      return {
        ok: true,
        source: written.file,
        locale: lang,
        replaced: unparsed.replaced,
        missing: unparsed.missing,
        multiline: unparsed.multiline,
        unrepresentable: unparsed.unrepresentable,
        note: LANG_KEY_IDENTITY_NOTE,
        ...(blocked
          ? {
              hint: 'multi-line keys were left as key names and values that cannot be inlined were skipped; use edit_source to edit those blocks, or unparse in the baseline language',
            }
          : {}),
      }
    },
    checkExport: async () => {
      hostOf()?.flushEditors()
      const workspace = getProjectSession().workspace
      let pak: Awaited<ReturnType<typeof buildResourcePackZip>>
      try {
        pak = await buildResourcePackZip(workspace)
      } catch (error) {
        /*
         * 引用解析不出来会让 PAK 导出**中止**（见 resourcePack）：预演要把这件事
         * 当成"这份工程现在导不出 PAK"报出去，而不是让工具调用直接炸掉 ——
         * Agent 拿到原话才能去修那条引用。
         */
        return {
          ok: false,
          reason: 'host_error',
          error: error instanceof Error ? error.message : String(error),
        }
      }
      const project = await buildProjectPackZip(workspace)
      // 译文完整性：导出预检必须能发现"正文有键、语言文件没文本"，
      // 否则用户在看不懂全红的编辑器里，还得靠肉眼翻 .lang 文件
      const localizable = workspace.packages.flatMap((pkg) =>
        pkg.scripts
          .filter(
            (script) =>
              !script.detached &&
              (script.name.toLowerCase().endsWith('.hs') ||
                script.name.toLowerCase().endsWith('.char')),
          )
          .map((script) => ({ name: script.name, content: script.content })),
      )
      const langReview = await collectMissingTranslationWarnings(
        localizable,
        listLocalesOf(workspace).map((item) => item.locale),
        async (sourceName, langTag) => {
          // 跨包同名时这里可能抛：预检不能让异常逃逸，退回空表（该文件的缺译文会由其它语言目标覆盖）
          const hit = (() => {
            try {
              return findScriptByName(workspace, sourceName)
            } catch {
              return null
            }
          })()
          if (!hit) return {}
          const path = langAssetPathFor(hit.script.name, langTag)
          const state = await readLangState(hit.pkg.id, path)
          return state.map
        },
      )
      // P9：每个语言资产做 orphan 统计；源文件不存在 / 源存在但译文键已不在正文
      const warningLimit = 200
      const translationsWarnings = langReview.warnings
      const orphanAssets: Array<{ path: string; locale?: string }> = []
      const orphanKeySummaries: Array<{ locale: string; source: string; count: number }> = []
      const orphanWarnings: string[] = []
      const localAssetWarnings: Array<{ code: string; message: string; path?: string }> = []
      for (const pkg of workspace.packages) {
        for (const asset of pkg.assets) {
          const parsed = parseLocaleAssetPath(asset.path)
          if (!parsed || parsed.kind !== 'text') continue
          const sourceName = sourceNameFromLangPath(asset.path)
          if (!sourceName) continue
          // 跨包同名时 findScriptByName 会抛：这里只是统计，不能让预检整体失败
          const sourceHit = (() => {
            try {
              return findScriptByName(workspace, sourceName)
            } catch {
              return null
            }
          })()
          if (!sourceHit) {
            orphanAssets.push({ path: asset.path, locale: parsed.locale })
            const message = `[${parsed.locale}] language asset has no source file: ${asset.path}`
            orphanWarnings.push(message)
            localAssetWarnings.push({
              code: 'orphan_asset',
              message,
              path: asset.path,
            })
            continue
          }
          const sourceKeys = collectSourceKeys(
            sourceHit.script.content,
            sourceHit.script.name,
          ).map((item) => item.key)
          const state = await readLangState(pkg.id, asset.path)
          const count = collectOrphanKeys(sourceKeys, state.map).length
          if (count === 0) continue
          orphanKeySummaries.push({
            locale: parsed.locale,
            source: sourceHit.script.name,
            count,
          })
          const message = `[${parsed.locale}] ${count} orphan translation key(s) in ${sourceHit.script.name}; delete_lang_keys can remove them`
          orphanWarnings.push(message)
          localAssetWarnings.push({
            code: 'orphan_keys',
            message,
            path: asset.path,
          })
        }
      }

      // P7：孤儿配音（来源文件已不存在 / 键已不在来源正文）
      const orphanVoiceList = orphanVoiceAssetsOf(workspace)
      const orphanVoice = {
        total: orphanVoiceList.length,
        sample: orphanVoiceList.slice(0, 20).map((item) => item.path),
        truncated: orphanVoiceList.length > 20,
      }

      // P6：顶层 warnings 只留 translations + assets（orphan）；导出编译器 warning 全部归组
      const topWarningsAll = [...translationsWarnings, ...orphanWarnings]
      const warnings = topWarningsAll.slice(0, warningLimit)
      const warningTotal = topWarningsAll.length

      const exportedAssets: Array<{ code: string; message: string; path?: string }> = []
      const exportedGameplay: Array<{ code: string; message: string; path?: string }> = []
      const rawGameplaySample: string[] = []
      const seenExport = new Set<string>()
      for (const raw of [...pak.warnings, ...project.warnings]) {
        const translated = translateExportWarning(raw)
        const key = `${translated.group}:${translated.message}`
        if (seenExport.has(key)) continue
        seenExport.add(key)
        if (translated.group === 'assets') {
          exportedAssets.push({ code: 'export_asset', message: translated.message })
        } else {
          if (rawGameplaySample.length < 10) rawGameplaySample.push(raw)
          exportedGameplay.push({
            code: translated.group === 'gameplay' ? 'export_gameplay' : 'export_other',
            message: translated.message,
          })
        }
      }
      const assetsAll = [...localAssetWarnings, ...exportedAssets]
      const truncateGroup = <T,>(items: T[]) => ({
        items: items.slice(0, warningLimit),
        total: items.length,
        truncated: items.length > warningLimit,
      })
      const translationsGroup = truncateGroup(translationsWarnings)
      const assetsGroup = truncateGroup(assetsAll)
      const gameplayGroup = truncateGroup(exportedGameplay)
      return {
        ok: true,
        warnings,
        warningTotal,
        truncated: warningTotal > warningLimit,
        missingTranslations: langReview.summaries,
        /** B11：预检基于工作区，包含未保存草稿 */
        includesDrafts: true,
        orphanAssets,
        orphanKeys: orphanKeySummaries,
        /** P7：孤儿配音（同时放在顶层与 groups 里，便于工具描述引用 groups.orphanVoice） */
        orphanVoice,
        groups: {
          translations: translationsGroup.items,
          assets: assetsGroup.items,
          gameplay: {
            items: gameplayGroup.items,
            sample: rawGameplaySample,
            total: gameplayGroup.total,
            truncated: gameplayGroup.truncated,
          },
          orphanVoice,
          totals: {
            translations: translationsGroup.total,
            assets: assetsGroup.total,
            gameplay: gameplayGroup.total,
          },
          truncated: {
            translations: translationsGroup.truncated,
            assets: assetsGroup.truncated,
            gameplay: gameplayGroup.truncated,
          },
        },
        // 只保留计数：pak/project.warnings 原串可能夹中文/游戏性噪声，工具 JSON 改走 groups
        pak: { files: pak.fileCount },
        project: { files: project.fileCount },
      }
    },
  }
  return agentHost
}
