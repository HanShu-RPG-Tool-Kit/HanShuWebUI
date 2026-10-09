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
import { Explorer } from '../Explorer'
import {
  CHAR_THEME_ID,
  registerCharLanguage,
} from '../monaco/charLanguage'
import { indexForeignHsInjects } from '../hanshu/injectIndex'
import { analyzeCharDiagnostics } from '../monaco/charDiagnostics'
import { analyzeHsDiagnostics } from '../monaco/hsDiagnostics'
import { parseCharTextSpans } from '../monaco/charTextSpans'
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
  createPackage,
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
  toggleAssetsCollapsed,
  updateScriptContent,
  ensureAssetFolder,
  isVoiceMapFile,
  type Workspace,
} from '../workspace'
import {
  consumeLegacyProgressWorkspace,
  setProjectSession,
  subscribeProjectSession,
  getProjectSession,
} from '../project/projectSession'
import {
  createBlankOggBlob,
  isVoiceRefPath,
  listMissingVoiceOggs,
  parseVoiceRefContent,
} from '../i18n/voiceMap'
import { createVoiceOps, type VoiceOps } from '../i18n/voiceOps'
import { voiceRootDir } from '../i18n/localeLayout'
import {
  buildResourcePackZip,
  bundlePacksZip,
  downloadBlob,
  exportPaks,
} from '../export/resourcePack'
import { buildProjectPackZip } from '../export/projectPack'
import { normalizeAssetPath, normalizeFolderPath } from '../assets/paths'
import {
  moveAssetToDir,
  moveScriptToPackage,
  renameScriptAssets,
} from '../workspaceMove'
import {
  deleteAssetBlob,
  deletePackageAssetBlobs,
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
  collectSourceKeys,
  deleteSourceAssets,
  langAssetPathFor,
  listLocalesOf,
  paginateSource,
  parseSourceText,
  readLangAsset,
  sourceKindOf,
  unparseSourceText,
  validateSourceContent,
  voiceStatusOf,
  writeLangAsset,
} from '../agent/agentOps'
import { MarkdownPreview } from '../MarkdownPreview'
import { HscPreview } from '../HscPreview'
import { AssetPreview } from '../AssetPreview'
import { AgentPanel } from '../AgentPanel'
import {
  AgentDiffModal,
  type AgentDiffSnapshot,
} from '../AgentDiffModal'
import { pushFileBackup, pushFileVersion } from '../agent/fileBackup'
import { HistoryModal } from '../HistoryModal'
import {
  type BoundProject,
  createProjectFromPicker,
  openProjectFromPicker,
  removeSourceFromDisk,
  renameSourceOnDisk,
  saveProjectAsToPicker,
  saveProjectToDirectory,
  setBoundProject,
  supportsDirectoryPicker,
  loadLastDirectoryHandle,
  tryRestoreLastProject,
} from '../project'

import type {
  ScriptChromeInfo,
  ScriptWorkspaceHandle,
} from './scriptTypes'
import { LocaleSelect } from '../LocaleSelect'
import { TextEditBox } from '../TextEditBox'
import {
  TextMap,
  TEXT_ASSET_MIME,
  stringifyTextFile,
  textAssetPath,
  type TextSink,
} from '../i18n/textMap'
import { createTextSink } from '../i18n/textSink'
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

type ScriptWorkspaceProps = {
  onChromeInfo?: (info: ScriptChromeInfo) => void
  isActive?: boolean
}

export const ScriptWorkspace = forwardRef<
  ScriptWorkspaceHandle,
  ScriptWorkspaceProps
>(function ScriptWorkspace({ onChromeInfo, isActive = true }, ref) {
  const [workspace, setWorkspace] = useState<Workspace>(() => emptyWorkspace())
  const [project, setProject] = useState<BoundProject | null>(null)
  const [projectBusy, setProjectBusy] = useState(false)
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
  const [agentOpen, setAgentOpen] = useState(true)
  const [agentDiffs, setAgentDiffs] = useState<AgentDiffSnapshot[]>([])
  const [diffOpen, setDiffOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [agentPercent, setAgentPercent] = useState(() => {
    const saved = Number(localStorage.getItem('hanshu.agentPercent'))
    return Number.isFinite(saved) && saved >= 25 && saved <= 70 ? saved : 45
  })
  const splitRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  /** 正在拖录音棚的右把手（存按下时的横向起点与宽度） */
  const studioDragRef = useRef<{ startX: number; startWidth: number } | null>(
    null,
  )
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
  const projectRef = useRef(project)
  rolesRef.current = roles
  valueRef.current = value
  workspaceRef.current = workspace
  activeIdRef.current = workspace.activeScriptId
  projectRef.current = project

  const lineCount = value.split('\n').length
  const charCount = value.length
  const viewingAsset = Boolean(activeAssetHit)
  const titleName = viewingAsset
    ? activeAssetHit!.asset.path
    : (active?.script.name ?? '未命名剧本.hs')
  const packageName = viewingAsset
    ? activeAssetHit!.pkg.name
    : (active?.pkg.name ?? '汉书')
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

  // 进度工作区改源文件 / 落盘时，把会话拉回本工作区
  useEffect(() => {
    return subscribeProjectSession(() => {
      const remote = getProjectSession()
      if (remote.binding?.manifest.id !== projectRef.current?.manifest.id) return
      if (remote.workspace !== workspaceRef.current) {
        workspaceRef.current = remote.workspace
        setWorkspace(remote.workspace)
      }
      if (remote.binding && remote.binding !== projectRef.current) {
        projectRef.current = remote.binding
        setProject(remote.binding)
      }
    })
  }, [])

  /**
   * 内容写回的**唯一**原语：正文 + 它属于哪一份文件。
   *
   * `updateScriptContent(ws, id, text)` 本身是安全的，出事的永远是"调用方拿错了 id"：
   * 早先只有 `persistActiveContent(text)` 一个入口，目标靠 `activeIdRef.current` 现取 ——
   * 只要有一处"换了活动文件、没换编辑器正文"，A 的正文就会落进 B。
   * 所以这里要求调用方**明确指出**是哪一份，然后再由 `persistActiveContent` 去核对归属。
   */
  const writeScriptContent = (scriptId: string, text: string): boolean => {
    if (!findScript(workspaceRef.current, scriptId)) return false
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

  /**
   * 把编辑器里那份正文并回**它属于的**那一份文件（换文件、导出、写盘前都先做这一步）。
   *
   * 用归属而不是用 `activeScriptId`：这两个值本来相等，不相等时该听的是正文的归属 ——
   * 按活动文件写就是把上一条正文盖到新文件上。
   */
  const flushEditorInto = (base: Workspace): Workspace => {
    const id = bufferOwnerRef.current
    if (!id || !findScript(base, id)) return base
    return updateScriptContent(base, id, valueRef.current)
  }

  const [locale, setLocale] = useState(loadLocale)
  const [langEdit, setLangEdit] = useState<{
    id: number
    request: TextEditRequest
  } | null>(null)
  /**
   * 语言文本写盘失败：连同它属于哪个「文件 + 语言」一起记下来。
   * 渲染时只认当前写入周期 —— 既避免切换语言/文件后还挂着旧提示，
   * 也避免在 effect 里同步 setState。
   */
  const [textDiskError, setLangDiskError] = useState<{
    key: string
    message: string
  } | null>(null)
  /** 配音未能写入磁盘（绑定了工程才会发生）；只提示，IndexedDB 里的内容仍权威 */
  const [voiceDiskError, setVoiceDiskError] = useState<{
    path: string
    message: string
  } | null>(null)
  const textMapRef = useRef<TextMap | null>(null)
  /** 当前语言文本资产的原始内容（TextSink.read 是同步接口，所以要用缓存兜住） */
  const textCacheRef = useRef<string | null>(null)
  const textBindingRef = useRef<TextBinding | null>(null)
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

  // —— 录音棚（右侧可调宽面板，与 Agent 窗口一样从底部栏唤出）——
  const [studioOpen, setStudioOpen] = useState(false)
  const [studioWidth, setStudioWidth] = useState(() => {
    const saved = Number(localStorage.getItem('hanshu.studioWidth'))
    return Number.isFinite(saved) && saved >= 280 && saved <= 760 ? saved : 420
  })
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
  const [pendingProjectRestore, setPendingProjectRestore] = useState(false)
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
    const { pkg, asset } = hit
    const mime = asset.mime || TEXT_ASSET_MIME
    const blob = new Blob([content], { type: mime })
    await putAssetBlob(pkg.id, asset.path, blob)
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

  // 语言文本映射实例：活动源文件 + 当前语言标签 → `assets/<语言标签>/lang_<后缀>/…`
  // 绑定文件夹工程时读写真实磁盘文件，否则退回包内虚拟文件（见 textSink）。
  useEffect(() => {
    if (!textSourceName) {
      textMapRef.current = null
      textBindingRef.current?.refresh()
      return
    }

    const fileName = textAssetPath(locale, textSourceName)
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

    const virtualSink: TextSink = {
      read: () => textCacheRef.current,
      write: (content: string) => {
        const base = workspaceRef.current
        const id = base.activeScriptId
        if (!id) return
        textCacheRef.current = content
        // 先把编辑器里的当前正文并回**它属于的**那一份，避免覆盖未保存的输入
        const merged = flushEditorInto(base)
        const hit = findScript(merged, id)
        if (!hit) return
        const blob = new Blob([content], { type: TEXT_ASSET_MIME })
        void putAssetBlob(hit.pkg.id, fileName, blob).then(() => {
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
      textCacheRef.current = await loadTextAsset()
      const sink = await createTextSink({
        project: projectRef.current,
        fileName,
        virtual: virtualSink,
        // 只在磁盘写结束后异步触发。oxlint 的 react(set-state-in-effect) 按词法
        // 判定，仍会就此报一条告警（规则过度近似：此处不会引发级联渲染）。
        onWriteResult: (error) => {
          if (!error) {
            setLangDiskError(null)
            return
          }
          console.warn('[hanshu] 语言文本写入磁盘失败', error)
          setLangDiskError({
            key: textWriteKey,
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
  }, [textSourceName, textWriteKey, locale, projectHandle])

  // 工具卸载时解绑编辑器
  useEffect(() => () => textBindingRef.current?.dispose(), [])

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
  }, [textSourceName, locale, projectHandle])

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

  /**
   * 资产读写适配器（照 `.lang` 的 sink 思路）：
   * - **IndexedDB + 工作区模型**：`put` 是事务原子的，直接覆盖，不需要临时文件；
   * - **绑定工程时再磁盘写穿**：`voiceDiskSink` 内部走 `.new` → 删旧 → 改名
   *   （同卷改名原子，防的是磁盘写被中断留下截断文件）。
   * 磁盘失败只提示不回滚：IndexedDB 是权威，且「保存工程」还会整树重写磁盘。
   */
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
        await putAssetBlob(packageId, path, blob)
        onProgress?.(0.4)

        const result = registerAsset(
          workspaceRef.current,
          packageId,
          path,
          mime,
          blob.size,
        )
        if (result) commitWorkspace(result.workspace)
        onProgress?.(0.6)

        const sink = createVoiceDiskSink(projectRef.current?.handle ?? null)
        if (!sink.enabled) {
          onProgress?.(1)
          return
        }
        try {
          await sink.write(path, bytes, mime, (ratio) =>
            onProgress?.(0.6 + 0.4 * Math.max(0, Math.min(1, ratio))),
          )
          setVoiceDiskError(null)
        } catch (error) {
          console.warn('[hanshu] 配音写入磁盘失败', path, error)
          setVoiceDiskError({
            path,
            message: error instanceof Error ? error.message : String(error),
          })
        }
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
          // 落成了 `.ogg`：把同基名的 `.ref` 清掉 —— 一个键只该有一个来源
          // （否则解析按 `.ogg` 优先，用户会以为刚写的引用还在生效）
          voiceOps().clearPeerBindingOf(keys[index], 'file')
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

    void (async () => {
      const blob = await getAssetBlob(result.fromPackageId, result.fromPath)
      if (!blob) return
      await putAssetBlob(result.toPackageId, result.toPath, blob)
      await deleteAssetBlob(result.fromPackageId, result.fromPath)
      commitWorkspace(result.workspace)
    })()
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
  const createTtsService = (): string | null => {
    const raw = window.prompt('新服务的名字（也就是文件名，只用字母、数字、- 和 _）', 'my-service')
    if (raw === null) return null
    const id = raw.trim()
    if (!isValidServiceId(id)) {
      window.alert('这个名字不行 —— 只用字母、数字、- 和 _，且不能为空')
      return null
    }

    // 新建**不切**文件，但当前那份的正文要先并回去：否则这一段写回要等自动记忆的定时器
    const current = flushEditorInto(workspaceRef.current)
    const fileName = serviceFileName(id)
    if (findScriptByName(current, fileName)) {
      window.alert(`「${fileName}」已经存在`)
      return null
    }
    const pkg = findScript(current, current.activeScriptId)?.pkg ?? current.packages[0]
    if (!pkg) return null

    // 建成**能通过结构校验**的样子 —— 空壳会在方案的服务下拉里都出不来，
    // 而那正是新建之后最需要看到它的地方
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
  const createTtsPlan = (): string | null => {
    // 同 `createTtsService`：不切文件，但先把当前那份的正文并回去
    const current = flushEditorInto(workspaceRef.current)
    const taken = new Set(
      current.packages
        .flatMap((pkg) => pkg.scripts)
        .map((script) => script.name.toLowerCase()),
    )
    // 默认名：剧本里第一个还没有方案的说话人
    const suggested =
      rolesRef.current
        .map((role) => role.trim())
        .find((role) => role && !taken.has(planFileName(role).toLowerCase())) ?? ''

    const raw = window.prompt('新配音方案的说话人名（文件名就是说话人的名字）', suggested)
    if (raw === null) return null
    const character = raw.trim()
    if (!isValidServiceId(character)) {
      window.alert('这个名字不行 —— 不能为空，也不能含 \\ / : * ? " < > |')
      return null
    }

    const fileName = planFileName(character)
    if (findScriptByName(current, fileName)) {
      window.alert(`「${fileName}」已经存在`)
      return null
    }
    const pkg = findScript(current, current.activeScriptId)?.pkg ?? current.packages[0]
    if (!pkg) return null

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
    setStudioOpen((open) => {
      if (open) {
        // 关掉时顺手清空选中：下次打开不该还挂着上次的键
        setStudioSelection([])
        setStudioMode('single')
      }
      return !open
    })
  }

  // 录音棚开关 → 编辑器进入 / 退出"键名选择"模式（常规交互被禁用）
  useEffect(() => {
    textBindingRef.current?.setStudioMode(studioOpen)
  }, [studioOpen, textBindingSeq])

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
    const next = consumeLegacyProgressWorkspace(loaded)
    projectRef.current = binding
    setProject(binding)
    setPendingProjectRestore(false)
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

  const isProjectCancel = (err: unknown) =>
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && /取消/.test(err.message))

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
    const text = valueRef.current
    // 落点用正文的归属：Ctrl+S 保存的是"你正在看的那份"，它属于谁就写给谁
    const id = bufferOwnerRef.current ?? activeIdRef.current
    if (!id) return
    const name = findScript(workspaceRef.current, id)?.script.name ?? ''
    if (isHanshuFile(name)) syncRolesFromText(text)

    // 手动保存前记一版历史（.hs 尤其重要）
    if (name) {
      pushFileVersion(name, text, 'manual-save', { force: true })
    }

    let next = updateScriptContent(workspaceRef.current, id, text)

    commitWorkspace(next)
    setSavedAt(Date.now())

    if (projectRef.current) {
      void flushProjectToDisk().catch((err) => {
        window.alert(
          `写入工程文件夹失败：${err instanceof Error ? err.message : String(err)}`,
        )
      })
    }
  }

  const handleOpenProject = async () => {
    if (!supportsDirectoryPicker()) {
      window.alert(
        '当前浏览器不支持文件夹 API。\n请用 Chrome / Edge 打开本开发页（localhost）。',
      )
      return
    }
    setProjectBusy(true)
    try {
      const result = await openProjectFromPicker()
      applyLoadedProject(result)
    } catch (err) {
      if (!isProjectCancel(err)) {
        window.alert(
          `打开工程失败：${err instanceof Error ? err.message : String(err)}`,
        )
      }
    } finally {
      setProjectBusy(false)
    }
  }

  const handleCreateProject = async () => {
    if (!supportsDirectoryPicker()) {
      window.alert(
        '当前浏览器不支持文件夹 API。\n请用 Chrome / Edge 打开本开发页（localhost）。',
      )
      return
    }
    setProjectBusy(true)
    try {
      const result = await createProjectFromPicker()
      applyLoadedProject(result)
    } catch (err) {
      if (!isProjectCancel(err)) {
        window.alert(
          `新建工程失败：${err instanceof Error ? err.message : String(err)}`,
        )
      }
    } finally {
      setProjectBusy(false)
    }
  }

  const handleSaveProjectAs = async () => {
    if (!supportsDirectoryPicker()) {
      window.alert(
        '当前浏览器不支持文件夹 API。\n请用 Chrome / Edge 打开本开发页（localhost）。',
      )
      return
    }
    // 先落本地缓存，再写盘 —— 并回编辑器正文**属于的**那一份
    if (bufferOwnerRef.current) {
      commitWorkspace(flushEditorInto(workspaceRef.current))
      setSavedAt(nowStamp())
    }
    setProjectBusy(true)
    try {
      const preferred =
        projectRef.current?.manifest.id ??
        workspaceRef.current.packages[0]?.id ??
        null
      const result = await saveProjectAsToPicker(
        workspaceRef.current,
        preferred,
      )
      applyLoadedProject(result)
    } catch (err) {
      if (!isProjectCancel(err)) {
        window.alert(
          `另存为失败：${err instanceof Error ? err.message : String(err)}`,
        )
      }
    } finally {
      setProjectBusy(false)
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

  const handleNewPackage = () => {
    const name = window.prompt('新包名称', '新包')
    if (!name?.trim()) return
    const pkg = createPackage(name.trim())
    commitWorkspace({
      ...workspaceRef.current,
      packages: [...workspaceRef.current.packages, pkg],
    })
  }

  const handleNewScript = (packageId: string) => {
    const name = window.prompt(
      `文件名（后缀须为 ${MANUAL_FILE_EXTENSIONS_LABEL}）`,
      '新剧本.hs',
    )
    if (name == null) return
    const normalized = normalizeResourceName(name)
    // `.lang` / `.voice` 的名字由剧本名派生（改名剧本时会一起搬），不手工新建
    if (!normalized || !isManualFileName(normalized)) {
      window.alert(`文件名无效。新建允许的后缀：${MANUAL_FILE_EXTENSIONS_LABEL}`)
      return
    }
    const script = createScript(normalized, '')
    const nextPackages = flushEditorInto(workspaceRef.current).packages.map((pkg) =>
      pkg.id === packageId
        ? { ...pkg, collapsed: false, scripts: [...pkg.scripts, script] }
        : pkg,
    )
    const next: Workspace = {
      packages: nextPackages,
      activeScriptId: script.id,
      activeAssetId: null,
    }
    commitWorkspace(next)
    loadEditorContent(script.id, '', script.updatedAt)
    setRoles(createDefaultRoles())
  }

  const handleTogglePackage = (packageId: string) => {
    commitWorkspace({
      ...workspaceRef.current,
      packages: workspaceRef.current.packages.map((pkg) =>
        pkg.id === packageId ? { ...pkg, collapsed: !pkg.collapsed } : pkg,
      ),
    })
  }

  const handleToggleAssets = (packageId: string) => {
    commitWorkspace(toggleAssetsCollapsed(workspaceRef.current, packageId))
  }

  const handleRenamePackage = (packageId: string) => {
    const pkg = workspaceRef.current.packages.find((item) => item.id === packageId)
    if (!pkg) return
    const name = window.prompt('重命名包', pkg.name)
    if (!name?.trim() || name.trim() === pkg.name) return
    commitWorkspace({
      ...workspaceRef.current,
      packages: workspaceRef.current.packages.map((item) =>
        item.id === packageId ? { ...item, name: name.trim() } : item,
      ),
    })
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
    if (newName === hit.script.name) return { ok: true, moves: 0 }
    const oldName = hit.script.name

    // 连带改名：每种语言的文本资产与音频目录都跟着走（见 renameScriptAssets）
    const renamed = renameScriptAssets(workspaceRef.current, scriptId, newName)
    if (renamed.kind === 'blocked') {
      return { ok: false, error: `${renamed.path} 已存在` }
    }

    // 先搬 blob 再提交模型：否则语言文本映射会先按新路径去读，读到空文件
    const assetMoves = renamed.kind === 'moved' ? renamed.moves : []
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
    commitWorkspace(nextWorkspace)

    const bound = projectRef.current
    if (bound) {
      try {
        const content =
          findScript(nextWorkspace, scriptId)?.script.content ?? hit.script.content
        await renameSourceOnDisk(
          bound.handle,
          oldName,
          newName,
          content,
          assetMoves,
        )
      } catch (error) {
        return {
          ok: false,
          error: `工作区已改名，但写入工程目录失败：${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }

    return {
      ok: true,
      moves: assetMoves.length,
    }
  }

  const handleRenameScript = async (scriptId: string) => {
    const hit = findScript(workspaceRef.current, scriptId)
    if (!hit) return
    const name = window.prompt(
      `重命名（后缀须为 ${MANUAL_FILE_EXTENSIONS_LABEL}）`,
      hit.script.name,
    )
    if (name == null) return
    const normalized = normalizeResourceName(name)
    // `.lang` / `.voice` 的名字由剧本名派生，不接受单独改名
    if (!normalized || !isManualFileName(normalized)) {
      window.alert(
        `文件名无效。改名允许的后缀：${MANUAL_FILE_EXTENSIONS_LABEL}`,
      )
      return
    }
    if (normalized === hit.script.name) return

    const result = await applyScriptRename(scriptId, normalized)
    if (!result.ok) window.alert(`改名未执行：${result.error}`)
  }

  const handleDeletePackage = (packageId: string) => {
    const pkg = workspaceRef.current.packages.find((item) => item.id === packageId)
    if (!pkg) return
    if (workspaceRef.current.packages.length <= 1) {
      window.alert('至少保留一个包')
      return
    }
    if (
      !window.confirm(`删除包「${pkg.name}」及其全部剧本与 assets？`)
    ) {
      return
    }

    const wasActiveScript = pkg.scripts.some(
      (script) => script.id === activeIdRef.current,
    )
    const wasActiveAsset = pkg.assets.some(
      (asset) => asset.id === workspaceRef.current.activeAssetId,
    )
    const remaining = workspaceRef.current.packages.filter(
      (item) => item.id !== packageId,
    )
    const next: Workspace = {
      packages: remaining,
      activeScriptId: wasActiveScript
        ? (remaining[0]?.scripts[0]?.id ?? null)
        : workspaceRef.current.activeScriptId,
      activeAssetId: wasActiveAsset
        ? null
        : workspaceRef.current.activeAssetId,
    }
    commitWorkspace(next)
    void deletePackageAssetBlobs(packageId)

    if (wasActiveScript || wasActiveAsset) {
      const hit = findScript(next, next.activeScriptId)
      loadEditorContent(hit?.script.id ?? null, hit?.script.content ?? '', hit?.script.updatedAt ?? null)
      setRoles(createDefaultRoles())
    }
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
      const fallback =
        nextPackages.flatMap((pkg) => pkg.scripts).find(Boolean) ?? null
      activeScriptId = fallback?.id ?? null
    }
    const next: Workspace = {
      packages: nextPackages,
      activeScriptId,
      activeAssetId: cleaned.workspace.activeAssetId,
    }
    commitWorkspace(next)

    const bound = projectRef.current
    if (bound) {
      try {
        await removeSourceFromDisk(bound.handle, sourceName)
      } catch (error) {
        window.alert(
          `已从工作区删除，但清理工程目录失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }
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
  }

  const handleDeleteScript = async (scriptId: string) => {
    const hit = findScript(workspaceRef.current, scriptId)
    if (!hit) return
    if (
      !window.confirm(`删除剧本「${hit.script.name}」及其各语言的译文 / 配音？`)
    ) {
      return
    }
    await deleteScriptWithAssets(scriptId)
  }

  const handleDeleteAsset = (assetId: string) => {
    const hit = findAsset(workspaceRef.current, assetId)
    if (!hit) return
    if (!window.confirm(`删除资产「${hit.asset.path}」？`)) return
    commitWorkspace(removeAssetMeta(workspaceRef.current, assetId))
    // 磁盘那一份也要删：只删应用内的话，重开工程会被读回来
    voiceOps().removeAssetEverywhere(hit.pkg.id, [hit.asset.path])
  }

  const handleNewAssetFolder = (packageId: string, parentPath: string) => {
    const name = window.prompt('新建文件夹名称', 'voice')
    if (!name?.trim()) return
    if (/[\\/:*?"<>|]/.test(name.trim())) {
      window.alert('文件夹名不能包含 \\ / : * ? " < > |')
      return
    }
    const folder = normalizeFolderPath(`${parentPath}/${name.trim()}`)
    if (!folder || folder === 'assets') {
      window.alert('文件夹路径无效')
      return
    }
    commitWorkspace(ensureAssetFolder(workspaceRef.current, packageId, folder))
  }

  const handleDeleteAssetFolder = (packageId: string, folderPath: string) => {
    if (folderPath === 'assets') return
    if (
      !window.confirm(
        `删除文件夹「${folderPath}」及其下全部资产？`,
      )
    ) {
      return
    }
    const { workspace: next, removed } = removeAssetFolder(
      workspaceRef.current,
      packageId,
      folderPath,
    )
    commitWorkspace(next)
    // 整个文件夹的磁盘副本一起删（同上：不删就会在下次打开工程时整批复活）
    voiceOps().removeAssetEverywhere(
      packageId,
      removed.map((asset) => asset.path),
    )
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

    if (failed.length > 0) {
      window.alert(`部分文件导入失败：\n${failed.join('\n')}`)
    }
  }

  const handleGeneratePlaceholderVoice = async (scriptId: string) => {
    const hit = findScript(workspaceRef.current, scriptId)
    if (!hit || !isVoiceMapFile(hit.script.name)) {
      window.alert('请选择 .voice 文件')
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
      window.alert('没有缺失的 ogg（或尚无有效 id）')
      return
    }

    if (
      !window.confirm(
        `将在 ${voiceRootDir(locale)}/ 生成 ${missing.length} 个空白 ogg，是否继续？`,
      )
    ) {
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
    window.alert(
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

  // .hs 自动历史快照（防抖，与手动/Agent 备份互补）
  useEffect(() => {
    if (workspace.activeAssetId) return
    const name =
      findScript(workspace, workspace.activeScriptId)?.script.name ?? ''
    if (!isHanshuFile(name) || !value) return
    const timer = window.setTimeout(() => {
      pushFileVersion(name, value, 'auto-hs')
    }, 12000)
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

  // 尝试恢复上次授权的工程文件夹（Chrome 会再弹一次权限）
  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!supportsDirectoryPicker()) return
      try {
        const result = await tryRestoreLastProject()
        if (cancelled) return
        if (result) {
          applyLoadedProject(result)
          return
        }
        // 恢复不了：句柄还在的话，多半是权限没授（冷启动没有用户手势，
        // requestPermission 会被静默拒绝）→ 给出可点的一键恢复入口
        const handle = await loadLastDirectoryHandle()
        if (!cancelled && handle) setPendingProjectRestore(true)
      } catch {
        // 忽略：无句柄或用户拒绝权限
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /** 用户点「上次工程待授权」：这时有手势，权限框能正常弹出 */
  const handleRestoreProject = () => {
    if (projectBusy) return
    setProjectBusy(true)
    void (async () => {
      try {
        const result = await tryRestoreLastProject()
        if (result) applyLoadedProject(result)
        else setPendingProjectRestore(false)
      } catch (error) {
        window.alert(
          `恢复上次工程失败：${error instanceof Error ? error.message : String(error)}`,
        )
        setPendingProjectRestore(false)
      } finally {
        setProjectBusy(false)
      }
    })()
  }

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      // 录音棚右把手：从"按下时的宽度"倒推，不依赖容器矩形
      const studio = studioDragRef.current
      if (studio) {
        const next = Math.min(
          760,
          Math.max(280, studio.startWidth + (studio.startX - event.clientX)),
        )
        setStudioWidth(next)
        return
      }
      if (!draggingRef.current || !splitRef.current) return
      const rect = splitRef.current.getBoundingClientRect()
      if (rect.width <= 0) return
      const raw = ((event.clientX - rect.left) / rect.width) * 100
      const next = Math.min(70, Math.max(25, raw))
      setAgentPercent(next)
    }
    const onUp = () => {
      if (studioDragRef.current) {
        studioDragRef.current = null
        document.body.classList.remove('is-resizing')
        setStudioWidth((current) => {
          localStorage.setItem('hanshu.studioWidth', String(Math.round(current)))
          return current
        })
        return
      }
      if (!draggingRef.current) return
      draggingRef.current = false
      document.body.classList.remove('is-resizing')
      setAgentPercent((current) => {
        localStorage.setItem('hanshu.agentPercent', String(Math.round(current)))
        return current
      })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [])

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
    if (item === '打开工程…') {
      void handleOpenProject()
      return
    }
    if (item === '新建工程…') {
      void handleCreateProject()
      return
    }
    if (item === '另存为工程…') {
      void handleSaveProjectAs()
      return
    }
    if (item === '保存') {
      persistNow()
      return
    }
    if (item === '历史版本') {
      setHistoryOpen(true)
      return
    }
    if (item === '导出PAK') {
      void handleExportResourcePack()
      return
    }
    if (item === '导出PAK（分平面）') {
      void handleExportResourcePackPlanes()
      return
    }
    if (item === '导出工程包') {
      void handleExportProjectPack()
      return
    }
    if (item === '新建包') {
      window.alert('请使用「新建工程…」创建本地工程文件夹；不再支持仅存在于浏览器缓存的包。')
      return
    }
    if (item === '新建剧本') {
      const pkgId =
        active?.pkg.id ?? workspaceRef.current.packages[0]?.id ?? null
      if (pkgId) handleNewScript(pkgId)
      return
    }
    if (item === 'Agent 窗口') {
      setAgentOpen((open) => !open)
      return
    }
    if (item === '录音棚') {
      toggleStudio()
      return
    }
  }

  const handleRestoreHistory = (fileName: string, content: string) => {
    // 恢复前再拍一版当前内容
    const currentName =
      findScript(workspaceRef.current, activeIdRef.current)?.script.name ?? ''
    if (currentName) {
      pushFileVersion(currentName, valueRef.current, 'restore-point', {
        force: true,
      })
    }

    const hit = findScriptByName(workspaceRef.current, fileName)
    if (!hit) {
      // 文件已删：在当前包重建
      const pkgId =
        findScript(workspaceRef.current, activeIdRef.current)?.pkg.id ??
        workspaceRef.current.packages[0]?.id
      if (!pkgId) {
        window.alert('没有可用的包，无法恢复')
        return
      }
      let base = flushEditorInto(workspaceRef.current)
      const script = createScript(fileName, content)
      const nextPackages = base.packages.map((pkg) =>
        pkg.id === pkgId
          ? { ...pkg, collapsed: false, scripts: [...pkg.scripts, script] }
          : pkg,
      )
      commitWorkspace({
        packages: nextPackages,
        activeScriptId: script.id,
        activeAssetId: null,
      })
      loadEditorContent(script.id, content)
      setHistoryOpen(false)
      return
    }

    pushFileVersion(fileName, hit.script.content, 'restore-point', {
      force: true,
    })
    const next = updateScriptContent(
      flushEditorInto(workspaceRef.current),
      hit.script.id,
      content,
    )
    commitWorkspace({
      ...next,
      activeScriptId: hit.script.id,
      activeAssetId: null,
    })
    loadEditorContent(hit.script.id, content)
    setHistoryOpen(false)
  }

  /** 导出 PAK：combined（兼容）；走编译图 */
  const handleExportResourcePack = async () => {
    persistNow()
    try {
      const { blob, fileCount, warnings } = await buildResourcePackZip(
        workspaceRef.current,
      )
      const stamp = new Date()
        .toISOString()
        .slice(0, 19)
        .replace(/[:T]/g, '-')
      downloadBlob(blob, `hanshu-${stamp}.pak`)

      if (warnings.length > 0) {
        const shown = warnings.slice(0, 20).join('\n')
        const more =
          warnings.length > 20 ? `\n…另有 ${warnings.length - 20} 条` : ''
        window.alert(
          `已导出 PAK（${fileCount} 个文件），但有警告：\n\n${shown}${more}`,
        )
      }
    } catch (err) {
      window.alert(
        `导出 PAK 失败：${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /** 导出 client / server / shared 三个 pak；可选用口令加密 server */
  const handleExportResourcePackPlanes = async () => {
    persistNow()
    try {
      const passphrase =
        window.prompt(
          '服务端 PAK 加密口令（留空则不加密；口令不会写入工程）',
          '',
        ) ?? ''
      const { packs, warnings } = await exportPaks(workspaceRef.current, {
        targets: ['client', 'server', 'shared'],
        encrypt: passphrase
          ? { targets: ['server'], passphrase }
          : undefined,
      })
      const stamp = new Date()
        .toISOString()
        .slice(0, 19)
        .replace(/[:T]/g, '-')
      const bundle = await bundlePacksZip(packs)
      downloadBlob(bundle, `hanshu-paks-${stamp}.zip`)

      const summary = packs
        .map(
          (p) =>
            `${p.target}: ${p.fileCount} 文件${p.encrypted ? '（已加密）' : ''}`,
        )
        .join('\n')
      if (warnings.length > 0) {
        const shown = warnings.slice(0, 20).join('\n')
        const more =
          warnings.length > 20 ? `\n…另有 ${warnings.length - 20} 条` : ''
        window.alert(
          `已导出分平面 PAK：\n${summary}\n\n警告：\n${shown}${more}`,
        )
      } else {
        window.alert(`已导出分平面 PAK：\n${summary}`)
      }
    } catch (err) {
      window.alert(
        `导出分平面 PAK 失败：${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  /** 导出工程包：原样完整打包（脚本正文 + assets 二进制） */
  const handleExportProjectPack = async () => {
    persistNow()
    try {
      const { blob, fileCount, warnings } = await buildProjectPackZip(
        workspaceRef.current,
      )
      const stamp = new Date()
        .toISOString()
        .slice(0, 19)
        .replace(/[:T]/g, '-')
      downloadBlob(blob, `hanshu-project-${stamp}.zip`)

      if (warnings.length > 0) {
        const shown = warnings.slice(0, 20).join('\n')
        const more =
          warnings.length > 20 ? `\n…另有 ${warnings.length - 20} 条` : ''
        window.alert(
          `已导出工程包（${fileCount} 个文件），但有警告：\n\n${shown}${more}`,
        )
      } else if (fileCount === 0) {
        window.alert('工程包为空（没有可导出的文件）')
      }
    } catch (err) {
      window.alert(
        `导出工程包失败：${err instanceof Error ? err.message : String(err)}`,
      )
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
      const fallback =
        nextPackages.flatMap((pkg) => pkg.scripts).find(Boolean) ?? null
      activeScriptId = fallback?.id ?? null
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

  const undoAgentDiff = (index: number) => {
    const snap = agentDiffs[index]
    if (!snap) return

    const current = currentContentOf(snap.fileName)
    if (
      current != null &&
      current !== snap.after &&
      current !== snap.before &&
      !window.confirm(
        `「${snap.fileName}」在 Agent 写入后又有改动，仍要撤销到修改前？`,
      )
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

  const undoAllAgentDiffs = () => {
    if (agentDiffs.length === 0) return
    if (
      !window.confirm(`撤销全部 ${agentDiffs.length} 处 Agent 修改？`)
    ) {
      return
    }
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

  const getEditorSelection = () => {
    const ed = editorRef.current
    const model = ed?.getModel()
    const sel = ed?.getSelection()
    if (!ed || !model || !sel || sel.isEmpty()) return ''
    return model.getValueInRange(sel)
  }

  /** Agent 写入已有文件：留历史、并回编辑器、记 diff */
  const applyAgentFileWrite = (
    scriptId: string,
    content: string,
    tool: string,
  ): { file: string } | null => {
    const hit = findScript(workspaceRef.current, scriptId)
    if (!hit) return null
    // "编辑器里这份正文就是它" —— 判据是正文归属
    const inEditor = hit.script.id === bufferOwnerRef.current
    const before = inEditor ? valueRef.current : hit.script.content
    pushFileBackup(hit.script.name, before, tool)
    commitWorkspace(updateScriptContent(workspaceRef.current, scriptId, content))
    if (inEditor) {
      loadEditorContent(scriptId, content)
    }
    pushAgentDiff({ fileName: hit.script.name, before, after: content })
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

  /** 语言工具的目标：源文件 + 语言 → 所属包、资产路径与当前译文表 */
  const langTargetOf = async (sourceName: string, localeArg?: string) => {
    const hit = findScriptByName(workspaceRef.current, sourceName)
    if (!hit) return null
    const lang = localeArg?.trim() || locale
    const path = langAssetPathFor(hit.script.name, lang)
    const map = await readLangAsset(hit.pkg.id, path)
    return { hit, lang, path, map }
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
          error: `文件名无效，后缀须为 ${ALLOWED_EXTENSIONS_LABEL}`,
        },
      }
    }
    if (normalized.toLowerCase().endsWith('.lang')) {
      return {
        error: {
          ok: false,
          error: '语言文本不能当普通文件写',
          hint: '用 list_lang_keys 看键、用 write_lang 写译文（键来自正文）',
        },
      }
    }
    return { name: normalized }
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
          error: `语言标签无效：${requested}`,
          hint: '用「语言_地区」的小写下划线形式，如 zh_cn / en_us / ja_jp',
        },
      }
    }

    if (resolved.ambiguous) {
      return {
        error: {
          ok: false,
          error: `语言标签不够明确：${requested}`,
          candidates: resolved.ambiguous,
          hint: '请从候选中挑一个明确的标签重试',
        },
      }
    }

    // 工程里已有等价标签（工程是 en_us、请求是 en）→ 一律以工程为准
    const equivalent = projectLocales.find(
      (item) => item.toLowerCase() === resolved.tag.toLowerCase(),
    )
    if (equivalent) {
      return { locale: equivalent, note: `${requested} → ${equivalent}（工程已有）` }
    }
    return { locale: resolved.tag, note: resolved.note }
  }

  const agentHost: AgentHost = {
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
          })),
        )
      return { ok: true, files, count: files.length }
    },
    readSource: (source, offset, limit) => {
      const hit = findScriptByName(workspaceRef.current, source)
      if (!hit) return { ok: false, error: `未找到文件：${source}` }
      const content = agentSourceContent(hit.script.id) ?? hit.script.content
      const page = paginateSource(content, offset, limit)
      return {
        ok: true,
        source: hit.script.name,
        kind: sourceKindOf(hit.script.name, hit.script.srcKind),
        version: hit.script.updatedAt,
        ...page,
      }
    },
    createSource: (source, content) => {
      const checked = normalizeAgentSource(source)
      if ('error' in checked) return checked.error
      if (findScriptByName(workspaceRef.current, checked.name)) {
        return {
          ok: false,
          error: `文件已存在：${checked.name}`,
          hint: '覆盖用 write_source，局部修改用 edit_source；不要靠改名字新建来"试一下"',
        }
      }
      const pkgId =
        findScript(workspaceRef.current, activeIdRef.current)?.pkg.id ??
        workspaceRef.current.packages[0]?.id
      if (!pkgId) return { ok: false, error: '没有可用的包' }

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
      return { ok: true, source: checked.name, created: true, activeUnchanged: true }
    },
    writeSource: (source, content, expectedVersion) => {
      const checked = normalizeAgentSource(source)
      if ('error' in checked) return checked.error

      const existing = findScriptByName(workspaceRef.current, checked.name)
      if (!existing) {
        return {
          ok: false,
          error: `文件不存在：${checked.name}`,
          hint: '新建请用 create_source；write_source 只覆盖已有文件',
        }
      }
      if (
        expectedVersion != null &&
        existing.script.updatedAt !== expectedVersion
      ) {
        return {
          ok: false,
          error: '文件已被改动，写入被拒绝',
          hint: '重新 read_source 拿到新的 version 再写',
        }
      }
      const written = applyAgentFileWrite(
        existing.script.id,
        content,
        'agent.write_source',
      )
      if (!written) return { ok: false, error: '写入失败' }
      return { ok: true, source: written.file, created: false, changed: true }
    },
    editSource: (source, oldText, newText, replaceAll) => {
      const hit = findScriptByName(workspaceRef.current, source)
      if (!hit) return { ok: false, error: `未找到文件：${source}` }
      const content = agentSourceContent(hit.script.id) ?? hit.script.content
      const edited = applyTextEdit(content, oldText, newText, replaceAll)
      if (!edited.ok) return { ok: false, error: edited.error }
      const written = applyAgentFileWrite(
        hit.script.id,
        edited.content,
        'agent.edit_source',
      )
      if (!written) return { ok: false, error: '写入失败' }
      return { ok: true, source: written.file, changed: true, replaced: edited.count }
    },
    renameSource: async (source, newSource) => {
      const hit = findScriptByName(workspaceRef.current, source)
      if (!hit) return { ok: false, error: `未找到文件：${source}` }
      const normalized = normalizeResourceName(newSource)
      if (!normalized || !isManualFileName(normalized)) {
        return {
          ok: false,
          error: `新文件名无效，后缀须为 ${MANUAL_FILE_EXTENSIONS_LABEL}`,
        }
      }
      const result = await applyScriptRename(hit.script.id, normalized)
      if (!result.ok) return { ok: false, error: result.error }
      return {
        ok: true,
        source: normalized,
        previous: hit.script.name,
        movedFiles: result.moves,
      }
    },
    deleteSource: async (source) => {
      const hit = findScriptByName(workspaceRef.current, source)
      if (!hit) return { ok: false, error: `文件不存在：${source}` }
      const deleted = await deleteScriptWithAssets(hit.script.id)
      if (!deleted) return { ok: false, error: '删除失败' }
      return {
        ok: true,
        source: hit.script.name,
        removedAssets: deleted.removedAssets,
      }
    },
    validateSource: (source) => {
      const hit = findScriptByName(workspaceRef.current, source)
      if (!hit) return { ok: false, error: `未找到文件：${source}` }
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
      if (!active) return { ok: false, error: '当前没有打开的文件' }
      return {
        ok: true,
        source: active.name,
        kind: active.kind,
        path: active.path,
        hint: 'path 只用于理解结构；工具参数仍只写逻辑名 source',
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
    listLangKeys: async (source, localeArg, offset, limit) => {
      const resolved = resolveAgentLocale(localeArg)
      if ('error' in resolved) return resolved.error
      const target = await langTargetOf(source, resolved.locale)
      if (!target) return { ok: false, error: `未找到文件：${source}` }
      const content =
        agentSourceContent(target.hit.script.id) ?? target.hit.script.content
      const keys = collectSourceKeys(content, target.hit.script.name)
      const start = Math.max(1, Math.floor(offset ?? 1) || 1)
      const count = Math.min(Math.max(1, Math.floor(limit ?? 200) || 200), 1000)
      const page = keys.slice(start - 1, start - 1 + count)
      const entries = page.map((item) => ({
        key: item.key,
        line: item.line,
        text: target.map[item.key] ?? '',
        translated: item.key in target.map,
      }))
      return {
        ok: true,
        source: target.hit.script.name,
        locale: target.lang,
        path: target.path,
        total: keys.length,
        missing: keys.filter((item) => !(item.key in target.map)).length,
        offset: start,
        truncated: start - 1 + page.length < keys.length,
        entries,
      }
    },
    writeLang: async (source, translations) => {
      const hit = findScriptByName(workspaceRef.current, source)
      if (!hit) return { ok: false, error: `未找到文件：${source}` }
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
      if (plan.length === 0) return { ok: false, error: 'translations 为空' }

      const content = agentSourceContent(hit.script.id) ?? hit.script.content
      const known = new Set(
        collectSourceKeys(content, hit.script.name).map((item) => item.key),
      )
      let workspace = workspaceRef.current
      const results: Array<Record<string, unknown>> = []
      let writtenTotal = 0

      for (const step of plan) {
        const locale = step.locale
        const path = langAssetPathFor(hit.script.name, locale)
        const map = await readLangAsset(hit.pkg.id, path)
        const next = { ...map }
        const written: string[] = []
        const skipped: string[] = []
        for (const entry of step.entries) {
          const key = entry.key.trim().toLowerCase()
          if (!known.has(key)) {
            skipped.push(entry.key)
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
            total: Object.keys(next).length,
          })
          continue
        }
        workspace = await writeLangAsset(workspace, hit.pkg.id, path, next)
        writtenTotal += written.length
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
          total: Object.keys(next).length,
        })
      }

      if (writtenTotal > 0) commitWorkspace(workspace)
      if (writtenTotal === 0) {
        return {
          ok: false,
          error: '没有任何键存在于正文里',
          locales: results,
          notes,
          hint: '键写在正文里（单行 `narrator:7f3a91c2//`；多行块里键名单独占一行）；用 list_lang_keys 查，或先 parse_hs 成键',
        }
      }
      return { ok: true, source: hit.script.name, locales: results, notes }
    },
    deleteLangKeys: async (source, keys, localeArg) => {
      const resolved = resolveAgentLocale(localeArg)
      if ('error' in resolved) return resolved.error
      const target = await langTargetOf(source, resolved.locale)
      if (!target) return { ok: false, error: `未找到文件：${source}` }
      const next = { ...target.map }
      const removed: string[] = []
      for (const raw of keys) {
        const key = raw.trim().toLowerCase()
        if (!(key in next)) continue
        delete next[key]
        removed.push(key)
      }
      if (removed.length === 0) return { ok: true, removed: [], total: Object.keys(next).length }

      const workspace = await writeLangAsset(
        workspaceRef.current,
        target.hit.pkg.id,
        target.path,
        next,
      )
      commitWorkspace(workspace)
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
      }
    },
    listVoiceStatus: async (source, localeArg) => {
      const hit = findScriptByName(workspaceRef.current, source)
      if (!hit) return { ok: false, error: `未找到文件：${source}` }
      const content = agentSourceContent(hit.script.id) ?? hit.script.content
      const keys = collectSourceKeys(content, hit.script.name).map(
        (item) => item.key,
      )
      const resolved = resolveAgentLocale(localeArg)
      if ('error' in resolved) return resolved.error
      const lang = resolved.locale
      const entries = await voiceStatusOf(
        hit.pkg.id,
        hit.pkg.assets,
        hit.script.name,
        lang,
        keys,
      )
      const missing = entries.filter((item) => item.state === 'missing')
      return {
        ok: true,
        source: hit.script.name,
        locale: lang,
        total: entries.length,
        missing: missing.map((item) => item.key),
        entries,
      }
    },
    parseHs: async (source, localeArg) => {
      const hit = findScriptByName(workspaceRef.current, source)
      if (!hit) return { ok: false, error: `未找到文件：${source}` }
      const resolved = resolveAgentLocale(localeArg)
      if ('error' in resolved) return resolved.error
      const lang = resolved.locale
      const path = langAssetPathFor(hit.script.name, lang)
      const map = await readLangAsset(hit.pkg.id, path)
      const before = agentSourceContent(hit.script.id) ?? hit.script.content
      const parsed = parseSourceText(before, map, hit.script.name)

      if (parsed.entries.length === 0) {
        return {
          ok: true,
          source: hit.script.name,
          locale: lang,
          created: 0,
          skipped: parsed.skipped,
          hint: '已经没有可成键的文本（要么都已成键，要么在 #stopparse 之后）',
        }
      }

      // 先写映射再改正文：万一正文写入失败，只是多出几条孤儿译文，不会出现"有键无译文"
      const next = { ...map }
      for (const [key, text] of parsed.entries) next[key] = text
      const workspace = await writeLangAsset(
        workspaceRef.current,
        hit.pkg.id,
        path,
        next,
      )
      commitWorkspace(workspace)
      if (textMapRef.current?.fileName.toLowerCase() === path.toLowerCase()) {
        textCacheRef.current = stringifyTextFile(next)
        textMapRef.current.load()
      }

      const written = applyAgentFileWrite(
        hit.script.id,
        parsed.content,
        'agent.parse_hs',
      )
      if (!written) return { ok: false, error: '写入失败' }
      return {
        ok: true,
        source: written.file,
        locale: lang,
        created: parsed.entries.length,
        skipped: parsed.skipped,
        keys: parsed.entries.map(([key]) => key),
      }
    },
    unparseHs: async (source, localeArg) => {
      const hit = findScriptByName(workspaceRef.current, source)
      if (!hit) return { ok: false, error: `未找到文件：${source}` }
      const resolved = resolveAgentLocale(localeArg)
      if ('error' in resolved) return resolved.error
      const lang = resolved.locale
      const path = langAssetPathFor(hit.script.name, lang)
      const map = await readLangAsset(hit.pkg.id, path)
      const before = agentSourceContent(hit.script.id) ?? hit.script.content
      const unparsed = unparseSourceText(before, map, hit.script.name)

      if (unparsed.replaced === 0) {
        return {
          ok: false,
          error: '没有可逆解析的键',
          source: hit.script.name,
          locale: lang,
          missing: unparsed.missing,
          multiline: unparsed.multiline,
          hint: '先用 list_lang_keys 确认该语言有译文；多行译文目前不支持逆解析',
        }
      }

      const written = applyAgentFileWrite(
        hit.script.id,
        unparsed.content,
        'agent.unparse_hs',
      )
      if (!written) return { ok: false, error: '写入失败' }
      return {
        ok: true,
        source: written.file,
        locale: lang,
        replaced: unparsed.replaced,
        missing: unparsed.missing,
        multiline: unparsed.multiline,
      }
    },
    checkExport: async () => {
      let pak: Awaited<ReturnType<typeof buildResourcePackZip>>
      try {
        pak = await buildResourcePackZip(workspaceRef.current)
      } catch (error) {
        /*
         * 引用解析不出来会让 PAK 导出**中止**（见 resourcePack）：预演要把这件事
         * 当成"这份工程现在导不出 PAK"报出去，而不是让工具调用直接炸掉 ——
         * Agent 拿到原话才能去修那条引用。
         */
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
      const project = await buildProjectPackZip(workspaceRef.current)
      return {
        ok: true,
        pak: { files: pak.fileCount, warnings: pak.warnings },
        project: { files: project.fileCount, warnings: project.warnings },
      }
    },
  }

  useImperativeHandle(ref, () => ({
    handleMenuAction,
  }))

  useEffect(() => {
    onChromeInfo?.({
      titleName,
      packageName,
      projectFolderName: project?.folderName ?? null,
      projectBusy,
    })
  }, [titleName, packageName, project?.folderName, projectBusy, onChromeInfo])

  return (
    <div className="script-workspace">
      <div className="workspace">
        <Explorer
          workspace={workspace}
          activeScriptId={workspace.activeScriptId}
          activeAssetId={workspace.activeAssetId}
          boundPackageId={project?.manifest.id ?? null}
          boundFolderName={project?.folderName ?? null}
          onOpenScript={openScript}
          onOpenAsset={openAsset}
          onTogglePackage={handleTogglePackage}
          onToggleAssets={handleToggleAssets}
          onNewPackage={handleNewPackage}
          onNewScript={handleNewScript}
          onRenamePackage={handleRenamePackage}
          onRenameScript={handleRenameScript}
          onDeletePackage={handleDeletePackage}
          onDeleteScript={handleDeleteScript}
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
        />

        <div className="main-split" ref={splitRef}>
          <AgentPanel
            open={agentOpen}
            host={agentHost}
            style={
              agentOpen
                ? { flex: `0 0 ${agentPercent}%`, width: `${agentPercent}%` }
                : undefined
            }
            onClose={() => setAgentOpen(false)}
            getContext={() => ({
              packageName,
              fileName: titleName,
              content: valueRef.current,
              selection: getEditorSelection(),
            })}
          />

          {agentOpen && (
            <div
              className="split-handle"
              title="拖动调整 Agent / 编辑器 宽度"
              onPointerDown={(event) => {
                event.preventDefault()
                draggingRef.current = true
                document.body.classList.add('is-resizing')
              }}
            />
          )}

          <div
            className="editor-column"
            style={
              agentOpen
                ? { flex: `1 1 ${100 - agentPercent}%` }
                : { flex: '1 1 auto' }
            }
          >
          <div className="tabbar">
            <div className="tab active">
              <span>{titleName}</span>
              <span className="tab-close" aria-hidden>
                ×
              </span>
            </div>
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
          </div>
          <main
            className={`editor-shell${
              editingMarkdown && mdPreviewOn ? ' split-md' : ''
            }${editingHanshu && hscPreviewOn ? ' split-hsc' : ''}${
              viewingAsset ? ' asset-mode' : ''
            }${ttsFileKind ? ' tts-file' : ''}`}
          >
            {viewingAsset && activeAssetHit ? (
              <AssetPreview
                packageId={activeAssetHit.pkg.id}
                asset={activeAssetHit.asset}
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
                  <Editor
                    key={titleName}
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
                      bindTaggedCommentHotkeys(editor, monaco)
                      if (isHanshuFile(titleName)) {
                        bindChoiceInsertHotkeys(editor, monaco)
                        bindSpeakerHotkeys(
                          editor,
                          monaco,
                          () => rolesRef.current,
                        )
                        bindCopyDialogueHotkey(editor, monaco)
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
                          langEditSeqRef.current += 1
                          setLangEdit({
                            id: langEditSeqRef.current,
                            request,
                          })
                        },
                        onUnitMenu: (request) => setUnitMenu(request),
                        onUnitDrop: (request) => handleUnitDrop(request),
                        // 缺失 / 无效态点按钮 = 去录音棚配一条
                        onEditVoice: (key) => editVoiceInStudio(key),
                        // 录音棚：左键点键名 / 划框都会走到这里
                        onUnitSelect: (request) => handleUnitSelect(request),
                        onMarquee: (request) => handleMarquee(request),
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
                    }}
                    options={{
                      fontSize: 18,
                      fontFamily:
                        'Consolas, "Courier New", "Sarasa Mono SC", monospace',
                      lineHeight: 28,
                      /**
                       * 录音棚打开时编辑器是**只读**的：那会儿左键点键名是"选中"、
                       * 空白处按下是"划框"，不允许再改正文（正常交互整体让位）。
                       */
                      readOnly: studioOpen,
                      domReadOnly: studioOpen,
                      minimap: { enabled: false },
                      wordWrap: 'on',
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
          </div>
        </div>

        {editingHanshu && (
          <aside className="role-panel" aria-label="备选角色栏">
            <div className="role-panel-header">
              <span>备选角色</span>
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
        )}

        {studioOpen && (
          <>
            <div
              className="split-handle"
              title="拖动调整录音棚宽度"
              onPointerDown={(event) => {
                event.preventDefault()
                studioDragRef.current = {
                  startX: event.clientX,
                  startWidth: studioWidth,
                }
                document.body.classList.add('is-resizing')
              }}
            />
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
              style={{
                flex: `0 0 ${studioWidth}px`,
                width: `${studioWidth}px`,
              }}
            />
          </>
        )}
      </div>

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

      {historyOpen && (
        <HistoryModal
          open={historyOpen}
          initialFileName={
            viewingAsset
              ? (active?.script.name ?? 'cp1.hs')
              : titleName
          }
          currentContent={value}
          onClose={() => setHistoryOpen(false)}
          onRestore={handleRestoreHistory}
        />
      )}

      <footer className="statusbar">
        <div className="statusbar-left">
          <span title={project ? project.folderName : '未绑定文件夹工程'}>
            {project ? `工程 · ${project.folderName}` : '仅浏览器缓存'}
          </span>
          <span>{packageName}</span>
          <span>{charCount} 字符</span>
          <span>{formatSavedAt(savedAt)}</span>
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
        </div>
        <div className="statusbar-right">
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
          <span>行 {lineCount}</span>
          <span>空格: 2</span>
          <span>UTF-8</span>
          <span>汉书</span>
          {activeTextDiskError && (
            <span
              className="status-warn"
              title={`语言文本未能写入磁盘：${activeTextDiskError}`}
              role="button"
              tabIndex={0}
              onClick={() => setLangDiskError(null)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  setLangDiskError(null)
                }
              }}
            >
              语言文本未写入磁盘
            </span>
          )}
          {pendingProjectRestore && (
            <span
              className="status-warn"
              title="上次的工程文件夹还没授权（启动时无法自动弹出权限框）。点一下重新打开它，并同意读写权限。"
              role="button"
              tabIndex={0}
              onClick={handleRestoreProject}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  handleRestoreProject()
                }
              }}
            >
              上次工程待授权
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
              配音未写入磁盘
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
        </div>
      </footer>
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
