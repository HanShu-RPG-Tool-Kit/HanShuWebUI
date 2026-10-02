import { useState, type ReactNode } from 'react'
import {
  type VoiceAssetEntry,
  type VoiceLibrary,
} from '../i18n/voiceLibrary'
import {
  formatVoiceChannels,
  formatVoiceDuration,
  type VoiceDecodeResult,
} from '../i18n/voiceRuntime'
import { formatBytes } from '../assets/paths'

/**
 * 音频资产浏览器：**搜索框 + 资源树**，录音棚里的候选音频就从这里挑。
 *
 * 独立成一个文件，是因为它将来可能出现在别处（例如资产的另一种挑选界面）；
 * 无论外框是侧栏还是别的形态，浏览体验必须一模一样，所以只允许这一份实现。
 *
 * 树根固定为 `assets`；文件项在**平台解不了**时才标红，
 * 能解但还不是目标格式（wav / 立体声 ogg / Opus…）属正常 —— 导入时会转码。
 */

export type VoiceTreeNode =
  | { kind: 'dir'; name: string; path: string; children: VoiceTreeNode[] }
  | { kind: 'file'; entry: VoiceAssetEntry }

/** 由扁平资产列表（相对 assets）建树 */
export function buildVoiceTree(entries: VoiceAssetEntry[]): VoiceTreeNode[] {
  const root: VoiceTreeNode[] = []
  const dirs = new Map<string, VoiceTreeNode[]>([['assets', root]])

  const ensureDir = (
    path: string,
    name: string,
    parent: VoiceTreeNode[],
  ): VoiceTreeNode[] => {
    const existing = dirs.get(path)
    if (existing) return existing
    const children: VoiceTreeNode[] = []
    parent.push({ kind: 'dir', name, path, children })
    dirs.set(path, children)
    return children
  }

  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    const parts = entry.relative.split('/')
    let parent = root
    let acc = 'assets'
    for (let i = 0; i < parts.length - 1; i++) {
      acc = `${acc}/${parts[i]}`
      parent = ensureDir(acc, parts[i], parent)
    }
    parent.push({ kind: 'file', entry })
  }

  const sortNodes = (nodes: VoiceTreeNode[]): VoiceTreeNode[] => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
      const an = a.kind === 'dir' ? a.name : a.entry.name
      const bn = b.kind === 'dir' ? b.name : b.entry.name
      return an.localeCompare(bn, 'zh-CN')
    })
    for (const node of nodes) if (node.kind === 'dir') sortNodes(node.children)
    return nodes
  }
  return sortNodes(root)
}

/** 格式文案：`WAV` / `OGG · Vorbis` / `OGG · Opus`（解出来才知道容器里装的是什么） */
export function voiceFormatOfPath(
  path: string,
  decoded: VoiceDecodeResult | null,
): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path.trim())?.[1]?.toLowerCase() ?? ''
  const base = ext ? ext.toUpperCase() : '无后缀'
  if (!decoded?.ok || ext !== 'ogg') return base
  const codec = decoded.info.codec
  const name =
    codec === 'vorbis' ? 'Vorbis' : codec === 'opus' ? 'Opus' : '未知编码'
  return `${base} · ${name}`
}

export type VoiceAssetBrowserProps = {
  library: VoiceLibrary
  query: string
  onQueryChange(value: string): void
  /** 当前选中的资产路径（null = 没选） */
  selected: string | null
  /** 点中某项（不可解的文件不会被选中，也不会回调） */
  onSelect(entry: VoiceAssetEntry): void
  /** 标记「这个文件就是某个键的对等文件」 */
  isTarget?(path: string): boolean
  /** 树上没有可显示内容时的文案 */
  emptyText?: string
  /** 搜索框占位文案 */
  placeholder?: string
}

export function VoiceAssetBrowser({
  library,
  query,
  onQueryChange,
  selected,
  onSelect,
  isTarget,
  emptyText,
  placeholder,
}: VoiceAssetBrowserProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const rootDir = library.rootDir()
  const entries = library.listAssets(query)
  const tree = buildVoiceTree(entries)

  const renderNodes = (nodes: VoiceTreeNode[], depth: number): ReactNode[] =>
    nodes.map((node) => {
      if (node.kind === 'dir') {
        // 有搜索词时全部展开，否则按折叠状态
        const isCollapsed = !query && Boolean(collapsed[node.path])
        return (
          <div key={node.path}>
            <div
              className="voice-tree-dir"
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() =>
                setCollapsed((prev) => ({ ...prev, [node.path]: !prev[node.path] }))
              }
            >
              <span className="voice-tree-twist">{isCollapsed ? '▸' : '▾'}</span>
              <span className="voice-tree-name">{node.name}</span>
            </div>
            {!isCollapsed && renderNodes(node.children, depth + 1)}
          </div>
        )
      }

      const entry = node.entry
      const info = library.peek(entry.path)
      const target = isTarget?.(entry.path) ?? false
      const badge = !entry.decodable
        ? { text: entry.ext ? `不可解 .${entry.ext}` : '不可解', warn: true }
        : info && info.ok
          ? {
              text: `${formatVoiceDuration(info.info.duration)} · ${formatVoiceChannels(info.info.channels)}`,
              warn: false,
            }
          : { text: formatBytes(entry.size), warn: false }

      return (
        <div
          key={entry.path}
          className={`voice-tree-file${entry.path === selected ? ' is-active' : ''}${entry.decodable ? '' : ' is-disabled'}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          title={entry.path}
          onClick={() => {
            if (!entry.decodable) return
            onSelect(entry)
          }}
        >
          <span className="voice-tree-twist" />
          <span className="voice-tree-name">
            {entry.name}
            {target && <span className="voice-tree-tag">目标</span>}
          </span>
          <span className={`voice-tree-badge${badge.warn ? ' is-warn' : ''}`}>
            {badge.text}
          </span>
        </div>
      )
    })

  return (
    <>
      <div className="voice-search">
        <input
          value={query}
          placeholder={placeholder ?? `在 ${rootDir} 下搜索（按路径匹配）`}
          onChange={(event) => onQueryChange(event.target.value)}
        />
      </div>

      <div className="voice-tree">
        <div className="voice-tree-root">{rootDir}</div>
        {tree.length > 0 ? (
          renderNodes(tree, 0)
        ) : (
          <div className="voice-tree-empty">
            {query ? '没有匹配的资产' : (emptyText ?? 'assets 下还没有资源')}
          </div>
        )}
      </div>
    </>
  )
}
