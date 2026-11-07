/**
 * Agent 面板：**订阅运行时给出的对话视图来渲染**，自己不再持有消息数组。
 *
 * 分层约定（见 `src/agent/contracts.ts`）：
 * - 状态单一真相在 `AgentRuntime`（pi-durable）；面板只读 `view()` + `subscribe()`；
 * - 面板**不创建、不 open、不 close 运行时**——生命周期归工作区（切换工程 / 卸载时关闭）；
 * - 面板不 import 任何 `@earendil-works/*` 或 `src/agent/pi/**`，只认契约。
 *
 * 体验上的硬性明示（文档 §7 / §10）：
 * - Run 期间不能保存：收到 `saveBlockedByRun` 就挂黄色提示，而不是只把按钮变灰；
 * - Run 失败不弹窗，落成对话里的一条 error 记录（附回滚结论）；
 * - 未配置 API Key 时给出可执行的配置表单，明文 Key 不回显；
 * - 数据只在本机本浏览器（空状态写明），归档段跨窗口但载入／导出是二期。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type {
  AgentRunResult,
  AgentRuntime,
  AgentRuntimeView,
  SegmentInfo,
  SnapshotInfo,
} from './agent/contracts'
import {
  clearAgentApiKey,
  getAgentApiKey,
  getAgentBaseUrl,
  getAgentModelIds,
  getAgentThinkingLevels,
  getUsePro,
  hasAgentApiKey,
  isValidModelId,
  isValidThinkingLevel,
  setAgentApiKey,
  setAgentBaseUrl,
  setAgentModelIds,
  setAgentThinkingLevels,
  setUsePro,
} from './agent/config'
import { ApiKeyForm, type ApiConfigDraft } from './agent/view/ApiKeyForm'
import { MessageList } from './agent/view/MessageList'
import { SegmentBar } from './agent/view/SegmentBar'
import {
  SnapshotList,
  type OpenedArchive,
  type PersistState,
} from './agent/view/SnapshotList'
import {
  appendRunFailure,
  contextReference,
  deriveMessageRows,
  describeError,
  maskApiKey,
  runStateLabel,
} from './agent/view/derive'

export type AgentPanelProps = {
  open: boolean
  /** 由工作区构造并 open 过的运行时；null = 尚未就绪（显示加载 / 未配置） */
  runtime: AgentRuntime | null
  onClose: () => void
  /** Run 活跃期间为 true：保存按钮 / 快捷键被禁用，面板要明示原因 */
  saveBlockedByRun: boolean
  /** 选区等上下文（只用于展示与「引用当前文件」快捷输入，不进状态机） */
  contextLabel?: string
  style?: CSSProperties
  placement?: 'left' | 'right' | 'top' | 'bottom' | 'float'
  onTitlePointerDown?: (event: ReactPointerEvent<HTMLElement>) => void
  onRedock?: () => void
  /**
   * 可选：Key / 网关保存或清除后通知工作区。
   * 运行时是由工作区拿着配置构造的，面板改完 localStorage 必须让工作区重建才能生效。
   */
  onConfigChanged?: (config: { apiKey: string; baseUrl: string }) => void
}

const PLACEMENT_HINT: Record<NonNullable<AgentPanelProps['placement']>, string> = {
  left: '拖动标题可停靠，拖到中间变弹层',
  right: '拖动标题可停靠，拖到中间变弹层',
  top: '拖动标题可停靠，拖到中间变弹层',
  bottom: '拖动标题可停靠，拖到中间变弹层',
  float: '拖到边缘停靠，停在中间保持弹层',
}

export function AgentPanel({
  open,
  runtime,
  onClose,
  saveBlockedByRun,
  contextLabel,
  style,
  placement = 'left',
  onTitlePointerDown,
  onRedock,
  onConfigChanged,
}: AgentPanelProps) {
  const [view, setView] = useState<AgentRuntimeView | null>(() => runtime?.view() ?? null)
  const [segments, setSegments] = useState<SegmentInfo[]>([])
  const [segmentsLoading, setSegmentsLoading] = useState(Boolean(runtime))
  const [creatingSegment, setCreatingSegment] = useState(false)
  const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([])
  const [snapshotsLoading, setSnapshotsLoading] = useState(false)
  const [snapshotError, setSnapshotError] = useState('')
  const [snapshotOpen, setSnapshotOpen] = useState(false)
  const [usageBytes, setUsageBytes] = useState<number | null>(null)
  const [persistState, setPersistState] = useState<PersistState>('idle')
  const [runFailure, setRunFailure] = useState<AgentRunResult | null>(null)
  const [input, setInput] = useState('')
  const [useProState, setUseProState] = useState(() => getUsePro())
  const [keyConfigured, setKeyConfigured] = useState(() => hasAgentApiKey())
  const [keyMask, setKeyMask] = useState(() => maskApiKey(getAgentApiKey()))
  const [baseUrl, setBaseUrl] = useState(() => getAgentBaseUrl())
  const [modelIds, setModelIdsState] = useState(() => getAgentModelIds())
  const [thinkingLevels, setThinkingLevelsState] = useState(() => getAgentThinkingLevels())
  const [deletingSegment, setDeletingSegment] = useState(false)
  /** 归档段只读查看 */
  const [openedArchive, setOpenedArchive] = useState<OpenedArchive | null>(null)
  const [openedLoading, setOpenedLoading] = useState(false)
  const [busySnapshotId, setBusySnapshotId] = useState<string | null>(null)
  const [apiOpen, setApiOpen] = useState(false)
  const [panelError, setPanelError] = useState('')
  const [panelInfo, setPanelInfo] = useState('')
  const startingRef = useRef(false)

  const running = view?.runState === 'running'
  const modelLabel = useProState ? 'Pro' : 'Flash'

  const refreshSegments = useCallback(async () => {
    if (!runtime) return
    try {
      const list = await runtime.listSegments()
      setSegments(list)
    } catch (error) {
      setPanelError(
        `读取对话失败：${describeError(error)}。可重试。`,
      )
    }
  }, [runtime])

  const loadSnapshots = useCallback(async () => {
    if (!runtime) {
      setSnapshots([])
      setUsageBytes(null)
      return
    }
    setSnapshotsLoading(true)
    setSnapshotError('')
    try {
      const [list, usage] = await Promise.all([runtime.listSnapshots(), runtime.storageUsage()])
      setSnapshots(list)
      setUsageBytes(usage)
    } catch (error) {
      setSnapshotError(
        `读取归档段失败：${describeError(error)}。数据仍在本机，可重试。`,
      )
    } finally {
      setSnapshotsLoading(false)
    }
  }, [runtime])

  // 运行时变化：先拿一次视图，再订阅；卸载（或换运行时）时取消订阅。
  // 注意：这里绝不调用 open()/close()——工作区负责生命周期。
  useEffect(() => {
    if (!runtime) {
      setView(null)
      setSegments([])
      setSegmentsLoading(false)
      setSnapshotOpen(false)
      setSnapshots([])
      setUsageBytes(null)
      setOpenedArchive(null)
      setRunFailure(null)
      return
    }
    let active = true
    setView(runtime.view())
    setSegmentsLoading(true)
    setRunFailure(null)
    setSnapshotOpen(false)
    setOpenedArchive(null)
    setApiOpen(false)
    setPanelError('')
    const unsubscribe = runtime.subscribe((next) => {
      if (active) setView(next)
    })
    void refreshSegments().finally(() => {
      if (active) setSegmentsLoading(false)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [runtime, refreshSegments])

  // 打开归档段面板时读一次列表与占用（只读浏览；载入／导出是二期）。
  useEffect(() => {
    if (snapshotOpen) void loadSnapshots()
  }, [snapshotOpen, loadSnapshots])

  const rows = useMemo(
    () => appendRunFailure(deriveMessageRows(view?.items ?? []), runFailure, view?.runId ?? null),
    [view, runFailure],
  )

  const togglePro = useCallback(() => {
    const next = !useProState
    setUsePro(next)
    setUseProState(next)
    setPanelInfo(`已切换为 ${next ? 'Pro' : 'Flash'}，下一轮生效。`)
  }, [useProState])

  const send = useCallback(() => {
    const text = input.trim()
    if (!text || !runtime || running || startingRef.current) return
    if (!keyConfigured) {
      setPanelError('先填写 API Key，再发送。')
      return
    }
    startingRef.current = true
    setInput('')
    setPanelError('')
    setPanelInfo('')
    setRunFailure(null)
    runtime
      .run(text)
      .then((result) => {
        // 失败不当异常弹窗：run() 约定不抛，结果落成对话里的记录（文档 §7）
        if (!result.ok) setRunFailure(result)
        void refreshSegments()
      })
      .catch((error: unknown) => {
        setRunFailure({
          ok: false,
          error: `启动失败：${describeError(error)}。检查 API 设置与网络后重试。`,
        })
      })
      .finally(() => {
        startingRef.current = false
      })
  }, [input, runtime, running, keyConfigured, refreshSegments])

  const stop = useCallback(() => {
    if (!runtime) return
    setPanelInfo('正在停止…')
    void runtime.abort().catch((error: unknown) => {
      setPanelError(`停止失败：${describeError(error)}。可重试。`)
    })
  }, [runtime])

  const createSegment = useCallback(() => {
    if (!runtime || creatingSegment) return
    setCreatingSegment(true)
    setPanelError('')
    runtime
      .createSegment()
      .then(() => {
        setRunFailure(null)
        void refreshSegments()
      })
      .catch((error: unknown) => {
        setPanelError(`新建失败：${describeError(error)}。可重试。`)
      })
      .finally(() => setCreatingSegment(false))
  }, [runtime, creatingSegment, refreshSegments])

  const selectSegment = useCallback(
    (segmentId: string) => {
      if (!runtime || !segmentId) return
      setPanelError('')
      runtime
        .selectSegment(segmentId)
        .then(() => {
          setRunFailure(null)
          void refreshSegments()
        })
        .catch((error: unknown) => {
          setPanelError(`切换失败：${describeError(error)}。可重试。`)
        })
    },
    [runtime, refreshSegments],
  )

  const removeSegment = useCallback(
    (segmentId: string) => {
      if (!runtime) return
      setDeletingSegment(true)
      setPanelError('')
      runtime
        .deleteSegment(segmentId)
        .then(() => {
          setRunFailure(null)
          void refreshSegments()
        })
        .catch((error: unknown) => {
          setPanelError(`删除失败：${describeError(error)}。可重试。`)
        })
        .finally(() => setDeletingSegment(false))
    },
    [runtime, refreshSegments],
  )

  const openSnapshot = useCallback(
    (snapshotId: string) => {
      if (!runtime) return
      const info = snapshots.find((item) => item.id === snapshotId)
      setOpenedArchive({ id: snapshotId, title: info?.title || '归档段', items: [] })
      setOpenedLoading(true)
      setPanelError('')
      runtime
        .snapshotItems(snapshotId)
        .then((items) => {
          setOpenedArchive({ id: snapshotId, title: info?.title || '归档段', items })
        })
        .catch((error: unknown) => {
          setPanelError(`读取归档段失败：${describeError(error)}。`)
          setOpenedArchive(null)
        })
        .finally(() => setOpenedLoading(false))
    },
    [runtime, snapshots],
  )

  const forkSnapshot = useCallback(
    (snapshotId: string) => {
      if (!runtime || busySnapshotId) return
      setBusySnapshotId(snapshotId)
      setPanelError('')
      runtime
        .forkSnapshot(snapshotId)
        .then(() => {
          setOpenedArchive(null)
          setSnapshotOpen(false)
          setRunFailure(null)
          setPanelInfo('已从归档段继承出新对话。')
          void refreshSegments()
        })
        .catch((error: unknown) => {
          setPanelError(`继承失败：${describeError(error)}。`)
        })
        .finally(() => setBusySnapshotId(null))
    },
    [runtime, busySnapshotId, refreshSegments],
  )

  const deleteSnapshot = useCallback(
    (snapshotId: string) => {
      if (!runtime || busySnapshotId) return
      setBusySnapshotId(snapshotId)
      setPanelError('')
      runtime
        .deleteSnapshot(snapshotId)
        .then((result) => {
          setOpenedArchive(null)
          setPanelInfo(
            result.segments > 0
              ? `已删除 ${result.snapshots} 个归档段，并连带删除 ${result.segments} 个继承自它的对话。`
              : '已删除归档段。',
          )
          void refreshSegments()
          void loadSnapshots()
        })
        .catch((error: unknown) => {
          setPanelError(`删除失败：${describeError(error)}。`)
        })
        .finally(() => setBusySnapshotId(null))
    },
    [runtime, busySnapshotId, refreshSegments, loadSnapshots],
  )

  const persistStorage = useCallback(() => {
    if (!runtime) return
    setPersistState('pending')
    runtime
      .persistStorage()
      .then((granted) => setPersistState(granted ? 'granted' : 'denied'))
      .catch(() => setPersistState('denied'))
  }, [runtime])

  const saveApiConfig = useCallback(
    (draft: ApiConfigDraft): string | null => {
      const trimmedKey = draft.apiKey.trim()
      const trimmedGateway = draft.baseUrl.trim().replace(/\/+$/, '')
      if (!trimmedKey && !keyConfigured) return '请填写 API Key。'
      if (trimmedGateway && !/^https?:\/\//i.test(trimmedGateway)) {
        return '网关地址要以 http:// 或 https:// 开头。'
      }
      if (!isValidModelId(draft.modelIds.flash)) return 'Flash 模型名不合法。'
      if (!isValidModelId(draft.modelIds.pro)) return 'Pro 模型名不合法。'
      if (!isValidThinkingLevel(draft.thinkingLevels.flash)) return 'Flash 思考强度不合法。'
      if (!isValidThinkingLevel(draft.thinkingLevels.pro)) return 'Pro 思考强度不合法。'
      if (trimmedKey) setAgentApiKey(trimmedKey)
      setAgentBaseUrl(trimmedGateway)
      setAgentModelIds(draft.modelIds)
      setAgentThinkingLevels(draft.thinkingLevels)
      const storedKey = getAgentApiKey()
      setKeyConfigured(Boolean(storedKey))
      setKeyMask(maskApiKey(storedKey))
      setBaseUrl(getAgentBaseUrl())
      setModelIdsState(getAgentModelIds())
      setThinkingLevelsState(getAgentThinkingLevels())
      setApiOpen(false)
      setPanelError('')
      setPanelInfo('已保存。')
      onConfigChanged?.({ apiKey: storedKey, baseUrl: getAgentBaseUrl() })
      return null
    },
    [keyConfigured, onConfigChanged],
  )

  const clearApiConfig = useCallback(() => {
    clearAgentApiKey()
    setKeyConfigured(false)
    setKeyMask(maskApiKey(''))
    setPanelInfo('已清除 API Key。')
    onConfigChanged?.({ apiKey: '', baseUrl })
  }, [baseUrl, onConfigChanged])

  const appendContext = useCallback(() => {
    const reference = contextReference(contextLabel)
    if (!reference) return
    setInput((current) =>
      current.includes(reference) ? current : `${current}${current.trim() ? '\n' : ''}${reference}`,
    )
  }, [contextLabel])

  if (!open) return null

  const titleHint = onTitlePointerDown ? PLACEMENT_HINT[placement] : 'Agent'
  const apiForm = (
    <ApiKeyForm
      configured={keyConfigured}
      maskedKey={keyMask}
      baseUrl={baseUrl}
      modelIds={modelIds}
      thinkingLevels={thinkingLevels}
      canClose={keyConfigured || Boolean(runtime)}
      onSave={saveApiConfig}
      onClear={clearApiConfig}
      onClose={() => setApiOpen(false)}
    />
  )
  const showConnectCard = !keyConfigured && !apiOpen && rows.length === 0

  const emptyState = (
    <div className="agent-empty">
      <div className="agent-empty-title">{runtime ? '有什么可以帮你' : '正在启动…'}</div>
      {runtime ? (
        <p>对话只在本机。运行期间不能保存工程，被修改的文件会暂时只读。</p>
      ) : (
        <p>若长时间没有反应，关闭面板后重新打开。</p>
      )}
    </div>
  )

  return (
    <section className="agent-panel" style={style} aria-label="Agent">
      <header
        className={`agent-header${onTitlePointerDown ? ' is-draggable' : ''}`}
        onPointerDown={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest('button, input, label, a, textarea, select')
          ) {
            return
          }
          onTitlePointerDown?.(event)
        }}
      >
        <div className="agent-title" title={titleHint}>
          <span>Agent</span>
          <span className="agent-sub">
            {modelLabel} · {runStateLabel(view?.runState ?? 'idle')} · {contextLabel ?? '未打开文件'}
          </span>
        </div>
        <div className="agent-header-actions">
          {onRedock && (
            <button type="button" title="停靠回上次的边缘" onClick={onRedock}>
              停靠
            </button>
          )}
          <button
            type="button"
            className={`agent-pro-toggle${useProState ? ' on' : ''}`}
            title={`当前 ${modelLabel}（${useProState ? modelIds.pro : modelIds.flash}）；点击切换，下一轮生效`}
            onClick={togglePro}
            disabled={running || !runtime}
          >
            Pro
          </button>
          <button
            type="button"
            className={`agent-snap-toggle${snapshotOpen ? ' on' : ''}`}
            title="查看归档段库（只读）"
            onClick={() => setSnapshotOpen((open) => !open)}
            disabled={!runtime}
          >
            归档段库
          </button>
          {(keyConfigured || runtime) && (
            <button
              type="button"
              className={`agent-api-toggle${apiOpen ? ' on' : ''}`}
              title="API 设置"
              onClick={() => setApiOpen((open) => !open)}
            >
              API
            </button>
          )}
          <button type="button" title="关闭" onClick={onClose}>
            ×
          </button>
        </div>
      </header>

      {runtime && (
        <SegmentBar
          segments={segments}
          currentId={view?.segmentId ?? null}
          loading={segmentsLoading}
          creating={creatingSegment}
          deleting={deletingSegment}
          canDelete={!running && !deletingSegment}
          onSelect={selectSegment}
          onCreate={createSegment}
          onDelete={removeSegment}
        />
      )}

      {saveBlockedByRun && (
        <div className="agent-banner warn" role="status">
          Agent 运行中，暂不可保存。
        </div>
      )}

      {view && view.lockedPaths.length > 0 && (
        <div
          className="agent-lock-badge"
          title="这些文件暂时只读，Agent 改完会恢复"
        >
          Agent 正在修改：{view.lockedPaths.join('、')}
        </div>
      )}

      {panelError && (
        <div className="agent-banner error" role="alert">
          <span>{panelError}</span>
          <button type="button" onClick={() => setPanelError('')} title="知道了">
            知道了
          </button>
        </div>
      )}

      {apiOpen && <div className="agent-api-section">{apiForm}</div>}

      {snapshotOpen && runtime ? (
        <SnapshotList
          snapshots={snapshots}
          loading={snapshotsLoading}
          error={snapshotError}
          usageBytes={usageBytes}
          persistState={persistState}
          opened={openedArchive}
          openedLoading={openedLoading}
          busyId={busySnapshotId}
          onRefresh={() => void loadSnapshots()}
          onPersist={persistStorage}
          onClose={() => {
            setOpenedArchive(null)
            setSnapshotOpen(false)
          }}
          onOpen={openSnapshot}
          onCloseOpened={() => setOpenedArchive(null)}
          onFork={forkSnapshot}
          onDelete={deleteSnapshot}
        />
      ) : showConnectCard ? (
        <div className="agent-connect">
          <div className="agent-empty">
            <div className="agent-empty-title">填写 API Key 开始使用</div>
          </div>
          {apiForm}
        </div>
      ) : (
        <MessageList
          rows={rows}
          status={running ? view?.status ?? '' : panelInfo || view?.status || ''}
          resetKey={view?.segmentId ?? null}
          empty={emptyState}
        />
      )}

      <form
        className="agent-input-row"
        onSubmit={(event) => {
          event.preventDefault()
          send()
        }}
      >
        <div className="agent-input-context">
          <button
            type="button"
            onClick={appendContext}
            disabled={!contextLabel || running}
            title="把当前打开的文件作为上下文附到问题里"
          >
            引用当前文件
          </button>
          {contextLabel && (
            <span className="agent-context-label" title={contextLabel}>
              {contextLabel}
            </span>
          )}
          {running && <span className="agent-run-state">运行中，可点「停止」</span>}
        </div>
        <textarea
          className="agent-input"
          rows={3}
          value={input}
          placeholder={
            !keyConfigured
              ? '先在 API 设置里填写 Key'
              : running
                ? '正在回答，可点「停止」'
                : '输入问题，Enter 发送'
          }
          disabled={!runtime || !keyConfigured || running}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              send()
            }
          }}
        />
        <div className="agent-input-actions">
          {running ? (
            <button
              type="button"
              onClick={stop}
              title="停止这一次回答"
            >
              停止
            </button>
          ) : (
            <button type="submit" disabled={!input.trim() || !runtime || !keyConfigured}>
              发送
            </button>
          )}
        </div>
      </form>
    </section>
  )
}
