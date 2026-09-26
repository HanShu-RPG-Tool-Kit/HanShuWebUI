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
  setBoundProject,
  supportsDirectoryPicker,
  tryRestoreLastProject,
} from '../project'

import type {
  ScriptChromeInfo,
  ScriptWorkspaceHandle,
} from './scriptTypes'


function formatSavedAt(ts: number | null) {
  if (!ts) return '???'
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `??? ${hh}:${mm}:${ss}`
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
    : (active?.script.name ?? '?????.hs')
  const packageName = viewingAsset
    ? activeAssetHit!.pkg.name
    : (active?.pkg.name ?? '??')
  const editingMarkdown = !viewingAsset && isMarkdownFile(titleName)
  const editingHanshu = !viewingAsset && isHanshuFile(titleName)

  const commitWorkspace = (next: Workspace) => {
    workspaceRef.current = next
    activeIdRef.current = next.activeScriptId
    setWorkspace(next)
    saveWorkspace(next)
  }

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
    setBoundProject(binding)
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
    (err instanceof Error && err.message.includes('??'))

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
      setBoundProject(saved)
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

    // ???????????.hs ?????
    if (name) {
      pushFileVersion(name, text, 'manual-save', { force: true })
    }

    let next = updateScriptContent(workspaceRef.current, id, text)

    // .hs ??????????? .lines?? hash?source????????
    if (isHanshuFile(name)) {
      const linesName = linesFileNameForHs(name)
      next = upsertPackageFile(next, id, linesName, buildLinesContent(text))
    }

    commitWorkspace(next)
    setSavedAt(Date.now())

    if (projectRef.current) {
      void flushProjectToDisk().catch((err) => {
        window.alert(
          `??????????${err instanceof Error ? err.message : String(err)}`,
        )
      })
    }
  }

  const handleOpenProject = async () => {
    if (!supportsDirectoryPicker()) {
      window.alert(
        '??????????? API?\n?? Chrome / Edge ???????localhost??',
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
          `???????${err instanceof Error ? err.message : String(err)}`,
        )
      }
    } finally {
      setProjectBusy(false)
    }
  }

  const handleCreateProject = async () => {
    if (!supportsDirectoryPicker()) {
      window.alert(
        '??????????? API?\n?? Chrome / Edge ???????localhost??',
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
          `???????${err instanceof Error ? err.message : String(err)}`,
        )
      }
    } finally {
      setProjectBusy(false)
    }
  }

  const handleSaveProjectAs = async () => {
    if (!supportsDirectoryPicker()) {
      window.alert(
        '??????????? API?\n?? Chrome / Edge ???????localhost??',
      )
      return
    }
    // ??????? .lines????
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
          `??????${err instanceof Error ? err.message : String(err)}`,
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
    // ???????
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
    const name = window.prompt('????', '??')
    if (!name?.trim()) return
    const pkg = createPackage(name.trim())
    commitWorkspace({
      ...workspaceRef.current,
      packages: [...workspaceRef.current.packages, pkg],
    })
  }

  const handleNewScript = (packageId: string) => {
    const name = window.prompt(
      `???????? ${ALLOWED_EXTENSIONS_LABEL}?`,
      '???.hs',
    )
    if (name == null) return
    const normalized = normalizeResourceName(name)
    if (!normalized) {
      window.alert(`????????????${ALLOWED_EXTENSIONS_LABEL}`)
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
    const name = window.prompt('????', pkg.name)
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
      `???????? ${ALLOWED_EXTENSIONS_LABEL}?`,
      hit.script.name,
    )
    if (name == null) return
    const normalized = normalizeResourceName(name)
    if (!normalized) {
      window.alert(`????????????${ALLOWED_EXTENSIONS_LABEL}`)
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
      window.alert('???????')
      return
    }
    if (
      !window.confirm(`????${pkg.name}???????? assets?`)
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
    if (!window.confirm(`?????${hit.script.name}??`)) return

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
    if (!window.confirm(`?????${hit.asset.path}??`)) return
    const next = removeAssetMeta(workspaceRef.current, assetId)
    commitWorkspace(next)
    void deleteAssetBlob(hit.pkg.id, hit.asset.path)
  }

  const handleNewAssetFolder = (packageId: string, parentPath: string) => {
    const name = window.prompt('???????', 'voice')
    if (!name?.trim()) return
    if (/[\\/:*?"<>|]/.test(name.trim())) {
      window.alert('???????? \\ / : * ? " < > |')
      return
    }
    const folder = normalizeFolderPath(`${parentPath}/${name.trim()}`)
    if (!folder || folder === 'assets') {
      window.alert('???????')
      return
    }
    commitWorkspace(ensureAssetFolder(workspaceRef.current, packageId, folder))
  }

  const handleDeleteAssetFolder = (packageId: string, folderPath: string) => {
    if (folderPath === 'assets') return
    if (
      !window.confirm(
        `??????${folderPath}?????????`,
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
        // ???????????
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
      window.alert(`?????????\n${failed.join('\n')}`)
    }
  }

  const handlePullVoice = (scriptId: string) => {
    const hit = findScript(workspaceRef.current, scriptId)
    if (!hit || !isVoiceMapFile(hit.script.name)) {
      window.alert('??? .voice ??')
      return
    }

    // ????????????????
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
        `????? *.lines.<locale>.voice\n???${refreshed.script.name}`,
      )
      return
    }

    const linesHit = refreshed.pkg.scripts.find(
      (s) => s.name.toLowerCase() === linesName.toLowerCase(),
    )
    if (!linesHit) {
      window.alert(`?????????${linesName}`)
      return
    }

    const result = pullVoiceFromLines(
      refreshed.script.content,
      linesHit.content,
    )
    if (result.added === 0 && result.idified === 0) {
      window.alert(`?????????? ${result.total} ??`)
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
        ? `?????????? ${result.total} ??`
        : `??????? ${result.added} ??value ??????? ${result.total}`,
    )
  }

  const handleGenerateBlankVoiceOggs = async (scriptId: string) => {
    const hit = findScript(workspaceRef.current, scriptId)
    if (!hit || !isVoiceMapFile(hit.script.name)) {
      window.alert('??? .voice ??')
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
        `????? *.lines.<locale>.voice\n???${hit.script.name}`,
      )
      return
    }

    const missing = listMissingVoiceOggs(
      voiceContent,
      parsed.locale,
      hit.pkg.assets.map((a) => a.path),
    )
    if (missing.length === 0) {
      window.alert('????? ogg?????? id?')
      return
    }

    if (
      !window.confirm(
        `?? assets/${parsed.locale}/voice/ ?? ${missing.length} ??? ogg??????`,
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
        ? `??? ${created} ???? ${failed.length}?\n${failed.join('\n')}`
        : `??? ${created} ??? ogg`,
    )
  }

  // ???????????????????
  useEffect(() => {
    if (workspace.activeAssetId) return
    const timer = window.setTimeout(() => {
      persistActiveContent(value)
    }, 400)
    return () => window.clearTimeout(timer)
  }, [value, workspace.activeAssetId])

  // .hs ?????????????/Agent ?????
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

  // ???????????????Chrome ????????
  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!supportsDirectoryPicker()) return
      try {
        const result = await tryRestoreLastProject()
        if (cancelled || !result) return
        applyLoadedProject(result)
      } catch {
        // ?????????????
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
    if (item === '?????') {
      void handleOpenProject()
      return
    }
    if (item === '?????') {
      void handleCreateProject()
      return
    }
    if (item === '??????') {
      void handleSaveProjectAs()
      return
    }
    if (item === '??') {
      persistNow()
      return
    }
    if (item === '????') {
      setHistoryOpen(true)
      return
    }
    if (item === '?????') {
      void handleExportResourcePack()
      return
    }
    if (item === '?????') {
      void handleExportAssetsPack()
      return
    }
    if (item === '???') {
      if (projectRef.current) {
        window.alert(
          '????????????????????????\n??????????????????????????',
        )
      }
      handleNewPackage()
      return
    }
    if (item === '????') {
      const pkgId =
        active?.pkg.id ?? workspaceRef.current.packages[0]?.id ?? null
      if (pkgId) handleNewScript(pkgId)
      return
    }
    if (item === 'Agent ??') {
      setAgentOpen((open) => !open)
      return
    }
  }

  const handleRestoreHistory = (fileName: string, content: string) => {
    // ???????????
    const currentName =
      findScript(workspaceRef.current, activeIdRef.current)?.script.name ?? ''
    if (currentName) {
      pushFileVersion(currentName, valueRef.current, 'restore-point', {
        force: true,
      })
    }

    const hit = findScriptByName(workspaceRef.current, fileName)
    if (!hit) {
      // ???????????
      const pkgId =
        findScript(workspaceRef.current, activeIdRef.current)?.pkg.id ??
        workspaceRef.current.packages[0]?.id
      if (!pkgId) {
        window.alert('???????????')
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
    // ???????? .hs ? .lines ?????
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
          warnings.length > 20 ? `\n??? ${warnings.length - 20} ?` : ''
        window.alert(
          `???????${fileCount} ??????????\n\n${shown}${more}`,
        )
      }
    } catch (err) {
      window.alert(
        `?????${err instanceof Error ? err.message : String(err)}`,
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
          warnings.length > 20 ? `\n??? ${warnings.length - 20} ?` : ''
        window.alert(
          `???????${fileCount} ??????????\n\n${shown}${more}`,
        )
      } else if (fileCount === 0) {
        window.alert('???????????????')
      }
    } catch (err) {
      window.alert(
        `????????${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  const pushAgentDiff = (snap: AgentDiffSnapshot) => {
    setAgentDiffs((prev) => {
      const idx = prev.findIndex((item) => item.fileName === snap.fileName)
      if (idx < 0) return [...prev, snap]
      // ????????????? before???? after
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

  /** ??????????? Agent ????? confirm? */
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
        `?${snap.fileName}?? Agent ?????????????????`,
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
      !window.confirm(`???? ${agentDiffs.length} ? Agent ???`)
    ) {
      return
    }
    // ???????????????????????????
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
      if (!hit) return { ok: false, error: `??????${fileName}` }
      // ????????????????????
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
      if (!id || !hit) return { ok: false, error: '?????????' }
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
          error: `?????????? ${ALLOWED_EXTENSIONS_LABEL}`,
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
      if (!pkgId) return { ok: false, error: '??????' }

      // ????????????????????????
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
      // ???????????? write_current_file ????? .hs
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
            ?
          </span>
        </div>
        {editingMarkdown && (
          <button
            type="button"
            className={`tab-action${mdPreviewOn ? ' on' : ''}`}
            onClick={() => setMdPreviewOn((on) => !on)}
            title="?? Markdown ??"
          >
            Preview
          </button>
        )}
        {editingHanshu && (
          <button
            type="button"
            className={`tab-action${hscPreviewOn ? ' on' : ''}`}
            onClick={() => setHscPreviewOn((on) => !on)}
            title="????? .hsc ??"
          >
            ??
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
              title="???? Agent / ??? ??"
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
          <aside className="role-panel" aria-label="?????">
            <div className="role-panel-header">
              <span>????</span>
            </div>
            <ul className="role-list">
              {Array.from({ length: SPEAKER_SLOT_COUNT }, (_, index) => (
                <li key={index} className="role-slot">
                  <button
                    type="button"
                    className="role-index"
                    title={
                      roles[index].trim()
                        ? `${numpadHint(index)} ? ??`
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
                    placeholder="?"
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
          <span title={project ? project.folderName : '????????'}>
            {project ? `?? ? ${project.folderName}` : '??????'}
          </span>
          <span>{packageName}</span>
          <span>{charCount} ??</span>
          <span>{formatSavedAt(savedAt)}</span>
          {project && (
            <span title="?????????">
              {diskSavedAt
                ? `??? ${new Date(diskSavedAt).toLocaleTimeString()}`
                : '?????'}
            </span>
          )}
          {agentDiffs.length > 0 && (
            <span
              className="status-on"
              onClick={() => setDiffOpen(true)}
              title="?? Agent ????"
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  setDiffOpen(true)
                }
              }}
            >
              Diff?{agentDiffs.length}
            </span>
          )}
        </div>
        <div className="statusbar-right">
          <span
            className={agentOpen ? 'status-on' : ''}
            onClick={() => setAgentOpen((open) => !open)}
            title="?? Agent ??"
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
          <span>? {lineCount}</span>
          <span>??: 2</span>
          <span>UTF-8</span>
          <span>??</span>
        </div>
      </footer>
    </div>
  )
})
