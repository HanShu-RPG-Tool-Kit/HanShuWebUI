import type { FileEdit, ProjectDirectory } from '../../project/serviceClient'
import { ServiceError } from '../../collab/protocol'
import { entryRef, folderRef, libraryCommand, type SkinLibraryCommand } from './libraryCommands'
import { entrySubmissionState, SKIN_INDEX_PATH, type SkinEntryCommand } from './entrySubmission'
/**
 * Skin library session under project `.hanshu/skinmanager`
 */

import { SkinApiError } from '../contracts/types'
import type {
  CreateFolderRequest,
  BatchPatchRequest,
  FolderNode,
  FolderScopeSnapshot,
  EntrySource,
  ImportJob,
  LibraryEntry,
  LibraryQuery,
  PatchEntryRequest,
  PatchFolderRequest,
  SaveEntryRequest,
  SkinEvent,
  SkinModel,
} from '../contracts/types'
import {
  buildC,
  decodeDiskFile,
  decodeShareCode,
  encodeDiskFile,
  encodeShareCode,
  isValidSkinId,
  skinIdOf,
  type DecodedSkin,
} from './codec'
import {
  ensureDir,
  listChildNames,
  readBytesAt,
} from './fsIo'
import {
  collectTags,
  collectTextureSizes,
  emptyLibrary,
  emptyLicense,
  emptyProvenance,
  folderDescendants,
  foldersWithStats,
  normalizeCustomId,
  normalizeTagName,
  nowIso,
  parseLibraryJson,
  queryEntries,
  resolveEntryTags,
  uid,
  type LibraryFile,
} from './library'
import { fetchPlayerSkinPng, fetchPngBytes } from './net'
import { normalizePngBytes, rgbaToPngBlob } from './normalize'
import {
  CACHE_PNG_DIR,
  OBJECTS_DIR,
  SCHEMA_VERSION,
  SKIN_ROOT,
  TMP_DIR,
} from './paths'

type ImportJobsSnapshot = { jobs: ImportJob[]; seq: number; sources: Array<[string, EntrySource]> }
// A remote index refresh replaces SkinLibrarySession, not the user's open import
// queue. Keep all prepared jobs in this window even when recovery storage is full.
const importJobsByClient = new WeakMap<ProjectDirectory['client'], ImportJobsSnapshot>()

function objectPath(skinId: string): string {
  return `${SKIN_ROOT}/${OBJECTS_DIR}/${skinId.slice(0, 2)}/${skinId}.skin`
}

function emitJob(job: ImportJob): SkinEvent {
  return {
    type: 'job-updated',
    jobId: job.jobId,
    seq: job.seq,
    state: job.state,
  }
}

export class SkinLibrarySession {
  private root: ProjectDirectory
  private lib: LibraryFile = emptyLibrary()
  private libVersion: string | null = null
  private needsLibraryRefresh = false
  private readableLib: LibraryFile | null = null
  private mutationTail: Promise<unknown> = Promise.resolve()
  private pendingDomain: 'entries' | 'tags' | 'folders' | null = null
  private pendingObjects = new Map<string, DecodedSkin>()

  /** Mutations work on a private copy; queries only see the last acknowledged index. */
  private mutateLibrary<T>(action: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(async () => {
      this.ensureReady()
      if (this.needsLibraryRefresh) {
        const raw = await this.readLibrary()
        if (!raw) throw new SkinApiError({ code: 'NOT_FOUND', message: '皮肤库已被删除，请刷新工程' })
        this.lib = this.parseCurrentLibrary(raw)
        this.needsLibraryRefresh = false
      }
      const previous = this.lib
      const previousVersion = this.libVersion
      this.lib = structuredClone(previous)
      this.readableLib = previous
      try {
        const result = await action()
        this.readableLib = null
        if (this.pendingDomain) this.emit({ type: 'library-updated', revision: this.lib.revision, domain: this.pendingDomain })
        return result
      } catch (error) {
        this.lib = previous
        this.libVersion = previousVersion
        throw error
      } finally { this.readableLib = null; this.pendingDomain = null }
    })
    this.mutationTail = run.catch(() => undefined)
    return run
  }
  private get visibleLibrary() { return this.readableLib ?? this.lib }

  renameTag(from: string, to: string) { return this.mutateLibrary(() => this.renameTagDraft(from, to)) }
  deleteTag(name: string) { return this.mutateLibrary(() => this.deleteTagDraft(name)) }
  createFolder(body: CreateFolderRequest) { return this.mutateLibrary(() => this.createFolderDraft(body)) }
  patchFolder(id: string, body: PatchFolderRequest) { return this.mutateLibrary(() => this.patchFolderDraft(id, body)) }
  deleteFolder(id: string, expected?: FolderNode) { return this.mutateLibrary(() => this.deleteFolderDraft(id, expected)) }
  saveEntry(body: SaveEntryRequest) { return this.mutateLibrary(() => this.saveEntryDraft(body)) }
  patchEntry(id: string, body: PatchEntryRequest) { return this.mutateLibrary(() => this.patchEntryDraft(id, body)) }
  batchPatchEntries(body: Parameters<SkinLibrarySession['batchPatchEntriesDraft']>[0]) { return this.mutateLibrary(() => this.batchPatchEntriesDraft(body)) }
  deleteEntry(id: string, revision?: number) { return this.mutateLibrary(() => this.deleteEntryDraft(id, revision)) }
  deleteEntriesInFolder(id: string, scope?: FolderScopeSnapshot) { return this.mutateLibrary(() => this.deleteEntriesInFolderDraft(id, scope)) }
  gcOrphans(progress?: Parameters<SkinLibrarySession['gcOrphansDraft']>[0]) { return this.mutateLibrary(() => this.gcOrphansDraft(progress)) }
  private jobs = new Map<string, ImportJob>()
  private jobSources = new Map<string, EntrySource>()
  /** ?????????????? encode ??? */
  private jobDecoded = new Map<string, DecodedSkin>()
  private jobSeq = 0
  private listeners = new Set<(e: SkinEvent) => void>()
  private previewUrls = new Map<string, string>()
  private ready = false
  private disposed = false
  private persistJobsTimer: ReturnType<typeof setTimeout> | null = null
  private jobsLoaded = false

  private get jobsStorageKey(): string | null {
    const client = this.root.client
    if (typeof sessionStorage === 'undefined' || !client.connection || !client.snapshot?.session) return null
    return `hanshu.skinImportJobs.v1:${JSON.stringify([
      client.connection.url, client.snapshot.projectId, client.snapshot.session.subjectId, this.root.resolve(SKIN_ROOT),
    ])}`
  }

  constructor(root: ProjectDirectory) {
    this.root = root
  }

  isReady(): boolean {
    return this.ready
  }

  async init(): Promise<void> {
    await ensureDir(this.root, SKIN_ROOT)
    await ensureDir(this.root, `${SKIN_ROOT}/${OBJECTS_DIR}`)
    await ensureDir(this.root, `${SKIN_ROOT}/${CACHE_PNG_DIR}`)
    await ensureDir(this.root, `${SKIN_ROOT}/${TMP_DIR}`)
    const raw = await this.readLibrary()
    if (raw) {
      this.lib = this.parseCurrentLibrary(raw)
    } else {
      this.lib = emptyLibrary()
      if (this.root.client.writable) await this.command({ command: 'ensure-library' }, '初始化皮肤库', 'folders')
    }
    await this.loadJobs()
    this.ready = true
  }

  private async loadJobs(): Promise<void> {
    if (this.disposed) return
    try {
      const cached = importJobsByClient.get(this.root.client)
      const key = this.jobsStorageKey
      const raw = !cached && key ? sessionStorage.getItem(key) : null
      if (!cached && !raw) return
      const data = (cached ? structuredClone(cached) : JSON.parse(raw!)) as Partial<ImportJobsSnapshot>
      if (Array.isArray(data.jobs)) {
        this.jobs.clear()
        for (const job of data.jobs) {
          if (typeof job?.jobId !== 'string' || !Number.isSafeInteger(job.seq)) continue
          // A disposed view cannot resume network/decoder work. Ready jobs retain
          // their share code, so they can still be saved after a library refresh.
          if (!['ready', 'failed', 'cancelled'].includes(job.state)) {
            job.state = 'failed'
            job.error = { code: 'IMPORT_INTERRUPTED', message: '导入准备已中断，请重新添加来源。' }
          }
          this.jobs.set(job.jobId, job)
        }
      }
      this.jobSources.clear()
      if (Array.isArray(data.sources)) {
        for (const pair of data.sources) {
          if (Array.isArray(pair) && pair.length === 2 && this.jobs.has(pair[0]) && typeof pair[1]?.kind === 'string') this.jobSources.set(pair[0], pair[1])
        }
      }
      if (Number.isSafeInteger(data.seq) && data.seq! >= 0) this.jobSeq = data.seq!
    } catch (error) {
      console.warn('[hanshu] 本窗口导入准备记录无法恢复，请重新添加来源', error)
    } finally {
      this.jobsLoaded = true
    }
  }

  private schedulePersistJobs(): void {
    if (this.persistJobsTimer != null) return
    this.persistJobsTimer = setTimeout(() => {
      this.persistJobsTimer = null
      void this.persistJobsNow().catch(error => console.warn('[hanshu] 本窗口导入准备记录保存失败；已提交操作仍由工程提交记录恢复', error))
    }, 400)
  }

  private async persistJobsNow(): Promise<void> {
    if (this.disposed || !this.jobsLoaded) return
    const allJobs = [...this.jobs.values()].sort((a, b) => b.seq - a.seq)
    importJobsByClient.set(this.root.client, structuredClone({ seq: this.jobSeq, jobs: allJobs, sources: [...this.jobSources] }))
    const key = this.jobsStorageKey
    if (!key) return
    const jobs = allJobs.slice(0, 50)
    const ids = new Set(jobs.map(job => job.jobId))
    const sources = [...this.jobSources].filter(([id]) => ids.has(id))
    sessionStorage.setItem(key, JSON.stringify({ seq: this.jobSeq, jobs, sources }))
  }

  /** @deprecated use schedulePersistJobs; kept name for call sites */
  private async persistJobs(): Promise<void> {
    this.schedulePersistJobs()
  }

  private ensureReady() {
    if (!this.ready || this.disposed) {
      throw new SkinApiError({
        code: 'NOT_READY',
        message: 'Skin library is not ready',
      })
    }
  }

  private parseCurrentLibrary(raw: string): LibraryFile {
    if (JSON.parse(raw).schemaVersion !== SCHEMA_VERSION) throw new SkinApiError({ code: 'UNSUPPORTED_SCHEMA', message: '皮肤库版本不受支持，请先转换工程；客户端不会自动改写索引' })
    return parseLibraryJson(raw)
  }

  private emit(event: SkinEvent) {
    for (const l of this.listeners) {
      try {
        l(event)
      } catch {
        // ignore
      }
    }
  }

  private async readLibrary(): Promise<string | null> {
    try {
      const { file, version } = await this.root.client.readSnapshot(this.root.resolve(SKIN_INDEX_PATH))
      const raw = await file.text()
      this.libVersion = version
      return raw
    } catch (error) {
      if (error instanceof ServiceError && error.code === 'not_found') { this.libVersion = null; return null }
      throw error
    }
  }

  /** Freeze intent, then let S validate and update its current library atomically. */
  private async command<T>(command: SkinLibraryCommand, label: string, domain: 'entries' | 'tags' | 'folders', extra: FileEdit[] = []): Promise<T> {
    if (this.disposed) throw new Error('皮肤工程会话已关闭，未提交修改')
    const client = this.root.client
    const data = JSON.stringify(command)
    const edits: FileEdit[] = [...extra, { op: 'skin-library-command', path: this.root.resolve(SKIN_INDEX_PATH), data, version: this.libVersion }]
    const pending = client.transactions.getSnapshot().transactions.find(transaction => transaction.phase !== 'saved' && client.transactions.submission(transaction.id).some(edit => {
      const previous = libraryCommand(edit)
      if (!previous || edit.path !== this.root.resolve(SKIN_INDEX_PATH)) return false
      return edit.data === data || (command.command === 'import-entry' && previous.command === 'import-entry' && previous.entry.entryId === command.entry.entryId)
    }))
    if (pending) {
      const same = client.transactions.submission(pending.id).some(edit => edit.op === 'skin-library-command' && edit.data === data)
      if (!same) throw new ServiceError('pending_transaction', '存在参数不同的原导入，请先在提交列表处理原操作；不能修改原提交后直接重发')
      await client.transactions.retry(pending.id)
    } else await client.apply(edits, label)
    const result = client.skinLibraryResult(data)
    if (!result) throw new ServiceError('commit_uncertain', '未能载入皮肤操作的确认结果，请查询原提交')
    this.needsLibraryRefresh = true
    try {
      const raw = await this.readLibrary()
      if (raw) { this.lib = this.parseCurrentLibrary(raw); this.needsLibraryRefresh = false }
    } catch { /* An acknowledged operation stays successful; refresh before the next mutation. */ }
    if (this.readableLib) this.pendingDomain = domain
    else this.emit({ type: 'library-updated', revision: this.lib.revision, domain })
    return structuredClone(result) as T
  }

  private expectedEntry(entryId: string, revision?: number) {
    const entry = this.lib.entries.find(item => item.entryId === entryId)
    if (revision === undefined && !entry) throw new SkinApiError({ code: 'NOT_FOUND', message: '皮肤条目不存在，请刷新列表' })
    return { entryId, revision: revision ?? entry!.revision }
  }

  private expectedFolder(folderId: string, expected?: FolderNode): FolderNode {
    const folder = expected ?? this.lib.folders.find(item => item.folderId === folderId)
    if (!folder || folder.folderId !== folderId) throw new SkinApiError({ code: 'NOT_FOUND', message: '文件夹不存在，请刷新列表' })
    return folderRef(folder)
  }

  private previewCachePath(skinId: string): string {
    return `${SKIN_ROOT}/${CACHE_PNG_DIR}/${skinId}.png`
  }

  /** Import validation is local. The object and its index entry are written together on save. */
  private async putDecoded(decoded: DecodedSkin): Promise<{ skinId: string; decoded: DecodedSkin }> {
    if (this.disposed) throw new Error('皮肤工程会话已关闭')
    const skinId = await skinIdOf(buildC(decoded.flags, decoded.width, decoded.height, decoded.rgba))
    this.pendingObjects.set(skinId, decoded)
    return { skinId, decoded }
  }

  private async readObject(skinId: string): Promise<DecodedSkin | null> {
    if (!isValidSkinId(skinId)) return null
    if (this.pendingObjects.has(skinId)) return this.pendingObjects.get(skinId)!
    const raw = await readBytesAt(this.root, objectPath(skinId))
    if (!raw) return null
    const { decoded, skinId: verified } = await decodeDiskFile(raw)
    if (verified !== skinId) return null
    return decoded
  }

  subscribe(listener: (e: SkinEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  capabilities() {
    return {
      toolVersion: 'hanshu-fsa',
      apiVersion: '1',
      librarySchemaVersion: SCHEMA_VERSION,
      formatVersion: 1,
      importKinds: [
        'png-file',
        'png-url',
        'player-name',
        'skin-code',
        'skin-file',
      ] as [
        'png-file',
        'png-url',
        'player-name',
        'skin-code',
        'skin-file',
      ],
      liveApply: false,
      features: { batchActive: true, httpApi: false },
    }
  }

  listEntries(query: LibraryQuery) {
    this.ensureReady()
    return queryEntries(this.visibleLibrary, query)
  }

  getEntry(entryId: string): LibraryEntry {
    this.ensureReady()
    const e = this.visibleLibrary.entries.find((x) => x.entryId === entryId)
    if (!e) {
      throw new SkinApiError({ code: 'NOT_FOUND', message: `entry ${entryId}` })
    }
    return e
  }

  listTags() {
    this.ensureReady()
    return {
      revision: this.visibleLibrary.revision,
      tags: collectTags(this.visibleLibrary),
      textureSizes: collectTextureSizes(this.visibleLibrary),
    }
  }

  private async renameTagDraft(from: string, to: string): Promise<{ affectedEntries: number }> {
    const key = normalizeTagName(from)?.toLowerCase()
    return this.command({ command: 'rename-tag', from, to, expectedEntries: this.lib.entries.filter(entry => entry.tags.some(tag => tag.toLowerCase() === key)).map(entryRef) }, '重命名皮肤标签', 'tags')
  }

  private async deleteTagDraft(name: string): Promise<{ affectedEntries: number }> {
    const key = normalizeTagName(name)?.toLowerCase()
    return this.command({ command: 'delete-tag', name, expectedEntries: this.lib.entries.filter(entry => entry.tags.some(tag => tag.toLowerCase() === key)).map(entryRef) }, '删除皮肤标签', 'tags')
  }

  listFolders() {
    this.ensureReady()
    return { revision: this.visibleLibrary.revision, folders: foldersWithStats(this.visibleLibrary) }
  }

  private async createFolderDraft(body: CreateFolderRequest): Promise<FolderNode> {
    const result = await this.command<{ folder: FolderNode }>({ command: 'create-folder', folderId: uid('folder'), name: body.name, parentId: body.parentId ?? null }, '新建皮肤文件夹', 'folders')
    return result.folder
  }

  private async patchFolderDraft(folderId: string, body: PatchFolderRequest): Promise<FolderNode> {
    const { expectedFolder, expectedSiblings, ...changes } = body
    const folder = this.expectedFolder(folderId, expectedFolder)
    const siblings = changes.sortSiblingsByName ? (expectedSiblings ?? this.lib.folders.filter(item => item.parentId === (changes.parentId !== undefined ? changes.parentId : folder.parentId))).map(folderRef) : undefined
    const result = await this.command<{ folder: FolderNode }>({ command: 'patch-folder', expectedFolder: folder, changes, ...(siblings ? { expectedSiblings: siblings } : {}) }, '修改皮肤文件夹', 'folders')
    return result.folder
  }

  private async deleteFolderDraft(folderId: string, expected?: FolderNode): Promise<{ deleted: boolean }> {
    return this.command({ command: 'delete-folder', expectedFolder: this.expectedFolder(folderId, expected) }, '删除空皮肤文件夹', 'folders')
  }

  private failJob(job: ImportJob, e: unknown): void {
    job.state = 'failed'
    job.error = {
      code:
        e instanceof Error && 'code' in e
          ? String((e as { code: string }).code)
          : 'IMPORT_FAILED',
      message: e instanceof Error ? e.message : String(e),
    }
    job.updatedAt = nowIso()
    this.jobs.set(job.jobId, job)
    this.emit(emitJob(job))
    void this.persistJobs()
  }

  private async finishPngImport(
    job: ImportJob,
    bytes: Uint8Array,
    suggestedName: string,
    model: SkinModel | undefined,
    source: EntrySource,
  ): Promise<void> {
    job.state = 'validating'
    job.updatedAt = nowIso()
    this.jobs.set(job.jobId, job)
    const { rgba, model: resolved, textureWidth, textureHeight, flags } =
      await normalizePngBytes(bytes, model)
    const decoded: DecodedSkin = {
      rgba,
      width: textureWidth,
      height: textureHeight,
      flags,
    }
    const { skinId } = await this.putDecoded(decoded)
    this.jobDecoded.set(job.jobId, decoded)
    job.state = 'ready'
    job.result = {
      skinId,
      model: resolved,
      suggestedName: suggestedName.replace(/\.[^.]+$/, '') || 'skin',
      // ?????????????? save ????
      skinCode: (await encodeShareCode(resolved, decoded)).skinCode,
      textureWidth,
      textureHeight,
    }
    job.updatedAt = nowIso()
    this.jobs.set(job.jobId, job)
    this.jobSources.set(job.jobId, source)
    this.emit(emitJob(job))
    this.schedulePersistJobs()
  }

  async startImportFromPng(
    bytes: Uint8Array,
    fileName: string,
    model?: SkinModel,
  ): Promise<{ jobId: string }> {
    this.ensureReady()
    const jobId = uid('job')
    const now = nowIso()
    const job: ImportJob = {
      jobId,
      kind: 'png-file',
      state: 'validating',
      createdAt: now,
      updatedAt: now,
      seq: ++this.jobSeq,
    }
    this.jobs.set(jobId, job)
    try {
      await this.finishPngImport(job, bytes, fileName, model, {
        kind: 'png-file',
        fileName,
      })
    } catch (e) {
      this.failJob(job, e)
    }
    return { jobId }
  }

  async startImportFromUrl(
    url: string,
    model?: SkinModel,
  ): Promise<{ jobId: string }> {
    this.ensureReady()
    const jobId = uid('job')
    const now = nowIso()
    const job: ImportJob = {
      jobId,
      kind: 'png-url',
      state: 'fetching',
      createdAt: now,
      updatedAt: now,
      seq: ++this.jobSeq,
    }
    this.jobs.set(jobId, job)
    this.emit(emitJob(job))
    void this.persistJobs()
    try {
      const { bytes, finalUrl, fileName } = await fetchPngBytes(url)
      await this.finishPngImport(job, bytes, fileName, model, {
        kind: 'png-url',
        url: finalUrl,
      })
    } catch (e) {
      this.failJob(job, e)
    }
    return { jobId }
  }

  async startImportFromPlayerName(name: string): Promise<{ jobId: string }> {
    this.ensureReady()
    const jobId = uid('job')
    const now = nowIso()
    const job: ImportJob = {
      jobId,
      kind: 'player-name',
      state: 'fetching',
      createdAt: now,
      updatedAt: now,
      seq: ++this.jobSeq,
    }
    this.jobs.set(jobId, job)
    this.emit(emitJob(job))
    void this.persistJobs()
    try {
      const { bytes, resolved, fileName } = await fetchPlayerSkinPng(name)
      await this.finishPngImport(job, bytes, fileName, resolved.model, {
        kind: 'player-name',
        playerName: resolved.playerName,
        uuid: resolved.uuid,
      })
    } catch (e) {
      this.failJob(job, e)
    }
    return { jobId }
  }

  async startImportSkinCode(text: string): Promise<{ jobId: string }> {
    this.ensureReady()
    const jobId = uid('job')
    const now = nowIso()
    const job: ImportJob = {
      jobId,
      kind: 'skin-code',
      state: 'validating',
      createdAt: now,
      updatedAt: now,
      seq: ++this.jobSeq,
    }
    this.jobs.set(jobId, job)
    this.emit(emitJob(job))
    void this.persistJobs()
    try {
      const { decoded, model, skinId, skinCode } = await decodeShareCode(
        text.trim(),
      )
      await this.putDecoded(decoded)
      job.state = 'ready'
      job.result = {
        skinId,
        model,
        suggestedName: `skin-${skinId.slice(0, 8)}`,
        skinCode,
        textureWidth: decoded.width,
        textureHeight: decoded.height,
      }
      job.updatedAt = nowIso()
      this.jobs.set(jobId, job)
      this.jobSources.set(jobId, { kind: 'skin-code' })
      this.emit(emitJob(job))
      void this.persistJobs()
    } catch (e) {
      this.failJob(job, e)
    }
    return { jobId }
  }

  /** Import portable `.skin.json` (v1–v3) or binary `.skin`. */
  async startImportSkinFile(
    bytes: Uint8Array,
    fileName?: string,
    model?: SkinModel,
  ): Promise<{ jobId: string }> {
    this.ensureReady()
    const nameLower = (fileName ?? '').toLowerCase()
    const looksJson =
      nameLower.endsWith('.skin.json') ||
      nameLower.endsWith('.json') ||
      (bytes.length > 0 && (bytes[0] === 0x7b || bytes[0] === 0xef))
    if (looksJson) {
      return this.startImportPortableJson(bytes, fileName)
    }
    const { decoded } = await decodeDiskFile(bytes)
    const { skinCode } = await encodeShareCode(model ?? 'classic', decoded)
    return this.startImportSkinCode(skinCode)
  }

  private async startImportPortableJson(
    bytes: Uint8Array,
    fileName?: string,
  ): Promise<{ jobId: string }> {
    const jobId = uid('job')
    const now = nowIso()
    const job: ImportJob = {
      jobId,
      kind: 'skin-file',
      state: 'validating',
      createdAt: now,
      updatedAt: now,
      seq: ++this.jobSeq,
    }
    this.jobs.set(jobId, job)
    this.emit(emitJob(job))
    void this.persistJobs()
    try {
      const text = new TextDecoder().decode(bytes)
      const parsed = JSON.parse(text) as {
        schemaVersion?: number
        name?: string
        skinCode?: string
        model?: SkinModel
        tagPaths?: string[][]
        active?: boolean
        license?: LibraryEntry['license']
        provenance?: LibraryEntry['provenance']
        note?: string
        customId?: string | null
      }
      const version = Number(parsed.schemaVersion ?? 0)
      if (![1, 2, 3].includes(version) || typeof parsed.skinCode !== 'string') {
        throw new SkinApiError({
          code: 'BAD_REQUEST',
          message: 'portable file missing schemaVersion=1|2|3/skinCode',
        })
      }
      const { decoded, model: modelFromCode, skinId, skinCode } =
        await decodeShareCode(parsed.skinCode.trim())
      await this.putDecoded(decoded)
      const model =
        parsed.model === 'slim' || parsed.model === 'classic'
          ? parsed.model
          : modelFromCode
      const suggestedName =
        (typeof parsed.name === 'string' && parsed.name.trim()) ||
        (fileName
          ? fileName.replace(/\.skin\.json$/i, '').replace(/\.json$/i, '')
          : '') ||
        `skin-${skinId.slice(0, 8)}`
      let suggestedCustomId: string | undefined
      try {
        suggestedCustomId = normalizeCustomId(parsed.customId) ?? undefined
      } catch (e) {
        throw new SkinApiError({
          code: 'BAD_REQUEST',
          message: e instanceof Error ? e.message : String(e),
        })
      }
      job.state = 'ready'
      job.result = {
        skinId,
        model,
        suggestedName,
        skinCode,
        textureWidth: decoded.width,
        textureHeight: decoded.height,
        suggestedTagPaths: Array.isArray(parsed.tagPaths)
          ? parsed.tagPaths
          : undefined,
        suggestedActive:
          typeof parsed.active === 'boolean' ? parsed.active : undefined,
        suggestedLicense: parsed.license,
        suggestedProvenance: parsed.provenance,
        suggestedNote:
          typeof parsed.note === 'string' ? parsed.note : undefined,
        suggestedCustomId,
      }
      job.updatedAt = nowIso()
      this.jobs.set(jobId, job)
      this.jobSources.set(jobId, {
        kind: 'skin-file',
        fileName: fileName,
      })
      this.emit(emitJob(job))
      void this.persistJobs()
    } catch (e) {
      this.failJob(job, e)
    }
    return { jobId }
  }

  getImport(jobId: string): ImportJob {
    const job = this.jobs.get(jobId)
    if (!job) {
      throw new SkinApiError({
        code: 'NOT_FOUND',
        message: 'import job not found',
      })
    }
    return job
  }

  listImports(): ImportJob[] {
    return [...this.jobs.values()].sort((a, b) => b.seq - a.seq)
  }

  cancelImport(jobId: string): ImportJob {
    const job = this.getImport(jobId)
    if (
      job.state === 'ready' ||
      job.state === 'failed' ||
      job.state === 'cancelled'
    ) {
      return job
    }
    job.state = 'cancelled'
    job.updatedAt = nowIso()
    this.emit(emitJob(job))
    void this.persistJobs()
    return job
  }

  private async saveEntryDraft(body: SaveEntryRequest): Promise<LibraryEntry> {
    this.ensureReady()
    const job = this.getImport(body.jobId)
    if (job.state !== 'ready' || !job.result) {
      throw new SkinApiError({
        code: 'BAD_REQUEST',
        message: 'import job not ready',
      })
    }
    let { skinId, model } = job.result
    const textureWidth = job.result.textureWidth || 64
    const textureHeight = job.result.textureHeight || 64
    if (body.model) model = body.model
    // Recover a locally prepared object or a persisted share-code job before committing the index.
    if (!(await this.readObject(skinId))) {
      const cached = this.jobDecoded.get(body.jobId)
      if (cached) {
        const put = await this.putDecoded(cached)
        skinId = put.skinId
      } else if (job.result.skinCode) {
        const { decoded } = await decodeShareCode(job.result.skinCode)
        const put = await this.putDecoded(decoded)
        skinId = put.skinId
      } else {
        throw new SkinApiError({
          code: 'BAD_REQUEST',
          message: 'skin object missing for import job',
        })
      }
    }
    const source =
      this.jobSources.get(body.jobId) ??
      (job.kind === 'skin-code'
        ? { kind: 'skin-code' as const }
        : job.kind === 'png-url'
          ? { kind: 'png-url' as const, url: job.result.suggestedName }
          : job.kind === 'player-name'
            ? {
                kind: 'player-name' as const,
                playerName: job.result.suggestedName,
              }
            : {
                kind: 'png-file' as const,
                fileName: job.result.suggestedName,
              })
    let customId: string | null = null
    try {
      customId = normalizeCustomId(
        body.customId !== undefined
          ? body.customId
          : job.result.suggestedCustomId,
      )
    } catch (e) {
      throw new SkinApiError({
        code: 'BAD_REQUEST',
        message: e instanceof Error ? e.message : String(e),
      })
    }
    const now = job.createdAt
    const entry: LibraryEntry = {
      entryId: `entry_${body.jobId}`,
      skinId,
      name: body.name.trim() || job.result.suggestedName,
      active: body.active ?? job.result.suggestedActive ?? false,
      tags: resolveEntryTags({ tags: body.tags, tagPaths: body.tagPaths }),
      folderId: body.folderId ?? null,
      favorite: body.favorite ?? false,
      model,
      textureWidth,
      textureHeight,
      source,
      provenance: body.provenance ?? emptyProvenance(),
      license: body.license ?? emptyLicense(),
      note: body.note ?? '',
      customId,
      createdAt: now,
      updatedAt: now,
      revision: 1,
    }
    const client = this.root.client
    const existingResult = client.skinImportResult(entry.entryId) as LibraryEntry | undefined
    // A restored completed job must not create another entry. This is a current
    // lookup, not an acknowledgement of any later metadata edits.
    const existing = this.lib.entries.find(item => item.entryId === entry.entryId)
    const pending = client.transactions.getSnapshot().transactions.some(transaction => transaction.phase !== 'saved' && client.transactions.submission(transaction.id).some(edit => {
      const original = libraryCommand(edit)
      return original?.command === 'import-entry' && original.entry.entryId === entry.entryId
    }))
    if (!pending && (existingResult || existing)) {
      this.pendingObjects.delete(skinId)
      this.jobSources.delete(body.jobId)
      this.jobDecoded.delete(body.jobId)
      return structuredClone((existingResult ?? existing)!)
    }
    const path = this.root.resolve(objectPath(skinId))
    const decoded = this.pendingObjects.get(skinId)
    const objects: FileEdit[] = decoded && !client.entry(path) ? [{ op: 'write', path, data: encodeDiskFile(decoded), version: null }] : []
    const result = await this.command<{ entry: LibraryEntry }>({ command: 'import-entry', entry }, `导入皮肤「${entry.name}」`, 'entries', objects)
    this.pendingObjects.delete(skinId)
    this.jobSources.delete(body.jobId)
    this.jobDecoded.delete(body.jobId)
    return result.entry
  }

  private async patchEntryDraft(
    entryId: string,
    body: PatchEntryRequest,
  ): Promise<LibraryEntry> {
    this.ensureReady()
    const { revision, resolvePending, ...changes } = body
    const command: SkinEntryCommand = { entryId, expectedRevision: revision, changes }
    const data = JSON.stringify(command)
    const client = this.root.client
    const edit: FileEdit = { op: 'skin-entry-patch', path: this.root.resolve(SKIN_INDEX_PATH), data,
      version: this.libVersion, baseData: JSON.stringify(this.lib.entries.find(entry => entry.entryId === entryId) ?? null) }
    const pending = entrySubmissionState(client, entryId).transaction
    if (resolvePending && pending && pending.phase !== 'saved') {
      if (pending.phase !== 'failed' && pending.phase !== 'conflict') {
        throw new ServiceError('pending_transaction', '这次修改的结果尚未确认，请先查询提交结果')
      }
      await client.transactions.resolve(pending.id, [edit])
    } else {
      await client.apply([edit], `修改皮肤「${this.lib.entries.find(entry => entry.entryId === entryId)?.name ?? entryId}」`)
    }
    const acknowledged = client.skinEntryResult(data) as LibraryEntry | undefined
    if (!acknowledged) throw new Error('皮肤修改已提交，未能载入确认结果，请刷新工程')
    // The receipt describes exactly this save, even when a peer has since made
    // another change. Never return a later entry as if it acknowledged our draft.
    this.lib.entries = this.lib.entries.map(entry => entry.entryId === entryId ? structuredClone(acknowledged) : entry)
    this.needsLibraryRefresh = true
    try {
      const raw = await this.readLibrary()
      if (raw) { this.lib = this.parseCurrentLibrary(raw); this.needsLibraryRefresh = false }
    } catch { /* The command is acknowledged. Refresh before the next mutation. */ }
    this.pendingDomain = 'entries'
    return structuredClone(acknowledged)
  }

  private async batchPatchEntriesDraft(body: BatchPatchRequest): Promise<{ updated: number; revision: number }> {
    const { entryIds, expectedRevisions, ...changes } = body
    if (expectedRevisions && expectedRevisions.length !== entryIds.length) throw new SkinApiError({ code: 'BAD_REQUEST', message: '批量修改缺少完整的条目版本，请重新选择' })
    return this.command({ command: 'batch-patch', expectedEntries: entryIds.map((id, i) => this.expectedEntry(id, expectedRevisions?.[i])), changes }, '批量修改皮肤', 'entries')
  }

  private async deleteEntryDraft(entryId: string, revision?: number): Promise<{ deleted: boolean }> {
    const result = await this.command<{ deleted: number }>({ command: 'delete-entries', expectedEntries: [this.expectedEntry(entryId, revision)] }, '删除皮肤条目', 'entries')
    return { deleted: result.deleted > 0 }
  }

  private async deleteEntriesInFolderDraft(folderId: string, expected?: FolderScopeSnapshot): Promise<{ deleted: number }> {
    const scope = folderDescendants(this.lib.folders, folderId)
    return this.command({ command: 'delete-folder-entries', folderId,
      expectedFolders: (expected?.folders ?? this.lib.folders.filter(folder => scope.has(folder.folderId))).map(folderRef),
      expectedEntries: expected?.entries ?? this.lib.entries.filter(entry => entry.folderId != null && scope.has(entry.folderId)).map(entryRef),
    }, '清空文件夹内皮肤', 'entries')
  }

  async getPreviewUrl(skinId: string): Promise<string> {
    this.ensureReady()
    const cached = this.previewUrls.get(skinId)
    if (cached) return cached
    const diskPng = await readBytesAt(this.root, this.previewCachePath(skinId))
    if (diskPng) {
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(diskPng)], { type: 'image/png' }),
      )
      this.previewUrls.set(skinId, url)
      return url
    }
    const decoded = await this.readObject(skinId)
    if (!decoded) {
      throw new SkinApiError({
        code: 'NOT_FOUND',
        message: 'skin object missing',
      })
    }
    const png = await rgbaToPngBlob(
      decoded.rgba,
      decoded.width,
      decoded.height,
    )
    // A generated preview is a local projection. Merely viewing a skin must not
    // acquire a project lease or leave a failed shared-cache write in the outbox.
    const url = URL.createObjectURL(png)
    this.previewUrls.set(skinId, url)
    return url
  }

  async getSkinCode(skinId: string): Promise<string> {
    this.ensureReady()
    const decoded = await this.readObject(skinId)
    if (!decoded) {
      throw new SkinApiError({
        code: 'NOT_FOUND',
        message: 'skin object missing',
      })
    }
    const model =
      this.visibleLibrary.entries.find((e) => e.skinId === skinId)?.model ?? 'classic'
    const { skinCode } = await encodeShareCode(model, decoded)
    return skinCode
  }

  async exportSkin(skinId: string, format: 'png' | 'skin' | 'hskin' | 'skin-json') {
    this.ensureReady()
    const decoded = await this.readObject(skinId)
    if (!decoded) {
      throw new SkinApiError({
        code: 'NOT_FOUND',
        message: 'skin object missing',
      })
    }
    if (format === 'skin' || format === 'hskin') {
      if(this.disposed)throw new Error('皮肤工程会话已关闭')
    const disk = encodeDiskFile(decoded)
      let binary = ''
      for (const b of disk) binary += String.fromCharCode(b)
      return { skinBase64: btoa(binary) }
    }
    if (format === 'skin-json') {
      const skinCode = await this.getSkinCode(skinId)
      return { text: skinCode }
    }
    const png = await rgbaToPngBlob(
      decoded.rgba,
      decoded.width,
      decoded.height,
    )
    const buf = new Uint8Array(await png.arrayBuffer())
    let binary = ''
    for (const b of buf) binary += String.fromCharCode(b)
    return { pngBase64: btoa(binary) }
  }

  async exportEntry(entryId: string, format: 'v3' | 'v2' = 'v3') {
    this.ensureReady()
    const entry = this.getEntry(entryId)
    const decoded = await this.readObject(entry.skinId)
    if (!decoded) {
      throw new SkinApiError({
        code: 'NOT_FOUND',
        message: 'skin object missing',
      })
    }
    const { skinCode } = await encodeShareCode(entry.model, decoded)
    const tagPaths = entry.tags.map((name) => [name])
    if (format === 'v2') {
      return {
        schemaVersion: 2 as const,
        name: entry.name,
        tagPaths,
        skinId: entry.skinId,
        skinCode,
      }
    }
    return {
      schemaVersion: 3 as const,
      name: entry.name,
      skinId: entry.skinId,
      skinCode,
      model: entry.model,
      tagPaths,
      active: entry.active,
      license: entry.license,
      provenance: entry.provenance,
      note: entry.note,
      ...(entry.customId ? { customId: entry.customId } : {}),
    }
  }

  exportUsableManifest() {
    this.ensureReady()
    const entries = this.visibleLibrary.entries
      .filter((e) => e.active)
      .map((e) => ({
        entryId: e.entryId,
        skinId: e.skinId,
        name: e.name,
        model: e.model,
        author: e.provenance.author,
        license: e.license,
        provenance: e.provenance,
      }))
    return { entries, count: entries.length }
  }

  /**
   * Remove unreferenced objects (orphans) and leftover preview cache.
   * `onProgress` drives the blocking GC dialog.
   */
  private async gcOrphansDraft(
    onProgress?: (p: {
      phase: 'scanning' | 'objects' | 'previews' | 'done'
      current: number
      total: number
      label: string
    }) => void,
  ): Promise<{
    removedObjects: number
    removedPreviews: number
    protectedCount: number
  }> {
    this.ensureReady()
    const report = (
      phase: 'scanning' | 'objects' | 'previews' | 'done',
      current: number,
      total: number,
      label: string,
    ) => {
      onProgress?.({ phase, current, total, label })
    }

    report('scanning', 0, 0, 'Scanning references and objects\u2026')

    const protectedIds = new Set<string>()
    for (const e of this.lib.entries) protectedIds.add(e.skinId)
    for (const job of this.jobs.values()) {
      if (job.result?.skinId) protectedIds.add(job.result.skinId)
    }

    type ObjVictim = { shard: string; name: string; skinId: string }
    const objectVictims: ObjVictim[] = []
    const objectShards = await listChildNames(
      this.root,
      `${SKIN_ROOT}/${OBJECTS_DIR}`,
    )
    for (const shard of objectShards) {
      if (shard.kind !== 'directory') continue
      const files = await listChildNames(
        this.root,
        `${SKIN_ROOT}/${OBJECTS_DIR}/${shard.name}`,
      )
      for (const f of files) {
        if (f.kind !== 'file' || !f.name.endsWith('.skin')) continue
        const skinId = f.name.slice(0, -'.skin'.length)
        if (!skinId || protectedIds.has(skinId)) continue
        objectVictims.push({ shard: shard.name, name: f.name, skinId })
      }
    }

    const previews = await listChildNames(this.root, `${SKIN_ROOT}/${CACHE_PNG_DIR}`)
    const previewVictims = previews.filter(file => file.kind === 'file' && file.name.endsWith('.png') && !protectedIds.has(file.name.slice(0, -4)))
    const edits: FileEdit[] = [
      ...objectVictims.map(victim => ({ op: 'remove' as const, path: this.root.resolve(`${SKIN_ROOT}/${OBJECTS_DIR}/${victim.shard}/${victim.name}`) })),
      ...previewVictims.map(victim => ({ op: 'remove' as const, path: this.root.resolve(`${SKIN_ROOT}/${CACHE_PNG_DIR}/${victim.name}`) })),
    ]
    if (edits.length) {
      report('objects', 0, edits.length, '正在提交清理事务…')
      // Include the index to validate its version and hold its lease: a concurrent
      // newly added reference must prevent deleting that client's object.
      await this.root.client.apply([...edits, { op: 'write', path: this.root.resolve(SKIN_INDEX_PATH), adopt: true, version: this.libVersion }], '清理未引用的皮肤对象')
      for (const victim of previewVictims) {
        const skinId = victim.name.slice(0, -4)
        const url = this.previewUrls.get(skinId)
        if (url) URL.revokeObjectURL(url)
        this.previewUrls.delete(skinId)
      }
    }
    const removedObjects = objectVictims.length
    const removedPreviews = previewVictims.length

    report('done', 1, 1, 'Done')

    return {
      removedObjects,
      removedPreviews,
      protectedCount: protectedIds.size,
    }
  }

  dispose() {
    // Flush synchronously before disposal; a remote library refresh can replace
    // this session before the short debounce expires.
    void this.persistJobsNow().catch(error => console.warn('[hanshu] 本窗口导入准备记录保存失败', error))
    this.disposed=true
    if(this.persistJobsTimer!==null)clearTimeout(this.persistJobsTimer)
    for (const url of this.previewUrls.values()) URL.revokeObjectURL(url)
    this.previewUrls.clear()
    this.listeners.clear()
  }
}
