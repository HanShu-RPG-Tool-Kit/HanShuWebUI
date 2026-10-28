import { getExtension } from './workspace'

/**
 * 资源树图标：一个 kind = 一条 SVG path。
 *
 * 新增文件类型时**必须**给它一个专属 kind（见 `newFileTypes.ts`）：树里 `.quest` 与
 * `.kit` 都退化成通用文件图标时，一眼看不出哪个是任务、哪个是礼包，右键点错了才发现。
 *
 * 形状与游戏性工作区（`workspaces/gameplay/FlowExplorer.tsx` 的 `Icon`）**同源**：
 * 同一个文件类型在两个资源树里长得一样，用户不必学两套。新建菜单里单/多进度
 * 都是 `.quest`，用 `progress` / `hflow` 图标区分作者态；资源树按后缀只认 `quest`。
 */

/**
 * 图标表里现有的全部 kind。
 *
 * **先有这张字面量清单，再有 `PATHS` 与 `ExplorerIconKind`** —— 单一来源：
 * 加一个 kind 只改这里一处，漏了 `PATHS` 那一条 `Record<ExplorerIconKind, string>`
 * 会当场编译不过（比"运行到那个文件才发现没图标"早得多）。
 *
 * 给 `scripts/verify-new-file-types.ts` 用：注册表每条记录都写了 `icon`，
 * 写错一个拼法在界面上只是"没图标"，没人会去点开每个类型看一遍 —— 让测试来点。
 */
export const EXPLORER_ICON_KINDS = [
  'package',
  'folder',
  'group',
  'hanshu',
  'character',
  'python',
  'goal',
  'script-kit',
  'script-shop',
  'script-item',
  'script-entity',
  'script-enchantment',
  'script-player',
  'markdown',
  'lang',
  'voice',
  'tts',
  'ttsservice',
  'progress',
  'quest',
  'hflow',
  'level',
  'nav',
  'item',
  'entity',
  'kit',
  'shop',
  'image',
  'audio',
  'json',
  'file',
] as const

export type ExplorerIconKind = (typeof EXPLORER_ICON_KINDS)[number]

const PATHS: Record<ExplorerIconKind, string> = {
  package: 'M12 2l9 5v10l-9 5-9-5V7z M3 7l9 5 9-5 M12 12v10',
  folder: 'M2 5h6l2 2h12v12H2z',
  group: 'M2 5h6l2 2h12v12H2z M6 13h12',
  hanshu: 'M4 5h7a3 3 0 013 3v12a3 3 0 00-3-3H4z M20 5h-7a3 3 0 00-3 3v12a3 3 0 013-3h7z',
  character: 'M12 12a4 4 0 100-8 4 4 0 000 8z M4 21a8 8 0 0116 0',
  python: 'M5 2h9l5 5v15H5z M14 2v6h5 M9 13c0 1.1.9 2 2 2h1 M14 13v2a2 2 0 01-2 2 M9 11v-1a2 2 0 012-2h1 M14 11c0-1.1-.9-2-2-2',
  // 目标定义也是 .py，所以形状差别要够大：脚本是"文件 + 蛇形折线"，这里是"写字板 + 对勾"
  goal: 'M8 4h11a2 2 0 012 2v14a2 2 0 01-2 2H8a2 2 0 01-2-2V6a2 2 0 012-2z M5 8H3 M5 12H3 M5 16H3 M11 10l2 2 4-4',
  markdown: 'M5 2h9l5 5v15H5z M14 2v6h5 M8 12h8 M8 16h8 M8 8h3',
  lang: 'M12 21a9 9 0 100-18 9 9 0 000 18z M3 12h18 M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z',
  voice: 'M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3z M5 11a7 7 0 0014 0 M12 18v3',
  tts: 'M4 9h4l5-4v14l-5-4H4z M16 9a4 4 0 010 6 M18.5 6.5a7.5 7.5 0 010 11',
  // 与 `.tts`（喇叭）刻意分开：服务定义是"一家供应商的配置"，齿轮一眼可辨
  ttsservice: 'M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
  progress: 'M5 21V4 M5 4h10l-2 3 2 3H5',
  // 任务通用（.quest）：摊开的书；单/多进度作者态在进度工作区按正文区分图标
  quest: 'M4 5h7a3 3 0 013 3v12a3 3 0 00-3-3H4z M20 5h-7a3 3 0 00-3 3v12a3 3 0 013-3h7z',
  // 与 `hanshu` / `quest`（摊开的书）区分：两个节点 + 连线 = 多进度树图（新建菜单）
  hflow: 'M4 3h6v5H4z M14 16h6v5h-6z M7 8v6h10v2',
  // 地图模板：折叠地图 + 等高线，和任务（书）/ 导航（罗盘）区分开
  level: 'M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z M9 3v15 M15 6v15',
  nav: 'M12 21a9 9 0 100-18 9 9 0 000 18z M14.5 9.5l-2 5-5 2 2-5 5-2z',
  // 与 `kit`（礼物盒）刻意分开：物品是"一块宝石"，盒子留给礼包
  'script-kit':'M4 3h12v9H4z M8 6l-2 2 2 2 M12 6l2 2-2 2 M13 16h9v6h-9z M12 13h11v3H12z M17.5 13v9',
  'script-shop':'M3 3h12v9H3z M6 6l-2 2 2 2 M11 6l2 2-2 2 M12 17h11l-1-4h-9z M13 17v6h9v-6',
  'script-item':'M4 3h12v9H4z M8 6l-2 2 2 2 M12 6l2 2-2 2 M17 13l5 3v5l-5 3-5-3v-5z M12 16l5 3 5-3',
  'script-enchantment':'M4 3h12v9H4z M8 6l-2 2 2 2 M12 6l2 2-2 2 M18 12l2 4 4 2-4 2-2 4-2-4-4-2 4-2z',
  'script-player':'M4 3h12v9H4z M8 6l-2 2 2 2 M12 6l2 2-2 2 M18 17a3 3 0 100-6 3 3 0 000 6z M12 23a6 6 0 0112 0',
  'script-entity':'M4 3h12v9H4z M8 6l-2 2 2 2 M12 6l2 2-2 2 M15 13h6v5h-6z M13 18h10v5H13z',
  item: 'M6 3h12l4 6-10 12L2 9z M2 9h20',
  entity: 'M8 3h8v6H8z M5 21v-6a7 7 0 0114 0v6 M8 15v6 M16 15v6',
  kit: 'M4 11h16v10H4z M2 7h20v4H2z M12 7v14 M12 7c0-2.5-2-4-4-4S5 5.5 5 7h7 M12 7c0-2.5 2-4 4-4s3 1.5 3 4h-7',
  shop: 'M3 10h18L19 3H5z M5 10v11h14V10 M9 21v-7h6v7',
  image: 'M3 4h18v16H3z M3 16l5-5 4 4 3-3 6 6 M15.5 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z',
  audio: 'M9 18V5l12-2v13 M9 18a3 3 0 11-6 0 3 3 0 016 0z M21 16a3 3 0 11-6 0 3 3 0 016 0z',
  json: 'M8 3H7a2 2 0 00-2 2v4a2 2 0 01-2 2 2 2 0 012 2v4a2 2 0 002 2h1 M16 3h1a2 2 0 012 2v4a2 2 0 002 2 2 2 0 00-2 2v4a2 2 0 01-2 2h-1',
  file: 'M5 2h9l5 5v15H5z M14 2v6h5',
}

/**
 * 后缀 → kind。
 *
 * **`.quest` / `.nav` / `.kit` 等曾经不在这张表里**，于是资源树把它们都画成
 * 通用文件图标 —— 补上之后，同一个包里的任务、导航点、礼包才一眼分得开。
 */
const BY_EXT: Record<string, ExplorerIconKind> = {
  '.hs': 'hanshu',
  '.char': 'character',
  '.py': 'python',
  '.md': 'markdown',
  '.lang': 'lang',
  '.voice': 'voice',
  '.tts': 'tts',
  '.ttsservice': 'ttsservice',
  '.quest': 'quest',
  '.level': 'level',
  '.nav': 'nav',
  '.item': 'item',
  '.entity': 'entity',
  '.kit': 'kit',
  '.shop': 'shop',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.svg': 'image',
  '.ogg': 'audio',
  '.mp3': 'audio',
  '.wav': 'audio',
  '.flac': 'audio',
  '.json': 'json',
}

export function fileIconKind(name: string): ExplorerIconKind {
  return BY_EXT[getExtension(name).toLowerCase()] ?? 'file'
}

/**
 * 源文件（`SourceFile`）的图标。
 *
 * 后缀不够用：**`.py` 的目标定义与普通脚本在磁盘上是两个目录**（`src/script/goal` / `src/script`），
 * 只有 `srcKind` 分得开。光看后缀的话，进度要用的目标定义与普通脚本会画成同一个图标，
 * 而这正是新建菜单要用户分清的那一对。
 */
export function sourceIconKind(file: {
  name: string
  srcKind?: string | null
}): ExplorerIconKind {
  if(getExtension(file.name)==='.py'&&['kit','shop','item','entity','enchantment','player'].includes(file.srcKind??''))return `script-${file.srcKind}` as ExplorerIconKind
  if(getExtension(file.name)==='.entity')return 'entity'
  if (getExtension(file.name) === '.py' && file.srcKind === 'goal') return 'goal'
  return fileIconKind(file.name)
}

export function ExplorerIcon({ kind }: { kind: ExplorerIconKind }) {
  return (
    <svg
      className={`explorer-icon is-${kind}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={PATHS[kind]} />
    </svg>
  )
}
