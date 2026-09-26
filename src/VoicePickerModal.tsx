import { useEffect, useState, type ReactNode } from 'react'
import { VOICE_EXTRA_GLYPHS, type VoiceGlyphPart } from './monaco/voiceIcons'
import {
  isCurrentTarget,
  type VoiceAssetEntry,
  type VoiceLibrary,
} from './i18n/voiceLibrary'
import { formatVoiceChannels, formatVoiceDuration } from './i18n/voiceRuntime'
import type { VoiceDecodeResult } from './i18n/voiceRuntime'
import { formatBytes } from './assets/paths'

/**
 * 音频选择器弹窗（Edit Voice）。
 *
 * 结构（与需求一致）：
 * - 顶部预览：左 2/3 画音频形状（没选时是一个框 + 叉），右 1/3 是元信息 + 播放键
 * - 中间搜索框：在 **assets**（根目录）下按路径模糊过滤
 * - 底部资源管理器：可见根目录**固定**为 `assets`
 *
 * 与旧版的区别：**不再编辑映射表**。选中的文件是「源」，点导入即把它按对等路径
 * 写进该键的位置（`assets/<语言标签>/voice/<脚本目录>/<键名>.ogg`），
 * 处理与写入由导入工作流负责（进度条见 VoiceImportProgress）。
 */

export type VoicePickerModalProps = {
  /** 正在指派配音的键名（不能叫 `key`：那是 React 的保留属性） */
  unitKey: string
  /** 对等目标路径（写入目标） */
  targetPath: string
  /** 目标当前解析到的资产路径（没有对等文件时为 null） */
  currentPath: string | null
  library: VoiceLibrary
  /** 触发导入：源 = 选中的资产路径 */
  onImport(sourcePath: string): void
  onClose(): void
}

type VoiceTreeNode =
  | { kind: 'dir'; name: string; path: string; children: VoiceTreeNode[] }
  | { kind: 'file'; entry: VoiceAssetEntry }

/** 由扁平资产列表（相对 assets）建树 */
function buildTree(entries: VoiceAssetEntry[]): VoiceTreeNode[] {
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

function VoiceGlyph({ parts }: { parts: VoiceGlyphPart[] }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {parts.map((part, index) =>
        part.mode === 'fill' ? (
          <path key={index} d={part.d} fill="currentColor" opacity={part.opacity} />
        ) : (
          <path
            key={index}
            d={part.d}
            fill="none"
            stroke="currentColor"
            strokeWidth={part.width ?? 2}
            strokeLinecap="round"
            opacity={part.opacity}
          />
        ),
      )}
    </svg>
  )
}

/** 音频形状：对称柱状波形（由解码后的峰值画） */
function VoiceWaveform({ peaks }: { peaks: number[] }) {
  const count = peaks.length || 1
  const slot = 100 / count
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="音频形状">
      {peaks.map((peak, index) => {
        const height = Math.max(peak * 94, 1)
        return (
          <rect
            key={index}
            x={index * slot + slot * 0.18}
            y={50 - height / 2}
            width={slot * 0.64}
            height={height}
            fill="currentColor"
            opacity={0.9}
          />
        )
      })}
    </svg>
  )
}

/** 格式文案：`WAV` / `OGG · Vorbis` / `OGG · Opus`（解出来才知道容器里装的是什么） */
function formatLabel(
  entry: VoiceAssetEntry,
  decoded: VoiceDecodeResult | null,
): string {
  const base = entry.ext ? entry.ext.toUpperCase() : '无后缀'
  if (!decoded?.ok || entry.ext.toLowerCase() !== 'ogg') return base
  const codec = decoded.info.codec
  const name =
    codec === 'vorbis' ? 'Vorbis' : codec === 'opus' ? 'Opus' : '未知编码'
  return `${base} · ${name}`
}

export function VoicePickerModal({
  unitKey,
  targetPath,
  currentPath,
  library,
  onImport,
  onClose,
}: VoicePickerModalProps) {
  const [query, setQuery] = useState('')
  // 默认选中「当前对等文件」（如果有），否则什么都不选
  const [selected, setSelected] = useState<string | null>(currentPath)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  /** 解码完成 / 试听状态变化时重画（订阅音频映射管理） */
  const [, setTick] = useState(0)

  useEffect(() => {
    const unsubscribe = library.subscribe(() => setTick((n) => n + 1))
    return unsubscribe
  }, [library])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const rootDir = library.rootDir()
  const entries = library.listAssets(query)
  const tree = buildTree(entries)

  const selectedEntry = selected
    ? (entries.find((entry) => entry.path === selected) ?? null)
    : null
  const decoded = selected ? library.inspect(selected) : null
  const previewing = selected ? library.isPreviewing(selected) : false
  const channelWarn =
    selectedEntry != null &&
    decoded != null &&
    decoded.ok &&
    decoded.info.channels !== 1
  const canImport = selectedEntry != null && selectedEntry.decodable

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
      const isTarget = isCurrentTarget(
        entry.path,
        library.locale,
        library.scriptName,
        unitKey,
      )
      const badge = !entry.decodable
        ? { text: entry.ext ? `不可解 .${entry.ext}` : '不可解', warn: true }
        : info && !info.ok
          ? { text: '解码失败', warn: true }
          : info && info.ok
            ? {
                text: `${formatVoiceDuration(info.info.duration)} · ${formatVoiceChannels(info.info.channels)}`,
                warn: info.info.channels !== 1,
              }
            : { text: formatBytes(entry.size), warn: false }

      return (
        <div
          key={entry.path}
          className={`voice-tree-file${entry.path === selected ? ' is-active' : ''}${entry.decodable ? '' : ' is-disabled'}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          title={entry.path}
          onClick={() => {
            if (entry.decodable) setSelected(entry.path)
          }}
        >
          <span className="voice-tree-twist" />
          <span className="voice-tree-name">
            {entry.name}
            {isTarget && <span className="voice-tree-tag">目标</span>}
          </span>
          <span className={`voice-tree-badge${badge.warn ? ' is-warn' : ''}`}>
            {badge.text}
          </span>
        </div>
      )
    })

  return (
    <div className="voice-picker-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="voice-picker" onClick={(event) => event.stopPropagation()}>
        <div className="voice-picker-header">
          <div className="voice-picker-title">
            选择配音
            <span className="voice-picker-key">键名 {unitKey}</span>
          </div>
          <button type="button" className="voice-picker-close" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="voice-picker-preview">
          <div
            className={`voice-picker-wave${selectedEntry && decoded?.ok ? '' : ' is-empty'}`}
          >
            {selectedEntry && decoded?.ok ? (
              <VoiceWaveform peaks={decoded.info.peaks} />
            ) : (
              <VoiceGlyph parts={VOICE_EXTRA_GLYPHS.emptyBox} />
            )}
          </div>

          <div className="voice-picker-info">
            <div className="voice-picker-row">
              <span className="voice-picker-row-label">源文件</span>
              <span className="voice-picker-row-value">
                {selectedEntry ? selectedEntry.name : '未选择'}
              </span>
            </div>
            <div className="voice-picker-row">
              <span className="voice-picker-row-label">格式</span>
              <span className="voice-picker-row-value">
                {selectedEntry ? formatLabel(selectedEntry, decoded) : '—'}
              </span>
            </div>
            <div className="voice-picker-row">
              <span className="voice-picker-row-label">声道</span>
              <span className="voice-picker-row-value">
                {decoded?.ok
                  ? formatVoiceChannels(decoded.info.channels)
                  : selectedEntry
                    ? '解码中…'
                    : '—'}
              </span>
            </div>
            <div className="voice-picker-row">
              <span className="voice-picker-row-label">时长</span>
              <span className="voice-picker-row-value">
                {decoded?.ok ? formatVoiceDuration(decoded.info.duration) : '—'}
              </span>
            </div>
            <div className="voice-picker-row">
              <span className="voice-picker-row-label">目标</span>
              <span className="voice-picker-row-value" title={targetPath}>
                {targetPath}
                {currentPath ? '（已存在）' : '（还没有）'}
              </span>
            </div>
            {selectedEntry && decoded && !decoded.ok && (
              <div className="voice-picker-hint is-danger">{decoded.reason}</div>
            )}
            {channelWarn && (
              <div className="voice-picker-hint is-warn">
                选中项不是单通道，导入后按钮会显示为「音频无效」
              </div>
            )}
            <button
              type="button"
              className="voice-picker-play"
              disabled={selectedEntry == null || decoded?.ok === false}
              onClick={() => {
                if (!selected) return
                if (previewing) library.stop()
                else library.preview(selected)
              }}
            >
              <VoiceGlyph parts={VOICE_EXTRA_GLYPHS.play} />
              {previewing ? '停止' : '播放'}
            </button>
          </div>
        </div>

        <div className="voice-picker-search">
          <input
            value={query}
            placeholder={`在 ${rootDir} 下搜索（按路径匹配）`}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <div className="voice-picker-tree">
          <div className="voice-tree-root">{rootDir}</div>
          {tree.length > 0 ? (
            renderNodes(tree, 0)
          ) : (
            <div className="voice-tree-empty">
              {query ? '没有匹配的资产' : 'assets 下还没有资源'}
            </div>
          )}
        </div>

        <div className="voice-picker-footer">
          <span className="voice-picker-hint">
            {selectedEntry && !selectedEntry.decodable
              ? `平台解不了这个格式，请换 wav / mp3 / ogg / flac / m4a 等常见格式`
              : channelWarn
                ? '导入时会转成单通道 Vorbis'
                : currentPath
                  ? '导入会覆盖现有对等文件'
                  : '导入会生成对等文件'}
          </span>
          <span className="spacer" />
          <button type="button" className="voice-picker-btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="voice-picker-btn is-primary"
            disabled={!canImport}
            onClick={() => {
              if (!selectedEntry) return
              onImport(selectedEntry.path)
            }}
          >
            导入
          </button>
        </div>
      </div>
    </div>
  )
}
