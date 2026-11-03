import { useState, type DragEvent } from "react";
import {
  currentDrag,
  droppedFiles,
  endDrag,
  hasExternalFiles,
  readDragPayload,
  resolveDropIntent,
  shouldAcceptDrop,
  type DragSource,
} from "./dragPayload";

/**
 * 目录行的投放接线（工程行 / assets 目录行共用）：
 * - 外部文件 → 等价于复制粘贴导入
 * - 内部的脚本 / 资产 → 等价于剪切移动
 *
 * 高亮只给**判定得出意图**的那种拖拽；但**准放**（`preventDefault`）不能只给它们 ——
 * 见下面 `onDragOver` 里的说明：拿 `types` 判"有没有文件"在 WebView2 上会漏，
 * 漏了就是不 preventDefault、浏览器不允许投放、`drop` 永远不来。
 */
export function useFolderDropTarget(options: {
  onFiles(files: File[]): void;
  onPayload(source: DragSource): void;
}) {
  const [active, setActive] = useState(false);
  const resolve = (event: DragEvent) =>
    resolveDropIntent({
      target: "explorer-folder",
      source: currentDrag(),
      hasFiles: hasExternalFiles(event.dataTransfer),
    });

  return {
    active,
    handlers: {
      onDragOver: (event: DragEvent) => {
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
      onDragLeave: (event: DragEvent) => {
        const next = event.relatedTarget as Node | null;
        if (!next || !event.currentTarget.contains(next)) setActive(false);
      },
      onDrop: (event: DragEvent) => {
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
