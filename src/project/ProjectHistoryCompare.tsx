import { useEffect, useMemo, useRef, useState } from 'react'
import * as monaco from 'monaco-editor'
import { editorLanguageForFile } from '../workspace'
import type { ProjectClient } from './serviceClient'
import { decodeHistoryContent, downloadHistoryBlob, historyBytes, historyContent, historyText, historyTree, type HistoryTree } from './historyClient'

type ContentView = { path: string; bytes: Uint8Array<ArrayBuffer>; text: string | null }
type Comparison = { left: HistoryTree; right: HistoryTree }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const imageType = (path: string) => ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' })[path.split('.').at(-1)?.toLowerCase() ?? '']

function HistoryTextDiff({ path, original, modified }: { path: string; original: string; modified: string }) {
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!container.current) return
    const language = editorLanguageForFile(path)
    const before = monaco.editor.createModel(original, language), after = monaco.editor.createModel(modified, language)
    const editor = monaco.editor.createDiffEditor(container.current, { readOnly: true, originalEditable: false, renderSideBySide: true, fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, wordWrap: 'on', ariaLabel: `历史文本对比 ${path}` })
    editor.setModel({ original: before, modified: after })
    return () => {
      // Monaco's diff view must detach its models before they are disposed.
      // Keeping this order explicit also covers switching versions and StrictMode.
      editor.setModel(null); editor.dispose(); before.dispose(); after.dispose()
    }
  }, [path, original, modified])
  return <div className="project-history-diff" ref={container} />
}

function ImagePreview({ content }: { content: ContentView }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    const next = URL.createObjectURL(new Blob([content.bytes], { type: imageType(content.path) }))
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [content])
  return url ? <img src={url} alt={`历史图片 ${content.path}`} /> : null
}

/** Both sides are immutable S revisions. Opening history never reads or replaces editor drafts. */
export function ProjectHistoryCompare({ client, left, right, initialPath, scope, onPathChange, onScopePath }: {
  client: ProjectClient; left: number; right: number; initialPath: string; scope: string; onPathChange: (path: string) => void; onScopePath: (path: string | null) => void
}) {
  const [comparison, setComparison] = useState<Comparison | null>(null)
  const [path, setPath] = useState(initialPath)
  const [onlyChanged, setOnlyChanged] = useState(true)
  const [contents, setContents] = useState<{ key: string; left: ContentView | null; right: ContentView | null } | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const key = `${left}:${right}:${path}`
  useEffect(() => {
    let cancelled = false
    setComparison(null); setError(''); setLoading(true)
    void Promise.all([historyTree(client, left, scope), historyTree(client, right, scope)]).then(([before, after]) => {
      if (!cancelled) setComparison({ left: before, right: after })
    }).catch(error => { if (!cancelled) setError(errorText(error)) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [client, left, right, scope])
  const rows = useMemo(() => {
    if (!comparison) return []
    const before = new Map(comparison.left.entries.map(entry => [entry.path, entry]))
    const after = new Map(comparison.right.entries.map(entry => [entry.path, entry]))
    return [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a.localeCompare(b, 'zh-CN')).map(path => {
      const previous = before.get(path), next = after.get(path)
      return { path, before: previous, after: next, changed: previous?.version !== next?.version || previous?.kind !== next?.kind,
        status: !previous ? '新增' : !next ? '删除' : previous.version !== next.version || previous.kind !== next.kind ? '修改' : '未变化' }
    }).filter(row => !(row.before?.kind === 'directory' && row.after?.kind === 'directory'))
  }, [comparison])
  const changedRows = rows.filter(row => row.changed)
  const visibleRows = onlyChanged && changedRows.length ? changedRows : rows
  const selected = rows.find(row => row.path === path)
  useEffect(() => {
    if (!rows.length) { onPathChange(''); return }
    if (path && rows.some(row => row.path === path)) return
    const next = rows.find(row => row.path === initialPath) ?? rows.find(row => row.path === comparison?.right.scopePath) ?? rows.find(row => row.changed) ?? rows[0]
    setPath(next.path)
  }, [rows, path, initialPath, onPathChange, comparison?.right.scopePath])
  useEffect(() => { onPathChange(selected?.path ?? '') }, [selected?.path, onPathChange])
  useEffect(() => { onScopePath(comparison?.right.scopePath ?? null) }, [comparison?.right.scopePath, onScopePath])
  useEffect(() => {
    if (!comparison || !selected) return
    let cancelled = false
    setContents(null); setError('')
    const load = async (side: 'left' | 'right') => {
      const entry = side === 'left' ? selected.before : selected.after
      if (!entry || entry.kind === 'directory' || entry.size > 2 * 1024 * 1024) return null
      const value = await historyContent(client, side === 'left' ? left : right, selected.path)
      const bytes = decodeHistoryContent(value)
      return { path: selected.path, bytes, text: historyText(bytes) }
    }
    void Promise.all([load('left'), load('right')]).then(([before, after]) => { if (!cancelled) setContents({ key, left: before, right: after }) })
      .catch(error => { if (!cancelled) setError(errorText(error)) })
    return () => { cancelled = true }
  }, [client, left, right, comparison, selected, key])
  const active = contents?.key === key ? contents : null
  const textComparable = active && [selected?.before, selected?.after].every(entry => !entry || entry.kind === 'file' && entry.size <= 2 * 1024 * 1024)
    && (!selected?.before || active.left?.text != null) && (!selected?.after || active.right?.text != null)
  async function download(side: 'left' | 'right') {
    if (!selected || downloading) return
    setDownloading(true); setError('')
    try {
      const content = await historyContent(client, side === 'left' ? left : right, selected.path)
      downloadHistoryBlob(new Blob([decodeHistoryContent(content)]), selected.path.split('/').at(-1) || 'history-file')
    } catch (error) { setError(errorText(error)) } finally { setDownloading(false) }
  }
  return <section className="project-history-compare" aria-label="历史版本对比">
    <aside className="project-history-files">
      <div className="project-history-files-heading"><strong>文件变化 <span>{changedRows.length}</span></strong><label><input type="checkbox" checked={onlyChanged} onChange={event => setOnlyChanged(event.target.checked)} />只看变化</label></div>
      {loading && <p role="status">正在读取两个版本…</p>}
      {!loading && !rows.length && <p>这两个版本中没有文件。</p>}
      {!loading && !changedRows.length && !!rows.length && <p className="project-history-muted">内容一致，显示此版本全部文件。</p>}
      <div className="project-history-file-list">{visibleRows.map(row => <button type="button" key={row.path} aria-label={`对比文件 ${row.path}`} aria-pressed={path === row.path} onClick={() => setPath(row.path)}><span className={`project-history-file-mark is-${row.status}`}>{row.status === '新增' ? '+' : row.status === '删除' ? '−' : row.changed ? '•' : '·'}</span><span>{row.path}</span><small>{row.status}</small></button>)}</div>
    </aside>
    <div className="project-history-content">
      <div className="project-history-content-heading"><strong title={path}>{path || '选择文件查看变化'}</strong><span>#{left} → #{right}</span></div>
      {error && <p className="project-history-error" role="alert">{error}</p>}
      {!selected ? <div className="project-history-empty">从左侧选择一个文件。历史查看不会改变当前草稿。</div>
        : textComparable ? <HistoryTextDiff path={path} original={active.left?.text ?? ''} modified={active.right?.text ?? ''} />
          : <div className="project-history-binary">{(['left', 'right'] as const).map(side => {
            const entry = side === 'left' ? selected.before : selected.after, content = active?.[side]
            return <article key={side}><h3>{side === 'left' ? '较早版本' : '较晚版本'} · #{side === 'left' ? left : right}</h3>
              {!entry ? <p>此版本中不存在</p> : entry.kind === 'directory' ? <p>目录</p> : <><p>{historyBytes(entry.size)} · {path.split('.').at(-1)?.toUpperCase() || '文件'}</p>{entry.size > 2 * 1024 * 1024 ? <p>文件较大，请下载查看完整内容。</p> : !active && !error ? <p role="status">正在读取内容…</p> : content && imageType(path) ? <ImagePreview content={content} /> : <p>二进制内容保留原文件，不进行文本合并。</p>}<button type="button" disabled={downloading || !client.online} onClick={() => void download(side)}>下载版本 #{side === 'left' ? left : right} 的文件</button></>}
            </article>
          })}</div>}
      {selected && textComparable && <div className="project-history-downloads">{selected.before?.kind === 'file' && <button type="button" disabled={downloading} onClick={() => void download('left')}>下载较早版本</button>}{selected.after?.kind === 'file' && <button type="button" disabled={downloading} onClick={() => void download('right')}>下载较晚版本</button>}</div>}
    </div>
  </section>
}
