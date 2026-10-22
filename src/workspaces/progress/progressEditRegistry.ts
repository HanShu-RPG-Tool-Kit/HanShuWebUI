import type { ProjectClient } from '../../project/serviceClient'
import { currentEditWindowId } from '../../project/editJournal'
import { textAssetPath } from '../../i18n/localeLayout'
import { parseProgress } from './progressDoc'
import { ProgressEditSession, type ProgressSessionRecovery } from './progressEditSession'

type EditorRecord = { session: ProgressEditSession; locales: Set<string>; start: () => Promise<void> }
const editors = new WeakMap<ProjectClient, Map<string, EditorRecord>>()
export function progressEditorSession(client: ProjectClient | undefined, path: string | null) { return client && path ? editors.get(client)?.get(path)?.session : undefined }
export function getProgressEditor(client: ProjectClient, path: string, name: string, source: string, locale: string): EditorRecord {
  let documents = editors.get(client)
  if (!documents) { documents = new Map(); editors.set(client, documents) }
  const existing = documents.get(path)
  if (existing) { existing.locales.add(locale); return existing }
  const locales = new Set([locale])
  const storageKey = `hanshu.progressIntent:${currentEditWindowId()}:${client.snapshot.projectId}:${client.snapshot.session.subjectId}:${path}`
  let recovery: ProgressSessionRecovery | null = null
  try {
    const candidate = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as ProgressSessionRecovery | null
    if (candidate && Array.isArray(candidate.pending) && Array.isArray(candidate.undo) && Array.isArray(candidate.redo)) {
      parseProgress(candidate.base.source)
      if (candidate.active) candidate.active.id = client.transactions.getSnapshot().transactions.find(record => record.requestId === candidate.active!.requestId)?.id ?? -1
      recovery = candidate
      for (const language of Object.keys(candidate.base.languages)) locales.add(language)
    }
  } catch { /* Invalid local recovery never replaces an authoritative document. */ }
  const session = new ProgressEditSession({ source, languages: {}, revision: 0 }, {
    read: async () => {
      const paths = [...locales].map(value => textAssetPath(value, name))
      const value = await client.readProgressState(path, paths)
      const languages: Record<string, Record<string, string>> = {}
      for (const language of locales) {
        const raw = value.languages[textAssetPath(language, name)]
        const data = raw ? JSON.parse(raw) : {}
        if (!data || typeof data !== 'object' || Array.isArray(data) || Object.values(data).some(value => typeof value !== 'string')) throw new Error(`${language} 语言资源格式无效，原文件已保留`)
        languages[language] = data
      }
      return { source: value.source, languages, revision: value.revision }
    },
    submit: (command, label) => {
      const completion = client.submitProgress(path, command, label)
      const record = client.transactions.getSnapshot().transactions.at(-1)!
      return { id: record.id, requestId: record.requestId, completion }
    },
    record: id => client.transactions.getSnapshot().transactions.find(record => record.id === id),
    acknowledgement: requestId => client.progressAcknowledgement(requestId),
    recover: requestId => client.loadProgressAcknowledgement(requestId),
    reinstate: attempt => client.recoverProgress(path, attempt.command, attempt.requestId, '恢复进度操作'),
    forget: id => client.transactions.forget(id),
    dirty: (dirty, languages) => client.transactions.setEditorDirty(`progress:${path}`, dirty ? [path, ...languages.map(value => textAssetPath(value, name))] : []),
    persist: value => { if (value) sessionStorage.setItem(storageKey, JSON.stringify(value)); else sessionStorage.removeItem(storageKey) },
  }, recovery)
  client.registerProgressEditor(path, () => session.flush())
  client.transactions.subscribe(() => { void session.reconcile() })
  let started = false
  const record: EditorRecord = { session, locales, start: async () => {
    if (started) return
    started = true
    try { await session.initialize() } catch (error) { started = false; throw error }
  } }
  documents.set(path, record)
  return record
}
