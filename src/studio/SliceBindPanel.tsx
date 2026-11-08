/**
 * 切段绑键：导入一条或多条单音轨音频，在波形上划出若干段，每段绑一个台词 key，
 * 确认后按段裁切并走既有 `onImport`（转成对等 .ogg）。
 *
 * 不做多音轨并排；多文件用列表切换，各自切段。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type { VoiceLibrary } from '../i18n/voiceLibrary'
import { formatVoiceDuration } from '../i18n/voiceRuntime'
import type { VoiceImportSource } from '../i18n/voiceImport'
import { VOICE_EXTRA_GLYPHS } from '../ui/voiceIcons'
import { VoiceGlyph } from '../ui/VoiceVisuals'
import { WaveformSlot } from './WaveformSlot'
import {
  decodeMemoryAudio,
  trimAudioBytes,
  type MemoryAudioInfo,
} from './audioPreview'

export type SliceBindStatus = {
  canConfirm: boolean
  hint: string
  confirm(): Promise<void>
}

type SliceFile = {
  id: string
  name: string
  bytes: Uint8Array
  status: 'decoding' | 'ready' | 'failed'
  info: MemoryAudioInfo | null
}

type SliceSegment = {
  id: string
  fileId: string
  /** 相对整段 0..1 */
  start: number
  end: number
  key: string | null
}

const SEGMENT_COLORS = [
  'rgb(78 201 176 / 35%)',
  'rgb(214 186 74 / 35%)',
  'rgb(126 160 232 / 35%)',
  'rgb(206 120 170 / 35%)',
  'rgb(140 200 100 / 35%)',
]

const MIN_GAP = 0.02
const MIN_SEC = 0.05

function newId(prefix: string): string {
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`
}

function ratioFromEvent(
  event: ReactPointerEvent<HTMLElement>,
  el: HTMLElement,
): number {
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0) return 0
  return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
}

export type SliceBindPanelProps = {
  selectedKeys: string[]
  textFor?: (key: string) => string | null
  library: VoiceLibrary
  /** 父级把外部拖入的多文件灌进来 */
  addFilesRef: MutableRefObject<((files: File[]) => void) | null>
  onStatusChange(status: SliceBindStatus): void
  onNotice(message: string | null): void
  onImport(keys: string[], source: VoiceImportSource): void | Promise<void>
}

export function SliceBindPanel({
  selectedKeys,
  textFor,
  library,
  addFilesRef,
  onStatusChange,
  onNotice,
  onImport,
}: SliceBindPanelProps) {
  const [files, setFiles] = useState<SliceFile[]>([])
  const [activeFileId, setActiveFileId] = useState<string | null>(null)
  const [segments, setSegments] = useState<SliceSegment[]>([])
  const [activeSegId, setActiveSegId] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [, setProgressTick] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const waveRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<
    | { kind: 'create'; segId: string; anchor: number }
    | { kind: 'resize'; segId: string; which: 'start' | 'end' }
    | null
  >(null)

  const activeFile = files.find((f) => f.id === activeFileId) ?? null
  const fileSegments = useMemo(
    () => segments.filter((s) => s.fileId === activeFileId),
    [segments, activeFileId],
  )

  const keyOwner = useMemo(() => {
    const map = new Map<string, string>()
    for (const seg of segments) {
      if (seg.key) map.set(seg.key, seg.id)
    }
    return map
  }, [segments])

  const assigned = segments.filter((s) => s.key)
  const progress = library.previewProgress()
  const [previewBusySeg, setPreviewBusySeg] = useState<string | null>(null)

  useEffect(() => {
    const off = library.subscribePreviewProgress(() => setProgressTick((n) => n + 1))
    const offState = library.subscribe(() => setProgressTick((n) => n + 1))
    return () => {
      off()
      offState()
    }
  }, [library])

  const playingSegId =
    segments.find((s) => library.isPreviewing(s.id))?.id ?? null

  const ingestBuffers = useCallback(
    (items: { name: string; bytes: Uint8Array }[]) => {
      if (items.length === 0) return
      const created: SliceFile[] = items.map((item) => ({
        id: newId('file'),
        name: item.name,
        bytes: item.bytes,
        status: 'decoding' as const,
        info: null,
      }))
      setFiles((prev) => [...prev, ...created])
      setActiveFileId((prev) => prev ?? created[0]?.id ?? null)
      onNotice(null)
      for (const file of created) {
        void decodeMemoryAudio(file.bytes).then((info) => {
          setFiles((prev) =>
            prev.map((f) =>
              f.id === file.id
                ? {
                    ...f,
                    status: info ? 'ready' : 'failed',
                    info,
                  }
                : f,
            ),
          )
          if (!info) {
            onNotice(`「${file.name}」解不开（支持 wav / mp3 / flac / m4a / ogg …）`)
          }
        })
      }
    },
    [onNotice],
  )

  const addFiles = useCallback(
    (list: File[]) => {
      const audio = list.filter((f) => {
        const lower = f.name.toLowerCase()
        return (
          f.type.startsWith('audio/') ||
          /\.(wav|mp3|ogg|oga|opus|flac|m4a|mp4|aac|webm|weba)$/i.test(lower)
        )
      })
      if (audio.length === 0) {
        onNotice('没有可识别的音频文件')
        return
      }
      void Promise.all(
        audio.map(async (file) => ({
          name: file.name,
          bytes: new Uint8Array(await file.arrayBuffer()),
        })),
      ).then(ingestBuffers)
    },
    [ingestBuffers, onNotice],
  )

  useEffect(() => {
    addFilesRef.current = addFiles
    return () => {
      addFilesRef.current = null
    }
  }, [addFiles, addFilesRef])

  const addSegment = useCallback(() => {
    if (!activeFile || activeFile.status !== 'ready' || !activeFile.info) return
    const start = 0.35
    const end = 0.65
    const id = newId('seg')
    setSegments((prev) => [
      ...prev,
      { id, fileId: activeFile.id, start, end, key: null },
    ])
    setActiveSegId(id)
  }, [activeFile])

  const removeSegment = (id: string) => {
    if (library.isPreviewing(id)) library.stop()
    setSegments((prev) => prev.filter((s) => s.id !== id))
    setActiveSegId((prev) => (prev === id ? null : prev))
  }

  const removeFile = (id: string) => {
    setSegments((prev) => prev.filter((s) => s.fileId !== id))
    setFiles((prev) => {
      const rest = prev.filter((f) => f.id !== id)
      setActiveFileId((cur) => (cur === id ? (rest[0]?.id ?? null) : cur))
      return rest
    })
    if (library.isPreviewing(id)) library.stop()
  }

  const bindKey = (key: string) => {
    if (!activeSegId) {
      onNotice('先在波形上选中或新增一段')
      return
    }
    setSegments((prev) =>
      prev.map((s) => {
        if (s.id === activeSegId) return { ...s, key }
        // 同一 key 只能绑一段
        if (s.key === key) return { ...s, key: null }
        return s
      }),
    )
    onNotice(null)
  }

  const clearKey = (segId: string) => {
    setSegments((prev) =>
      prev.map((s) => (s.id === segId ? { ...s, key: null } : s)),
    )
  }

  /** 试听某一选段：先裁成短 wav 再播，播完自然停 */
  const toggleSegPreview = async (segId: string) => {
    const seg = segments.find((s) => s.id === segId)
    const file = seg ? files.find((f) => f.id === seg.fileId) : null
    if (!seg || !file?.info || file.status !== 'ready') return

    if (library.isPreviewing(seg.id) && progress) {
      if (progress.paused) library.resumePreview()
      else library.pausePreview()
      return
    }

    const dur = file.info.duration
    const span = (seg.end - seg.start) * dur
    if (span < MIN_SEC) {
      onNotice('这段太短了，至少留 0.05 秒')
      return
    }

    setPreviewBusySeg(seg.id)
    setActiveSegId(seg.id)
    try {
      const trimmed = await trimAudioBytes(
        file.bytes,
        dur * seg.start,
        dur * seg.end,
      )
      if (!trimmed) {
        onNotice('这段裁切失败，无法试听')
        return
      }
      library.previewBlob(seg.id, `${seg.key ?? '选段'}.wav`, trimmed.bytes)
    } finally {
      setPreviewBusySeg(null)
    }
  }

  const onWavePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!activeFile || activeFile.status !== 'ready') return
    const handle = (event.target as HTMLElement | null)?.dataset?.sliceHandle
    const segAttr = (event.target as HTMLElement | null)?.dataset?.sliceSeg
    const wave = waveRef.current
    if (!wave) return
    const ratio = ratioFromEvent(event, wave)

    if (handle === 'start' || handle === 'end') {
      const segId = segAttr
      if (!segId) return
      setActiveSegId(segId)
      dragRef.current = { kind: 'resize', segId, which: handle }
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }

    // 点到已有段 → 选中
    const hit = fileSegments.find((s) => ratio >= s.start && ratio <= s.end)
    if (hit && !(event.shiftKey || event.altKey)) {
      setActiveSegId(hit.id)
      return
    }

    // 空白处拖出新段（或按住 Alt 强制新建）
    const id = newId('seg')
    setSegments((prev) => [
      ...prev,
      { id, fileId: activeFile.id, start: ratio, end: Math.min(1, ratio + MIN_GAP), key: null },
    ])
    setActiveSegId(id)
    dragRef.current = { kind: 'create', segId: id, anchor: ratio }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onWavePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    const wave = waveRef.current
    if (!drag || !wave) return
    const ratio = ratioFromEvent(event, wave)
    if (drag.kind === 'create') {
      const a = drag.anchor
      const start = Math.min(a, ratio)
      const end = Math.max(a, ratio)
      setSegments((prev) =>
        prev.map((s) =>
          s.id === drag.segId
            ? {
                ...s,
                start,
                end: Math.max(end, start + MIN_GAP),
              }
            : s,
        ),
      )
      return
    }
    setSegments((prev) =>
      prev.map((s) => {
        if (s.id !== drag.segId) return s
        if (drag.which === 'start') {
          return { ...s, start: Math.min(ratio, s.end - MIN_GAP) }
        }
        return { ...s, end: Math.max(ratio, s.start + MIN_GAP) }
      }),
    )
  }

  const endWaveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    const drag = dragRef.current
    dragRef.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* already released */
    }
    // 过短的新建段丢掉
    if (drag.kind === 'create' && activeFile?.info) {
      setSegments((prev) =>
        prev.filter((s) => {
          if (s.id !== drag.segId) return true
          const dur = (s.end - s.start) * (activeFile.info?.duration ?? 0)
          return dur >= MIN_SEC
        }),
      )
    }
  }

  const runConfirm = useCallback(async () => {
    if (importing || assigned.length === 0) return
    setImporting(true)
    onNotice(null)
    library.stop()
    const doneSegIds: string[] = []
    const total = assigned.length
    try {
      for (const seg of assigned) {
        const file = files.find((f) => f.id === seg.fileId)
        if (!file?.info || !seg.key) continue
        const dur = file.info.duration
        const trimmed = await trimAudioBytes(
          file.bytes,
          dur * seg.start,
          dur * seg.end,
        )
        if (!trimmed) {
          onNotice(`「${seg.key}」裁切失败`)
          break
        }
        await onImport([seg.key], {
          kind: 'file',
          name: `${seg.key}.wav`,
          bytes: trimmed.bytes,
        })
        doneSegIds.push(seg.id)
      }
      if (doneSegIds.length > 0) {
        setSegments((prev) => prev.filter((s) => !doneSegIds.includes(s.id)))
        setActiveSegId(null)
        onNotice(
          doneSegIds.length === total
            ? `已导入 ${doneSegIds.length} 段`
            : `已导入 ${doneSegIds.length} / ${total} 段`,
        )
      }
    } finally {
      setImporting(false)
    }
  }, [assigned, files, importing, library, onImport, onNotice])

  const confirmRef = useRef(runConfirm)
  confirmRef.current = runConfirm

  const canConfirm =
    !importing && files.length > 0 && selectedKeys.length > 0 && assigned.length > 0
  const hint = importing
    ? '正在按段导入…'
    : files.length === 0
      ? '拖入或选择一段或多段 wav（可多文件）'
      : selectedKeys.length === 0
        ? '在编辑器里选要绑的键名'
        : assigned.length === 0
          ? '在波形上拖出片段，再点下方键名绑定'
          : `按段写入 ${assigned.length} 个键`

  useEffect(() => {
    onStatusChange({
      canConfirm,
      hint,
      confirm: () => confirmRef.current(),
    })
  }, [canConfirm, hint, onStatusChange])

  const playingSeg = playingSegId
    ? segments.find((s) => s.id === playingSegId)
    : null
  const playedRatio =
    playingSeg &&
    progress &&
    progress.duration > 0 &&
    playingSeg.fileId === activeFileId
      ? playingSeg.start +
        (progress.current / progress.duration) *
          (playingSeg.end - playingSeg.start)
      : 0

  return (
    <div className="studio-slice">
      <div className="studio-slice-toolbar">
        <button
          type="button"
          className="studio-mini"
          onClick={() => fileInputRef.current?.click()}
          title="可一次选多个音频文件"
        >
          选择文件…
        </button>
        <input
          ref={fileInputRef}
          className="studio-file-input"
          type="file"
          accept="audio/*,.wav,.mp3,.ogg,.flac,.m4a"
          multiple
          onChange={(event) => {
            const list = Array.from(event.target.files ?? [])
            event.target.value = ''
            if (list.length) addFiles(list)
          }}
        />
        <button
          type="button"
          className="studio-mini"
          disabled={!activeFile || activeFile.status !== 'ready'}
          onClick={addSegment}
          title="在当前文件上加一段（也可在波形空白处拖出）"
        >
          加一段
        </button>
        <span className="spacer" />
        <span className="studio-slice-meta">
          {files.length} 个文件 · {assigned.length} 段已绑键
        </span>
      </div>

      {files.length > 0 && (
        <div className="studio-slice-files" role="tablist" aria-label="音频文件">
          {files.map((file) => (
            <button
              key={file.id}
              type="button"
              role="tab"
              aria-selected={file.id === activeFileId}
              className={`studio-slice-file${file.id === activeFileId ? ' is-on' : ''}${
                file.status === 'failed' ? ' is-failed' : ''
              }`}
              onClick={() => setActiveFileId(file.id)}
              title={file.name}
            >
              <span className="studio-slice-file-name">{file.name}</span>
              <span
                className="studio-slice-file-x"
                onClick={(event) => {
                  event.stopPropagation()
                  removeFile(file.id)
                }}
                title="移除这个文件"
              >
                ×
              </span>
            </button>
          ))}
        </div>
      )}

      <div
        ref={waveRef}
        className={`studio-slice-wave${activeFile?.status === 'ready' ? ' is-filled' : ' is-empty'}`}
        onPointerDown={onWavePointerDown}
        onPointerMove={onWavePointerMove}
        onPointerUp={endWaveDrag}
        onPointerCancel={endWaveDrag}
        title="在空白处拖出片段；拖两端把手调整；点片段选中"
      >
        {activeFile?.status === 'ready' && activeFile.info ? (
          <WaveformSlot
            state={{
              kind: 'ready',
              peaks: activeFile.info.peaks,
              progress: playedRatio,
            }}
          />
        ) : activeFile?.status === 'decoding' ? (
          <WaveformSlot state={{ kind: 'decoding' }} />
        ) : activeFile?.status === 'failed' ? (
          <WaveformSlot state={{ kind: 'failed', caption: '解不开' }} />
        ) : (
          <WaveformSlot state={{ kind: 'empty' }} />
        )}

        {activeFile?.status === 'ready' &&
          fileSegments.map((seg, index) => {
            const active = seg.id === activeSegId
            const segPlaying =
              playingSegId === seg.id && progress != null && !progress.paused
            const segPaused =
              playingSegId === seg.id && progress != null && progress.paused
            return (
              <div
                key={seg.id}
                className={`studio-slice-seg${active ? ' is-active' : ''}${
                  playingSegId === seg.id ? ' is-playing' : ''
                }`}
                data-slice-seg={seg.id}
                style={{
                  left: `${seg.start * 100}%`,
                  width: `${(seg.end - seg.start) * 100}%`,
                  background: SEGMENT_COLORS[index % SEGMENT_COLORS.length],
                }}
                title={
                  seg.key
                    ? `${seg.key} · ${formatVoiceDuration(
                        (seg.end - seg.start) * (activeFile.info?.duration ?? 0),
                      )}`
                    : '未绑键'
                }
              >
                <button
                  type="button"
                  className="studio-slice-seg-play"
                  disabled={previewBusySeg === seg.id}
                  title={
                    segPlaying ? '暂停试听' : segPaused ? '继续试听' : '试听这段'
                  }
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation()
                    void toggleSegPreview(seg.id)
                  }}
                >
                  <VoiceGlyph
                    parts={
                      segPlaying
                        ? VOICE_EXTRA_GLYPHS.pause
                        : VOICE_EXTRA_GLYPHS.play
                    }
                  />
                </button>
                <span className="studio-slice-seg-label">
                  {seg.key ?? '未绑'}
                </span>
                {active && (
                  <>
                    <span
                      className="studio-slice-handle is-start"
                      data-slice-handle="start"
                      data-slice-seg={seg.id}
                    />
                    <span
                      className="studio-slice-handle is-end"
                      data-slice-handle="end"
                      data-slice-seg={seg.id}
                    />
                  </>
                )}
              </div>
            )
          })}
      </div>

      {fileSegments.length > 0 && (
        <ul className="studio-slice-list">
          {fileSegments.map((seg) => {
            const dur =
              (seg.end - seg.start) * (activeFile?.info?.duration ?? 0)
            const line = seg.key ? textFor?.(seg.key) : null
            const segPlaying =
              playingSegId === seg.id && progress != null && !progress.paused
            const segPaused =
              playingSegId === seg.id && progress != null && progress.paused
            return (
              <li
                key={seg.id}
                className={`studio-slice-row${seg.id === activeSegId ? ' is-on' : ''}`}
                onClick={() => setActiveSegId(seg.id)}
              >
                <button
                  type="button"
                  className="voice-play studio-play"
                  disabled={previewBusySeg === seg.id}
                  title={
                    segPlaying ? '暂停试听' : segPaused ? '继续试听' : '试听这段'
                  }
                  onClick={(event) => {
                    event.stopPropagation()
                    void toggleSegPreview(seg.id)
                  }}
                >
                  <VoiceGlyph
                    parts={
                      segPlaying
                        ? VOICE_EXTRA_GLYPHS.pause
                        : VOICE_EXTRA_GLYPHS.play
                    }
                  />
                </button>
                <code className="studio-slice-row-key">
                  {seg.key ?? '（未绑键）'}
                </code>
                <span className="studio-slice-row-time">
                  {formatVoiceDuration(dur)}
                </span>
                {line ? (
                  <span className="studio-slice-row-text" title={line}>
                    {line}
                  </span>
                ) : (
                  <span className="studio-slice-row-text is-dim">
                    {seg.key ? '无译文' : '点下方键名绑定'}
                  </span>
                )}
                <span className="spacer" />
                {seg.key && (
                  <button
                    type="button"
                    className="studio-mini"
                    onClick={(event) => {
                      event.stopPropagation()
                      clearKey(seg.id)
                    }}
                  >
                    解绑
                  </button>
                )}
                <button
                  type="button"
                  className="studio-mini"
                  onClick={(event) => {
                    event.stopPropagation()
                    removeSegment(seg.id)
                  }}
                >
                  删除
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <div className="studio-slice-keys">
        <div className="studio-slice-keys-label">
          选中的键（点一下绑到当前段）
        </div>
        {selectedKeys.length === 0 ? (
          <div className="studio-take-empty">在编辑器里点选或框选键名</div>
        ) : (
          <div className="studio-chips">
            {selectedKeys.map((key) => {
              const owner = keyOwner.get(key)
              const on = owner === activeSegId
              const taken = Boolean(owner)
              return (
                <button
                  key={key}
                  type="button"
                  className={`studio-chip studio-slice-key${on ? ' is-on' : ''}${
                    taken && !on ? ' is-taken' : ''
                  }`}
                  title={
                    taken && !on
                      ? `${key} · 已绑到另一段（再点会改绑到当前段）`
                      : on
                        ? `${key} · 已绑到当前段`
                        : `绑到当前段`
                  }
                  onClick={() => bindKey(key)}
                >
                  <span className="studio-chip-mark" aria-hidden />
                  {key}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {!activeFile && (
        <div className="studio-take-empty">
          拖入或选择 wav / mp3 等（可多文件）。在波形空白处拖出片段，再点键名绑定。
        </div>
      )}
    </div>
  )
}
