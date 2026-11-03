import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ExplorerIcon } from "../../explorerIcons";
import {
  newFileTypesByGroup,
  stageplayNewFileTypesByGroup,
  type NewFileType,
} from "../../newFileTypes";
import { shouldHoldWheel } from "../../newFileMenuWheel";
import "../../explorer-newfile.css";

export type MenuAnchorBox = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

/**
 * 新建文件类型选择器（`+剧`、分类右键「新建创作资料…」、应用菜单「新建剧本」）。
 *
 * 没复用 `NodeContextMenu`：选类型要靠分组、图标、后缀与每项一句说明，那是单层文字菜单给不了的。
 * `types` 省略时列出全部剧本类型；分类入口只传该分类可建的类型。
 */
export function NewFileTypeMenu({
  x,
  y,
  place = "below",
  anchorBox = null,
  types,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  /** `beside` 与触发按钮并排；`below` 从锚点下方展开。 */
  place?: "below" | "beside";
  anchorBox?: MenuAnchorBox | null;
  types?: readonly NewFileType[];
  onPick: (type: NewFileType) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLUListElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState({ x, y });
  const groups = useMemo(
    () => (types ? newFileTypesByGroup(types) : stageplayNewFileTypesByGroup()),
    [types],
  );
  /*
   * 展平后的可选项：分组标题不参与上下键，所以键盘走的是这一份。
   * 每一项在 `items` 里的下标就是它的序号 —— 渲染时用 `indexOf` 现算。
   */
  const items = useMemo(() => groups.flatMap((entry) => entry.items), [groups]);

  // 「+剧」并排：顶边对齐按钮，右侧放得下就贴在右边，否则翻到左边。其余入口从锚点下方展开。
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
      x: Math.max(margin, Math.min(nextX, window.innerWidth - rect.width - margin)),
      y: Math.max(margin, Math.min(nextY, window.innerHeight - rect.height - margin)),
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
       * 触发器（`+剧`）自己的点击留给它处理：这里先关掉的话，
       * 紧接着的 click 会把它又打开一次 —— 表现为"点一下没反应"。
       */
      if (target.closest("[data-newfile-trigger]")) return;
      onClose();
    };
    /*
     * 菜单自己的滚动**不该**把菜单关掉：`scroll` 在捕获阶段照样会经过 window，
     * 而菜单自己就是滚动容器（见 .explorer-newfile-menu 的 max-height）。
     */
    const onScroll = (event: Event) => {
      const el = ref.current;
      if (el && event.target instanceof Node && el.contains(event.target)) return;
      onClose();
    };
    /*
     * 滚轮要被菜单自己吃掉，不能穿透去滚背后的资源树（树一滚，上面那条监听就把菜单关掉）。
     * 用原生监听而不是 React 的 onWheel：React 在根节点上把 wheel 注册成 passive，preventDefault 不生效。
     */
    const el = ref.current;
    const onWheel = (event: WheelEvent) => {
      if (!el) return;
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
      {groups.map(({ group, items: groupItems }) => (
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
                    className={`explorer-newfile-item${itemIndex === active ? " is-active" : ""}`}
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

export type ExplorerContextItem = {
  id: string;
  label: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  onSelect: () => void;
};

/**
 * `assets/` 附加件与工程行的右键菜单。分类树本身用壳的 `NodeContextMenu`。
 * 挂到 document.body，避开栏目的 overflow 裁切。
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
      if (el && event.target instanceof Node && el.contains(event.target)) return;
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
          {item.separatorBefore && <div className="explorer-context-sep" role="separator" />}
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
