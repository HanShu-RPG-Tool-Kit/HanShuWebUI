import { useEffect, useState } from 'react'
import { VOICE_EXTRA_GLYPHS } from './ui/voiceIcons'
import { VoiceGlyph, VoiceWaveform } from './ui/VoiceVisuals'
import { isCurrentVoiceAsset } from './i18n/voiceLibrary'
import type { VoiceLibrary } from './i18n/voiceLibrary'
import { formatVoiceChannels, formatVoiceDuration } from './i18n/voiceRuntime'
import { hasExternalFiles } from './drag/dragPayload'
import { formatBytes } from './assets/paths'
import {
  VoiceAssetBrowser,
  voiceFormatLabel,
} from './studio/VoiceAssetBrowser'

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
 *
 * 搜索框 + 资源树与**录音棚共用同一实现**（见 studio/VoiceAssetBrowser），
 * 图标与波形同理（见 ui/VoiceVisuals）—— 两边不许各写一份。
 */

/** 拖进来的外部文件：先缓存在内存里当候选源，点"导入"才真正写入 */
export type PendingVoiceFile = {
  name: string
  ext: string
  size: number
  bytes: Uint8Array
}

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
  /** 导入内存里缓存的拖入文件 */
  onImportFile(source: { name: string; bytes: Uint8Array }): void
  onClose(): void
}

export function VoicePickerModal({
  unitKey,
  targetPath,
  currentPath,
  library,
  onImport,
  onImportFile,
  onClose,
}: VoicePickerModalProps) {
  const [query, setQuery] = useState('')
  // 默认选中「当前对等文件」（如果有），否则什么都不选
  const [selected, setSelected] = useState<string | null>(currentPath)
  /** 有外部文件拖到预览框上（框式高亮） */
  const [dropActive, setDropActive] = useState(false)
  /**
   * 拖进来的外部文件：**只缓存进内存**，作为当前候选源显示；
   * 点"导入"才真的写入，关闭弹窗即丢弃（组件卸载，字节随之释放）。
   */
  const [pending, setPending] = useState<PendingVoiceFile | null>(null)
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

  const entries = library.listAssets(query)

  const selectedEntry = selected
    ? (entries.find((entry) => entry.path === selected) ?? null)
    : null
  const decoded = selected ? library.inspect(selected) : null
  /** 缓冲文件的播放态标识：它没有资产路径，用 name+size 造一个稳定的 id */
  const pendingId = pending ? `pending:${pending.name}:${pending.size}` : null
  const previewing = pendingId
    ? library.isPreviewing(pendingId)
    : selected
      ? library.isPreviewing(selected)
      : false

  // 候选源：优先内存里那个拖入文件，其次是树里选中的资产
  const sourceName = pending ? pending.name : (selectedEntry?.name ?? null)
  const sourceFormat = pending
    ? pending.ext
      ? pending.ext.toUpperCase()
      : '无后缀'
    : selectedEntry
      ? voiceFormatLabel(selectedEntry, decoded)
      : null
  const canImport = pending != null || (selectedEntry != null && selectedEntry.decodable)
  /**
   * 能否试听：**只看"平台认不认这个后缀"**，不看我们自己那套成品校验的解码结果。
   * 播放本来就是浏览器直接放 blob，跟"是不是单通道 Vorbis ogg"无关；
   * 之前挂在 `decoded.ok` 上，导致 wav/mp3 这些完全能播的源被禁用（点了没反应）。
   * 拖入的缓冲文件也能试听（字节就在内存里，走 previewBlob）。
   */
  const canPreview = pending != null || (selectedEntry?.decodable ?? false)

  /** 把拖入的文件读进内存当候选源（**不**直接导入） */
  const cacheDroppedFile = (file: File) => {
    void file
      .arrayBuffer()
      .then((buffer) => {
        const dot = file.name.lastIndexOf('.')
        setPending({
          name: file.name,
          ext: dot > 0 ? file.name.slice(dot + 1).toLowerCase() : '',
          size: file.size,
          bytes: new Uint8Array(buffer),
        })
        setSelected(null)
      })
      .catch((error: unknown) => {
        console.warn('[hanshu] 读取拖入的音频失败', error)
      })
  }

  return (
    <div
      className="voice-picker-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      // 兜底：拖到弹窗别处（搜索框 / 树 / 页脚）也必须吃掉默认行为，
      // 否则浏览器会直接导航到那个文件，应用状态全丢
      onDragOver={(event) => {
        if (!hasExternalFiles(event.dataTransfer)) return
        event.preventDefault()
      }}
      onDrop={(event) => {
        if (!hasExternalFiles(event.dataTransfer)) return
        event.preventDefault()
        setDropActive(false)
      }}
    >
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
            className={`voice-picker-wave${selectedEntry && decoded?.ok ? '' : ' is-empty'}${
              dropActive ? ' is-drop-target' : ''
            }`}
            title="可以把外部音频文件拖到这里，等同于点导入"
            onDragOver={(event) => {
              // 注意：dragover 阶段 dataTransfer.files 往往是空的（规范只保证 drop 时有），
              // 判定要用 types 里的 'Files' —— 见 hasExternalFiles。
              // 不 preventDefault 的话浏览器根本不允许投放，drop 永远不会来，
              // 松手还可能直接导航到那个文件。
              if (!hasExternalFiles(event.dataTransfer)) return
              event.preventDefault()
              event.stopPropagation()
              if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
              setDropActive(true)
            }}
            onDragLeave={(event) => {
              const next = event.relatedTarget as Node | null
              if (!next || !event.currentTarget.contains(next)) setDropActive(false)
            }}
            onDrop={(event) => {
              const file = event.dataTransfer?.files?.[0]
              setDropActive(false)
              if (!file) return
              event.preventDefault()
              event.stopPropagation()
              // 只缓存，不导入
              cacheDroppedFile(file)
            }}
          >
            {pending ? (
              <div className="voice-picker-pending" title={pending.name}>
                <span className="voice-picker-pending-name">{pending.name}</span>
                <span className="voice-picker-pending-hint">
                  已缓存到内存（{formatBytes(pending.size)}）· 点「导入」写入
                </span>
              </div>
            ) : selectedEntry && decoded?.ok ? (
              <VoiceWaveform peaks={decoded.info.peaks} />
            ) : (
              <VoiceGlyph parts={VOICE_EXTRA_GLYPHS.emptyBox} />
            )}
            {dropActive && (
              // 半透明白色幕布：明确"这里能放"。注意拖入只是**选用**，不会直接导入。
              // pointer-events: none —— 拖拽事件仍然打在框上，别让幕布改变 dragleave 判定。
              <div className="voice-picker-wave-scrim">
                <span>松开即可选用</span>
              </div>
            )}
          </div>

          <div className="voice-picker-info">
            <div className="voice-picker-row">
              <span className="voice-picker-row-label">源文件</span>
              <span className="voice-picker-row-value" title={sourceName ?? undefined}>
                {sourceName ?? '未选择'}
                {pending ? '（拖入 · 未导入）' : ''}
              </span>
            </div>
            <div className="voice-picker-row">
              <span className="voice-picker-row-label">格式</span>
              <span className="voice-picker-row-value">{sourceFormat ?? '—'}</span>
            </div>
            <div className="voice-picker-row">
              <span className="voice-picker-row-label">声道</span>
              <span className="voice-picker-row-value">
                {pending
                  ? '—'
                  : decoded?.ok
                    ? formatVoiceChannels(decoded.info.channels)
                    : selectedEntry
                      ? '解码中…'
                      : '—'}
              </span>
            </div>
            <div className="voice-picker-row">
              <span className="voice-picker-row-label">时长</span>
              <span className="voice-picker-row-value">
                {!pending && decoded?.ok
                  ? formatVoiceDuration(decoded.info.duration)
                  : '—'}
              </span>
            </div>
            <div className="voice-picker-row">
              <span className="voice-picker-row-label">目标</span>
              <span className="voice-picker-row-value" title={targetPath}>
                {targetPath}
                {currentPath ? '（已存在）' : '（还没有）'}
              </span>
            </div>
            <button
              type="button"
              className="voice-picker-play"
              disabled={!canPreview}
              title={canPreview ? undefined : '这个文件预览不了'}
              onClick={() => {
                if (previewing) {
                  library.stop()
                  return
                }
                // 缓冲文件：字节在内存里，走 blob 播放（没有资产路径可读）
                if (pending && pendingId) {
                  library.previewBlob(pendingId, pending.name, pending.bytes)
                  return
                }
                if (selected) library.preview(selected)
              }}
            >
              {/* 正在试听时给暂停符号（三角容易让人以为还要再点一次才会响） */}
              <VoiceGlyph
                parts={previewing ? VOICE_EXTRA_GLYPHS.pause : VOICE_EXTRA_GLYPHS.play}
              />
              {previewing ? '停止' : '播放'}
            </button>
          </div>
        </div>

        <VoiceAssetBrowser
          library={library}
          query={query}
          onQueryChange={setQuery}
          selected={pending ? null : selected}
          onSelect={(entry) => {
            // 改选资产 = 放弃内存里那个拖入文件
            setPending(null)
            setSelected(entry.path)
          }}
          isTarget={(path) =>
            isCurrentVoiceAsset(path, library.locale, library.scriptName, unitKey)
          }
        />

        <div className="voice-picker-footer">
          <span className="voice-picker-hint">
            {pending
              ? `已缓存拖入的文件，点「导入」才会写入`
              : selectedEntry && !selectedEntry.decodable
                ? `平台解不了这个格式，请换 wav / mp3 / ogg / flac / m4a 等常见格式`
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
              if (pending) {
                onImportFile({ name: pending.name, bytes: pending.bytes })
                return
              }
              if (selectedEntry) onImport(selectedEntry.path)
            }}
          >
            导入
          </button>
        </div>
      </div>
    </div>
  )
}
