import { SCRIPT_TYPE_NAMES, scriptType } from "./scriptResources/types";
import { sourcePathOf, sourceRelativePath } from "./workspace";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import type { AssetFile, ScriptPackage, Workspace } from "./workspace";
import { isVoiceMapFile } from "./workspace";
import {
  packageLocationLabel,
  packageLocationTitle,
} from "./project/projectLabel";
import { openProjectUi } from "./project/projectUi";
import { chooseDialog } from "./ui/dialogs";
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
} from "./drag/dragPayload";
import {
  assetFileName,
  buildAssetTree,
  type AssetTreeDir,
  type AssetTreeNode,
} from "./assets/paths";
import { ExplorerIcon, fileIconKind, sourceIconKind } from "./explorerIcons";
import {
  findNewFileType,
  NEW_FILE_TYPES,
  newFileName,
  newFileTypesByGroup,
  validateNewFileBase,
  type NewFileCreateResult,
  type NewFileType,
  type NewFileTypeId,
} from "./newFileTypes";
import {
  createdNameOnDismiss,
  useImmediateCreateWheel,
} from "./immediateCreateWheel";
import { shouldHoldWheel } from "./newFileMenuWheel";
import {
  WORKSPACE_GROUP_ORDER,
  groupDirPrefix,
  isManualFileName,
  sourceKindOf,
} from "./workspace";
import "./explorer-newfile.css";

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
  onFiles(files: File[]): void;
  onPayload(source: DragSource): void;
}) {
  const [active, setActive] = useState(false);
  const resolve = (event: React.DragEvent) =>
    resolveDropIntent({
      target: "explorer-folder",
      source: currentDrag(),
      hasFiles: hasExternalFiles(event.dataTransfer),
    });

  return {
    active,
    handlers: {
      onDragOver: (event: React.DragEvent) => {
        const intent = resolve(event);
        if (!intent) {
          setActive(false);
          /*
           * 判定不出意图也要**吃掉默认行为**：准放判据只有一条 —— 不是本应用自己的
           * 内部拖拽就一律接下（见 `shouldAcceptDrop`）。拿 `types` 判"有没有文件"在
           * WebView2 上会漏，漏了就是不 preventDefault、浏览器不允许投放、drop 不来。
           */
          if (shouldAcceptDrop(event.dataTransfer)) event.preventDefault();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect =
            intent.action === "move-into-folder" ? "move" : "copy";
        }
        setActive(true);
      },
      onDragLeave: (event: React.DragEvent) => {
        const next = event.relatedTarget as Node | null;
        if (!next || !event.currentTarget.contains(next)) setActive(false);
      },
      onDrop: (event: React.DragEvent) => {
        const files = droppedFiles(event.dataTransfer);
        // 判定用**实际拿到的文件**兜底：意图表里的 hasFiles 只是 dragover 的猜测
        const intent =
          resolve(event) ??
          (files.length > 0 && !currentDrag()
            ? ({ action: "import-files" } as const)
            : null);
        setActive(false);
        if (!intent) return;
        event.preventDefault();
        event.stopPropagation();
        const source = readDragPayload(event.dataTransfer);
        endDrag();
        if (intent.action === "import-files") {
          options.onFiles(files);
          return;
        }
        if (intent.action === "move-into-folder" && source) {
          options.onPayload(source);
        }
      },
    },
  };
}

/** 刚创建、正在就地改名的文件。一次只允许一个：同一时刻该只有一行输入框 */
type CreatedRename = {
  scriptId: string;
  packageId: string;
  typeId: NewFileTypeId;
  base: string;
  /** 创建时落下的基名。没改过、空名或非法名时就留这个，不删文件 */
  committedBase: string;
  /** 行内错误（重名 / 非法名）；空串 = 还没提交过 */
  error: string;
};

/**
 * 「新建文件」在资源树里的全部接线。
 *
 * 状态统一放在 `Explorer` 上而不是各包自己存：下拉菜单是**整棵树只有一个**的浮层，
 * 而同一时刻也只该有一行改名输入框 —— 分到 `PackageNode` 里就得处理"两个包各开一个"。
 * 选类型即创建；输入框只改已经存在的文件名。
 */
type NewFileWiring = {
  /** 属于**这个包**的改名行；别的包开着时这里是 null */
  created: CreatedRename | null;
  /** 创建失败时画在这个包上的原因；没有则为空串 */
  createError: string;
  /**
   * 触发器被点：同一个锚点再点一次收起，否则把菜单挪到这个锚点上（见 `toggleMenu`）。
   * 包行的 `+` 与头部的 `+剧` 走同一条，两处行为不会两样。
   */
  toggleMenu: (packageId: string, anchor: HTMLElement | null) => void;
  /** 右键「新建某某」或选中类型：立即创建，并在真实文件行上改名 */
  createFile: (packageId: string, typeId: NewFileTypeId) => void;
  /** 右键「新建文件…」：在点击处打开类型选择器 */
  openTypeMenu: (packageId: string, x: number, y: number) => void;
  changeBase: (base: string) => void;
  submitRename: () => void;
  /** Esc：放弃正在输入的名字，保留创建名，并跳过随后的 blur */
  cancelRename: () => void;
  /** 点空白 / 失焦：按规则收下，不删除文件。epoch 是这一行挂上时抓到的代号 */
  dismissRename: (epoch: number) => void;
  /** 输入框挂上时抓当前 epoch。不要把 epoch 放进 state，否则旧行会带着新代号重渲染 */
  armRename: () => number;
};

type ExplorerProps = {
  workspace: Workspace;
  activeScriptId: string | null;
  activeAssetId: string | null;
  /** 绑定到本地工程文件夹的那个包 id（null = 没有绑定工程） */
  boundPackageId: string | null;
  /** 该工程的本地位置（浏览器 API 只给得到文件夹名） */
  boundFolderName: string | null;
  onOpenScript: (scriptId: string) => void;
  onOpenAsset: (assetId: string) => void;
  onTogglePackage: (packageId: string) => void;
  onToggleAssets: (packageId: string) => void;
  onNewPackage: () => void;
  /**
   * 选类型后立即创建（取代旧的「先填名、回车才建」）。
   *
   * 省略 `base` 时由工作区分配唯一默认名并立刻创建。失败返回原因，资源树就地显示，不弹窗。
   * 校验与创建都在剧本工作区那一侧：只有它同时握着工作区快照与创建管线。
   */
  onNewFile: (
    packageId: string,
    typeId: NewFileTypeId,
    base?: string,
  ) => NewFileCreateResult;
  /**
   * 就地改名提交。未落盘的新文件只改工作区；已有旧路径才走既有改名管线。
   * 失败返回原因，输入框留着，不删除文件。
   */
  onCommitCreatedName: (
    scriptId: string,
    base: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * 应用菜单「新建剧本」的等价入口：**值变化**即请求打开类型选择器（0 = 从未请求）。
   *
   * 用计数器而不是布尔量：菜单项连点两次时布尔量第二次不产生变化，菜单就不会重开。
   * 目标包与「+剧」同一套判定（见 `activePackageId`），锚点就是那个按钮。
   */
  newFileMenuRequest?: number;
  onRenamePackage: (packageId: string) => void;
  onRenameScript: (scriptId: string) => void;
  onDeletePackage: (packageId: string) => void;
  onDeleteScript: (scriptId: string) => void;
  onDeleteAsset: (assetId: string) => void;
  onNewAssetFolder: (packageId: string, parentPath: string) => void;
  onDeleteAssetFolder: (packageId: string, folderPath: string) => void;
  onImportAssets: (
    packageId: string,
    files: FileList | File[],
    targetDir?: string,
  ) => void;
  onGeneratePlaceholderVoice: (scriptId: string) => void;
  /** 内部拖拽落到目录行：把载荷里的脚本 / 资产移动到该包该目录 */
  onDropIntoFolder: (
    targetPackageId: string,
    targetDir: string,
    source: DragSource,
  ) => void;
  /** 停靠位置。浮动时标题可以再拖回边缘。 */
  placement?: "left" | "right" | "top" | "bottom" | "float";
  /** 拖标题栏。按钮和输入框上的按下不会进来。 */
  onTitlePointerDown?: (event: ReactPointerEvent<HTMLElement>) => void;
  /** 仅浮动时提供，停回上次的边缘。 */
  onRedock?: () => void;
};

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
  onCommitCreatedName,
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
  placement = "left",
  onTitlePointerDown,
  onRedock,
}: ExplorerProps) {
  const [menu, setMenu] = useState<{
    packageId: string;
    x: number;
    y: number;
    /**
     * 打开菜单的那个按钮。用来判"再点一次是不是同一个触发器" ——
     * 树里（含 `+剧` 与每个包行的 `+`）有好几个触发器，只看"菜单开着没有"的话，
     * 点 B 包的 `+` 会被当成"收起 A 包的菜单"，那一下就没反应。
     */
    anchor: HTMLElement | null;
    /** `beside`：和「+剧」并排、顶边对齐。`below`：包行 `+` / 右键，从锚点下方展开。 */
    place: "below" | "beside";
    anchorBox: {
      left: number;
      top: number;
      right: number;
      bottom: number;
    } | null;
  } | null>(null);
  const createWheel = useImmediateCreateWheel<
    CreatedRename,
    { packageId: string; typeId: NewFileTypeId }
  >();
  const created = createWheel.session;
  const [createError, setCreateError] = useState<{
    packageId: string;
    error: string;
  } | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    items: ExplorerContextItem[];
  } | null>(null);
  const headerButtonRef = useRef<HTMLButtonElement>(null);
  /** 已处理过的请求号。挂载时那一次（0）不算请求，否则一进工作区菜单就自己弹出来 */
  const handledRequestRef = useRef(newFileMenuRequest);

  /** 「+剧」/ 文件菜单的目标包：当前活动文件所在的包，没有就第一个 */
  const activePackageId = (): string | null => {
    const target =
      workspace.packages.find(
        (pkg) =>
          pkg.scripts.some((s) => s.id === activeScriptId) ||
          pkg.assets.some((a) => a.id === activeAssetId),
      ) ?? workspace.packages[0];
    return target?.id ?? null;
  };

  const promptingProjectRef = useRef(false);
  /** 没有工程时不能新建文件：提示去创建或导入，而不是把点击吃掉。 */
  const promptCreateOrImport = () => {
    if (promptingProjectRef.current) return;
    promptingProjectRef.current = true;
    void chooseDialog({
      title: "提示",
      message: "工程为空，请先创建或导入工程。",
      cancelLabel: "取消",
      options: [
        { id: "create", label: "创建工程" },
        { id: "import", label: "导入工程" },
      ],
    })
      .then((choice) => {
        if (choice === "create") openProjectUi("create");
        else if (choice === "import") openProjectUi("open");
      })
      .finally(() => {
        promptingProjectRef.current = false;
      });
  };

  /**
   * 打开类型选择器。坐标用视口坐标：菜单会挂到 `document.body`，盖过相邻栏目。
   * 挂在资源管理器里会被栏目的 `overflow` 裁掉，即使写了 `position: fixed`。
   */
  const openMenu = (
    packageId: string,
    anchor: HTMLElement | null,
    place: "below" | "beside" = "below",
  ) => {
    const rect = anchor?.getBoundingClientRect();
    const gap = 4;
    setMenu({
      packageId,
      // 「+剧」从按钮右侧并排打开，顶边与按钮对齐；其余入口仍从锚点下方展开。
      x: rect ? (place === "beside" ? rect.right + gap : rect.left) : 8,
      y: rect ? (place === "beside" ? rect.top : rect.bottom + 2) : 8,
      anchor,
      place,
      anchorBox: rect
        ? {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
          }
        : null,
    });
  };

  /**
   * 触发器被点：同一个锚点 = 收起，别的锚点 = 把菜单挪过去。
   *
   * 菜单自己的"点外部关闭"会跳过 `[data-newfile-trigger]`（见 NewFileTypeMenu），
   * 所以开关只能由触发器自己管 —— 两边都管就会各关一次又各开一次，表现为"点一下没反应"。
   */
  const toggleMenu = (
    packageId: string,
    anchor: HTMLElement | null,
    place: "below" | "beside" = "below",
  ) => {
    if (menu && menu.anchor === anchor) {
      setMenu(null);
      return;
    }
    setContextMenu(null);
    openMenu(packageId, anchor, place);
  };

  const showContext = (
    event: React.MouseEvent,
    items: ExplorerContextItem[],
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu(null);
    setContextMenu({ x: event.clientX, y: event.clientY, items });
  };

  const updateCreated = createWheel.updateSession;

  /**
   * 点空白 / 再新建之前，把正在改的名字收尾。
   * 不在队列里再入队：调用方已经在同一条队列上，再入队会死锁。
   */
  const finishRename = async () => {
    const current = createWheel.sessionRef.current;
    if (!current) return;
    const type = findNewFileType(current.typeId);
    const invalid = !type || Boolean(validateNewFileBase(type, current.base));
    if (
      createdNameOnDismiss(current.base, current.committedBase, invalid) ===
      "keep"
    ) {
      updateCreated(null);
      return;
    }
    const result = await onCommitCreatedName(current.scriptId, current.base);
    if (createWheel.sessionRef.current?.scriptId !== current.scriptId) return;
    // 失焦收尾失败也不删文件：回到创建名，原因画在包上，后面的新建还能继续
    if (!result.ok)
      setCreateError({ packageId: current.packageId, error: result.error });
    updateCreated(null);
  };

  /**
   * 已经在队列里。先收掉上一行，再立刻创建。
   * 这里不能再 runSerial，调用方已经在同一条队列上。
   */
  const createFileNow = async (packageId: string, typeId: NewFileTypeId) => {
    await finishRename();
    if (createWheel.sessionRef.current) return;
    const result = onNewFile(packageId, typeId);
    if (!result.ok) {
      setCreateError({ packageId, error: result.error });
      return;
    }
    setCreateError(null);
    createWheel.lastRef.current = { packageId, typeId };
    updateCreated({
      scriptId: result.scriptId,
      packageId,
      typeId,
      base: result.base,
      committedBase: result.base,
      error: "",
    });
  };

  const createFile = (packageId: string, typeId: NewFileTypeId) => {
    setMenu(null);
    setContextMenu(null);
    createWheel.beginReplace();
    void createWheel.run(() => createFileNow(packageId, typeId));
  };

  const openTypeMenuAt = (packageId: string, x: number, y: number) => {
    setContextMenu(null);
    setMenu({ packageId, x, y, anchor: null, place: "below", anchorBox: null });
  };

  useEffect(() => {
    // 请求号没变 = 不是新的一次请求。工作区变化也会走到这里，那不该弹菜单
    if (newFileMenuRequest === handledRequestRef.current) return;
    handledRequestRef.current = newFileMenuRequest;
    const packageId = activePackageId();
    // 这一下 setState 是"响应外部请求"（应用菜单），不是从 props 派生渲染值 ——
    // 与 `FlowExplorer` 里那几处同一性质，所以同样按既定写法放行
    // eslint-disable-next-line react/set-state-in-effect
    if (packageId) openMenu(packageId, headerButtonRef.current, "beside");
    else promptCreateOrImport();
    // 目标包只在这一刻取一次：之后活动文件变了也不该把已经打开的菜单挪走
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newFileMenuRequest]);

  const changeBase = (base: string) => {
    const current = createWheel.sessionRef.current;
    if (!current) return;
    updateCreated({ ...current, base, error: "" });
  };

  const submitRename = () => {
    createWheel.mark("submit");
    void createWheel.run(async () => {
      const current = createWheel.sessionRef.current;
      if (!current) return;
      const type = findNewFileType(current.typeId);
      const error = type
        ? validateNewFileBase(type, current.base)
        : "不认识的文件类型";
      if (error) {
        updateCreated({ ...current, error });
        return;
      }
      if (current.base.trim() === current.committedBase.trim()) {
        updateCreated(null);
        return;
      }
      const result = await onCommitCreatedName(current.scriptId, current.base);
      if (createWheel.sessionRef.current?.scriptId !== current.scriptId) return;
      if (!result.ok) {
        updateCreated({
          ...createWheel.sessionRef.current,
          error: result.error,
        });
        return;
      }
      updateCreated(null);
    });
  };

  const cancelRename = () => {
    createWheel.mark("escape");
    updateCreated(null);
  };

  const dismissRename = (epoch: number) => {
    createWheel.dismiss(epoch, finishRename);
  };

  const armRename = () => createWheel.arm();

  return (
    <aside className="explorer" aria-label="资源管理器">
      <div
        className={`explorer-header${onTitlePointerDown ? " is-draggable" : ""}`}
        onPointerDown={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest("button, input, label, a, textarea, select")
          ) {
            return;
          }
          onTitlePointerDown?.(event);
        }}
      >
        <span
          className="explorer-title"
          title={
            onTitlePointerDown
              ? placement === "float"
                ? "拖动标题可停靠到边缘；松手在中间则保持弹层"
                : "拖动标题可停靠到左、右、上、下，拖到中间变成弹层"
              : "资源管理器"
          }
        >
          资源管理器
        </span>
        <div className="explorer-actions">
          {onRedock && (
            <button type="button" title="停靠回上次的边缘" onClick={onRedock}>
              停靠
            </button>
          )}
          <button
            ref={headerButtonRef}
            type="button"
            data-newfile-trigger
            title="新建文件…（选类型后立即创建，可再改名）"
            onClick={(event) => {
              // 再点一次收起（同一个锚点）；别的触发器则把菜单挪过去。
              // 菜单的"点外部关闭"会跳过触发器（见 NewFileTypeMenu），
              // 所以开关只能由触发器自己管，否则两个处理器会各关一次又各开一次
              const packageId = activePackageId();
              if (!packageId) {
                promptCreateOrImport();
                return;
              }
              toggleMenu(packageId, event.currentTarget, "beside");
            }}
          >
            +剧
          </button>
          <button type="button" title="新建包" onClick={onNewPackage}>
            +包
          </button>
        </div>
      </div>

      <div
        className="explorer-tree"
        onContextMenu={(event) => {
          if (event.defaultPrevented) return;
          const x = event.clientX;
          const y = event.clientY;
          const packageId = activePackageId();
          showContext(event, [
            {
              id: "new-file",
              label: "新建文件…",
              disabled: !packageId,
              hint: packageId ? "选类型后立即创建，可再改名" : "请先新建包",
              onSelect: () => {
                if (packageId) openTypeMenuAt(packageId, x, y);
              },
            },
            {
              id: "new-package",
              label: "新建包",
              separatorBefore: true,
              onSelect: onNewPackage,
            },
          ]);
        }}
      >
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
              created: created?.packageId === pkg.id ? created : null,
              createError:
                createError?.packageId === pkg.id ? createError.error : "",
              toggleMenu,
              createFile,
              openTypeMenu: openTypeMenuAt,
              changeBase,
              submitRename,
              cancelRename,
              dismissRename,
              armRename,
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
            showContext={showContext}
          />
        ))}
        {workspace.packages.length === 0 && (
          <div className="explorer-empty" title="暂无资源，右键或点 +包 开始">
            暂无资源，右键或点 +包 开始
          </div>
        )}
      </div>

      {menu && (
        <NewFileTypeMenu
          x={menu.x}
          y={menu.y}
          place={menu.place}
          anchorBox={menu.anchorBox}
          onClose={() => setMenu(null)}
          onPick={(type) => {
            createFile(menu.packageId, type.id);
          }}
        />
      )}
      {contextMenu && (
        <ExplorerContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
    </aside>
  );
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
  place = "below",
  anchorBox = null,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  /** `beside` 与触发按钮并排；`below` 从锚点下方展开。 */
  place?: "below" | "beside";
  anchorBox?: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  } | null;
  onPick: (type: NewFileType) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLUListElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState({ x, y });
  /*
   * 展平后的可选项：分组标题不参与上下键，所以键盘走的是这一份。
   * 每一项在 `items` 里的下标就是它的序号 —— 渲染时用 `indexOf` 现算，
   * 不在 JSX 里累加计数器（那是对渲染期变量的改写，React 编译器会拦）。
   */
  const items = useMemo(
    () => newFileTypesByGroup().flatMap((entry) => entry.items),
    [],
  );

  // 「+剧」并排：顶边对齐按钮，右侧放得下就贴在右边，否则翻到左边。
  // 其余入口从锚点下方展开。高度约 600 时不再把整张菜单抬到视口顶上。
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    const gap = 4;
    let nextX = x;
    let nextY = y;
    if (place === "beside" && anchorBox) {
      const rightX = anchorBox.right + gap;
      const leftX = anchorBox.left - rect.width - gap;
      const fitsRight = rightX + rect.width <= window.innerWidth - margin;
      nextX = fitsRight || leftX < margin ? rightX : leftX;
      nextY = anchorBox.top;
    }
    setPos({
      x: Math.max(
        margin,
        Math.min(nextX, window.innerWidth - rect.width - margin),
      ),
      y: Math.max(
        margin,
        Math.min(nextY, window.innerHeight - rect.height - margin),
      ),
    });
  }, [x, y, place, anchorBox]);

  // 打开就把焦点交给当前项：键盘用户不必先 Tab 一遍，↑/↓ 才有落点
  useEffect(() => {
    itemRefs.current[active]?.focus();
  }, [active]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((index) => (index + 1) % items.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((index) => (index - 1 + items.length) % items.length);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const type = items[active];
        if (type) onPick(type);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, active, onPick, onClose]);

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        onClose();
        return;
      }
      if (ref.current?.contains(target)) return;
      /*
       * 触发器（`+剧` / 包行 `+`）自己的点击留给它处理：这里先关掉的话，
       * 紧接着的 click 会把它又打开一次 —— 表现为"点一下没反应"。
       */
      if (target.closest("[data-newfile-trigger]")) return;
      onClose();
    };
    /*
     * 菜单自己的滚动**不该**把菜单关掉。
     *
     * 上面的捕获监听是为了抓资源树那种不冒泡的容器滚动，但 `scroll` 在捕获阶段
     * 照样会经过 window —— 菜单现在自己就是滚动容器（类型多了要能滚，见
     * .explorer-newfile-menu 的 max-height），于是"滚轮一碰菜单，菜单瞬间消失"。
     */
    const onScroll = (event: Event) => {
      const el = ref.current;
      if (el && event.target instanceof Node && el.contains(event.target))
        return;
      onClose();
    };
    /*
     * 滚轮要被菜单自己吃掉，不能穿透去滚背后的资源树 —— 树一滚，上面那条监听
     * 立刻把菜单关掉（菜单是 fixed 定位，不跟锚点走，所以关掉也算合理，但用户
     * 只是想滚菜单）。菜单自己还能滚时交给浏览器原生滚（只在到边界时才拦），
     * 菜单根本不溢出时直接拦下 —— 否则滚轮会去滚树、菜单照样消失。
     *
     * 用原生监听而不是 React 的 onWheel：React 在根节点上把 wheel 注册成 passive，
     * 里面 preventDefault 不生效（还会打警告）。
     */
    const el = ref.current;
    const onWheel = (event: WheelEvent) => {
      if (!el) return;
      // 判据本身是纯算术，抽在 newFileMenuWheel 里穷举测（这里只管取数与拦）
      if (
        shouldHoldWheel({
          scrollTop: el.scrollTop,
          clientHeight: el.clientHeight,
          scrollHeight: el.scrollHeight,
          deltaY: event.deltaY,
        })
      ) {
        event.preventDefault();
      }
    };
    window.addEventListener("mousedown", onMouseDown);
    // 捕获阶段：资源树自己的滚动容器不会把事件冒泡到 window
    window.addEventListener("scroll", onScroll, true);
    el?.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("scroll", onScroll, true);
      el?.removeEventListener("wheel", onWheel);
    };
  }, [onClose]);

  const menu = (
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
              const itemIndex = items.indexOf(type);
              return (
                <li key={type.id} role="none">
                  <button
                    ref={(el) => {
                      itemRefs.current[itemIndex] = el;
                    }}
                    type="button"
                    role="menuitem"
                    className={`explorer-newfile-item${
                      itemIndex === active ? " is-active" : ""
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
              );
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
  return createPortal(menu, document.body);
}

/**
 * 刚创建的文件就地改名。文件已经建好，这一行只改名字。
 *
 * Enter 提交当前名字。Esc 放弃正在输入的名字，保留创建名，不删文件。
 * 失焦按 `createdRenameOnDismiss`：空名、非法名或没改过就保留创建名；合法且改过才提交。
 * epoch 只放 ref，不要放进 state，否则旧行会带着新代号重渲染，blur 会误伤下一行。
 */
function NewFileRow({
  type,
  base,
  error,
  onChange,
  onSubmit,
  onCancel,
  onDismiss,
  onArmed,
}: {
  type: NewFileType;
  base: string;
  error: string;
  onChange: (base: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onDismiss: (epoch: number) => void;
  onArmed: () => number;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const epochRef = useRef(0);

  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    epochRef.current = onArmed();
    input.focus();
    input.setSelectionRange(0, input.value.length);
    // 只在挂载时聚焦并全选。onArmed 每次渲染都是新函数，放进依赖会在每次按键后重新全选。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <form
        className="explorer-newfile-row"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        {/*
         * 点图标不要抢走输入框焦点，否则失焦会把这次改名收掉。
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
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onCancel();
            }
          }}
          onBlur={() => onDismiss(epochRef.current)}
        />
      </form>
      {error && (
        <div
          className="explorer-newfile-error"
          role="alert"
          onMouseDown={(event) => event.preventDefault()}
        >
          {error}
        </div>
      )}
    </>
  );
}

export type ExplorerContextItem = {
  id: string;
  label: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  onSelect: () => void;
};

function typesInDirectory(directory: string): NewFileType[] {
  return NEW_FILE_TYPES.filter((type) => {
    const path = sourceRelativePath(newFileName(type, "pending"), type.srcKind);
    const slash = path.lastIndexOf("/");
    return slash >= 0 && path.slice(0, slash) === directory;
  });
}

function typesInKind(kind: string): NewFileType[] {
  return NEW_FILE_TYPES.filter(
    (type) => sourceKindOf(newFileName(type, "pending"), type.srcKind) === kind,
  );
}

function newTypeItems(
  types: NewFileType[],
  start: (type: NewFileType) => void,
): ExplorerContextItem[] {
  if (types.length === 0) {
    return [
      {
        id: "new-none",
        label: "此位置不能新建",
        disabled: true,
        onSelect: () => {},
      },
    ];
  }
  return types.map((type) => ({
    id: `new-${type.id}`,
    label: `新建${type.label}`,
    hint: type.hint,
    onSelect: () => start(type),
  }));
}

function withAnyType(
  items: ExplorerContextItem[],
  openAll: () => void,
): ExplorerContextItem[] {
  return [
    ...items,
    {
      id: "new-any",
      label: "新建文件…",
      hint: "全部类型",
      separatorBefore: items.length > 0,
      onSelect: openAll,
    },
  ];
}

/**
 * 剧本资源树的右键菜单。
 *
 * 游戏性 / 皮肤库都是按落点给「新建、打开、展开、删除」。
 * 这里只接已有回调，不另造一套写入。菜单挂到 document.body，
 * 避开栏目的 overflow 裁切。
 */
export function ExplorerContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ExplorerContextItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLUListElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const gap = 8;
    el.style.left = `${Math.max(gap, Math.min(x, window.innerWidth - rect.width - gap))}px`;
    el.style.top = `${Math.max(gap, Math.min(y, window.innerHeight - rect.height - gap))}px`;
  }, [x, y, items]);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onContextScroll = (event: Event) => {
      const el = ref.current;
      if (el && event.target instanceof Node && el.contains(event.target))
        return;
      close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", onContextScroll, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", onContextScroll, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return createPortal(
    <ul
      ref={ref}
      className="explorer-context-menu"
      style={{ left: x, top: y }}
      role="menu"
      aria-label="资源操作"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <li key={item.id}>
          {item.separatorBefore && (
            <div className="explorer-context-sep" role="separator" />
          )}
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            title={item.hint}
            className={item.danger ? "is-danger" : undefined}
            onClick={() => {
              if (item.disabled) return;
              onClose();
              item.onSelect();
            }}
          >
            {item.label}
          </button>
        </li>
      ))}
    </ul>,
    document.body,
  );
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
  showContext,
}: {
  pkg: ScriptPackage;
  activeScriptId: string | null;
  activeAssetId: string | null;
  /** 这个工程的本地位置标签（小灰字：本地工程） */
  locationLabel: string;
  /** 标签的说明（tooltip） */
  locationTitle: string;
  newFile: NewFileWiring;
  onOpenScript: (scriptId: string) => void;
  onOpenAsset: (assetId: string) => void;
  onTogglePackage: (packageId: string) => void;
  onToggleAssets: (packageId: string) => void;
  onRenamePackage: (packageId: string) => void;
  onRenameScript: (scriptId: string) => void;
  onDeletePackage: (packageId: string) => void;
  onDeleteScript: (scriptId: string) => void;
  onDeleteAsset: (assetId: string) => void;
  onNewAssetFolder: (packageId: string, parentPath: string) => void;
  onDeleteAssetFolder: (packageId: string, folderPath: string) => void;
  onImportAssets: (
    packageId: string,
    files: FileList | File[],
    targetDir?: string,
  ) => void;
  onGeneratePlaceholderVoice: (scriptId: string) => void;
  /** 内部拖拽落到目录行 */
  onDropIntoFolder: (
    targetPackageId: string,
    targetDir: string,
    source: DragSource,
  ) => void;
  showContext: (event: React.MouseEvent, items: ExplorerContextItem[]) => void;
}) {
  const [collapsedDirs, setCollapsedDirs] = useState<Record<string, boolean>>(
    {},
  );
  const importInputRef = useRef<HTMLInputElement>(null);
  const importDirRef = useRef("assets");
  const requestImport = (dir: string) => {
    importDirRef.current = dir;
    const input = importInputRef.current;
    if (!input) return;
    input.value = "";
    input.click();
  };

  const tree = useMemo(
    () => buildAssetTree(pkg.assets, pkg.assetFolders ?? []),
    [pkg.assets, pkg.assetFolders],
  );

  const toggleDir = (path: string) => {
    setCollapsedDirs((prev) => ({ ...prev, [path]: !prev[path] }));
  };

  const isDirCollapsed = (path: string) => Boolean(collapsedDirs[path]);

  // 包行本身也是投放目标：外部文件进 `assets/`，内部脚本 / 资产移进本包
  const pkgDrop = useFolderDropTarget({
    onFiles: (files) => onImportAssets(pkg.id, files, "assets"),
    onPayload: (source) => onDropIntoFolder(pkg.id, "assets", source),
  });

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
    );
    const root: Array<(typeof pkg.scripts)[number]> = [];
    const unknownByKind = new Map<
      string,
      Array<(typeof pkg.scripts)[number]>
    >();
    for (const script of pkg.scripts) {
      const kind = sourceKindOf(script.name, script.srcKind);
      // `root` 语义不变：未归类（留在包根）的文件直接挂在包下面，不套分组头
      if (kind === "root") {
        root.push(script);
        continue;
      }
      const bucket = byKind.get(kind);
      if (bucket) {
        bucket.push(script);
        continue;
      }
      const fallback = unknownByKind.get(kind);
      if (fallback) fallback.push(script);
      else unknownByKind.set(kind, [script]);
    }
    return { byKind, root, unknownByKind };
  }, [pkg.scripts]);

  const openPackageMenu = (event: React.MouseEvent) => {
    const x = event.clientX;
    const y = event.clientY;
    showContext(event, [
      {
        id: "new-file",
        label: "新建文件…",
        hint: "选类型后立即创建，可再改名",
        onSelect: () => newFile.openTypeMenu(pkg.id, x, y),
      },
      {
        id: "import",
        label: "导入资源…",
        hint: "导入到 assets",
        onSelect: () => requestImport("assets"),
      },
      {
        id: "toggle",
        label: pkg.collapsed ? "展开" : "折叠",
        onSelect: () => onTogglePackage(pkg.id),
      },
      {
        id: "rename",
        label: "重命名",
        separatorBefore: true,
        onSelect: () => onRenamePackage(pkg.id),
      },
      {
        id: "delete",
        label: "删除",
        danger: true,
        onSelect: () => onDeletePackage(pkg.id),
      },
    ]);
  };

  const openKindMenu = (event: React.MouseEvent, kind: string) => {
    const x = event.clientX;
    const y = event.clientY;
    showContext(
      event,
      withAnyType(
        newTypeItems(typesInKind(kind), (type) =>
          newFile.createFile(pkg.id, type.id),
        ),
        () => newFile.openTypeMenu(pkg.id, x, y),
      ),
    );
  };

  const openDirectoryMenu = (event: React.MouseEvent, directory: string) => {
    const x = event.clientX;
    const y = event.clientY;
    showContext(
      event,
      withAnyType(
        newTypeItems(typesInDirectory(directory), (type) =>
          newFile.createFile(pkg.id, type.id),
        ),
        () => newFile.openTypeMenu(pkg.id, x, y),
      ),
    );
  };

  const renderScriptRow = (script: (typeof pkg.scripts)[number]) => {
    const created =
      newFile.created?.scriptId === script.id ? newFile.created : null;
    const createdType = created ? findNewFileType(created.typeId) : null;
    if (created && createdType) {
      return (
        <li key={script.id}>
          <NewFileRow
            type={createdType}
            base={created.base}
            error={created.error}
            onChange={newFile.changeBase}
            onSubmit={newFile.submitRename}
            onCancel={newFile.cancelRename}
            onDismiss={newFile.dismissRename}
            onArmed={newFile.armRename}
          />
        </li>
      );
    }
    return (
      <li key={script.id}>
        <div
          className={`explorer-row explorer-file-row${
            script.id === activeScriptId ? " active" : ""
          }`}
          draggable
          onDragStart={(e) => {
            writeDragPayload(e.dataTransfer, {
              kind: "script",
              packageId: pkg.id,
              scriptId: script.id,
              name: script.name,
            });
          }}
          onDragEnd={() => endDrag()}
          onContextMenu={(event) => {
            const manual = isManualFileName(script.name);
            const voice = isVoiceMapFile(script.name);
            showContext(event, [
              {
                id: "open",
                label: "打开",
                hint: "在编辑器中显示",
                onSelect: () => onOpenScript(script.id),
              },
              {
                id: "rename",
                label: "重命名",
                disabled: !manual,
                hint: manual
                  ? "双击也可以重命名"
                  : "语言表和配音映射跟着剧本名走，不能单独改名",
                onSelect: () => onRenameScript(script.id),
              },
              ...(voice
                ? [
                    {
                      id: "ogg",
                      label: "生成空白 ogg",
                      onSelect: () => onGeneratePlaceholderVoice(script.id),
                    },
                  ]
                : []),
              {
                id: "delete",
                label: "删除",
                danger: true,
                separatorBefore: true,
                onSelect: () => onDeleteScript(script.id),
              },
            ]);
          }}
        >
          <button
            type="button"
            className="explorer-label"
            onClick={() => onOpenScript(script.id)}
            onDoubleClick={() => onRenameScript(script.id)}
            title={`${sourcePathOf(script)}\n${isVoiceMapFile(script.name) ? "右键：打开、生成空白 ogg 或删除" : "右键：打开、重命名或删除"}`}
          >
            <ExplorerIcon kind={sourceIconKind(script)} />
            <span className="explorer-name">{assetFileName(script.name)}</span>
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
    );
  };

  /**
   * 分组头是 `src/<kind>` 目录。文件来自 `pkg.scripts`。
   * 改名行画在真实文件上，不再另插草稿行。右键可新建。
   */
  const renderKindGroup = (
    kind: string,
    items: Array<(typeof pkg.scripts)[number]>,
  ) => (
    <li
      key={`kind-${kind}`}
      className="explorer-kind"
      onContextMenu={(event) => openKindMenu(event, kind)}
    >
      <div
        className="explorer-kind-row"
        title={`${groupDirPrefix(kind)}\n右键可新建`}
      >
        <ExplorerIcon kind="group" />
        <span className="explorer-name">{groupDirPrefix(kind)}</span>
      </div>
      <ul className="explorer-files nested">
        {(() => {
          const prefix = groupDirPrefix(kind);
          const directories = [
            ...new Set(
              items.map((file) =>
                sourcePathOf(file).split("/").slice(0, -1).join("/"),
              ),
            ),
          ];
          return directories.map((directory) => {
            const children = items.filter(
              (file) =>
                sourcePathOf(file).startsWith(`${directory}/`) &&
                sourcePathOf(file).split("/").slice(0, -1).join("/") ===
                  directory,
            );
            const openHere = (event: React.MouseEvent) =>
              openDirectoryMenu(event, directory);
            if (directory === prefix) {
              return (
                <li key={directory} onContextMenu={openHere}>
                  <ul className="explorer-files">
                    {children.map(renderScriptRow)}
                  </ul>
                </li>
              );
            }
            const label =
              kind === "script"
                ? SCRIPT_TYPE_NAMES[scriptType(directory.split("/").at(-1))]
                : directory.slice(prefix.length + 1);
            return (
              <li
                key={directory}
                className="explorer-kind"
                onContextMenu={openHere}
              >
                <div
                  className="explorer-kind-row"
                  title={`${directory}\n右键可新建`}
                >
                  <ExplorerIcon kind="group" />
                  <span className="explorer-name">{label}</span>
                </div>
                <ul className="explorer-files nested">
                  {children.map(renderScriptRow)}
                </ul>
              </li>
            );
          });
        })()}
      </ul>
    </li>
  );

  const groupsToRender = useMemo(() => {
    const order: string[] = [...WORKSPACE_GROUP_ORDER];
    for (const kind of grouped.unknownByKind.keys()) {
      if (!order.includes(kind)) order.push(kind);
    }
    return order.map((kind) => ({
      kind,
      items: grouped.byKind.get(kind) ?? grouped.unknownByKind.get(kind) ?? [],
    }));
  }, [grouped]);

  return (
    <div
      className={`explorer-pkg${pkgDrop.active ? " is-drop-target" : ""}`}
      {...pkgDrop.handlers}
      onContextMenu={openPackageMenu}
    >
      <div
        className="explorer-row explorer-pkg-row"
        onContextMenu={openPackageMenu}
      >
        <button
          type="button"
          className="explorer-twist"
          onClick={() => onTogglePackage(pkg.id)}
          aria-label={pkg.collapsed ? "展开" : "折叠"}
        >
          {pkg.collapsed ? "▸" : "▾"}
        </button>
        <button
          type="button"
          className="explorer-label"
          onClick={() => onTogglePackage(pkg.id)}
          onDoubleClick={() => onRenamePackage(pkg.id)}
          title={`${pkg.name} · 双击重命名；可拖入文件到包内 assets/`}
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
            title="在此包新建文件…（选类型后立即创建，可再改名）"
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
      {newFile.createError && (
        <div className="explorer-newfile-error" role="alert">
          {newFile.createError}
        </div>
      )}

      {!pkg.collapsed && (
        <>
          <ul className="explorer-files">
            {groupsToRender.map(({ kind, items }) => {
              if (items.length === 0) return null;
              return renderKindGroup(kind, items);
            })}
            {grouped.root.map(renderScriptRow)}
            {pkg.scripts.length === 0 && (
              <li className="explorer-empty nested" title="空包，右键可新建">
                空包，右键可新建
              </li>
            )}
          </ul>

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
            onRequestImport={requestImport}
            showContext={showContext}
          />
        </>
      )}

      {/*
       * 折叠着也要让改名行看得见：选完类型文件已经建好，整棵树仍折叠时
       * 只画出这一份文件，避免用户以为新建没有发生。
       */}
      {pkg.collapsed &&
        newFile.created &&
        (() => {
          const script = pkg.scripts.find(
            (item) => item.id === newFile.created?.scriptId,
          );
          if (!script) return null;
          const kind = sourceKindOf(script.name, script.srcKind);
          return (
            <ul className="explorer-files">
              {kind === "root"
                ? renderScriptRow(script)
                : renderKindGroup(kind, [script])}
            </ul>
          );
        })()}
      <input
        ref={importInputRef}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          const files = event.target.files;
          if (files?.length)
            onImportAssets(pkg.id, files, importDirRef.current);
          event.target.value = "";
        }}
      />
    </div>
  );
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
  onRequestImport,
  showContext,
}: {
  pkgId: string;
  dir: AssetTreeDir;
  depth: number;
  rootCollapsed: boolean;
  activeAssetId: string | null;
  isDirCollapsed: (path: string) => boolean;
  onToggleRoot: () => void;
  onToggleDir: (path: string) => void;
  onOpenAsset: (assetId: string) => void;
  onDeleteAsset: (assetId: string) => void;
  onNewAssetFolder: (packageId: string, parentPath: string) => void;
  onDeleteAssetFolder: (packageId: string, folderPath: string) => void;
  onImportAssets: (
    packageId: string,
    files: FileList | File[],
    targetDir?: string,
  ) => void;
  onDropIntoFolder: (
    targetPackageId: string,
    targetDir: string,
    source: DragSource,
  ) => void;
  onRequestImport: (dir: string) => void;
  showContext: (event: React.MouseEvent, items: ExplorerContextItem[]) => void;
}) {
  const isRoot = dir.path === "assets";
  const collapsed = isRoot ? rootCollapsed : isDirCollapsed(dir.path);
  // 目录行就是"拖到哪个文件夹"的判定框：外部文件导入、内部载荷移动
  const dirDrop = useFolderDropTarget({
    onFiles: (files) => onImportAssets(pkgId, files, dir.path),
    onPayload: (source) => onDropIntoFolder(pkgId, dir.path, source),
  });

  const openFolderMenu = (event: React.MouseEvent) => {
    showContext(event, [
      {
        id: "toggle",
        label: collapsed ? "展开" : "折叠",
        onSelect: () => (isRoot ? onToggleRoot() : onToggleDir(dir.path)),
      },
      {
        id: "new-folder",
        label: "新建子文件夹",
        separatorBefore: true,
        onSelect: () => onNewAssetFolder(pkgId, dir.path),
      },
      {
        id: "import",
        label: "导入到这里",
        hint: "选择文件导入到此文件夹",
        onSelect: () => onRequestImport(dir.path),
      },
      ...(isRoot
        ? []
        : [
            {
              id: "delete",
              label: "删除",
              danger: true,
              separatorBefore: true,
              onSelect: () => onDeleteAssetFolder(pkgId, dir.path),
            },
          ]),
    ]);
  };

  return (
    <div
      className={`explorer-assets${dirDrop.active ? " is-drop-target" : ""}`}
      style={{ paddingLeft: depth === 0 ? undefined : 8 }}
      {...dirDrop.handlers}
      onContextMenu={openFolderMenu}
    >
      <div
        className={`explorer-row explorer-assets-row${
          isRoot ? "" : " explorer-subdir-row"
        }`}
      >
        <button
          type="button"
          className="explorer-twist"
          onClick={() => (isRoot ? onToggleRoot() : onToggleDir(dir.path))}
          aria-label={collapsed ? "展开" : "折叠"}
        >
          {collapsed ? "▸" : "▾"}
        </button>
        <button
          type="button"
          className="explorer-label"
          onClick={() => (isRoot ? onToggleRoot() : onToggleDir(dir.path))}
          title={`${dir.path} — 右键可展开、新建、导入${isRoot ? "" : "或删除"}`}
        >
          <ExplorerIcon kind="folder" />
          <span className="explorer-name">{dir.name}</span>
          {isRoot && <span className="explorer-count">{countFiles(dir)}</span>}
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
                  onImportAssets(pkgId, e.target.files, dir.path);
                  e.target.value = "";
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
            node.kind === "dir" ? (
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
                  onRequestImport={onRequestImport}
                  showContext={showContext}
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
                showContext={showContext}
              />
            ),
          )}
          {dir.children.length === 0 && (
            <li className="explorer-empty nested" title="空文件夹，右键可新建">
              空文件夹，右键可新建
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function countFiles(node: AssetTreeNode): number {
  if (node.kind === "file") return 1;
  return node.children.reduce((n, c) => n + countFiles(c), 0);
}

function AssetRow({
  packageId,
  asset,
  active,
  onOpen,
  onDelete,
  showContext,
}: {
  packageId: string;
  asset: AssetFile;
  active: boolean;
  onOpen: () => void;
  onDelete: () => void;
  showContext: (event: React.MouseEvent, items: ExplorerContextItem[]) => void;
}) {
  return (
    <li>
      <div
        className={`explorer-row explorer-file-row explorer-asset-row${
          active ? " active" : ""
        }`}
        draggable
        onContextMenu={(event) => {
          showContext(event, [
            {
              id: "open",
              label: "打开",
              hint: "在编辑器中显示",
              onSelect: onOpen,
            },
            {
              id: "delete",
              label: "删除",
              danger: true,
              separatorBefore: true,
              onSelect: onDelete,
            },
          ]);
        }}
        onDragStart={(e) => {
          writeDragPayload(e.dataTransfer, {
            kind: "asset",
            packageId,
            assetId: asset.id,
            path: asset.path,
          });
        }}
        onDragEnd={() => endDrag()}
      >
        <button
          type="button"
          className="explorer-label"
          onClick={onOpen}
          title={`${asset.path}\n右键：打开或删除`}
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
  );
}
