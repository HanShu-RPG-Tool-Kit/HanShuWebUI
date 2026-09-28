import { useCallback, useEffect, useMemo, useRef, useState, type Ref } from 'react'
import {
  loadActiveWorkspaceId,
  saveActiveWorkspaceId,
} from './workspaces/activeWorkspace.ts'
import { APP_WORKSPACES } from './workspaces/registry.ts'
import { McSkinWorkspace } from './workspaces/McSkinWorkspace.tsx'
import { ProgressFlowWorkspace, type ProgressWorkspaceHandle } from './workspaces/ProgressFlowWorkspace.tsx'
import { McStreamWorkspace } from './workspaces/McStreamWorkspace.tsx'
import { ScriptWorkspace } from './workspaces/ScriptWorkspace.tsx'
import type {
  ScriptChromeInfo,
  ScriptWorkspaceHandle,
} from './workspaces/scriptTypes.ts'
import type { AppWorkspaceId } from './workspaces/types.ts'
import {
  applyUiScale,
  loadUiScale,
  saveUiScale,
  UI_SCALES,
  type UiScale,
} from './displayPrefs.ts'
import './App.css'

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

function renderToolWorkspace(id: AppWorkspaceId, active: boolean, progressRef: Ref<ProgressWorkspaceHandle>) {
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
  const [scriptChrome, setScriptChrome] = useState<ScriptChromeInfo | null>(
    null,
  )
  const [uiScale, setUiScale] = useState<UiScale>(() => loadUiScale())
  const menubarRef = useRef<HTMLElement>(null)
  const scriptRef = useRef<ScriptWorkspaceHandle>(null)
  const progressRef = useRef<ProgressWorkspaceHandle>(null)

  // Apply the persisted UI scale on mount (default 125% on first run).
  useEffect(() => {
    applyUiScale(uiScale)
  }, [uiScale])

  const changeUiScale = useCallback((scale: UiScale) => {
    setUiScale(scale)
    saveUiScale(scale)
  }, [])

  const onChromeInfo = useCallback((info: ScriptChromeInfo) => {
    setScriptChrome(info)
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
    if (activeWorkspaceId === 'progress-flow') progressRef.current?.handleMenuAction(item)
    else if (activeWorkspaceId === 'script') scriptRef.current?.handleMenuAction(item)
  }

  const titleCenter = useMemo(() => {
    const activeDef = APP_WORKSPACES.find((w) => w.id === activeWorkspaceId)
    if (activeWorkspaceId === 'script' && scriptChrome) {
      const folder =
        scriptChrome.projectFolderName ?? scriptChrome.packageName
      const busy = scriptChrome.projectBusy ? '（读写中…）' : ''
      return `${scriptChrome.titleName} — ${folder}${busy}`
    }
    return activeDef?.label ?? '汉书'
  }, [activeWorkspaceId, scriptChrome])

  return (
    <div className="app">
      <header className="titlebar">
        <div className="titlebar-left">
          <span className="app-icon" aria-hidden>
            书
          </span>
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
                              !['保存', '撤销', '重做', '恢复推荐大小（125%）'].includes(menuItem) &&
                              !menuItem.startsWith('界面比例 ')}
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
        <div className="titlebar-center">{titleCenter}</div>
        <div className="titlebar-right" aria-hidden>
          <span className="win-btn">─</span>
          <span className="win-btn">□</span>
          <span className="win-btn close">×</span>
        </div>
      </header>

      <div className="app-body">
        <div
          className={`app-workspace-pane${
            activeWorkspaceId === 'script' ? ' active' : ''
          }`}
        >
          <ScriptWorkspace ref={scriptRef} onChromeInfo={onChromeInfo} isActive={activeWorkspaceId === 'script'} />
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
    </div>
  )
}

export default App
