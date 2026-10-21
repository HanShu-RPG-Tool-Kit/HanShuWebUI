import type { FileEdit, ProjectDirectory } from '../../project/serviceClient'
/**
 * Skin library session under project `.hanshu/skinmanager`
 */

import { SkinApiError } from '../contracts/types'
import type {
  CreateFolderRequest,
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
  readTextAt,
  writeBytesAt,
  writeTextAt,
} from './fsIo'
import {
  collectTags,
  collectTextureSizes,
  deleteTagInLibrary,
  emptyLibrary,
  emptyLicense,
  emptyProvenance,
  folderDescendants,
  foldersWithStats,
  normalizeCustomId,
  normalizeFolderName,
  normalizeTagList,
  normalizeTagName,
  nowIso,
  parseLibraryJson,
  queryEntries,
  renameTagInLibrary,
  repairDuplicateSiblingFolders,
  resolveEntryTags,
  uid,
  type LibraryFile,
} from './library'
import { fetchPlayerSkinPng, fetchPngBytes } from './net'
import { normalizePngBytes, rgbaToPngBlob } from './normalize'
import {
  CACHE_PNG_DIR,
  LIBRARY_FILE,
  OBJECTS_DIR,
  SCHEMA_VERSION,
  SKIN_ROOT,
  TMP_DIR,
} from './paths'

const IMPORT_JOBS_FILE = `${SKIN_ROOT}/${TMP_DIR}/import-jobs.json`

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
  private readableLib: LibraryFile | null = null
  private mutationTail: Promise<unknown> = Promise.resolve()
  private pendingDomain: 'entries' | 'tags' | 'folders' | null = null
  private pendingObjects = new Map<string, DecodedSkin>()

  /** Mutations work on a private copy; queries only see the last acknowledged index. */
  private mutateLibrary<T>(action: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(async () => {
      this.ensureReady()
      const previous = this.lib
      this.lib = structuredClone(previous)
      this.readableLib = previous
      try {
        const result = await action()
        this.readableLib = null
        if (this.pendingDomain) this.emit({ type: 'library-updated', revision: this.lib.revision, domain: this.pendingDomain })
        return result
      } catch (error) {
        this.lib = previous
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
  deleteFolder(id: string) { return this.mutateLibrary(() => this.deleteFolderDraft(id)) }
  saveEntry(body: SaveEntryRequest) { return this.mutateLibrary(() => this.saveEntryDraft(body)) }
  patchEntry(id: string, body: PatchEntryRequest) { return this.mutateLibrary(() => this.patchEntryDraft(id, body)) }
  batchPatchEntries(body: Parameters<SkinLibrarySession['batchPatchEntriesDraft']>[0]) { return this.mutateLibrary(() => this.batchPatchEntriesDraft(body)) }
  deleteEntry(id: string) { return this.mutateLibrary(() => this.deleteEntryDraft(id)) }
  deleteEntriesInFolder(id: string) { return this.mutateLibrary(() => this.deleteEntriesInFolderDraft(id)) }
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
    const raw = await readTextAt(this.root, `${SKIN_ROOT}/${LIBRARY_FILE}`)
    if (raw) {
      let needsRewrite = false
      try {
        const peek = JSON.parse(raw) as { schemaVersion?: number; tags?: unknown }
        if (Number(peek.schemaVersion ?? 0) < SCHEMA_VERSION || Array.isArray(peek.tags)) {
          needsRewrite = true
        }
      } catch {
        needsRewrite = true
      }
      this.lib = parseLibraryJson(raw)
      this.lib.schemaVersion = SCHEMA_VERSION
      if (repairDuplicateSiblingFolders(this.lib)) {
        needsRewrite = true
      }
      if (needsRewrite) {
        this.bump()
        await this.persistLibrary('entries')
      }
    } else {
      this.lib = emptyLibrary()
      if (this.root.client.writable) await this.persistLibrary('folders')
    }
    await this.loadJobs()
    this.ready = true
  }

  private async loadJobs(): Promise<void> {
    const raw = await readTextAt(this.root, IMPORT_JOBS_FILE)
    if (!raw) return
    try {
      const data = JSON.parse(raw) as { jobs?: ImportJob[]; seq?: number }
      if (Array.isArray(data.jobs)) {
        this.jobs.clear()
        for (const job of data.jobs) {
          if (job?.jobId) this.jobs.set(job.jobId, job)
        }
      }
      if (typeof data.seq === 'number') this.jobSeq = data.seq
    } catch {
      // ignore corrupt job file
    }
  }

  private schedulePersistJobs(): void {
    if (this.persistJobsTimer != null) return
    this.persistJobsTimer = setTimeout(() => {
      this.persistJobsTimer = null
      void this.persistJobsNow().catch(error => console.warn('[hanshu] 导入队列提交失败，记录保留在事务列表', error))
    }, 400)
  }

  private async persistJobsNow(): Promise<void> {
    if(this.disposed || !this.root.client.writable)return
    const jobs = [...this.jobs.values()].sort((a, b) => b.seq - a.seq).slice(0, 50)
    const json = `${JSON.stringify({ seq: this.jobSeq, jobs })}\n`
    await writeTextAt(this.root, IMPORT_JOBS_FILE, json)
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

  private bump(): number {
    this.lib.revision += 1
    return this.lib.revision
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

  private async persistLibrary(domain: 'entries' | 'tags' | 'folders' = 'entries', extra: FileEdit[] = []): Promise<void> {
    if (this.disposed) throw new Error('皮肤工程会话已关闭，未提交修改')
    const objects = [...new Set(this.lib.entries.map(entry => entry.skinId))]
      .filter(id => this.pendingObjects.has(id) && !this.root.client.entry(this.root.resolve(objectPath(id))))
    const edits: FileEdit[] = objects.map(id => ({ op: 'write', path: this.root.resolve(objectPath(id)), data: encodeDiskFile(this.pendingObjects.get(id)!) }))
    edits.push(...extra, { op: 'write', path: this.root.resolve(`${SKIN_ROOT}/${LIBRARY_FILE}`), data: `${JSON.stringify(this.lib, null, 2)}\n` })
    await this.root.client.apply(edits, extra.length ? '清理皮肤对象及索引' : '保存皮肤对象及索引')
    for (const id of objects) this.pendingObjects.delete(id)
    if (this.readableLib) this.pendingDomain = domain
    else this.emit({ type: 'library-updated', revision: this.lib.revision, domain })
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

  private async renameTagDraft(from: string, to: string) {
    this.ensureReady()
    const fromN = normalizeTagName(from)
    const toN = normalizeTagName(to)
    if (!fromN || !toN) {
      throw new SkinApiError({ code: 'BAD_REQUEST', message: 'tag name empty' })
    }
    if (fromN.toLowerCase() === toN.toLowerCase() && fromN !== toN) {
      // case-only rename still rewrites display form
    } else if (fromN.toLowerCase() === toN.toLowerCase()) {
      return { affectedEntries: 0 }
    }
    const affected = renameTagInLibrary(this.lib, fromN, toN)
    if (affected > 0) {
      this.bump()
      await this.persistLibrary('tags')
    }
    return { affectedEntries: affected }
  }

  private async deleteTagDraft(name: string) {
    this.ensureReady()
    const n = normalizeTagName(name)
    if (!n) {
      throw new SkinApiError({ code: 'BAD_REQUEST', message: 'tag name empty' })
    }
    const affected = deleteTagInLibrary(this.lib, n)
    if (affected > 0) {
      this.bump()
      await this.persistLibrary('tags')
    }
    return { affectedEntries: affected }
  }

  listFolders() {
    this.ensureReady()
    return { revision: this.visibleLibrary.revision, folders: foldersWithStats(this.visibleLibrary) }
  }

  private assertUniqueSiblingFolderName(
    name: string,
    parentId: string | null,
    excludeFolderId?: string,
  ) {
    const norm = normalizeFolderName(name)
    const clash = this.lib.folders.some(
      (f) =>
        f.folderId !== excludeFolderId &&
        (f.parentId ?? null) === parentId &&
        normalizeFolderName(f.name) === norm,
    )
    if (clash) {
      throw new SkinApiError({
        code: 'FOLDER_NAME_CONFLICT',
        message: `????????${norm}?`,
      })
    }
  }

  private async createFolderDraft(body: CreateFolderRequest) {
    this.ensureReady()
    const name = normalizeFolderName(body.name)
    if (!name) {
      throw new SkinApiError({
        code: 'BAD_REQUEST',
        message: 'folder name empty',
      })
    }
    const parentId = body.parentId ?? null
    if (parentId && !this.lib.folders.some((f) => f.folderId === parentId)) {
      throw new SkinApiError({
        code: 'NOT_FOUND',
        message: 'parent folder not found',
      })
    }
    this.assertUniqueSiblingFolderName(name, parentId)
    const folder = {
      folderId: uid('folder'),
      name,
      parentId,
      sortOrder: this.lib.folders.filter((f) => (f.parentId ?? null) === parentId)
        .length,
    }
    this.lib.folders.push(folder)
    this.bump()
    await this.persistLibrary('folders')
    return folder
  }

  private async patchFolderDraft(folderId: string, body: PatchFolderRequest) {
    this.ensureReady()
    const folder = this.lib.folders.find((f) => f.folderId === folderId)
    if (!folder) {
      throw new SkinApiError({ code: 'NOT_FOUND', message: 'folder not found' })
    }
    const nextName =
      body.name != null
        ? normalizeFolderName(body.name) || folder.name
        : folder.name
    const nextParent =
      body.parentId !== undefined ? body.parentId : (folder.parentId ?? null)
    if (
      nextName !== folder.name ||
      nextParent !== (folder.parentId ?? null)
    ) {
      this.assertUniqueSiblingFolderName(nextName, nextParent, folderId)
    }
    if (body.name != null) folder.name = nextName
    if (body.parentId !== undefined) folder.parentId = body.parentId
    if (body.sortOrder != null) folder.sortOrder = body.sortOrder
    this.bump()
    await this.persistLibrary('folders')
    return folder
  }

  private async deleteFolderDraft(folderId: string) {
    this.ensureReady()
    const before = this.lib.folders.length
    this.lib.folders = this.lib.folders.filter((f) => f.folderId !== folderId)
    this.lib.entries = this.lib.entries.map((e) =>
      e.folderId === folderId
        ? {
            ...e,
            folderId: null,
            updatedAt: nowIso(),
            revision: e.revision + 1,
          }
        : e,
    )
    if (this.lib.folders.length === before) {
      return { deleted: false }
    }
    this.bump()
    await this.persistLibrary('folders')
    return { deleted: true }
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

  private assertCustomIdAvailable(
    customId: string | null,
    exceptEntryId?: string,
  ): void {
    if (!customId) return
    const clash = this.lib.entries.find(
      (e) =>
        e.customId === customId &&
        (!exceptEntryId || e.entryId !== exceptEntryId),
    )
    if (clash) {
      throw new SkinApiError({
        code: 'CONFLICT',
        message: `自定义 ID「${customId}」已被「${clash.name}」占用`,
      })
    }
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
    this.assertCustomIdAvailable(customId)
    const now = nowIso()
    const entry: LibraryEntry = {
      entryId: uid('entry'),
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
    this.lib.entries.push(entry)
    this.bump()
    await this.persistLibrary('entries')
    this.jobSources.delete(body.jobId)
    this.jobDecoded.delete(body.jobId)
    return entry
  }

  private async patchEntryDraft(
    entryId: string,
    body: PatchEntryRequest,
  ): Promise<LibraryEntry> {
    this.ensureReady()
    const idx = this.lib.entries.findIndex((e) => e.entryId === entryId)
    if (idx < 0) {
      throw new SkinApiError({ code: 'NOT_FOUND', message: 'entry not found' })
    }
    const entry = this.lib.entries[idx]!
    if (entry.revision !== body.revision) {
      throw new SkinApiError({
        code: 'CONFLICT',
        message: `revision mismatch expected ${body.revision} got ${entry.revision}`,
      })
    }
    if (body.name != null) entry.name = body.name
    if (body.favorite != null) entry.favorite = body.favorite
    if (body.folderId !== undefined) entry.folderId = body.folderId
    if (body.active != null) entry.active = body.active
    if (body.model != null) entry.model = body.model
    if (body.license) entry.license = body.license
    if (body.provenance) entry.provenance = body.provenance
    if (body.note != null) entry.note = body.note
    if (body.customId !== undefined) {
      let next: string | null
      try {
        next = normalizeCustomId(body.customId)
      } catch (e) {
        throw new SkinApiError({
          code: 'BAD_REQUEST',
          message: e instanceof Error ? e.message : String(e),
        })
      }
      this.assertCustomIdAvailable(next, entryId)
      entry.customId = next
    }
    if (body.tags) entry.tags = normalizeTagList(body.tags)
    if (body.addTags?.length) {
      entry.tags = normalizeTagList([...entry.tags, ...body.addTags])
    }
    if (body.removeTags?.length) {
      const ban = new Set(
        body.removeTags
          .map((t) => normalizeTagName(t)?.toLowerCase())
          .filter((t): t is string => Boolean(t)),
      )
      entry.tags = entry.tags.filter((t) => !ban.has(t.toLowerCase()))
    }
    entry.updatedAt = nowIso()
    entry.revision += 1
    this.bump()
    await this.persistLibrary('entries')
    return entry
  }

  private async batchPatchEntriesDraft(body: {
    entryIds: string[]
    addTags?: string[]
    removeTags?: string[]
    folderId?: string | null
    active?: boolean
    expectedRevisions?: number[]
  }) {
    this.ensureReady()
    let updated = 0
    const conflicts: Array<{
      entryId: string
      expectedRevision: number
      actualRevision: number
    }> = []
    const removeBan = new Set(
      (body.removeTags ?? [])
        .map((t) => normalizeTagName(t)?.toLowerCase())
        .filter((t): t is string => Boolean(t)),
    )
    for (let i = 0; i < body.entryIds.length; i++) {
      const id = body.entryIds[i]!
      const entry = this.lib.entries.find((e) => e.entryId === id)
      if (!entry) continue
      const expected = body.expectedRevisions?.[i]
      if (expected != null && entry.revision !== expected) {
        conflicts.push({
          entryId: id,
          expectedRevision: expected,
          actualRevision: entry.revision,
        })
        continue
      }
      if (body.addTags?.length) {
        entry.tags = normalizeTagList([...entry.tags, ...body.addTags])
      }
      if (removeBan.size) {
        entry.tags = entry.tags.filter((t) => !removeBan.has(t.toLowerCase()))
      }
      if (body.folderId !== undefined) entry.folderId = body.folderId
      if (body.active != null) entry.active = body.active
      entry.updatedAt = nowIso()
      entry.revision += 1
      updated += 1
    }
    if (updated > 0) {
      this.bump()
      await this.persistLibrary('entries')
    }
    return { updated, revision: this.lib.revision, conflicts }
  }

  private async deleteEntryDraft(entryId: string) {
    this.ensureReady()
    const before = this.lib.entries.length
    this.lib.entries = this.lib.entries.filter((e) => e.entryId !== entryId)
    if (this.lib.entries.length === before) return { deleted: false }
    this.bump()
    await this.persistLibrary('entries')
    return { deleted: true }
  }

  private async deleteEntriesInFolderDraft(folderId: string): Promise<{ deleted: number }> {
    this.ensureReady()
    const scope = folderDescendants(this.lib.folders, folderId)
    const before = this.lib.entries.length
    this.lib.entries = this.lib.entries.filter(
      (e) => e.folderId == null || !scope.has(e.folderId),
    )
    const deleted = before - this.lib.entries.length
    if (deleted === 0) return { deleted: 0 }
    this.bump()
    await this.persistLibrary('entries')
    return { deleted }
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
    if (this.root.client.entry(this.root.resolve(objectPath(skinId))) && this.root.client.writable) {
      void writeBytesAt(this.root, this.previewCachePath(skinId), new Uint8Array(await png.arrayBuffer())).catch(() => {})
    }
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
      await this.persistLibrary('entries', edits)
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
    this.disposed=true
    if(this.persistJobsTimer!==null)clearTimeout(this.persistJobsTimer)
    for (const url of this.previewUrls.values()) URL.revokeObjectURL(url)
    this.previewUrls.clear()
    this.listeners.clear()
  }
}
