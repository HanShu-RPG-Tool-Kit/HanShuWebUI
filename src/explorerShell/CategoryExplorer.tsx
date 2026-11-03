import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { notify } from '../activity'
import { ExplorerIcon } from '../explorerIcons'
import { NodeContextMenu, type NodeMenuItem } from '../nodeEditor/ContextMenu'
import type { ExplorerOrganization } from '../project/explorerOrganization'
import { resourceBaseError } from '../resourceNames'
import { confirmDialog } from '../ui/dialogs'
import type { ShellCategory, ShellFile } from './categoryAdapter'
import { ExplorerShellFrame } from './ExplorerShellFrame'
import type { ExplorerDockProps } from './shellModel'
import { ExplorerTreeRow } from './ExplorerTreeRow'
import {
  addVirtualFolder,
  moveVirtualFolder,
  placeSource,
  removeVirtualFolder,
  renameVirtualFolder,
} from './virtualFolders'
import './explorerShell.css'

type TreeNode =
  | { kind: 'category'; category: string }
  | { kind: 'folder'; key: string; category: string }
  | { kind: 'file'; id: string; category: string }

type Row = {
  node: TreeNode
  depth: number
  name: string
  icon: ShellFile['icon']
  expanded?: boolean
  file?: ShellFile
  count?: number | null
}

type Edit =
  | { kind: 'rename-file'; id: string; value: string; error: string }
  | { kind: 'rename-folder'; key: string; value: string; error: string }
  | { kind: 'new-folder'; category: string; parent: string | null; value: string; error: string }

const SHELL_DRAG_MIME = 'application/x-hanshu-explorer-shell'

/** 新建入口被触发的视口坐标；工作区据此就地弹出自己的类型选择器。 */
export type CreateAnchor = { x: number; y: number }

/** 工作区在壳结构上的扩展点：类名、标题栏工具、树顶部内容与空白处菜单。 */
export type CategoryExplorerSlots = {
  /** 追加到根节点的类名（壳类名 `explorer-shell` 始终保留）。 */
  rootClass?: string
  /** 排在壳自带工具按钮之前。 */
  tools?: ReactNode
  /** 树顶部、第一个分类之前（如工程行）。 */
  prepend?: ReactNode
  /** 树空白处右键菜单的附加项。 */
  blankMenuItems?: (anchor: CreateAnchor) => NodeMenuItem[]
}

const nodeId = (node: TreeNode) =>
  node.kind === 'category' ? `category:${node.category}` : node.kind === 'folder' ? `folder:${node.key}` : `file:${node.id}`

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, 'zh-CN', { numeric: true })

/**
 * 通用资源管理器：分类 →（可选共享虚拟文件夹）→ 源文件。
 *
 * 壳只认分类表、规范工程路径与 `meta/explorer.json` 组织；领域视图、导入转换、拖拽 MIME
 * 等由工作区通过回调与 `addons` 接入。所有写入都交回调用方经 ProjectClient 提交。
 */
export function CategoryExplorer({
  label,
  categories,
  files,
  organization,
  activeId,
  readOnly,
  defaultOpen = [],
  emptyHint,
  onOpen,
  onCreate,
  onRename,
  onDelete,
  onOrganize,
  onFileDragStart,
  addons,
  slots = {},
  renameRequest = null,
  dock,
}: {
  label: string
  categories: readonly ShellCategory[]
  files: readonly ShellFile[]
  /** null = 该工作区不启用共享虚拟文件夹 */
  organization: ExplorerOrganization | null
  activeId: string | null
  readOnly: boolean
  defaultOpen?: readonly string[]
  /** 有格式但没有文件时的提示 */
  emptyHint?: (category: ShellCategory) => string
  onOpen: (id: string) => void
  onCreate?: (category: string, folderKey: string | null, anchor: CreateAnchor | null) => void
  onRename?: (id: string, base: string) => string | null
  onDelete?: (ids: string[]) => void
  onOrganize?: (next: ExplorerOrganization, label: string) => void
  /** 领域拖拽载荷（如编辑器落点 MIME）；壳只写自己的内部移动标记。 */
  onFileDragStart?: (file: ShellFile, event: DragEvent<HTMLDivElement>) => void
  /** 挂在分类树之后的附加视图（如剧本临时 assets 真实目录）。 */
  addons?: ReactNode
  slots?: CategoryExplorerSlots
  /** `seq` 变化且文件已在树中时，展开到该文件并进入行内改名（用于创建后立即改名）。 */
  renameRequest?: { id: string; seq: number } | null
  dock: ExplorerDockProps
}) {
  const [expanded, setExpanded] = useState(() => new Set(defaultOpen.map(id => `category:${id}`)))
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [focusId, setFocusId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [edit, setEditState] = useState<Edit | null>(null)
  /** 回车 / Esc 后输入框卸载触发的 blur 不能再提交一次 */
  const editRef = useRef<Edit | null>(null)
  const setEdit = (next: Edit | null) => {
    editRef.current = next
    setEditState(next)
  }
  const [menu, setMenu] = useState<{ node: TreeNode | null; x: number; y: number } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const dragging = useRef<TreeNode | null>(null)
  const anchorId = useRef<string | null>(null)
  const elements = useRef(new Map<string, HTMLDivElement>())

  const categoryById = useMemo(() => new Map(categories.map(category => [category.id, category])), [categories])
  const folders = useMemo(
    () => (organization?.folders ?? []).filter(folder => categoryById.get(folder.category)?.folders),
    [organization, categoryById],
  )
  const folderByKey = useMemo(() => new Map(folders.map(folder => [folder.key, folder])), [folders])
  const fileById = useMemo(() => new Map(files.map(file => [file.id, file])), [files])
  const canOrganize = Boolean(organization && onOrganize && !readOnly)

  const placementOf = (file: ShellFile): string | null => {
    const key = organization?.placements[file.path]
    return key && folderByKey.get(key)?.category === file.category ? key : null
  }

  const query = search.trim().toLowerCase()
  const matches = (file: ShellFile) => !query || file.name.toLowerCase().includes(query)

  const rows = useMemo(() => {
    const result: Row[] = []
    const filesIn = (category: string, parent: string | null) =>
      files.filter(file => file.category === category && placementOf(file) === parent && matches(file)).sort(byName)
    const hasMatch = (category: string, key: string): boolean =>
      filesIn(category, key).length > 0 ||
      folders.some(folder => folder.parentId === key && hasMatch(category, folder.key))
    const walk = (category: ShellCategory, parent: string | null, depth: number) => {
      for (const folder of folders.filter(item => item.category === category.id && item.parentId === parent).sort(byName)) {
        if (query && !hasMatch(category.id, folder.key)) continue
        const node: TreeNode = { kind: 'folder', key: folder.key, category: category.id }
        const open = Boolean(query) || expanded.has(nodeId(node))
        result.push({ node, depth, name: folder.name, icon: 'folder', expanded: open })
        if (open) walk(category, folder.key, depth + 1)
      }
      for (const file of filesIn(category.id, parent)) {
        result.push({ node: { kind: 'file', id: file.id, category: category.id }, depth, name: file.name, icon: file.icon, file })
      }
    }
    for (const category of categories) {
      const node: TreeNode = { kind: 'category', category: category.id }
      const open = Boolean(query) || expanded.has(nodeId(node))
      const count = category.extensions.length
        ? files.filter(file => file.category === category.id && matches(file)).length
        : null
      result.push({ node, depth: 0, name: category.name, icon: category.icon, expanded: open, count })
      if (open) walk(category, null, 1)
    }
    return result
    // placementOf / matches read the same inputs listed here
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categories, files, folders, folderByKey, organization, expanded, query])

  const organize = (label: string, change: (value: ExplorerOrganization) => ExplorerOrganization) => {
    if (!organization || !onOrganize || readOnly) return false
    try {
      const next = change(organization)
      if (next !== organization) onOrganize(next, label)
      return true
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), { kind: 'error' })
      return false
    }
  }

  const toggle = (id: string, open?: boolean) => {
    setExpanded(previous => {
      const next = new Set(previous)
      if (open ?? !next.has(id)) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const focusNode = (): TreeNode | null => rows.find(row => nodeId(row.node) === focusId)?.node ?? null
  /** 新建落点：聚焦文件夹，或聚焦文件所在文件夹，或分类根。 */
  const targetOf = (node: TreeNode | null): { category: string; parent: string | null } | null => {
    if (!node) {
      const first = categories.find(category => category.createLabel)
      return first ? { category: first.id, parent: null } : null
    }
    if (node.kind === 'category') return { category: node.category, parent: null }
    if (node.kind === 'folder') return { category: node.category, parent: node.key }
    const file = fileById.get(node.id)
    return { category: node.category, parent: file ? placementOf(file) : null }
  }

  const create = (target: { category: string; parent: string | null } | null, anchor: CreateAnchor | null) => {
    if (!target || readOnly || !onCreate) return
    if (!categoryById.get(target.category)?.createLabel) return
    if (target.parent) toggle(`folder:${target.parent}`, true)
    toggle(`category:${target.category}`, true)
    onCreate(target.category, target.parent, anchor)
  }

  const handledRename = useRef(renameRequest?.seq ?? 0)
  useEffect(() => {
    if (!renameRequest || renameRequest.seq === handledRename.current) return
    const file = fileById.get(renameRequest.id)
    if (!file) return
    handledRename.current = renameRequest.seq
    const open = [`category:${file.category}`]
    for (let key = placementOf(file); key; key = folderByKey.get(key)?.parentId ?? null) open.push(`folder:${key}`)
    const id = `file:${file.id}`
    // 外部请求（刚创建的文件）驱动的一次性状态切换，不是从 props 派生渲染值
    // eslint-disable-next-line react/set-state-in-effect
    setExpanded(previous => new Set([...previous, ...open]))
    setSelected(new Set([id]))
    setFocusId(id)
    if (!readOnly && onRename && !file.detached) setEdit({ kind: 'rename-file', id: file.id, value: file.base, error: '' })
    // placementOf 读取 organization / folderByKey，已在依赖中
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renameRequest, fileById, folderByKey, organization, readOnly, onRename])

  const beginNewFolder = (target: { category: string; parent: string | null } | null) => {
    if (!target || !canOrganize || !categoryById.get(target.category)?.folders) return
    setMenu(null)
    toggle(target.parent ? `folder:${target.parent}` : `category:${target.category}`, true)
    setEdit({ kind: 'new-folder', category: target.category, parent: target.parent, value: '', error: '' })
  }

  const beginRename = (node: TreeNode) => {
    setMenu(null)
    if (readOnly) return
    if (node.kind === 'file' && onRename) {
      const file = fileById.get(node.id)
      if (file && !file.detached) setEdit({ kind: 'rename-file', id: file.id, value: file.base, error: '' })
    } else if (node.kind === 'folder' && canOrganize) {
      const folder = folderByKey.get(node.key)
      if (folder) setEdit({ kind: 'rename-folder', key: folder.key, value: folder.name, error: '' })
    }
  }

  const commitEdit = () => {
    const edit = editRef.current
    if (!edit) return
    const value = edit.value.trim()
    if (edit.kind === 'new-folder' && !value) {
      setEdit(null)
      return
    }
    const nameError = resourceBaseError(value)
    if (nameError) {
      setEdit({ ...edit, error: nameError })
      return
    }
    try {
      if (edit.kind === 'rename-file') {
        const error = onRename?.(edit.id, value) ?? null
        if (error) {
          setEdit({ ...edit, error })
          return
        }
      } else if (edit.kind === 'rename-folder') {
        if (organization && onOrganize) {
          const next = renameVirtualFolder(organization, edit.key, value)
          if (next !== organization) onOrganize(next, '重命名文件夹')
        }
      } else if (organization && onOrganize) {
        const { organization: next, folder } = addVirtualFolder(organization, edit.category, edit.parent, value)
        onOrganize(next, '新建文件夹')
        setSelected(new Set([`folder:${folder.key}`]))
        setFocusId(`folder:${folder.key}`)
      }
      setEdit(null)
    } catch (error) {
      setEdit({ ...edit, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const selectedFiles = (node: TreeNode | null): string[] => {
    const ids = [...selected].filter(id => id.startsWith('file:')).map(id => id.slice('file:'.length))
    if (node?.kind === 'file' && !ids.includes(node.id)) return [node.id]
    return ids.length ? ids : node?.kind === 'file' ? [node.id] : []
  }

  const removeFolder = (key: string) => {
    const folder = folderByKey.get(key)
    if (!folder || !canOrganize) return
    const category = categoryById.get(folder.category)?.name ?? folder.category
    void confirmDialog({
      title: '删除文件夹',
      message: `删除文件夹「${folder.name}」？其中的资源回到「${category}」根下，不会删除源文件。`,
      confirmLabel: '删除',
      danger: true,
    }).then(ok => {
      if (ok) organize('删除文件夹', value => removeVirtualFolder(value, key))
    })
  }

  const remove = (node: TreeNode | null) => {
    if (readOnly || !node) return
    if (node.kind === 'folder') removeFolder(node.key)
    else if (node.kind === 'file' && onDelete) {
      const ids = selectedFiles(node).filter(id => !fileById.get(id)?.detached || id === node.id)
      if (ids.length) onDelete(ids)
    }
  }

  const clickRow = (event: ReactMouseEvent, row: Row, index: number) => {
    const id = nodeId(row.node)
    setFocusId(id)
    if (event.shiftKey && anchorId.current) {
      const from = rows.findIndex(item => nodeId(item.node) === anchorId.current)
      const [start, end] = from < index ? [from, index] : [index, from]
      setSelected(new Set(rows.slice(Math.max(0, start), end + 1).map(item => nodeId(item.node))))
      return
    }
    anchorId.current = id
    if (event.ctrlKey || event.metaKey) {
      setSelected(previous => {
        const next = new Set(previous)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      return
    }
    setSelected(new Set([id]))
    if (row.node.kind === 'file') onOpen(row.node.id)
    else toggle(id)
  }

  const keyDown = (event: KeyboardEvent<HTMLDivElement>, row: Row, index: number) => {
    const move = (to: number) => {
      const target = rows[Math.max(0, Math.min(rows.length - 1, to))]
      if (!target) return
      const id = nodeId(target.node)
      setFocusId(id)
      elements.current.get(id)?.focus()
    }
    if (event.key === 'ArrowDown') move(index + 1)
    else if (event.key === 'ArrowUp') move(index - 1)
    else if (event.key === 'ArrowRight' && row.expanded === false) toggle(nodeId(row.node), true)
    else if (event.key === 'ArrowLeft' && row.expanded) toggle(nodeId(row.node), false)
    else if (event.key === 'Enter') {
      if (row.node.kind === 'file') onOpen(row.node.id)
      else toggle(nodeId(row.node))
    } else if (event.key === 'F2') beginRename(row.node)
    else if (event.key === 'Delete') remove(row.node)
    else return
    event.preventDefault()
  }

  const canDrop = (target: TreeNode): boolean => {
    const source = dragging.current
    if (!source || !canOrganize || source.kind === 'category' || target.kind === 'file') return false
    if (source.category !== target.category || !categoryById.get(target.category)?.folders) return false
    return !(source.kind === 'folder' && target.kind === 'folder' && source.key === target.key)
  }

  const drop = (target: TreeNode) => {
    const source = dragging.current
    dragging.current = null
    setDropTarget(null)
    if (!source || target.kind === 'file' || source.kind === 'category') return
    const parent = target.kind === 'folder' ? target.key : null
    if (source.kind === 'file') {
      const file = fileById.get(source.id)
      if (file) organize('移动资源', value => placeSource(value, file.path, parent))
    } else {
      organize('移动文件夹', value => moveVirtualFolder(value, source.key, parent))
    }
  }

  const menuItems = (node: TreeNode | null, anchor: CreateAnchor): NodeMenuItem[] => {
    const target = targetOf(node)
    const category = target ? categoryById.get(target.category) : undefined
    const items: NodeMenuItem[] = []
    if (category?.createLabel && onCreate) {
      items.push({
        label: category.createLabel,
        disabled: readOnly,
        hint: readOnly ? '只读工程不能新建' : target?.parent ? '新建到此文件夹' : '新建到分类根',
        action: () => create(target, anchor),
      })
    } else if (category && !category.extensions.length) {
      items.push({ label: '暂无新建格式', disabled: true, hint: '该分类尚无原生资源格式', action: () => undefined })
    }
    if (category?.folders && organization) {
      items.push({
        label: target?.parent ? '新建子文件夹' : '新建文件夹',
        disabled: !canOrganize,
        hint: canOrganize ? '共享虚拟文件夹，不创建磁盘目录' : '只读工程不能整理',
        action: () => beginNewFolder(target),
      })
    }
    if (node?.kind === 'file') {
      const file = fileById.get(node.id)
      const files = selectedFiles(node)
      items.unshift({ label: '打开', hint: '在编辑器中显示', action: () => onOpen(node.id) })
      if (onRename) {
        items.push({
          label: '重命名',
          disabled: readOnly || Boolean(file?.detached),
          hint: readOnly ? '只读工程不能重命名' : 'F2 或双击也可以重命名',
          action: () => beginRename(node),
        })
      }
      if (file && placementOf(file) && canOrganize) {
        items.push({ label: '移到分类根', action: () => organize('移动资源', value => placeSource(value, file.path, null)) })
      }
      if (onDelete) {
        items.push({
          label: files.length > 1 ? `删除 ${files.length} 个资源` : '删除',
          disabled: readOnly,
          hint: readOnly ? '只读工程不能删除' : '删除源文件',
          action: () => remove(node),
        })
      }
    } else if (node?.kind === 'folder') {
      const folder = folderByKey.get(node.key)
      items.push({ label: '重命名', disabled: !canOrganize, action: () => beginRename(node) })
      if (folder?.parentId) {
        items.push({ label: '移到分类根', disabled: !canOrganize, action: () => organize('移动文件夹', value => moveVirtualFolder(value, node.key, null)) })
      }
      items.push({ label: '删除文件夹', disabled: !canOrganize, hint: '资源回到分类根，不删除源文件', action: () => removeFolder(node.key) })
    }
    if (node && node.kind !== 'file') {
      const id = nodeId(node)
      items.push({ label: expanded.has(id) ? '折叠' : '展开', action: () => toggle(id) })
    }
    if (!node && slots.blankMenuItems) items.push(...slots.blankMenuItems(anchor))
    return items
  }

  const editRow = (depth: number) =>
    edit?.kind === 'new-folder' ? (
      <div className="explorer-shell-row explorer-shell-new" style={{ paddingLeft: 6 + depth * 10 }}>
        <span className="explorer-shell-twist" />
        <ExplorerIcon kind="folder" />
        {editInput('新文件夹名称')}
      </div>
    ) : null

  const editInput = (aria: string) =>
    edit && (
      <span className="explorer-shell-edit">
        <input
          className="explorer-shell-input"
          aria-label={aria}
          aria-invalid={edit.error ? true : undefined}
          title={edit.error || undefined}
          value={edit.value}
          autoFocus
          spellCheck={false}
          onChange={event => setEdit({ ...edit, value: event.target.value, error: '' })}
          onBlur={commitEdit}
          onClick={event => event.stopPropagation()}
          onKeyDown={event => {
            event.stopPropagation()
            if (event.key === 'Enter') {
              event.preventDefault()
              commitEdit()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              setEdit(null)
            }
          }}
        />
        {edit.error && <span className="explorer-shell-error" role="alert">{edit.error}</span>}
      </span>
    )

  const focusTarget = targetOf(focusNode())
  const focusCategory = focusTarget ? categoryById.get(focusTarget.category) : undefined
  const createTarget = focusCategory?.createLabel ? focusTarget : targetOf(null)
  const createLabel = createTarget ? categoryById.get(createTarget.category)?.createLabel : undefined

  return (
    <ExplorerShellFrame
      label={label}
      classes={{
        root: slots.rootClass ? `explorer-shell ${slots.rootClass}` : 'explorer-shell',
        heading: 'explorer-shell-heading',
        tools: 'explorer-shell-tools',
      }}
      dock={dock}
      tools={
        <>
          {slots.tools}
          <button
            type="button"
            title={createLabel ?? '当前分类不能新建'}
            aria-label={createLabel ?? '新建'}
            disabled={readOnly || !createLabel || !onCreate}
            onClick={event => {
              const rect = event.currentTarget.getBoundingClientRect()
              create(createTarget, { x: rect.left, y: rect.bottom + 2 })
            }}
          >
            <ExplorerIcon kind="new-file" />
          </button>
          {organization && (
            <button
              type="button"
              title="新建文件夹（共享虚拟文件夹）"
              aria-label="新建文件夹"
              disabled={!canOrganize || !focusCategory?.folders}
              onClick={() => beginNewFolder(focusTarget)}
            >
              <ExplorerIcon kind="new-folder" />
            </button>
          )}
          <button
            type="button"
            title="折叠全部"
            aria-label="折叠全部"
            onClick={() => {
              setExpanded(new Set())
              setSearch('')
            }}
          >
            <ExplorerIcon kind="collapse" />
          </button>
        </>
      }
    >
      <input
        className="explorer-shell-search"
        placeholder="筛选资源…"
        aria-label="筛选资源"
        value={search}
        onChange={event => setSearch(event.target.value)}
      />
      <div
        className="explorer-shell-tree"
        role="tree"
        aria-label={label}
        aria-multiselectable="true"
        onContextMenu={event => {
          event.preventDefault()
          setMenu({ node: null, x: event.clientX, y: event.clientY })
        }}
      >
        {slots.prepend}
        {rows.map((row, index) => {
          const id = nodeId(row.node)
          const category = categoryById.get(row.node.category)!
          const renaming =
            (edit?.kind === 'rename-file' && row.node.kind === 'file' && edit.id === row.node.id) ||
            (edit?.kind === 'rename-folder' && row.node.kind === 'folder' && edit.key === row.node.key)
          const newFolderHere =
            edit?.kind === 'new-folder' && row.node.category === edit.category &&
            (row.node.kind === 'category' ? edit.parent === null : row.node.kind === 'folder' && edit.parent === row.node.key)
          const draggable = canOrganize && category.folders && row.node.kind !== 'category' && !renaming
          const placeholder = row.node.kind === 'category' && row.expanded && !category.extensions.length && !query
          const empty = row.node.kind === 'category' && row.expanded && category.extensions.length > 0 && !query &&
            row.count === 0 && !folders.some(folder => folder.category === category.id)
          return (
            <div key={id} role="none" className={row.node.kind === 'category' ? 'explorer-shell-category' : undefined}>
              <ExplorerTreeRow
                rowRef={element => {
                  if (element) elements.current.set(id, element)
                  else elements.current.delete(id)
                }}
                depth={row.depth}
                expanded={row.expanded}
                classes={{
                  row: `explorer-shell-row${row.node.kind === 'category' ? ' is-category' : ''}`,
                  twist: 'explorer-shell-twist',
                }}
                state={{
                  selected: selected.has(id),
                  open: row.node.kind === 'file' && row.node.id === activeId,
                  dropTarget: dropTarget === id,
                  detached: row.file?.detached,
                }}
                icon={<ExplorerIcon kind={row.icon} />}
                tabIndex={id === focusId || (focusId === null && index === 0) ? 0 : -1}
                title={row.file ? `${row.file.path}\n右键：打开、重命名、移动或删除` : row.name}
                draggable={draggable}
                onClick={event => {
                  if (event.detail > 1) return
                  clickRow(event, row, index)
                }}
                onDoubleClick={event => {
                  event.preventDefault()
                  beginRename(row.node)
                }}
                onFocus={event => {
                  if (event.target === event.currentTarget) setFocusId(id)
                }}
                onKeyDown={event => keyDown(event, row, index)}
                onContextMenu={event => {
                  event.preventDefault()
                  event.stopPropagation()
                  setFocusId(id)
                  if (!selected.has(id)) setSelected(new Set([id]))
                  setMenu({ node: row.node, x: event.clientX, y: event.clientY })
                }}
                onDragStart={event => {
                  dragging.current = row.node
                  event.dataTransfer.effectAllowed = 'copyMove'
                  event.dataTransfer.setData(SHELL_DRAG_MIME, id)
                  if (row.file) onFileDragStart?.(row.file, event)
                }}
                onDragEnd={() => {
                  dragging.current = null
                  setDropTarget(null)
                }}
                onDragOver={event => {
                  if (!canDrop(row.node)) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  setDropTarget(id)
                }}
                onDragLeave={() => setDropTarget(previous => (previous === id ? null : previous))}
                onDrop={event => {
                  if (!canDrop(row.node)) return
                  event.preventDefault()
                  drop(row.node)
                }}
              >
                {renaming ? (
                  editInput(row.node.kind === 'file' ? '重命名资源' : '重命名文件夹')
                ) : (
                  <span className="explorer-shell-name">{row.name}</span>
                )}
                {row.node.kind === 'category' && (
                  <span className="explorer-shell-count">{row.count ?? '—'}</span>
                )}
              </ExplorerTreeRow>
              {newFolderHere && editRow(row.depth + 1)}
              {placeholder && (
                <p className="explorer-shell-empty">格式待定。分类已预留，后续接入资源类型。</p>
              )}
              {empty && (
                <p className="explorer-shell-empty">{emptyHint?.(category) ?? '暂无资源。'}</p>
              )}
            </div>
          )
        })}
        {query && !rows.some(row => row.node.kind !== 'category') && (
          <p className="explorer-shell-empty">没有匹配的资源</p>
        )}
        {addons}
      </div>
      <div className="explorer-shell-footer">
        {selected.size > 1 ? `已选 ${selected.size} 项 · ` : ''}
        {categories.length} 个分类 · {files.length} 个资源
        {organization ? ` · ${folders.length} 个共享文件夹` : ''}
      </div>
      {menu && (
        <NodeContextMenu
          x={menu.x}
          y={menu.y}
          title={menu.node ? rows.find(row => nodeId(row.node) === nodeId(menu.node!))?.name ?? label : label}
          label="资源操作"
          items={menuItems(menu.node, { x: menu.x, y: menu.y })}
          onClose={(restore = true) => {
            const node = menu.node
            setMenu(null)
            if (restore && node) elements.current.get(nodeId(node))?.focus()
          }}
        />
      )}
    </ExplorerShellFrame>
  )
}
