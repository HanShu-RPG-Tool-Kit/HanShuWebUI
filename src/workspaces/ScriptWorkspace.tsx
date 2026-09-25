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
  languageForFile,
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
import { buildLinesContent, linesFileNameForHs } from '../hanshu/lines'
import {
  createBlankOggBlob,
  linesFileNameForVoice,
  listMissingVoiceOggs,
  parseVoiceLocaleFile,
  pullVoiceFromLines,
} from '../hanshu/voice'
import {
  buildResourcePackZip,
  downloadBlob,
} from '../export/resourcePack'
import { buildAssetsPackZip } from '../export/assetsPack'
import { normalizeAssetPath, normalizeFolderPath } from '../assets/paths'
import {
  deleteAssetBlob,
  deletePackageAssetBlobs,
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
  tryRestoreLastProject,
} from '../project'

import type {
  ScriptChromeInfo,
  ScriptWorkspaceHandle,
} from './scriptTypes'
import { LanguageSelect } from '../LanguageSelect'
import { LangTextEditBox } from '../LangTextEditBox'
import { LangTextMap, langFileNameFor } from '../i18n/langTextMap'
import {
  bindLangText,
  type LangEditRequest,
  type LangTextBinding,
} from '../monaco/langTextEditor'
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
    request: LangEditRequest
  } | null>(null)
  const langMapRef = useRef<LangTextMap | null>(null)
  const langBindingRef = useRef<LangTextBinding | null>(null)
  const langEditSeqRef = useRef(0)
  /** 仅活动文件是 .hs 时才有语言文本映射 */
  const langScriptName = editingHanshu ? titleName : ''
  const handleLocaleChange = (tag: string) => {
    setLocale(tag)
    saveLocale(tag)
  }

  // 语言文本映射实例：活动 .hs 文件 + 当前语言标签 → `<文件名>.lang.<语言标签>`
  // 缓存是权威，写穿到同包内的虚拟文件；换成真实磁盘只需换一个 sink 实现。
  useEffect(() => {
    if (!langScriptName) {
      langMapRef.current = null
      langBindingRef.current?.refresh()
      return
    }

    const fileName = langFileNameFor(langScriptName, locale)
    const readSink = () => {
      const base = workspaceRef.current
      const hit = findScript(base, base.activeScriptId)
      if (!hit) return null
      const found = hit.pkg.scripts.find(
        (item) => item.name.toLowerCase() === fileName.toLowerCase(),
      )
      return found?.content ?? null
    }
    const writeSink = (content: string) => {
      const base = workspaceRef.current
      const id = base.activeScriptId
      if (!id) return
      // 先把编辑器里的当前正文并回 workspace，避免覆盖未保存的输入
      const merged = updateScriptContent(base, id, valueRef.current)
      commitWorkspace(upsertPackageFile(merged, id, fileName, content))
    }

    const map = new LangTextMap({
      fileName,
      locale,
      sink: { read: readSink, write: writeSink },
    })
    langMapRef.current = map
    const unsubscribe = map.subscribe(() => langBindingRef.current?.refresh())
    map.load()
    langBindingRef.current?.refresh()

    return () => {
      unsubscribe()
      if (langMapRef.current === map) langMapRef.current = null
    }
  }, [langScriptName, locale])

  // 工具卸载时解绑编辑器
  useEffect(() => () => langBindingRef.current?.dispose(), [])

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

    // .hs 显式保存时全量编译同名 .lines（仅 hash↔source；删句即删条目）
    if (isHanshuFile(name)) {
      const linesName = linesFileNameForHs(name)
      next = upsertPackageFile(next, id, linesName, buildLinesContent(text))
    }

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
    // 先落本地缓存与 .lines，再写盘
    const text = valueRef.current
    const id = activeIdRef.current
    if (id) {
      const name = findScript(workspaceRef.current, id)?.script.name ?? ''
      let next = updateScriptContent(workspaceRef.current, id, text)
      if (isHanshuFile(name)) {
        next = upsertPackageFile(
          next,
          id,
          linesFileNameForHs(name),
          buildLinesContent(text),
        )
      }
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

  const handlePullVoice = (scriptId: string) => {
    const hit = findScript(workspaceRef.current, scriptId)
    if (!hit || !isVoiceMapFile(hit.script.name)) {
      window.alert('请选择 .voice 文件')
      return
    }

    // 先落盘当前打开的同文件编辑器内容
    let base = workspaceRef.current
    if (
      activeIdRef.current === scriptId &&
      !workspaceRef.current.activeAssetId
    ) {
      base = updateScriptContent(base, scriptId, valueRef.current)
    }

    const refreshed = findScript(base, scriptId)
    if (!refreshed) return

    const linesName = linesFileNameForVoice(refreshed.script.name)
    if (!linesName) {
      window.alert(
        `文件名须为 *.lines.<locale>.voice\n当前：${refreshed.script.name}`,
      )
      return
    }

    const linesHit = refreshed.pkg.scripts.find(
      (s) => s.name.toLowerCase() === linesName.toLowerCase(),
    )
    if (!linesHit) {
      window.alert(`找不到对应台词表：${linesName}`)
      return
    }

    const result = pullVoiceFromLines(
      refreshed.script.content,
      linesHit.content,
    )
    if (result.added === 0 && result.idified === 0) {
      window.alert(`已对齐，无需更新（共 ${result.total} 条）`)
      return
    }

    pushFileVersion(refreshed.script.name, refreshed.script.content, 'voice-pull', {
      force: true,
    })
    const next = updateScriptContent(base, scriptId, result.content)
    commitWorkspace(next)
    if (activeIdRef.current === scriptId) {
      setValue(result.content)
      editorRef.current?.setValue(result.content)
    }
    window.alert(
      result.added === 0
        ? `已对齐，无需更新（共 ${result.total} 条）`
        : `拉取完成：追加 ${result.added} 条（value 为原文），合计 ${result.total}`,
    )
  }

  const handleGenerateBlankVoiceOggs = async (scriptId: string) => {
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

    const parsed = parseVoiceLocaleFile(hit.script.name)
    if (!parsed) {
      window.alert(
        `文件名须为 *.lines.<locale>.voice\n当前：${hit.script.name}`,
      )
      return
    }

    const missing = listMissingVoiceOggs(
      voiceContent,
      parsed.locale,
      hit.pkg.assets.map((a) => a.path),
    )
    if (missing.length === 0) {
      window.alert('没有缺失的 ogg（或尚无有效 id）')
      return
    }

    if (
      !window.confirm(
        `将在 assets/${parsed.locale}/voice/ 生成 ${missing.length} 个空白 ogg，是否继续？`,
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
        if (cancelled || !result) return
        applyLoadedProject(result)
      } catch {
        // 忽略：无句柄或用户拒绝权限
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

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
    // 先保存，确保当前 .hs 的 .lines 已全量编译
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
          onPullVoice={handlePullVoice}
          onGenerateBlankVoiceOggs={(scriptId) => {
            void handleGenerateBlankVoiceOggs(scriptId)
          }}
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
                    language={languageForFile(titleName)}
                    theme={HANSHU_THEME_ID}
                    value={value}
                    beforeMount={registerHanshuLanguage}
                    onMount={(editor, monaco) => {
                      editorRef.current = editor
                      bindTaggedCommentHotkeys(editor, monaco)
                      bindChoiceInsertHotkeys(editor, monaco)
                      bindSpeakerHotkeys(editor, monaco, () => rolesRef.current)
                      bindCopyDialogueHotkey(editor, monaco)
                      langBindingRef.current?.dispose()
                      langBindingRef.current = bindLangText(editor, monaco, {
                        getMap: () => langMapRef.current,
                        onEditRequest: (request) => {
                          langEditSeqRef.current += 1
                          setLangEdit({
                            id: langEditSeqRef.current,
                            request,
                          })
                        },
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
          <LanguageSelect value={locale} onChange={handleLocaleChange} />
        </div>
      </footer>
      {langEdit && (
        <LangTextEditBox
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
    </div>
  )
})
