/**
 * 新建文件注册表的验证。
 *
 * 这个脚本守的是三件**界面上看不出来**的事：
 *
 * 1. 注册表的 `ext` 集合与 `workspace.MANUAL_FILE_EXTENSIONS` **完全一致**。
 *    两边一漂移，就会出现"菜单里没有、后缀却合法"（或反过来：菜单里能点、落盘被拒）——
 *    点一下才发现，而且只在某个后缀上。
 * 2. **每条 `seed` 都能被各自的解析器吃回去**。空壳对 `.quest` / `.kit`
 *    就是一份打开即报错的坏文档，而"新建 → 打开"这条路上没人会去读解析器源码。
 * 3. 每个 `icon` 都真实存在于 `explorerIcons` 的图标表。写错一个 kind 只是"没图标"，
 *    没人会逐个点开 11 个类型看一遍。
 *
 * 跑：`npx tsx scripts/verify-new-file-types.ts`
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  MANUAL_FILE_EXTENSIONS,
  SOURCE_KIND_ORDER,
  WORKSPACE_GROUP_ORDER,
  sourceKindOf,
  sourcePathOf,
} from '../src/workspace.ts'
import {
  MAX_BASE_LENGTH,
  NEW_FILE_GROUPS,
  NEW_FILE_TYPES,
  findNewFileType,
  newFileName,
  newFileTypesByGroup,
  validateNewFileBase,
  type NewFileSeedContext,
  type NewFileType,
} from '../src/newFileTypes.ts'
import { EXPLORER_ICON_KINDS, fileIconKind, sourceIconKind } from '../src/explorerIcons.tsx'
import { shouldHoldWheel } from '../src/newFileMenuWheel.ts'
import { analyzeHsDiagnostics } from '../src/monaco/hsDiagnostics.ts'
import { analyzeCharDiagnostics } from '../src/monaco/charDiagnostics.ts'
import { parseCharTextSpans } from '../src/monaco/charTextSpans.ts'
import { collectSourceKeys } from '../src/hanshu/sourceKeys.ts'
import { parseProgress, stringifyProgress } from '../src/workspaces/gameplay/progressDoc.ts'
import { parseItem, stringifyItem } from '../src/workspaces/gameplay/itemDoc.ts'
import { parseEntity, stringifyEntity } from '../src/workspaces/gameplay/entityDoc.ts'
import { parseKit } from '../src/workspaces/gameplay/kit.ts'
import { parseShop } from '../src/workspaces/gameplay/shop.ts'
import { parseNavigationPoint, validateNavigationPoint } from '../src/workspaces/gameplay/navigationPoint.ts'
import { parseLevelDocument, stringifyLevelDocument } from '../src/workspaces/gameplay/levelDoc.ts'
import { parseFlow } from '../src/workspaces/gameplay/model.ts'
import { readVoicePlan } from '../src/tts/plan.ts'
import { readServiceDefinition, resolveService } from '../src/tts/service.ts'
import { AUTH_SHAPES, PROTOCOLS } from '../src/tts/spec.ts'
import { resolvePresets } from '../src/tts/providers.ts'

const type = (id: string): NewFileType => {
  const found = findNewFileType(id)
  assert.ok(found, `注册表里应有「${id}」`)
  return found
}

/**
 * 去掉注释，只留代码。
 *
 * 源码级护栏必须只看**代码**：`Explorer.tsx` 的注释里正大光明地写着
 * `STAGEPLAY_WORKSPACE_GROUP_ORDER`（解释 D-1 是怎么来的），拿原文做子串匹配会误判。
 * 这个剥离器不追求通用（不认识字符串字面量里的 `//`），够这里用即可 ——
 * 判据是"标识符还在不在代码里"，被多剥掉一段只会让断言更严，不会放过回归。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

/** 一条"像真的"播种上下文：语言、服务、预设都齐 */
const presets = resolvePresets().presets
const ctx: NewFileSeedContext = {
  goalDefinitions: [],
  ttsPresets: presets,
  firstLocale: 'zh_cn',
  firstServiceId: 'my-service',
  firstVoiceId: null,
}
const seedOf = (id: string, base?: string) =>
  type(id).seed(base ?? type(id).defaultBase, ctx)

// ===== 1. 后缀集合与 workspace 对齐 =====

assert.deepEqual(
  [...new Set(NEW_FILE_TYPES.map((item) => item.ext))].sort(),
  [...MANUAL_FILE_EXTENSIONS].sort(),
  '注册表的 ext 集合必须与 MANUAL_FILE_EXTENSIONS 完全一致（.lang / .voice 不在此列）',
)
for (const ext of MANUAL_FILE_EXTENSIONS) {
  assert.ok(
    NEW_FILE_TYPES.some((item) => item.ext === ext),
    `MANUAL_FILE_EXTENSIONS 里的 ${ext} 在注册表里没有条目`,
  )
}
// `.py` 恰恰两条：普通脚本与目标定义（磁盘上是两个目录）
assert.equal(NEW_FILE_TYPES.filter((item) => item.ext === '.py').length, 8)
assert.equal(type('py').srcKind, 'common', '通用脚本使用 common 类型')
assert.equal(type('py-goal').srcKind, 'goal')
assert.notEqual(type('py').icon, type('py-goal').icon, '两种 .py 的图标必须能区分')

// id 唯一 + 分组 id 都存在
assert.equal(new Set(NEW_FILE_TYPES.map((item) => item.id)).size, NEW_FILE_TYPES.length, 'id 不能重复')
// 每种类型一个**专属**图标：两种类型共用一个 kind，下拉里就分不出谁是谁
assert.equal(
  new Set(NEW_FILE_TYPES.map((item) => item.icon)).size,
  NEW_FILE_TYPES.length,
  '每种类型的图标 kind 必须互不相同',
)
const groupIds = new Set(NEW_FILE_GROUPS.map((group) => group.id))
for (const item of NEW_FILE_TYPES) assert.ok(groupIds.has(item.group), `${item.id} 的分组「${item.group}」不存在`)
// 分组视图不漏项：加类型时不必记得同步别处
assert.deepEqual(
  newFileTypesByGroup().flatMap((entry) => entry.items).map((item) => item.id),
  NEW_FILE_TYPES.map((item) => item.id),
)

// ===== 2. 图标 kind 都存在，且后缀映射认得出注册表里每一个类型 =====

for (const item of NEW_FILE_TYPES) {
  assert.ok(
    EXPLORER_ICON_KINDS.includes(item.icon),
    `${item.id} 的图标 kind「${item.icon}」不在 explorerIcons 的图标表里`,
  )
}
// 资源树是靠 sourceIconKind(file) 选图标的：注册表里每种类型的图标必须与它一致，
// 否则"菜单里认得出、树里认不出"（`.quest` 等曾经就退化成通用文件图标；
// 而 `.py` 的目标定义光看后缀根本分不开，得靠 srcKind）。
// 例外：单/多进度都是 `.quest`，菜单用 progress/hflow 区分作者态，树里统一 quest。
for (const item of NEW_FILE_TYPES) {
  const name = newFileName(item, item.defaultBase)
  const expected = item.ext === '.quest' ? 'quest' : item.icon
  assert.equal(
    sourceIconKind({ name, srcKind: item.srcKind }),
    expected,
    `${name} 在资源树里的图标与期望的 ${expected} 不一致`,
  )
}
assert.equal(fileIconKind('a.quest'), 'quest')
assert.equal(fileIconKind('a.level'), 'level')
assert.equal(fileIconKind('a.nav'), 'nav')
assert.equal(fileIconKind('a.kit'), 'kit')
assert.equal(fileIconKind('a.entity'), 'entity')
assert.equal(fileIconKind('a.ttsservice'), 'ttsservice')
assert.equal(fileIconKind('a.tts'), 'tts')
assert.notEqual(fileIconKind('a.tts'), fileIconKind('a.ttsservice'), '方案与服务定义必须是两个图标')
assert.notEqual(sourceIconKind({ name: 'a.py' }), sourceIconKind({ name: 'a.py', srcKind: 'goal' }))
assert.equal(type('progress').ext, '.quest')
assert.equal(type('hflow').ext, '.quest')
assert.notEqual(type('progress').icon, type('hflow').icon, '单/多进度在新建菜单里必须能区分')

// ===== 2b. 注册表建得出来的文件，资源树必须渲染得出来 =====

/*
 * 守的是 D-1 那个 bug：资源树当时只给 `STAGEPLAY_WORKSPACE_GROUP_ORDER`
 * （hanshu / character / script / meta）建桶，而 `sourceKindOf` 返回
 * goal / progress / story / navigator / gift 的文件**既不入桶也不入 root**，
 * 被静默丢掉 —— 从「+剧」新建进度 / 流程 / 导航 / 礼包 / 目标定义（11 种里的 5 种）
 * 建完就在树里消失（文件其实建成了、还成了活动文件）。
 *
 * 这种"菜单能建、树里看不见"的 bug 靠人眼点 11 个类型是发现不了的，必须由测试守。
 *
 * 为什么断言 `WORKSPACE_GROUP_ORDER`（从 workspace 取）而不是从 `Explorer.tsx` 导出的常量：
 * `Explorer.tsx` 顶层 `import './explorer-newfile.css'`，tsx 起不来
 * （实测 `Unknown file extension ".css"`），所以测试**无法** import 它。
 * 退而取 `WORKSPACE_GROUP_ORDER` —— 这正是 `Explorer` 现在 import 的那个常量，
 * 两者是同一个值、同一个出处（`workspace.ts`），不存在抄一份的问题。
 * 下面再补一条**源码级**护栏，防止有人把 Explorer 改回按窄常量分桶。
 */
const RENDERED_GROUPS = new Set<string>([...WORKSPACE_GROUP_ORDER, 'root'])

// 先钉死这个常量本身：`SOURCE_KIND_ORDER` 少一个 kind（或 `meta` 被摘掉）时，
// 光靠"注册表 ext 集合 == MANUAL_FILE_EXTENSIONS"是发现不了的
assert.deepEqual(
  [...WORKSPACE_GROUP_ORDER],
  [
    'hanshu',
    'character',
    'script',
    'quest',
    'level',
    'navigator',
    'shop',
    'gift',
    'items',
    'entities',
    'meta',
  ],
  'WORKSPACE_GROUP_ORDER 必须覆盖全部源类型 + meta（资源树按它建桶）',
)
assert.deepEqual([...SOURCE_KIND_ORDER], [...WORKSPACE_GROUP_ORDER].slice(0, -1), 'WORKSPACE_GROUP_ORDER 应是 SOURCE_KIND_ORDER + meta')

for (const item of NEW_FILE_TYPES) {
  const name = newFileName(item, item.defaultBase)
  const kind = sourceKindOf(name, item.srcKind)
  assert.ok(
    RENDERED_GROUPS.has(kind),
    `${item.id}（${name}）的 sourceKindOf = 「${kind}」不在资源树渲染的分组里 —— ` +
      `建出来就会在树里消失（可用分组：${[...RENDERED_GROUPS].join(' / ')}）`,
  )
}

/*
 * 源码级护栏：`Explorer.tsx` 分桶必须用 `WORKSPACE_GROUP_ORDER`，
 * 且**不能**再出现按 `STAGEPLAY_WORKSPACE_GROUP_ORDER` 分桶的写法。
 *
 * 为什么要读源码而不是 import：见上面那段（CSS 让 tsx 起不来）。
 * 它挡的正是 D-1 的原始形态 —— 有人觉得"剧本树只该列剧本那几个目录"，把常量换回去。
 */
const explorerSource = stripComments(
  readFileSync(new URL('../src/Explorer.tsx', import.meta.url), 'utf8'),
)
assert.ok(
  /WORKSPACE_GROUP_ORDER/.test(explorerSource),
  'Explorer.tsx 应按 WORKSPACE_GROUP_ORDER 给资源树建桶',
)
assert.ok(
  !/STAGEPLAY_WORKSPACE_GROUP_ORDER/.test(explorerSource),
  'Explorer.tsx 不能再按 STAGEPLAY_WORKSPACE_GROUP_ORDER 建桶 —— 那会让进度/流程/导航/礼包/目标定义在树里消失',
)

// ===== 2c. 菜单能滚：滚轮不能被"关菜单"或"穿透去滚树"吃掉 =====

/*
 * 守的是实测到的两条：
 * 1. 菜单自己就是滚动容器（`.explorer-newfile-menu` 的 max-height + overflow-y），
 *    而关闭监听是 `window.addEventListener('scroll', close, true)` —— **捕获阶段**。
 *    `scroll` 不冒泡，但捕获阶段照样会经过 window，于是"滚轮一碰菜单，菜单瞬间消失"。
 * 2. 菜单不溢出时滚轮会穿透去滚背后的资源树 —— 树一滚，同一条监听又把菜单关掉。
 *
 * 两条判据都只能读源码：`Explorer.tsx` 顶层 import 了 `./explorer-newfile.css`，
 * tsx 直接 import 会 `Unknown file extension ".css"`（见上面 2b 的说明）。
 */
const scrollHandlerAt = explorerSource.indexOf('const onScroll = (event: Event) =>')
assert.ok(
  scrollHandlerAt >= 0,
  '找不到菜单的 onScroll 关闭处理器（改成别的形态了就把这条断言一起改）',
)
const scrollHandler = explorerSource.slice(scrollHandlerAt, scrollHandlerAt + 400)
assert.ok(
  /contains\(event\.target\)/.test(scrollHandler) && /return/.test(scrollHandler),
  '菜单自己的滚动必须放过（scroll 在捕获阶段也会经过 window）：' +
    '不放过就是"滚轮一碰菜单，菜单瞬间消失"',
)
assert.ok(
  /addEventListener\('scroll', onScroll, true\)/.test(explorerSource),
  '资源树那种不冒泡的容器滚动仍要靠捕获阶段抓 —— 别顺手把 true 去掉',
)

// 滚轮要在菜单这一层被拦住：菜单自己不能滚（或已到边界）时 preventDefault，别让它滚到树上去
assert.ok(
  /addEventListener\('wheel', onWheel, \{ passive: false \}\)/.test(explorerSource),
  '菜单要挂一个**非 passive** 的 wheel 监听：React 的 onWheel 在根节点上是 passive，' +
    '里面 preventDefault 不生效',
)
const wheelHandlerAt = explorerSource.indexOf('const onWheel = (event: WheelEvent)')
assert.ok(wheelHandlerAt >= 0, '找不到 onWheel（改名了就把这条断言一起改）')
const wheelHandler = explorerSource.slice(wheelHandlerAt, wheelHandlerAt + 500)
assert.ok(
  /preventDefault\(\)/.test(wheelHandler),
  'onWheel 里要在会穿透时 preventDefault：否则滚轮去滚资源树，菜单照样被关掉',
)
/*
 * 但"里面有个 preventDefault"远远不够 —— **无条件** preventDefault 也能过上面那条，
 * 而那正是"滚轮完全不可用"（用户报的第二个症状）。
 * 判据必须来自那个纯函数，且必须拿真实尺寸算过（见下面的穷举）。
 */
assert.ok(
  /shouldHoldWheel\(\{/.test(wheelHandler) &&
    /scrollHeight: el\.scrollHeight/.test(wheelHandler) &&
    /deltaY: event\.deltaY/.test(wheelHandler),
  'onWheel 必须把真实尺寸与方向交给 shouldHoldWheel 判 —— 无条件 preventDefault 会把滚轮彻底废掉',
)

// ===== 2d. 拦与不拦的判据：纯算术穷举 =====

/*
 * `shouldHoldWheel` 就是 Explorer 里用的那一个（上面那条断言钉住了"用的是它"），
 * 所以这里可以不起浏览器、不模拟 DOM，直接把边界算干净。
 *
 * 两条不变量：
 *   INV1 不拦 → 菜单必须真的能沿这个方向滚（否则浏览器会链给树，树一滚菜单就被关）
 *   INV2 拦 → 被挡掉的真实可滚量 ≤ 1px（否则就是"滚轮不可用"）
 * `deltaY === 0` 不参与 INV1：纵向本来就不会滚，也就没有穿透。
 */
const sizes = [0, 1, 2, 50, 120, 384, 500, 704, 1064]
const overflows = [0, 1, 2, 3, 5, 20, 100, 400]
const positions = [0, 1, 2, 3, 10, 50, 99, 100, 400]
const deltas = [200, 100, 3, 1, 0, -1, -3, -100, -200]

let heldCases = 0
let freeCases = 0
for (const clientHeight of sizes) {
  for (const overflow of overflows) {
    const scrollHeight = clientHeight + overflow
    for (const rawTop of positions) {
      const scrollTop = Math.max(0, Math.min(rawTop, scrollHeight - clientHeight))
      for (const deltaY of deltas) {
        const held = shouldHoldWheel({ scrollTop, clientHeight, scrollHeight, deltaY })
        if (held) {
          heldCases++
          // INV2：拦下时最多只挡掉 1px（容差，见函数里的注释）
          //
          // `clientHeight === 0`（元素还没量到尺寸）要单独算：可视高度为 0 时
          // 浏览器根本没有"可滚动的行程"，挡掉的就是 0px —— 不能拿 scrollHeight 当行程。
          const roomUp = clientHeight > 0 ? scrollTop : 0
          const roomDown = clientHeight > 0 ? scrollHeight - clientHeight - scrollTop : 0
          const blocked = deltaY < 0 ? Math.min(roomUp, -deltaY) : deltaY > 0 ? Math.min(roomDown, deltaY) : 0
          assert.ok(
            blocked <= 1,
            `拦下了不该拦的一下：scrollTop=${scrollTop} client=${clientHeight} ` +
              `scroll=${scrollHeight} deltaY=${deltaY} 会挡掉 ${blocked}px 的真实滚动`,
          )
        } else {
          freeCases++
          if (deltaY !== 0) {
            // INV1：不拦就必须真能滚
            assert.ok(
              clientHeight > 0 && scrollHeight > clientHeight + 1,
              `没拦但菜单不可滚：scrollTop=${scrollTop} client=${clientHeight} ` +
                `scroll=${scrollHeight} deltaY=${deltaY} —— 这一下会穿透去滚资源树，菜单被关掉`,
            )
            const room = deltaY > 0 ? scrollHeight - clientHeight - scrollTop : scrollTop
            assert.ok(
              room > 0,
              `没拦但该方向已到头：scrollTop=${scrollTop} client=${clientHeight} ` +
                `scroll=${scrollHeight} deltaY=${deltaY}`,
            )
          }
        }
      }
    }
  }
}
assert.ok(heldCases > 0 && freeCases > 0, '穷举两个分支都要覆盖到（否则断言是空跑）')

// 逐条钉死几个手算的边界，免得穷举的网格恰好漏掉它们
const wheeling = (scrollTop: number, clientHeight: number, scrollHeight: number, deltaY: number) =>
  shouldHoldWheel({ scrollTop, clientHeight, scrollHeight, deltaY })
assert.equal(wheeling(0, 500, 500, 100), true, '内容不溢出：滚轮要拦下（不能去滚树）')
assert.equal(wheeling(0, 500, 501, 100), true, '只溢出 1px：按容差判为不可滚，拦下（最多挡 1px）')
assert.equal(wheeling(0, 500, 502, 100), false, '还能往下滚：不要拦，交给原生滚')
assert.equal(wheeling(0, 500, 900, -100), true, '已经在顶、还要往上：拦下')
assert.equal(wheeling(2, 500, 900, -100), false, '不在顶、向上还有余量：不要拦')
assert.equal(wheeling(1, 500, 900, 100), false, '不在底、向下还有余量：不要拦')
assert.equal(wheeling(399, 500, 900, 100), true, '正好到底、还要往下：拦下')
assert.equal(wheeling(398, 500, 900, 100), false, '离底还有 1px：不要拦')
assert.equal(wheeling(1, 500, 502, 100), true, '已经到底（差 1px 也算到底）：拦下')
assert.equal(wheeling(0, 0, 0, 100), true, '退化尺寸（还没量到）：拦下，别去滚树')
assert.equal(wheeling(0, 500, 900, 0), false, 'deltaY = 0：纵向没有穿透这回事')

// ===== 3. 每条 seed 都能被各自的解析器吃回去 =====

// `.hs`：不能有任何语法诊断（缺闭合符 / 说话人换行都算）
const hsSeed = seedOf('hs')
assert.deepEqual(analyzeHsDiagnostics(hsSeed), [], '.hs 种子不该有语法诊断')
assert.ok(hsSeed.startsWith('# 新剧本\n'), '.hs 种子应以注释标题行开头')
assert.deepEqual(collectSourceKeys(hsSeed, '新剧本.hs'), [], '.hs 种子不该带已成的键')
// 场景行用带标签注释：#【场景】是文档承认的形态，裸的【场景】不是
assert.ok(hsSeed.includes('#【场景】'), '.hs 种子的场景行应是带标签注释')
assert.ok(hsSeed.includes('narrator:'), '.hs 种子应含合法对白 speaker')
assert.ok(/\n\/\/\n/.test(hsSeed) || hsSeed.includes('//\n'), '.hs 种子对白应正确以 // 收尾')

// `.char`：每个非注释行都是 key:msg//，且解析出恰好一个槽
const charSeed = seedOf('char', '林砚')
assert.deepEqual(analyzeCharDiagnostics(charSeed), [], '.char 种子不该有语法诊断')
assert.equal(parseCharTextSpans(charSeed).length, 1, '.char 种子应恰好一个文本槽')
assert.ok(charSeed.includes('name:林砚//'), '角色卡的示例槽应带上文件名当值')

// `.md`：有意义的骨架，不是空文件
assert.ok(seedOf('md', '设定').startsWith('# 设定\n'))

// 两种 `.py`：只写注释，且**不能**凭空产生目标定义
//
// 这里只做文本判据、不去 import `parseGoalDefinitionsFromSource`：那个模块
// （`goalDefinitions.ts`）在顶层拉 `builtinGoals/index.ts`，而后者用了 Vite 专有的
// `import.meta.glob` —— 在 tsx 下会当场炸（`verify-goal-definitions.ts` 因此改走 vite-node）。
// 判据本身比解析器更严：出现 `@goal(` 就算失败。目标定义目录是拿正则扫**全文**的，
// 注释里一句示例也会被当成一条定义，所以种子里干脆不该有这个形态。
for (const id of ['py', 'py-goal']) {
  const seed = seedOf(id, '示例')
  assert.ok(seed.startsWith('# 示例\n'), `${id} 的骨架第一行应是标题注释`)
  assert.ok(
    !seed.includes('@goal('),
    `${id} 的种子不该出现 @goal( —— 目标定义是扫全文的，注释里的示例也会被当成一条定义`,
  )
}

// 单进度 `.quest`：往返一致（种子就是 `stringifyProgress(createProgress(…))`）
const progressSeed = seedOf('progress')
const progressDoc = parseProgress(progressSeed)
assert.equal(progressSeed, stringifyProgress(progressDoc), '单进度 .quest 种子应能原样往返')
assert.deepEqual(progressDoc.goals, [], '新建单进度任务不带目标，由用户在游戏性工作区加')
assert.equal(newFileName(type('progress'), '示例'), '示例.quest')

// `.kit`
const kitSeed = seedOf('kit')
assert.equal(parseKit(kitSeed).name, 'name', '礼包名是语义键，种子不该写死展示名')
assert.equal(parseShop(seedOf('shop')).format, 'hanshu.shop')
/*
 * `.item`（上游的物品库文档）：往返一致。
 * 物品 id 是**数据**（`minecraft:` 命名空间），不该由文件名猜出来 —— 种子里是
 * `createItem()` 的默认 id，与进度工作区的新建文档同式。
 */
const itemSeed = seedOf('item')
assert.equal(stringifyItem(parseItem(itemSeed)), itemSeed, '.item 种子应能原样往返')
assert.equal(parseItem(itemSeed).item.id, 'minecraft:stick', '.item 种子用 itemDoc 的默认 id')
// `.entity` follows the same valid template seed and source directory as the entity workspace.
const entitySeed = seedOf('entity')
const entityDoc = parseEntity(entitySeed)
assert.equal(stringifyEntity(entityDoc), entitySeed, '.entity 种子应能原样往返')
assert.equal(entityDoc.entity.id, 'minecraft:pig', '.entity 种子使用构造器的默认实体类型')
assert.deepEqual(entityDoc.entity.data, { type: 'compound', value: {} })
assert.equal(sourceKindOf(newFileName(type('entity'), '新实体')), 'entities')
assert.equal(sourcePathOf({ name: newFileName(type('entity'), '新实体') }), 'src/entities/新实体.entity')
// `.nav`：v3 形状；新建时还没选模板，所以校验会提示 level，而不是当成坏文档
const navPoint = parseNavigationPoint(seedOf('nav'))
assert.equal(navPoint.level, '')
assert.equal(navPoint.type, 'rpgtoolkit:pos')
assert.ok(validateNavigationPoint(navPoint).some((item) => item.includes('地图模板')))

// `.level`：空模板可原样往返；路径落在 src/level
const levelSeed = seedOf('level')
assert.equal(stringifyLevelDocument(parseLevelDocument(levelSeed)), levelSeed, '.level 种子应能原样往返')
assert.equal(sourcePathOf({ name: newFileName(type('level'), '新地图') }), 'src/level/新地图.level')
assert.equal(sourceKindOf(newFileName(type('level'), '新地图')), 'level')

// 多进度 `.quest`：树图文档
const flowSeed = seedOf('hflow', '序章流程')
const flow = parseFlow(flowSeed)
assert.equal(flow.format, 'hanshu.progress-tree')
assert.equal(flow.progress[flow.start]?.questTitle?.text, '序章流程', '多进度种子标题由唯一开始进度承载')
assert.equal(newFileName(type('hflow'), '示例'), '示例.quest')

// `.ttsservice`：必须**通过结构校验**（否则它连方案的服务下拉都进不去）
const serviceSeed = seedOf('ttsservice')
const serviceRead = readServiceDefinition(serviceSeed, 'my-service', presets)
assert.ok(serviceRead.ok, `.ttsservice 种子应通过结构校验：${JSON.stringify(serviceRead.issues)}`)
assert.equal(serviceRead.value.provider, presets[0]!.id)
// `protocol` 是**派生值**，定义里不写（写了反而要跟预设比对）；生效值由 `resolveService` 折叠出来
assert.equal(serviceRead.value.protocol, undefined, 'protocol 是派生值，不该写进定义')
assert.equal(
  resolveService(serviceRead.value, 'my-service', presets).protocol,
  presets[0]!.protocol,
  '生效协议应来自预设',
)
assert.deepEqual(
  Object.keys(serviceRead.value.auth),
  AUTH_SHAPES[PROTOCOLS[presets[0]!.protocol].authShape].map((field) => field.key),
  'auth 里该按协议的凭据形态起好引用名',
)

// `.tts`：有语言、有服务时，结构上只差一个音色 id（厂商账号下的值，新建时无从得知）
const planRead = readVoicePlan(seedOf('tts', '林砚'), '林砚.tts')
assert.deepEqual(
  planRead.issues.filter((issue) => issue.level === 'error').map((issue) => issue.path),
  ['voices.zh_cn.voice'],
  '.tts 种子在结构上应只缺音色 id（写个占位串比缺一个键坏得多）',
)
assert.equal(planRead.value.voices.zh_cn?.service, 'my-service')
// 预设声明了固定音色表时（如 [OI]）应当预填 —— 那时它就该完全合法
const planWithVoice = readVoicePlan(
  type('tts').seed('林砚', { ...ctx, firstVoiceId: 'alloy' }),
  '林砚.tts',
)
assert.ok(planWithVoice.ok, `有固定音色表时应完全合法：${JSON.stringify(planWithVoice.issues)}`)
assert.equal(planWithVoice.value.voices.zh_cn?.voice, 'alloy')
// 工程里一条语言都没有：`voices` 只能是空的，报"至少要有一条语言"（那种工程本来也配不了音）
const planNoLocale = readVoicePlan(
  type('tts').seed('林砚', { ...ctx, firstLocale: null }),
  '林砚.tts',
)
assert.ok(
  planNoLocale.issues.some((issue) => issue.path === 'voices' && issue.level === 'error'),
  '没有工程语言时应报缺语言，而不是悄悄写一个不存在的语言',
)

// ===== 4. defaultBase 与 validateBase 的边界 =====

for (const item of NEW_FILE_TYPES) {
  assert.equal(
    validateNewFileBase(item, item.defaultBase),
    null,
    `${item.id} 的 defaultBase「${item.defaultBase}」自己都过不了校验`,
  )
  assert.ok(item.defaultBase.trim(), `${item.id} 的 defaultBase 不能为空`)
  assert.ok(item.hint.trim(), `${item.id} 应有一句说明（下拉里要显示）`)
  // 后缀只能来自注册表：`newFileName` 是唯一拼装点
  assert.ok(newFileName(item, '示例').endsWith(item.ext))
}

const hs = type('hs')
assert.equal(validateNewFileBase(hs, '  '), '名字不能为空')
assert.equal(validateNewFileBase(hs, 'a/b'), '不能含 \\ / : * ? " < > |')
assert.equal(validateNewFileBase(hs, 'a:b'), '不能含 \\ / : * ? " < > |')
// 结尾的**点**必须拦（Windows 会静默丢掉它，资源树名与磁盘名就对不上）
assert.equal(validateNewFileBase(hs, '序章.'), '结尾不能是点')
// 首尾空白是**修掉**而不是报错：用户多半正打到一半，而 `newFileName` 本来就 trim。
// （这条同时钉死"结尾不能是空格"那句过时文案的删除 —— 空格不报错，是被 trim 掉的）
assert.equal(validateNewFileBase(hs, ' 序章 '), null)
assert.equal(validateNewFileBase(hs, '序章 '), null)
assert.equal(newFileName(hs, ' 序章 '), '序章.hs')
assert.equal(validateNewFileBase(hs, '.'), '这个名字不能用')
// 用户把后缀也敲进来：拦下来，否则会建出 `序章.hs.hs`
assert.match(String(validateNewFileBase(hs, '序章.hs')), /不用写后缀/)
assert.match(String(validateNewFileBase(hs, '设定.md')), /不用写后缀/)
// 但不能误伤合法基名：`v1.2` 的"后缀"是 `.2`，`getExtension` 会把它当后缀
assert.equal(validateNewFileBase(hs, 'v1.2'), null, '版本号形态的基名不该被当成写了后缀')
assert.equal(validateNewFileBase(hs, '第 1 章'), null, '中间的空格是允许的')

/*
 * Windows 保留设备名。目标外壳是 Windows 桌面（Tauri + 真实文件系统），
 * 建出 `CON.hs` 会在**落盘那一步**才炸，那时错误信息离"名字"已经很远。
 * 判据：大小写不敏感，且只看第一个点之前那一段（`NUL.txt` 与 `NUL` 等价）。
 */
for (const reserved of ['CON', 'con', 'Con', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'LPT9', 'COM0', 'LPT0', 'CONIN$', 'CONOUT$']) {
  assert.match(
    String(validateNewFileBase(hs, reserved)),
    /Windows 保留设备名/,
    `${reserved} 是 Windows 保留设备名，必须拦下`,
  )
}
// 带扩展名也算（第一个点之前那一段是设备名）
assert.match(String(validateNewFileBase(hs, 'NUL.txt')), /Windows 保留设备名/)
assert.match(String(validateNewFileBase(hs, 'con.foo.bar')), /Windows 保留设备名/)
// 但不能误伤"以保留名开头"的普通名字（判据是整段相等，不是前缀）
assert.equal(validateNewFileBase(hs, 'CONSOLE'), null, 'CONSOLE 不是保留名')
assert.equal(validateNewFileBase(hs, 'NULL'), null, 'NULL 不是保留名')
assert.equal(validateNewFileBase(hs, 'COM10'), null, 'COM10 不是保留名（只有 COM0–COM9）')
assert.equal(validateNewFileBase(hs, '我的CON'), null, '保留名只在整段相等时才拦')

/*
 * 长度上限：真正的约束是整条路径的 MAX_PATH 260，而包根由用户选、可以很深。
 * 边界取两端（等于上限放行、超一个字符拦下），免得以后有人把 `>` 改成 `>=` 没人发现。
 */
assert.equal(validateNewFileBase(hs, 'x'.repeat(MAX_BASE_LENGTH)), null, '正好到上限应放行')
assert.match(
  String(validateNewFileBase(hs, 'x'.repeat(MAX_BASE_LENGTH + 1))),
  /名字太长/,
  '超一个字符就该拦下',
)
assert.ok(MAX_BASE_LENGTH <= 200, '基名上限要给整条路径留出余量（MAX_PATH 260）')

// `.ttsservice` 的基名同时是服务 id，会拼进凭据引用（app:<id>）—— 只能是 ASCII
const service = type('ttsservice')
assert.equal(validateNewFileBase(service, 'my-service'), null)
assert.match(String(validateNewFileBase(service, '我的服务')), /只能用字母、数字/)
// 判据与 tts/spec 的 CREDENTIAL_REF_RE 一致：这个名字最终要进 auth 的引用
assert.equal(validateNewFileBase(service, 'a_b.c-d'), null)
// 保留设备名那一条对每种类型都生效（它判在通用规则里，不在各条目的 validateBase）
assert.match(String(validateNewFileBase(service, 'CON')), /Windows 保留设备名/)

console.log('verify-new-file-types: ok')
