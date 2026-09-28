import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import { Explorer } from '../Explorer'
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
  findAsset,
  findScript,
  findScriptByName,
  isHanshuFile,
  isMarkdownFile,
  editorLanguageForFile,
  listWorkspaceFiles,
  loadWorkspace,
  normalizeResourceName,
  ALLOWED_EXTENSIONS_LABEL,
  removeAssetMeta,
  saveWorkspace,
  toggleAssetsCollapsed,
  updateScriptContent,
  upsertAssetMeta,
  upsertPackageFile,
  ensureAssetFolder,
  removeAssetFolder,
  isVoiceMapFile,
  type Workspace,
} from '../workspace'
import {
  createBlankOggBlob,
  listMissingVoiceOggs,
} from '../i18n/voiceMap'
import { voiceRootDir } from '../i18n/localeLayout'
import {
  buildResourcePackZip,
  downloadBlob,
} from '../export/resourcePack'
import { buildAssetsPackZip } from '../export/assetsPack'
import { normalizeAssetPath, normalizeFolderPath } from '../assets/paths'
import { moveAssetToDir, moveScriptToPackage } from '../workspaceMove'
import {
  deleteAssetBlob,
  deletePackageAssetBlobs,
  getAssetBlob,
  putAssetBlob,
} from '../assets/idb'
import type { AgentHost } from '../agent/tools'
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
  saveProjectAsToPicker,
  saveProjectToDirectory,
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
  type VoiceImportIo,
  type VoiceImportSource,
} from '../i18n/voiceImport'
import { createVoiceProcessor } from '../i18n/voiceTranscode'
import { createVoiceDiskSink } from '../project/voiceDiskSink'
import type { DragSource } from '../drag/dragPayload'
import { TextUnitMenu, type TextUnitMenuItem } from '../TextUnitMenu'
import { VoicePickerModal } from '../VoicePickerModal'
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

type ScriptWorkspaceProps = {
  onChromeInfo?: (info: ScriptChromeInfo) => void
}

export const ScriptWorkspace = forwardRef<
  ScriptWorkspaceHandle,
  ScriptWorkspaceProps
>(function ScriptWorkspace({ onChromeInfo }, ref) {
  const [workspace, setWorkspace] = useState<Workspace>(() => loadWorkspace())
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
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null)
  const rolesRef = useRef(roles)
  const valueRef = useRef(value)
  const workspaceRef = useRef(workspace)
  const activeIdRef = useRef(workspace.activeScriptId)
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

  const commitWorkspace = (next: Workspace) => {
    workspaceRef.current = next
    activeIdRef.current = next.activeScriptId
    setWorkspace(next)
    saveWorkspace(next)
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
  const textBindingRef = useRef<TextBinding | null>(null)
  const langEditSeqRef = useRef(0)
  const voiceLibraryRef = useRef<VoiceLibrary | null>(null)
  /** 音频映射管理的渲染态镜像（ref 给编辑器用，state 给弹窗用） */
  const [voiceRuntime, setVoiceRuntime] = useState<VoiceLibrary | null>(null)
  /** 上级容器右键菜单（null = 没开） */
  const [unitMenu, setUnitMenu] = useState<{
    key: string
    x: number
    y: number
  } | null>(null)
  /** 音频选择器弹窗（null = 没开）。带上建它时的那个 library 实例：
      换文件 / 换语言会重建库，身份一变弹窗自动失效，不用在 effect 里再 setState */
  const [voicePicker, setVoicePicker] = useState<{
    key: string
    library: VoiceLibrary
  } | null>(null)
  /** 正在跑的音频导入（null = 没在导入）：驱动置顶进度条 */
  const [voiceImport, setVoiceImport] = useState<{
    sourceLabel: string
    targetPath: string
    progress: number
    phase: 'process' | 'write'
  } | null>(null)

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
  /** 仅活动文件是 .hs 时才有语言文本映射 */
  const textSourceName = editingHanshu ? titleName : ''
  const handleLocaleChange = (tag: string) => {
    setLocale(tag)
    saveLocale(tag)
  }

  const projectHandle = project?.handle ?? null
  /** 当前写入周期：活动 .hs 文件 + 语言标签 */
  const textWriteKey = `${textSourceName}|${locale}`
  const activeTextDiskError =
    textDiskError?.key === textWriteKey ? textDiskError.message : null

  // 语言文本映射实例：活动源文件 + 当前语言标签 → `assets/<语言标签>/lang_<后缀>/…`
  // 绑定文件夹工程时读写真实磁盘文件，否则退回包内虚拟文件（见 textSink）。
  useEffect(() => {
    if (!textSourceName) {
      textMapRef.current = null
      textBindingRef.current?.refresh()
      return
    }

    const fileName = textAssetPath(locale, textSourceName)
    // 虚拟工作区实现：同包内名为 `<剧本名>.lang.<语言标签>` 的文件
    const virtualSink: TextSink = {
      read: () => {
        const base = workspaceRef.current
        const hit = findScript(base, base.activeScriptId)
        if (!hit) return null
        const found = hit.pkg.scripts.find(
          (item) => item.name.toLowerCase() === fileName.toLowerCase(),
        )
        return found?.content ?? null
      },
      write: (content: string) => {
        const base = workspaceRef.current
        const id = base.activeScriptId
        if (!id) return
        // 先把编辑器里的当前正文并回 workspace，避免覆盖未保存的输入
        const merged = updateScriptContent(base, id, valueRef.current)
        commitWorkspace(upsertPackageFile(merged, id, fileName, content))
      },
    }

    let cancelled = false
    let unsubscribe: (() => void) | null = null
    let created: TextMap | null = null

    // 磁盘读取是异步的：读完再建映射；磁盘写入在 sink 里按顺序串行执行
    void (async () => {
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

  /** 打开音频选择器：内容全由音频映射管理推导，这里只记键与那个库实例 */
  const openVoicePicker = (key: string) => {
    const library = voiceLibraryRef.current
    if (!library) return
    setVoicePicker({ key, library })
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

        const parent = path.includes('/')
          ? path.slice(0, path.lastIndexOf('/'))
          : 'assets'
        const withFolder = ensureAssetFolder(
          workspaceRef.current,
          packageId,
          parent,
        )
        const result = upsertAssetMeta(withFolder, packageId, path, mime, blob.size)
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
   * 跑一次「音频导入」：源 = 资源管理器里选中的资产，或拖进来的外部文件；
   * 目标 = 该键的对等文件。进度条由 voiceImport 状态驱动；中断（点 ×）返回 interrupted。
   */
  const runVoiceImportFor = (key: string, source: VoiceImportSource) => {
    const library = voiceLibraryRef.current
    const packageId = activePackage()?.id
    if (!library || !packageId) return
    const targetPath = library.targetPathOf(key)
    setVoiceImportMessage(null)
    setVoiceImport({
      sourceLabel: formatVoiceImportSourceLabel(source),
      targetPath,
      progress: 0,
      phase: 'process',
    })

    const run = runVoiceImport(
      { source, targetPath },
      createVoiceImportIo(packageId),
      createVoiceProcessor(),
      {
        onPhase: (phase) =>
          setVoiceImport((current) => (current ? { ...current, phase } : current)),
        onProgress: (progress) =>
          setVoiceImport((current) =>
            current ? { ...current, progress } : current,
          ),
        // 工作流在结果落定前发出这条：先弹浮窗，稍后状态栏再留一条可点掉的记录
        onNotice: (notice) =>
          setVoiceToast({ id: Date.now(), message: notice.message, ok: notice.ok }),
      },
    )
    voiceImportCancelRef.current = run.cancel

    void run.result.then((report) => {
      voiceImportCancelRef.current = null
      setVoiceImport(null)
      // 常量枚举消息原样展示；技术细节只进控制台
      setVoiceImportMessage({
        message: report.message,
        ok: report.ok,
        // 没绑定工程文件夹时，导入只会写进应用内资源（IndexedDB）—— 说清楚，
        // 免得看到"成功"却在磁盘上找不到文件
        hint: projectRef.current?.handle
          ? undefined          : '未绑定工程文件夹，只写入了应用内资源',
      })
      if (!report.ok && report.detail) {
        console.warn('[hanshu] 音频导入失败：', report.detail)
      }
    })
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
   * 删除某个键的配音（右键菜单 Delete Voice）。
   *
   * 动作与删除资产一致（元数据 + blob），但**必须连磁盘那一份一起删**：
   * 配音是写穿到工程目录的，只删应用内的话，下次打开工程又会被读回来。
   *
   * 两种确认文案：正常情况就是删这个文件；若它是靠"同名回落"从别的目录解析到的，
   * 说明可能有其它脚本的键也在用它，得说清楚影响面。
   */
  const handleDeleteVoice = (key: string) => {
    const library = voiceLibraryRef.current
    const pkg = activePackage()
    if (!library || !pkg) return
    const status = library.statusOf(key)
    const path = status.path
    if (!path) return

    const targetPath = library.targetPathOf(key)
    if (path.toLowerCase() === targetPath.toLowerCase()) {
      if (!window.confirm(`删除配音「${path}」？`)) return
    } else if (
      !window.confirm(
        `该配音来自其它目录：${path}\n删除会影响所有引用它的键，确定删除？`,
      )
    ) {
      return
    }

    // 正在播就先停掉，否则播的是已经被删掉的音频
    if (status.state === 'playing') library.togglePlay(key)

    const asset = pkg.assets.find(
      (item) => item.path.toLowerCase() === path.toLowerCase(),
    )
    if (asset) {
      commitWorkspace(removeAssetMeta(workspaceRef.current, asset.id))
      void deleteAssetBlob(pkg.id, asset.path)
    }
    // 磁盘副本（含可能残留的 .new）：删掉才算真的删了
    const sink = createVoiceDiskSink(
      projectRef.current?.handle ?? null,
      (failedPath, error) => {
        if (error) {
          console.warn('[hanshu] 没能删掉磁盘上的配音文件：', failedPath, error)
        }
      },
    )
    void sink.remove(path)
  }

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
      onSelect: () => openVoicePicker(key),
    },
    {
      id: 'delete-voice',
      label: 'Delete Voice',
      // 没有配音文件（缺失态）就没什么可删的
      disabled: (voiceRuntime?.statusOf(key).path ?? null) == null,
      onSelect: () => handleDeleteVoice(key),
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
    const { binding, workspace: next } = result
    projectRef.current = binding
    setProject(binding)
    setPendingProjectRestore(false)
    commitWorkspace(next)
    const hit = findScript(next, next.activeScriptId)
    const text = hit?.script.content ?? ''
    setValue(text)
    valueRef.current = text
    editorRef.current?.setValue(text)
    setSavedAt(hit?.script.updatedAt ?? Date.now())
    setDiskSavedAt(Date.now())
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
      const id = activeIdRef.current
      let ws = workspaceRef.current
      if (id) {
        ws = updateScriptContent(ws, id, valueRef.current)
        workspaceRef.current = ws
        setWorkspace(ws)
        saveWorkspace(ws)
      }
      const saved = await saveProjectToDirectory(bound, ws)
      projectRef.current = saved
      setProject(saved)
      setDiskSavedAt(Date.now())
    } finally {
      setProjectBusy(false)
    }
  }

  const persistActiveContent = (text: string) => {
    const id = activeIdRef.current
    if (!id) return
    const next = updateScriptContent(workspaceRef.current, id, text)
    commitWorkspace(next)
    setSavedAt(Date.now())
  }

  const persistNow = () => {
    const text = valueRef.current
    const id = activeIdRef.current
    if (!id) return
    const name =
      findScript(workspaceRef.current, id)?.script.name ?? ''
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
    // 先落本地缓存，再写盘
    const text = valueRef.current
    const id = activeIdRef.current
    if (id) {
      const next = updateScriptContent(workspaceRef.current, id, text)
      commitWorkspace(next)
      setSavedAt(Date.now())
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

    let base = workspaceRef.current
    if (activeIdRef.current) {
      base = updateScriptContent(base, activeIdRef.current, valueRef.current)
    }
    const hit = findScript(base, scriptId)
    if (!hit) return

    commitWorkspace({
      ...base,
      activeScriptId: scriptId,
      activeAssetId: null,
    })
    setValue(hit.script.content)
    valueRef.current = hit.script.content
    editorRef.current?.setValue(hit.script.content)
    setSavedAt(hit.script.updatedAt)
    setRoles(createDefaultRoles())
  }

  const openAsset = (assetId: string) => {
    const hit = findAsset(workspaceRef.current, assetId)
    if (!hit) return
    // 先落盘当前剧本
    let base = workspaceRef.current
    if (activeIdRef.current) {
      base = updateScriptContent(base, activeIdRef.current, valueRef.current)
    }
    commitWorkspace({
      ...base,
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
      `文件名（后缀须为 ${ALLOWED_EXTENSIONS_LABEL}）`,
      '新剧本.hs',
    )
    if (name == null) return
    const normalized = normalizeResourceName(name)
    if (!normalized) {
      window.alert(`文件名无效。后缀只允许：${ALLOWED_EXTENSIONS_LABEL}`)
      return
    }
    persistActiveContent(valueRef.current)
    const script = createScript(normalized, '')
    const nextPackages = workspaceRef.current.packages.map((pkg) =>
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
    setValue('')
    valueRef.current = ''
    editorRef.current?.setValue('')
    setSavedAt(script.updatedAt)
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

  const handleRenameScript = (scriptId: string) => {
    const hit = findScript(workspaceRef.current, scriptId)
    if (!hit) return
    const name = window.prompt(
      `重命名（后缀须为 ${ALLOWED_EXTENSIONS_LABEL}）`,
      hit.script.name,
    )
    if (name == null) return
    const normalized = normalizeResourceName(name)
    if (!normalized) {
      window.alert(`文件名无效。后缀只允许：${ALLOWED_EXTENSIONS_LABEL}`)
      return
    }
    if (normalized === hit.script.name) return
    commitWorkspace({
      ...workspaceRef.current,
      packages: workspaceRef.current.packages.map((pkg) => ({
        ...pkg,
        scripts: pkg.scripts.map((script) =>
          script.id === scriptId ? { ...script, name: normalized } : script,
        ),
      })),
    })
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
      const content = hit?.script.content ?? ''
      setValue(content)
      valueRef.current = content
      editorRef.current?.setValue(content)
      setSavedAt(hit?.script.updatedAt ?? null)
      setRoles(createDefaultRoles())
    }
  }

  const handleDeleteScript = (scriptId: string) => {
    const hit = findScript(workspaceRef.current, scriptId)
    if (!hit) return
    if (!window.confirm(`删除剧本「${hit.script.name}」？`)) return

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
    if (scriptId === activeIdRef.current) {
      const opened = findScript(next, activeScriptId)
      const content = opened?.script.content ?? ''
      setValue(content)
      valueRef.current = content
      editorRef.current?.setValue(content)
      setSavedAt(opened?.script.updatedAt ?? null)
      setRoles(createDefaultRoles())
    }
  }

  const handleDeleteAsset = (assetId: string) => {
    const hit = findAsset(workspaceRef.current, assetId)
    if (!hit) return
    if (!window.confirm(`删除资产「${hit.asset.path}」？`)) return
    const next = removeAssetMeta(workspaceRef.current, assetId)
    commitWorkspace(next)
    void deleteAssetBlob(hit.pkg.id, hit.asset.path)
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
    for (const asset of removed) {
      void deleteAssetBlob(packageId, asset.path)
    }
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
        // 确保父文件夹存在于树中
        const parent = path.includes('/')
          ? path.slice(0, path.lastIndexOf('/'))
          : 'assets'
        next = ensureAssetFolder(next, packageId, parent)
        const result = upsertAssetMeta(
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
    if (
      activeIdRef.current === scriptId &&
      !workspaceRef.current.activeAssetId
    ) {
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
        const parent = path.includes('/')
          ? path.slice(0, path.lastIndexOf('/'))
          : 'assets'
        next = ensureAssetFolder(next, hit.pkg.id, parent)
        await putAssetBlob(hit.pkg.id, path, blank)
        const result = upsertAssetMeta(
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
    const timer = window.setTimeout(() => {
      persistActiveContent(value)
    }, 400)
    return () => window.clearTimeout(timer)
  }, [value, workspace.activeAssetId])

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
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        persistNow()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

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
      if (!draggingRef.current || !splitRef.current) return
      const rect = splitRef.current.getBoundingClientRect()
      if (rect.width <= 0) return
      const raw = ((event.clientX - rect.left) / rect.width) * 100
      const next = Math.min(70, Math.max(25, raw))
      setAgentPercent(next)
    }
    const onUp = () => {
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
    if (item === '导出资源包') {
      void handleExportResourcePack()
      return
    }
    if (item === '导出资产包') {
      void handleExportAssetsPack()
      return
    }
    if (item === '新建包') {
      if (projectRef.current) {
        window.alert(
          '当前已绑定文件夹工程：磁盘上只保存当前这一个包。\n新建包仅留在浏览器缓存；多工程请用「另存为工程…」。',
        )
      }
      handleNewPackage()
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
      let base = workspaceRef.current
      if (activeIdRef.current) {
        base = updateScriptContent(base, activeIdRef.current, valueRef.current)
      }
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
      setValue(content)
      valueRef.current = content
      editorRef.current?.setValue(content)
      setSavedAt(Date.now())
      setHistoryOpen(false)
      return
    }

    pushFileVersion(fileName, hit.script.content, 'restore-point', {
      force: true,
    })
    const next = updateScriptContent(
      workspaceRef.current,
      hit.script.id,
      content,
    )
    commitWorkspace({
      ...next,
      activeScriptId: hit.script.id,
      activeAssetId: null,
    })
    setValue(content)
    valueRef.current = content
    editorRef.current?.setValue(content)
    setSavedAt(Date.now())
    setHistoryOpen(false)
  }

  const handleExportResourcePack = async () => {
    // 先保存，确保导出用到的是最新的 .hs 正文
    persistNow()
    try {
      const { blob, fileCount, warnings } = await buildResourcePackZip(
        workspaceRef.current,
      )
      const stamp = new Date()
        .toISOString()
        .slice(0, 19)
        .replace(/[:T]/g, '-')
      downloadBlob(blob, `rpgtoolkit-resourcepack-${stamp}.zip`)

      if (warnings.length > 0) {
        const shown = warnings.slice(0, 20).join('\n')
        const more =
          warnings.length > 20 ? `\n…另有 ${warnings.length - 20} 条` : ''
        window.alert(
          `已导出资源包（${fileCount} 个文件），但有警告：\n\n${shown}${more}`,
        )
      }
    } catch (err) {
      window.alert(
        `导出失败：${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  const handleExportAssetsPack = async () => {
    persistNow()
    try {
      const { blob, fileCount, warnings } = await buildAssetsPackZip(
        workspaceRef.current,
      )
      const stamp = new Date()
        .toISOString()
        .slice(0, 19)
        .replace(/[:T]/g, '-')
      downloadBlob(blob, `hanshu-assets-${stamp}.zip`)

      if (warnings.length > 0) {
        const shown = warnings.slice(0, 20).join('\n')
        const more =
          warnings.length > 20 ? `\n…另有 ${warnings.length - 20} 条` : ''
        window.alert(
          `已导出资产包（${fileCount} 个文件），但有警告：\n\n${shown}${more}`,
        )
      } else if (fileCount === 0) {
        window.alert('资产包为空（没有可导出的文件）')
      }
    } catch (err) {
      window.alert(
        `导出资产包失败：${err instanceof Error ? err.message : String(err)}`,
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

  const applyEditorContent = (content: string, updatedAt?: number) => {
    setValue(content)
    valueRef.current = content
    editorRef.current?.setValue(content)
    setSavedAt(updatedAt ?? Date.now())
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
      applyEditorContent(opened?.script.content ?? '', opened?.script.updatedAt)
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
    if (hit.script.id === activeIdRef.current) {
      applyEditorContent(content)
    }
    return true
  }

  const currentContentOf = (fileName: string) => {
    const hit = findScriptByName(workspaceRef.current, fileName)
    if (!hit) return null
    if (hit.script.id === activeIdRef.current) return valueRef.current
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

  const agentHost: AgentHost = {
    listFiles: () => listWorkspaceFiles(workspaceRef.current),
    getCurrentFileName: () =>
      findScript(workspaceRef.current, activeIdRef.current)?.script.name ?? '',
    readFile: (fileName) => {
      const hit = findScriptByName(workspaceRef.current, fileName)
      if (!hit) return { ok: false, error: `未找到文件：${fileName}` }
      // 若读的是当前文件，以编辑器里最新内容为准
      if (hit.script.id === activeIdRef.current) {
        return {
          ok: true,
          fileName: hit.script.name,
          content: valueRef.current,
        }
      }
      return {
        ok: true,
        fileName: hit.script.name,
        content: hit.script.content,
      }
    },
    writeCurrentFile: (content) => {
      const id = activeIdRef.current
      const hit = findScript(workspaceRef.current, id)
      if (!id || !hit) return { ok: false, error: '当前没有打开的文件' }
      const before =
        hit.script.id === activeIdRef.current
          ? valueRef.current
          : hit.script.content
      pushFileBackup(hit.script.name, before, 'agent.write_current_file')
      const next = updateScriptContent(workspaceRef.current, id, content)
      commitWorkspace(next)
      setValue(content)
      valueRef.current = content
      editorRef.current?.setValue(content)
      setSavedAt(Date.now())
      pushAgentDiff({
        fileName: hit.script.name,
        before,
        after: content,
      })
      return { ok: true, fileName: hit.script.name }
    },
    writeFile: (fileName, content) => {
      const normalized = normalizeResourceName(fileName)
      if (!normalized) {
        return {
          ok: false,
          error: `文件名无效，后缀须为 ${ALLOWED_EXTENSIONS_LABEL}`,
        }
      }
      const existing = findScriptByName(workspaceRef.current, normalized)
      if (existing) {
        const before =
          existing.script.id === activeIdRef.current
            ? valueRef.current
            : existing.script.content
        pushFileBackup(normalized, before, 'agent.write_file')
        const next = updateScriptContent(
          workspaceRef.current,
          existing.script.id,
          content,
        )
        commitWorkspace(next)
        if (existing.script.id === activeIdRef.current) {
          setValue(content)
          valueRef.current = content
          editorRef.current?.setValue(content)
          setSavedAt(Date.now())
        }
        pushAgentDiff({
          fileName: normalized,
          before,
          after: content,
        })
        return { ok: true, fileName: normalized, created: false }
      }

      const pkgId =
        findScript(workspaceRef.current, activeIdRef.current)?.pkg.id ??
        workspaceRef.current.packages[0]?.id
      if (!pkgId) return { ok: false, error: '没有可用的包' }

      // 先落盘当前打开文件，避免内容丢在未保存的编辑器里
      let base = workspaceRef.current
      if (activeIdRef.current) {
        base = updateScriptContent(base, activeIdRef.current, valueRef.current)
      }

      const script = createScript(normalized, content)
      const nextPackages = base.packages.map((pkg) =>
        pkg.id === pkgId
          ? { ...pkg, collapsed: false, scripts: [...pkg.scripts, script] }
          : pkg,
      )
      // 切换到新建文件，避免后续 write_current_file 误盖原来的 .hs
      commitWorkspace({
        packages: nextPackages,
        activeScriptId: script.id,
        activeAssetId: null,
      })
      setValue(content)
      valueRef.current = content
      editorRef.current?.setValue(content)
      setSavedAt(script.updatedAt)
      setRoles(createDefaultRoles())
      pushAgentDiff({
        fileName: normalized,
        before: '',
        after: content,
        created: true,
      })
      return { ok: true, fileName: normalized, created: true }
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

          <main
            className={`editor-shell${
              editingMarkdown && mdPreviewOn ? ' split-md' : ''
            }${editingHanshu && hscPreviewOn ? ' split-hsc' : ''}${
              viewingAsset ? ' asset-mode' : ''
            }`}
            style={
              agentOpen
                ? { flex: `1 1 ${100 - agentPercent}%` }
                : { flex: '1 1 auto' }
            }
          >
            {viewingAsset && activeAssetHit ? (
              <AssetPreview
                packageId={activeAssetHit.pkg.id}
                asset={activeAssetHit.asset}
              />
            ) : (
              <>
                <div className="editor-pane">
                  <Editor
                    height="100%"
                    language={editorLanguageForFile(titleName)}
                    theme={HANSHU_THEME_ID}
                    value={value}
                    beforeMount={registerHanshuLanguage}
                    onMount={(editor, monaco) => {
                      editorRef.current = editor
                      bindTaggedCommentHotkeys(editor, monaco)
                      bindChoiceInsertHotkeys(editor, monaco)
                      bindSpeakerHotkeys(editor, monaco, () => rolesRef.current)
                      bindCopyDialogueHotkey(editor, monaco)
                      textBindingRef.current?.dispose()
                      textBindingRef.current = bindText(editor, monaco, {
                        getMap: () => textMapRef.current,
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
                        // 缺失 / 无效态点按钮 = 挑一个音频
                        onVoicePick: (key) => openVoicePicker(key),
                      })
                    }}
                    onChange={(next) => {
                      setValue(next ?? '')
                    }}
                    options={{
                      fontSize: 18,
                      fontFamily:
                        'Consolas, "Courier New", "Sarasa Mono SC", monospace',
                      lineHeight: 28,
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
      </div>

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
          <LocaleSelect value={locale} onChange={handleLocaleChange} />
        </div>
      </footer>
      {langEdit && (
        <TextEditBox
          key={langEdit.id}
          mode={langEdit.request.mode}
          initial={langEdit.request.initial}
          rect={langEdit.request.rect}
          onCommit={(next) => {
            const edit = langEdit
            setLangEdit((current) => (current?.id === edit.id ? null : current))
            edit.request.apply(next)
          }}
          onCancel={() => {
            const edit = langEdit
            setLangEdit((current) => (current?.id === edit.id ? null : current))
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
      {voicePicker &&
        voiceRuntime != null &&
        voiceRuntime === voicePicker.library && (
          <VoicePickerModal
            unitKey={voicePicker.key}
            targetPath={voicePicker.library.targetPathOf(voicePicker.key)}
            currentPath={voicePicker.library.resolvedPathOf(voicePicker.key)}
            library={voicePicker.library}
            onImport={(sourcePath) => {
              const key = voicePicker.key
              setVoicePicker(null)
              runVoiceImportFor(key, { kind: 'asset', path: sourcePath })
            }}
            onImportFile={(source) => {
              // 选择器里已经把这文件缓存在内存里了（拖入 ≠ 导入），这里只负责跑工作流
              const key = voicePicker.key
              setVoicePicker(null)
              runVoiceImportFor(key, { kind: 'file', name: source.name, bytes: source.bytes })
            }}
            onClose={() => setVoicePicker(null)}
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
