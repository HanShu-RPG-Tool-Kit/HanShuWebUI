/**
 * 拖拽载荷协议（内部拖拽）+ 投放意图解析。
 *
 * 为什么需要内存态：`dragover` 阶段（用来决定"要不要高亮、能不能放"）
 * 读不到 `dataTransfer.getData`，只有 `drop` 时才给。所以拖拽开始时除了写
 * `dataTransfer`，还在内存里记一份"当前正在拖什么"。
 *
 * 三类**拖拽源**：
 * - 外部文件（不走本协议，走 `dataTransfer.files`）
 * - 资源管理器里的脚本 / 资产
 * - 编辑器里的**键名**（`.hs-lang-unit`）
 *
 * 三类**投放目标**与语义（见 `resolveDropIntent`）：
 * - 资源管理器目录：外部文件 = 复制粘贴导入；内部脚本/资产 = 剪切移动
 * - 键名：外部文件 / 资产 = 尝试导入音频；另一个键名 = 替换键名
 * - 编辑器文本：**只接受键名**，且只插入键名文本（不成键）
 *
 * 关于文本区：插入出来的是一个"光键名"（没有映射条目），这点是有意为之 ——
 * 它就是个纯粹的"把键名搬到别处"的手写便利，成键与否交给正常的编辑流程。
 * 另外无论是否接受，文本区都要吃掉 dragover/drop 的默认行为，否则把文件拖进来时
 * 浏览器会直接导航到该文件、整个应用状态丢失。
 */

/** 内部拖拽用的 MIME */
export const HANSHU_DRAG_MIME = 'application/x-hanshu-drag'

export type DragSource =
  | {
      kind: 'key'
      /** 键名（8 位十六进制） */
      key: string
    }
  | {
      kind: 'asset'
      packageId: string
      assetId: string
      path: string
    }
  | {
      kind: 'script'
      packageId: string
      scriptId: string
      name: string
    }

/** 当前正在拖的内部载荷（dragover 阶段只能从这里读） */
let activeDrag: DragSource | null = null

export function beginDrag(source: DragSource): void {
  activeDrag = source
}

export function endDrag(): void {
  activeDrag = null
}

export function currentDrag(): DragSource | null {
  return activeDrag
}

/** 拖拽源开始拖时调用：写 dataTransfer + 记内存态 */
export function writeDragPayload(
  dataTransfer: DataTransfer | null,
  source: DragSource,
): void {
  beginDrag(source)
  try {
    dataTransfer?.setData(HANSHU_DRAG_MIME, JSON.stringify(source))
    // 给浏览器/其它区域一个可读的文本表示（拖到外部程序时至少是键名/路径）
    dataTransfer?.setData('text/plain', dragSourceLabel(source))
  } catch {
    // 某些环境禁止在 dragstart 之外写 dataTransfer：内存态足够本应用内部使用
  }
  if (dataTransfer) dataTransfer.effectAllowed = 'copyMove'
}

/** 投放时读载荷：优先 dataTransfer，退回内存态 */
export function readDragPayload(
  dataTransfer: DataTransfer | null,
): DragSource | null {
  const raw = dataTransfer?.getData(HANSHU_DRAG_MIME)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as DragSource
      if (isDragSource(parsed)) return parsed
    } catch {
      /* 落到内存态 */
    }
  }
  return activeDrag
}

/**
 * 拖拽源是否携带外部文件（从系统拖进来的）。
 *
 * `dragover` 阶段 `dataTransfer.files` **往往是空的**（规范只保证 drop 时有），
 * 所以必须同时看 `types` 里的 'Files' —— 少了这一步，dragover 就不会 preventDefault，
 * 浏览器不允许投放，drop 永远不来。
 */
export function hasExternalFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  if (dataTransfer.files && dataTransfer.files.length > 0) return true
  return Array.from(dataTransfer.types ?? []).some(
    (type) => type.toLowerCase() === 'files',
  )
}

/** 拖拽源的文字表示（dataTransfer 的 text/plain；也用于提示） */
export function dragSourceLabel(source: DragSource): string {
  if (source.kind === 'key') return source.key
  if (source.kind === 'asset') return source.path
  return source.name
}

function isDragSource(value: unknown): value is DragSource {
  if (!value || typeof value !== 'object') return false
  const kind = (value as { kind?: unknown }).kind
  if (kind === 'key') return typeof (value as DragSource & { key: unknown }).key === 'string'
  if (kind === 'asset') {
    return typeof (value as { path?: unknown }).path === 'string'
  }
  if (kind === 'script') {
    return typeof (value as { scriptId?: unknown }).scriptId === 'string'
  }
  return false
}

/** 投放目标类型 */
export type DropTargetKind = 'explorer-folder' | 'key' | 'text'

/** 键名拖拽源（投放动作里需要它的具体形状） */
export type KeyDragSource = Extract<DragSource, { kind: 'key' }>

/** 解析出来的投放动作（null = 不支持，界面不高亮、也不 preventDefault） */
export type DropIntent =
  | { action: 'import-files' }
  | { action: 'move-into-folder'; source: DragSource }
  | { action: 'import-audio-file' }
  | { action: 'import-audio-asset'; source: DragSource }
  | { action: 'replace-key'; source: KeyDragSource }
  | { action: 'insert-key'; source: KeyDragSource }

/**
 * 语义表（需求逐条对应）：
 * | 拖拽源 \ 目标 | 资源管理器目录 | 键名 | 文本 |
 * |---|---|---|---|
 * | 外部文件 | 复制粘贴导入 | 尝试导入音频 | — |
 * | 资产 | 剪切移动 | 尝试导入音频 | — |
 * | 脚本 | 剪切移动 | — | — |
 * | 键名 | — | 替换键名 | 插入键名文本 |
 *
 * 键名只认「键名」和「文本」两个落点：落到资源管理器目录没有意义，不接受。
 */
export function resolveDropIntent(options: {
  target: DropTargetKind
  source: DragSource | null
  hasFiles: boolean
}): DropIntent | null {
  const { target, source, hasFiles } = options

  if (target === 'explorer-folder') {
    if (hasFiles) return { action: 'import-files' }
    if (source && (source.kind === 'asset' || source.kind === 'script')) {
      return { action: 'move-into-folder', source }
    }
    return null
  }

  if (target === 'key') {
    if (hasFiles) return { action: 'import-audio-file' }
    if (source?.kind === 'asset') {
      return { action: 'import-audio-asset', source }
    }
    if (source?.kind === 'key') return { action: 'replace-key', source }
    return null
  }

  // 文本：只接受键名，且只插文本（不成键）。
  // 有文件时一律不接受 —— 外部文件拖拽必须优先于内存里可能残留的内部拖拽载荷
  // （上一次拖拽若没收到 dragend，内存态会留着），否则会被误判成"键名拖到文本"。
  if (hasFiles) return null
  if (source?.kind === 'key') return { action: 'insert-key', source }
  return null
}
