import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AssetFile, ScriptPackage, Workspace } from './workspace'
import { isVoiceMapFile } from './workspace'
import { packageLocationLabel, packageLocationTitle } from './project/projectLabel'
import {
  currentDrag,
  droppedFiles,
  endDrag,
  hasExternalFiles,
  readDragPayload,
  resolveDropIntent,
  shouldAcceptDrop,
  writeDragPayload,
  type DragSource,
} from './drag/dragPayload'
import {
  assetFileName,
  buildAssetTree,
  type AssetTreeDir,
  type AssetTreeNode,
} from './assets/paths'
import { ExplorerIcon, fileIconKind, sourceIconKind } from './explorerIcons'
import {
  findNewFileType,
  newFileName,
  newFileTypesByGroup,
  type NewFileType,
  type NewFileTypeId,
} from './newFileTypes'
import { shouldHoldWheel } from './newFileMenuWheel'
import {
  WORKSPACE_GROUP_ORDER,
  groupDirPrefix,
  sourceKindOf,
} from './workspace'
import './explorer-newfile.css'

/**
 * 目录行的投放接线（包行 / assets 目录行共用）：
 * - 外部文件 → 等价于复制粘贴导入
 * - 内部的脚本 / 资产 → 等价于剪切移动
 *
 * 高亮只给**判定得出意图**的那种拖拽；但**准放**（`preventDefault`）不能只给它们 ——
 * 见下面 `onDragOver` 里的说明：拿 `types` 判"有没有文件"在 WebView2 上会漏，
 * 漏了就是不 preventDefault、浏览器不允许投放、`drop` 永远不来。
 */
function useFolderDropTarget(options: {
  onFiles(files: File[]): void
  onPayload(source: DragSource): void
}) {
  const [active, setActive] = useState(false)
  const resolve = (event: React.DragEvent) =>
    resolveDropIntent({
      target: 'explorer-folder',
      source: currentDrag(),
      hasFiles: hasExternalFiles(event.dataTransfer),
    })

  return {
    active,
    handlers: {
      onDragOver: (event: React.DragEvent) => {
        const intent = resolve(event)
        if (!intent) {
          setActive(false)
          /*
           * 判定不出意图也要**吃掉默认行为**：准放判据只有一条 —— 不是本应用自己的
           * 内部拖拽就一律接下（见 `shouldAcceptDrop`）。拿 `types` 判"有没有文件"在
           * WebView2 上会漏，漏了就是不 preventDefault、浏览器不允许投放、drop 不来。
           */
          if (shouldAcceptDrop(event.dataTransfer)) event.preventDefault()
          return
        }
        event.preventDefault()
        event.stopPropagation()
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect =
            intent.action === 'move-into-folder' ? 'move' : 'copy'
        }
        setActive(true)
      },
      onDragLeave: (event: React.DragEvent) => {
        const next = event.relatedTarget as Node | null
        if (!next || !event.currentTarget.contains(next)) setActive(false)
      },
      onDrop: (event: React.DragEvent) => {
        const files = droppedFiles(event.dataTransfer)
        // 判定用**实际拿到的文件**兜底：意图表里的 hasFiles 只是 dragover 的猜测
        const intent =
          resolve(event) ??
          (files.length > 0 && !currentDrag()
            ? ({ action: 'import-files' } as const)
            : null)
        setActive(false)
        if (!intent) return
        event.preventDefault()
        event.stopPropagation()
        const source = readDragPayload(event.dataTransfer)
        endDrag()
        if (intent.action === 'import-files') {
          options.onFiles(files)
          return
        }
        if (intent.action === 'move-into-folder' && source) {
          options.onPayload(source)
        }
      },
    },
  }
}

/** 正在命名的那个新文件。一次只允许一个：同一时刻该只有一行输入框 */
type NewFileDraft = {
  packageId: string
  typeId: NewFileTypeId
  base: string
  /** 行内错误（重名 / 非法名）；空串 = 还没提交过 */
  error: string
}

/**
 * 「新建文件」在资源树里的全部接线。
 *
 * 状态统一放在 `Explorer` 上而不是各包自己存：下拉菜单是**整棵树只有一个**的浮层，
 * 而同一时刻也只该有一行命名输入框 —— 分到 `PackageNode` 里就得处理"两个包各开一个"。
 */
type NewFileWiring = {
  /** 属于**这个包**的草稿；别的包开着时这里是 null */
  draft: NewFileDraft | null
  /**
   * 触发器被点：同一个锚点再点一次收起，否则把菜单挪到这个锚点上（见 `toggleMenu`）。
   * 包行的 `+` 与头部的 `+剧` 走同一条，两处行为不会两样。
   */
  toggleMenu: (packageId: string, anchor: HTMLElement | null) => void
  changeBase: (base: string) => void
  submit: () => void
  cancel: () => void
}

type ExplorerProps = {
  workspace: Workspace
  activeScriptId: string | null
  activeAssetId: string | null
  /** 绑定到本地工程文件夹的那个包 id（null = 没有绑定工程） */
  boundPackageId: string | null
  /** 该工程的本地位置（浏览器 API 只给得到文件夹名） */
  boundFolderName: string | null
  onOpenScript: (scriptId: string) => void
  onOpenAsset: (assetId: string) => void
  onTogglePackage: (packageId: string) => void
  onToggleAssets: (packageId: string) => void
  onNewPackage: () => void
  /**
   * 新建文件（取代旧的 `onNewScript`）。
   *
   * **成功返回 null，失败返回要显示在命名行里的中文原因**。校验（非法名 / 重名）与创建
   * 都在剧本工作区那一侧：只有它同时握着工作区快照与创建管线，让资源树再判一遍
   * 就会有两份会漂移的规则。返回字符串而不是抛异常，是因为这条错误要就地画在
   * 输入框下面（旧代码是 `window.alert`，用户得重新找位置）。
   */
  onNewFile: (packageId: string, typeId: NewFileTypeId, base: string) => string | null
  /**
   * 应用菜单「新建剧本」的等价入口：**值变化**即请求打开类型选择器（0 = 从未请求）。
   *
   * 用计数器而不是布尔量：菜单项连点两次时布尔量第二次不产生变化，菜单就不会重开。
   * 目标包与「+剧」同一套判定（见 `activePackageId`），锚点就是那个按钮。
   */
  newFileMenuRequest?: number
  onRenamePackage: (packageId: string) => void
  onRenameScript: (scriptId: string) => void
  onDeletePackage: (packageId: string) => void
  onDeleteScript: (scriptId: string) => void
  onDeleteAsset: (assetId: string) => void
  onNewAssetFolder: (packageId: string, parentPath: string) => void
  onDeleteAssetFolder: (packageId: string, folderPath: string) => void
  onImportAssets: (
    packageId: string,
    files: FileList | File[],
    targetDir?: string,
  ) => void
  onGeneratePlaceholderVoice: (scriptId: string) => void
  /** 内部拖拽落到目录行：把载荷里的脚本 / 资产移动到该包该目录 */
  onDropIntoFolder: (
    targetPackageId: string,
    targetDir: string,
    source: DragSource,
  ) => void
}

export function Explorer({
  workspace,
  activeScriptId,
  activeAssetId,
  boundPackageId,
  boundFolderName,
  onOpenScript,
  onOpenAsset,
  onTogglePackage,
  onToggleAssets,
  onNewPackage,
  onNewFile,
  newFileMenuRequest = 0,
  onRenamePackage,
  onRenameScript,
  onDeletePackage,
  onDeleteScript,
  onDeleteAsset,
  onNewAssetFolder,
  onDeleteAssetFolder,
  onImportAssets,
  onGeneratePlaceholderVoice,
  onDropIntoFolder,
}: ExplorerProps) {
  const [menu, setMenu] = useState<{
    packageId: string
    x: number
    y: number
    /**
     * 打开菜单的那个按钮。用来判"再点一次是不是同一个触发器" ——
     * 树里（含 `+剧` 与每个包行的 `+`）有好几个触发器，只看"菜单开着没有"的话，
     * 点 B 包的 `+` 会被当成"收起 A 包的菜单"，那一下就没反应。
     */
    anchor: HTMLElement | null
  } | null>(null)
  const [draft, setDraft] = useState<NewFileDraft | null>(null)
  const headerButtonRef = useRef<HTMLButtonElement>(null)
  /** 已处理过的请求号。挂载时那一次（0）不算请求，否则一进工作区菜单就自己弹出来 */
  const handledRequestRef = useRef(newFileMenuRequest)

  /** 「+剧」/ 文件菜单的目标包：当前活动文件所在的包，没有就第一个 */
  const activePackageId = (): string | null => {
    const target =
      workspace.packages.find(
        (pkg) =>
          pkg.scripts.some((s) => s.id === activeScriptId) ||
          pkg.assets.some((a) => a.id === activeAssetId),
      ) ?? workspace.packages[0]
    return target?.id ?? null
  }

  /**
   * 打开类型选择器。菜单是 `fixed` 的，所以这里要先把触发按钮的位置算成视口坐标 ——
   * 挂在树里当普通子节点会被资源树的滚动容器裁掉。
   */
  const openMenu = (packageId: string, anchor: HTMLElement | null) => {
    const rect = anchor?.getBoundingClientRect()
    setMenu({
      packageId,
      x: rect ? rect.left : 8,
      y: rect ? rect.bottom + 2 : 8,
      anchor,
    })
  }

  /**
   * 触发器被点：同一个锚点 = 收起，别的锚点 = 把菜单挪过去。
   *
   * 菜单自己的"点外部关闭"会跳过 `[data-newfile-trigger]`（见 NewFileTypeMenu），
   * 所以开关只能由触发器自己管 —— 两边都管就会各关一次又各开一次，表现为"点一下没反应"。
   */
  const toggleMenu = (packageId: string, anchor: HTMLElement | null) => {
    if (menu && menu.anchor === anchor) {
      setMenu(null)
      return
    }
    openMenu(packageId, anchor)
  }

  useEffect(() => {
    // 请求号没变 = 不是新的一次请求。工作区变化也会走到这里，那不该弹菜单
    if (newFileMenuRequest === handledRequestRef.current) return
    handledRequestRef.current = newFileMenuRequest
    const packageId = activePackageId()
    // 这一下 setState 是"响应外部请求"（应用菜单），不是从 props 派生渲染值 ——
    // 与 `FlowExplorer` 里那几处同一性质，所以同样按既定写法放行
    // eslint-disable-next-line react/set-state-in-effect
    if (packageId) openMenu(packageId, headerButtonRef.current)
    // 目标包只在这一刻取一次：之后活动文件变了也不该把已经打开的菜单挪走
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newFileMenuRequest])

  const changeBase = (base: string) =>
    setDraft((current) => (current ? { ...current, base, error: '' } : current))

  const submitDraft = () => {
    if (!draft) return
    const error = onNewFile(draft.packageId, draft.typeId, draft.base)
    // 失败就把行留着并就地报错：用户刚敲的名字还在，改一下就能重试
    if (error) setDraft({ ...draft, error })
    else setDraft(null)
  }

  return (
    <aside className="explorer" aria-label="资源管理器">
      <div className="explorer-header">
        <span>资源管理器</span>
        <div className="explorer-actions">
          <button
            ref={headerButtonRef}
            type="button"
            data-newfile-trigger
            title="新建文件…（先选类型，再填名字）"
            onClick={(event) => {
              // 再点一次收起（同一个锚点）；别的触发器则把菜单挪过去。
              // 菜单的"点外部关闭"会跳过触发器（见 NewFileTypeMenu），
              // 所以开关只能由触发器自己管，否则两个处理器会各关一次又各开一次
              const packageId = activePackageId()
              if (packageId) toggleMenu(packageId, event.currentTarget)
            }}
          >
            +剧
          </button>
          <button type="button" title="新建包" onClick={onNewPackage}>
            +包
          </button>
        </div>
      </div>

      <div className="explorer-tree">
        {workspace.packages.map((pkg) => (
          <PackageNode
            key={pkg.id}
            pkg={pkg}
            activeScriptId={activeScriptId}
            activeAssetId={activeAssetId}
            locationLabel={packageLocationLabel({
              packageId: pkg.id,
              boundPackageId,
            })}
            locationTitle={packageLocationTitle({
              packageId: pkg.id,
              boundPackageId,
              boundFolderName,
            })}
            newFile={{
              draft: draft?.packageId === pkg.id ? draft : null,
              toggleMenu,
              changeBase,
              submit: submitDraft,
              cancel: () => setDraft(null),
            }}
            onOpenScript={onOpenScript}
            onOpenAsset={onOpenAsset}
            onTogglePackage={onTogglePackage}
            onToggleAssets={onToggleAssets}
            onRenamePackage={onRenamePackage}
            onRenameScript={onRenameScript}
            onDeletePackage={onDeletePackage}
            onDeleteScript={onDeleteScript}
            onDeleteAsset={onDeleteAsset}
            onNewAssetFolder={onNewAssetFolder}
            onDeleteAssetFolder={onDeleteAssetFolder}
            onImportAssets={onImportAssets}
            onGeneratePlaceholderVoice={onGeneratePlaceholderVoice}
            onDropIntoFolder={onDropIntoFolder}
          />
        ))}
        {workspace.packages.length === 0 && (
          <div className="explorer-empty">暂无资源，点击 +包 开始</div>
        )}
      </div>

      {menu && (
        <NewFileTypeMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onPick={(type) => {
            setMenu(null)
            setDraft({
              packageId: menu.packageId,
              typeId: type.id,
              base: type.defaultBase,
              error: '',
            })
          }}
        />
      )}
    </aside>
  )
}

/**
 * 新建文件类型选择器。
 *
 * 没复用 `skin/components/ContextMenu.tsx`：那个是**单层文字项**的通用右键菜单，
 * 没有分组、没有图标、也没有每项那句说明 —— 而这三点正是"选文件类型"要靠的东西
 * （要一眼看清哪个是进度、哪个是礼包、哪个 .py 是目标定义）。它的样式还住在皮肤工作区的
 * CSS module 里，借过来会把两个工作区的观感绑在一起。
 */
function NewFileTypeMenu({
  x,
  y,
  onPick,
  onClose,
}: {
  x: number
  y: number
  onPick: (type: NewFileType) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLUListElement>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [active, setActive] = useState(0)
  const [pos, setPos] = useState({ x, y })
  /*
   * 展平后的可选项：分组标题不参与上下键，所以键盘走的是这一份。
   * 每一项在 `items` 里的下标就是它的序号 —— 渲染时用 `indexOf` 现算，
   * 不在 JSX 里累加计数器（那是对渲染期变量的改写，React 编译器会拦）。
   */
  const items = useMemo(
    () => newFileTypesByGroup().flatMap((entry) => entry.items),
    [],
  )

  // 贴到视口边缘时翻回另一侧（与资源树右键菜单同一套规则）
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPos({
      x: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
    })
  }, [x, y])

  // 打开就把焦点交给当前项：键盘用户不必先 Tab 一遍，↑/↓ 才有落点
  useEffect(() => {
    itemRefs.current[active]?.focus()
  }, [active])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActive((index) => (index + 1) % items.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActive((index) => (index - 1 + items.length) % items.length)
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        const type = items[active]
        if (type) onPick(type)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items, active, onPick, onClose])

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element)) {
        onClose()
        return
      }
      if (ref.current?.contains(target)) return
      /*
       * 触发器（`+剧` / 包行 `+`）自己的点击留给它处理：这里先关掉的话，
       * 紧接着的 click 会把它又打开一次 —— 表现为"点一下没反应"。
       */
      if (target.closest('[data-newfile-trigger]')) return
      onClose()
    }
    /*
     * 菜单自己的滚动**不该**把菜单关掉。
     *
     * 上面的捕获监听是为了抓资源树那种不冒泡的容器滚动，但 `scroll` 在捕获阶段
     * 照样会经过 window —— 菜单现在自己就是滚动容器（类型多了要能滚，见
     * .explorer-newfile-menu 的 max-height），于是"滚轮一碰菜单，菜单瞬间消失"。
     */
    const onScroll = (event: Event) => {
      const el = ref.current
      if (el && event.target instanceof Node && el.contains(event.target)) return
      onClose()
    }
    /*
     * 滚轮要被菜单自己吃掉，不能穿透去滚背后的资源树 —— 树一滚，上面那条监听
     * 立刻把菜单关掉（菜单是 fixed 定位，不跟锚点走，所以关掉也算合理，但用户
     * 只是想滚菜单）。菜单自己还能滚时交给浏览器原生滚（只在到边界时才拦），
     * 菜单根本不溢出时直接拦下 —— 否则滚轮会去滚树、菜单照样消失。
     *
     * 用原生监听而不是 React 的 onWheel：React 在根节点上把 wheel 注册成 passive，
     * 里面 preventDefault 不生效（还会打警告）。
     */
    const el = ref.current
    const onWheel = (event: WheelEvent) => {
      if (!el) return
      // 判据本身是纯算术，抽在 newFileMenuWheel 里穷举测（这里只管取数与拦）
      if (
        shouldHoldWheel({
          scrollTop: el.scrollTop,
          clientHeight: el.clientHeight,
          scrollHeight: el.scrollHeight,
          deltaY: event.deltaY,
        })
      ) {
        event.preventDefault()
      }
    }
    window.addEventListener('mousedown', onMouseDown)
    // 捕获阶段：资源树自己的滚动容器不会把事件冒泡到 window
    window.addEventListener('scroll', onScroll, true)
    el?.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('scroll', onScroll, true)
      el?.removeEventListener('wheel', onWheel)
    }
  }, [onClose])

  return (
    <ul
      ref={ref}
      className="explorer-newfile-menu"
      style={{ left: pos.x, top: pos.y }}
      role="menu"
      aria-label="新建文件类型"
    >
      {newFileTypesByGroup().map(({ group, items: groupItems }) => (
        <li key={group.id} role="none">
          <div className="explorer-newfile-group" aria-hidden>
            {group.label}
          </div>
          <ul role="none">
            {groupItems.map((type) => {
              const itemIndex = items.indexOf(type)
              return (
                <li key={type.id} role="none">
                  <button
                    ref={(el) => {
                      itemRefs.current[itemIndex] = el
                    }}
                    type="button"
                    role="menuitem"
                    className={`explorer-newfile-item${
                      itemIndex === active ? ' is-active' : ''
                    }`}
                    onMouseEnter={() => setActive(itemIndex)}
                    onClick={() => onPick(type)}
                  >
                    <ExplorerIcon kind={type.icon} />
                    <span className="explorer-newfile-label">{type.label}</span>
                    <span className="explorer-newfile-ext">{type.ext}</span>
                    <span className="explorer-newfile-hint">{type.hint}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </li>
      ))}
    </ul>
  )
}

/**
 * 内联命名行：选完类型就地出现，预填该类型的默认基名并**全选**，用户直接打字即可。
 *
 * 后缀画在输入框右边、不可编辑 —— 这次要解决的就是"让用户自己写后缀"。
 * 提交（Enter）交给上层校验，回来的错误文案显示在**这一行下面**：重名 / 非法名正是
 * 用户此刻在处理的事，弹到别处（旧代码是 `window.alert`）等于让他重新找位置。
 * Esc 与失焦都取消：这两下都是"我不想建了"，没有第三种解释。
 */
function NewFileRow({
  type,
  base,
  error,
  onChange,
  onSubmit,
  onCancel,
}: {
  type: NewFileType
  base: string
  error: string
  onChange: (base: string) => void
  onSubmit: () => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)

  // 打开即选中整段基名：默认名就是"整个基名"，敲第一个字就该把它替换掉
  useEffect(() => {
    const input = ref.current
    if (!input) return
    input.focus()
    input.setSelectionRange(0, input.value.length)
  }, [])

  return (
    <li className="explorer-newfile-row-item">
      <form
        className="explorer-newfile-row"
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit()
        }}
      >
        {/*
         * 图标与后缀不是焦点目标：点它们不该把输入框的焦点夺走 ——
         * 焦点一走 onBlur 就把这一行取消了，用户看到的是"点了一下就没了"
         */}
        <span
          className="explorer-newfile-affix"
          onMouseDown={(event) => event.preventDefault()}
        >
          <ExplorerIcon kind={type.icon} />
        </span>
        <input
          ref={ref}
          className="explorer-newfile-input"
          value={base}
          aria-label={`${type.label}文件名`}
          aria-invalid={error ? true : undefined}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              onCancel()
            }
          }}
          onBlur={onCancel}
        />
        <span
          className="explorer-newfile-affix explorer-newfile-ext"
          onMouseDown={(event) => event.preventDefault()}
        >
          {type.ext}
        </span>
      </form>
      {error && (
        // 点错误文案本身不该取消这一行（它不是焦点目标，mousedown 会先把输入框的焦点夺走）
        <div
          className="explorer-newfile-error"
          role="alert"
          onMouseDown={(event) => event.preventDefault()}
        >
          {error}
        </div>
      )}
    </li>
  )
}

function PackageNode({
  pkg,
  activeScriptId,
  activeAssetId,
  locationLabel,
  locationTitle,
  newFile,
  onOpenScript,
  onOpenAsset,
  onTogglePackage,
  onToggleAssets,
  onRenamePackage,
  onRenameScript,
  onDeletePackage,
  onDeleteScript,
  onDeleteAsset,
  onNewAssetFolder,
  onDeleteAssetFolder,
  onImportAssets,
  onGeneratePlaceholderVoice,
  onDropIntoFolder,
}: {
  pkg: ScriptPackage
  activeScriptId: string | null
  activeAssetId: string | null
  /** 这个工程的本地位置标签（小灰字：本地工程） */
  locationLabel: string
  /** 标签的说明（tooltip） */
  locationTitle: string
  newFile: NewFileWiring
  onOpenScript: (scriptId: string) => void
  onOpenAsset: (assetId: string) => void
  onTogglePackage: (packageId: string) => void
  onToggleAssets: (packageId: string) => void
  onRenamePackage: (packageId: string) => void
  onRenameScript: (scriptId: string) => void
  onDeletePackage: (packageId: string) => void
  onDeleteScript: (scriptId: string) => void
  onDeleteAsset: (assetId: string) => void
  onNewAssetFolder: (packageId: string, parentPath: string) => void
  onDeleteAssetFolder: (packageId: string, folderPath: string) => void
  onImportAssets: (
    packageId: string,
    files: FileList | File[],
    targetDir?: string,
  ) => void
  onGeneratePlaceholderVoice: (scriptId: string) => void
  /** 内部拖拽落到目录行 */
  onDropIntoFolder: (
    targetPackageId: string,
    targetDir: string,
    source: DragSource,
  ) => void
}) {
  const [collapsedDirs, setCollapsedDirs] = useState<Record<string, boolean>>(
    {},
  )
  const [ctxMenu, setCtxMenu] = useState<{
    x: number
    y: number
    scriptId: string
  } | null>(null)

  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [ctxMenu])

  const tree = useMemo(
    () => buildAssetTree(pkg.assets, pkg.assetFolders ?? []),
    [pkg.assets, pkg.assetFolders],
  )

  const toggleDir = (path: string) => {
    setCollapsedDirs((prev) => ({ ...prev, [path]: !prev[path] }))
  }

  const isDirCollapsed = (path: string) => Boolean(collapsedDirs[path])

  // 包行本身也是投放目标：外部文件进 `assets/`，内部脚本 / 资产移进本包
  const pkgDrop = useFolderDropTarget({
    onFiles: (files) => onImportAssets(pkg.id, files, 'assets'),
    onPayload: (source) => onDropIntoFolder(pkg.id, 'assets', source),
  })

  /**
   * 源文件按 `src/<kind>/` 分组、创作资料归 `meta/`。
   *
   * 桶按 `WORKSPACE_GROUP_ORDER`（**全部**源类型 + `meta`）建，不是剧本工作区那套
   * `STAGEPLAY_WORKSPACE_GROUP_ORDER`（只有 hanshu / character / script / meta）。
   * 用后者时 `sourceKindOf` 返回 goal / progress / story / navigator / gift 的文件
   * **既不入桶也不入 root**，被 `continue` 静默丢掉：从「+剧」新建进度 / 流程 / 导航 /
   * 礼包 / 目标定义（11 种里的 5 种）建完就在树里消失 —— 文件其实建成了、还成了活动文件，
   * 只是看不见。**树永远不许静默丢文件**：宁可多列一个分组头，也不能让刚建出来的文件找不到。
   *
   * 这是有意的行为变化：`src/progress` / `src/story` / `src/navigator` / `src/gift` /
   * `src/script/goal` 里有文件时，剧本资源树也会把它们列出来。进度工作区照样用它自己那套视图
   * 展示同一批文件（同一份 `SourceFile`，两种视图），两边不冲突 ——
   * 而"刚建出来的文件必须找得到"比"两个工作区的分组严格不重叠"重要得多。
   *
   * `unknownByKind` 是给"将来往 `FILE_DIRS` 加了新后缀、忘了同步 `SOURCE_KIND_ORDER`"
   * 兜的底：那种文件同样必须看得见（分组头退回 `src/<kind>` 的原始名字）。
   */
  const grouped = useMemo(() => {
    const byKind = new Map<string, Array<(typeof pkg.scripts)[number]>>(
      (WORKSPACE_GROUP_ORDER as readonly string[]).map((kind) => [kind, []]),
    )
    const root: Array<(typeof pkg.scripts)[number]> = []
    const unknownByKind = new Map<string, Array<(typeof pkg.scripts)[number]>>()
    for (const script of pkg.scripts) {
      const kind = sourceKindOf(script.name, script.srcKind)
      // `root` 语义不变：未归类（留在包根）的文件直接挂在包下面，不套分组头
      if (kind === 'root') {
        root.push(script)
        continue
      }
      const bucket = byKind.get(kind)
      if (bucket) {
        bucket.push(script)
        continue
      }
      const fallback = unknownByKind.get(kind)
      if (fallback) fallback.push(script)
      else unknownByKind.set(kind, [script])
    }
    return { byKind, root, unknownByKind }
  }, [pkg.scripts])

  const renderScriptRow = (script: (typeof pkg.scripts)[number]) => (
    <li key={script.id}>
      <div
        className={`explorer-row explorer-file-row${
          script.id === activeScriptId ? ' active' : ''
        }`}
        draggable
        onDragStart={(e) => {
          writeDragPayload(e.dataTransfer, {
            kind: 'script',
            packageId: pkg.id,
            scriptId: script.id,
            name: script.name,
          })
        }}
        onDragEnd={() => endDrag()}
        onContextMenu={
          isVoiceMapFile(script.name)
            ? (e) => {
                e.preventDefault()
                e.stopPropagation()
                setCtxMenu({
                  x: e.clientX,
                  y: e.clientY,
                  scriptId: script.id,
                })
              }
            : undefined
        }
      >
        <button
          type="button"
          className="explorer-label"
          onClick={() => onOpenScript(script.id)}
          onDoubleClick={() => onRenameScript(script.id)}
          title={
            isVoiceMapFile(script.name) ? '右键：生成空白 ogg' : '双击重命名'
          }
        >
          <ExplorerIcon kind={sourceIconKind(script)} />
          <span className="explorer-name">{script.name}</span>
        </button>
        <div className="explorer-row-actions">
          <button
            type="button"
            title="删除剧本"
            onClick={() => onDeleteScript(script.id)}
          >
            ×
          </button>
        </div>
      </div>
    </li>
  )

  const pendingType = newFile.draft
    ? findNewFileType(newFile.draft.typeId)
    : null
  /*
   * 待命名的那一行要落在**它所属的分组**下 —— 与建完之后文件出现的分组一致。
   * 分组用 `sourceKindOf` 现算（而不是给注册表再写一个 group 字段）：
   * 落哪个目录只有 `FILE_DIRS` 说了算，抄一份到注册表就是又一处会漂移的规则。
   */
  const pendingKind =
    newFile.draft && pendingType
      ? sourceKindOf(
          newFileName(pendingType, newFile.draft.base),
          pendingType.srcKind,
        )
      : null

  const newFileRow =
    newFile.draft && pendingType ? (
      <NewFileRow
        key="new-file"
        type={pendingType}
        base={newFile.draft.base}
        error={newFile.draft.error}
        onChange={newFile.changeBase}
        onSubmit={newFile.submit}
        onCancel={newFile.cancel}
      />
    ) : null

  /**
   * 一个分组（`src/<kind>` 表头 + 该组的文件行）。**树里所有分组都走这一个渲染器**：
   * 展开的包、未归类的 kind、待命名的那一行、以及折叠包里的那一个落点，全都用它。
   *
   * 早先"展开路径"与"待命名兜底"各写了一份相同的 `<li className="explorer-kind">`，
   * 于是 bug 只发生在其中一份上（新建的进度 / 流程 / 导航 / 礼包建完即消失，
   * 而待命名那一行是好的）—— 一份渲染器就没有这种"两边长歪"的余地。
   */
  const renderKindGroup = (
    kind: string,
    items: Array<(typeof pkg.scripts)[number]>,
    pendingRow: ReactNode,
  ) => (
    <li key={`kind-${kind}`} className="explorer-kind">
      <div className="explorer-kind-row">
        <ExplorerIcon kind="group" />
        <span className="explorer-name">{groupDirPrefix(kind)}</span>
      </div>
      <ul className="explorer-files nested">
        {items.map(renderScriptRow)}
        {pendingRow}
      </ul>
    </li>
  )

  /**
   * 这次要画的分组，合并成一份列表：标准分组（`WORKSPACE_GROUP_ORDER`）→ 未归类的 kind
   * （`grouped` 兜底收下的）→ 待命名的分组（若它不在前两者里）。
   *
   * 合并成一份而不是各画各的，是为了让"哪些分组该出现"只有一处判断：
   * 漏一个分支就是文件凭空不见，而那种 bug 靠点 11 个类型是发现不了的
   * （`scripts/verify-new-file-types.ts` 有断言守着这条）。
   */
  const groupsToRender = useMemo(() => {
    const order: string[] = [...WORKSPACE_GROUP_ORDER]
    for (const kind of grouped.unknownByKind.keys()) {
      if (!order.includes(kind)) order.push(kind)
    }
    if (pendingKind && !order.includes(pendingKind)) order.push(pendingKind)
    return order.map((kind) => ({
      kind,
      items:
        grouped.byKind.get(kind) ?? grouped.unknownByKind.get(kind) ?? [],
    }))
  }, [grouped, pendingKind])

  return (
    <div
      className={`explorer-pkg${pkgDrop.active ? ' is-drop-target' : ''}`}
      {...pkgDrop.handlers}
    >
      <div className="explorer-row explorer-pkg-row">
        <button
          type="button"
          className="explorer-twist"
          onClick={() => onTogglePackage(pkg.id)}
          aria-label={pkg.collapsed ? '展开' : '折叠'}
        >
          {pkg.collapsed ? '▸' : '▾'}
        </button>
        <button
          type="button"
          className="explorer-label"
          onClick={() => onTogglePackage(pkg.id)}
          onDoubleClick={() => onRenamePackage(pkg.id)}
          title="双击重命名；可拖入文件到包内 assets/"
        >
          <ExplorerIcon kind="package" />
          <span className="explorer-pkg-name">{pkg.name}</span>
          {/* 本地位置：小灰字。Local Mirror = 绑定了磁盘上的工程文件夹 */}
          <span className="explorer-pkg-path" title={locationTitle}>
            {locationLabel}
          </span>
        </button>
        <div className="explorer-row-actions">
          <button
            type="button"
            data-newfile-trigger
            title="在此包新建文件…（先选类型，再填名字）"
            onClick={(event) => newFile.toggleMenu(pkg.id, event.currentTarget)}
          >
            +
          </button>
          <button
            type="button"
            title="删除包"
            onClick={() => onDeletePackage(pkg.id)}
          >
            ×
          </button>
        </div>
      </div>

      {!pkg.collapsed && (
        <>
          <ul className="explorer-files">
            {groupsToRender.map(({ kind, items }) => {
              const pendingHere = pendingKind === kind
              // 空分组平时不出现；正在命名的那一行例外 —— 它得先有个落点
              if (items.length === 0 && !pendingHere) return null
              return renderKindGroup(kind, items, pendingHere ? newFileRow : null)
            })}
            {grouped.root.map(renderScriptRow)}
            {pkg.scripts.length === 0 && !pendingType && (
              <li className="explorer-empty nested">空包</li>
            )}
          </ul>

          {ctxMenu && (
            <ul
              className="explorer-context-menu"
              style={{ left: ctxMenu.x, top: ctxMenu.y }}
              role="menu"
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
            >
              <li>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const id = ctxMenu.scriptId
                    setCtxMenu(null)
                    onGeneratePlaceholderVoice(id)
                  }}
                >
                  生成空白 ogg
                </button>
              </li>
            </ul>
          )}

          <AssetFolderBlock
            pkgId={pkg.id}
            dir={tree}
            depth={0}
            rootCollapsed={pkg.assetsCollapsed}
            activeAssetId={activeAssetId}
            isDirCollapsed={isDirCollapsed}
            onToggleRoot={() => onToggleAssets(pkg.id)}
            onToggleDir={toggleDir}
            onOpenAsset={onOpenAsset}
            onDeleteAsset={onDeleteAsset}
            onNewAssetFolder={onNewAssetFolder}
            onDeleteAssetFolder={onDeleteAssetFolder}
            onImportAssets={onImportAssets}
            onDropIntoFolder={onDropIntoFolder}
          />
        </>
      )}

      {/*
       * 折叠着也要让命名行看得见：菜单是从包行的 `+` 打开的，选完类型却什么都没出现
       * 会让人以为按钮坏了。这里只画命名行所在的那个分组头，不展开整棵树 ——
       * 展开时走的是上面那份 `groupsToRender`，两处共用 `renderKindGroup`，
       * 所以不存在"展开路径修好了、折叠路径没修"这种分叉。
       */}
      {pkg.collapsed && pendingKind && (
        <ul className="explorer-files">
          {renderKindGroup(pendingKind, [], newFileRow)}
        </ul>
      )}
    </div>
  )
}

function AssetFolderBlock({
  pkgId,
  dir,
  depth,
  rootCollapsed,
  activeAssetId,
  isDirCollapsed,
  onToggleRoot,
  onToggleDir,
  onOpenAsset,
  onDeleteAsset,
  onNewAssetFolder,
  onDeleteAssetFolder,
  onImportAssets,
  onDropIntoFolder,
}: {
  pkgId: string
  dir: AssetTreeDir
  depth: number
  rootCollapsed: boolean
  activeAssetId: string | null
  isDirCollapsed: (path: string) => boolean
  onToggleRoot: () => void
  onToggleDir: (path: string) => void
  onOpenAsset: (assetId: string) => void
  onDeleteAsset: (assetId: string) => void
  onNewAssetFolder: (packageId: string, parentPath: string) => void
  onDeleteAssetFolder: (packageId: string, folderPath: string) => void
  onImportAssets: (
    packageId: string,
    files: FileList | File[],
    targetDir?: string,
  ) => void
  onDropIntoFolder: (
    targetPackageId: string,
    targetDir: string,
    source: DragSource,
  ) => void
}) {
  const isRoot = dir.path === 'assets'
  const collapsed = isRoot ? rootCollapsed : isDirCollapsed(dir.path)
  // 目录行就是"拖到哪个文件夹"的判定框：外部文件导入、内部载荷移动
  const dirDrop = useFolderDropTarget({
    onFiles: (files) => onImportAssets(pkgId, files, dir.path),
    onPayload: (source) => onDropIntoFolder(pkgId, dir.path, source),
  })

  return (
    <div
      className={`explorer-assets${dirDrop.active ? ' is-drop-target' : ''}`}
      style={{ paddingLeft: depth === 0 ? undefined : 8 }}
      {...dirDrop.handlers}
    >
      <div
        className={`explorer-row explorer-assets-row${
          isRoot ? '' : ' explorer-subdir-row'
        }`}
      >
        <button
          type="button"
          className="explorer-twist"
          onClick={() => (isRoot ? onToggleRoot() : onToggleDir(dir.path))}
          aria-label={collapsed ? '展开' : '折叠'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <button
          type="button"
          className="explorer-label"
          onClick={() => (isRoot ? onToggleRoot() : onToggleDir(dir.path))}
          title={`${dir.path} — 拖入文件到此文件夹`}
        >
          <ExplorerIcon kind="folder" />
          <span className="explorer-name">{dir.name}</span>
          {isRoot && (
            <span className="explorer-count">
              {countFiles(dir)}
            </span>
          )}
        </button>
        <div className="explorer-row-actions">
          <button
            type="button"
            title="新建子文件夹"
            onClick={() => onNewAssetFolder(pkgId, dir.path)}
          >
            +夹
          </button>
          <label className="explorer-upload" title="导入到此文件夹">
            ↑
            <input
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) {
                  onImportAssets(pkgId, e.target.files, dir.path)
                  e.target.value = ''
                }
              }}
            />
          </label>
          {!isRoot && (
            <button
              type="button"
              title="删除文件夹"
              onClick={() => onDeleteAssetFolder(pkgId, dir.path)}
            >
              ×
            </button>
          )}
        </div>
      </div>

      {!collapsed && (
        <ul className="explorer-files explorer-asset-files">
          {dir.children.map((node) =>
            node.kind === 'dir' ? (
              <li key={`dir:${node.path}`}>
                <AssetFolderBlock
                  pkgId={pkgId}
                  dir={node}
                  depth={depth + 1}
                  rootCollapsed={false}
                  activeAssetId={activeAssetId}
                  isDirCollapsed={isDirCollapsed}
                  onToggleRoot={onToggleRoot}
                  onToggleDir={onToggleDir}
                  onOpenAsset={onOpenAsset}
                  onDeleteAsset={onDeleteAsset}
                  onNewAssetFolder={onNewAssetFolder}
                  onDeleteAssetFolder={onDeleteAssetFolder}
                  onImportAssets={onImportAssets}
                  onDropIntoFolder={onDropIntoFolder}
                />
              </li>
            ) : (
              <AssetRow
                key={node.asset.id}
                packageId={pkgId}
                asset={node.asset as AssetFile}
                active={node.asset.id === activeAssetId}
                onOpen={() => onOpenAsset(node.asset.id)}
                onDelete={() => onDeleteAsset(node.asset.id)}
              />
            ),
          )}
          {dir.children.length === 0 && (
            <li className="explorer-empty nested">空文件夹 · 拖入或 +夹</li>
          )}
        </ul>
      )}
    </div>
  )
}

function countFiles(node: AssetTreeNode): number {
  if (node.kind === 'file') return 1
  return node.children.reduce((n, c) => n + countFiles(c), 0)
}

function AssetRow({
  packageId,
  asset,
  active,
  onOpen,
  onDelete,
}: {
  packageId: string
  asset: AssetFile
  active: boolean
  onOpen: () => void
  onDelete: () => void
}) {
  return (
    <li>
      <div
        className={`explorer-row explorer-file-row explorer-asset-row${
          active ? ' active' : ''
        }`}
        draggable
        onDragStart={(e) => {
          writeDragPayload(e.dataTransfer, {
            kind: 'asset',
            packageId,
            assetId: asset.id,
            path: asset.path,
          })
        }}
        onDragEnd={() => endDrag()}
      >
        <button
          type="button"
          className="explorer-label"
          onClick={onOpen}
          title={asset.path}
        >
          <ExplorerIcon kind={fileIconKind(asset.path)} />
          <span className="explorer-name">{assetFileName(asset.path)}</span>
        </button>
        <div className="explorer-row-actions">
          <button type="button" title="删除资产" onClick={onDelete}>
            ×
          </button>
        </div>
      </div>
    </li>
  )
}
