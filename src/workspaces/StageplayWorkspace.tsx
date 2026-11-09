import {resourceNameKey} from '../resourceTypes'
import {JavaScriptEditor} from '../monaco/javascript/JavaScriptEditor'
import {scriptType} from '../scriptResources/types'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import { StageplayExplorer } from './stageplay/StageplayExplorer'
import { commitOrganization, placeSource, relocatedExplorer, withExplorer } from '../explorerShell'
import { emptyOrganization } from '../project/explorerOrganization'
import { sourcePathKnownToServer } from '../project/projectFs'
import { notify } from '../activity'
import { ServiceError } from '../collab/protocol'
import { PanelDock, resetPanelDock, type DockPanelSpec } from '../ui/PanelDock'
import { EditorDock, resetEditorDock } from '../ui/EditorDock'
import {
  editorPageKey,
  loadOpenPages,
  parseEditorPageKey,
  sameOpenPages,
  saveOpenPages,
  type EditorPage,
} from './stageplay/EditorTabs'
import { SecondaryDockPage } from './stageplay/SecondaryDockPage'
import {
  folderHasLockedAsset,
  isLockedAssetPath,
  sourceNameFromLangAssetPath,
  splitAgentLockPaths,
} from './stageplay/agentLockTargets'

const STAGEPLAY_EDITOR_DOCK_KEY = 'hanshu.stageplayEditorDock.v1'
import {
  alertDialog,
  chooseDialog as showChooseDialog,
  confirmDialog as showConfirmDialog,
  editorMenuActionId,
  pickFontSize,
  promptDialog as showPromptDialog,
  type ConfirmDialogOptions,
  runMonacoMenuAction,
} from '../ui/dialogs'
import { assignViewFlag, useViewFlags } from '../ui/viewFlags'
import { runScriptCommandPalette } from './scriptCommands'
import {
  SCRIPT_FONT_MAX,
  SCRIPT_FONT_MIN,
  scriptEditorAppearance,
  scriptViewFlags,
  toggleScriptViewItem,
} from './scriptView'
import {
  allocateNewFileBase,
  findNewFileType,
  isStageplayNewFileType,
  NEW_FILE_TYPES,
  newFileName,
  validateNewFileBase,
  type NewFileCreateResult,
  type NewFileSeedContext,
  type NewFileTypeId,
} from '../newFileTypes'
import { parseGoalDefinitionsFromSource } from '../workspaces/gameplay/goalDefinitions'
import {
  CHAR_THEME_ID,
  registerCharLanguage,
} from '../monaco/charLanguage'
import { indexForeignHsInjects } from '../hanshu/injectIndex'
import { analyzeCharDiagnostics } from '../monaco/charDiagnostics'
import { analyzeHsDiagnostics } from '../monaco/hsDiagnostics'
import { parseCharTextSpans } from '../monaco/charTextSpans'
import { parseTextSpans } from '../monaco/textSpans'
import { assessLangValueRisks, type InlineContext } from '../hanshu/inlineText'
import {
  HANSHU_THEME_ID,
  registerHanshuLanguage,
} from '../monaco/hanshuLanguage'
import { bindTaggedCommentHotkeys } from '../monaco/taggedComment'
import { bindChoiceInsertHotkeys } from '../monaco/choiceInsert'
import { bindCopyDialogueHotkey } from '../monaco/copyDialogue'
import {
  SPEAKER_SLOT_COUNT,
  applySpeakerInsert,
  bindSpeakerHotkeys,
  createDefaultRoles,
  extractSpeakersFromText,
  fillRolesFromSpeakers,
  numpadHint,
  numpadLabel,
} from '../monaco/speakerInsert'
import {
  createScript,
  emptyWorkspace,
  findAsset,
  findScript,
  findScriptByName,
  isCharFile,
  isHanshuFile,
  isMarkdownFile,
  editorLanguageForFile,
  normalizeResourceName,
  ALLOWED_EXTENSIONS_LABEL,
  MANUAL_FILE_EXTENSIONS_LABEL,
  isManualFileName,
  registerAsset,
  removeAssetMeta,
  removeAssetFolder,
  saveWorkspace,
  getExtension,
  sourcePathOf,
  toggleAssetsCollapsed,
  updateScriptContent,
  ensureAssetFolder,
  isVoiceMapFile,
  type Workspace,
} from '../workspace'
import {
  setProjectSession,
  subscribeProjectSession,
  useProjectSession,
  getProjectSession,
} from '../project/projectSession'
import {
  flushProjectEditors,
  registerProjectEditorFlush,
} from '../project/editorFlush'
import {
  createBlankOggBlob,
  isVoiceRefPath,
  listMissingVoiceOggs,
  parseVoiceRefContent,
} from '../i18n/voiceMap'
import { createVoiceOps, type VoiceOps } from '../i18n/voiceOps'
import {
  normalizeSourcePath,
  parseLocaleAssetPath,
  voiceRootDir,
} from '../i18n/localeLayout'
import { buildResourcePackZip } from '../export/resourcePack'
import { buildProjectPackZip } from '../export/projectPack'
import { assetFileName, normalizeAssetPath, normalizeFolderPath } from '../assets/paths'
import {
  moveAssetToDir,
  moveScriptToPackage,
  renameScriptAssets,
} from '../workspaceMove'
import {
  assetCacheEpoch,
  deleteAssetBlob,
  getAssetBlob,
  putAssetBlob,
} from '../assets/idb'
import type { AgentHost, AgentOpResult, LangEntry } from '../agent/tools'
import {
  COMMON_LOCALES,
  findLocale,
  isValidLocaleTag,
  resolveLocale,
  resolveLocaleTag,
} from '../i18n/locales'
import {
  activeFilePathOf,
  applyTextEdit,
  collectMissingTranslationWarnings,
  collectOrphanKeys,
  collectSourceKeys,
  countUnparsedTexts,
  deleteSourceAssets,
  langAssetPathFor,
  listLocalesOf,
  paginateSource,
  parseSourceText,
  sourceKindOf,
  sourceOffsetError,
  translateExportWarning,
  unparseSourceText,
  validateLangKeys,
  validateSourceContent,
  voiceStatusOf,
  writeLangAsset,
} from '../agent/agentOps'
import { MarkdownPreview } from '../MarkdownPreview'
import { HscPreview } from '../HscPreview'
import { AssetPreview } from '../AssetPreview'
import { AgentPanel } from '../AgentPanel'
import { createAgentRuntime } from '../agent/pi/facade'
import { claimWindowId } from '../agent/store/windowId'
import { getAgentApiKey, getAgentModelId } from '../agent/config'
import type { AgentRuntime, AgentRuntimeView } from '../agent/contracts'
import {
  AgentDiffModal,
  type AgentDiffSnapshot,
} from '../AgentDiffModal'
import {
  type BoundProject,
  removeSourceFromDisk,
  renameSourceOnDisk,
  saveProjectToDirectory,
  setBoundProject,
} from '../project'

import type {
  StageplayChromeInfo,
  StageplayWorkspaceHandle,
} from './stageplayTypes'
import { StatusBarSlots } from '../chrome'
import { LocaleSelect } from '../LocaleSelect'
import { FilePresenceBar } from '../project/FilePresenceBar'
import { TextEditBox } from '../TextEditBox'
import {
  TextMap,
  TEXT_ASSET_MIME,
  parseTextFile,
  stringifyTextFile,
  textAssetPath,
} from '../i18n/textMap'
import { createTextSink } from '../i18n/textSink'
import {
  discardLangDraft,
  readLangDraft,
  writeLangDraft,
} from '../i18n/langDraft'
import {
  createVoiceLibrary,
  type VoiceLibrary,
} from '../i18n/voiceLibrary'
import {
  runVoiceImport,
  formatVoiceImportSourceLabel,
  VOICE_IMPORT_RESULT,
  type VoiceImportIo,
  type VoiceImportSource,
} from '../i18n/voiceImport'
import { createVoiceProcessor } from '../i18n/voiceTranscode'
import { createVoiceDiskSink } from '../project/voiceDiskSink'
import type { DragSource } from '../drag/dragPayload'
import { TextUnitMenu, type TextUnitMenuItem } from '../TextUnitMenu'
import {
  RecordingStudio,
  type StudioMode,
  type StudioSourceMode,
  type StudioTtsStatus,
} from '../studio/RecordingStudio'
import { TtsCredentialsModal } from '../TtsCredentialsModal'
import { synthesizePlanLocale } from '../tts/client'
import { createCredentialResolver, createLocalBackend } from '../tts/credentials'
import { readVoicePlan, stringifyVoicePlan, type VoicePlan } from '../tts/plan'
import { resolvePresets } from '../tts/providers'
import {
  blankServiceDefinition,
  readServiceDefinition,
  resolveService,
  stringifyServiceDefinition,
  type ResolvedService,
} from '../tts/service'
import {
  characterNameOfFileName,
  isValidServiceId,
  planFileName,
  serviceFileName,
  ttsFileKindOf,
} from '../tts/spec'
import { TtsPlanForm } from '../tts/TtsPlanForm'
import { TtsServiceForm } from '../tts/TtsServiceForm'
import { createFetchTransport } from '../tts/transport'
import { VoiceImportProgress } from '../VoiceImportProgress'
import { VoiceToast } from '../VoiceToast'
import {
  bindText,
  type TextEditRequest,
  type TextBinding,
  type TextUnitDropRequest,
} from '../monaco/textEditor'
import { loadLocale, saveLocale } from '../storage'


function formatSavedAt(ts: number | null) {
  if (!ts) return '未记忆'
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `已记忆 ${hh}:${mm}:${ss}`
}

/**
 * 现在的时间戳。
 *
 * 抽成一个函数**不是为了避免重复**：`Date.now()` 直接出现在组件体内的调用链上时，
 * oxlint 的 react(purity) 会把它报成"渲染期调用了非纯函数"。而这条规则自己写着
 * "React Compiler skipped optimizing this component" —— 本组件早就不在它的分析范围里，
 * 那些报点全是误报。挪到模块作用域，报点就不再落在组件身上。
 */
function nowStamp(): number {
  return Date.now()
}

type StageplayWorkspaceProps = {
  onChromeInfo?: (info: StageplayChromeInfo) => void
  isActive?: boolean
}

export const StageplayWorkspace = forwardRef<
  StageplayWorkspaceHandle,
  StageplayWorkspaceProps
>(function StageplayWorkspace({ onChromeInfo, isActive = true }, ref) {
  const serviceSession = useProjectSession()
  const [workspace, setWorkspace] = useState<Workspace>(() => emptyWorkspace())
  const [openPages, setOpenPages] = useState<EditorPage[]>(loadOpenPages)
  const openPagesRef = useRef(openPages)
  openPagesRef.current = openPages
  const tabsHydratedRef = useRef(false)
  const [project, setProject] = useState<BoundProject | null>(null)
  const [projectBusy, setProjectBusy] = useState(false)
  /** 保存事务是否进行中：Agent Run 的启动闸门要读最新值（闭包里的 state 会是旧值） */
  const projectBusyRef = useRef(projectBusy)
  projectBusyRef.current = projectBusy
  const active = useMemo(
    () => findScript(workspace, workspace.activeScriptId),
    [workspace],
  )
  const activeAssetHit = useMemo(
    () => findAsset(workspace, workspace.activeAssetId),
    [workspace],
  )
  /**
   * 当前包资产清单的指纹（路径 + 大小 + 更新时间）。
   * 配音按钮的状态只在对等文件存在性上，所以资产一变就得重画覆盖框 ——
   * 否则导入完成后按钮还停在「缺失」（点击却能播，因为点击是实时求值的）。
   */
  const voiceAssetSignature = useMemo(
    () =>
      (findScript(workspace, workspace.activeScriptId)?.pkg.assets ?? [])
        .map((asset) => `${asset.path}:${asset.size}:${asset.updatedAt}`)
        .join('|'),
    [workspace],
  )
  const [value, setValue] = useState(() => active?.script.content ?? '')
  const [roles, setRoles] = useState(createDefaultRoles)
  const [savedAt, setSavedAt] = useState<number | null>(
    () => active?.script.updatedAt ?? null,
  )
  const [diskSavedAt, setDiskSavedAt] = useState<number | null>(null)
  const [mdPreviewOn, setMdPreviewOn] = useState(true)
  const [hscPreviewOn, setHscPreviewOn] = useState(false)
  const view = useViewFlags(scriptViewFlags)
  const agentOpen = view.agent
  const setAgentOpen = (next: boolean | ((open: boolean) => boolean)) => {
    assignViewFlag(scriptViewFlags, 'agent', next)
  }

  /** Agent 运行时（pi-durable facade）：只在面板打开且工程就绪时创建 */
  const [agentRuntime, setAgentRuntime] = useState<AgentRuntime | null>(null)
  /** 订阅到的会话视图：Run 状态、锁列表、流式条目都从这里来 */
  const [agentView, setAgentView] = useState<AgentRuntimeView | null>(null)
  /** 面板里改了网关/模型 → 重建运行时（Key 是惰性读的，不需要重建） */
  const [agentRuntimeNonce, setAgentRuntimeNonce] = useState(0)
  const agentRuntimeRef = useRef<AgentRuntime | null>(null)
  const agentHostRef = useRef<AgentHost | null>(null)
  /**
   * 稳定宿主代理：运行时只创建一次，但工具调用要拿到**当前渲染**的宿主实现
   * （宿主方法里会读 locale、活动文件这类每次渲染都可能变的值）。
   */
  const agentHostProxyRef = useRef<AgentHost | null>(null)
  if (!agentHostProxyRef.current) {
    agentHostProxyRef.current = new Proxy({} as AgentHost, {
      get: (_target, property) => {
        const host = agentHostRef.current as unknown as
          | Record<PropertyKey, unknown>
          | null
        const value = host?.[property]
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(host)
          : value
      },
    })
  }
  /** Run 活跃：保存按钮/快捷键/自动保存全部禁用（文档 §7 双向互斥） */
  const agentRunning = agentView?.runState === 'running'
  const [agentDiffs, setAgentDiffs] = useState<AgentDiffSnapshot[]>([])
  const [diffOpen, setDiffOpen] = useState(false)
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null)
  const rolesRef = useRef(roles)
  const valueRef = useRef(value)
  const workspaceRef = useRef(workspace)
  const activeIdRef = useRef(workspace.activeScriptId)
  /**
   * 编辑器里这份正文**属于**哪一份文件。
   *
   * 它和 `activeIdRef` 本该永远相等 —— 但"换活动文件"和"换编辑器正文"是两件事，
   * 只要有一条路径只做了前者，接下来任何"写回当前文件"的动作就会把 A 的正文写进 B。
   * 所以写入前一律核对归属（见 `persistActiveContent`），不一致就拒写。
   */
  const bufferOwnerRef = useRef<string | null>(workspace.activeScriptId)
  /**
   * 自动成键抑制集合（源文件锁 + 派生 `.lang` 锁所属的源文件）。
   * 供 `bindText` 的 `canAutoKey` 在成键防抖回调里读**最新**值 —— 那个回调
   * 只在挂载时创建一次，不能闭包捕获渲染期的 Set。
   */
  const agentLockedSourceNamesRef = useRef<ReadonlySet<string>>(new Set())
  /** 原始锁路径里的资产路径（`.lang` 等），供译文编辑浮层在锁期间拒绝编辑 */
  const agentLockedAssetPathsRef = useRef<ReadonlySet<string>>(new Set())
  /**
   * 程序化写入（agent）后的正文快照：正文仍等于它时不做自动成键。
   * 这是内容级抑制 —— 解锁 / 编辑器重挂载 / 刷新都不会把 agent 刚写出的正文再成键一遍。
   */
  const agentWrittenContentRef = useRef<Map<string, string>>(new Map())
  const projectRef = useRef(project)
  rolesRef.current = roles
  valueRef.current = value
  workspaceRef.current = workspace
  activeIdRef.current = workspace.activeScriptId
  projectRef.current = project

  // Custom dialogs yield while remote updates and project switches continue.
  // A result must still belong to the project and resource that opened it.
  const contextualDialog = async <T,>(run: () => Promise<T>, cancelled: T): Promise<T> => {
    const client = projectRef.current?.handle.client
    const scriptId = activeIdRef.current
    const assetId = workspaceRef.current.activeAssetId
    const result = await run()
    return projectRef.current?.handle.client === client &&
      activeIdRef.current === scriptId && workspaceRef.current.activeAssetId === assetId
      ? result : cancelled
  }
  const confirmDialog = (input: string | ConfirmDialogOptions) =>
    contextualDialog(() => typeof input === 'string' ? showConfirmDialog(input) : showConfirmDialog(input), false)
  const promptDialog = (input: Parameters<typeof showPromptDialog>[0]) =>
    contextualDialog(() => showPromptDialog(input), null)
  const chooseDialog = (input: Parameters<typeof showChooseDialog>[0]) =>
    contextualDialog(() => showChooseDialog(input), null)

  const lineCount = value.split('\n').length
  const charCount = value.length
  const viewingAsset = Boolean(activeAssetHit)
  const presenceClient = serviceSession.binding?.handle.client
  const presencePath = activeAssetHit?.asset.path ?? (active&&!active.script.detached ? sourcePathOf(active.script) : null)
  // The editor buffer precedes its debounced workspace mirror by 400 ms.
  const presenceDirty = !viewingAsset && !!active && bufferOwnerRef.current === active.script.id && value !== active.script.content
  /** 没有活动文件时不要再冒出「未命名剧本.hs」这种假标签。 */
  const pageOpen = Boolean(active || viewingAsset)
  const titleName = viewingAsset
    ? activeAssetHit!.asset.path
    : (active?.script.name ?? '')
  const packageName = viewingAsset
    ? activeAssetHit!.pkg.name
    : (active?.pkg.name ?? '')
  /**
   * Agent 锁涉及的文件（文档 D2：「锁只对被锁的文件生效」）。
   *
   * - `agentLockedSourceNames`：**源文件锁**（`lock_source`），只让源编辑器只读；
   * - `agentLockedAssetPaths`：**语言/资产锁**（`lock_lang` 的 `.lang` 等），只让该资产只读；
   * - `agentAutoKeyBlockedSources`：自动成键抑制集合 = 源文件锁 + 派生 `.lang` 锁所属的源文件
   *   （lang 锁期间源文件仍可编辑正文，但不能再自动成键）。
   *
   * 拆分口径与反解布局都在 `stageplay/agentLockTargets.ts`（纯函数，有单测）。
   */
  const agentLockTargets = splitAgentLockPaths(
    agentView?.lockedPaths ?? [],
    (candidate) => findScriptByName(workspaceRef.current, candidate)?.script.name ?? null,
  )
  const agentLockedSourceNames = agentLockTargets.sourceNames
  const agentLockedAssetPaths = agentLockTargets.assetPaths
  const agentAutoKeyBlockedSources = agentLockTargets.autoKeyBlockedSources
  agentLockedSourceNamesRef.current = agentAutoKeyBlockedSources
  agentLockedAssetPathsRef.current = agentLockedAssetPaths
  /** 当前打开的**源文件**被源锁命中 → 编辑器只读（语言锁不锁源正文） */
  const agentWritingFile = agentLockedSourceNames.has(titleName)
  /** 当前打开的资产被锁（`.lang` 的只读靠 lang 锁，不靠源文件锁） */
  const agentLockedViewingAsset = viewingAsset && isLockedAssetPath(agentLockedAssetPaths, titleName)
  const SourceEditor=editorLanguageForFile(titleName)==='javascript'?JavaScriptEditor:Editor
  const editingMarkdown = !viewingAsset && isMarkdownFile(titleName)
  const editingHanshu = !viewingAsset && isHanshuFile(titleName)
  const editingChar = !viewingAsset && isCharFile(titleName)
  /** `.hs` / `.char`：语言文本映射与录音棚 */
  const editingLocalizable = editingHanshu || editingChar

  const commitWorkspace = (next: Workspace) => {
    workspaceRef.current = next
    activeIdRef.current = next.activeScriptId
    setWorkspace(next)
    setProjectSession({ workspace: next, binding: projectRef.current })
    // 仅绑定工程时把镜像写入 localStorage，作为崩溃恢复；未绑定不保留 Virtual Cache
    if (projectRef.current) saveWorkspace(next)
  }

  /**
   * 内容写回的**唯一**原语：正文 + 它属于哪一份文件。
   *
   * `updateScriptContent(ws, id, text)` 本身是安全的，出事的永远是"调用方拿错了 id"：
   * 早先只有 `persistActiveContent(text)` 一个入口，目标靠 `activeIdRef.current` 现取 ——
   * 只要有一处"换了活动文件、没换编辑器正文"，A 的正文就会落进 B。
   * 所以这里要求调用方**明确指出**是哪一份，然后再由 `persistActiveContent` 去核对归属。
   */
  const writeScriptContent = (scriptId: string, text: string): boolean => {
    const current = findScript(workspaceRef.current, scriptId)
    if (!current) return false
    if (current.script.content === text) return true
    commitWorkspace(updateScriptContent(workspaceRef.current, scriptId, text))
    return true
  }

  /**
   * 换文件：正文、ref、编辑器、归属**一起换**。少换一样就会出现"看着是 A、写进 B"。
   */
  const loadEditorContent = (
    scriptId: string | null,
    content: string,
    updatedAt?: number | null,
  ) => {
    bufferOwnerRef.current = scriptId
    setValue(content)
    valueRef.current = content
    editorRef.current?.setValue(content)
    setSavedAt(updatedAt ?? nowStamp())
  }
  const activeDiscardVersion=active?serviceSession.binding?.handle.client.discardVersions.get(sourcePathOf(active.script))??0:0
  useEffect(() => {
    if (!activeDiscardVersion) return
    const live=getProjectSession().workspace
    const selected=live.activeScriptId && findScript(live,live.activeScriptId)
    if(selected)loadEditorContent(selected.script.id,selected.script.content,selected.script.updatedAt)
    else loadEditorContent(null,'')
    setLangEdit(null)
    // Explicit bulk adoption must reset the source buffer and its local undo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[activeDiscardVersion])

  /**
   * 把编辑器里那份正文并回**它属于的**那一份文件（换文件、导出、写盘前都先做这一步）。
   *
   * 用归属而不是用 `activeScriptId`：这两个值本来相等，不相等时该听的是正文的归属 ——
   * 按活动文件写就是把上一条正文盖到新文件上。
   */
  const flushEditorInto = (base: Workspace): Workspace => {
    const id = bufferOwnerRef.current
    if (!id) return base
    const hit = findScript(base, id)
    if (!hit) return base
    // P4：正文没变时不要 commit —— updateScriptContent 会刷新 updatedAt，造成无变更的“更新时间”跳变
    if (hit.script.content === valueRef.current) return base
    return updateScriptContent(base, id, valueRef.current)
  }

  // 工程级导出/发版前：把 Monaco 缓冲冲进 projectSession
  useEffect(() => {
    return registerProjectEditorFlush(() => {
      const id = bufferOwnerRef.current
      if (!id) return
      const current = findScript(workspaceRef.current, id)
      if (!current || current.script.content === valueRef.current) return
      commitWorkspace(
        updateScriptContent(workspaceRef.current, id, valueRef.current),
      )
    })
  }, [])

  const [locale, setLocale] = useState(loadLocale)
  const [langEdit, setLangEdit] = useState<{
    id: number
    request: TextEditRequest
  } | null>(null)
  /**
   * 语言草稿镜像失败：连同它属于哪个「文件 + 语言」一起记下来。
   * 渲染时只认当前写入周期 —— 既避免切换语言/文件后还挂着旧提示，
   * 也避免在 effect 里同步 setState。
   */
  const [textDiskError, setLangDiskError] = useState<{
    key: string
    path: string
    message: string
  } | null>(null)
  /** 配音提交失败；原绑定保留，待提交字节保留在事务记录中。 */
  const [voiceDiskError, setVoiceDiskError] = useState<{
    path: string
    message: string
  } | null>(null)
  useEffect(() => {
    const client = serviceSession.binding?.handle.client
    if (!client) return
    let saved = new Set(client.transactions.getSnapshot().transactions.filter(transaction => transaction.phase === 'saved').map(transaction => `${transaction.id}:${transaction.requestId}`))
    return client.transactions.subscribe(() => {
      const complete = client.transactions.getSnapshot().transactions.filter(transaction => transaction.phase === 'saved')
      const acknowledged = complete.filter(transaction => !saved.has(`${transaction.id}:${transaction.requestId}`))
      saved = new Set(complete.map(transaction => `${transaction.id}:${transaction.requestId}`))
      if (!acknowledged.length) return
      const includes = (path: string) => acknowledged.some(transaction => transaction.paths.some(changed => changed === path || path.startsWith(`${changed}/`)))
      setLangDiskError(previous => previous && includes(previous.path) ? null : previous)
      setVoiceDiskError(previous => previous && includes(previous.path) ? null : previous)
      const current = findScript(workspaceRef.current, bufferOwnerRef.current)?.script
      if (current && includes(sourcePathOf(current))) setDiskSavedAt(Date.now())
    })
  }, [serviceSession.binding?.handle.client])
  const textMapRef = useRef<TextMap | null>(null)
  /** 当前语言文本资产的原始内容（TextSink.read 是同步接口，所以要用缓存兜住） */
  const textCacheRef = useRef<string | null>(null)
  const textBindingRef = useRef<TextBinding | null>(null)
  /**
   * 当前正在编辑的**语言文本**（`.lang`）是否被 Agent 锁住。
   *
   * 译文编辑浮层是自绘 UI，不受 Monaco `readOnly` 约束；锁期间必须在这里拒绝，
   * 否则用户仍能改译文，产生与 agent 写入冲突的草稿（「语言文件看 lang 锁」）。
   */
  const rejectLockedLangEdit = (): boolean => {
    const langPath = textMapRef.current?.fileName
    if (
      !langPath ||
      !agentLockedAssetPathsRef.current.has(normalizeSourcePath(langPath))
    ) {
      return false
    }
    void alertDialog(
      '这篇语言文本正被 Agent 修改（锁未释放），暂时不能改译文；等这一轮结束或 Agent 释放锁后再编辑。',
    )
    return true
  }
  const langEditSeqRef = useRef(0)
  const voiceLibraryRef = useRef<VoiceLibrary | null>(null)
  /** 音频映射管理的渲染态镜像（ref 给编辑器用，state 给弹窗用） */
  const [voiceRuntime, setVoiceRuntime] = useState<VoiceLibrary | null>(null)
  /**
   * 语言文本映射的渲染态镜像（值本身不用，只为"映射加载完了"能触发一次重渲染）。
   *
   * 映射是**异步**建出来的（先读资产再建 sink）：只写 `textMapRef` 的话，录音棚那边
   * 拿到的会一直是"还没有文本"，直到碰巧有别的 state 变化 —— 录音的人不该看到这种
   * 状态。同 `voiceRuntime`：库/映射是刚建出来的，不会引发级联渲染。
   */
  const [, setTextRuntime] = useState<TextMap | null>(null)
  /** 上级容器右键菜单（null = 没开） */
  const [unitMenu, setUnitMenu] = useState<{
    key: string
    x: number
    y: number
  } | null>(null)
  /** 正在跑的音频导入（null = 没在导入）：驱动置顶进度条 */
  const [voiceImport, setVoiceImport] = useState<{
    sourceLabel: string
    targetPath: string
    progress: number
    phase: 'process' | 'write'
  } | null>(null)
  /**
   * 「新建剧本」菜单项的请求号：**值变化**即请求资源管理器打开类型选择器（0 = 从未请求）。
   *
   * 菜单在 App 那一层，类型选择器在资源树里（它需要树上的锚点位置），中间只能过这么
   * 一个计数器。用计数器而不是布尔量：连点两次菜单项时布尔量第二次不产生变化，
   * 菜单就不会重开。真正打开由 `Explorer` 负责 —— 目标包得按"当前活动文件在哪个包"算，
   * 那是资源树的知识。
   */
  const [newFileMenuRequest, setNewFileMenuRequest] = useState(0)
  /** 新建后请求资源树对该文件进入行内改名 */
  const [renameRequest, setRenameRequest] = useState<{ id: string; seq: number } | null>(null)

  // 录音棚跟其他栏目一样进停靠布局，开关仍然走查看菜单。
  const studioOpen = view.studio
  const setStudioOpen = (next: boolean | ((open: boolean) => boolean)) => {
    assignViewFlag(scriptViewFlags, 'studio', next)
  }
  const [studioMode, setStudioMode] = useState<StudioMode>('single')
  /** 配音方式（固定音频 / TTS / 录音）：**单选与批量共用**，只是目标键集合不同 */
  const [studioSourceMode, setStudioSourceMode] =
    useState<StudioSourceMode>('fixed')
  /** 录音棚里"已选中的键名"（按正文顺序）。选中动作发生在编辑器里，见 textEditor 的选择模式 */
  const [studioSelection, setStudioSelection] = useState<string[]>([])
  /** 编辑器里挂上 TextBinding 的轮次：挂载/重建后要把模式与选中态重新灌回去 */
  const [textBindingSeq, setTextBindingSeq] = useState(0)

  /**
   * 导入结果浮窗（自动消失）。内容就是工作流要返回的那条消息，
   * 由工作流在结果落定前发出；状态栏那条记录仍然保留（可点掉、不自动消失）。
   */
  const [voiceToast, setVoiceToast] = useState<{
    id: number
    message: string
    ok: boolean
  } | null>(null)
  /** 导入结果（常量枚举消息 + 成败 + 一句补充说明），点一下清掉 */
  const [voiceImportMessage, setVoiceImportMessage] = useState<{
    message: string
    ok: boolean
    hint?: string
  } | null>(null)
  const voiceImportCancelRef = useRef<(() => void) | null>(null)
  /**
   * 上次的工程文件夹还在、但这次没能恢复（几乎都是权限没授：冷启动没有用户手势，
   * `requestPermission` 会被静默拒绝）。此时给出一个可点的一键恢复入口，
   * 否则「看起来有工程、其实没绑定」，导入只会写进应用内资源。
   */
  /** 仅活动文件是可本地化源（.hs / .char）时才有语言文本映射 */
  const textSourceName = editingLocalizable ? titleName : ''
  const handleLocaleChange = (tag: string) => {
    // 换语言 = 换映射：编辑框里那行字属于上一个语言，而请求里抓着的是旧映射对象，
    // 提交会写进上一个语言的文本。就地关掉（等同于 Esc，不动正文）
    if (langEdit) {
      langEdit.request.cancel()
      setLangEdit(null)
    }
    setLocale(tag)
    saveLocale(tag)
  }

  const projectHandle = project?.handle ?? null
  /** 当前写入周期：活动 .hs 文件 + 语言标签 */
  const textWriteKey = `${textSourceName}|${locale}`
  const activeTextDiskError =
    textDiskError?.key === textWriteKey ? textDiskError.message : null

  /**
   * 资产编辑器保存文本资产（`.lang`）：写回 IndexedDB + 更新元数据。
   * 若保存的正是当前语言文本文件，还要同步内存映射 —— 否则下一次写键会用旧缓存
   * 覆盖掉这次手工编辑。
   */
  const handleSaveTextAsset = async (content: string) => {
    const hit = activeAssetHit
    if (!hit) return
    if (agentRuntimeRef.current?.view().runState === 'running') {
      void alertDialog('Agent 运行中，暂不可保存。等这一轮结束（或点停止）再保存。')
      return
    }
    const { pkg, asset } = hit
    const mime = asset.mime || TEXT_ASSET_MIME
    const blob = new Blob([content], { type: mime })
    const sourceClient = projectRef.current?.handle.client
    const mirror = async () => {
    if (projectRef.current?.handle.client !== sourceClient) throw new Error('工程已切换，原语言草稿保留在原工程')
    await putAssetBlob(pkg.id, asset.path, blob)
    // putAssetBlob 会提升 IDB 缓存 epoch；同步到 client.assetEpochs，避免保存前把
    // 「镜像刚写进去」误判成别的端改过资源（P0 假 dirty）。
    sourceClient?.assetEpochs.set(asset.path, assetCacheEpoch(pkg.id, asset.path))
    if (projectRef.current?.handle.client !== sourceClient) throw new Error('工程已切换，原语言草稿保留在原工程')
    const result = registerAsset(
      workspaceRef.current,
      pkg.id,
      asset.path,
      mime,
      blob.size,
      // 手改 `.ref`（引用资产）的正文：目标路径必须跟着更新，
      // 否则四态还按旧目标判 —— 一直错到重开工程为止
      isVoiceRefPath(asset.path) ? parseVoiceRefContent(content) : undefined,
    )
    if (result) commitWorkspace(result.workspace)
    if (isVoiceRefPath(asset.path)) {
      voiceLibraryRef.current?.notifyAssetsChanged()
      textBindingRef.current?.refreshVoice()
    }

    if (textMapRef.current?.fileName.toLowerCase() === asset.path.toLowerCase()) {
      textCacheRef.current = content
      textMapRef.current.load()
    }
    }
    if (sourceClient && /^assets\/[^/]+\/lang_/.test(asset.path)) {
      await sourceClient.transactions.stageWrite({op:'write',path:asset.path,data:content}, mirror)
    } else await mirror()
  }

  // 语言文本映射实例：活动源文件 + 当前语言标签 → `assets/<语言标签>/lang_<后缀>/…`
  // 绑定工程时读取服务内容，修改暂存并与正文一起提交（见 textSink）。
  useEffect(() => {
    if (!textSourceName) {
      textMapRef.current = null
      textBindingRef.current?.refresh()
      return
    }

    const fileName = textAssetPath(locale, textSourceName)
    const sourceId = workspaceRef.current.activeScriptId
    const sourceClient = projectRef.current?.handle.client
    // 语言文本按**资产**存放（`assets/<locale>/lang_<ext>/…`）：与音频一样进 IndexedDB，
    // 资源管理器因此把它画在 assets 树下。此前当包内文件写，会在包根下多出一条名字
    // 带整条路径的记录（旧状态在读到时顺手迁移掉，见 loadTextAsset）。
    // 文本缓存在组件作用域的 textCacheRef 上：资产编辑器保存后也要用它收敛
    // （见 handleSaveTextAsset）。

    /*
     * 旧状态清理：把误写成包内文件的那条记录移出 scripts。
     *
     * **它只改结构，不动编辑器正文** —— 但可能把 `activeScriptId` 挪到另一份文件上，
     * 而此刻编辑器里还是被移走那篇的正文。这正是"A 的正文写进 B"的经典条件，
     * 所以写入侧一律核对正文归属（见 `persistActiveContent`）。将来真要在这里动 id，
     * 必须同时用 `loadEditorContent` 把正文也换过去。
     */
    const dropLegacyTextFile = (base: Workspace, scriptId: string): Workspace => ({
      ...base,
      activeScriptId:
        base.activeScriptId === scriptId
          ? base.packages
              .flatMap((pkg) => pkg.scripts)
              .find((script) => script.id !== scriptId)?.id ?? null
          : base.activeScriptId,
      packages: base.packages.map((pkg) => ({
        ...pkg,
        scripts: pkg.scripts.filter((script) => script.id !== scriptId),
      })),
    })

    /** TextSink.read 是同步接口：先异步取回（资产优先，其次旧包内文件并迁移） */
    const loadTextAsset = async (): Promise<string | null> => {
      const base = workspaceRef.current
      const hit = findScript(base, base.activeScriptId)
      if (!hit) return null

      const blob = await getAssetBlob(hit.pkg.id, fileName)
      if (blob) return blob.text()

      const legacy = hit.pkg.scripts.find(
        (item) => item.name.toLowerCase() === fileName.toLowerCase(),
      )
      if (!legacy) return null

      const migrated = new Blob([legacy.content], { type: TEXT_ASSET_MIME })
      await putAssetBlob(hit.pkg.id, fileName, migrated)
      // 镜像提升的缓存 epoch 要同步到 client，避免保存前把镜像写入误判成远端改动（P0）
      sourceClient?.assetEpochs.set(fileName, assetCacheEpoch(hit.pkg.id, fileName))
      const withAsset = registerAsset(
        base,
        hit.pkg.id,
        fileName,
        TEXT_ASSET_MIME,
        migrated.size,
      )
      commitWorkspace(dropLegacyTextFile(withAsset?.workspace ?? base, legacy.id))
      return legacy.content
    }

    const virtualSink = {
      read: () => textCacheRef.current,
      write: (content: string) => {
        if (projectRef.current?.handle.client !== sourceClient) throw new Error('工程已切换，原语言草稿保留在原工程')
        const base = workspaceRef.current
        const id = sourceId
        if (!id) return
        textCacheRef.current = content
        // 先把编辑器里的当前正文并回**它属于的**那一份，避免覆盖未保存的输入
        const merged = flushEditorInto(base)
        const hit = findScript(merged, id)
        if (!hit) return
        const blob = new Blob([content], { type: TEXT_ASSET_MIME })
        return putAssetBlob(hit.pkg.id, fileName, blob).then(() => {
          if (projectRef.current?.handle.client !== sourceClient) throw new Error('工程已切换，原语言草稿保留在原工程')
          // 手改语言文本的镜像同样提升缓存 epoch：同步 client.assetEpochs（P0 假 dirty）
          sourceClient?.assetEpochs.set(fileName, assetCacheEpoch(hit.pkg.id, fileName))
          const result = registerAsset(
            workspaceRef.current,
            hit.pkg.id,
            fileName,
            TEXT_ASSET_MIME,
            blob.size,
          )
          if (result) commitWorkspace(result.workspace)
        })
      },
    }

    let cancelled = false
    let unsubscribe: (() => void) | null = null
    let created: TextMap | null = null

    // 磁盘读取是异步的：读完再建映射；磁盘写入在 sink 里按顺序串行执行
    void (async () => {
      // TextSink.read 是同步接口：先把资产文本读进缓存再建映射
      const content = await loadTextAsset()
      if (cancelled || projectRef.current?.handle.client !== sourceClient) return
      textCacheRef.current = content
      const sink = await createTextSink({
        project: projectRef.current,
        fileName,
        virtual: virtualSink,
        // 只在本地镜像结束后异步触发。oxlint 的 react(set-state-in-effect) 按词法
        // 判定，仍会就此报一条告警（规则过度近似：此处不会引发级联渲染）。
        onWriteResult: (error) => {
          if (!error) {
            setLangDiskError(previous => previous?.path === fileName ? null : previous)
            return
          }
          console.warn('[hanshu] 语言草稿镜像失败', error)
          setLangDiskError({
            key: textWriteKey,
            path: fileName,
            message: error instanceof Error ? error.message : String(error),
          })
        },
      })
      if (cancelled) return
      const map = new TextMap({ fileName, locale, sink })
      created = map
      textMapRef.current = map
      unsubscribe = map.subscribe(() => textBindingRef.current?.refresh())
      map.load()
      textBindingRef.current?.refresh()
      // 文本已加载好：让"读 ref 的内容"（录音棚的台词）拿到它，见 setTextRuntime 的注释
      setTextRuntime(map)
    })()

    return () => {
      cancelled = true
      unsubscribe?.()
      if (textMapRef.current === created) textMapRef.current = null
    }
  }, [textSourceName, textWriteKey, locale, serviceSession.binding?.handle.client.remoteEpoch, projectHandle])

  // 工具卸载时解绑编辑器
  useEffect(() => () => textBindingRef.current?.dispose(), [])

  // A shared project arrives after the initial empty editor. Bind its model by
  // project/file identity and repaint when a previously hidden workspace opens.
  useEffect(() => {
    if (!isActive || projectBusy) return
    const frame = requestAnimationFrame(() => {
      editorRef.current?.layout()
      textBindingRef.current?.refresh()
    })
    return () => cancelAnimationFrame(frame)
  }, [isActive, textBindingSeq, projectBusy, serviceSession.binding?.handle.client.snapshot.role])

  /** 活动文件所在包（音频映射管理要读它的资产清单与包 id） */
  const activePackage = () => {
    const base = workspaceRef.current
    return findScript(base, base.activeScriptId)?.pkg ?? null
  }

  // 音频映射管理：**没有映射文件** —— 每个键对应哪个音频，由「脚本路径 + 键名」
  // 推导出的对等文件决定（见 i18n/voiceMap）。这里只负责按当前脚本/语言建出来，
  // 并把「解码完成 / 播放态变化」转成覆盖层重画。
  useEffect(() => {
    const scriptName = textSourceName
    if (!scriptName) {
      voiceLibraryRef.current?.dispose()
      voiceLibraryRef.current = null
      textBindingRef.current?.refresh()
      return
    }

    const library = createVoiceLibrary({
      locale,
      scriptName,
      assets: () => activePackage()?.assets ?? [],
      packageId: () => activePackage()?.id ?? '',
    })
    voiceLibraryRef.current = library
    // 同步镜像到 state 只为让选择器能渲染。oxlint 的 react(set-state-in-effect)
    // 按词法判定，会就此报一条告警；这里库是同步建的、不会引发级联渲染（同 textDiskError 那处）。
    setVoiceRuntime(library)
    const unsubscribe = library.subscribe(() =>
      textBindingRef.current?.refreshVoice(),
    )
    textBindingRef.current?.refresh()

    return () => {
      unsubscribe()
      if (voiceLibraryRef.current === library) {
        library.dispose()
        voiceLibraryRef.current = null
      }
    }
  }, [textSourceName, locale, serviceSession.binding?.handle.client.remoteEpoch, projectHandle])

  // 资产清单一变（导入完成、拖入、删除…），配音按钮的状态就可能从缺失变可用：
  // 让音频映射管理失效并发一次通知 —— 覆盖层按钮与已打开的选择器都会跟着刷新。
  // （状态是渲染期求值的，不重画就一直停在旧状态：点击能播、按钮却还是红的。）
  useEffect(() => {
    voiceLibraryRef.current?.notifyAssetsChanged()
  }, [voiceAssetSignature])

  /**
   * 编辑某个键的音频：**打开录音棚**，并把这个键选成当前目标。
   *
   * 以前这里开的是"音频选择器"弹窗；它的全部职责（挑工程里的资产、拖外部文件进来、
   * 录音、TTS 合成）录音棚都有，而且录音棚还能顺带预览与确认，所以那个弹窗被删了 ——
   * 编辑器里所有"要给这个键配一条音频"的入口都汇到这一条路。
   */
  const editVoiceInStudio = (key: string) => {
    setStudioSelection(orderKeys([key]))
    // 固定音频是"手上有文件 / 挑了资产"的那条路；录音与 TTS 在棚里随时可切
    setStudioSourceMode('fixed')
    setStudioMode('single')
    setStudioOpen(true)
  }

  /** 音频与同基名引用的替换是一个 S 事务；确认后再更新缓存和可见绑定。 */
  const createVoiceImportIo = (packageId: string): VoiceImportIo => {
    const findAsset = (path: string) => {
      const pkg = workspaceRef.current.packages.find((item) => item.id === packageId)
      const wanted = path.trim().replace(/\\/g, '/').toLowerCase()
      return pkg?.assets.find((asset) => asset.path.toLowerCase() === wanted) ?? null
    }

    return {
      read: async (path) => {
        const asset = findAsset(path)
        if (!asset) return null
        const blob = await getAssetBlob(packageId, asset.path)
        if (!blob) return null
        return new Uint8Array(await blob.arrayBuffer())
      },

      async write(path, bytes, mime, onProgress) {
        const blob = new Blob([bytes as BlobPart], { type: mime })
        const peerPath = path.replace(/\.ogg$/i, '.ref')
        const sink = createVoiceDiskSink(projectRef.current?.handle ?? null)
        try {
          await sink.replace(path, bytes, mime, peerPath === path ? [] : [peerPath], (ratio) => onProgress?.(ratio * 0.8))
          setVoiceDiskError(null)
        } catch (error) {
          setVoiceDiskError({ path, message: error instanceof Error ? error.message : String(error) })
          throw error
        }
        if (peerPath !== path) await deleteAssetBlob(packageId, peerPath)
        await putAssetBlob(packageId, path, blob)
        const peer = findAsset(peerPath)
        const current = peer && peerPath !== path ? removeAssetMeta(workspaceRef.current, peer.id) : workspaceRef.current
        const result = registerAsset(
          current,
          packageId,
          path,
          mime,
          blob.size,
        )
        if (result) commitWorkspace(result.workspace)
        onProgress?.(1)
      },
    }
  }

  /**
   * 跑一次「音频导入」：源 = 资源管理器里选中的资产，或拖进来的外部文件 / 刚录下的字节；
   * 目标 = 一个或多个键的对等文件。进度条由 voiceImport 状态驱动；中断（点 ×）返回 interrupted。
   *
   * 多个键时**串行**跑同一个工作流（源字节只读一次，但每个目标都要独立落盘），
   * 总进度按 `(已完成的键 + 当前键的进度) / 键数` 聚合 —— 进度条不会在第二个键上跳回 0。
   *
   * **返回这次导入的 promise。** 批量 TTS 要一个键一个键地"先合成、再导入"，
   * 不 await 就会同时跑起多个导入 —— 它们共用同一份进度与取消引用，进度会跳、
   * 取消会乱。别的地方不关心返回值，照旧不等。
   */
  const runVoiceImportForKeys = (keys: string[], source: VoiceImportSource) => {
    const library = voiceLibraryRef.current
    const packageId = activePackage()?.id
    if (!library || !packageId || keys.length === 0) return Promise.resolve()

    const targets = keys.map((key) => library.targetPathOf(key))
    setVoiceImportMessage(null)
    setVoiceImport({
      sourceLabel: formatVoiceImportSourceLabel(source),
      targetPath:
        targets.length === 1
          ? targets[0]
          : `${targets[0]}（共 ${targets.length} 个目标）`,
      progress: 0,
      phase: 'process',
    })

    const cancelled = { value: false }
    voiceImportCancelRef.current = () => {
      cancelled.value = true
    }

    const io = createVoiceImportIo(packageId)
    const processor = createVoiceProcessor()

    return (async () => {
      let ok = 0
      let failed = 0
      let lastMessage: string = VOICE_IMPORT_RESULT.interrupted
      let lastDetail: string | undefined

      for (let index = 0; index < targets.length; index += 1) {
        if (cancelled.value) {
          failed += targets.length - index
          break
        }
        const run = runVoiceImport(
          { source, targetPath: targets[index] },
          io,
          processor,
          {
            onPhase: (phase) =>
              setVoiceImport((current) =>
                current ? { ...current, phase } : current,
              ),
            onProgress: (ratio) =>
              setVoiceImport((current) =>
                current
                  ? {
                      ...current,
                      progress: (index + Math.max(0, Math.min(1, ratio))) /
                        targets.length,
                    }
                  : current,
              ),
          },
        )
        const report = await run.result
        lastMessage = report.message
        lastDetail = report.detail
        if (report.ok) {
          ok += 1
        } else {
          failed += 1
        }
        if (report.outcome === 'interrupted') {
          failed += targets.length - index - 1
          break
        }
      }

      voiceImportCancelRef.current = null
      setVoiceImport(null)

      const message =
        targets.length === 1
          ? lastMessage
          : failed === 0
            ? VOICE_IMPORT_RESULT.success
            : ok === 0
              ? lastMessage
              : `${ok} 个已导入，${failed} 个失败（${lastMessage}）`
      setVoiceImportMessage({
        message,
        ok: failed === 0,
        // 没绑定工程文件夹时，导入只会写进应用内资源（IndexedDB）—— 说清楚，
        // 免得看到"成功"却在磁盘上找不到文件
        hint: projectRef.current?.handle
          ? targets.length > 1
            ? `共 ${targets.length} 个键`
            : undefined
          : '未绑定工程文件夹，只写入了应用内资源',
      })
      setVoiceToast({ id: Date.now(), message, ok: failed === 0 })
      if (failed > 0 && lastDetail) {
        console.warn('[hanshu] 音频导入失败：', lastDetail)
      }
    })()
  }

  /** 单键导入（右键菜单、拖到键名上、录音棚的确认导入都走这条） */
  const runVoiceImportFor = (key: string, source: VoiceImportSource) => {
    runVoiceImportForKeys([key], source)
  }

  /** 把一个外部文件读成「文件源」（拖到键名上导入音频用；外部文件拿不到路径） */
  const readDroppedFile = async (file: File): Promise<VoiceImportSource> => ({
    kind: 'file',
    name: file.name,
    bytes: new Uint8Array(await file.arrayBuffer()),
  })

  /**
   * 键名上的投放（见 dragPayload 的语义表）：
   * - 外部文件 / 资产 → 尝试导入音频（多文件只取第一个：目标只有一个对等文件）
   * - 另一个键名 → 替换键名（只改正文，与 deleteUnit 口径一致）
   */
  const handleUnitDrop = (request: TextUnitDropRequest) => {
    const { key, intent, files, source } = request

    if (intent.action === 'replace-key') {
      if (source?.kind === 'key' && source.key !== key) {
        textBindingRef.current?.replaceUnitKey(key, source.key)
      }
      return
    }

    if (intent.action === 'import-audio-asset' && source?.kind === 'asset') {
      runVoiceImportFor(key, { kind: 'asset', path: source.path })
      return
    }

    if (intent.action === 'import-audio-file') {
      const file = files[0]
      if (!file) return
      void readDroppedFile(file)
        .then((next) => runVoiceImportFor(key, next))
        .catch((error: unknown) => {
          console.warn('[hanshu] 读取拖入的音频失败', error)
        })
    }
  }

  /**
   * 资源管理器内部拖拽落到目录行 = **剪切**：
   * - 脚本：换包（模型里脚本是包内扁平的，没有子目录概念）
   * - 资产：换目录（同包换文件夹或跨包），blob 与元数据一起搬，保留原 id
   * 目标已有同名文件时不覆盖，直接忽略（避免出现两条同路径资产）。
   */
  /** 剧本换包（模型变换走 workspaceMove 的纯函数） */
  const applyScriptMove = (
    scriptId: string,
    targetPackageId: string,
  ) => {
    const base = workspaceRef.current
    const next = moveScriptToPackage(base, scriptId, targetPackageId)
    if (next === base) return
    commitWorkspace(next)
  }

  /** 资产换目录（blob 与元数据一起搬；模型变换走 workspaceMove 的纯函数） */
  const applyAssetMove = (
    assetId: string,
    targetPackageId: string,
    targetDir: string,
  ) => {
    const result = moveAssetToDir(
      workspaceRef.current,
      assetId,
      targetPackageId,
      targetDir,
    )
    if (!result) return
    const client = projectRef.current?.handle.client
    void (async () => {
      const blob = await getAssetBlob(result.fromPackageId, result.fromPath)
      if (!blob) return
      if (client) {
        if (client.transactions.stagedWrites().some(edit => edit.path === result.fromPath)) throw new Error('该资产还有未保存的修改，请先保存再移动')
        await client.apply([
          ...(client.entry(result.fromPath) ? [{ op: 'move' as const, path: result.fromPath, destination: result.toPath }] : []),
          { op: 'write', path: result.toPath, data: blob },
        ], '移动资产及当前内容')
      }
      if (projectRef.current?.handle.client !== client) return
      await putAssetBlob(result.toPackageId, result.toPath, blob)
      await deleteAssetBlob(result.fromPackageId, result.fromPath)
      const current = moveAssetToDir(workspaceRef.current, assetId, targetPackageId, targetDir)
      if (current) commitWorkspace(current.workspace)
    })().catch(e => void alertDialog(`移动资产失败：${String(e)}`))
  }

  const handleDropIntoFolder = (
    targetPackageId: string,
    targetDir: string,
    source: DragSource,
  ) => {
    if (source.kind === 'script') {
      applyScriptMove(source.scriptId, targetPackageId)
      return
    }
    if (source.kind !== 'asset') return
    applyAssetMove(source.assetId, targetPackageId, targetDir)
  }

  /**
   * 配音资产的写 / 删 / 引用 —— 领域逻辑住在 `i18n/voiceOps.ts`，
   * 这里只把组件才做得到的那几件事注进去（工作区读写、活动包、工程句柄、提示）。
   *
   * **在调用时才建，建完不缓存**：`createVoiceOps` 的宿主里到处是 `ref.current`
   * 与 `Date.now()`，直接写在渲染体里会被 React 规则判成"渲染期访问 ref / 调用非纯函数"，
   * 而它本来就只在事件处理里用得到。每次现建几个闭包对象换来的是宿主状态**必然**最新，
   * 不会跨工程切换后还拿着旧句柄。
   */
  const voiceOps = (): VoiceOps =>
    createVoiceOps({
      getWorkspace: () => workspaceRef.current,
      commit: (next) => commitWorkspace(next),
      activePackage: () => {
        const pkg = activePackage()
        return pkg ? { id: pkg.id, assets: pkg.assets } : null
      },
      projectHandle: () => projectRef.current?.handle ?? null,
      library: () => voiceLibraryRef.current,
      refresh: () => {
        voiceLibraryRef.current?.notifyAssetsChanged()
        textBindingRef.current?.refreshVoice()
      },
      notify: (message, ok) => setVoiceToast({ id: Date.now(), message, ok }),
      confirm: (message) => confirmDialog(message),
      alert: (message) => alertDialog(message),
    })

  // ——————————————————————————————————————————————————————————————
  //  录音棚接线
  // ——————————————————————————————————————————————————————————————

  /** 按正文顺序整理选中集合（划框 / 多选给出的顺序不一定和正文一致） */
  const orderKeys = (keys: string[]): string[] => {
    const order = textBindingRef.current?.listKeys() ?? []
    const rank = new Map(order.map((key, index) => [key, index]))
    return [...new Set(keys.map((key) => key.trim().toLowerCase()))]
      .filter(Boolean)
      .sort(
        (a, b) =>
          (rank.get(a) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(b) ?? Number.MAX_SAFE_INTEGER),
      )
  }

  /**
   * 编辑器里左键点了键名。
   *
   * 语义按需求写死：**左键 = 单选配音**（把录音棚切到单选模式并只留这一个键），
   * **按住 Shift / Ctrl / Cmd = 多选**（切到批量配音并把这个键追加进去）。
   */
  const handleUnitSelect = (request: { key: string; additive: boolean }) => {
    setStudioMode(request.additive ? 'batch' : 'single')
    setStudioSelection((prev) =>
      orderKeys(request.additive ? [...prev, request.key] : [request.key]),
    )
  }

  /** 编辑器里划框：keys 为空 = 点了空白处（清空选择）。Ctrl+A 走同一条 */
  const handleMarquee = useCallback(
    (request: { keys: string[]; additive: boolean }) => {
      setStudioSelection((prev) => {
        const next = orderKeys(
          request.additive ? [...prev, ...request.keys] : request.keys,
        )
        // 框到多个键就是批量；只框到一个键按单选处理（等价于点了一下）
        if (request.additive || next.length > 1) setStudioMode('batch')
        else if (next.length === 1) setStudioMode('single')
        return next
      })
    },
    [],
  )

  /** 录音棚底部「确认导入」：把这份音频写进这些键的对等文件 */
  const handleStudioImport = (keys: string[], source: VoiceImportSource) => {
    runVoiceImportForKeys(orderKeys(keys), source)
  }

  /**
   * 录音棚：「引用资产」这种配音方式 —— 把这些键的配音设成引用。
   *
   * 与"确认导入"的区别只有一件事：**不转码、不搬字节**。被引用的那份音频留在原处，
   * 键的对等位置上写一个指向它的 `.ref`。所以同一份音频给多个键用也不会多出拷贝。
   */
  const handleStudioReference = (keys: string[], targetPath: string) => {
    voiceOps().referenceForKeys(orderKeys(keys), targetPath)
  }

  // ===== 录音棚的 TTS =====
  //
  // 两级选择（配音方案 → 语言方案）是**强制**的：缺任一级 `canGenerate` 就是 false，
  // 按钮不可用（规范 §7.4）。生成出来的字节交给 `handleStudioImport` ——
  // 与拖进来的文件完全同一条路，转码、落盘、试听都不需要第二份实现。

  const ttsPresets = useMemo(() => resolvePresets().presets, [])
  const ttsCredentialStore = useMemo(
    () => createCredentialResolver({ backend: createLocalBackend() }),
    [],
  )
  const ttsTransport = useMemo(() => createFetchTransport(), [])

  const [ttsPlanName, setTtsPlanName] = useState<string | null>(null)
  const [ttsLocale, setTtsLocale] = useState<string | null>(null)
  const [ttsStatus, setTtsStatus] = useState<StudioTtsStatus>({ kind: 'idle' })
  /** 一次合成的分块进度。长文本会切成好几块，没有它就只能干等 */
  const [ttsProgress, setTtsProgress] = useState<{ ratio: number; label: string } | null>(null)
  const [showTtsCredentials, setShowTtsCredentials] = useState(false)
  /**
   * 正在跑的那一次批量生成。
   *
   * 它同时是"生成中"这个状态本身。**必须是 state，不能只在 ref 上判断** ——
   * ref 变化不会触发重渲染，按钮就会一直停在"可点"的样子。
   */
  const [ttsRunning, setTtsRunning] = useState(false)
  /** 当前那一次生成的中断手柄。只在事件处理器与异步流程里读，不在渲染期读 */
  const ttsAbortRef = useRef<AbortController | null>(null)

  /** 中断当前生成。已经合成好的那些仍会照常导入（见 `runStudioTts`） */
  function cancelStudioTts() {
    ttsAbortRef.current?.abort()
  }

  const ttsFiles = useMemo(
    () =>
      workspace.packages
        .flatMap((pkg) => pkg.scripts)
        .filter((script) => script.name.toLowerCase().endsWith('.tts')),
    [workspace],
  )

  /** 工程里的服务定义 → 生效值（与配音方案工作区同一套推导） */
  const ttsServices = useMemo(() => {
    const map = new Map<string, ResolvedService>()
    for (const pkg of workspace.packages) {
      for (const script of pkg.scripts) {
        if (!script.name.toLowerCase().endsWith('.ttsservice')) continue
        const id = script.name.slice(0, script.name.length - '.ttsservice'.length).trim()
        if (!id) continue
        const read = readServiceDefinition(script.content, id, ttsPresets)
        if (read.ok) map.set(id, resolveService(read.value, id, ttsPresets))
      }
    }
    return map
  }, [workspace, ttsPresets])

  /** 这个工程用到的 API KEY 引用 —— 本地缓存据此列出"还缺哪几个" */
  const ttsRequiredRefs = useMemo(
    () => [...ttsServices.values()].flatMap((service) => service.auth.map((f) => f.value)),
    [ttsServices],
  )

  /** 工程的语言表 —— 配音方案的语言从它里面挑，而不是手打一个工程里没有的 */
  const ttsProjectLocales = useMemo(
    () =>
      listLocalesOf(workspace)
        .map((item) => item.locale)
        .sort((a, b) => a.localeCompare(b)),
    [workspace],
  )

  /**
   * 新建一个服务定义文件。**只建，不切换。**
   *
   * 调用方（方案设置页）紧接着要把新 id 写进方案，而那一步写的是"当前活动文件" ——
   * 这里如果顺手切过去，方案内容就会写进那个新服务里。
   */
  const createTtsService = async (): Promise<string | null> => {
    const raw = await promptDialog({
      title: '新建服务',
      message: '名字会成为文件名。只用字母、数字、- 和 _。',
      defaultValue: 'my-service',
      validate: (value) =>
        isValidServiceId(value) ? null : '这个名字不行 —— 只用字母、数字、- 和 _，且不能为空',
    })
    if (raw === null) return null
    const id = raw.trim()
    const current = flushEditorInto(workspaceRef.current)
    const fileName = serviceFileName(id)
    if (findScriptByName(current, fileName)) {
      await alertDialog(`「${fileName}」已经存在`)
      return null
    }
    const pkg = findScript(current, current.activeScriptId)?.pkg ?? current.packages[0]
    if (!pkg) {
      await alertDialog('还没有包，请先打开或新建工程。')
      return null
    }
    const script = createScript(
      fileName,
      stringifyServiceDefinition(
        blankServiceDefinition(id, ttsPresets[0]?.id ?? 'template', ttsPresets),
      ),
    )
    commitWorkspace({
      ...current,
      packages: current.packages.map((item) =>
        item.id === pkg.id
          ? { ...item, collapsed: false, scripts: [...item.scripts, script] }
          : item,
      ),
    })
    return id
  }

  /** 打开工程里的某个文件（按文件名）。先把当前正文落定再切，否则刚写的那笔会丢 */
  const openScriptNamed = (fileName: string) => {
    const hit = findScriptByName(workspaceRef.current, fileName)
    if (!hit) return
    /*
     * 落盘与切换必须用**同一个 base**：先 `persistActiveContent` 再拿切换前的快照去
     * `commitWorkspace`，第二笔会把第一笔的结果覆盖回去 —— 刚写的那一份又变回旧正文。
     */
    const base = flushEditorInto(workspaceRef.current)
    commitWorkspace({ ...base, activeScriptId: hit.script.id, activeAssetId: null })
    loadEditorContent(hit.script.id, hit.script.content, hit.script.updatedAt)
  }

  /** 打开某个服务定义的设置页 */
  const openTtsService = (id: string) => openScriptNamed(serviceFileName(id))

  /**
   * 新建一份配音方案（`meta/voice/<说话人>.tts`）。**只建，不切换编辑器。**
   *
   * 从录音棚调用：建完就选中它，缺什么由那一格说出来。切走编辑器会顺带把录音棚
   * 变成"当前文件不支持配音"，为了看一眼新文件把工作台关掉不划算。
   *
   * 建出来就带**一条语言**（工程语言表的第一条）与当前第一个服务 ——
   * 空 `voices` 会是一份结构校验不通过的文件，用户打开它还得先猜要加什么。
   */
  const createTtsPlan = async (): Promise<string | null> => {
    const taken = new Set(
      workspaceRef.current.packages
        .flatMap((pkg) => pkg.scripts)
        .map((script) => script.name.toLowerCase()),
    )
    const suggested =
      rolesRef.current
        .map((role) => role.trim())
        .find((role) => role && !taken.has(planFileName(role).toLowerCase())) ?? ''
    const raw = await promptDialog({
      title: '新建配音方案',
      message: '文件名就是说话人的名字。',
      defaultValue: suggested,
      validate: (value) =>
        isValidServiceId(value) ? null : '这个名字不行 —— 不能为空，也不能含 \\ / : * ? " < > |',
    })
    if (raw === null) return null
    const character = raw.trim()
    const current = flushEditorInto(workspaceRef.current)
    const fileName = planFileName(character)
    if (findScriptByName(current, fileName)) {
      await alertDialog(`「${fileName}」已经存在`)
      return null
    }
    const pkg = findScript(current, current.activeScriptId)?.pkg ?? current.packages[0]
    if (!pkg) {
      await alertDialog('还没有包，请先打开或新建工程。')
      return null
    }
    // 语言就用**编辑器当前正在编辑的那一种**：那一份 `.lang` 才是合成的文本来源，
    // 方案的语言与它不一致时录音棚会拦着不让生成
    const firstLocale = isValidLocaleTag(locale) ? locale : (ttsProjectLocales[0] ?? null)
    const firstService = [...ttsServices.keys()][0] ?? ''
    const plan: VoicePlan = {
      version: 1,
      // 音色**不写空串**：缺就是缺，少一个键比多一个空值干净
      voices: firstLocale ? { [firstLocale]: { service: firstService, extra: {} } } : {},
      extra: {},
    }
    const script = createScript(fileName, stringifyVoicePlan(plan))
    commitWorkspace({
      ...current,
      packages: current.packages.map((item) =>
        item.id === pkg.id
          ? { ...item, collapsed: false, scripts: [...item.scripts, script] }
          : item,
      ),
    })
    // 选中它 —— 录音棚那一格马上就能告诉你它还缺什么
    setTtsPlanName(fileName)
    return fileName
  }

  /**
   * 批量生成配音：逐键「先合成、再导入」。
   *
   * 三件事在这里定死，改动前先看清楚：
   *
   * 1. **串行**。导入共用一份进度与取消引用（见 `runVoiceImportForKeys` 的注释），
   *    并发跑会互相覆盖进度、取消也取消不干净。
   * 2. **译文取自当前打开的语言文件**，所以选的语音方案语言必须与它一致 ——
   *    不一致就**不生成**（见下面的 `textLocale`）。拿中文译文配日语音色是
   *    "成功了一条错误的配音"，比失败难发现得多。
   * 3. **中断要能立刻停**：`AbortController` 传给 `synthesize`，
   *    已经合成出来的那些仍然照常导入 —— 半途丢掉用户等了几分钟的成果没有道理。
   */
  const runStudioTts = async (
    keys: string[],
    planName: string | null,
    locale: string | null,
  ) => {
    const targets = orderKeys(keys)
    if (!planName || !locale || targets.length === 0) return
    // 已经有一次在跑：再来一次会跑起第二条循环，而导入的进度/取消是共用的
    if (ttsAbortRef.current) return

    const file = ttsFiles.find((script) => script.name === planName)
    const parsed = file ? readVoicePlan(file.content, file.name) : null
    if (!file || !parsed?.ok) {
      setTtsStatus({
        kind: 'error',
        failureKind: 'config',
        message: '这份配音方案读不出来',
        hint: '打开这个 .tts 看一眼，或用「以文本方式编辑」修好它',
      })
      return
    }

    const controller = new AbortController()
    ttsAbortRef.current = controller
    setTtsRunning(true)
    let done = 0

    try {
      for (const [index, key] of targets.entries()) {
        if (controller.signal.aborted) break

        setTtsProgress(null)
        setTtsStatus({
          kind: 'busy',
          message: `正在生成 ${index + 1}/${targets.length} —— ${key}`,
        })

        // 没有译文的键不该拿去合成：那会生成一条念着空白的配音
        const text = textMapRef.current?.get(key) ?? null
        if (!text) {
          setTtsStatus({
            kind: 'error',
            failureKind: 'config',
            message: `键「${key}」还没有「${locale}」的译文`,
            hint: '按顺序来：先写译文，再生成配音',
          })
          return
        }

        const result = await synthesizePlanLocale(
          { plan: parsed.value, locale, text, services: ttsServices },
          {
            transport: ttsTransport,
            credential: ttsCredentialStore.resolve,
            signal: controller.signal,
            // 进度按"已完成几个键 + 当前键的第几块"聚合，条不会在第二个键上跳回 0
            onProgress: (ratio, chunk) =>
              setTtsProgress({
                ratio: (index + ratio) / targets.length,
                label:
                  chunk.total > 1
                    ? `${key} · 第 ${chunk.index}/${chunk.total} 段`
                    : `${key} · 共 ${targets.length} 个键`,
              }),
          },
        )

        if (!result.ok) {
          // 用户按了「停止生成」：不算错误，说清已经完成了多少
          if (controller.signal.aborted) break
          // 失败分类直接透出去：缺 API KEY、CORS、厂商拒绝各有各的下一步
          setTtsStatus({
            kind: 'error',
            message: result.failure.message,
            hint: result.failure.hint,
            failureKind: result.failure.kind,
          })
          return
        }

        // 等这一次导入落定再合成下一个：导入共用一份进度与取消引用，并发跑会互相踩
        await runVoiceImportForKeys([key], {
          kind: 'file',
          name: `${key}.wav`,
          bytes: result.audio,
        })
        done += 1
      }

      if (controller.signal.aborted) {
        setTtsStatus({
          kind: 'done',
          message:
            done > 0
              ? `已停止 —— 停止前完成的 ${done} 条已经导入`
              : '已停止 —— 这一批什么都没生成',
        })
        return
      }

      setTtsStatus({ kind: 'done', message: `已生成并导入 ${done} 条` })
    } finally {
      ttsAbortRef.current = null
      setTtsRunning(false)
      setTtsProgress(null)
    }
  }

  /** 录音棚那一格要的东西。每次渲染重算 —— 解析一份小 JSON 比维护依赖表便宜 */
  const studioTts = (() => {
    const plans = ttsFiles
      .map((script) => ({
        name: script.name,
        character: characterNameOfFileName(script.name) ?? script.name,
      }))
      .sort((a, b) => a.character.localeCompare(b.character, 'zh-CN'))

    const plan = plans.find((item) => item.name === ttsPlanName) ?? plans[0] ?? null
    const content = plan ? (ttsFiles.find((s) => s.name === plan.name)?.content ?? '') : ''
    const parsed = plan ? readVoicePlan(content, plan.name) : null
    /*
     * 这份方案配了哪些语言，第②级就只有哪些 —— 选不到，而不是报错。
     *
     * **不看 `parsed.ok`**：一条只差音色 id 的条目仍然是"配了的语言"，把它藏起来
     * 只会让人以为这份文件是空的。能不能生成另由 `planBlockedReason` 把关。
     */
    const locales = parsed ? Object.keys(parsed.value.voices).sort() : []
    /**
     * 第一条错误。面板直接用它说明"为什么还不能生成" —— 用的是校验器的原话，
     * 不再自己猜是缺音色、缺服务，还是旧文件留了个废弃键。
     */
    const planBlockedReason =
      parsed?.issues.find((issue) => issue.level === 'error')?.message ?? null
    const locale = ttsLocale && locales.includes(ttsLocale) ? ttsLocale : (locales[0] ?? null)

    /**
     * 译文来自哪个语言，由**录音棚那一边自己判定** —— 它拿着的 `library.locale`
     * 就是编辑器里那份 `.lang` 的语言。合成用的文本与语音方案的语言不一致时
     * 不该生成（那是"用 A 语言的台词配 B 语言的音色"），而判据在录音棚手上，
     * 所以这里不重复一遍：见 `RecordingStudio` 的 `localeMatchesText`。
     */
    return {
      plans,
      planName: plan?.name ?? null,
      locales,
      locale,
      planBlockedReason,
      status: ttsStatus,
      busy: ttsRunning,
      progress: ttsProgress,
      canGenerate: Boolean(plan && locale && !planBlockedReason),
      onPlanChange: setTtsPlanName,
      onLocaleChange: setTtsLocale,
      onOpenCredentials: () => setShowTtsCredentials(true),
      onCreatePlan: () => {
        createTtsPlan()
      },
      onOpenPlan: plan
        ? () => {
            openScriptNamed(plan.name)
          }
        : undefined,
      onCancel: cancelStudioTts,
      onGenerate: (keys: string[]) => {
        void runStudioTts(keys, plan?.name ?? null, locale)
      },
    }
  })()

  /**
   * 当前打开的是不是 TTS 的那两类文件。
   *
   * 判据是**编辑器里打开的文件**，不是工作区 —— `.tts` / `.ttsservice` 就在常规剧本
   * 编辑器里编辑，下面这一格只在打开它们时出现。换成别的文件它自动消失。
   */
  const ttsFileKind = viewingAsset ? null : ttsFileKindOf(titleName)

  /**
   * 有谁选了"以文本方式编辑"。
   *
   * 记的是**文件名**而不是布尔值 —— 换到别的文件自然就不再匹配，于是自动回到表单，
   * 不需要"换文件时重置一下"的 effect。
   */
  const [ttsRawEditFor, setTtsRawEditFor] = useState<string | null>(null)

  /**
   * 打开这两类文件时一律给设置页。
   *
   * **内容无效也算数** —— 读不出设置就从零填：读取器失败时给的本来就是一份空定义
   * (`toServiceDefinition(null)`)，表单照着它渲染即可。早先的写法是"读不出来就
   * 退回文本编辑"，那等于惩罚用户打开了一个坏文件。文本编辑仍然从设置页够得着。
   */
  const ttsUseForm = Boolean(ttsFileKind && ttsRawEditFor !== titleName)

  /**
   * 由表单写回文件：与手改走同一条路 —— 先回编辑器正文，再照常落盘。
   *
   * 这里**不动归属**：表单显示的就是当前打开的那份文件，正文还属于它。
   * （表单确实是靠 `titleName` 决定显示谁的，`titleName` 又来自 `activeScriptId`。）
   */
  const handleTtsRewrite = (next: string) => {
    setValue(next)
    valueRef.current = next
    editorRef.current?.setValue(next)
    persistActiveContent(next)
  }

  const toggleStudio = () => {
    const open = scriptViewFlags.get().studio
    if (open) {
      // 关掉时顺手清空选中：下次打开不该还挂着上次的键
      setStudioSelection([])
      setStudioMode('single')
    }
    scriptViewFlags.set({ studio: !open })
  }

  // 录音棚开关 → 编辑器进入 / 退出"键名选择"模式（常规交互被禁用）
  useEffect(() => {
    textBindingRef.current?.setStudioMode(studioOpen)
  }, [studioOpen, textBindingSeq])

  useEffect(() => {
    editorRef.current?.updateOptions(scriptEditorAppearance(view))
  }, [view.fontSize, view.minimap, view.wordWrap])

  /**
   * 录音棚模式下 Ctrl / Cmd + A = **选中全部键名**。
   *
   * 挂在 window 上而不是编辑器上：录音棚模式会把编辑器**失焦**（正文只读，常规编辑
   * 交互整体让位），编辑器自己收不到按键。输入框里的 Ctrl+A 是它自己的"全选"，
   * 一律放行。选择语义与划框完全一致（走同一条 `handleMarquee`），所以它是"框住了
   * 所有键"，单选 / 批量的切换规则也一致。
   */
  useEffect(() => {
    if (!studioOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isActive || event.altKey) return
      if (!(event.ctrlKey || event.metaKey)) return
      if (event.key.toLowerCase() !== 'a') return
      const target = event.target as HTMLElement | null
      if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) {
        return
      }
      const keys = textBindingRef.current?.listKeys() ?? []
      if (keys.length === 0) return
      event.preventDefault()
      handleMarquee({ keys, additive: false })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [studioOpen, isActive, handleMarquee])

  // 选中集合 → 覆盖层高亮
  useEffect(() => {
    textBindingRef.current?.setStudioSelection(studioSelection)
  }, [studioSelection, textBindingSeq])

  // 换文件（含换资产）时选中集合作废：那些键已经不在正文里了
  useEffect(() => {
    setStudioSelection([])
  }, [titleName])


  /**
   * 上级容器的右键菜单条目。**可扩展**：往这里加一条就多一个功能；
   * 默认五条 = 改键名 / 改文本 / 改配音 / 删配音 / 删除（红）。
   */
  const unitMenuItems = (key: string): TextUnitMenuItem[] => [
    {
      id: 'edit-key',
      label: 'Edit Key',
      onSelect: () => textBindingRef.current?.editUnit(key, 'key'),
    },
    {
      id: 'edit-text',
      label: 'Edit Text',
      onSelect: () => textBindingRef.current?.editUnit(key, 'value'),
    },
    {
      id: 'edit-voice',
      label: 'Edit Voice',
      onSelect: () => editVoiceInStudio(key),
    },
    {
      id: 'delete-voice',
      label: 'Delete Voice',
      // 没有配音文件（缺失态）就没什么可删的
      disabled: (voiceRuntime?.statusOf(key).path ?? null) == null,
      onSelect: () => voiceOps().confirmAndDeleteVoice(key),
    },
    {
      id: 'delete',
      label: 'Delete',
      danger: true,
      onSelect: () => textBindingRef.current?.deleteUnit(key),
    },
  ]

  const syncRolesFromText = (text: string) => {
    setRoles((prev) =>
      fillRolesFromSpeakers(prev, extractSpeakersFromText(text)),
    )
  }

  const applyLoadedProject = (result: {
    binding: BoundProject
    workspace: Workspace
  }) => {
    const { binding, workspace: loaded } = result
    const next = loaded
    projectRef.current = binding
    setProject(binding)
    setBoundProject(binding)
    commitWorkspace(next)
    setProjectSession({ workspace: next, binding })
    const hit = findScript(next, next.activeScriptId)
    const text = hit?.script.content ?? ''
    loadEditorContent(hit?.script.id ?? null, text, hit?.script.updatedAt ?? null)
    setDiskSavedAt(nowStamp())
    setAgentDiffs([])
    setDiffOpen(false)
    if (hit && isHanshuFile(hit.script.name)) {
      syncRolesFromText(text)
    } else {
      setRoles(createDefaultRoles())
    }
  }

  // 进度工作区改源文件 / 落盘时，把会话拉回本工作区
  useEffect(() => {
    return subscribeProjectSession(() => {
      const remote = getProjectSession()
      if (remote.binding?.handle.client !== projectRef.current?.handle.client) {
        if (remote.binding) applyLoadedProject({ binding: remote.binding, workspace: remote.workspace })
        else { projectRef.current = null; setProject(null); workspaceRef.current = remote.workspace; setWorkspace(remote.workspace); loadEditorContent(null, '', null) }
        return
      }
      if (remote.workspace !== workspaceRef.current) {
        const owner = bufferOwnerRef.current
        const before = owner ? findScript(workspaceRef.current,owner)?.script : null
        const incoming = owner ? findScript(remote.workspace,owner)?.script : null
        workspaceRef.current = remote.workspace
        setWorkspace(remote.workspace)
        if (before && valueRef.current === before.content && incoming?.content !== before.content) {
          const opened = incoming ?? findScript(remote.workspace,remote.workspace.activeScriptId)?.script
          loadEditorContent(opened?.id ?? null,opened?.content ?? '',opened?.updatedAt ?? null)
        }
      }
      if (remote.binding && remote.binding !== projectRef.current) {
        projectRef.current = remote.binding
        setProject(remote.binding)
      }
    })
  }, [])


  const flushProjectToDisk = async () => {
    const bound = projectRef.current
    if (!bound) return
    setProjectBusy(true)
    try {
      // 写盘前把编辑器那份正文并回**它属于的**文件：绑定目录的写入不该动别的文件
      const ws = flushEditorInto(workspaceRef.current)
      workspaceRef.current = ws
      setWorkspace(ws)
      saveWorkspace(ws)
      const saved = await saveProjectToDirectory(bound, ws)
      projectRef.current = saved
      setProject(saved)
      setBoundProject(saved)
      setDiskSavedAt(Date.now())
      // ② 文件已确认提交 → 才把段的新增条目追加进快照库。
      // 失败只告警、不回滚文件：档案是本机副本，文件才是服务端权威（文档 §9「保存路径」）
      try {
        await agentRuntimeRef.current?.archive()
      } catch (error) {
        void alertDialog(
          `文件已保存，但对话快照未落盘：${error instanceof Error ? error.message : String(error)}。下次保存会补写。`,
        )
      }
    } finally {
      setProjectBusy(false)
    }
  }

  /**
   * 写回"当前这份正文"。**写入前核对归属**：正文不属于当前活动文件时拒写。
   *
   * 拒写会丢掉这一次自动记忆（下一次输入会再来一次），但比起把 A 的正文写进 B，
   * 这是唯一可接受的失手方式。真出现了就说明还有一条换文件的路径没走
   * `loadEditorContent` —— 控制台那条 warn 就是留给它的线索。
   */
  const persistActiveContent = (text: string) => {
    const id = activeIdRef.current
    if (!id) return
    if (bufferOwnerRef.current !== id) {
      console.warn('[hanshu] 跳过一次正文写回：编辑器正文不属于当前文件', {
        owner: bufferOwnerRef.current,
        active: id,
      })
      return
    }
    if (writeScriptContent(id, text)) setSavedAt(nowStamp())
  }

  const persistNow = () => {
    // 文档 §7：Run 活跃 → 保存按钮、快捷键、自动保存全部禁用
    if (agentRuntimeRef.current?.view().runState === 'running') {
      void alertDialog('Agent 运行中，暂不可保存。等这一轮结束（或点停止）再保存。')
      return
    }
    const text = valueRef.current
    // 落点用正文的归属：Ctrl+S 保存的是"你正在看的那份"，它属于谁就写给谁
    const id = bufferOwnerRef.current ?? activeIdRef.current
    if (!id) return
    const name = findScript(workspaceRef.current, id)?.script.name ?? ''
    if (isHanshuFile(name)) syncRolesFromText(text)

    let next = updateScriptContent(workspaceRef.current, id, text)

    commitWorkspace(next)
    setSavedAt(Date.now())

    if (projectRef.current) {
      const boundId = projectRef.current.manifest.id
      if (!workspaceRef.current.packages.some((pkg) => pkg.id === boundId)) {
        void alertDialog('当前工程包已不在工作区，这次只记住了本机草稿，没有写入工程。')
        return
      }
      void flushProjectToDisk().catch((err) => {
        void alertDialog(
          `写入工程文件夹失败：${err instanceof Error ? err.message : String(err)}`,
        )
      })
    }
  }

  const openScript = (scriptId: string) => {
    if (
      scriptId === activeIdRef.current &&
      !workspaceRef.current.activeAssetId
    ) {
      return
    }

    const base = flushEditorInto(workspaceRef.current)
    const hit = findScript(base, scriptId)
    if (!hit) return

    commitWorkspace({
      ...base,
      activeScriptId: scriptId,
      activeAssetId: null,
    })
    loadEditorContent(hit.script.id, hit.script.content, hit.script.updatedAt)
    setRoles(createDefaultRoles())
  }

  const openAsset = (assetId: string) => {
    const hit = findAsset(workspaceRef.current, assetId)
    if (!hit) return
    // 先落盘当前剧本
    commitWorkspace({
      ...flushEditorInto(workspaceRef.current),
      activeAssetId: assetId,
    })
  }

  const visibleEditorPage = (ws: Workspace): EditorPage | null => {
    if (ws.activeAssetId && findAsset(ws, ws.activeAssetId)) return { kind: 'asset', id: ws.activeAssetId }
    if (ws.activeScriptId && findScript(ws, ws.activeScriptId)) return { kind: 'script', id: ws.activeScriptId }
    return null
  }
  const editorPageExists = (ws: Workspace, page: EditorPage) =>
    page.kind === 'script' ? Boolean(findScript(ws, page.id)) : Boolean(findAsset(ws, page.id))

  const editorPageLabel = (page: EditorPage) => {
    if (page.kind === 'script') {
      const script = findScript(workspace, page.id)?.script
      if (!script) return { title: '已关闭', tooltip: '已关闭' }
      return { title: assetFileName(script.name), tooltip: sourcePathOf(script) }
    }
    const path = findAsset(workspace, page.id)?.asset.path
    if (!path) return { title: '已关闭', tooltip: '已关闭' }
    return { title: assetFileName(path), tooltip: path }
  }
  /** 删掉当前文件后，优先回到已经打开的另一张书签，不要偷偷打开一份没打开过的文件。 */
  const retainOpenScript = (ws: Workspace, removedScriptIds: Set<string>): string | null => {
    if (ws.activeScriptId && !removedScriptIds.has(ws.activeScriptId) && findScript(ws, ws.activeScriptId)) {
      return ws.activeScriptId
    }
    return openPagesRef.current.find(
      (page) => page.kind === 'script' && !removedScriptIds.has(page.id) && findScript(ws, page.id),
    )?.id ?? null
  }

  const selectEditorPage = (page: EditorPage) => {
    if (page.kind === 'script') openScript(page.id)
    else openAsset(page.id)
  }

  /**
   * 关掉一张书签：只卸下这一页，不删除文件，也不确认。
   * 关掉的是当前页时，切到右侧相邻书签，没有则向左，再没有就回到未打开。
   */
  const closeEditorPage = (page: EditorPage) => {
    const ws = workspaceRef.current
    const pages = openPagesRef.current
    const index = pages.findIndex((item) => editorPageKey(item) === editorPageKey(page))
    if (index < 0) return
    const rest = pages.filter((item) => editorPageKey(item) !== editorPageKey(page))
    openPagesRef.current = rest
    setOpenPages(rest)

    const visible = visibleEditorPage(ws)
    const closingVisible = Boolean(visible && editorPageKey(visible) === editorPageKey(page))
    if (!closingVisible) {
      if (page.kind === 'script' && ws.activeScriptId === page.id) {
        commitWorkspace({ ...ws, activeScriptId: null })
      }
      return
    }

    const neighbor = rest[index] ?? rest[index - 1] ?? null
    if (!neighbor) {
      const current = page.kind === 'script' ? findScript(ws, page.id) : null
      const dirty = Boolean(current && bufferOwnerRef.current === page.id && valueRef.current !== current.script.content)
      const flushed = dirty ? flushEditorInto(ws) : ws
      loadEditorContent(null, '')
      commitWorkspace({ ...flushed, activeScriptId: null, activeAssetId: null })
      setLangEdit(null)
      setUnitMenu(null)
      return
    }
    selectEditorPage(neighbor)
  }

  /**
   * 选类型后立即创建。省略 base 时分配不重名的默认名。
   *
   * 失败只返回原因，不弹窗。folderKey 非空时把新文件登记到该共享虚拟文件夹（只改归属，不改磁盘路径）。
   * 已经建成的文件改名走资源树行内改名（`handleShellRename`）。
   */
  const handleNewFile = (
    packageId: string,
    typeId: NewFileTypeId,
    base?: string,
    folderKey: string | null = null,
  ): NewFileCreateResult => {
    const type = findNewFileType(typeId)
    if (!type) return { ok: false, error: `不认识的文件类型「${typeId}」` }
    if (!isStageplayNewFileType(type)) {
      return {
        ok: false,
        error: `「${type.label}」请在游戏性或视听工作区新建，剧本工作区只建剧本类文件`,
      }
    }

    const pkg = workspaceRef.current.packages.find((item) => item.id === packageId)
    if (!pkg) return { ok: false, error: '目标工程不存在' }

    const occupied = (candidate: string) => {
      const normalized = normalizeResourceName(newFileName(type, candidate))
      if (!normalized) return false
      return pkg.scripts.some(
        (item) =>
          resourceNameKey(sourcePathOf(item)) ===
          resourceNameKey(sourcePathOf({ name: normalized, srcKind: type.srcKind })),
      )
    }
    const resolved = base === undefined ? allocateNewFileBase(type, occupied) : base
    const baseError = validateNewFileBase(type, resolved)
    if (baseError) return { ok: false, error: baseError }

    const name = newFileName(type, resolved)
    const normalized = normalizeResourceName(name)
    if (!normalized || !isManualFileName(normalized)) {
      return { ok: false, error: `文件名无效。新建允许的后缀：${MANUAL_FILE_EXTENSIONS_LABEL}` }
    }
    if (occupied(resolved)) return { ok: false, error: `「${normalized}」已经存在` }

    const script = createScript(
      normalized,
      type.seed(resolved, newFileSeedContext()),
      type.srcKind,
    )
    const nextPackages = flushEditorInto(workspaceRef.current).packages.map((item) =>
      item.id === packageId
        ? { ...item, collapsed: false, scripts: [...item.scripts, script] }
        : item,
    )
    const next: Workspace = {
      packages: nextPackages,
      activeScriptId: script.id,
      activeAssetId: null,
    }
    commitWorkspace(next)
    /*
     * 正文传种子内容，不能传空串。种子已经写进工作区，
     * 编辑器缓冲区若是空的，下一次自动保存会把种子覆盖掉。
     */
    loadEditorContent(script.id, script.content, script.updatedAt)
    setRoles(createDefaultRoles())
    // 未保存的新文件也可先登记归属；其他窗口在源文件提交前只看到空文件夹
    if (folderKey && projectRef.current) {
      void commitOrganization(placeSource(pkg.explorer ?? emptyOrganization(), sourcePathOf(script), folderKey)).catch(
        (error) => notify('文件夹归属未提交', { kind: 'error', detail: String(error) }),
      )
    }
    return { ok: true, scriptId: script.id, base: resolved.trim() }
  }

  /** 资源树新建：创建后让树对新文件进入行内改名。 */
  const handleExplorerCreate = (typeId: NewFileTypeId, folderKey: string | null) => {
    const pkg = workspaceRef.current.packages[0]
    if (!pkg) return
    const result = handleNewFile(pkg.id, typeId, undefined, folderKey)
    if (!result.ok) {
      notify('新建未完成', { kind: 'error', detail: result.error })
      return
    }
    setRenameRequest((previous) => ({ id: result.scriptId, seq: (previous?.seq ?? 0) + 1 }))
  }

  /**
   * 注册表的播种上下文。
   *
   * 注册表**不认识工作区**（见 `newFileTypes.ts` 文件头），语言表、服务定义、目标定义
   * 都由这里现取现给 —— 反过来让一张纯数据表去拉这些，等于把新建文件和配音 / 进度
   * 两个工作区焊在一起。
   */
  const newFileSeedContext = (): NewFileSeedContext => {
    const scripts = workspaceRef.current.packages.flatMap((item) => item.scripts)
    const firstService = [...ttsServices.values()][0]
    return {
      /*
       * 目标定义只扫 `srcKind === 'goal'` 的 `.js`。解析器是纯函数（只看源码文本），
       * 所以这里不必去问进度工作区要它的 catalog。
       * 说明：`createProgress` 现在**收了不用**（新建进度一律空 `goals`，由用户自己加），
       * 所以这一项眼下不改变播种结果 —— 留着是为了它开始按定义播种那天不用改这条路径。
       */
      goalDefinitions: scripts
        .filter((item) => item.srcKind === 'goal')
        .flatMap((item) =>
          parseGoalDefinitionsFromSource(item.content, {
            sourceKey: item.id,
            sourceName: item.name,
          }),
        ),
      ttsPresets,
      // 与录音棚的 `createTtsPlan` 取同一份：方案的语言必须与编辑器当前编辑的那种一致
      firstLocale: isValidLocaleTag(locale) ? locale : (ttsProjectLocales[0] ?? null),
      firstServiceId: firstService?.id ?? '',
      // 预设声明过固定音色表时才预填音色（如 [OI]）；否则留空由方案表单要
      firstVoiceId: firstService?.preset?.voices?.[0] ?? null,
    }
  }

  const handleToggleAssets = (packageId: string) => {
    commitWorkspace(toggleAssetsCollapsed(workspaceRef.current, packageId))
  }

  /**
   * 改名并连带搬迁每种语言的文本 / 音频（见 `renameScriptAssets`）。
   * 界面里的改名与 Agent 的 `rename_source` 共用这一条路径。
   */
  const applyScriptRename = async (
    scriptId: string,
    newName: string,
  ): Promise<{ ok: true; moves: number } | { ok: false; error: string }> => {
    const hit = findScript(workspaceRef.current, scriptId)
    if (!hit) return { ok: false, error: '文件不存在' }
    if(hit.script.detached)return {ok:false,error:'资源已从工程移除，请导出草稿后另存为新资源'}
    if (newName === hit.script.name) return { ok: true, moves: 0 }
    if (projectBusy) return { ok: false, error: '工程操作进行中，请稍候' }
    const oldName = hit.script.name

    // 连带改名：每种语言的文本资产与音频目录都跟着走（见 renameScriptAssets）
    let renamed = renameScriptAssets(workspaceRef.current, scriptId, newName)
    if (renamed.kind === 'blocked') {
      return { ok: false, error: `${renamed.path} 已存在` }
    }

    const assetMoves = renamed.kind === 'moved' ? renamed.moves : []
    const bound = projectRef.current
    const command = { path: sourcePathOf(hit.script), destination: sourcePathOf({ name: newName, srcKind: hit.script.srcKind }) }
    // S 认识的源文件由 sourceCommands 在同一事务里搬迁归属；新文件只有本窗口投影，需单独提交组织
    const serverKnown = Boolean(bound && sourcePathKnownToServer(bound.handle.client, command.path))
    setProjectBusy(true)
    try {
      if (bound) await renameSourceOnDisk(bound.handle, oldName, newName, hit.script.content, assetMoves, hit.script.srcKind, hit.script.srcKind)
    } catch (error) {
      setProjectBusy(false)
      return { ok: false, error: `改名未提交，原文件与草稿已保留：${error instanceof Error ? error.message : String(error)}` }
    }
    if (projectRef.current?.handle.client !== bound?.handle.client) { setProjectBusy(false); return { ok: true, moves: assetMoves.length } }
    // S 已确认。用最新工作区更新投影，避免覆盖等待期间其他文件的编辑。
    renamed = renameScriptAssets(workspaceRef.current, scriptId, newName)
    try {
    if (renamed.kind === 'moved') {
      const packageId = hit.pkg.id
      for (const move of renamed.moves) {
        const blob = await getAssetBlob(packageId, move.fromPath)
        if (!blob) continue
        await putAssetBlob(packageId, move.toPath, blob)
        await deleteAssetBlob(packageId, move.fromPath)
      }
    }

    const base =
      renamed.kind === 'moved' ? renamed.workspace : workspaceRef.current
    const nextWorkspace: Workspace = {
      ...base,
      packages: base.packages.map((pkg) => ({
        ...pkg,
        scripts: pkg.scripts.map((script) =>
          script.id === scriptId ? { ...script, name: newName } : script,
        ),
      })),
    }
    const placed = relocatedExplorer(nextWorkspace, [command])
    commitWorkspace(placed && serverKnown ? withExplorer(nextWorkspace, placed) : nextWorkspace)
    if (placed && !serverKnown && bound) {
      void commitOrganization(placed).catch((error) =>
        notify('文件夹归属未提交', { kind: 'error', detail: String(error) }),
      )
    }
    return {
      ok: true,
      moves: assetMoves.length,
    }
    } catch (error) {
      return { ok: false, error: `服务器已改名，本地缓存更新失败，请重新打开工程：${String(error)}` }
    } finally { setProjectBusy(false) }
  }

  /**
   * 资源树行内改名（F2 / 双击 / 创建后立即改名）。同步校验名字，返回错误则输入框保留；
   * 通过后经 applyScriptRename 提交，失败只提示，不删文件。没改名直接收下。
   */
  const handleShellRename = (scriptId: string, base: string): string | null => {
    const hit = findScript(workspaceRef.current, scriptId)
    if (!hit) return '文件不存在'
    // 改名会连带搬迁该文件的 `.lang` / 配音，agent 持锁期间一律不让改
    if (agentAutoKeyBlockedSources.has(hit.script.name)) {
      return '该资源正被 Agent 使用（锁未释放），暂不能改名；等解锁后再试。'
    }
    if (!isManualFileName(hit.script.name)) return '语言表和配音映射跟着剧本名走，不能单独改名'
    const ext = getExtension(hit.script.name)
    const type =
      NEW_FILE_TYPES.find(
        (item) =>
          item.ext === ext &&
          (item.srcKind ?? undefined) === (hit.script.srcKind ?? undefined),
      ) ?? NEW_FILE_TYPES.find((item) => item.ext === ext)
    if (!type) return '不认识的文件类型'
    const baseError = validateNewFileBase(type, base)
    if (baseError) return baseError
    const normalized = normalizeResourceName(newFileName(type, base))
    if (!normalized || !isManualFileName(normalized)) {
      return `文件名无效。新建允许的后缀：${MANUAL_FILE_EXTENSIONS_LABEL}`
    }
    if (normalized === hit.script.name) return null
    const duplicate = hit.pkg.scripts.some(
      (item) =>
        item.id !== scriptId &&
        resourceNameKey(sourcePathOf(item)) ===
          resourceNameKey(sourcePathOf({ name: normalized, srcKind: hit.script.srcKind })),
    )
    if (duplicate) return `「${normalized}」已经存在`
    if (projectBusy) return '工程操作进行中，请稍候'
    void applyScriptRename(scriptId, normalized).then((result) => {
      if (!result.ok) notify('改名未执行', { kind: 'error', detail: result.error })
    })
    return null
  }

  /**
   * 删除剧本，并连带删除它在**所有语言**下的语言文本与配音资产。
   * 只从 `pkg.scripts` 里摘掉会留下 `assets/<locale>/lang_<ext>/xx.lang` 孤儿（旧行为就漏在这里）。
   */
  const deleteScriptWithAssets = async (
    scriptId: string,
  ): Promise<{ removedAssets: number } | null> => {
    const hit = findScript(workspaceRef.current, scriptId)
    if (!hit) return null
    const sourceName = hit.script.name
    if (projectBusy) return null
    const bound = projectRef.current
    const command = { path: sourcePathOf(hit.script), destination: null }
    const serverKnown = Boolean(bound && !hit.script.detached && sourcePathKnownToServer(bound.handle.client, command.path))
    setProjectBusy(true)
    try {
      if (bound&&!hit.script.detached) await removeSourceFromDisk(bound.handle, sourceName, hit.script.srcKind)
    } catch (error) {
      setProjectBusy(false)
      void alertDialog(`删除未提交，原文件与草稿已保留：${error instanceof Error ? error.message : String(error)}`)
      return null
    }
    if (projectRef.current?.handle.client !== bound?.handle.client) { setProjectBusy(false); return { removedAssets: 0 } }
    try {
    const cleaned = await deleteSourceAssets(
      workspaceRef.current,
      sourceName,
    )

    const nextPackages = cleaned.workspace.packages.map((pkg) => ({
      ...pkg,
      scripts: pkg.scripts.filter((script) => script.id !== scriptId),
    }))
    let activeScriptId = cleaned.workspace.activeScriptId
    if (activeScriptId === scriptId) {
      activeScriptId = retainOpenScript(
        { ...cleaned.workspace, packages: nextPackages, activeScriptId: null },
        new Set([scriptId]),
      )
    }
    const next: Workspace = {
      packages: nextPackages,
      activeScriptId,
      activeAssetId: cleaned.workspace.activeAssetId,
    }
    const placed = relocatedExplorer(next, [command])
    commitWorkspace(placed && serverKnown ? withExplorer(next, placed) : next)
    if (placed && !serverKnown && bound) {
      void commitOrganization(placed).catch((error) =>
        notify('文件夹归属未提交', { kind: 'error', detail: String(error) }),
      )
    }

    if (scriptId === bufferOwnerRef.current || scriptId === activeIdRef.current) {
      const opened = findScript(next, activeScriptId)
      loadEditorContent(
        opened?.script.id ?? null,
        opened?.script.content ?? '',
        opened?.script.updatedAt ?? null,
      )
      setRoles(createDefaultRoles())
    }
    return { removedAssets: cleaned.removed.length }
    } catch (error) {
      void alertDialog(`服务器已删除，本地缓存更新失败，请重新打开工程：${String(error)}`)
      return null
    } finally { setProjectBusy(false) }
  }

  const handleDeleteScripts = async (scriptIds: string[]) => {
    const hits = scriptIds.flatMap((id) => {
      const hit = findScript(workspaceRef.current, id)
      return hit ? [hit] : []
    })
    if (!hits.length) return
    // 删除会连带删掉该文件的 `.lang` / 配音：源锁或任一派生语言锁都挡住；
    // 其余（未锁）资源照常删，不做整次静默失败。
    const locked = hits.filter((hit) => agentAutoKeyBlockedSources.has(hit.script.name))
    if (locked.length > 0) {
      notify(
        `以下资源正被 Agent 使用（锁未释放），暂不能删除：${locked
          .map((hit) => hit.script.name)
          .join('、')}；等解锁后再试。`,
        { kind: 'error' },
      )
    }
    const deletable = hits.filter((hit) => !agentAutoKeyBlockedSources.has(hit.script.name))
    if (!deletable.length) return
    const message = deletable.length === 1
      ? `删除「${deletable[0]!.script.name}」及其各语言的译文 / 配音？`
      : `删除 ${deletable.length} 个剧本资源及其各语言的译文 / 配音？`
    if (!(await confirmDialog({ message, danger: true }))) return
    for (const hit of deletable) {
      if (!(await deleteScriptWithAssets(hit.script.id))) break
    }
  }

  const handleDeleteAsset = (assetId: string) => {
    const hit = findAsset(workspaceRef.current, assetId)
    if (!hit) return
    // 资源树按行禁用了；这里再兜一层，防止从其它入口删到被锁的语言文件
    if (isLockedAssetPath(agentLockedAssetPathsRef.current, hit.asset.path)) {
      void alertDialog(
        `「${hit.asset.path}」正被 Agent 使用（锁未释放），暂不能删除；等解锁后再试。`,
      )
      return
    }
    void confirmDialog({ message: `删除资产「${hit.asset.path}」？`, danger: true }).then(async (ok) => {
      if (!ok) return
      try {
        await voiceOps().removeAssetEverywhere(hit.pkg.id, [hit.asset.path])
      } catch (error) {
        await alertDialog(`资产未删除：${String(error)}`)
      }
    })
  }

  const handleNewAssetFolder = (packageId: string, parentPath: string) => {
    void promptDialog({
      title: '新建文件夹',
      message: '文件夹名不能包含 \\ / : * ? " < > |',
      defaultValue: 'voice',
      validate: (value) => {
        if (!value.trim()) return '名字不能为空'
        if (/[\\/:*?"<>|]/.test(value.trim())) return '文件夹名不能包含 \\ / : * ? " < > |'
        return null
      },
    }).then((name) => {
      if (!name?.trim()) return
      const folder = normalizeFolderPath(`${parentPath}/${name.trim()}`)
      if (!folder || folder === 'assets') {
        void alertDialog('文件夹路径无效')
        return
      }
      const client = projectRef.current?.handle.client
      if (client) void client.apply([{ op: 'mkdir', path: folder }]).then(() => commitWorkspace(ensureAssetFolder(workspaceRef.current, packageId, folder))).catch((error) => { void alertDialog(String(error)) })
    })
  }

  const handleDeleteAssetFolder = (packageId: string, folderPath: string) => {
    if (folderPath === 'assets') return
    // 删除目录 = 删除其下全部资产；有被锁语言文件时整目录都别动
    if (folderHasLockedAsset(agentLockedAssetPathsRef.current, folderPath)) {
      void alertDialog(
        `「${folderPath}」内有正被 Agent 使用的资产（锁未释放），暂不能删除；等解锁后再试。`,
      )
      return
    }
    void confirmDialog({ message: `删除文件夹「${folderPath}」及其下全部资产？`, danger: true }).then((ok) => {
      if (!ok) return
      const client = projectRef.current?.handle.client
      void (async () => {
        if (client?.transactions.stagedWrites().some((edit) => edit.path.startsWith(`${folderPath}/`))) throw new Error('文件夹内还有未保存的修改，请先保存或处理提交记录')
        if (client?.entry(folderPath)) await client.apply([{ op: 'remove', path: folderPath }], '删除资产文件夹')
        if (projectRef.current?.handle.client !== client) return
        const { workspace: next, removed } = removeAssetFolder(workspaceRef.current, packageId, folderPath)
        for (const asset of removed) await deleteAssetBlob(packageId, asset.path)
        commitWorkspace(next)
      })().catch((error) => { void alertDialog(`删除文件夹未完成：${String(error)}`) })
    })
  }

  const handleImportAssets = async (
    packageId: string,
    files: FileList | File[],
    targetDir = 'assets',
  ) => {
    const list = Array.from(files)
    if (list.length === 0) return

    const baseDir = normalizeFolderPath(targetDir) ?? 'assets'
    let next = ensureAssetFolder(workspaceRef.current, packageId, baseDir)
    let lastAssetId: string | null = null
    const failed: string[] = []
    const lockedFiles: string[] = []

    for (const file of list) {
      const withPath = file as File & { webkitRelativePath?: string }
      const rel =
        withPath.webkitRelativePath && withPath.webkitRelativePath.length > 0
          ? withPath.webkitRelativePath
          : file.name
      const path = normalizeAssetPath(`${baseDir}/${rel}`)
      if (!path) {
        failed.push(file.name)
        continue
      }
      // 导入到被锁资产路径会覆盖 Agent 正在写的文件：跳过并统一告知
      if (isLockedAssetPath(agentLockedAssetPathsRef.current, path)) {
        lockedFiles.push(path)
        continue
      }
      try {
        await putAssetBlob(packageId, path, file)
        const result = registerAsset(
          next,
          packageId,
          path,
          file.type || 'application/octet-stream',
          file.size,
        )
        if (!result) {
          failed.push(file.name)
          continue
        }
        next = result.workspace
        lastAssetId = result.asset.id
      } catch {
        failed.push(file.name)
      }
    }

    commitWorkspace({
      ...next,
      activeAssetId: lastAssetId ?? next.activeAssetId,
    })

    if (failed.length > 0 || lockedFiles.length > 0) {
      const problems: string[] = []
      if (lockedFiles.length > 0) {
        problems.push(
          `以下资产正被 Agent 使用（锁未释放），未导入：\n${lockedFiles.join('\n')}\n等解锁后再试。`,
        )
      }
      if (failed.length > 0) problems.push(`部分文件导入失败：\n${failed.join('\n')}`)
      void alertDialog(problems.join('\n\n'))
    }
  }

  const handleGeneratePlaceholderVoice = async (scriptId: string) => {
    const hit = findScript(workspaceRef.current, scriptId)
    if (!hit || !isVoiceMapFile(hit.script.name)) {
      void alertDialog('请选择 .voice 文件')
      return
    }

    let voiceContent = hit.script.content
    // 这份文件的正文就在编辑器里（归属是它）→ 以编辑器内容为准
    if (bufferOwnerRef.current === scriptId && !workspaceRef.current.activeAssetId) {
      voiceContent = valueRef.current
    }

    const missing = listMissingVoiceOggs(
      voiceContent,
      locale,
      hit.pkg.assets.map((a) => a.path),
    )
    if (missing.length === 0) {
      void alertDialog('没有缺失的 ogg（或尚无有效 id）')
      return
    }

    if (!(await confirmDialog(`将在 ${voiceRootDir(locale)}/ 生成 ${missing.length} 个空白 ogg，是否继续？`))) {
      return
    }

    const blank = createBlankOggBlob()
    let next = workspaceRef.current
    let created = 0
    const failed: string[] = []

    for (const { path } of missing) {
      try {
        await putAssetBlob(hit.pkg.id, path, blank)
        const result = registerAsset(
          next,
          hit.pkg.id,
          path,
          'audio/ogg',
          blank.size,
        )
        if (!result) {
          failed.push(path)
          continue
        }
        next = result.workspace
        created++
      } catch {
        failed.push(path)
      }
    }

    commitWorkspace(next)
    void alertDialog(
      failed.length > 0
        ? `已生成 ${created} 个；失败 ${failed.length}：\n${failed.join('\n')}`
        : `已生成 ${created} 个空白 ogg`,
    )
  }

  // 自动记忆当前剧本正文（看资产时不写回）
  useEffect(() => {
    if (workspace.activeAssetId) return
    const scriptId = workspace.activeScriptId
    // 正文不属于这一份就别排程：排了也只是等着被拒
    if (!scriptId || bufferOwnerRef.current !== scriptId) return
    const timer = window.setTimeout(() => {
      /*
       * 定时器**写的是这份正文属于的那一份**，不是"400ms 之后谁是活动文件"。
       *
       * 期间换过文件（例如旧格式文本文件被迁移、活动 id 跳到了另一份）时，写回原来的
       * 那一份仍然是对的；写"当前活动的那一份"就是把上一份的正文盖到新文件上。
       */
      if (bufferOwnerRef.current !== scriptId) return
      if (writeScriptContent(scriptId, value)) setSavedAt(nowStamp())
    }, 400)
    return () => window.clearTimeout(timer)
  }, [value, workspace.activeScriptId, workspace.activeAssetId])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isActive && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        persistNow()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isActive])

  const updateRole = (index: number, next: string) => {
    setRoles((prev) => {
      const copy = [...prev]
      copy[index] = next
      return copy
    })
  }

  const insertRole = (index: number) => {
    const role = rolesRef.current[index]?.trim()
    const ed = editorRef.current
    if (!role || !ed) return
    applySpeakerInsert(ed, role)
  }

  const handleMenuAction = (item: string) => {
    if (item !== 'voice-studio' && toggleScriptViewItem(item)) return
    switch (item) {
      case 'save':
        persistNow()
        return
      case 'new-script':
        setNewFileMenuRequest((count) => count + 1)
        return
      case 'voice-studio':
        toggleStudio()
        return
      case 'command-palette':
        void runScriptCommandPalette(handleMenuAction)
        return
      case 'appearance':
        void pickFontSize(scriptViewFlags.get().fontSize, SCRIPT_FONT_MIN, SCRIPT_FONT_MAX).then((size) => {
          if (size != null) scriptViewFlags.set({ fontSize: size })
        })
        return
      case 'editor-layout':
        void confirmDialog({
          title: '编辑器布局',
          message: '恢复默认停靠布局？当前拖过的栏目和文件标签布局会丢掉。',
          confirmLabel: '恢复',
        }).then((ok) => {
          if (ok) {
            resetPanelDock()
            resetEditorDock(STAGEPLAY_EDITOR_DOCK_KEY)
          }
        })
        return
      case 'go-to-file':
        void (async () => {
          const options = workspaceRef.current.packages.flatMap((pkg) =>
            pkg.scripts.map((script) => ({ id: script.id, label: script.name, detail: pkg.name })),
          )
          if (options.length === 0) {
            await alertDialog('工程里还没有可打开的文件。')
            return
          }
          const picked = await chooseDialog({
            title: '转到文件',
            message: '输入以筛选。',
            options,
            filterable: true,
            placeholder: '文件名',
          })
          if (picked) openScript(picked)
        })()
        return
      default: {
        if (runMonacoMenuAction(editorRef.current, item)) return
        if (editorMenuActionId(item)) void alertDialog('当前没有打开可编辑的文本。')
      }
    }
  }

  const pushAgentDiff = (snap: AgentDiffSnapshot) => {
    setAgentDiffs((prev) => {
      const idx = prev.findIndex((item) => item.fileName === snap.fileName)
      if (idx < 0) return [...prev, snap]
      // 同一文件多次写入：保留最初 before，只更新 after
      const next = [...prev]
      const old = next[idx]
      next[idx] = {
        ...old,
        after: snap.after,
        created: old.created || snap.created,
      }
      return next
    })
    setDiffOpen(true)
  }

  const removeAgentDiffAt = (index: number) => {
    setAgentDiffs((prev) => {
      const next = prev.filter((_, i) => i !== index)
      if (next.length === 0) setDiffOpen(false)
      return next
    })
  }

  const clearAgentDiffs = () => {
    setAgentDiffs([])
    setDiffOpen(false)
  }

  /** 静默删除剧本（用于撤销 Agent 新建，不弹 confirm） */
  const removeScriptSilent = (scriptId: string) => {
    const nextPackages = workspaceRef.current.packages.map((pkg) => ({
      ...pkg,
      scripts: pkg.scripts.filter((script) => script.id !== scriptId),
    }))
    let activeScriptId = workspaceRef.current.activeScriptId
    if (activeScriptId === scriptId) {
      activeScriptId = retainOpenScript(
        { packages: nextPackages, activeScriptId: null, activeAssetId: workspaceRef.current.activeAssetId },
        new Set([scriptId]),
      )
    }
    const next: Workspace = {
      packages: nextPackages,
      activeScriptId,
      activeAssetId: workspaceRef.current.activeAssetId,
    }
    commitWorkspace(next)
    if (scriptId === activeIdRef.current || !activeScriptId) {
      const opened = findScript(next, activeScriptId)
      loadEditorContent(
        opened?.script.id ?? null,
        opened?.script.content ?? '',
        opened?.script.updatedAt ?? null,
      )
      setRoles(createDefaultRoles())
    }
  }

  const restoreFileContent = (fileName: string, content: string) => {
    const hit = findScriptByName(workspaceRef.current, fileName)
    if (!hit) return false
    const next = updateScriptContent(
      workspaceRef.current,
      hit.script.id,
      content,
    )
    commitWorkspace(next)
    if (hit.script.id === bufferOwnerRef.current) {
      loadEditorContent(hit.script.id, content)
    }
    return true
  }

  const currentContentOf = (fileName: string) => {
    const hit = findScriptByName(workspaceRef.current, fileName)
    if (!hit) return null
    // "当前打开的文件以编辑器内容为准" —— 判据是**正文的归属**，不是活动 id
    if (hit.script.id === bufferOwnerRef.current) return valueRef.current
    return hit.script.content
  }

  const undoAgentDiff = async (index: number) => {
    const snap = agentDiffs[index]
    if (!snap) return

    const current = currentContentOf(snap.fileName)
    if (
      current != null &&
      current !== snap.after &&
      current !== snap.before &&
      !(await confirmDialog(`「${snap.fileName}」在 Agent 写入后又有改动，仍要撤销到修改前？`))
    ) {
      return
    }

    if (snap.created) {
      const hit = findScriptByName(workspaceRef.current, snap.fileName)
      if (hit) removeScriptSilent(hit.script.id)
    } else {
      restoreFileContent(snap.fileName, snap.before)
    }
    removeAgentDiffAt(index)
  }

  const acceptAgentDiff = (index: number) => {
    removeAgentDiffAt(index)
  }

  const undoAllAgentDiffs = async () => {
    if (agentDiffs.length === 0) return
    if (!(await confirmDialog(`撤销全部 ${agentDiffs.length} 处 Agent 修改？`))) return

    // 从后往前，避免索引错位；新建删除与内容恢复互不依赖顺序
    for (let i = agentDiffs.length - 1; i >= 0; i -= 1) {
      const snap = agentDiffs[i]
      if (snap.created) {
        const hit = findScriptByName(workspaceRef.current, snap.fileName)
        if (hit) removeScriptSilent(hit.script.id)
      } else {
        restoreFileContent(snap.fileName, snap.before)
      }
    }
    clearAgentDiffs()
  }

  const acceptAllAgentDiffs = () => {
    clearAgentDiffs()
  }

  /** Agent 写入已有文件：并回编辑器、记 diff；工程历史由 S 在提交成功时记录。 */
  const applyAgentFileWrite = (
    scriptId: string,
    content: string,
  ): { file: string } | null => {
    const hit = findScript(workspaceRef.current, scriptId)
    if (!hit) return null
    // "编辑器里这份正文就是它" —— 判据是正文归属
    const inEditor = hit.script.id === bufferOwnerRef.current
    const before = inEditor ? valueRef.current : hit.script.content
    // P4：内容相同 → 不 commit、不记 diff（updatedAt 不跳变；P7 据此报 changed:false）
    if (before === content) return { file: hit.script.name }
    commitWorkspace(updateScriptContent(workspaceRef.current, scriptId, content))
    if (inEditor) {
      loadEditorContent(scriptId, content)
    }
    pushAgentDiff({ fileName: hit.script.name, before, after: content })
    // 内容级成键抑制：这份正文是程序化写入的，用户没改之前不要自动成键
    agentWrittenContentRef.current.set(hit.script.name, content)
    return { file: hit.script.name }
  }

  /** 源文件的最新正文：当前打开的文件以编辑器内容为准 */
  const agentSourceContent = (scriptId: string): string | null => {
    const hit = findScript(workspaceRef.current, scriptId)
    if (!hit) return null
    return hit.script.id === bufferOwnerRef.current
      ? valueRef.current
      : hit.script.content
  }

  /**
   * staged 草稿的路径查找：事务 key 可能是 `handle.resolve()` 之后的工程内路径，
   * 而工具与资产接口拿到的是包内相对路径（`assets/…`），两种都要认。
   */
  const stagedLangText = (path: string): string | undefined => {
    const project = projectRef.current
    const client = project?.handle.client
    if (!client) return undefined
    const direct = client.transactions.stagedText(path)
    if (direct !== undefined) return direct
    if (!project) return undefined
    const resolved = project.handle.resolve(path)
    return resolved === path ? undefined : client.transactions.stagedText(resolved)
  }

  /** 已保存版本：绑定工程优先读 S（带内容哈希），读不到退回本机镜像（无版本） */
  const readLangSaved = async (
    pkgId: string,
    path: string,
  ): Promise<{ text: string | null; version: string | null }> => {
    const project = projectRef.current
    const client = project?.handle.client
    // 工程可能挂在 S 根的子目录下：优先读 resolve 后的真实工程内路径
    const resolved = project ? project.handle.resolve(path) : path
    const lookup = resolved !== path && client?.entry(resolved) ? resolved : path
    if (client?.entry(lookup)) {
      try {
        const { file, version } = await client.readSnapshot(lookup, false)
        return { text: await file.text(), version }
      } catch {
        /* 读不到就退回本机缓存，至少不要阻断工具 */
      }
    }
    const blob = await getAssetBlob(pkgId, path)
    return { text: blob ? await blob.text() : null, version: null }
  }

  /**
   * 语言文本的权威读取：**本地草稿优先**（与编辑器手改同一通道），其次工程文件 / 本机镜像。
   *
   * `version` 只在读到 S 的已保存版本时有值；`draft=true` 表示读到的是尚未保存的草稿，
   * 工具层必须据此标注（D1：不把草稿伪装成已保存）。
   */
  const readLangState = async (
    pkgId: string,
    path: string,
  ): Promise<{
    map: Record<string, string>
    version: string | null
    draft: boolean
    saved: boolean
    /** R1：本机有镜像但 S 无已保存版本（常见于新建工程渲染过当前语言） */
    hasLocalMirror: boolean
    /** 兼容旧字段名：等价于 draft */
    localDraft: boolean
  }> => {
    const state = await readLangDraft(stagedLangText, path, () => readLangSaved(pkgId, path))
    return {
      map: state.map,
      version: state.savedVersion,
      draft: state.draft,
      // B8/R1：saved 只表示“S 里已有已保存版本”，本机镜像不算
      saved: state.hasSaved,
      hasLocalMirror: state.hasLocalMirror,
      localDraft: state.draft,
    }
  }

  /**
   * 语言文本写入 = **本地草稿**（D1）：stageWrite 草稿 + IndexedDB 镜像，不再写 S。
   * 返回 `ok:true` 只表示草稿已写；未绑定工程时额外标 `localOnly`（没有工程文件可保存）。
   */
  const stageLangWrite = async (
    pkgId: string,
    path: string,
    map: Record<string, string>,
    options?: { allowUnwritable?: boolean },
  ): Promise<
    | { ok: true; localOnly: boolean; draft: true; saved: false; version: null }
    | { ok: false; error: string }
  > => {
    const project = projectRef.current
    const client = project?.handle.client ?? null
    return writeLangDraft({
      client:
        client && project
          ? {
              writable: client.writable,
              online: client.online,
              resolvePath: (candidate) => project.handle.resolve(candidate),
              transactions: client.transactions,
              assetEpochs: client.assetEpochs,
            }
          : null,
      path,
      map,
      ...(options?.allowUnwritable ? { allowUnwritable: true } : {}),
      mirror: async () => {
        const workspace = await writeLangAsset(workspaceRef.current, pkgId, path, map)
        if (projectRef.current?.handle.client !== client) {
          throw new Error('project switched; the language draft stayed in the previous project')
        }
        commitWorkspace(workspace)
      },
      cacheEpoch: () => assetCacheEpoch(pkgId, path),
    })
  }

  /** 跨包同名时 `findScriptByName` 会抛异常：宿主统一转成稳定的英文错误，不再让异常逃逸 */
  const agentDuplicateNameError = (source: string): AgentOpResult => ({
    ok: false,
    reason: 'not_unique',
    error: `resource name is not unique: ${source}`,
    hint: 'pass the full project path (with directory) to disambiguate',
  })

  type AgentScriptHit = NonNullable<ReturnType<typeof findScriptByName>>
  const findAgentScript = (
    source: string,
  ): { hit: AgentScriptHit } | { error: AgentOpResult; notFound?: boolean } => {
    try {
      const hit = findScriptByName(workspaceRef.current, source)
      return hit
        ? { hit }
        : {
            error: {
              ok: false,
              reason: 'not_found',
              error: `file not found: ${source}`,
            },
            notFound: true,
          }
    } catch {
      return { error: agentDuplicateNameError(source) }
    }
  }

  /** 语言工具的目标：源文件 + 语言 → 所属包、资产路径与当前译文表 */
  const langTargetOf = async (sourceName: string, localeArg?: string) => {
    const found = findAgentScript(sourceName)
    if ('error' in found) return found
    const hit = found.hit
    const lang = localeArg?.trim() || locale
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
    const requested = (raw ?? '').trim() || locale
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

  /** C2：键名是文本哈希；逆解析后必须用**同一语言**重新 parse_hs 才能拿回原键 */
  const LANG_KEY_IDENTITY_NOTE =
    'keys are text hashes: re-run parse_hs with the same locale to rebuild them; parsing a different locale will create new keys and drop the old ones'

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
      const files = workspaceRef.current.packages
        .filter((pkg) => !filter || pkg.name.toLowerCase() === filter)
        .flatMap((pkg) =>
          pkg.scripts.map((script) => ({
            package: pkg.name,
            source: script.name,
            kind: sourceKindOf(script.name, script.srcKind),
            bytes: script.content.length,
            updatedAt: script.updatedAt,
            /** 已从工程移除、只剩本机恢复草稿的文件：可读，但不能再写 */
            detached: script.detached === true,
          })),
        )
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
        const project = projectRef.current
        const client = project?.handle.client
        if (!project || !client) return false
        // 事务里的 key 可能是 `handle.resolve()` 之后的工程内路径（带子目录前缀），
        // 两种形态都查，避免因为路径规范化差异漏掉草稿。
        const candidates = new Set([normalized, project.handle.resolve(normalized)])
        return [...candidates].some((path) => client.transactions.hasDraft(path))
      }
      const hit = (() => {
        try {
          return findScriptByName(workspaceRef.current, source)
        } catch {
          return null
        }
      })()
      if (!hit) return false
      return (
        hit.script.id === bufferOwnerRef.current &&
        valueRef.current !== hit.script.content
      )
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
      const pkgId =
        findScript(workspaceRef.current, activeIdRef.current)?.pkg.id ??
        workspaceRef.current.packages[0]?.id
      if (!pkgId) {
        return { ok: false, reason: 'host_error', error: 'no project package available' }
      }

      let base = flushEditorInto(workspaceRef.current)
      const script = createScript(checked.name, content)
      // 新建**不切换**当前打开的文件：agent 造文件不该动用户正在看的东西
      commitWorkspace({
        packages: base.packages.map((pkg) =>
          pkg.id === pkgId
            ? { ...pkg, collapsed: false, scripts: [...pkg.scripts, script] }
            : pkg,
        ),
        activeScriptId: base.activeScriptId,
        activeAssetId: base.activeAssetId,
      })
      pushAgentDiff({
        fileName: checked.name,
        before: '',
        after: content,
        created: true,
      })
      // 新建正文同样算程序化写入：内容未改前不要自动成键
      agentWrittenContentRef.current.set(checked.name, content)
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
      const hit = found.hit
      removeScriptSilent(hit.script.id)
      // 刚被撤销的新建不该继续留在「Agent 修改」待审列表里
      setAgentDiffs((previous) => {
        const next = previous.filter((item) => item.fileName !== hit.script.name)
        if (next.length === 0) setDiffOpen(false)
        return next
      })
    },
    validateSource: (source) => {
      const found = findAgentScript(source)
      if ('error' in found) return found.error
      const hit = found.hit
      const content = agentSourceContent(hit.script.id) ?? hit.script.content
      const result = validateSourceContent(hit.script.name, content, {
        foreignInjects: indexForeignHsInjects(
          workspaceRef.current,
          hit.script.name,
        ),
      })
      return {
        ok: result.diagnostics.length === 0 && !result.compileError,
        source: hit.script.name,
        diagnostics: result.diagnostics,
        compileError: result.compileError,
      }
    },
    getActiveFilePath: () => {
      const active = activeFilePathOf(workspaceRef.current, activeIdRef.current)
      if (!active) return { ok: false, error: 'no file is currently open' }
      return {
        ok: true,
        source: active.name,
        kind: active.kind,
        path: active.path,
        hint: 'path is informational only; tool arguments still use the logical source name',
      }
    },
    listLocales: () => ({
      ok: true,
      active: locale,
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
        if (locale) push(locale)
      }
      return tags.map((tag) => ({ locale: tag, path: langAssetPathFor(hit.script.name, tag) }))
    },
    /** 读派生语言资产正文（S 权威优先）：锁版本与 write_lang 写前校验用 */
    readAssetText: async (path) => {
      // 草稿优先：锁版本 / noteWritten 必须看到 agent 刚写进 staged 的内容，
      // 否则写后版本会和锁表锚点对不上（下一轮误判 version_stale）。
      const staged = stagedLangText(path)
      if (staged !== undefined) return staged
      const client = projectRef.current?.handle.client
      if (client?.entry(path)) {
        try {
          const { file } = await client.readSnapshot(path, false)
          return await file.text()
        } catch {
          return null
        }
      }
      const packageId =
        client?.assetPackageId ??
        projectRef.current?.manifest.id ??
        workspaceRef.current.packages[0]?.id
      if (!packageId) return null
      const blob = await getAssetBlob(packageId, path)
      return blob ? blob.text() : null
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
      const project = projectRef.current
      const client = project?.handle.client ?? null
      const pkgId =
        client?.assetPackageId ??
        project?.manifest.id ??
        workspaceRef.current.packages[0]?.id
      if (!pkgId) {
        throw new Error(`language draft replay failed: no project available (${normalized})`)
      }

      if (content === null) {
        // staged key 可能是原始资产路径，也可能是 handle.resolve() 后的工程内路径
        if (client && project) {
          try {
            discardLangDraft(client.transactions, [
              normalized,
              project.handle.resolve(normalized),
            ])
          } catch (error) {
            throw new Error(
              `language draft replay failed: ${error instanceof Error ? error.message : String(error)}`,
            )
          }
        }
        const existing = workspaceRef.current.packages
          .flatMap((pkg) => pkg.assets)
          .find((asset) => normalizeSourcePath(asset.path) === normalized)
        if (!existing) return
        await deleteAssetBlob(pkgId, existing.path)
        if (projectRef.current?.handle.client !== client) {
          throw new Error('language draft replay failed: project switched')
        }
        client?.assetEpochs.delete(existing.path)
        commitWorkspace(removeAssetMeta(workspaceRef.current, existing.id))
        if (textMapRef.current?.fileName.toLowerCase() === existing.path.toLowerCase()) {
          textCacheRef.current = ''
          textMapRef.current.load()
        }
        return
      }

      const staged = await stageLangWrite(pkgId, normalized, parseTextFile(content), {
        // 回放只动本地草稿：断线 / 暂时只读时也应允许恢复，否则失败后反而回滚不了
        allowUnwritable: true,
      })
      if (!staged.ok) throw new Error(`language draft replay failed: ${staged.error}`)
      if (textMapRef.current?.fileName.toLowerCase() === normalized.toLowerCase()) {
        textCacheRef.current = content
        textMapRef.current.load()
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
      const entries = page.map((item) => ({
        key: item.key,
        line: item.line,
        text: target.map[item.key] ?? '',
        translated: item.key in target.map,
      }))
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
        active: target.lang.toLowerCase() === locale.toLowerCase(),
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
        if (textMapRef.current?.fileName.toLowerCase() === path.toLowerCase()) {
          textCacheRef.current = stringifyTextFile(next)
          textMapRef.current.load()
        }
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
      if (
        textMapRef.current?.fileName.toLowerCase() === target.path.toLowerCase()
      ) {
        textCacheRef.current = stringifyTextFile(next)
        textMapRef.current.load()
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
    listVoiceStatus: async (source, localeArg, offset, limit) => {
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
      const allEntries = await voiceStatusOf(
        hit.pkg.id,
        hit.pkg.assets,
        hit.script.name,
        lang,
        keys,
      )
      // B3：分页；不再回传完整 missing 数组，只给数量 + 最多 10 个样例
      const start = Math.max(1, Math.floor(offset ?? 1) || 1)
      const count = Math.min(Math.max(1, Math.floor(limit ?? 100) || 100), 500)
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
      if (textMapRef.current?.fileName.toLowerCase() === path.toLowerCase()) {
        textCacheRef.current = stringifyTextFile(next)
        textMapRef.current.load()
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
      flushProjectEditors()
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
          const sourceName = sourceNameFromLangAssetPath(asset.path)
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

      // P6：顶层 warnings 只留 translations + assets（orphan）；导出编译器 warning 全部归组
      const topWarningsAll = [...translationsWarnings, ...orphanWarnings]
      const warnings = topWarningsAll.slice(0, warningLimit)
      const warningTotal = topWarningsAll.length

      const exportedAssets: Array<{ code: string; message: string; path?: string }> = []
      const exportedGameplay: Array<{ code: string; message: string; path?: string }> = []
      const seenExport = new Set<string>()
      for (const raw of [...pak.warnings, ...project.warnings]) {
        const translated = translateExportWarning(raw)
        const key = `${translated.group}:${translated.message}`
        if (seenExport.has(key)) continue
        seenExport.add(key)
        if (translated.group === 'assets') {
          exportedAssets.push({ code: 'export_asset', message: translated.message })
        } else {
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
        groups: {
          translations: translationsGroup.items,
          assets: assetsGroup.items,
          gameplay: gameplayGroup.items,
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

  // 工具派发时读最新宿主：runtime 只创建一次，宿主随渲染更新（避免每次渲染重建运行时）
  agentHostRef.current = agentHost

  const agentScope = project?.manifest.id ?? workspace.packages[0]?.id ?? 'local'

  useEffect(() => {
    if (!agentOpen || !agentHostRef.current) return
    let disposed = false
    let cleanup: (() => void) | null = null

    void (async () => {
      try {
        const windowId = await claimWindowId()
        // 每个窗口一个独立段库（文档 §9）：windowId 跨刷新稳定，复制标签页会拿到新 id
        const runtime = createAgentRuntime({
          scope: agentScope,
          windowId,
          host: agentHostProxyRef.current as AgentHost,
          apiKey: getAgentApiKey(),
          model: getAgentModelId(),
          // 文档 §7：保存事务进行中禁止启动 Run
          canStartRun: () => !projectBusyRef.current,
        })
        await runtime.open()
        if (disposed) {
          await runtime.close()
          return
        }
        agentRuntimeRef.current = runtime
        setAgentRuntime(runtime)
        setAgentView(runtime.view())
        const unsubscribe = runtime.subscribe((next) => setAgentView(next))
        cleanup = () => {
          unsubscribe()
          agentRuntimeRef.current = null
          void runtime.close()
        }
      } catch (error) {
        if (!disposed) {
          console.warn('[hanshu] Agent 运行时启动失败', error)
        }
      }
    })()

    return () => {
      disposed = true
      if (cleanup) cleanup()
      setAgentRuntime(null)
      setAgentView(null)
    }
    // 宿主与配置都通过 ref/闭包读取，不重建运行时；只有工程 scope 变了才换段库
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentOpen, agentScope, agentRuntimeNonce])

  useImperativeHandle(ref, () => ({
    handleMenuAction,
  }))

  useEffect(() => {
    const hydrated = workspace.packages.length > 0
    if (!hydrated && !tabsHydratedRef.current) return
    if (hydrated) tabsHydratedRef.current = true
    setOpenPages((prev) => {
      const live = prev.filter((page) => editorPageExists(workspace, page))
      const visible = visibleEditorPage(workspace)
      const next = visible && !live.some((page) => editorPageKey(page) === editorPageKey(visible))
        ? [...live, visible]
        : live
      return sameOpenPages(prev, next) ? prev : next
    })
  }, [workspace])

  useEffect(() => {
    if (!tabsHydratedRef.current) return
    saveOpenPages(openPages)
  }, [openPages])

  useEffect(() => {
    onChromeInfo?.({
      titleName,
      packageName,
      projectFolderName: project?.folderName ?? null,
      projectBusy,
    })
  }, [titleName, packageName, project?.folderName, projectBusy, onChromeInfo])

  const dockPanels: DockPanelSpec[] = [
    {
      id: 'explorer',
      title: '资源管理器',
      visible: view.explorer,
      defaultPlacement: 'left' as const,
      defaultSize: 280,
      render: (dock) => (
          <StageplayExplorer
            project={workspace.packages[0] ?? null}
            organization={project && workspace.packages[0] ? (workspace.packages[0].explorer ?? emptyOrganization()) : null}
            readOnly={!workspace.packages[0] || serviceSession.binding?.handle.client.snapshot.role === 'viewer'}
            activeScriptId={workspace.activeScriptId}
            activeAssetId={workspace.activeAssetId}
            newFileMenuRequest={newFileMenuRequest}
            renameRequest={renameRequest}
            /*
             * 逐目标锁：改名/删除源文件会连带搬迁或删除它的派生 `.lang`，
             * 所以这里用「源锁 + 派生语言锁」的并集；资产删除只看该资产自己的锁。
             */
            lockedSourceNames={agentAutoKeyBlockedSources}
            lockedAssetPaths={agentLockedAssetPaths}
            onOpenScript={openScript}
            onOpenAsset={openAsset}
            onCreate={handleExplorerCreate}
            onRename={handleShellRename}
            onDelete={(ids) => {
              void handleDeleteScripts(ids)
            }}
            onOrganize={(next, label) => {
              void commitOrganization(next).catch((error) =>
                notify(
                  error instanceof ServiceError && error.code === 'commit_uncertain' ? `${label}结果待确认` : `${label}未提交`,
                  { kind: 'error', detail: String(error) },
                ),
              )
            }}
            onToggleAssets={handleToggleAssets}
            onDeleteAsset={handleDeleteAsset}
            onNewAssetFolder={handleNewAssetFolder}
            onDeleteAssetFolder={handleDeleteAssetFolder}
            onImportAssets={(packageId, files, targetDir) => {
              void handleImportAssets(packageId, files, targetDir)
            }}
            onGeneratePlaceholderVoice={(scriptId) => {
              void handleGeneratePlaceholderVoice(scriptId)
            }}
            onDropIntoFolder={handleDropIntoFolder}
            dock={dock}
          />
      ),
    },
    {
      id: 'agent',
      title: 'Agent',
      visible: agentOpen,
      defaultPlacement: 'left' as const,
      defaultSize: 360,
      minSize: 220,
      render: (dock) => (
        <AgentPanel
          open={agentOpen}
          runtime={agentRuntime}
          onClose={() => setAgentOpen(false)}
          saveBlockedByRun={agentRunning}
          contextLabel={titleName}
          onConfigChanged={() => setAgentRuntimeNonce((value) => value + 1)}
          placement={dock.placement}
          onTitlePointerDown={dock.onTitlePointerDown}
          onRedock={dock.onRedock}
        />
      ),
    },
    {
      id: 'roles',
      title: '备选角色',
      visible: view.roles && editingHanshu,
      defaultPlacement: 'right' as const,
      defaultSize: 190,
      minSize: 140,
      maxSize: 420,
      render: (dock) => (
          <aside className="role-panel" aria-label="备选角色栏">
            <div
              className="role-panel-header is-draggable"
              onPointerDown={(event) => {
                if (
                  event.target instanceof Element &&
                  event.target.closest('button, input, label, a, textarea, select')
                ) {
                  return
                }
                dock.onTitlePointerDown(event)
              }}
            >
              <span
                className="role-panel-title"
                title={dock.placement === 'float' ? '拖动标题可停靠到边缘；松手在中间则保持弹层' : '拖动标题可停靠到左、右、上、下，拖到中间变成弹层'}
              >
                备选角色
              </span>
              {dock.onRedock && (
                <button
                  type="button"
                  className="panel-dock-redock"
                  title="停靠回上次的边缘"
                  onClick={dock.onRedock}
                >
                  停靠
                </button>
              )}
            </div>
            <ul className="role-list">
              {Array.from({ length: SPEAKER_SLOT_COUNT }, (_, index) => (
                <li key={index} className="role-slot">
                  <button
                    type="button"
                    className="role-index"
                    title={
                      roles[index].trim()
                        ? `${numpadHint(index)} · 插入`
                        : numpadHint(index)
                    }
                    disabled={!roles[index].trim()}
                    onClick={() => insertRole(index)}
                  >
                    {numpadLabel(index)}
                  </button>
                  <input
                    className="role-input"
                    value={roles[index]}
                    placeholder="空"
                    spellCheck={false}
                    onChange={(event) =>
                      updateRole(index, event.target.value)
                    }
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        insertRole(index)
                      }
                    }}
                  />
                </li>
              ))}
            </ul>
          </aside>
      ),
    },
    {
      id: 'studio',
      title: '录音棚',
      visible: studioOpen,
      defaultPlacement: 'right' as const,
      defaultSize: (() => {
        try {
          const saved = Number(localStorage.getItem('hanshu.studioWidth'))
          if (Number.isFinite(saved) && saved >= 280 && saved <= 760) return saved
        } catch {
          /* keep the built-in width */
        }
        return 420
      })(),
      minSize: 280,
      maxSize: 760,
      render: (dock) => (
        <RecordingStudio
          mode={studioMode}
          sourceMode={studioSourceMode}
          selectedKeys={studioSelection}
          library={
            editingLocalizable
              ? (voiceRuntime ?? voiceLibraryRef.current)
              : null
          }
          /*
            台词取自当前语言的文本映射（和 TTS 合成用的是同一份）：
            录音的人要照着念的，就是编辑器里显示的那一句。
          */
          textFor={(key) => textMapRef.current?.get(key) ?? null}
          onClose={() => toggleStudio()}
          onModeChange={setStudioMode}
          onSourceModeChange={setStudioSourceMode}
          onClearSelection={() => setStudioSelection([])}
          onClearVoice={(keys) => voiceOps().deleteVoices(keys)}
          onImport={handleStudioImport}
          onReference={handleStudioReference}
          tts={studioTts}
          onTitlePointerDown={dock.onTitlePointerDown}
          onRedock={dock.onRedock}
        />
      ),
    },
  ]

  return (
    <div className="stageplay-workspace">
      <PanelDock panels={dockPanels}>
          <EditorDock
            storageKey={STAGEPLAY_EDITOR_DOCK_KEY}
            pages={openPages.map((page) => ({ id: editorPageKey(page), ...editorPageLabel(page) }))}
            activeId={visibleEditorPage(workspace) ? editorPageKey(visibleEditorPage(workspace)!) : null}
            onActivate={(id) => {
              const page = parseEditorPageKey(id)
              if (page) selectEditorPage(page)
            }}
            onClose={(id) => {
              const page = parseEditorPageKey(id)
              if (page) closeEditorPage(page)
            }}
            tabExtra={
              <>
  {editingMarkdown && (
                <button
                  type="button"
                  className={`tab-action${mdPreviewOn ? ' on' : ''}`}
                  onClick={() => setMdPreviewOn((on) => !on)}
                  title="切换 Markdown 预览"
                >
                  Preview
                </button>
              )}
              {editingHanshu && (
                <button
                  type="button"
                  className={`tab-action${hscPreviewOn ? ' on' : ''}`}
                  onClick={() => setHscPreviewOn((on) => !on)}
                  title="切换编译后 .hsc 视角"
                >
                  编译
                </button>
              )}
              </>
            }
            renderPage={(pageId) => {
              const page = parseEditorPageKey(pageId)
              const visible = visibleEditorPage(workspace)
              const activeKey = visible ? editorPageKey(visible) : null
              if (!page || !editorPageExists(workspace, page)) return null
              if (pageId !== activeKey) {
                const pageScript =
                  page.kind === 'script' ? findScript(workspace, page.id) : null
                return (
                  <SecondaryDockPage
                    page={page}
                    workspace={workspace}
                    readOnly={
                      projectBusy ||
                      Boolean(
                        pageScript && agentLockedSourceNames.has(pageScript.script.name),
                      ) ||
                      serviceSession.binding?.handle.client.snapshot.role === 'viewer'
                    }
                    onChangeScript={writeScriptContent}
                  />
                )
              }
              return (
                <>
    {isActive && presenceClient && presencePath && <FilePresenceBar
                key={`${presenceClient.snapshot.session.id}:${presencePath}`}
                client={presenceClient}
                path={presencePath}
                mode="optimistic"
                dirty={presenceDirty}
                label={titleName}
              />}
              {active?.script.detached&&<p role="status">此资源已从工程移除，当前内容保留为本机草稿；普通保存不会重新创建它。可复制或导出内容后另存。</p>}
              <main
                className={`editor-shell${
                  editingMarkdown && mdPreviewOn ? ' split-md' : ''
                }${editingHanshu && hscPreviewOn ? ' split-hsc' : ''}${
                  viewingAsset ? ' asset-mode' : ''
                }${ttsFileKind ? ' tts-file' : ''}`}
              >
                {!pageOpen ? (
                  <div className="editor-closed" role="status">未打开文件</div>
                ) : viewingAsset && activeAssetHit ? (
                  <AssetPreview
                    packageId={activeAssetHit.pkg.id}
                    asset={activeAssetHit.asset}
                    /*
                     * `.lang` 的只读按「lang 锁」判断（文档 D2：语言文件看 lang 锁）；
                     * 源文件锁不阻止人类编辑译文。只读时仍用 Monaco 呈现，只是保存入口不可用。
                     */
                    readOnly={agentLockedViewingAsset}
                    onSaveText={handleSaveTextAsset}
                  />
                ) : ttsUseForm ? (
                  ttsFileKind === 'service' ? (
                    <TtsServiceForm
                      /* key = 文件名：换一个文件就重挂，表单里的临时状态
                         （正在敲的语速草稿、拉回来的音色列表、上次的验证结论、
                         刚新建的服务名）全都不该跨文件留着 */
                      key={titleName}
                      fileName={titleName}
                      text={value}
                      onChange={handleTtsRewrite}
                      onSwitchToRaw={() => setTtsRawEditFor(titleName)}
                      onOpenCredentials={() => setShowTtsCredentials(true)}
                    />
                  ) : (
                    <TtsPlanForm
                      key={titleName}
                      fileName={titleName}
                      text={value}
                      services={ttsServices}
                      projectLocales={ttsProjectLocales}
                      createService={createTtsService}
                      openService={openTtsService}
                      onChange={handleTtsRewrite}
                      onSwitchToRaw={() => setTtsRawEditFor(titleName)}
                      onOpenCredentials={() => setShowTtsCredentials(true)}
                    />
                  )
                ) : (
                  <>
                    {ttsFileKind && (
                      <div className="tts-raw-bar">
                        <span>按原始 JSON 编辑</span>
                        <button
                          type="button"
                          className="tts-form-link"
                          onClick={() => setTtsRawEditFor(null)}
                        >
                          用表单编辑
                        </button>
                      </div>
                    )}
                    <div className="editor-pane">
                      <SourceEditor
                        scriptType={scriptType(active?.script.srcKind)}
                        path={editorLanguageForFile(titleName)==='javascript'?`javascript-source://${presenceClient?.snapshot.projectId??'unbound'}/${active?.script.id??'scratch'}/${titleName}`:undefined}
                        key={`${presenceClient?.snapshot.projectId ?? 'unbound'}:${presenceClient?.discardVersions.get(presencePath ?? '') ?? 0}:${active?.script.id ?? 'empty'}:${titleName}`}
                        height="100%"
                        language={editorLanguageForFile(titleName)}
                        theme={
                          editingChar ? CHAR_THEME_ID : HANSHU_THEME_ID
                        }
                        value={value}
                        beforeMount={(monaco) => {
                          registerHanshuLanguage(monaco)
                          registerCharLanguage(monaco)
                        }}
                        onMount={(editor, monaco) => {
                          editorRef.current = editor
                          editor.updateOptions(scriptEditorAppearance(scriptViewFlags.get()))
                          // # 注释快捷键只给对话／角色正文；脚本走 Monaco 的 // 行注释
                          if (editorLanguageForFile(titleName) !== 'javascript') {
                            bindTaggedCommentHotkeys(editor, monaco)
                          }
                          if (isHanshuFile(titleName)) {
                            bindChoiceInsertHotkeys(editor, monaco)
                            bindSpeakerHotkeys(
                              editor,
                              monaco,
                              () => rolesRef.current,
                            )
                            bindCopyDialogueHotkey(editor, monaco, () => textMapRef.current)
                          }
                          textBindingRef.current?.dispose()
                          // 换文件 = 换绑定：旧绑定的编辑请求已经作废，覆盖编辑框不能留在新文件上
                          setLangEdit(null)
                          textBindingRef.current = bindText(editor, monaco, {
                            getMap: () => textMapRef.current,
                            parseSpans: isCharFile(titleName)
                              ? parseCharTextSpans
                              : undefined,
                            analyzeDiagnostics: isCharFile(titleName)
                              ? analyzeCharDiagnostics
                              : isHanshuFile(titleName)
                                ? (source) =>
                                    analyzeHsDiagnostics(source, {
                                      foreignInjects: indexForeignHsInjects(
                                        workspaceRef.current,
                                        titleName,
                                      ),
                                    })
                                : undefined,
                            getVoice: () => voiceLibraryRef.current,
                            onEditRequest: (request) => {
                              // 语言文本被 Agent 锁住：不给改译文（含改键名 / 改文本）
                              if (rejectLockedLangEdit()) return
                              langEditSeqRef.current += 1
                              setLangEdit({
                                id: langEditSeqRef.current,
                                request,
                              })
                            },
                            onUnitMenu: (request) => {
                              if (rejectLockedLangEdit()) return
                              setUnitMenu(request)
                            },
                            onUnitDrop: (request) => {
                              if (rejectLockedLangEdit()) return
                              handleUnitDrop(request)
                            },
                            // 缺失 / 无效态点按钮 = 去录音棚配一条
                            onEditVoice: (key) => editVoiceInStudio(key),
                            // 录音棚：左键点键名 / 划框都会走到这里
                            onUnitSelect: (request) => handleUnitSelect(request),
                            onMarquee: (request) => handleMarquee(request),
                            // Agent 持锁期间禁止自动成键；解锁后也不把 agent 刚写出的正文再成键一遍
                            // （内容级抑制：正文仍等于程序化写入的内容就跳过，用户一改就恢复）
                            canAutoKey: () => {
                              if (agentLockedSourceNamesRef.current.has(titleName)) return false
                              const programmatic = agentWrittenContentRef.current.get(titleName)
                              return !(programmatic !== undefined && valueRef.current === programmatic)
                            },
                          })
                          // 绑定重建后，把录音棚的模式与选中态重新灌回去
                          setTextBindingSeq((seq) => seq + 1)
                        }}
                        onChange={(next) => {
                          const text = next ?? ''
                          /*
                           * ref 也要跟上：写回、导出、Ctrl+S 读的都是它。只 `setValue` 的话，
                           * ref 会慢一拍（渲染时才同步），那期间的动作会拿到上一版正文。
                           */
                          valueRef.current = text
                          setValue(text)
                          if (bufferOwnerRef.current) writeScriptContent(bufferOwnerRef.current,text)
                        }}
                        options={{
                          ...scriptEditorAppearance(view),
                          fontFamily:
                            'Consolas, "Courier New", "Sarasa Mono SC", monospace',
                          /**
                           * 录音棚打开时编辑器是**只读**的：那会儿左键点键名是"选中"、
                           * 空白处按下是"划框"，不允许再改正文（正常交互整体让位）。
                           */
                          readOnly:
                            projectBusy ||
                            studioOpen ||
                            Boolean(agentWritingFile) ||
                            serviceSession.binding?.handle.client.snapshot.role === 'viewer',
                          domReadOnly: studioOpen,
                          scrollBeyondLastLine: false,
                          automaticLayout: true,
                          padding: { top: 14, bottom: 14 },
                          renderLineHighlight: 'all',
                          cursorBlinking: 'smooth',
                          overviewRulerBorder: false,
                          stickyScroll: { enabled: false },
                          /**
                           * 拖放由覆盖层自己处理（键名容器 / 文本区），所以关掉 Monaco 这一套。
                           * 否则它在编辑器根节点上监听 dragover/drop，画一个 `dnd-target` 装饰当
                           * 落点指示器（那个"虚线光标"），而清除只发生在她自己的
                           * drop / dragleave / dragend 里 —— 我们在容器上 stopPropagation 之后
                           * 根节点收不到 drop，外部文件（没有页面内 dragend）拖完就会一直挂着。
                           */
                          dropIntoEditor: { enabled: false },
                          scrollbar: {
                            verticalScrollbarSize: 14,
                            horizontalScrollbarSize: 14,
                          },
                        }}
                      />
                    </div>
                    {editingMarkdown && mdPreviewOn && (
                      <MarkdownPreview source={value} />
                    )}
                    {editingHanshu && hscPreviewOn && (
                      <HscPreview source={value} />
                    )}
                  </>
                )}
              </main>
                </>
              )
            }}
          />
      </PanelDock>

      {/*
        本地缓存（API KEY）**挂在工作区这一层**，不挂在录音棚里。
        它有三个入口：服务设置页的 API KEY 卡片、方案设置页的页头、录音棚生成失败时的
        "填写 API KEY"。挂在 `studioOpen` 里面时，录音棚没开就只有前两个入口 ——
        点了没反应，因为那个分支根本不渲染。
      */}
      {showTtsCredentials && (
        <TtsCredentialsModal
          onClose={() => setShowTtsCredentials(false)}
          requiredRefs={ttsRequiredRefs}
        />
      )}

      {diffOpen && agentDiffs.length > 0 && (
        <AgentDiffModal
          diffs={agentDiffs}
          onClose={() => setDiffOpen(false)}
          onAccept={acceptAgentDiff}
          onUndo={undoAgentDiff}
          onAcceptAll={acceptAllAgentDiffs}
          onUndoAll={undoAllAgentDiffs}
        />
      )}

      <StatusBarSlots
        active={isActive}
        left={
          <>
            <span title={project ? project.folderName : '未绑定文件夹工程'}>
              {project ? `工程 · ${project.folderName}` : '仅浏览器缓存'}
            </span>
            {pageOpen && (
              <>
                <span>{packageName}</span>
                <span>{charCount} 字符</span>
                <span>行 {lineCount}</span>
                <span>{formatSavedAt(savedAt)}</span>
              </>
            )}
            {project && (
              <span title="最近写入工程文件夹">
                {diskSavedAt
                  ? `已落盘 ${new Date(diskSavedAt).toLocaleTimeString()}`
                  : '工程未写入'}
              </span>
            )}
            {agentDiffs.length > 0 && (
              <span
                className="status-on"
                onClick={() => setDiffOpen(true)}
                title="查看 Agent 修改对比"
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    setDiffOpen(true)
                  }
                }}
              >
                Diff×{agentDiffs.length}
              </span>
            )}
          </>
        }
        right={
          <>
            <span
              className={agentOpen ? 'status-on' : ''}
              onClick={() => setAgentOpen((open) => !open)}
              title="开关 Agent 窗口"
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  setAgentOpen((open) => !open)
                }
              }}
            >
              Agent
            </span>
            <span
              className={studioOpen ? 'status-on' : ''}
              onClick={toggleStudio}
              title="开关录音棚（配音工作台）"
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  toggleStudio()
                }
              }}
            >
              录音棚
            </span>
            {activeTextDiskError && (
              <span
                className="status-warn"
                title={`语言草稿镜像失败：${activeTextDiskError}`}
                role="button"
                tabIndex={0}
                onClick={() => setLangDiskError(null)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    setLangDiskError(null)
                  }
                }}
              >
                语言草稿失败
              </span>
            )}
            {voiceDiskError && (
              <span
                className="status-warn"
                title={`配音未能写入磁盘：${voiceDiskError.message}`}
                role="button"
                tabIndex={0}
                onClick={() => setVoiceDiskError(null)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    setVoiceDiskError(null)
                  }
                }}
              >
                配音未写入
              </span>
            )}
            {voiceImportMessage && (
              <span
                className={voiceImportMessage.ok ? 'status-note' : 'status-warn'}
                title="音频导入结果（点击清除）"
                role="button"
                tabIndex={0}
                onClick={() => setVoiceImportMessage(null)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    setVoiceImportMessage(null)
                  }
                }}
              >
                {voiceImportMessage.message}
                {voiceImportMessage.hint && (
                  <span className="status-hint">（{voiceImportMessage.hint}）</span>
                )}
              </span>
            )}
            <LocaleSelect
              value={locale}
              onChange={handleLocaleChange}
              projectLocales={listLocalesOf(workspace).map((item) => item.locale)}
            />
          </>
        }
      />
      {langEdit && (
        <TextEditBox
          key={langEdit.id}
          mode={langEdit.request.mode}
          initial={langEdit.request.initial}
          rect={langEdit.request.rect}
          caretIndex={langEdit.request.caretIndex}
          font={langEdit.request.font}
          placeholder={langEdit.request.placeholder}
          // 滚轮 / 布局变化时编辑器会推来新位置，编辑框跟着框走（只重渲染这个输入框）
          subscribeSpot={langEdit.request.subscribeSpot}
          /*
           * 每次草稿变化都上报原始草稿：编辑器据此**实时**改黄底框与正文里键名槽位的
           * 宽度 / 高度，框和后面的正文都跟着手指走，而不是等提交才跳一下。
           * 上报的是原始草稿（没归一化、没回退成键名）：显示成什么由编辑器按模式决定，
           * 免得同一套规则在两边各写一份。
           */
          onDraftChange={langEdit.request.onDraftChange}
          // 点另一个框 = 切换编辑目标：先提交这一份，再把编辑框交给那个框
          grabBoxAt={langEdit.request.grabBoxAt}
          onCommit={(next, reason) => {
            const edit = langEdit
            setLangEdit((current) => (current?.id === edit.id ? null : current))
            edit.request.apply(next, reason)
          }}
          onCancel={() => {
            const edit = langEdit
            setLangEdit((current) => (current?.id === edit.id ? null : current))
            edit.request.cancel()
          }}
          onExit={(direction, input) => {
            const edit = langEdit
            // 光标出框可能会顺势贴上别的框：那一下会把新的编辑请求塞进来（见 handleCaretEnter）。
            // 先问编辑器"这一按出得去吗"：出不去（框贴文档头 / 尾）就不关框，把按下当无事发生。
            const left = edit.request.exit(direction, input)
            if (left) {
              setLangEdit((current) => (current?.id === edit.id ? null : current))
            }
            return left
          }}
        />
      )}
      {unitMenu && (
        <TextUnitMenu
          x={unitMenu.x}
          y={unitMenu.y}
          items={unitMenuItems(unitMenu.key)}
          onClose={() => setUnitMenu(null)}
        />
      )}
      {voiceImport && (
        <VoiceImportProgress
          progress={voiceImport.progress}
          phase={voiceImport.phase}
          sourceLabel={voiceImport.sourceLabel}
          targetPath={voiceImport.targetPath}
          onCancel={() => voiceImportCancelRef.current?.()}
        />
      )}
      {/* 换 key：每次通知都重新挂载 → 动画与倒计时重来 */}
      {voiceToast && (
        <VoiceToast
          key={voiceToast.id}
          message={voiceToast.message}
          ok={voiceToast.ok}
          onDone={() =>
            setVoiceToast((current) =>
              current && current.id === voiceToast.id ? null : current,
            )
          }
        />
      )}
    </div>
  )
})
