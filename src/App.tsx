import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from 'react'
import {
  loadActiveWorkspaceId,
  saveActiveWorkspaceId,
} from './workspaces/activeWorkspace.ts'
import { APP_WORKSPACES } from './workspaces/registry.ts'
import { McSkinWorkspace } from './workspaces/McSkinWorkspace.tsx'
import { QuestWorkspace, type ProgressWorkspaceHandle } from './workspaces/QuestWorkspace.tsx'
import { ScriptWorkspace } from './workspaces/ScriptWorkspace.tsx'
import {
  ensureGameDevControlStarted,
  GameDevServerPanel,
} from './gameDevServer'
import type { ScriptWorkspaceHandle } from './workspaces/scriptTypes.ts'
import { HelpModal } from './help/HelpModal.tsx'
import type { HelpTopicId } from './help/topics.ts'
import type { AppWorkspaceId } from './workspaces/types.ts'
import {
  applyUiScale,
  loadUiScale,
  saveUiScale,
  type UiScale,
} from './displayPrefs.ts'
import {
  closeDesktopWindow,
  finishDesktopSplashToMain,
  isTauriRuntime,
  minimizeDesktopWindow,
  presentDesktopSplashWindow,
  revealDesktopMainWindow,
  toggleMaximizeDesktopWindow,
  watchDesktopMaximized,
} from './desktopWindow.ts'
import { SplashOverlay } from './SplashOverlay.tsx'
import { shouldShowSplash } from './splashSession.ts'
import appWordmarkUrl from './brand/hanshu-wordmark.svg'
import './App.css'
import { ProjectConnectionBar } from './project/ProjectConnectionBar'
import { ProjectHistory } from './project/ProjectHistory'
import { getProjectClient } from './project/serviceClient'
import { openProjectUi } from './project/projectUi'
import { useProjectSession } from './project/projectSession'
import {
  AppStatusBar,
  MenuBar,
  runAppMenuAction,
  type MenuCommand,
  type MenuContext,
} from './chrome'

const isDesktopShell = isTauriRuntime()

const WORKSPACE_IDS = APP_WORKSPACES.map((w) => w.id)

function renderToolWorkspace(
  id: AppWorkspaceId,
  active: boolean,
  progressRef: Ref<ProgressWorkspaceHandle>,
) {
  switch (id) {
    case 'quest':
      return <QuestWorkspace active={active} workspaceRef={progressRef} />
    case 'mc-skin':
      return <McSkinWorkspace active={active} />
    default:
      return null
  }
}

function App() {
  const projectSession = useProjectSession()
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<AppWorkspaceId>(
    () => loadActiveWorkspaceId(WORKSPACE_IDS),
  )
  const [uiScale, setUiScale] = useState<UiScale>(() => loadUiScale())
  const [helpTopicId, setHelpTopicId] = useState<HelpTopicId | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const closeHistory = useCallback(() => setHistoryOpen(false), [])
  const [gameDevOpen, setGameDevOpen] = useState(false)
  const closeGameDev = useCallback(() => setGameDevOpen(false), [])

  useEffect(() => {
    ensureGameDevControlStarted()
  }, [])
  const [maximized, setMaximized] = useState(false)
  const [showSplash, setShowSplash] = useState(
    () => isDesktopShell && shouldShowSplash(),
  )
  /** Bumps to remount splash when replaying via debug shortcut. */
  const [splashPreviewKey, setSplashPreviewKey] = useState(0)
  const splashPreview = !isDesktopShell
  const scriptRef = useRef<ScriptWorkspaceHandle>(null)
  const progressRef = useRef<ProgressWorkspaceHandle>(null)

  useEffect(() => {
    applyUiScale(uiScale)
  }, [uiScale])

  useEffect(() => {
    if (!isDesktopShell) return
    document.documentElement.classList.add('is-desktop-shell')
    return () => document.documentElement.classList.remove('is-desktop-shell')
  }, [])

  useEffect(() => {
    if (isDesktopShell) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || !event.shiftKey || event.code !== 'KeyS') return
      if (event.ctrlKey || event.metaKey) return
      event.preventDefault()
      setSplashPreviewKey((key) => key + 1)
      setShowSplash(true)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (!isDesktopShell) return
    let cancelled = false
    void (async () => {
      try {
        if (showSplash) await presentDesktopSplashWindow()
        else await revealDesktopMainWindow()
      } catch (err) {
        console.error('desktop window bootstrap failed', err)
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window')
          await getCurrentWindow().show()
        } catch {
          /* ignore */
        }
        if (!cancelled) {
          await revealDesktopMainWindow().catch(() => undefined)
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional mount bootstrap
  }, [])

  useEffect(() => {
    if (!isDesktopShell) return
    let disposed = false
    let unwatch: (() => void) | undefined
    void watchDesktopMaximized((next) => {
      if (!disposed) setMaximized(next)
    }).then((stop) => {
      if (disposed) stop()
      else unwatch = stop
    })
    return () => {
      disposed = true
      unwatch?.()
    }
  }, [])

  const onSplashDone = useCallback(() => {
    if (!isDesktopShell) {
      setShowSplash(false)
      return
    }
    void finishDesktopSplashToMain(() => setShowSplash(false)).catch((err) => {
      console.error('reveal main window failed', err)
      setShowSplash(false)
    })
  }, [])

  const showMainShell = !isDesktopShell || !showSplash

  const changeUiScale = useCallback((scale: UiScale) => {
    setUiScale(scale)
    saveUiScale(scale)
  }, [])

  const selectWorkspace = (id: AppWorkspaceId) => {
    setActiveWorkspaceId(id)
    saveActiveWorkspaceId(id)
  }

  const menuCtx: MenuContext = useMemo(
    () => ({
      workspaceId: activeWorkspaceId,
      projectBound: Boolean(projectSession.binding),
      role: projectSession.binding?.handle.client.snapshot.role ?? null,
      uiScale,
    }),
    [activeWorkspaceId, projectSession.binding, uiScale],
  )

  const handleMenuCommand = useCallback(
    (item: MenuCommand) => {
      if (item.run === 'app') {
        runAppMenuAction(item.id, {
          openProjectUi,
          openHistory: () => setHistoryOpen(true),
          openGameDev: () => setGameDevOpen(true),
          openHelp: (topic) => setHelpTopicId(topic),
          changeUiScale,
          quit: () => {
            void closeDesktopWindow()
          },
        })
        return
      }

      if (activeWorkspaceId === 'quest') {
        progressRef.current?.handleMenuAction(item.id)
        return
      }
      if (activeWorkspaceId === 'script') {
        scriptRef.current?.handleMenuAction(item.id)
      }
    },
    [activeWorkspaceId, changeUiScale],
  )

  return (
    <div className="app">
      {showSplash && (
        <SplashOverlay
          key={splashPreviewKey}
          preview={splashPreview}
          windowed={isDesktopShell}
          onDone={onSplashDone}
        />
      )}
      {showMainShell && (
      <Fragment>
      <header className={`titlebar${isDesktopShell ? ' is-desktop' : ''}`}>
        <div className="titlebar-left">
          <img
            className="app-wordmark"
            src={appWordmarkUrl}
            alt="HanShu"
            draggable={false}
          />
          <div className="workspace-tabs" role="tablist" aria-label="工作区">
            {APP_WORKSPACES.map((ws) => (
              <button
                key={ws.id}
                type="button"
                role="tab"
                aria-selected={activeWorkspaceId === ws.id}
                className={`workspace-tab${
                  activeWorkspaceId === ws.id ? ' active' : ''
                }`}
                onClick={() => selectWorkspace(ws.id)}
              >
                {ws.label}
              </button>
            ))}
          </div>
          <MenuBar ctx={menuCtx} onAction={handleMenuCommand} />
        </div>
        <div className="titlebar-center" data-tauri-drag-region />
        {isDesktopShell && (
          <div className="titlebar-right">
            <button
              type="button"
              className="win-btn"
              aria-label="最小化"
              onClick={() => void minimizeDesktopWindow()}
            >
              ─
            </button>
            <button
              type="button"
              className="win-btn"
              aria-label={maximized ? '还原' : '最大化'}
              onClick={() => void toggleMaximizeDesktopWindow()}
            >
              {maximized ? '❐' : '□'}
            </button>
            <button
              type="button"
              className="win-btn close"
              aria-label="关闭"
              onClick={() => void closeDesktopWindow()}
            >
              ×
            </button>
          </div>
        )}
      </header>

      <ProjectConnectionBar />
      {historyOpen && <ProjectHistory client={getProjectClient()} onClose={closeHistory} />}
      {gameDevOpen && <GameDevServerPanel onClose={closeGameDev} />}
      <div className="app-body">
        <div
          className={`app-workspace-pane${
            activeWorkspaceId === 'script' ? ' active' : ''
          }`}
        >
          <ScriptWorkspace ref={scriptRef} isActive={activeWorkspaceId === 'script'} />
        </div>
        {APP_WORKSPACES.filter((w) => w.id !== 'script').map((ws) => (
          <div
            key={ws.id}
            className={`app-workspace-pane${
              activeWorkspaceId === ws.id ? ' active' : ''
            }`}
          >
            {renderToolWorkspace(ws.id, activeWorkspaceId === ws.id, progressRef)}
          </div>
        ))}
      </div>
      <AppStatusBar />
      {helpTopicId && (
        <HelpModal
          topicId={helpTopicId}
          onClose={() => setHelpTopicId(null)}
          onOpenTopic={setHelpTopicId}
        />
      )}
      </Fragment>
      )}
    </div>
  )
}

export default App
