import { request } from '../collab/protocol'
import type { HistoryEntry, HistoryPage, HistoryStats, HistoryTree, HistoryContent, HistoryRestoreSelection, HistoryRestorePlan } from '../collab/generated'
import type { ProjectClient } from './serviceClient'

export type { HistoryEntry, HistoryPage, HistoryStats, HistoryTree, HistoryContent, HistoryRestorePlan }

export function listProjectHistory(client: ProjectClient, before?: number | null, path = '') {
  const query = new URLSearchParams({ limit: '80' })
  if (before != null) query.set('before', String(before))
  if (path) query.set('path', path)
  return request<HistoryPage>(client.connection, `/api/history?${query}`)
}
export function historyStats(client: ProjectClient) { return request<HistoryStats>(client.connection, '/api/history/stats') }
export function historyTree(client: ProjectClient, sequence: number, path = '') { return request<HistoryTree>(client.connection, `/api/history/${sequence}/tree${path ? `?${new URLSearchParams({ path })}` : ''}`) }
export function historyContent(client: ProjectClient, sequence: number, path: string) {
  return request<HistoryContent>(client.connection, `/api/history/${sequence}/content?${new URLSearchParams({ path })}`)
}
export function nameHistoryVersion(client: ProjectClient, sequence: number, label: string | null) {
  return request<HistoryEntry>(client.connection, `/api/history/${sequence}/label`, 'POST', { label })
}
export function planHistoryRestore(client: ProjectClient, value: HistoryRestoreSelection) {
  return request<HistoryRestorePlan>(client.connection, '/api/history/restore-plan', 'POST', value)
}

export function decodeHistoryContent(content: HistoryContent): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(content.content), character => character.charCodeAt(0))
}
export function historyText(bytes: Uint8Array): string | null {
  if (bytes.some(byte => byte === 0)) return null
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return null }
}
export function historyBytes(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}
export function downloadHistoryBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a')
  anchor.href = url; anchor.download = name; anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
/** Export the original local stores verbatim. Reading here never migrates or deletes them. */
export function exportLegacyHistory() {
  const stores = Object.fromEntries(['hanshu.fileHistory.v1', 'hanshu.fileBackups.v1'].map(key => [key, localStorage.getItem(key)]))
  downloadHistoryBlob(new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), source: 'local-browser-history', stores }, null, 2)], { type: 'application/json' }), 'hanshu-local-history.json')
}
