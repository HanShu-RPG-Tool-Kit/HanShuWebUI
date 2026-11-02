import { useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { ExplorerIcon } from '../../explorerIcons'
import { NodeContextMenu, type NodeMenuItem } from '../../nodeEditor/ContextMenu'
import { AUDIOVISUAL_CATEGORIES } from '../../resourceTypes'
import type { SourceFile } from '../../workspace'
import { resourceBaseError } from '../../resourceNames'
import type { DockPlacement } from '../../ui/panelDockModel'

type ExplorerMenu =
  | { kind: 'file'; fileId: string; x: number; y: number }
  | { kind: 'blank'; x: number; y: number }

export function AudiovisualExplorer({
  files,
  activeId,
  readOnly,
  onOpen,
  onCreate,
  onRename,
  onDelete,
  placement = 'left',
  onTitlePointerDown,
  onRedock,
}: {
  files: readonly SourceFile[]
  activeId: string | null
  readOnly: boolean
  onOpen: (id: string) => void
  onCreate: () => void
  onRename: (id: string, base: string) => string | null
  onDelete: (id: string) => void
  placement?: DockPlacement
  onTitlePointerDown?: (event: ReactPointerEvent<HTMLElement>) => void
  onRedock?: () => void
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [editError, setEditError] = useState('')
  const [categoryOpen, setCategoryOpen] = useState(true)
  const [menu, setMenu] = useState<ExplorerMenu | null>(null)
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  const menuFile = menu?.kind === 'file' ? files.find((file) => file.id === menu.fileId) ?? null : null

  const beginRename = (file: SourceFile) => {
    if (readOnly) return
    setMenu(null)
    setEditingId(file.id)
    setEditValue(file.name.replace(/\.bossbar$/i, ''))
    setEditError('')
  }

  const commitRename = () => {
    if (!editingId) return
    const error = resourceBaseError(editValue) ?? onRename(editingId, editValue.trim())
    if (error) {
      setEditError(error)
      return
    }
    setEditingId(null)
    setEditError('')
  }

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitRename()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setEditingId(null)
      setEditError('')
    }
  }

  const openFileMenu = (event: ReactMouseEvent, file: SourceFile) => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({ kind: 'file', fileId: file.id, x: event.clientX, y: event.clientY })
  }

  const openBlankMenu = (event: ReactMouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({ kind: 'blank', x: event.clientX, y: event.clientY })
  }

  const fileMenuItems: NodeMenuItem[] = menuFile
    ? [
        { label: '打开', hint: '在编辑器中显示', action: () => onOpen(menuFile.id) },
        {
          label: '重命名',
          disabled: readOnly,
          hint: readOnly ? '只读工程不能重命名' : '双击也可以重命名',
          action: () => beginRename(menuFile),
        },
        {
          label: '删除',
          disabled: readOnly,
          hint: readOnly ? '只读工程不能删除' : '删除此 .bossbar',
          action: () => onDelete(menuFile.id),
        },
      ]
    : []

  const blankMenuItems: NodeMenuItem[] = [
    {
      label: '新建 BOSS 血条',
      disabled: readOnly,
      hint: readOnly ? '只读工程不能新建' : '创建 .bossbar 文件',
      action: () => onCreate(),
    },
    {
      label: categoryOpen ? '折叠分类' : '展开分类',
      action: () => setCategoryOpen((open) => !open),
    },
  ]

  return (
    <aside className="av-library" aria-label="视听效果资源管理器">
      <div
        className={`av-explorer-heading${onTitlePointerDown ? ' is-draggable' : ''}`}
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
        <strong
          title={
            onTitlePointerDown
              ? placement === 'float'
                ? '拖动标题可停靠到边缘；松手在中间则保持弹层'
                : '拖动标题可停靠到左、右、上、下，拖到中间变成弹层'
              : '资源管理器'
          }
        >
          资源管理器
        </strong>
        <div className="av-explorer-tools">
          {onRedock && (
            <button type="button" className="panel-dock-redock" title="停靠回上次的边缘" onClick={onRedock}>
              停靠
            </button>
          )}
          <button
            type="button"
            title="新建 BOSS 血条"
            aria-label="新建 BOSS 血条"
            disabled={readOnly}
            onClick={onCreate}
          >
            ＋
          </button>
        </div>
      </div>

      <div className="av-explorer-body" onContextMenu={openBlankMenu}>
        <button
          type="button"
          className="av-category-row"
          aria-expanded={categoryOpen}
          onClick={() => setCategoryOpen((open) => !open)}
          onContextMenu={openBlankMenu}
        >
          <span className="av-twist" aria-hidden>
            {categoryOpen ? '▾' : '▸'}
          </span>
          <ExplorerIcon kind="bossbar" />
          <span className="av-category-name">{AUDIOVISUAL_CATEGORIES.bossbar.name}</span>
          <span className="av-category-count">{sorted.length}</span>
        </button>

        {categoryOpen && (
          <ul className="av-explorer-list" role="tree">
            {sorted.length === 0 && (
              <li className="av-explorer-empty">暂无 .bossbar。右键或点标题栏 ＋ 新建。</li>
            )}
            {sorted.map((file) => {
              const editing = editingId === file.id
              return (
                <li
                  key={file.id}
                  className={`av-explorer-row${activeId === file.id ? ' is-active' : ''}${file.detached ? ' is-detached' : ''}`}
                  role="treeitem"
                  onContextMenu={(event) => openFileMenu(event, file)}
                >
                  <button
                    type="button"
                    className="av-explorer-item"
                    onClick={() => onOpen(file.id)}
                    onDoubleClick={() => beginRename(file)}
                    title={`${file.name}\n右键：打开、重命名或删除`}
                  >
                    <ExplorerIcon kind="bossbar" />
                    {editing ? (
                      <input
                        className="av-explorer-rename"
                        value={editValue}
                        aria-label="重命名"
                        autoFocus
                        onChange={(event) => {
                          setEditValue(event.target.value)
                          setEditError('')
                        }}
                        onBlur={commitRename}
                        onKeyDown={onKey}
                        onClick={(event) => event.stopPropagation()}
                      />
                    ) : (
                      <span className="av-explorer-name">{file.name}</span>
                    )}
                  </button>
                  {!readOnly && !editing && (
                    <button
                      type="button"
                      className="av-explorer-delete"
                      title="删除"
                      aria-label={`删除 ${file.name}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        onDelete(file.id)
                      }}
                    >
                      ×
                    </button>
                  )}
                  {editing && editError && (
                    <p className="av-explorer-error" role="alert">
                      {editError}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {menu?.kind === 'file' && menuFile && (
        <NodeContextMenu
          x={menu.x}
          y={menu.y}
          title={menuFile.name}
          label="资源操作"
          items={fileMenuItems}
          onClose={() => setMenu(null)}
        />
      )}
      {menu?.kind === 'blank' && (
        <NodeContextMenu
          x={menu.x}
          y={menu.y}
          title={AUDIOVISUAL_CATEGORIES.bossbar.name}
          label="资源操作"
          items={blankMenuItems}
          onClose={() => setMenu(null)}
        />
      )}
    </aside>
  )
}
