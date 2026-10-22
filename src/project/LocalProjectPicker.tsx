import { useEffect, useRef, useState } from 'react'
import { request } from '../collab/protocol'
import type { LocalDirectory as Directory, LocalDirectoryListing as Listing, LocalProjectHost } from './localProjects'

export function LocalProjectPicker({ host, opening, onOpen, onCancel, mode = 'open' }: { host: LocalProjectHost; opening: boolean; onOpen: (directoryId: string, path: string) => void; onCancel: () => void; mode?: 'open' | 'location' }) {
  const [listing, setListing] = useState<Listing | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<Directory | null>(null)
  const sequence = useRef(0)
  async function browse(directory: Directory, query = '') {
    const ticket = ++sequence.current
    setLoading(true); setError('')
    try {
      const next = await request<Listing>(host.connection, `/api/local/directories?directoryId=${encodeURIComponent(directory.id)}&filter=${encodeURIComponent(query)}`)
      if (ticket !== sequence.current) return
      setListing(next); setSelected(null); setFilter(query)
    } catch (error) { if (ticket === sequence.current) setError(error instanceof Error ? error.message : String(error)) }
    finally { if (ticket === sequence.current) setLoading(false) }
  }
  useEffect(() => () => { sequence.current++ }, [])
  const disabled = opening || loading
  const target = selected ?? listing?.directory
  return <section className="local-project-picker" aria-label="选择本机工程目录">
    <p>{mode === 'location' ? '选择保存位置，新工程会放在这个位置下的独立文件夹中。' : '选择工程文件夹。'}</p>
    <div className="local-project-layout">
      <nav aria-label="本机位置">{host.roots.map(root => <button key={root.id} type="button" title={root.path} disabled={opening} onClick={() => void browse(root)}>{root.name}</button>)}</nav>
      <div className="local-project-browser">
        <div className="local-project-location"><button type="button" disabled={disabled || !listing?.parent} onClick={() => { if (listing?.parent) void browse(listing.parent) }}>上一级</button><span title={listing?.directory.path}>{listing?.directory.path ?? '请在左侧选择位置'}</span></div>
        {listing && <div className="local-project-filter"><input aria-label="筛选本机文件夹" placeholder="筛选文件夹…" value={filter} disabled={opening} onChange={event => setFilter(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void browse(listing.directory, filter) } }} /><button type="button" disabled={disabled} onClick={() => void browse(listing.directory, filter)}>筛选</button></div>}
        <div className="local-project-folders" role="listbox" aria-label="本机文件夹" aria-busy={loading}>
          {listing?.entries.map(directory => <button type="button" role="option" aria-selected={selected?.id === directory.id} key={directory.id} disabled={disabled} onClick={() => setSelected(directory)} onDoubleClick={() => void browse(directory)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void browse(directory) } }}><span aria-hidden="true">▸</span>{directory.name}</button>)}
          {!listing && !loading && <p>选择一个位置以浏览文件夹。</p>}
          {listing && !listing.entries.length && !loading && <p>没有子文件夹，可以打开当前目录。</p>}
          {loading && <p role="status">正在读取目录…</p>}
        </div>
        {listing?.truncated && <small>文件夹较多，请输入名称筛选。</small>}
        {error && <p role="alert">{error}</p>}
      </div>
    </div>
    <div className="local-project-target"><span>{mode === 'location' ? '保存位置' : '将打开'}</span><strong>{target?.path ?? '尚未选择目录'}</strong></div>
    <footer><button type="button" disabled={opening} onClick={onCancel}>返回</button><button type="button" className="is-primary" disabled={disabled || !target} onClick={() => { if (target) onOpen(target.id, target.path) }}>{opening ? '正在打开…' : mode === 'location' ? '选择此位置' : '打开此文件夹'}</button></footer>
  </section>
}
