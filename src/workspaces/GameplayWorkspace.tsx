import {ServiceError} from '../collab/protocol'
import {EXPLORER_ORGANIZATION_PATH,documentPlacements,emptyOrganization,organizationFromDocuments,serializeOrganization} from '../project/explorerOrganization'
import {PythonEditor} from '../monaco/python/PythonEditor'
import {scriptType,scriptSection,scriptTemplate} from '../scriptResources'
import {scriptTypeInFolder,sectionFolderKey} from './gameplay/library'
import {openEntityEditInGame} from '../gameDevServer/entityWorkbench'
import {LocalizedItemEditor, LocalizedEntityEditor} from './gameplay/LocalizedAppearanceEditors'
import {createEntity,parseEntity,stringifyEntity} from './gameplay/entityDoc'
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type DragEvent, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { connectNodes, createFlow, disconnectLink, parseFlow, validateFlow, type CanvasNodeType, type FlowCanvasNote, type FlowInputPort, type FlowOutputPort, type FlowPosition, type FlowSelection, type ProgressFlow } from './gameplay/model'
import { createCanvasNote, createEndNode, createPredicateNode, createObjectiveNode, createProgressNode, createTransitionNode, groupCanvasNodes, moveCanvasNodes, removeCanvasItems, renameCanvasGroup, ungroupCanvasNodes, updateCanvasNote, withCanvasPositions } from './gameplay/canvas'
import { smartArrangeCanvas } from './gameplay/arrange'
import { ProgressGraph } from './gameplay/ProgressGraph'
import { FlowDocumentProperties } from './gameplay/FlowDocumentProperties'
import { FlowExplorer } from './gameplay/FlowExplorer'
import { PageList } from './gameplay/PageList'
import { EditorSplit } from './gameplay/EditorSplit'
import { closeAllInGroup, closeInGroup, closeOthersInGroup, closeRightInGroup, focusedGroupId, focusGroup, joinGroups, moveTab, normalizeGroups, openAsRightSplit, openInGroup, openOppositeToKey, readGroup, setSplitRatio, splitTab, togglePinInGroup, type GroupId, type SplitZone } from './gameplay/editorGroups'
import { ensurePackageSections, folderPath, isBuiltinScriptFolder, isEntityDocument, isItemDocument, isItemLibraryTableKey, isLibraryTableKey, isEntityLibraryTableKey, ENTITY_LIBRARY_TABLE_KEY, ITEM_LIBRARY_TABLE_KEY, isKitDocument, isMultiQuestDocument, isNavigationDocument, isQuestDocument, isScriptDocument, isSectionFolder, isSimpleQuestDocument, packageAcceptsImportFile, packageAllowsDocuments, packageDocumentExt, renameFlowEntry, stripLibraryTables, uniqueDocumentName, withLibraryTables } from './gameplay/library'
import { normalizeQuestFileName, questAuthorKindFromSource } from './gameplay/questKind'
import { createFlowDocument, downloadFlowFile, importFlowDocument, stampDocument, type FlowDocument, type FlowPackageId, type FlowWorkspaceState } from './gameplay/storage'
import { createKit, kitRefFromFileName, readKitSource, stringifyKit, parseKit } from './gameplay/kit'
import { createProgress, createProgressLocaleSeeds, readProgressSource, stringifyProgress, parseProgress } from './gameplay/progressDoc'
import { createNavigationPoint, readNavigationSource, stringifyNavigationPoint, parseNavigationPoint } from './gameplay/navigationPoint'
import { createItem, itemFromItemStackSource, parseItem, readItemSource, stringifyItem } from './gameplay/itemDoc'
import {
  isAutoItemSnapshotRefreshEnabled,
  isItemSnapshotRefreshOnline,
  setAutoItemSnapshotRefreshEnabled,
} from './gameplay/itemSnapshotCache'
import { refreshDocumentsItemSnapshots } from './gameplay/itemSnapshotActions'
import { isItemStackFileName } from './gameplay/itemstack'
import {
  ensureItemEditNotifyStarted,
  openItemEditInGame,
} from '../gameDevServer'
import { itemRefFromFileName } from './gameplay/kit'
import {
  buildGoalDefinitionCatalog,
  isBuiltinScriptDocumentKey,
  stripBuiltinScripts,
  withBuiltinScripts,
} from './gameplay/goalDefinitions'
import { ShopEditor } from './gameplay/ShopEditor'
import { createShop, parseShop, stringifyShop } from './gameplay/shop'
import { KitEditor } from './gameplay/KitEditor'
import { ProgressCollaborativeEditor } from './gameplay/ProgressCollaborativeEditor'
import { progressEditorSession } from './gameplay/progressEditRegistry'
import { NavigationEditor } from './gameplay/NavigationEditor'
import {EntityLibraryTable} from './gameplay/EntityLibraryTable'
import { ItemLibraryTable } from './gameplay/ItemLibraryTable'
import { useEditorFontSize } from './gameplay/editorFont'
import {
  defaultFlowLocaleSeeds,
  defaultKitLocaleSeeds,
  defaultNavLocaleSeeds,
  ensureFlowLocaleKeys,
  ensureKitLocaleKeys,
  ensureNavLocaleKeys,
  isProgressLocaleKey,
} from './gameplay/progressLocale'
import {
  applyProgressDocumentsToWorkspace,
  getProjectSession,
  isProgressSourceName,
  loadProgressUiState,
  saveProgressUiState,
  setProjectSession,
  sourcesToProgressDocuments,
  useProjectSession,
} from '../project/projectSession'
import { setBoundProject } from '../project/bindingBus'
import { saveProjectToDirectory } from '../project/projectFs'
import { deleteSourceAssets } from '../agent/agentOps'
import { randomId } from '../project/crypto'
import { FilePresenceBar } from '../project/FilePresenceBar'
import { notify } from '../activity'
import { StatusBarSlots } from '../chrome'
import { renameScriptAssets } from '../workspaceMove'
import { registerAsset, saveWorkspace, sourcePathOf } from '../workspace'
import { deleteAssetBlob, getAssetBlob, putAssetBlob } from '../assets/idb'
import { TextMap, TEXT_ASSET_MIME } from '../i18n/textMap'
import { textAssetPath } from '../i18n/localeLayout'
import { createTextSink } from '../i18n/textSink'
import { loadLocale, saveLocale } from '../storage'
import { LocaleSelect } from '../LocaleSelect'
import Editor from '@monaco-editor/react'
import { HANSHU_THEME_ID, registerHanshuLanguage } from '../monaco/hanshuLanguage'
import './GameplayWorkspace.css'

export type GameplayWorkspaceHandle = { handleMenuAction: (item: string) => void }

type History = { past: string[]; future: string[]; lastEdit: number }
type DropZone = SplitZone | 'center'

/** 指针离哪条边足够近就拆向哪边，否则落入该组（VS Code 的五区规则）。 */
function dropZoneAt(event: DragEvent, splitOn: boolean): DropZone {
  if (splitOn) return 'center'
  const rect = event.currentTarget.getBoundingClientRect()
  const x = (event.clientX - rect.left) / Math.max(1, rect.width)
  const y = (event.clientY - rect.top) / Math.max(1, rect.height)
  const edges: [SplitZone, number][] = [['left', x], ['right', 1 - x], ['top', y], ['bottom', 1 - y]]
  const [zone, distance] = edges.reduce((best, item) => item[1] < best[1] ? item : best)
  return distance < 0.3 ? zone : 'center'
}

export function GameplayWorkspace({ active, workspaceRef }: { active: boolean; workspaceRef?: Ref<GameplayWorkspaceHandle> }) {
  const session = useProjectSession()
  const client = session.binding?.handle.client
  const projectBound = Boolean(session.binding)
  const editorFontSize = useEditorFontSize()
  const [ui, setUi] = useState(loadProgressUiState)
  const [locale, setLocale] = useState(loadLocale)
  const [localeTick, setLocaleTick] = useState(0)
  const textMapRef = useRef<TextMap | null>(null)
  const textMapClientRef = useRef(client)
  const textDocKeyRef = useRef<string | null>(null)
  const textCacheRef = useRef<string | null>(null)
  const pendingSeedsRef = useRef(new Map<string, Record<string, string>>())
  const migratedKeysRef = useRef(new Set<string>())
  const documents = useMemo(() => {
    const folders = session.workspace.packages[0]?.explorer?.folders ?? []
    const folderKeys = new Set(folders.map((folder) => folder.key))
    return sourcesToProgressDocuments(
      session.workspace.packages[0]?.scripts ?? [],
      documentPlacements(session.workspace.packages[0]?.scripts ?? [],session.workspace.packages[0]?.explorer??emptyOrganization()),
    ).map((doc) => {
      let folderId = doc.folderId && (folderKeys.has(doc.folderId) || isSectionFolder(doc.folderId)) ? doc.folderId : null
      const source = session.workspace.packages[0]?.scripts.find(source => source.id === doc.key)
      if (doc.name.toLowerCase().endsWith('.py')) {
        const type=scriptType(source?.srcKind)
        if(scriptTypeInFolder({folders},folderId)!==type||folderId===null)folderId=sectionFolderKey('script',scriptSection(type))
      }
      return folderId === (doc.folderId ?? null) ? doc : { ...doc, folderId }
    })
  }, [session.workspace])
  const baseState = useMemo(
    () => ensurePackageSections({
      documents,
      folders: session.workspace.packages[0]?.explorer?.folders ?? [],
      openKeys: ui.openKeys ?? [],
      activeKey: ui.activeKey ?? null,
      pinnedKeys: ui.pinnedKeys ?? [],
      split: ui.split,
    }),
    [documents, ui, session.workspace],
  )
  /** 先叠虚拟内置文档 / 物品库表视图，再清理页条——否则虚拟页会被当成失效键清掉 */
  const state = useMemo(
    () => normalizeGroups(withLibraryTables(withBuiltinScripts(baseState))),
    [baseState],
  )
  const stateRef = useRef(state)
  stateRef.current = state

  const structuralPendingRef = useRef(false)
  const setState = (change: FlowWorkspaceState | ((previous: FlowWorkspaceState) => FlowWorkspaceState)) => {
    if (structuralPendingRef.current) return
    const previous = stateRef.current
    const next = stripLibraryTables(stripBuiltinScripts(typeof change === 'function' ? change(previous) : change))
    const live = getProjectSession()
    const binding = live.binding
    const prevScripts = live.workspace.packages[0]?.scripts ?? []
    const previousOrganization = live.workspace.packages[0]?.explorer ?? emptyOrganization()
    const nextOrganization = organizationFromDocuments(next.documents.filter(doc=>!doc.detached), next.folders ?? [], {
      organization: previousOrganization, sourcePaths: prevScripts.filter(source=>!source.detached).map(sourcePathOf),
    })
    const metadataChanged = serializeOrganization(nextOrganization) !== serializeOrganization(previousOrganization)
    const organization = metadataChanged ? nextOrganization : previousOrganization
    const metadataEdits:import('../project/serviceClient').FileEdit[]=metadataChanged?[{op:'write',path:EXPLORER_ORGANIZATION_PATH,data:serializeOrganization(organization)}]:[]
    const renames = next.documents.flatMap(doc => {
      const old = prevScripts.find(script => script.id === doc.key)
      if (!old) return []
      const srcKind = doc.name.toLowerCase().endsWith('.py')
        ? scriptTypeInFolder(next,doc.folderId??null)
        : old.srcKind
      return old.name !== doc.name || scriptType(old.srcKind) !== scriptType(srcKind)
        ? [{ old, doc, srcKind }] : []
    })
    const removed = prevScripts.filter(script => isProgressSourceName(script.name) && !next.documents.some(doc => doc.key === script.id))
    const applyUi = (workspace: typeof live.workspace) => {
      const nextUi = {
        openKeys: next.openKeys ?? [], activeKey: next.activeKey ?? null,
        pinnedKeys: next.pinnedKeys ?? [], split: next.split,
      }
      setUi(nextUi)
      saveProgressUiState(nextUi)
      const structuralIds = new Set(renames.map(item => item.doc.key))
      const currentSources = workspace.packages[0]?.scripts ?? []
      const currentOrganization=workspace.packages[0]?.explorer??emptyOrganization()
      const appliedOrganization=structuralPendingRef.current&&serializeOrganization(currentOrganization)!==serializeOrganization(organization)?currentOrganization:organization
      const projected = next.documents.flatMap(doc => {
        if (!structuralPendingRef.current) return [doc]
        if(structuralIds.has(doc.key)){const current=currentSources.find(source=>source.id===doc.key);return [{...doc,source:current?.content??doc.source}]}
        const current = currentSources.find(source => source.id === doc.key)
        return current ? [{ ...doc, source: current.content, updatedAt: new Date(current.updatedAt).toISOString() }] : []
      })
      // A peer can create resources while this transaction is in flight.
      if(structuralPendingRef.current){
        const removedIds=new Set(removed.map(source=>source.id))
        const additions=sourcesToProgressDocuments(currentSources,documentPlacements(currentSources,appliedOrganization))
        for(const doc of additions)if(!removedIds.has(doc.key)&&!projected.some(item=>item.key===doc.key))projected.push(doc)
      }
      if (binding) {
        const updated=applyProgressDocumentsToWorkspace(workspace, projected, ensurePackageSections({...next,folders:appliedOrganization.folders}).folders)
        setProjectSession({workspace:{...updated,packages:updated.packages.map((pkg,index)=>index===0?{...pkg,explorer:appliedOrganization}:pkg)}})
      }
    }
    if (!binding || (!renames.length && !removed.length && !metadataChanged)) { applyUi(live.workspace); return }
    try {
      for (const { doc } of renames) {
        const renamed = renameScriptAssets(live.workspace, doc.key, doc.name)
        if (renamed.kind === 'blocked') throw new Error(`关联文件 ${renamed.path} 已存在`)
      }
    } catch (error) { setNotice(String(error)); return }
    // 尚未写入 S 的草稿不能 move（会报「移动目标无效」）；只改本机名，等下次保存落新路径
    const onServer = (file: { name: string; srcKind?: string | null }) => {
      const path = sourcePathOf(file)
      return Boolean(binding.handle.client.entry(path))
    }
    const serverRenames = renames.filter(({ old }) => onServer(old))
    const serverRemoves = removed.filter((old) => onServer(old))
    if (!serverRenames.length && !serverRemoves.length && !metadataChanged) {
      applyUi(live.workspace)
      if (removed.length) {
        const ids = new Set(removed.map((old) => old.id))
        setHistory((items) => new Map([...items].filter(([key]) => !ids.has(key))))
        if (ids.has(previous.activeKey ?? '')) setSelection({ kind: 'flow' })
      }
      setNotice(renames.length ? '已改名（尚未保存到工程的草稿，保存时会写入新文件名）。' : '已更新工程结构。')
      return
    }
    // 先更新树名，再等 S 落盘；失败则按提交前工作区回滚（避免像「改了没反应」）
    const revertWorkspace = live.workspace
    applyUi(live.workspace)
    structuralPendingRef.current = true
    setBusy(true)
    let acknowledged = false
    void (async () => {
      await binding.handle.client.sourceCommands([
        ...serverRenames.map(({ old, doc, srcKind }) => ({ path: sourcePathOf(old), destination: sourcePathOf({ name: doc.name, srcKind }), content: doc.source })),
        ...serverRemoves.map((old) => ({ path: sourcePathOf(old), destination: null })),
      ],metadataEdits)
      acknowledged = true
      // A project switch while S was working must not replace the new project's view.
      if (getProjectSession().binding?.handle.client !== binding.handle.client) return
      let workspace = getProjectSession().workspace
      for (const { doc } of renames) {
        const renamed = renameScriptAssets(workspace, doc.key, doc.name)
        if (renamed.kind === 'moved') {
          const packageId = workspace.packages[0]?.id
          if (packageId) for (const move of renamed.moves) {
            const blob = await getAssetBlob(packageId, move.fromPath)
            if (blob) await putAssetBlob(packageId, move.toPath, blob)
            await deleteAssetBlob(packageId, move.fromPath)
          }
          workspace = renamed.workspace
        }
      }
      for (const old of removed) workspace = (await deleteSourceAssets(workspace, old.name)).workspace
      applyUi(workspace)
      if (removed.length) {
        const ids = new Set(removed.map(old => old.id))
        setHistory(previous => new Map([...previous].filter(([key]) => !ids.has(key))))
        if (ids.has(previous.activeKey ?? '')) setSelection({ kind: 'flow' })
      }
      setNotice('工程结构已保存。')
    })().catch(error => {
      if (!acknowledged && !(error instanceof ServiceError&&error.code==='commit_uncertain') && getProjectSession().binding?.handle.client === binding.handle.client) {
        // Folder-only rollback must not discard text edited or refreshed while waiting.
        const current=getProjectSession().workspace
        setProjectSession({ workspace: renames.length||removed.length?revertWorkspace:{...current,packages:current.packages.map((pkg,index)=>index===0?{...pkg,explorer:revertWorkspace.packages[0]?.explorer}:pkg)} })
        const revertUi = {
          openKeys: previous.openKeys ?? [],
          activeKey: previous.activeKey ?? null,
          pinnedKeys: previous.pinnedKeys ?? [],
          split: previous.split,
        }
        setUi(revertUi)
        saveProgressUiState(revertUi)
      }
      setNotice(`${acknowledged ? '服务器已保存，本地视图更新失败，请查询原提交恢复' : error instanceof ServiceError&&error.code==='commit_uncertain'?'操作结果待确认，资源编辑已暂停，请查询原提交':'操作未提交，原文件和草稿已保留'}：${String(error)}`)
    })
      .finally(() => { structuralPendingRef.current = false; setBusy(false) })
  }

  const [storageError, setStorageError] = useState('')
  const failedSaveRef = useRef<{ client: NonNullable<typeof session.binding>['handle']['client']; ids: number[] } | null>(null)
  /** 短提示走全 IDE 活动列表，不再占编辑区 layout */
  const setNotice = (message: string) => {
    if (!message.trim()) return
    notify(message, { source: 'progress' })
  }
  const [selection, setSelection] = useState<FlowSelection>({ kind: 'flow' })
  const [busy, setBusy] = useState(false)
  const [showIssues, setShowIssues] = useState(false)
  const [cycleAlert, setCycleAlert] = useState<string | null>(null)
  const [propertiesKey, setPropertiesKey] = useState<string | null>(null)
  const [progressSourceKey, setProgressSourceKey] = useState<string | null>(null)
  const [history, setHistory] = useState(() => new Map<string, History>())
  const fileInput = useRef<HTMLInputElement>(null)
  const importFolder = useRef<{ folderId: string | null; package: FlowPackageId }>({ folderId: null, package: 'quest' })
  const seenCycle = useRef<string | null>(null)
  const cycleDialog = useRef<HTMLDialogElement>(null)
  const [pageDrag, setPageDrag] = useState<{ key: string; group: GroupId } | null>(null)
  const [dropTarget, setDropTarget] = useState<{ group: GroupId; zone: DropZone } | null>(null)

  useEffect(() => {
    failedSaveRef.current = null
    setStorageError(projectBound ? '' : '请先打开工程；所有工作区使用同一工程连接。')
  }, [projectBound, session.binding?.handle.client])

  useEffect(() => {
    const client = session.binding?.handle.client
    if (!client) return
    return client.transactions.subscribe(() => {
      const failed = failedSaveRef.current
      if (failed?.client !== client) return
      const saved = new Set(client.transactions.getSnapshot().transactions.filter(transaction => transaction.phase === 'saved').map(transaction => transaction.id))
      if (!failed.ids.length || !failed.ids.every(id => saved.has(id))) return
      failedSaveRef.current = null
      setStorageError('')
      setNotice('相关提交已保存。')
    })
  }, [session.binding?.handle.client])

  function queueLocaleSeeds(docKey: string, seeds: Record<string, string>) {
    if (!Object.keys(seeds).length) return
    const previous = pendingSeedsRef.current.get(docKey) ?? {}
    pendingSeedsRef.current.set(docKey, { ...previous, ...seeds })
    if (textMapRef.current && textDocKeyRef.current === docKey) {
      textMapRef.current.setMissing(Object.entries(seeds))
      setLocaleTick((value) => value + 1)
    }
  }

  function resolveLocaleText(key: string): string {
    void localeTick
    return textMapRef.current?.get(key) ?? ''
  }

  function setLocaleText(key: string, value: string) {
    if (progressDoc && !progressEditable) return
    textMapRef.current?.set(key, value)
    setLocaleTick((tick) => tick + 1)
  }

  const splitOn = Boolean(state.split)
  const focusedGroup = focusedGroupId(state)
  const focusedKey = readGroup(state, focusedGroup).activeKey
  const doc = state.documents.find((item) => item.key === focusedKey)
  const scriptDoc = doc ? isScriptDocument(doc) : false
  const shopDoc = doc?.package === 'shop'
  const kitDoc = doc ? isKitDocument(doc) : false
  const progressDoc = doc ? isSimpleQuestDocument(doc) : false
  const multiQuestDoc = doc ? isMultiQuestDocument(doc) : false
  const progressPath = progressDoc && doc ? sourcePathOf({ name: doc.name }) : null
  const progressEditable = !!progressPath && !!client?.writable
  const presenceSource = doc && !isBuiltinScriptDocumentKey(doc.key) && !isLibraryTableKey(doc.key)
    ? session.workspace.packages.flatMap(pkg => pkg.scripts).find(script => script.id === doc.key)
    : null
  const presencePath = presenceSource&&!presenceSource.detached ? sourcePathOf(presenceSource) : null
  const navigationDoc = doc ? isNavigationDocument(doc) : false
  const itemTableDoc = doc ? isLibraryTableKey(doc.key) : false
  const entityDoc = doc ? isEntityDocument(doc) : false
  const itemDoc = doc ? isItemDocument(doc) : false
  const goalCatalog = useMemo(() => buildGoalDefinitionCatalog(state), [state.documents, state.folders])
  const kitCatalog = useMemo(() => {
    const map = new Map<string, ReturnType<typeof readKitSource>['kit']>()
    const options: { ref: string; label: string; key: string }[] = []
    for (const item of state.documents) {
      if (!isKitDocument(item)) continue
      const ref = kitRefFromFileName(item.name)
      if (!ref || map.has(ref)) continue
      const parsedKit = readKitSource(item.source)
      if (parsedKit.error) continue
      map.set(ref, parsedKit.kit)
      const title = parsedKit.kit.name.trim()
      const showTitle = title && title !== ref && !isProgressLocaleKey(title)
      options.push({ ref, label: showTitle ? `${ref}（${title}）` : ref, key: item.key })
    }
    options.sort((a, b) => a.ref.localeCompare(b.ref, 'zh-CN'))
    return { map, options }
  }, [state.documents])
  const itemCatalog = useMemo(() => {
    const map = new Map<string, ReturnType<typeof readItemSource>['doc']>()
    for (const item of state.documents) {
      if (!isItemDocument(item)) continue
      const ref = itemRefFromFileName(item.name)
      if (!ref || map.has(ref)) continue
      const parsedItem = readItemSource(item.source)
      if (parsedItem.error) continue
      map.set(ref, parsedItem.doc)
    }
    return map
  }, [state.documents])
  const parsed = useMemo(() => {
    if (!doc || shopDoc || scriptDoc || kitDoc || progressDoc || navigationDoc || itemDoc || entityDoc || itemTableDoc) return { flow: null, error: '' }
    try { return { flow: parseFlow(doc.source), error: '' } }
    catch (error) { return { flow: null, error: error instanceof Error ? error.message : String(error) } }
  }, [doc, shopDoc, scriptDoc, kitDoc, progressDoc, navigationDoc, itemDoc, entityDoc, itemTableDoc])
  const docByKey = useMemo(() => new Map(state.documents.map((item) => [item.key, item])), [state.documents])
  const explorerState = useMemo(() => ({ ...state, activeKey: focusedKey }), [state, focusedKey])
  const issues = useMemo(() => parsed.flow ? validateFlow(parsed.flow, goalCatalog.definitions) : [], [parsed.flow, goalCatalog.definitions])
  const cycleWarning = issues.find(issue => issue.path === 'graph' && issue.message.includes('环'))
  const readOnly = !client?.writable
  const locked = !projectBound || propertiesKey !== null
  const propertiesDoc = propertiesKey ? state.documents.find((item) => item.key === propertiesKey) ?? null : null
  const flowLocalizable = Boolean(doc && !shopDoc && !scriptDoc && !kitDoc && !progressDoc && !navigationDoc && !itemDoc && !entityDoc && !itemTableDoc)
  const localeDoc = Boolean(doc && (shopDoc || flowLocalizable || kitDoc || navigationDoc))

  // 当前焦点文档的语义键 TextMap（literal）
  useEffect(() => {
    const sourceDoc = localeDoc ? doc : null
    if (!sourceDoc || !projectBound) {
      textMapRef.current = null
      textMapClientRef.current = undefined
      textDocKeyRef.current = null
      textCacheRef.current = null
      return
    }

    const fileName = textAssetPath(locale, sourceDoc.name)
    const packageId = session.workspace.packages[0]?.id
    if (!packageId) return
    const sourceClient = session.binding?.handle.client
    if (textMapClientRef.current !== sourceClient || textDocKeyRef.current !== sourceDoc.key || textMapRef.current?.fileName !== fileName) {
      textMapRef.current = null
      textDocKeyRef.current = null
      textCacheRef.current = null
    }

    const virtualSink = {
      read: () => textCacheRef.current,
      write: (content: string) => {
        if (getProjectSession().binding?.handle.client !== sourceClient) throw new Error('工程已切换，原语言草稿保留在原工程')
        textCacheRef.current = content
        const live = getProjectSession()
        const pkg = live.workspace.packages[0]
        if (!pkg) return
        const blob = new Blob([content], { type: TEXT_ASSET_MIME })
        return putAssetBlob(pkg.id, fileName, blob).then(() => {
          if (getProjectSession().binding?.handle.client !== sourceClient) throw new Error('工程已切换，原语言草稿保留在原工程')
          const result = registerAsset(
            getProjectSession().workspace,
            pkg.id,
            fileName,
            TEXT_ASSET_MIME,
            blob.size,
          )
          if (result) setProjectSession({ workspace: result.workspace })
        })
      },
    }

    let cancelled = false
    let unsubscribe: (() => void) | null = null

    const initialize = async () => {
      const blob = await getAssetBlob(packageId, fileName)
      const content = blob ? await blob.text() : null
      if (cancelled || getProjectSession().binding?.handle.client !== sourceClient) return
      textCacheRef.current = content
      const sink = await createTextSink({
        project: session.binding,
        fileName,
        virtual: virtualSink,
      })
      if (cancelled) return
      const map = new TextMap({ fileName, locale, sink, keyStyle: 'literal' })
      textMapRef.current = map
      textMapClientRef.current = sourceClient
      textDocKeyRef.current = sourceDoc.key
      unsubscribe = map.subscribe(() => setLocaleTick((tick) => tick + 1))
      map.load()
      const pending = pendingSeedsRef.current.get(sourceDoc.key)
      if (pending && (!progressDoc || progressEditable)) {
        map.setMissing(Object.entries(pending))
        pendingSeedsRef.current.delete(sourceDoc.key)
      }
      setLocaleTick((tick) => tick + 1)
    }
    // Source creation and its default language seeds are one save. Register the
    // asynchronous read now, before TextMap can stage its first language write.
    const ready = sourceClient?.writable && (!progressDoc || progressEditable)
      ? sourceClient.transactions.prepareDraft(fileName, initialize)
      : initialize()
    void ready.catch(error => { if (!cancelled) setNotice(`语言资源准备失败：${String(error)}`) })

    return () => {
      cancelled = true
      unsubscribe?.()
      // Losing a lease or refreshing the same document must not blank its fields
      // while the replacement map loads. Its sink still reads the staged draft.
    }
  }, [doc?.key, doc?.name, locale, projectBound, localeDoc, session.workspace.packages[0]?.id, client, client?.remoteEpoch, progressEditable])

  // 打开旧明文文档时迁移为语义键并灌默认语种子
  useEffect(() => {
    if (!doc || !projectBound || readOnly || progressDoc || migratedKeysRef.current.has(`${doc.key}:${locale}`)) return
    if (navigationDoc) {
      const parsedNav = readNavigationSource(doc.source)
      if (parsedNav.error) {
        migratedKeysRef.current.add(`${doc.key}:${locale}`)
        return
      }
      const { point: next, seeds } = ensureNavLocaleKeys(parsedNav.point)
      migratedKeysRef.current.add(`${doc.key}:${locale}`)
      const source = stringifyNavigationPoint(next)
      if (Object.keys(seeds).length && source !== doc.source) {
        setState((previous) => ({
          ...previous,
          documents: previous.documents.map((item) =>
            item.key === doc.key ? stampDocument({ ...item, source }) : item,
          ),
        }))
      }
      queueLocaleSeeds(doc.key, seeds)
      return
    }
    if (kitDoc) {
      const parsedKit = readKitSource(doc.source)
      if (parsedKit.error) {
        migratedKeysRef.current.add(`${doc.key}:${locale}`)
        return
      }
      const { kit: next, seeds } = ensureKitLocaleKeys(parsedKit.kit)
      migratedKeysRef.current.add(`${doc.key}:${locale}`)
      const source = stringifyKit(next)
      if (Object.keys(seeds).length && source !== doc.source) {
        setState((previous) => ({
          ...previous,
          documents: previous.documents.map((item) =>
            item.key === doc.key ? stampDocument({ ...item, source }) : item,
          ),
        }))
      }
      queueLocaleSeeds(doc.key, seeds)
      return
    }
    if (flowLocalizable) {
      try {
        const flow = parseFlow(doc.source)
        const { flow: next, seeds } = ensureFlowLocaleKeys(flow)
        migratedKeysRef.current.add(`${doc.key}:${locale}`)
        const source = JSON.stringify(next, null, 2) + '\n'
        if (Object.keys(seeds).length && source !== doc.source) {
          setState((previous) => ({
            ...previous,
            documents: previous.documents.map((item) =>
              item.key === doc.key ? stampDocument({ ...item, source }) : item,
            ),
          }))
        }
        queueLocaleSeeds(doc.key, seeds)
      } catch {
        migratedKeysRef.current.add(`${doc.key}:${locale}`)
      }
    }
  }, [doc?.key, doc?.source, locale, projectBound, progressDoc, navigationDoc, kitDoc, flowLocalizable, progressEditable, readOnly])

  useEffect(() => {
    if (!pageDrag) return
    // 被拖的页可能已移到另一组而卸载，收不到自身的 dragend
    const clear = () => { setPageDrag(null); setDropTarget(null) }
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [pageDrag])

  useEffect(() => {
    const message = cycleWarning?.message ?? null
    if (!message) {
      seenCycle.current = null
      return
    }
    if (seenCycle.current === message) return
    seenCycle.current = message
    setCycleAlert(message)
    setShowIssues(true)
  }, [cycleWarning?.message])

  useEffect(() => {
    const element = cycleDialog.current
    if (!element) return
    if (cycleAlert) {
      if (!element.open) element.showModal()
    } else if (element.open) {
      element.close()
    }
  }, [cycleAlert])

  useEffect(() => {
    if (!storageError || projectBound) return
    const preventLoss = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', preventLoss)
    return () => window.removeEventListener('beforeunload', preventLoss)
  }, [storageError, projectBound])

  function changeSource(source: string, group = false, key = doc?.key) {
    if (!key || isBuiltinScriptDocumentKey(key) || isItemLibraryTableKey(key)) return
    const current = state.documents.find((item) => item.key === key)
    if (!current || source === current.source || readOnly) return
    const previous = history.get(key)
    const entry: History = previous ? { ...previous, past: [...previous.past], future: [] } : { past: [], future: [], lastEdit: 0 }
    if (!group || Date.now() - entry.lastEdit > 600) entry.past = [...entry.past.slice(-49), current.source]
    entry.lastEdit = group ? Date.now() : 0
    setHistory((items) => new Map(items).set(key, entry))
    setState((previous) => ({
      ...previous,
      documents: previous.documents.map((item) => item.key === key ? stampDocument({ ...item, source }) : item),
    }))
  }
  useEffect(() => { ensureItemEditNotifyStarted() }, [])

  async function openEntityInGame(key:string){
    const document=state.documents.find(d=>d.key===key)
    if(!document||!isEntityDocument(document))return
    try{await openEntityEditInGame(key,parseEntity(document.source));setNotice('已在游戏中打开实体编辑器')}catch(error){setNotice(`打开游戏实体编辑器失败：${error instanceof Error?error.message:String(error)}`)}
  }
  async function openItemInGame(key: string) {
    const document = state.documents.find((item) => item.key === key)
    if (!document || !isItemDocument(document)) {
      setNotice('请选择一个 .item。')
      return
    }
    const parsed = readItemSource(document.source)
    if (parsed.error || !parsed.doc.item.id.trim()) {
      setNotice(parsed.error || '当前物品缺少 id，无法在游戏中编辑。')
      return
    }
    try {
      await openItemEditInGame(key, parsed.doc.item)
      setNotice('已在游戏中打开物品编辑器')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message === 'control_not_connected') {
        setNotice('未连接游戏开发服务器，无法打开客户端编辑器')
        return
      }
      setNotice(`打开游戏物品编辑器失败：${message}`)
    }
  }
  const changeFlow = (flow: ProgressFlow, key = focusedKey ?? undefined) => changeSource(JSON.stringify(flow, null, 2), false, key)
  function createNode(position: FlowPosition, operator?: CanvasNodeType) {
    if (!parsed.flow || locked || busy) return
    const result = operator === 'objective' ? createObjectiveNode(parsed.flow, position)
      : operator === 'predicate' ? createPredicateNode(parsed.flow, position)
      : operator === 'transition' ? createTransitionNode(parsed.flow, position)
        : operator === 'end' ? createEndNode(parsed.flow, position)
          : operator === 'note' ? createCanvasNote(parsed.flow, position)
            : createProgressNode(parsed.flow, position)
    const kind = operator === 'predicate' ? 'predicate' : operator === 'transition' ? 'transition' : operator === 'end' ? 'end' : operator === 'note' ? 'note' : 'progress'
    changeFlow(result.flow); setSelection({ kind, id: result.id } as FlowSelection)
    if (doc && 'localeSeeds' in result && result.localeSeeds) {
      queueLocaleSeeds(doc.key, result.localeSeeds as Record<string, string>)
    }
  }
  function moveCanvasSelection(positions: Record<string, FlowPosition>) {
    if (!parsed.flow || locked || busy) return
    changeFlow(moveCanvasNodes(parsed.flow, positions))
  }
  function groupCanvasSelection(ids: string[]) {
    if (!parsed.flow || locked || busy) return null
    const result = groupCanvasNodes(parsed.flow, ids)
    changeFlow(result.flow); setSelection({ kind: 'flow' })
    return result.id
  }
  function ungroupCanvasSelection(id: string) {
    if (!parsed.flow || locked || busy) return
    changeFlow(ungroupCanvasNodes(parsed.flow, id)); setSelection({ kind: 'flow' })
  }
  function deleteNodes(ids: string[], disconnect: FlowSelection[] = []) {
    if (!parsed.flow || locked || busy) return
    let next = parsed.flow
    if (disconnect.length) {
      const fixed = withCanvasPositions(next)
      next = disconnect.reduce(disconnectLink, fixed)
    }
    next = removeCanvasItems(next, ids)
    if (next !== parsed.flow) { changeFlow(next); setSelection({ kind: 'flow' }) }
  }
  function deleteNode(id: string) { deleteNodes([id]) }
  function arrangeSelection(ids: string[]) {
    if (!parsed.flow || locked || busy) return
    const next = smartArrangeCanvas(parsed.flow, ids)
    if (next !== parsed.flow) changeFlow(next)
  }
  function updateNote(id: string, patch: Partial<FlowCanvasNote>) {
    if (!parsed.flow || locked || busy) return
    changeFlow(updateCanvasNote(parsed.flow, id, patch))
  }
  function connectCanvasNodes(from: string, to: string, port: FlowInputPort, fromPort?: FlowOutputPort) {
    if (!parsed.flow || locked || busy) return
    try {
      const fixed = withCanvasPositions(parsed.flow), result = connectNodes(fixed, from, to, port, fromPort ?? 'output')
      if (result.flow !== fixed) changeFlow(result.flow)
      setSelection(result.selection)
    } catch (error) { setNotice(String(error)) }
  }
  function disconnectCanvasLink(link: FlowSelection) {
    disconnectCanvasLinks([link])
  }
  function renameGroup(id: string, name: string) {
    if (!parsed.flow || locked || busy) return
    const next = renameCanvasGroup(parsed.flow, id, name)
    if (next !== parsed.flow) changeFlow(next)
  }
  function disconnectCanvasLinks(links: FlowSelection[]) {
    if (!parsed.flow || locked || busy) return
    const fixed = withCanvasPositions(parsed.flow), next = links.reduce(disconnectLink, fixed)
    if (next !== fixed) { changeFlow(next); setSelection({ kind: 'flow' }) }
  }
  function undo(redo = false) {
    if (!doc || locked || readOnly || (progressDoc && !progressEditable)) return
    if (progressDoc && progressPath) {
      const current = progressEditorSession(client, progressPath)
      if (current) { void current.undo(redo).catch(error => setNotice(String(error))); return }
    }
    const previous = history.get(doc.key)
    if (!previous) return
    const entry = { ...previous, past: [...previous.past], future: [...previous.future] }
    const source = (redo ? entry.future : entry.past).pop()
    if (source === undefined) return
    ;(redo ? entry.past : entry.future).push(doc.source)
    entry.lastEdit = 0
    setHistory((items) => new Map(items).set(doc.key, entry))
    setState((previous) => ({ ...previous, documents: previous.documents.map((item) => item.key === doc.key ? { ...item, source } : item) }))
    setSelection({ kind: 'flow' })
  }
  /** 编辑组操作；焦点页一旦变化就清空画布选区，避免选区落到别的文档上。 */
  function updateGroups(change: (previous: FlowWorkspaceState) => FlowWorkspaceState) {
    if (locked || busy) return
    const predicted = change(state)
    if (predicted === state) return
    setState(change)
    if (readGroup(predicted, focusedGroupId(predicted)).activeKey !== focusedKey) setSelection({ kind: 'flow' })
  }
  function focusEditorGroup(id: GroupId) {
    if (!splitOn || id === focusedGroup) return
    updateGroups((previous) => focusGroup(previous, id))
  }
  function selectDocument(key: string, group: GroupId = focusedGroup) {
    if (isLibraryTableKey(key)) {
      updateGroups((previous) => openAsRightSplit(previous, key))
      setProgressSourceKey(null)
      setNotice('')
      return
    }
    updateGroups((previous) => openInGroup(previous, group, key))
    setProgressSourceKey(null)
    setNotice('')
  }
  function openItemFromTable(itemKey: string) {
    updateGroups((previous) => openOppositeToKey(previous, ITEM_LIBRARY_TABLE_KEY, itemKey, focusedGroup))
    setProgressSourceKey(null)
    setNotice('')
  }
  function viewProgressSource(key: string) {
    updateGroups((previous) => openInGroup(previous, focusedGroup, key))
    setProgressSourceKey(key)
    setNotice('')
  }
  function dropPage(group: GroupId, zone: DropZone, beforeKey: string | null = null) {
    const drag = pageDrag
    setPageDrag(null); setDropTarget(null)
    if (!drag) return
    if (zone !== 'center') updateGroups((previous) => splitTab(previous, drag.key, zone, 'move'))
    else if (drag.group !== group) updateGroups((previous) => moveTab(previous, drag.group, group, drag.key, beforeKey))
    else if (beforeKey !== drag.key) updateGroups((previous) => moveTab(previous, group, group, drag.key, beforeKey))
  }
  function newFlow(value = '新建流程', folderId: string | null = null, packageId: FlowPackageId = 'quest', templateName='default.py', sourceOverride?:string) {
    if (locked || busy) throw new Error('请先完成当前修改。')
    const ext = packageDocumentExt(packageId)
    if (!ext) throw new Error('此分类不支持文件。')
    const name = uniqueDocumentName(state,value,packageId,folderId)
    const title = name.slice(0, -ext.length)
    /** 任务包：templateName 区分单进度（progress/simple）与多进度（flow/multi）；缺省单进度 */
    const questKind = packageId === 'quest'
      ? (templateName === 'flow' || templateName === 'multi' || templateName === 'multi-quest' ? 'multi' as const : 'simple' as const)
      : null
    const next = ext === '.py'
      ? stampDocument({
        key: randomId(),
        name,
        source: sourceOverride??scriptTemplate(scriptTypeInFolder(state,folderId),templateName,title),
        package: packageId,
        folderId,
      })
      : ext === '.shop' ? stampDocument({ key: randomId(), name, source: stringifyShop(createShop()), package: packageId, folderId })
      : ext === '.kit'
        ? stampDocument({
          key: randomId(),
          name,
          source: stringifyKit(createKit(title)),
          package: packageId,
          folderId,
        })
        : questKind === 'simple'
          ? stampDocument({
            key: randomId(),
            name,
            source: stringifyProgress(createProgress(title, goalCatalog.definitions)),
            package: packageId,
            folderId,
          })
          : ext === '.nav'
            ? stampDocument({
              key: randomId(),
              name,
              source: stringifyNavigationPoint(createNavigationPoint(title)),
              package: packageId,
              folderId,
            })
            : ext === '.entity' ? stampDocument({key:randomId(),name,source:stringifyEntity(createEntity()),package:packageId,folderId})
            : ext === '.item'
              ? stampDocument({
                key: randomId(),
                name,
                source: stringifyItem(createItem()),
                package: packageId,
                folderId,
              })
        : { ...createFlowDocument(createFlow(undefined, title), packageId), name, folderId, package: packageId }
    if (questKind === 'simple') queueLocaleSeeds(next.key, createProgressLocaleSeeds(title))
    else if (questKind === 'multi') queueLocaleSeeds(next.key, defaultFlowLocaleSeeds(title))
    else if (ext === '.nav') queueLocaleSeeds(next.key, defaultNavLocaleSeeds(title))
    else if (ext === '.kit') queueLocaleSeeds(next.key, defaultKitLocaleSeeds(title))
    else if (ext === '.shop') queueLocaleSeeds(next.key, { name: title })
    setState((previous) => openInGroup({ ...previous, documents: [...previous.documents, next] }, focusedGroupId(previous), next.key))
    setSelection({ kind: 'flow' }); setNotice('')
    return next.key
  }
  function requestImport(folderId: string | null, packageId: FlowPackageId) {
    importFolder.current = { folderId, package: packageId }
    const input = fileInput.current
    if (!input) return
    input.accept = packageId === 'script' ? '.py,text/x-python'
      : packageId === 'gift' ? '.kit,application/json'
        : packageId === 'quest' ? '.quest,.json,application/json'
          : packageId === 'navigator' ? '.nav,.json,application/json'
            : packageId === 'entities' ? '.entity,application/json'
            : packageId === 'items' ? '.item,.itemstack,.json,application/json'
              : '.quest,.json,application/json'
    input.click()
  }
  async function importFiles(files: File[], target = importFolder.current) {
    if (!files.length || locked) return
    const pkg = target.package
    const folderId = target.folderId
    if (!packageAllowsDocuments(pkg)) {
      setNotice('该分类暂不支持导入文件。')
      return
    }
    const accepted = files.filter((file) => packageAcceptsImportFile(pkg, file.name))
    const skipped = files.length - accepted.length
    if (!accepted.length) {
      setNotice(pkg === 'script' ? '请放入 .py 脚本。' : pkg === 'gift' ? '请放入 .kit 礼包。' : pkg === 'quest' ? '请放入 .quest 或 JSON 任务文档。' : pkg === 'navigator' ? '请放入 .nav 导航点。' : pkg === 'entities' ? '请放入 .entity 实体模板。' : pkg === 'items' ? '请放入 .item 或 .itemstack。' : '请放入 .quest 或 JSON 任务文档。')
      return
    }
    setBusy(true)
    try {
      const documents: FlowDocument[] = []
      for (const file of accepted) {
        if (file.size > 4 * 1024 * 1024) throw new Error(`${file.name}：文件超过 4 MB`)
        if (pkg === 'script') {
          const name = uniqueDocumentName({ ...state, documents: [...state.documents, ...documents] }, file.name, pkg, folderId)
          documents.push(stampDocument({
            key: randomId(),
            name,
            source: await file.text(),
            package: pkg,
            folderId,
          }))
          continue
        }
        if (pkg === 'gift' || pkg === 'shop') {
          const source = await file.text()
          if (pkg === 'shop') parseShop(source)
          else parseKit(source)
          const name = uniqueDocumentName({ ...state, documents: [...state.documents, ...documents] }, file.name, pkg, folderId)
          documents.push(stampDocument({
            key: randomId(),
            name,
            source,
            package: pkg,
            folderId,
          }))
          continue
        }
        if (pkg === 'quest') {
          const source = await file.text()
          const kind = questAuthorKindFromSource(source)
          const questName = uniqueDocumentName({ ...state, documents: [...state.documents, ...documents] }, normalizeQuestFileName(file.name), pkg, folderId)
          if (kind === 'multi') {
            const imported = importFlowDocument(questName, source, pkg)
            imported.folderId = folderId
            imported.name = questName
            documents.push(imported)
          } else {
            parseProgress(source)
            documents.push(stampDocument({
              key: randomId(),
              name: questName,
              source,
              package: pkg,
              folderId,
            }))
          }
          continue
        }
        if (pkg === 'navigator') {
          const source = await file.text()
          parseNavigationPoint(source)
          const name = uniqueDocumentName({ ...state, documents: [...state.documents, ...documents] }, file.name, pkg, folderId)
          documents.push(stampDocument({
            key: randomId(),
            name,
            source,
            package: pkg,
            folderId,
          }))
          continue
        }
        if(pkg==='entities') {
          const source=stringifyEntity(parseEntity(await file.text()))
          const name=uniqueDocumentName({...state,documents:[...state.documents,...documents]},file.name,pkg,folderId)
          documents.push(stampDocument({key:randomId(),name,source,package:pkg,folderId}));continue
        }
        if (pkg === 'items') {
          const raw = await file.text()
          const source = isItemStackFileName(file.name)
            ? stringifyItem(itemFromItemStackSource(raw))
            : stringifyItem(parseItem(raw))
          const name = uniqueDocumentName({ ...state, documents: [...state.documents, ...documents] }, file.name, pkg, folderId)
          documents.push(stampDocument({
            key: randomId(),
            name,
            source,
            package: pkg,
            folderId,
          }))
          continue
        }
        const imported = importFlowDocument(file.name, await file.text(), pkg)
        imported.folderId = folderId
        imported.name = uniqueDocumentName({ ...state, documents: [...state.documents, ...documents] }, imported.name, pkg, folderId)
        documents.push(imported)
      }
      setState((previous) => openInGroup(
        { ...previous, documents: [...previous.documents, ...documents] },
        focusedGroupId(previous),
        documents.map((item) => item.key),
      ))
      setSelection({ kind: 'flow' })
      const kind = pkg === 'script' ? '个脚本' : pkg === 'gift' ? '个礼包' : pkg === 'quest' ? '个任务' : pkg === 'navigator' ? '个导航点' : pkg === 'items' ? '个物品' : '个任务'
      setNotice(skipped > 0 ? `已导入 ${documents.length} ${kind}，跳过 ${skipped} 个不匹配的文件。` : `已导入 ${documents.length} ${kind}。`)
    } catch (error) { setNotice(`导入失败：${String(error)}`) }
    finally { setBusy(false) }
  }
  function exportFlow(key: string) {
    if (locked || busy) return
    const item = state.documents.find((d) => d.key === key)
    if (!item) return
    if (item.package === 'shop' || isEntityDocument(item) || isScriptDocument(item) || isKitDocument(item) || isSimpleQuestDocument(item) || isNavigationDocument(item) || isItemDocument(item)) {
      const progress = isSimpleQuestDocument(item) ? progressEditorSession(client, sourcePathOf({ name: item.name })) : undefined
      downloadFlowFile(item.name, progress?.getSnapshot().view.source ?? item.source)
      setNotice(isItemDocument(item) ? '已下载物品。' : isKitDocument(item) ? '已下载礼包。' : isSimpleQuestDocument(item) ? '已下载任务。' : isNavigationDocument(item) ? '已下载导航点。' : '已下载脚本。')
      return
    }
    try {
      const flow = parseFlow(item.source)
      if (validateFlow(flow, goalCatalog.definitions).some((issue) => issue.severity === 'error')) throw new Error('请先修复流程的配置错误。')
      downloadFlowFile(item.name, JSON.stringify(flow, null, 2) + '\n')
      setNotice('已导出 HanShu 树图文档。')
    } catch (error) { setNotice(`导出失败：${String(error)}`) }
  }
  function downloadDraft(key: string) {
    if (locked || busy) return
    const item = state.documents.find((d) => d.key === key)
    if (!item) return
    const progress = isSimpleQuestDocument(item) ? progressEditorSession(client, sourcePathOf({ name: item.name })) : undefined
    if (progress) {
      downloadFlowFile(`${item.name}.draft.json`, JSON.stringify({ ...progress.backup(), projectId: client?.snapshot.projectId, path: sourcePathOf({ name: item.name }) }, null, 2) + '\n')
      setNotice('已下载完整任务草稿，包含源文件、语言文本与未完成提交。')
      return
    }
    downloadFlowFile(item.name, item.source)
    setNotice('已下载当前草稿。')
  }
  function saveProperties(key: string, next: { name: string; source: string }) {
    const current = state.documents.find((item) => item.key === key)
    if (!current) return
    if (next.source !== current.source) {
      const previous = history.get(key)
      const entry: History = previous ? { ...previous, past: [...previous.past], future: [] } : { past: [], future: [], lastEdit: 0 }
      entry.past = [...entry.past.slice(-49), current.source]
      entry.lastEdit = 0
      setHistory((items) => new Map(items).set(key, entry))
    }
    setState((previous) => {
      let nextState = {
        ...previous,
        documents: previous.documents.map((item) => item.key === key ? stampDocument({ ...item, source: next.source }) : item),
      }
      if (next.name !== current.name) nextState = renameFlowEntry(nextState, { kind: 'document', key }, next.name)
      return nextState
    })
    setPropertiesKey(null)
    setNotice(next.name !== current.name ? '正在保存流程属性…' : '已更新草稿属性。')
  }
  function removeResources({ documents: documentKeys, folders: folderKeys }: { documents: string[]; folders: string[] }) {
    const docs = documentKeys.filter((key) => !isBuiltinScriptDocumentKey(key) && !isLibraryTableKey(key))
    const foldersToRemove = folderKeys.filter((key) => !isBuiltinScriptFolder(key) && !isSectionFolder(key))
    if (locked || busy || (!docs.length && !foldersToRemove.length)) return
    const parts = [
      docs.length ? `${docs.length} 个流程` : '',
      foldersToRemove.length ? `${foldersToRemove.length} 个文件夹` : '',
    ].filter(Boolean)
    if (!window.confirm(`从共享工程中移除 ${parts.join('、')}？`)) return
    const documentSet = new Set(docs)
    const folderSet = new Set(foldersToRemove)
    setState((previous) => {
      const documents = previous.documents.filter((item) => !documentSet.has(item.key))
      const folders = previous.folders.filter((folder) => {
        if (folder.key.startsWith('section:') || isBuiltinScriptFolder(folder.key)) return true
        if (!folderSet.has(folder.key)) return true
        const hasDoc = documents.some((item) => item.folderId === folder.key)
        const hasChild = previous.folders.some((child) => child.parentId === folder.key && !folderSet.has(child.key))
        return hasDoc || hasChild
      })
      return normalizeGroups({ ...previous, documents, folders })
    })
  }
  async function saveDraft() {
    if (locked || busy) return
    // 先让当前输入失焦，把 defaultValue/草稿类字段刷进文档，再落盘（否则 Ctrl+S 会存旧值）。
    const focused = document.activeElement
    if (focused instanceof HTMLElement && focused.closest('.gameplay-workspace')) focused.blur()
    await new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)))
    const live = getProjectSession()
    if (!live.binding) {
      setNotice('请先打开工程；进度文件会写入工程目录。')
      return
    }
    setBusy(true)
    const client = live.binding.handle.client
    const pendingPaths = client.transactions.getSnapshot().pendingPaths
    let transactionId: number | undefined
    try {
      saveWorkspace(live.workspace)
      const saving = saveProjectToDirectory(live.binding, live.workspace)
      transactionId = client.transactions.getSnapshot().transactions.at(-1)?.id
      const saved = await saving
      setProjectSession({ binding: saved })
      setBoundProject(saved)
      failedSaveRef.current = null
      setStorageError('')
      setNotice('')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failed = client.transactions.getSnapshot().transactions.filter(transaction => ['failed', 'conflict', 'uncertain'].includes(transaction.phase))
      // A duplicate save can be rejected by an older unresolved transaction; tie
      // the banner to that original record so resolving it also clears the banner.
      const own = failed.find(transaction => transaction.id === transactionId)
      const ids = own ? [own.id] : failed.filter(transaction => transaction.paths.some(path => pendingPaths.some(pending => path === pending || path.startsWith(`${pending}/`) || pending.startsWith(`${path}/`)))).map(transaction => transaction.id)
      failedSaveRef.current = { client, ids }
      setStorageError(message)
      setNotice(`保存失败：${message}`)
    } finally {
      setBusy(false)
    }
  }
  useImperativeHandle(workspaceRef, () => ({ handleMenuAction(item) {
    if (item === 'save') {
      void saveDraft()
      return
    }
    if (item === 'undo') {
      undo()
      return
    }
    if (item === 'redo') {
      undo(true)
      return
    }
    if (item === 'toggle-auto-item-snapshot-refresh') {
      const next = !isAutoItemSnapshotRefreshEnabled()
      setAutoItemSnapshotRefreshEnabled(next)
      setNotice(next ? '已开启自动刷新物品快照' : '已关闭自动刷新物品快照（仍可用下方菜单手动刷新）')
      return
    }
    if (item === 'refresh-item-snapshot') {
      const focused = state.documents.find((document) => document.key === focusedKey)
      if (!focused) {
        setNotice('请先打开一个物品、礼包或商店文档，再刷新物品快照。')
        return
      }
      // 物品库表视图是虚拟文档，刷新它等于刷新整个物品库
      const targets = isItemLibraryTableKey(focused.key)
        ? state.documents.filter((document) => isItemDocument(document))
        : [focused]
      const count = refreshDocumentsItemSnapshots(targets, { itemCatalog })
      if (count === 0) {
        setNotice('当前文档没有可刷新的物品。')
        return
      }
      // 进度与结果由活动列表「刷新物品快照」任务更新；离线排队文案也在那里
      if (!isItemSnapshotRefreshOnline()) {
        setNotice('未连接游戏开发服务器，快照已排队')
      }
      return
    }
    if (item === 'refresh-all-item-snapshots') {
      const count = refreshDocumentsItemSnapshots(state.documents, { itemCatalog })
      if (count === 0) {
        setNotice('工程里还没有可刷新的物品。')
        return
      }
      if (!isItemSnapshotRefreshOnline()) {
        setNotice('未连接游戏开发服务器，快照已排队')
      }
    }
  } }))
  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || locked) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void saveDraft() }
      const target = event.target as HTMLElement
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return
      if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y')) { event.preventDefault(); undo(event.shiftKey || event.key.toLowerCase() === 'y') }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  function renderDocumentPane(paneDoc: FlowDocument | null, group: GroupId) {
    if (!paneDoc) {
      return <div className="flow-empty is-pane"><span className="flow-empty-icon">◇</span><p>此组未打开文档</p></div>
    }
    const paneScript = isScriptDocument(paneDoc)
    const paneShop = paneDoc.package === 'shop'
    const paneKit = isKitDocument(paneDoc)
    const paneProgress = isSimpleQuestDocument(paneDoc)
    const paneNavigation = isNavigationDocument(paneDoc)
    const paneEntityTable = isEntityLibraryTableKey(paneDoc.key)
    const paneItemTable = isItemLibraryTableKey(paneDoc.key)
    const paneEntity = isEntityDocument(paneDoc)
    const paneItem = isItemDocument(paneDoc)
    const paneKitParsed = paneKit ? readKitSource(paneDoc.source) : null
    const paneProgressParsed = paneProgress ? readProgressSource(paneDoc.source, goalCatalog.definitions) : null
    const paneNavigationParsed = paneNavigation ? readNavigationSource(paneDoc.source) : null
    const paneItemParsed = paneItem ? readItemSource(paneDoc.source) : null
    const paneCatalogOptions = kitCatalog.options.filter((option) => option.ref !== kitRefFromFileName(paneDoc.name))
    const paneCatalog = new Map(kitCatalog.map)
    const selfRef = kitRefFromFileName(paneDoc.name)
    if (selfRef) paneCatalog.delete(selfRef)
    let paneFlow: ProgressFlow | null = null
    let paneError = ''
    if (!paneShop && !paneScript && !paneKit && !paneProgress && !paneNavigation && !paneItem && !paneEntity && !paneItemTable && !paneEntityTable) {
      // 焦点文档复用 memo 过的 parse，避免父级重渲染换掉 flow 引用打断拖拽
      if (paneDoc.key === focusedKey && parsed.flow) paneFlow = parsed.flow
      else {
        try { paneFlow = parseFlow(paneDoc.source) }
        catch (error) { paneError = error instanceof Error ? error.message : String(error) }
      }
      if (paneDoc.key === focusedKey && parsed.error) paneError = parsed.error
    }
    const paneIssues = paneFlow ? validateFlow(paneFlow, goalCatalog.definitions) : []
    const paneErrors = paneIssues.filter((issue) => issue.severity === 'error').length + (paneError ? 1 : 0)
    const paneWarnings = paneIssues.filter((issue) => issue.severity === 'warning').length
    const paneCycle = paneIssues.find((issue) => issue.path === 'graph' && issue.message.includes('环'))
    // 同一文档可同时开在两组，画布交互只交给焦点组
    const graphLive = group === focusedGroup
    const disabledPane = Boolean(paneDoc.detached) || locked || busy || readOnly || (paneProgress && !graphLive)

    if (paneShop) return <ShopEditor key={paneDoc.key} source={paneDoc.source} disabled={disabledPane} onChange={source => changeSource(source, false, paneDoc.key)} itemCatalog={itemCatalog} resolveText={paneDoc.key === focusedKey ? resolveLocaleText : undefined} setText={paneDoc.key === focusedKey ? setLocaleText : undefined}
      scriptOptions={state.documents.filter(d => d.package === 'script' && scriptTypeInFolder(state, d.folderId ?? null) === 'shop').map(d => ({ ref: d.name.replace(/\.py$/i, ''), label: d.name, key: d.key }))}
      onOpenScript={key => selectDocument(key)} />
    if (paneProgress && paneProgressParsed) {
      if (!paneProgressParsed.doc) return <ProgressSourceRepair key={paneDoc.key} source={paneDoc.source} error={paneProgressParsed.error} disabled={disabledPane}
        onApply={source => { if (!disabledPane) changeSource(source, false, paneDoc.key) }} />
      if (progressSourceKey === paneDoc.key) {
        return <div className="flow-source-pane flow-script-pane" aria-label=".quest 源码">
          <div className="flow-script-readonly-bar">
            <span>只读 · .quest JSON（单进度）</span>
            <button type="button" onClick={() => setProgressSourceKey(null)}>返回表单</button>
          </div>
          <div className="flow-script-editor">
            <Editor
              height="100%"
              language="json"
              theme={HANSHU_THEME_ID}
              value={progressEditorSession(client, sourcePathOf({ name: paneDoc.name }))?.getSnapshot().view.source ?? paneDoc.source}
              path={`progress-source://g${group}/${paneDoc.key}/${paneDoc.name}`}
              beforeMount={registerHanshuLanguage}
              options={{ fontSize: editorFontSize, mouseWheelZoom: true, minimap: { enabled: false }, wordWrap: 'on', automaticLayout: true, scrollBeyondLastLine: false, padding: { top: 8 }, readOnly: true, domReadOnly: true }}
            />
          </div>
        </div>
      }
      return <div className="flow-kit-pane">
        {client && <ProgressCollaborativeEditor
          key={paneDoc.key}
          client={client}
          detached={paneDoc.detached}
          path={sourcePathOf({ name: paneDoc.name })}
          name={paneDoc.name}
          source={paneDoc.source}
          locale={locale}
          initialSeeds={pendingSeedsRef.current.get(paneDoc.key)}
          onCreated={() => pendingSeedsRef.current.delete(paneDoc.key)}
          goalCatalog={goalCatalog}
          kitOptions={kitCatalog.options}
          disabled={disabledPane}
          onOpenKit={(key) => {
            updateGroups((previous) => openOppositeToKey(previous, paneDoc.key, key, focusedGroup))
            setProgressSourceKey(null)
            setNotice('')
          }}
        />}
      </div>
    }
    if (paneNavigation && paneNavigationParsed) {
      return <div className="flow-kit-pane">
        <NavigationEditor
          key={paneDoc.key}
          point={paneNavigationParsed.point}
          error={paneNavigationParsed.error}
          disabled={disabledPane}
          resolveText={paneDoc.key === focusedKey ? resolveLocaleText : undefined}
          setText={paneDoc.key === focusedKey ? setLocaleText : undefined}
          onChange={(source) => { if (!disabledPane) changeSource(source, true, paneDoc.key) }}
        />
      </div>
    }
    if(paneEntityTable)return <EntityLibraryTable active={active} documents={state.documents} onOpen={key=>updateGroups(previous=>openOppositeToKey(previous,ENTITY_LIBRARY_TABLE_KEY,key,focusedGroup))}/>
    if(paneEntity)return <div className="flow-kit-pane"><LocalizedEntityEditor name={paneDoc.name} locale={locale} onLocaleChange={tag=>{setLocale(tag);saveLocale(tag)}} key={`${client?.snapshot.projectId??''}/${paneDoc.key}`} documentKey={paneDoc.key} source={paneDoc.source} disabled={disabledPane} active={active} onChange={source=>{if(!disabledPane)changeSource(source,false,paneDoc.key)}}/></div>
    if (paneItemTable) {
      return <div className="flow-kit-pane">
        <ItemLibraryTable
          documents={state.documents}
          folderLabel={(document) => folderPath(state, document.package, document.folderId ?? null)}
          onOpen={openItemFromTable}
        />
      </div>
    }
    if (paneItem && paneItemParsed) {
      if (progressSourceKey === paneDoc.key) {
        return <div className="flow-source-pane flow-script-pane" aria-label=".item 源码">
          <div className="flow-script-readonly-bar">
            <span>只读 · .item JSON</span>
            <button type="button" onClick={() => setProgressSourceKey(null)}>返回编辑器</button>
          </div>
          <div className="flow-script-editor">
            <Editor
              height="100%"
              language="json"
              theme={HANSHU_THEME_ID}
              value={paneDoc.source}
              path={`progress-item-source://g${group}/${paneDoc.key}/${paneDoc.name}`}
              beforeMount={registerHanshuLanguage}
              options={{ fontSize: editorFontSize, mouseWheelZoom: true, minimap: { enabled: false }, wordWrap: 'on', automaticLayout: true, scrollBeyondLastLine: false, padding: { top: 8 }, readOnly: true, domReadOnly: true }}
            />
          </div>
        </div>
      }
      return <div className="flow-kit-pane">
        <LocalizedItemEditor
          name={paneDoc.name} locale={locale} onLocaleChange={tag=>{setLocale(tag);saveLocale(tag)}}
          key={paneDoc.key}
          doc={paneItemParsed.doc}
          onEditInGame={()=>{void openItemInGame(paneDoc.key)}}
          error={paneItemParsed.error}
          disabled={disabledPane}
          onChange={(source) => { if (!disabledPane) changeSource(source, true, paneDoc.key) }}
        />
      </div>
    }
    if (paneKit && paneKitParsed) {
      return <div className="flow-kit-pane">
        <KitEditor
          key={paneDoc.key}
          kit={paneKitParsed.kit}
          scriptOptions={state.documents.filter(d=>d.package==='script'&&scriptTypeInFolder(state,d.folderId??null)==='kit').map(d=>({ref:d.name.replace(/\.py$/i,''),label:d.name,key:d.key}))}
          onOpenScript={key=>selectDocument(key)}
          onCreateScript={source=>{
            setState(previous=>{
              const folderId=sectionFolderKey('script',scriptSection('kit'))
              const name=uniqueDocumentName(previous,`${paneDoc.name.replace(/\.kit$/i,'')}-发放脚本.py`,'script',folderId)
              const created=stampDocument({key:randomId(),name,source:source??scriptTemplate('kit','default.py',name.replace(/\.py$/i,'')),package:'script',folderId})
              const documents=previous.documents.map(d=>d.key===paneDoc.key?{...d,source:stringifyKit({...paneKitParsed.kit,script:[...(Array.isArray(paneKitParsed.kit.script)?paneKitParsed.kit.script:typeof paneKitParsed.kit.script==='string'?[]:paneKitParsed.kit.script.ref?[paneKitParsed.kit.script]:[]),{ref:name.replace(/\.py$/i,'')}]})}:d)
              return openInGroup({...previous,documents:[...documents,created]},group,created.key)
            })
          }}
          error={paneKitParsed.error}
          selfRef={selfRef}
          catalog={paneCatalog}
          catalogOptions={paneCatalogOptions}
          itemCatalog={itemCatalog}
          disabled={disabledPane}
          resolveText={paneDoc.key === focusedKey ? resolveLocaleText : undefined}
          setText={paneDoc.key === focusedKey ? setLocaleText : undefined}
          onChange={(source) => { if (!disabledPane) changeSource(source, true, paneDoc.key) }}
        />
      </div>
    }
    if (paneScript) {
      const builtinScript = isBuiltinScriptDocumentKey(paneDoc.key)
      return <div className="flow-source-pane flow-script-pane">
        {builtinScript && <p className="flow-banner is-info" role="status">内置脚本（只读）</p>}
        <div className="flow-script-editor">
          <PythonEditor
            scriptType={scriptTypeInFolder(state,paneDoc.folderId??null)}
            height="100%"
            language="python"
            theme={HANSHU_THEME_ID}
            value={paneDoc.source}
            path={`progress-script://g${group}/${paneDoc.key}/${paneDoc.name}`}
            beforeMount={registerHanshuLanguage}
            onChange={(value) => { if (!disabledPane && !builtinScript) changeSource(value ?? '', true, paneDoc.key) }}
            options={{ fontSize: editorFontSize, mouseWheelZoom: true, minimap: { enabled: false }, wordWrap: 'on', automaticLayout: true, scrollBeyondLastLine: false, padding: { top: 8 }, readOnly: disabledPane || builtinScript }}
          />
        </div>
      </div>
    }
    return <>
      {paneFlow ? (
        <ProgressGraph
          key={paneDoc.key}
          flow={paneFlow}
          selection={graphLive ? selection : { kind: 'flow' }}
          onSelect={(next) => { if (graphLive) setSelection(next) }}
          onCreate={graphLive ? createNode : () => undefined}
          onChangeFlow={graphLive ? (next) => changeFlow(next) : () => undefined}
          definitions={goalCatalog.definitions}
          kitOptions={kitCatalog.options}
          setText={paneDoc.key === focusedKey ? setLocaleText : undefined}
          onMove={graphLive ? moveCanvasSelection : () => undefined}
          onGroup={graphLive ? groupCanvasSelection : () => null}
          onUngroup={graphLive ? ungroupCanvasSelection : () => undefined}
          onRenameGroup={graphLive ? renameGroup : () => undefined}
          onDelete={graphLive ? deleteNode : () => undefined}
          onDeleteMany={graphLive ? deleteNodes : () => undefined}
          onArrange={graphLive ? arrangeSelection : () => undefined}
          onUpdateNote={graphLive ? updateNote : () => undefined}
          resolveText={paneDoc.key === focusedKey ? (key) => textMapRef.current?.get(key) ?? null : undefined}
          onConnect={graphLive ? connectCanvasNodes : () => undefined}
          onDisconnect={graphLive ? disconnectCanvasLink : () => undefined}
          onCut={graphLive ? disconnectCanvasLinks : () => undefined}
          active={active && graphLive}
          disabled={locked || busy || readOnly || !graphLive}
        />
      ) : (
        <div className="flow-source-pane">
          <div className="flow-source-heading"><strong>草稿无法显示为画布</strong><span className="flow-hint">{paneError}</span></div>
          <textarea className="flow-source flow-code" aria-label="修复草稿源码" value={paneDoc.source} disabled={locked || busy} onChange={(event) => changeSource(event.target.value, true, paneDoc.key)} spellCheck={false} />
        </div>
      )}
      <div className={`flow-validation${paneCycle ? ' has-cycle' : ''}`}>
        <button type="button" className="flow-validation-toggle" aria-expanded={graphLive && showIssues} onClick={() => { if (graphLive) setShowIssues(!showIssues) }}>
          <span className={paneErrors ? 'flow-error' : paneCycle ? 'flow-warning' : 'flow-valid'}>
            {paneErrors ? `${paneErrors} 个结构错误` : paneCycle ? '画布连线存在环' : '草稿结构校验通过'}
          </span>
          <span>{paneCycle ? '环路警告 · ' : ''}{paneWarnings ? `${paneWarnings} 条设计提示` : '结构检查'} {graphLive && showIssues ? '▾' : '▴'}</span>
        </button>
        {graphLive && showIssues && <div className="flow-issues">
          {paneError && <p className="flow-error">{paneError}</p>}
          {paneIssues.map((issue, index) => <p key={index} className={issue.severity === 'error' ? 'flow-error' : 'flow-warning'}><code>{issue.path}</code> {issue.message}</p>)}
          <p className="flow-hint">开始进度始终保留；进度、条件、目标、逻辑、结束节点可自由创建和删除。逻辑使用“并且 / 或者”组合输入；条件提供当前真值，目标随任务启动。画布不允许成环。</p>
        </div>}
      </div>
    </>
  }

  function renderGroup(id: GroupId) {
    const group = readGroup(state, id)
    const docs = group.openKeys.map((key) => docByKey.get(key)).filter((item): item is FlowDocument => !!item)
    const paneDoc = group.activeKey ? docByKey.get(group.activeKey) ?? null : null
    const focused = id === focusedGroup
    const hint = dropTarget?.group === id && (dropTarget.zone !== 'center' || pageDrag?.group !== id) ? dropTarget.zone : null
    const other: GroupId = id === 0 ? 1 : 0
    return <div
      className={`flow-group${splitOn && focused ? ' is-focused' : ''}`}
      onPointerDownCapture={() => focusEditorGroup(id)}
      onFocusCapture={() => focusEditorGroup(id)}
    >
      <PageList
        docs={docs}
        activeKey={group.activeKey}
        pinnedKeys={group.pinnedKeys}
        focused={!splitOn || focused}
        splitOn={splitOn}
        disabled={locked || busy}
        dragKey={pageDrag?.key ?? null}
        onSelect={(key) => selectDocument(key, id)}
        onClose={(key) => updateGroups((previous) => closeInGroup(previous, id, [key]))}
        onCloseOthers={(key) => updateGroups((previous) => closeOthersInGroup(previous, id, key))}
        onCloseRight={(key) => updateGroups((previous) => closeRightInGroup(previous, id, key))}
        onCloseAll={() => updateGroups((previous) => closeAllInGroup(previous, id))}
        onTogglePin={(key) => updateGroups((previous) => togglePinInGroup(previous, id, key))}
        onDragStart={(key) => setPageDrag({ key, group: id })}
        onDragEnd={() => { setPageDrag(null); setDropTarget(null) }}
        onDropTab={(beforeKey) => dropPage(id, 'center', beforeKey)}
        onSplit={(key, zone) => updateGroups((previous) => splitTab(previous, key, zone, 'copy'))}
        onMoveToOther={(key) => updateGroups((previous) => moveTab(previous, id, other, key, null))}
        onJoin={() => updateGroups(joinGroups)}
      />
      <div className="flow-group-body">
        {paneDoc?.detached&&<div role="status">资源已从工程移除，草稿仅保留在本机；普通保存不会重新创建它。<button type="button" onClick={()=>downloadFlowFile(`${paneDoc.name}.draft`,paneDoc.source)}>导出保留的草稿</button></div>}
        {renderDocumentPane(paneDoc, id)}
        {pageDrag && !locked && !busy && (
          <div
            className="flow-drop-target"
            onDragOver={(event) => {
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              const zone = dropZoneAt(event, splitOn)
              if (dropTarget?.group !== id || dropTarget.zone !== zone) setDropTarget({ group: id, zone })
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null)
            }}
            onDrop={(event) => {
              event.preventDefault()
              event.stopPropagation()
              dropPage(id, dropZoneAt(event, splitOn))
            }}
          >
            {hint && <div className={`flow-drop-hint is-${hint}`} />}
          </div>
        )}
      </div>
    </div>
  }

  return <section className="gameplay-workspace" aria-label="游戏性工作区">
    <input ref={fileInput} type="file" multiple hidden onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void importFiles(files) }} />
    <div className="flow-layout">
      <FlowExplorer onOverrideBuiltinScript={key=>{const d=state.documents.find(d=>d.key===key);if(!d)return;const type=scriptTypeInFolder(state,d.folderId??null);newFlow(d.name,sectionFolderKey('script',scriptSection(type)),'script','default.py',d.source)}} readOnly={readOnly} state={explorerState} active={active} disabled={locked || busy} onChange={(next) => setState((previous) => normalizeGroups({ ...previous, documents: next.documents, folders: next.folders }))} onSelect={(key) => selectDocument(key)} onNew={newFlow} onImport={requestImport} onImportFiles={(files, folderId, packageId) => { void importFiles(files, { folderId, package: packageId }) }} onExport={exportFlow} onDownload={downloadDraft} onRemove={removeResources} onProperties={setPropertiesKey} onViewSource={viewProgressSource} onOpenEntityInGame={key=>{void openEntityInGame(key)}} onOpenItemInGame={(key) => { void openItemInGame(key) }} onNotice={setNotice} />
      <main className="flow-main">
        {active && client && presencePath && <FilePresenceBar key={`${client.snapshot.session.id}:${presencePath}`} client={client} path={presencePath} mode="optimistic" label={doc?.name} />}
        {state.split ? (
          <EditorSplit
            direction={state.split.direction}
            ratio={state.split.ratio}
            disabled={locked || busy}
            onRatio={(ratio) => setState((previous) => setSplitRatio(previous, ratio))}
            primary={renderGroup(0)}
            secondary={renderGroup(1)}
          />
        ) : (state.openKeys ?? []).length ? renderGroup(0) : (
          <div className="flow-empty"><span className="flow-empty-icon">◇</span><h2>设计一个任务</h2><p>在左侧「任务」分类中新建或导入 .quest（单进度表单或多进度树图）；「脚本」可新建 .py；「导航器」可新建 .nav 导航点；「物品库」可新建 .item 或拖入 .itemstack；「礼包」可新建 .kit。打开的文档会出现在上方页条；把页拖到编辑区的左右上下边缘即可拆分对照。</p></div>
        )}
      </main>
    </div>
    <StatusBarSlots
      active={active}
      left={
        <span>{storageError ? (projectBound ? '保存异常' : '未打开工程') : projectBound ? (busy ? '正在保存…' : 'Ctrl+S 保存到工程目录') : '需要工程目录'}{locked && projectBound ? ' · 正在编辑' : ''}{splitOn ? ' · 二分编辑' : ''}</span>
      }
      right={
        <>
          {(progressDoc || shopDoc || flowLocalizable || kitDoc || navigationDoc || itemDoc || entityDoc) && (
            <LocaleSelect
              value={locale}
              onChange={(tag) => { setLocale(tag); saveLocale(tag) }}
            />
          )}
          <span className="flow-statusbar-type">{itemTableDoc ? (doc&&isEntityLibraryTableKey(doc.key)?'实体库 · 网格表视图':'物品库 · 表视图') : entityDoc ? '实体 · .entity' : itemDoc ? '物品 · .item' : navigationDoc ? '导航点 · .nav' : progressDoc ? '单进度任务 · .quest' : multiQuestDoc ? '多进度任务 · .quest' : shopDoc ? '商店 · .shop' : kitDoc ? '礼包 · .kit' : scriptDoc ? '脚本 · Python' : doc && isQuestDocument(doc) ? '任务 · .quest' : '任务'}</span>
        </>
      }
    />
    {propertiesDoc && active && <FlowDocumentProperties key={propertiesDoc.key} doc={propertiesDoc} onSave={(next) => saveProperties(propertiesDoc.key, next)} onCancel={() => setPropertiesKey(null)} />}
    {createPortal(<dialog ref={cycleDialog} className="flow-alert-dialog" aria-labelledby="flow-cycle-alert-title" onCancel={(event) => { event.preventDefault(); setCycleAlert(null) }}>
      <header><strong id="flow-cycle-alert-title">画布连线成环</strong></header>
      <div className="flow-alert-body">
        <p className="flow-warning">{cycleAlert}</p>
        <p className="flow-hint">这是结构错误：画布连线不能成环。请断开环上的某条连线，否则校验不会通过。</p>
      </div>
      <footer>
        <button type="button" onClick={() => { setShowIssues(true); setCycleAlert(null) }}>查看问题列表</button>
        <button type="button" className="flow-primary" onClick={() => setCycleAlert(null)}>知道了</button>
      </footer>
    </dialog>, document.body)}
  </section>
}

function ProgressSourceRepair({ source, error, disabled, onApply }: { source: string; error: string; disabled: boolean; onApply: (source: string) => void }) {
  const [draft, setDraft] = useState(source)
  const [message, setMessage] = useState(error)
  return <div className="progress-source-repair"><h3>单进度任务需要修复</h3><p role="alert">{message}</p>
    <span>原始文件已保留。修复并通过校验后才会应用，不会以默认文档覆盖原文。</span>
    <textarea aria-label="任务源码修复" spellCheck={false} value={draft} disabled={disabled} onChange={event => setDraft(event.target.value)} />
    <button type="button" disabled={disabled} onClick={() => { try { parseProgress(draft); onApply(draft) } catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)) } }}>校验并应用修复</button>
  </div>
}

