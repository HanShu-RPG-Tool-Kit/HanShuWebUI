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
  decodeSkinCode,
  encodeSkinCode,
  isValidSkinId,
  type DecodedSkin,
} from './codec'
import { ensureDir, readTextAt, writeBytesAt, writeTextAt } from './fsIo'
import {
  collectTags,
  deleteTagInLibrary,
  emptyLibrary,
  emptyLicense,
  emptyProvenance,
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
  return `${SKIN_ROOT}/${OBJECTS_DIR}/${skinId.slice(0, 2)}/${skinId}.hskin`
}

function previewPath(skinId: string): string {
  return `${SKIN_ROOT}/${CACHE_PNG_DIR}/${skinId}.png`
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
  private jobSeq = 0
  private listeners = new Set<(e: SkinEvent) => void>()
  private previewUrls = new Map<string, string>()
  private ready = false

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

  private async persistJobs(): Promise<void> {
    const jobs = [...this.jobs.values()].sort((a, b) => b.seq - a.seq).slice(0, 50)
    const json = `${JSON.stringify({ seq: this.jobSeq, jobs }, null, 2)}\n`
    await writeTextAt(this.root, IMPORT_JOBS_FILE, json)
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

  private async persistLibrary(
    domain: 'entries' | 'tags' | 'folders' = 'entries',
  ): Promise<void> {
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
      domain,
    })
  }

  private async putObject(
    skinCode: string,
  ): Promise<{ skinId: string; model: SkinModel; decoded: DecodedSkin }> {
    const { decoded, skinId, skinCode: code } = await decodeSkinCode(
      skinCode.trim(),
    )
    await writeTextAt(this.root, objectPath(skinId), `${code}\n`)
    try {
      const png = await rgbaToPngBlob(decoded.rgba)
      await writeBytesAt(this.root, previewPath(skinId), png)
    } catch {
      // preview cache best-effort
    }
    return { skinId, model: decoded.model, decoded }
  }

  private async readObjectCode(skinId: string): Promise<string | null> {
    if (!isValidSkinId(skinId)) return null
    const raw = await readTextAt(this.root, objectPath(skinId))
    return raw?.trim() ?? null
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
    return { revision: this.lib.revision, tags: collectTags(this.lib) }
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
    this.emit(emitJob(job))
    void this.persistJobs()
    const { rgba, model: resolved } = await normalizePngBytes(bytes, model)
    const { skinCode, skinId } = await encodeSkinCode(resolved, rgba)
    job.state = 'ready'
    job.result = {
      skinId,
      model: resolved,
      suggestedName: suggestedName.replace(/\.[^.]+$/, '') || 'skin',
      skinCode,
      suggestedActive: true,
    }
    job.updatedAt = nowIso()
    this.jobs.set(job.jobId, job)
    this.jobSources.set(job.jobId, source)
    this.emit(emitJob(job))
    void this.persistJobs()
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
    this.emit(emitJob(job))
    void this.persistJobs()
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
      const { decoded, skinId, skinCode } = await decodeSkinCode(text.trim())
      job.state = 'ready'
      job.result = {
        skinId,
        model: decoded.model,
        suggestedName: `skin-${skinId.slice(0, 8)}`,
        skinCode,
        suggestedActive: true,
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
    const { skinId, model, skinCode } = job.result
    await this.putObject(skinCode)
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
    const now = nowIso()
    const entry: LibraryEntry = {
      entryId: uid('entry'),
      skinId,
      name: body.name.trim() || job.result.suggestedName,
      active: body.active ?? job.result.suggestedActive ?? true,
      tags: resolveEntryTags({ tags: body.tags, tagPaths: body.tagPaths }),
      folderId: body.folderId ?? null,
      favorite: body.favorite ?? false,
      model,
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

  async getPreviewUrl(skinId: string): Promise<string> {
    this.ensureReady()
    const cached = this.previewUrls.get(skinId)
    if (cached) return cached
    const code = await this.readObjectCode(skinId)
    if (!code) {
      throw new SkinApiError({
        code: 'NOT_FOUND',
        message: 'skin object missing',
      })
    }
    const { decoded } = await decodeSkinCode(code)
    const png = await rgbaToPngBlob(decoded.rgba)
    const url = URL.createObjectURL(png)
    this.previewUrls.set(skinId, url)
    return url
  }

  async getSkinCode(skinId: string): Promise<string> {
    this.ensureReady()
    const code = await this.readObjectCode(skinId)
    if (!code) {
      throw new SkinApiError({
        code: 'NOT_FOUND',
        message: 'skin object missing',
      })
    }
    return code
  }

  async exportSkin(skinId: string, format: 'png' | 'hskin' | 'skin-json') {
    this.ensureReady()
    const code = await this.readObjectCode(skinId)
    if (!code) {
      throw new SkinApiError({
        code: 'NOT_FOUND',
        message: 'skin object missing',
      })
    }
    if (format === 'hskin' || format === 'skin-json') {
      return { text: code }
    }
    const { decoded } = await decodeSkinCode(code)
    const png = await rgbaToPngBlob(decoded.rgba)
    const buf = new Uint8Array(await png.arrayBuffer())
    let binary = ''
    for (const b of buf) binary += String.fromCharCode(b)
    return { pngBase64: btoa(binary) }
  }

  async exportEntry(entryId: string, format: 'v3' | 'v2' = 'v3') {
    this.ensureReady()
    const entry = this.getEntry(entryId)
    const skinCode = await this.getSkinCode(entry.skinId)
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

  dispose() {
    for (const url of this.previewUrls.values()) URL.revokeObjectURL(url)
    this.previewUrls.clear()
    this.listeners.clear()
  }
}
