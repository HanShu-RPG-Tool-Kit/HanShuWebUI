import {createEntity,stringifyEntity} from './workspaces/progress/entityDoc'
import {scriptTemplate,SCRIPT_TYPE_NAMES,SCRIPT_TYPES} from './scriptResources'
/**
 * 「资源管理器里能新建什么」的**唯一真相**。
 *
 * 加一个类型 = 加一条记录：菜单项、专属图标、默认名、命名校验、初始正文全在这条记录里。
 * 旧 `handleNewScript` 把「能建哪些后缀」抄在 `window.prompt` 的提示语里、又抄在
 * `workspace.MANUAL_FILE_EXTENSIONS` 里，两处一漂移就会出现「菜单里没有、后缀却合法」。
 *
 * 三条约定，改动前先看清楚：
 *
 * 1. **`ext` 集合必须与 `workspace.MANUAL_FILE_EXTENSIONS` 完全一致**（不多不少）。
 *    `.lang` / `.voice` 的名字由剧本名派生（见 `localeLayout`：改 `.hs` 名会连带搬走它们），
 *    手工建一个只会变成孤儿，所以它们**不在**这张表里。这条一致性由
 *    `scripts/verify-new-file-types.ts` 断言，别靠人眼。
 * 2. **`seed` 必须能被各自的解析器吃回去**。`createScript(name, '')` 那种空壳对
 *    `.progress` / `.kit` / `.hflow` 就是一份坏文档（打开即报错），所以一律复用既有构造函数播种。
 * 3. **注册表不认识工作区**。语言表、服务定义、供应商预设、目标定义都由调用方经
 *    `NewFileSeedContext` 现取现给 —— 让一张纯数据表去拉这些，等于把「新建文件」
 *    和配音 / 进度两个工作区焊在一起，测试也就再跑不起来了。
 */

import {
  MANUAL_FILE_EXTENSIONS,
  type AllowedExtension,
  type PySrcKind,
} from './workspace'
import { defaultHsSeed } from './hanshu/defaultSeed'
import type { ExplorerIconKind } from './explorerIcons'
import { createFlow } from './workspaces/progress/model'
import { createFlowDocument } from './workspaces/progress/storage'
import { createKit, stringifyKit } from './workspaces/progress/kit'
import {
  createNavigationPoint,
  stringifyNavigationPoint,
} from './workspaces/progress/navigationPoint'
import { createProgress, stringifyProgress } from './workspaces/progress/progressDoc'
import { createItem, stringifyItem } from './workspaces/progress/itemDoc'
import { createEntity, stringifyEntity } from './workspaces/progress/entityDoc'
import type { GoalDefinition } from './workspaces/progress/goalDefinitions'
import { blankServiceDefinition, stringifyServiceDefinition } from './tts/service'
import { stringifyVoicePlan, type VoicePlan } from './tts/plan'
import type { ProviderPreset } from './tts/providers'

/** 下拉菜单里的分组。顺序即显示顺序（先"写剧本要用的"，再"要另开工作区编的"，最后"资料"） */
export type NewFileGroupId = 'source' | 'progress' | 'meta'

export const NEW_FILE_GROUPS: readonly { id: NewFileGroupId; label: string }[] = [
  { id: 'source', label: '源文件' },
  { id: 'progress', label: '进度与流程' },
  { id: 'meta', label: '创作资料' },
]

/** 稳定 id：文件菜单 / 测试 / 日志引用它；`label` 改了也不影响 */
export type NewFileTypeId =
  | 'hs'
  | 'char'
  | 'py'
  | 'py-goal'
  | 'py-kit'
  | 'py-item'
  | 'py-entity'
  | 'py-enchantment'
  | 'py-player'
  | 'entity'
  | 'progress'
  | 'hflow'
  | 'nav'
  | 'item'
  | 'entity'
  | 'kit'
  | 'md'
  | 'tts'
  | 'ttsservice'

/**
 * 播种上下文。注册表**不自己去读工作区**，需要什么由调用方给（见文件头第 3 条）。
 *
 * 这些字段只喂 `seed`：命名校验不需要上下文（重名判断要的是目标包的文件名表，
 * 那是创建管线的事，见 `ScriptWorkspace.handleNewFile`）。
 */
export type NewFileSeedContext = {
  /**
   * 工程里的目标定义。按 `createProgress` 的**真实签名**喂进去 ——
   * 它现在收了不用（新建进度一律空 `goals`，由用户在进度工作区加目标），
   * 但将来它开始按定义播种时，这条路径不用改。
   */
  goalDefinitions: readonly GoalDefinition[]
  /** 内置 + 用户自建的供应商预设；`.ttsservice` 拿第一条定 `provider` */
  ttsPresets: readonly ProviderPreset[]
  /** 工程语言表的第一条；没有语言时 `.tts` 建不出可用的方案（见 `.tts` 的 seed 注释） */
  firstLocale: string | null
  /** 工程里第一个服务 id；`.tts` 的语言条目引用它 */
  firstServiceId: string
  /** 第一个服务所属预设声明过的默认音色；没有就 null */
  firstVoiceId: string | null
}

export type NewFileType = {
  id: NewFileTypeId
  ext: AllowedExtension
  /** 菜单里显示的名字（不含后缀，后缀单独显示） */
  label: string
  /** 菜单里那句说明：写"建它做什么 / 建完在哪继续"，不是复述 label */
  hint: string
  icon: ExplorerIconKind
  group: NewFileGroupId
  /** 预填的基名（不含后缀） */
  defaultBase: string
  /** `.py` 的脚本类型，对应 src/script/<类型>/；其余类型留空 */
  srcKind?: PySrcKind
  /**
   * **这个类型额外**的基名规则。
   * 通用规则（不能为空 / 不能含路径分隔符 / 结尾不能是点或空格 / 别把后缀也敲进来）
   * 由 `validateNewFileBase` 统一加在前面，各条不用重复。
   */
  validateBase?(base: string): string | null
  /** 初始正文；必须能被对应解析器吃回去（文件头第 2 条） */
  seed(base: string, ctx: NewFileSeedContext): string
}

/**
 * Windows 保留设备名（判据大小写不敏感）。
 *
 * 为什么注册表要管这个：目标外壳是 Windows 桌面（Tauri + 真实文件系统）。
 * 建出 `CON.hs` / `NUL.hs` **不会当场报错** —— 它会在落盘那一步炸，
 * 而那时用户已经以为文件建好了，错误信息离"名字"还很远。
 *
 * 判据按 Windows 的实际规则：只看**第一个点之前**那一段（`NUL.txt` 与 `NUL` 等价，
 * 所以 `CON.hs` 与 `CON.x.hs` 都要拦）。MS 文档列的是 `COM1`–`COM9` / `LPT1`–`LPT9`；
 * 这里连 `COM0` / `LPT0` 一起拦（内核的 DOS 设备名判定也认它们），
 * 多拦一个的代价只是让用户换个名字，漏一个的代价是文件根本写不下去。
 */
const WINDOWS_RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'CONIN$',
  'CONOUT$',
  ...Array.from({ length: 10 }, (_, index) => `COM${index}`),
  ...Array.from({ length: 10 }, (_, index) => `LPT${index}`),
])

/**
 * 基名长度上限。理由见 `baseShapeError` 里那一段（整条路径的 MAX_PATH 260，
 * 而包根由用户选、可以很深）。导出来是为了让测试断言边界时不必抄一遍数字。
 */
export const MAX_BASE_LENGTH = 120

/**
 * 基名的通用规则。
 *
 * 判据与 `workspace.normalizeResourceName` 对齐 —— 这里先拦一道只是为了**把话说在输入框那一行**，
 * 真正落地的判据仍在创建管线里：资源树拿到的是"用户敲到一半"的文本，不能当成可信输入。
 */
function baseShapeError(base: string): string | null {
  const value = base.trim()
  if (!value) return '名字不能为空'
  if (/[\\/:*?"<>|]/.test(value)) return '不能含 \\ / : * ? " < > |'
  // eslint 不管，但控制字符（粘贴带进来的）会让文件名在磁盘上出现怪东西
  if ([...value].some((ch) => ch.charCodeAt(0) < 32)) return '不能含控制字符'
  if (value === '.' || value === '..') return '这个名字不能用'
  /*
   * 结尾的**点**必须拦：Windows 会静默丢掉结尾的点，`序章.` 落盘后变成 `序章`，
   * 于是资源树里的名字与磁盘上的名字对不上（改名 / 重名判断全跟着错）。
   *
   * 结尾的**空格**不在这里拦 —— 上面 `trim()` 已经去掉了，`newFileName` 也 trim，
   * 所以 `序章 ` 建出来就是 `序章.hs`，那正是用户想要的。
   * （早先这条判据写作 `/[. ]$/` 并宣称覆盖两种情形，其实空格那一半**永远不可达**：
   * trim 之后末尾不可能还有空格。判据与文案不一致比少一条规则更坏 —— 看代码的人会以为
   * 空格被拦住了，实际没有。所以现在只留点号这一半，空格交给 trim。）
   */
  if (value.endsWith('.')) return '结尾不能是点'
  // 保留设备名按第一个点之前那一段判（见 WINDOWS_RESERVED_NAMES）
  const device = value.split('.')[0]
  if (WINDOWS_RESERVED_NAMES.has(device.toUpperCase())) {
    return `「${device}」是 Windows 保留设备名，换一个`
  }
  /*
   * 长度上限。为什么不卡在 Windows 的单段上限 255：真正的约束是**整条路径**的
   * MAX_PATH 260（Tauri 走的是普通 Win32 文件 API，长路径支持要用户与清单都开）。
   * 包根由用户选、可以很深，再加上 `meta/voice/service/` 这类目录与后缀，
   * 留给基名的余量得保守。120 是"远超正常文件名、又给路径留足余量"的一档；
   * 用 `.length`（UTF-16 码元）而不是码点数，因为 Windows 的 255 就是按码元算的。
   */
  if (value.length > MAX_BASE_LENGTH) {
    return `名字太长（最多 ${MAX_BASE_LENGTH} 个字符，当前 ${value.length}）`
  }
  return null
}

/**
 * 用户把后缀也敲进来时（`序章.hs`）当场说清楚。
 *
 * 不这么判就会造出 `序章.hs.hs` —— 合法、能建、图标还对，但没人想要。
 * 判据用**整张后缀表**而不是本条目的 `ext`：敲成 `.md` 的同样是"想手写后缀"这个错误。
 * 这里不能改用 `getExtension`（`v1.2` 会被它看成后缀 `.2`，把合法基名误伤）。
 */
function typedExtensionError(base: string): string | null {
  const value = base.trim().toLowerCase()
  return MANUAL_FILE_EXTENSIONS.some((ext) => value.endsWith(ext))
    ? '不用写后缀，后缀由类型决定'
    : null
}

/** 菜单 / 创建管线共用的校验：静态规则。重名要目标包的文件名表，只能由创建管线判 */
export function validateNewFileBase(type: NewFileType, base: string): string | null {
  return baseShapeError(base) ?? typedExtensionError(base) ?? type.validateBase?.(base) ?? null
}

/** 基名 + 该类型的后缀。后缀**只**从这里来，界面上没有让用户改它的地方 */
export function newFileName(type: NewFileType, base: string): string {
  return `${base.trim()}${type.ext}`
}

/**
 * `.ttsservice` 的基名只能是 ASCII —— 它同时是**服务 id**，而 id 会拼进凭据引用
 * （`blankServiceDefinition` → `defaultCredentialRef` → `app:<id>`），
 * 引用名的字符集是 `[A-Za-z0-9_.-]`（见 `tts/spec.ts` 的 `CREDENTIAL_REF_RE`）。
 * 放中文进去，新建出来的定义会当场带一条"auth.apiKeyRef 必须是 env:/app: 引用"的错误 ——
 * 那比直接拦住难懂得多。
 */
function serviceIdError(base: string): string | null {
  return /^[A-Za-z0-9_.-]+$/.test(base.trim())
    ? null
    : '服务 id 会拼进凭据引用（app:<id>），只能用字母、数字、. - _'
}

/** New Python files always use the same bundled templates as the progress explorer. */
export const NEW_FILE_TYPES: readonly NewFileType[] = [
  {
    id: 'hs',
    ext: '.hs',
    label: '汉书剧本',
    hint: '对白、选项树、注入点；可本地化与配音',
    icon: 'hanshu',
    group: 'source',
    defaultBase: '新剧本',
    /*
     * 与新工程默认 `.hs`、本地空工作区种子同形（`defaultHsSeed`）。
     * 场景行用带标签注释 `#【场景】`（编辑器认得）；对白 / 选项须符合当前 .hs 语法。
     */
    seed: (base) => defaultHsSeed(base),
  },
  {
    id: 'char',
    ext: '.char',
    label: '角色卡',
    hint: 'key:msg// 文本槽；角色 id 就是文件名',
    icon: 'character',
    group: 'source',
    defaultBase: '新角色',
    /*
     * 角色 id = 文件名，正文里**不再写**一层名字字段（见帮助「.char 角色卡语法」§1）。
     * 只给一个 `name:` 槽当例子：键名词汇表标准不规定，多写几个反而是替作者定约定。
     */
    seed: (base) => {
      const name = base.trim()
      return `# 角色卡：${name}（角色 id 就是文件名，正文里不要再写名字字段）\nname:${name}//\n`
    },
  },
  ...SCRIPT_TYPES.map(type=>({
    id:(type==='common'?'py':`py-${type}`) as NewFileTypeId,ext:'.py' as const,label:SCRIPT_TYPE_NAMES[type],
    hint:`src/script/${type} · 服务端脚本`,icon:(type==='goal'?'goal':type==='common'?'python':`script-${type}`) as ExplorerIconKind,
    group:'source' as const,defaultBase:type==='goal'?'新目标':'新脚本',srcKind:type,
    seed:(base:string)=>scriptTemplate(type,'default.py',base.trim()),
  })),
  {id:'entity',ext:'.entity',label:'实体模板',hint:'实体库模板',icon:'entity',group:'progress',defaultBase:'新实体',seed:()=>stringifyEntity(createEntity())},
  {
    id: 'progress',
    ext: '.progress',
    label: '进度 / 委托',
    hint: '目标、可见性与奖励（src/progress）；表单编辑',
    icon: 'progress',
    group: 'progress',
    defaultBase: '新进度',
    /*
     * `createProgress` 忽略标题（文档里的 `name` 是**语义键**，译文在 lang_progress），
     * 所以文件名不会进正文 —— 名称由用户在进度工作区填，`progressIssues` 会提示"请填写进度名称"。
     * 这是有意的：新建时猜一个显示名，只会让译文表里多一条没人认领的条目。
     */
    seed: (base, ctx) => stringifyProgress(createProgress(base.trim(), ctx.goalDefinitions)),
  },
  {
    id: 'hflow',
    ext: '.hflow',
    label: '故事流程',
    hint: '树图节点与连线的草稿（src/story）',
    icon: 'hflow',
    group: 'progress',
    defaultBase: '新流程',
    /*
     * 只取 `createFlowDocument(...).source`（= flow 的 JSON）：文件名由用户在资源树里定，
     * 而 `createFlowDocument` 会按 flow 标题另拼一个 `.hflow` 名，与这里的选择无关。
     *
     * `base` 传进 `createFlow` 的标题位是**眼下用不上**的（`_title` 收了不用：标题是语义键，
     * 译文在 lang_flow）。与进度工作区的 `newFlow` 同一写法 —— 它也是把标题传进同一个位置。
     *
     * `package: 'story'` 是分类的合理默认：剧本工作区没有"分类"这个概念，树图分类归进度
     * 工作区；`folderId` 留空即落在该分类根（`sourcesToProgressDocuments` 同样这么认）。
     */
    seed: (base) => createFlowDocument(createFlow(undefined, base.trim()), 'story').source,
  },
  {
    id: 'nav',
    ext: '.nav',
    label: '导航点',
    hint: '固定坐标或绑定实体（src/navigator）',
    icon: 'nav',
    group: 'progress',
    defaultBase: '新导航点',
    // `createNavigationPoint` 同样忽略展示名：`label` 是语义键，译文在 lang_nav
    seed: (base) => stringifyNavigationPoint(createNavigationPoint(base.trim())),
  },
  {
    id: 'item',
    ext: '.item',
    label: '物品',
    hint: '物品 id、组件与标签（src/items）',
    icon: 'item',
    group: 'progress',
    defaultBase: '新物品',
    /*
     * 与进度工作区的新建文档同式：`stringifyItem(createItem())`。
     *
     * `createItem` 的默认 id 是 `minecraft:stick`（见 itemDoc 的 `DEFAULT_ITEM_ID`）——
     * 物品 id 是**数据**、不是展示名，所以**不拿文件名去猜**：猜出来的多半是个不存在的
     * 物品（而 `minecraft:` 命名空间的东西也不该由文件名决定）。用户进去改成自己的 id。
     */
    seed: () => stringifyItem(createItem()),
  },
  {
    id: 'entity',
    ext: '.entity',
    label: '实体',
    hint: '名称、属性与装备',
    icon: 'entity',
    group: 'progress',
    defaultBase: '新实体',
    seed: () => stringifyEntity(createEntity()),
  },
  {
    id: 'kit',
    ext: '.kit',
    label: '礼包',
    hint: '超参数、修饰器与内容卡（src/gift）',
    icon: 'kit',
    group: 'progress',
    defaultBase: '新礼包',
    seed: (base) => stringifyKit(createKit(base.trim())),
  },
  {
    id: 'md',
    ext: '.md',
    label: '文档',
    hint: '设计稿、设定集（meta/docs）；不进 PAK，随工程包导出',
    icon: 'markdown',
    group: 'meta',
    defaultBase: '新文档',
    seed: (base) => `# ${base.trim()}\n\n> 这份文档在 \`meta/docs/\`，随工程包导出，但不进 PAK。\n`,
  },
  {
    id: 'tts',
    ext: '.tts',
    label: '配音方案',
    hint: '每个说话人一份（meta/voice）；文件名就是说话人名',
    icon: 'tts',
    group: 'meta',
    defaultBase: '新说话人',
    /*
     * 与录音棚的 `createTtsPlan` 同一份种子：**一条语言 + 第一个服务**，
     * 但**不写音色** —— 音色 id 是厂商账号下的值，新建时无从得知，
     * 写个占位串比缺一个键坏得多（打开表单会显示"缺少音色 id"，那正是要用户填的地方）。
     * 所以：预设声明了固定音色表时（`ctx.firstVoiceId`）才写 `voice`，
     * 其余情况这份文件**在结构校验里就是差一个 `voice`**，由 `TtsPlanForm` 在那一格上说清楚。
     * 工程里一条语言都没有时同理（`voices: {}` 报"至少要有一条语言"）——
     * 那种工程本来也做不了配音。
     */
    // `_base` 用不上：说话人名在**文件名**里，方案正文只认语言 → 服务/音色
    seed: (_base, ctx) => {
      const plan: VoicePlan = {
        version: 1,
        voices: ctx.firstLocale
          ? {
              [ctx.firstLocale]: {
                service: ctx.firstServiceId,
                // 缺就是缺：少一个键比多一个空串干净（同 `createTtsPlan`）
                ...(ctx.firstVoiceId ? { voice: ctx.firstVoiceId } : {}),
                extra: {},
              },
            }
          : {},
        extra: {},
      }
      return stringifyVoicePlan(plan)
    },
  },
  {
    id: 'ttsservice',
    ext: '.ttsservice',
    label: '配音服务',
    hint: '一家供应商的端点与凭据引用（meta/voice/service）',
    icon: 'ttsservice',
    group: 'meta',
    // 默认名与录音棚的 `createTtsService` 一致（`my-service`），且必须是 ASCII —— 见 serviceIdError
    defaultBase: 'my-service',
    validateBase: serviceIdError,
    /*
     * `blankServiceDefinition` 建成**能通过结构校验**的样子（选第一家预设、按协议形态起好
     * 凭据引用的名字）：空壳会在方案的服务下拉里都出不来，而新建之后最需要看到它的地方
     * 恰恰就是那里。`ttsPresets` 为空（理论上不会）时退到 `template`，
     * 那时缺 protocol / baseUrl 由服务表单接着要。
     */
    seed: (base, ctx) =>
      stringifyServiceDefinition(
        blankServiceDefinition(
          base.trim(),
          ctx.ttsPresets[0]?.id ?? 'template',
          ctx.ttsPresets,
        ),
      ),
  },
]

/** 按 id 取类型；界面传来的 id 来自同一张表，取不到说明两边不同步（调用方要报错，不要静默新建） */
export function findNewFileType(id: string): NewFileType | null {
  return NEW_FILE_TYPES.find((type) => type.id === id) ?? null
}

/** 菜单用的分组视图：空分组不出现（加类型时不用记得同步别处） */
export function newFileTypesByGroup(): { group: (typeof NEW_FILE_GROUPS)[number]; items: NewFileType[] }[] {
  return NEW_FILE_GROUPS.map((group) => ({
    group,
    items: NEW_FILE_TYPES.filter((type) => type.group === group.id),
  })).filter((entry) => entry.items.length > 0)
}
