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
  removeAt,
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
  private root: FileSystemDirectoryHandle
  private lib: LibraryFile = emptyLibrary()
  private jobs = new Map<string, ImportJob>()
  private jobSources = new Map<string, EntrySource>()
  /** ?????????????? encode ??? */
  private jobDecoded = new Map<string, DecodedSkin>()
  private jobSeq = 0
  private listeners = new Set<(e: SkinEvent) => void>()
  private previewUrls = new Map<string, string>()
  private ready = false
  private persistJobsTimer: ReturnType<typeof setTimeout> | null = null

  constructor(root: FileSystemDirectoryHandle) {
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
      await this.persistLibrary('folders')
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
      void this.persistJobsNow()
    }, 400)
  }

  private async persistJobsNow(): Promise<void> {
    const jobs = [...this.jobs.values()].sort((a, b) => b.seq - a.seq).slice(0, 50)
    const json = `${JSON.stringify({ seq: this.jobSeq, jobs })}\n`
    await writeTextAt(this.root, IMPORT_JOBS_FILE, json)
  }

  /** @deprecated use schedulePersistJobs; kept name for call sites */
  private async persistJobs(): Promise<void> {
    this.schedulePersistJobs()
  }

  private ensureReady() {
    if (!this.ready) {
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

  private persistDirtyDomain: 'entries' | 'tags' | 'folders' | null = null
  private persistWaiter: Promise<void> | null = null

  /** Coalesce rapid library.json writes (batch import). */
  private async persistLibrary(
    domain: 'entries' | 'tags' | 'folders' = 'entries',
  ): Promise<void> {
    this.persistDirtyDomain = domain
    if (!this.persistWaiter) {
      this.persistWaiter = (async () => {
        await Promise.resolve()
        while (this.persistDirtyDomain) {
          const d = this.persistDirtyDomain
          this.persistDirtyDomain = null
          const json = `${JSON.stringify(
            {
              schemaVersion: this.lib.schemaVersion,
              revision: this.lib.revision,
              folders: this.lib.folders,
              entries: this.lib.entries,
            },
            null,
            2,
          )}\n`
          await writeTextAt(this.root, `${SKIN_ROOT}/${LIBRARY_FILE}`, json)
          this.emit({
            type: 'library-updated',
            revision: this.lib.revision,
            domain: d,
          })
        }
      })().finally(() => {
        this.persistWaiter = null
      })
    }
    await this.persistWaiter
  }

  private previewCachePath(skinId: string): string {
    return `${SKIN_ROOT}/${CACHE_PNG_DIR}/${skinId}.png`
  }

  private async writePreviewCache(
    skinId: string,
    decoded: DecodedSkin,
  ): Promise<void> {
    const png = await rgbaToPngBlob(decoded.rgba, decoded.width, decoded.height)
    const buf = new Uint8Array(await png.arrayBuffer())
    await writeBytesAt(this.root, this.previewCachePath(skinId), buf)
  }

  private async putDecoded(
    decoded: DecodedSkin,
  ): Promise<{ skinId: string; decoded: DecodedSkin }> {
    const c = buildC(decoded.flags, decoded.width, decoded.height, decoded.rgba)
    const skinId = await skinIdOf(c)
    const path = objectPath(skinId)
    const existing = await readBytesAt(this.root, path)
    if (existing) {
      // Ensure preview cache exists for faster right-panel loads.
      const cached = await readBytesAt(this.root, this.previewCachePath(skinId))
      if (!cached) {
        void this.writePreviewCache(skinId, decoded).catch(() => {})
      }
      return { skinId, decoded }
    }
    const disk = encodeDiskFile(decoded)
    await writeBytesAt(this.root, path, disk)
    // Preview PNG in background ? don't block validate path.
    void this.writePreviewCache(skinId, decoded).catch(() => {})
    return { skinId, decoded }
  }

  private async readObject(skinId: string): Promise<DecodedSkin | null> {
    if (!isValidSkinId(skinId)) return null
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
    return queryEntries(this.lib, query)
  }

  getEntry(entryId: string): LibraryEntry {
    this.ensureReady()
    const e = this.lib.entries.find((x) => x.entryId === entryId)
    if (!e) {
      throw new SkinApiError({ code: 'NOT_FOUND', message: `entry ${entryId}` })
    }
    return e
  }

  listTags() {
    this.ensureReady()
    return {
      revision: this.lib.revision,
      tags: collectTags(this.lib),
      textureSizes: collectTextureSizes(this.lib),
    }
  }

  async renameTag(from: string, to: string) {
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

  async deleteTag(name: string) {
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
    return { revision: this.lib.revision, folders: foldersWithStats(this.lib) }
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

  async createFolder(body: CreateFolderRequest) {
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

  async patchFolder(folderId: string, body: PatchFolderRequest) {
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

  async deleteFolder(folderId: string) {
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
      skinCode: '',
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

  async saveEntry(body: SaveEntryRequest): Promise<LibraryEntry> {
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
    // Ensure object exists on disk (share-code imports already wrote it).
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
    this.jobSources.delete(body.jobId)
    this.jobDecoded.delete(body.jobId)
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
      createdAt: now,
      updatedAt: now,
      revision: 1,
    }
    this.lib.entries.push(entry)
    this.bump()
    await this.persistLibrary('entries')
    return entry
  }

  async patchEntry(
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

  async batchPatchEntries(body: {
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

  async deleteEntry(entryId: string) {
    this.ensureReady()
    const before = this.lib.entries.length
    this.lib.entries = this.lib.entries.filter((e) => e.entryId !== entryId)
    if (this.lib.entries.length === before) return { deleted: false }
    this.bump()
    await this.persistLibrary('entries')
    return { deleted: true }
  }

  async deleteEntriesInFolder(folderId: string): Promise<{ deleted: number }> {
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
    void writeBytesAt(
      this.root,
      this.previewCachePath(skinId),
      new Uint8Array(await png.arrayBuffer()),
    ).catch(() => {})
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
      this.lib.entries.find((e) => e.skinId === skinId)?.model ?? 'classic'
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
    }
  }

  exportUsableManifest() {
    this.ensureReady()
    const entries = this.lib.entries
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
  async gcOrphans(
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

    let removedObjects = 0
    const objTotal = objectVictims.length
    report(
      'objects',
      0,
      objTotal,
      objTotal
        ? `Cleaning objects 0 / ${objTotal}\u2026`
        : 'No orphan objects',
    )
    for (let i = 0; i < objectVictims.length; i++) {
      const v = objectVictims[i]!
      await removeAt(
        this.root,
        `${SKIN_ROOT}/${OBJECTS_DIR}/${v.shard}/${v.name}`,
      )
      removedObjects += 1
      await removeAt(this.root, `${SKIN_ROOT}/${CACHE_PNG_DIR}/${v.skinId}.png`)
      const url = this.previewUrls.get(v.skinId)
      if (url) {
        URL.revokeObjectURL(url)
        this.previewUrls.delete(v.skinId)
      }
      report(
        'objects',
        i + 1,
        objTotal,
        `Cleaning objects ${i + 1} / ${objTotal}\u2026`,
      )
      // Yield so the progress bar can paint.
      if ((i + 1) % 4 === 0) await new Promise((r) => setTimeout(r, 0))
    }

    const previewVictims: { name: string; skinId: string }[] = []
    const previews = await listChildNames(
      this.root,
      `${SKIN_ROOT}/${CACHE_PNG_DIR}`,
    )
    for (const f of previews) {
      if (f.kind !== 'file' || !f.name.endsWith('.png')) continue
      const skinId = f.name.slice(0, -'.png'.length)
      if (!skinId || protectedIds.has(skinId)) continue
      previewVictims.push({ name: f.name, skinId })
    }

    let removedPreviews = 0
    const prevTotal = previewVictims.length
    report(
      'previews',
      0,
      prevTotal,
      prevTotal
        ? `Cleaning previews 0 / ${prevTotal}\u2026`
        : 'No orphan previews',
    )
    for (let i = 0; i < previewVictims.length; i++) {
      const v = previewVictims[i]!
      await removeAt(this.root, `${SKIN_ROOT}/${CACHE_PNG_DIR}/${v.name}`)
      removedPreviews += 1
      const url = this.previewUrls.get(v.skinId)
      if (url) {
        URL.revokeObjectURL(url)
        this.previewUrls.delete(v.skinId)
      }
      report(
        'previews',
        i + 1,
        prevTotal,
        `Cleaning previews ${i + 1} / ${prevTotal}\u2026`,
      )
      if ((i + 1) % 8 === 0) await new Promise((r) => setTimeout(r, 0))
    }

    report('done', 1, 1, 'Done')

    return {
      removedObjects,
      removedPreviews,
      protectedCount: protectedIds.size,
    }
  }

  dispose() {
    for (const url of this.previewUrls.values()) URL.revokeObjectURL(url)
    this.previewUrls.clear()
    this.listeners.clear()
  }
}
