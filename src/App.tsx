import {
  Fragment,
  useCallback,
  useEffect,
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
import { ProgressFlowWorkspace, type ProgressWorkspaceHandle } from './workspaces/ProgressFlowWorkspace.tsx'
import { McStreamWorkspace } from './workspaces/McStreamWorkspace.tsx'
import { ScriptWorkspace } from './workspaces/ScriptWorkspace.tsx'
import type { ScriptWorkspaceHandle } from './workspaces/scriptTypes.ts'
import { HelpModal } from './help/HelpModal.tsx'
import type { HelpTopicId } from './help/topics.ts'
import type { AppWorkspaceId } from './workspaces/types.ts'
import {
  applyUiScale,
  loadUiScale,
  saveUiScale,
  UI_SCALES,
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

const isDesktopShell = isTauriRuntime()

const MENUS = [
  {
    label: '文件',
    items: [
      '打开工程…',
      '新建工程…',
      '—',
      '新建剧本',
      '新建包',
      '保存',
      '另存为工程…',
      '历史版本',
      '—',
      '导出PAK',
      '导出PAK（分平面）',
      '导出工程包',
      '—',
      '退出',
    ],
  },
  {
    label: '编辑',
    items: ['撤销', '重做', '—', '剪切', '复制', '粘贴', '—', '查找', '替换'],
  },
  {
    label: '选择',
    items: ['全选', '扩展选区', '缩小选区', '—', '向上复制行', '向下复制行'],
  },
  {
    label: '查看',
    items: [
      'Agent 窗口',
      '录音棚',
      '命令面板...',
      '外观',
      '编辑器布局',
      '—',
      '界面比例 100%',
      '界面比例 110%',
      '界面比例 125%',
      '界面比例 150%',
      '恢复推荐大小（125%）',
      '—',
      '显示小地图',
      '自动换行',
    ],
  },
  {
    label: '转到',
    items: ['转到文件...', '转到行/列...', '—', '上一个问题', '下一个问题'],
  },
  {
    label: '帮助',
    items: ['欢迎', '文档', '—', '关于汉书'],
  },
] as const

const WORKSPACE_IDS = APP_WORKSPACES.map((w) => w.id)

const HELP_MENU_ITEMS = new Set(['欢迎', '文档', '关于汉书'])
const HELP_MENU_TOPIC: Record<string, HelpTopicId> = {
  欢迎: 'welcome',
  文档: 'docs',
  关于汉书: 'about',
}

function isAlwaysEnabledMenuItem(item: string) {
  return (
    HELP_MENU_ITEMS.has(item) ||
    item.startsWith('界面比例 ') ||
    item === '恢复推荐大小（125%）' ||
    item === '退出'
  )
}

function renderToolWorkspace(
  id: AppWorkspaceId,
  active: boolean,
  progressRef: Ref<ProgressWorkspaceHandle>,
) {
  switch (id) {
    case 'progress-flow':
      return <ProgressFlowWorkspace active={active} workspaceRef={progressRef} />
    case 'mc-skin':
      return <McSkinWorkspace active={active} />
    case 'mc-stream':
      return <McStreamWorkspace active={active} />
    default:
      return null
  }
}

function App() {
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<AppWorkspaceId>(
    () => loadActiveWorkspaceId(WORKSPACE_IDS),
  )
  const [uiScale, setUiScale] = useState<UiScale>(() => loadUiScale())
  const [helpTopicId, setHelpTopicId] = useState<HelpTopicId | null>(null)
  const [maximized, setMaximized] = useState(false)
  const [showSplash, setShowSplash] = useState(
    () => isDesktopShell && shouldShowSplash(),
  )
  /** Bumps to remount splash when replaying via debug shortcut. */
  const [splashPreviewKey, setSplashPreviewKey] = useState(0)
  const splashPreview = !isDesktopShell
  const menubarRef = useRef<HTMLElement>(null)
  const scriptRef = useRef<ScriptWorkspaceHandle>(null)
  const progressRef = useRef<ProgressWorkspaceHandle>(null)

  // Apply the persisted UI scale on mount (default 125% on first run).
  useEffect(() => {
    applyUiScale(uiScale)
  }, [uiScale])

  useEffect(() => {
    if (!isDesktopShell) return
    document.documentElement.classList.add('is-desktop-shell')
    return () => document.documentElement.classList.remove('is-desktop-shell')
  }, [])

  // Web-only: Alt+Shift+S replays the startup splash for design iteration.
  // (Alt+Space is often stolen by the browser / OS window menu.)
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

  // Desktop: splash window first (PS-style), then maximize the main shell.
  useEffect(() => {
    if (!isDesktopShell) return
    let cancelled = false
    void (async () => {
      try {
        if (showSplash) await presentDesktopSplashWindow()
        else await revealDesktopMainWindow()
      } catch (err) {
        console.error('desktop window bootstrap failed', err)
        // Last resort: force-show whatever window we have.
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
    // Only on cold mount — showSplash is the initial gate, not a live toggle.
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

  /** Desktop cold splash: hide main chrome until the dialog finishes. */
  const showMainShell = !isDesktopShell || !showSplash

  const changeUiScale = useCallback((scale: UiScale) => {
    setUiScale(scale)
    saveUiScale(scale)
  }, [])

  const selectWorkspace = (id: AppWorkspaceId) => {
    setActiveWorkspaceId(id)
    saveActiveWorkspaceId(id)
    setOpenMenu(null)
  }

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (
        menubarRef.current &&
        !menubarRef.current.contains(event.target as Node)
      ) {
        setOpenMenu(null)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [])

  const handleMenuAction = (item: string) => {
    setOpenMenu(null)
    const helpTopic = HELP_MENU_TOPIC[item]
    if (helpTopic) {
      setHelpTopicId(helpTopic)
      return
    }
    const scaleMatch = /^界面比例 (\d+)%$/.exec(item)
    if (scaleMatch) {
      const scale = Number.parseInt(scaleMatch[1], 10) as UiScale
      if (UI_SCALES.includes(scale)) changeUiScale(scale)
      return
    }
    if (item === '恢复推荐大小（125%）') {
      changeUiScale(125)
      return
    }
    if (item === '退出') {
      void closeDesktopWindow()
      return
    }
    if (activeWorkspaceId === 'progress-flow') progressRef.current?.handleMenuAction(item)
    else if (activeWorkspaceId === 'script') scriptRef.current?.handleMenuAction(item)
  }

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
          <nav className="menubar" ref={menubarRef} aria-label="主菜单">
            {MENUS.map((menu) => (
              <div
                key={menu.label}
                className={`menu-item${openMenu === menu.label ? ' open' : ''}`}
              >
                <button
                  type="button"
                  className="menu-trigger"
                  onClick={() =>
                    setOpenMenu((current) =>
                      current === menu.label ? null : menu.label,
                    )
                  }
                  onMouseEnter={() => {
                    if (openMenu) setOpenMenu(menu.label)
                  }}
                >
                  {menu.label}
                </button>
                {openMenu === menu.label && (
                  <ul className="menu-dropdown" role="menu">
                    {menu.items.map((menuItem, index) =>
                      menuItem === '—' ? (
                        <li
                          key={`${menu.label}-sep-${index}`}
                          className="sep"
                        />
                      ) : (
                        <li key={menuItem} role="none">
                          <button
                            type="button"
                            role="menuitem"
                            disabled={activeWorkspaceId === 'progress-flow' &&
                              !['保存', '撤销', '重做'].includes(menuItem) &&
                              !isAlwaysEnabledMenuItem(menuItem)}
                            aria-checked={
                              menu.label === '查看' &&
                              UI_SCALES.some(
                                (s) => `界面比例 ${s}%` === menuItem && s === uiScale,
                              )
                                ? true
                                : undefined
                            }
                            className={
                              menu.label === '查看' &&
                              UI_SCALES.some(
                                (s) => `界面比例 ${s}%` === menuItem && s === uiScale,
                              )
                                ? 'checked'
                                : ''
                            }
                            onClick={() => handleMenuAction(menuItem)}
                          >
                            {menuItem}
                          </button>
                        </li>
                      ),
                    )}
                  </ul>
                )}
              </div>
            ))}
          </nav>
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
