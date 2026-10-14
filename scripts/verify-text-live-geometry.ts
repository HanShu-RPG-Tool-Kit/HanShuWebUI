import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  TEXT_BOX_GAP_PX,
  liveBoxGeometry,
  liveDisplayText,
  liveSlotWidthPx,
  renderDisplayText,
} from '../src/monaco/textLiveGeometry.ts'
import {
  METER_CACHE_LIMIT,
  evictOldestEntries,
} from '../src/monaco/textSlotStyles.ts'

let passed = 0
function test(name: string, check: () => void) {
  check()
  passed++
  console.log(`[OK] ${name}`)
}

/**
 * 读源码用：D-3 / D-6 那两条不变量只在浏览器里显现，只能钉住语句与调用
 * （与 verify-hs-diagnostic-symbols 读源码同一手法）。
 * CRLF 折成 LF：断言里写的是 `\n`，而这份工作区的检出可能是 CRLF（git 的 autocrlf），
 * 不折的话 `\n  }\n` 这种找函数体结尾的模式永远匹配不上。
 */
const root = new URL('../', import.meta.url)
const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, root)), 'utf8').replace(/\r\n/g, '\n')

/**
 * 去掉注释再做"源码里有没有某段代码"的断言。
 * 必须去：注释里为了解释取舍会**引用**被删掉的老写法（例如 D-6 那条注释里就写着
 * `cache.clear()`），不去的话断言会被自己的说明文字绊倒。
 * 这个文件里没有含 `//` 的字符串字面量，粗糙的正则够用。
 */
const stripComments = (code: string): string =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/**
 * 假的实测宽度：全角按 2 格、其余按 1 格，每格 9px。
 * 刻意**逐字符**算（含空格），这样"行尾空格有没有被量进去"是可断言的 ——
 * 真 meter 那边靠 `white-space: pre` 达到同样效果（见 textSlotStyles）。
 */
const CELL = 9
function fakeWidth(text: string): number {
  let cells = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    cells += code >= 0x2e80 && code <= 0xff60 ? 2 : 1
  }
  return cells * CELL
}

/** 记录每次量了哪些文本：既当实测函数，也用来断言"批量一次量完" */
function recorder() {
  const batches: string[][] = []
  return {
    batches,
    measureWidths(texts: readonly string[]): number[] {
      batches.push([...texts])
      return texts.map(fakeWidth)
    },
  }
}

const KEY = '7f3a91c2'
const LINE_HEIGHT = 28
const geometry = (
  mode: 'key' | 'value',
  draft: string,
  m = recorder(),
  key = KEY,
) => ({
  ...m,
  geo: liveBoxGeometry({
    mode,
    draft,
    key,
    lineHeightPx: LINE_HEIGHT,
    measureWidths: m.measureWidths,
  }),
})

test('value 模式：显示草稿本身，宽度 = 草稿实测宽度', () => {
  const { geo } = geometry('value', '你好')
  assert.equal(geo.display, '你好')
  assert.equal(geo.widthPx, fakeWidth('你好'))
  assert.equal(geo.lineCount, 1)
  assert.equal(geo.needsZone, false)
  assert.equal(geo.zoneHeightPx, 0)
})

test('value 模式：空草稿回退成键名（= placeholder），框不塌成 0 宽', () => {
  const { geo } = geometry('value', '')
  assert.equal(geo.display, KEY)
  assert.equal(geo.widthPx, fakeWidth(KEY))
  // 显示文本是回退来的，但 lines 也按回退后的文本算（框里画的就是它）
  assert.deepEqual(geo.lines, [KEY])
  assert.ok(geo.widthPx > 0)
})

test('key 模式：显示草稿本身；草稿删空时宽度退回键名（光标要有地方站）', () => {
  assert.equal(geometry('key', 'abcd1234').geo.display, 'abcd1234')
  const empty = geometry('key', '').geo
  assert.equal(empty.display, '')
  // 宽度不跟着塌成 0：空显示文本量不出宽度，退回按键名量
  assert.equal(empty.widthPx, fakeWidth(KEY))
  assert.equal(empty.heightPx, LINE_HEIGHT - TEXT_BOX_GAP_PX)
})

test('多行：高度 = 行数 × 行高 − 缝隙，zone 高度 = 多出来的行', () => {
  const one = geometry('value', '第一行').geo
  const two = geometry('value', '第一行\n第二行').geo
  const three = geometry('value', '第一行\n第二行\n第三行').geo
  assert.equal(one.heightPx, LINE_HEIGHT - TEXT_BOX_GAP_PX)
  assert.equal(two.heightPx, 2 * LINE_HEIGHT - TEXT_BOX_GAP_PX)
  assert.equal(three.heightPx, 3 * LINE_HEIGHT - TEXT_BOX_GAP_PX)
  assert.equal(two.zoneHeightPx, LINE_HEIGHT)
  assert.equal(three.zoneHeightPx, 2 * LINE_HEIGHT)
  assert.equal(one.needsZone, false)
  assert.equal(two.needsZone, true)
  assert.equal(three.needsZone, true)
  // 高度单调：多一行必然更高
  assert.ok(two.heightPx > one.heightPx && three.heightPx > two.heightPx)
})

test('多行宽度取各行最大值（不按最长行的字符数、按实测像素）', () => {
  const { geo } = geometry('value', 'ab\n中文更宽\nc')
  assert.equal(geo.widthPx, fakeWidth('中文更宽'))
})

test('随文本变长，宽度单调不减（打字只会变宽或不变，不会忽宽忽窄）', () => {
  const text = '今天天气不错'
  // 从 1 个字开始：**空**草稿是刻意的例外（回退成键名宽度，见上一条用例），
  // 拿它当单调性的起点会把"删空时退回 placeholder"误判成抖动
  let previous = geometry('value', text.slice(0, 1)).geo.widthPx
  for (let i = 1; i <= text.length; i++) {
    const { geo } = geometry('value', text.slice(0, i))
    assert.ok(
      geo.widthPx >= previous,
      `第 ${i} 个字符后宽度 ${geo.widthPx} 不该小于 ${previous}`,
    )
    previous = geo.widthPx
  }
  // 变长确实会变宽（不是常量）
  assert.ok(previous > geometry('value', '今').geo.widthPx)
})

test('行尾空格算进宽度：末尾打空格框要跟着变宽（光标才有地方站）', () => {
  const { geo, batches } = geometry('value', '你好  ')
  assert.equal(geo.display, '你好  ')
  // 量的是**没被 trim 过**的整行
  assert.deepEqual(batches[0], ['你好  '])
  assert.equal(geo.widthPx, fakeWidth('你好  '))
  assert.ok(geo.widthPx > fakeWidth('你好'))
})

test('空行也是真实占位：行数与高度按空行算', () => {
  const { geo } = geometry('value', 'a\n\nb')
  assert.deepEqual(geo.lines, ['a', '', 'b'])
  assert.equal(geo.lineCount, 3)
  assert.equal(geo.heightPx, 3 * LINE_HEIGHT - TEXT_BOX_GAP_PX)
})

test('宽度只量一轮：一次调用只喂一批文本给 meter', () => {
  const { batches } = geometry('value', 'a\nbb\nccc')
  assert.equal(batches.length, 1)
  assert.deepEqual(batches[0], ['a', 'bb', 'ccc'])
})

test('槽位宽度 = 框宽 + 配音按钮（整个原子单位）', () => {
  const { geo } = geometry('value', '你好')
  assert.equal(liveSlotWidthPx(geo.widthPx, 28), geo.widthPx + 28)
  // 量不出宽度（0 / 负数 / NaN）时不产生负槽位
  assert.equal(liveSlotWidthPx(0, 28), 28)
  assert.equal(liveSlotWidthPx(-5, 28), 28)
})

test('D-8 槽位宽度兜底：NaN / ±Infinity / 负数一律折成有限数，不产生 width:NaNpx', () => {
  // 槽位宽度一旦是 NaN，Monaco 那边整条 `width:NaNpx` 规则作废 ——
  // 槽位退回按原文列数撑开，同一行后面的正文整体错位，且错得隐蔽
  assert.equal(liveSlotWidthPx(Number.NaN, 28), 28)
  assert.equal(liveSlotWidthPx(10, Number.NaN), 10)
  assert.equal(liveSlotWidthPx(Number.POSITIVE_INFINITY, 28), 28)
  assert.equal(liveSlotWidthPx(10, Number.POSITIVE_INFINITY), 10)
  assert.equal(liveSlotWidthPx(Number.NEGATIVE_INFINITY, Number.NaN), 0)
  assert.equal(liveSlotWidthPx(10, -3), 10)
  assert.equal(liveSlotWidthPx(-5, -3), 0)
  for (const value of [
    liveSlotWidthPx(Number.NaN, 28),
    liveSlotWidthPx(10, Number.NaN),
    liveSlotWidthPx(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY),
    liveSlotWidthPx(Number.NEGATIVE_INFINITY, -1),
  ]) {
    assert.ok(Number.isFinite(value), `${value} 必须是有限数`)
    assert.ok(value >= 0, `${value} 不能是负宽度`)
  }
})

test('D-6 meter 缓存超限：丢最旧的几条，留下最新的一批（长行量测不再每次全量重来）', () => {
  // 模拟 indexAtX 的一次调用：把「行长 + 1」条前缀全喂进来（行长 600 > 上限 512）
  const cache = new Map<string, number>()
  for (let i = 0; i < 600; i++) cache.set(`p${i}`, i)
  evictOldestEntries(cache, METER_CACHE_LIMIT)
  assert.equal(cache.size, METER_CACHE_LIMIT)
  // 留下的必须是**最新**的那一批：最旧的一段被丢掉，刚量的那段还在
  assert.equal(cache.has('p0'), false, '最旧的键应被淘汰')
  assert.equal(cache.has('p87'), false)
  assert.equal(cache.has('p88'), true, '上限内的最新一批必须留下')
  assert.equal(cache.has('p599'), true, '刚量的那一段必须留下')
  // 插入顺序 = 淘汰顺序（FIFO，不是 LRU）
  assert.equal(cache.keys().next().value, 'p88')
  // 反证修复前的行为：整表清空会让上面几条断言全部失败（size 会变 0）
  assert.ok(cache.size > 0, '整表清空会让缓存对长行完全失效')
})

test('D-6 淘汰策略的边界：上限不合法退化成清空、没超限一条不动、永不抛错', () => {
  const empty = new Map<string, number>()
  evictOldestEntries(empty, 0)
  assert.equal(empty.size, 0)

  const zero = new Map([['a', 1], ['b', 2]])
  evictOldestEntries(zero, 0)
  assert.equal(zero.size, 0, '上限 0 = 不留缓存')

  const nan = new Map([['c', 3]])
  evictOldestEntries(nan, Number.NaN)
  assert.equal(nan.size, 0, '上限是 NaN 时不能留下一个只涨不落的表')

  const negative = new Map([['d', 4]])
  evictOldestEntries(negative, -1)
  assert.equal(negative.size, 0)

  const under = new Map([['x', 1], ['y', 2]])
  evictOldestEntries(under, METER_CACHE_LIMIT)
  assert.deepEqual([...under.keys()], ['x', 'y'], '没到上限时顺序与内容都不许动')
})

test('D-6 上限本身是个够用的正数（缓存占用的上界从无界变成常数）', () => {
  assert.ok(Number.isFinite(METER_CACHE_LIMIT))
  assert.ok(METER_CACHE_LIMIT >= 256, '至少要装得下一屏槽位加最近输入的前缀')
})

test('D-6 装配检查：measure() 真的调了淘汰（不是把 evictOldestEntries 白写在那里）', () => {
  /*
   * 上面几条只证明**淘汰函数本身**对，证明不了 `measure()` 用它。
   * 而 `textSlotStyles.ts` 里 `cache.clear()` 是**合法存在**的（字体指纹变了要整表作废），
   * 所以不能简单断言"源码里没有 cache.clear" —— 只在量完那一段里钉调用。
   */
  const source = stripComments(read('src/monaco/textSlotStyles.ts'))
  const measureAt = source.indexOf('measure(texts) {')
  assert.ok(measureAt >= 0, '找不到 measure（改名了就把这条断言一起改）')
  // 够长以覆盖整段 measure 体（当前约 80 行）
  const body = source.slice(measureAt, measureAt + 6000)
  assert.ok(
    body.includes('evictOldestEntries(cache, METER_CACHE_LIMIT)'),
    'measure() 必须在量完之后调 evictOldestEntries(cache, METER_CACHE_LIMIT)',
  )
  // 量完之后不许再出现整表清空：那正是 D-6（长行每次都超限 → 缓存完全失效）
  /*
   * 标记必须**先确认找得到**再切片。`indexOf` 返回 -1 时 `slice(-1)` 会给回**末尾一个字符**，
   * 于是 `length > 0` 通过、紧接着那条 `includes('cache.clear()')` 也在一个无关字符上通过 ——
   * 整条装配检查就变成空跑（有人重写这行循环时就再也守不住 D-6）。
   */
  const nodesMarker = 'for (const el of nodes) el.remove()'
  const nodesAt = body.indexOf(nodesMarker)
  assert.ok(nodesAt >= 0, '找不到量完那一段（改名了就把这条断言一起改）')
  const afterNodes = body.slice(nodesAt)
  assert.equal(
    afterNodes.includes('cache.clear()'),
    false,
    '量完那一段不能整表清空：长行每次都超限，清空等于缓存对长行完全失效',
  )
  /*
   * 反证：同一条判据喂进"老写法"必须报错，否则它就是恒真的空跑。
   * 这里必须自己造一份**老写法的函数体**再喂给同一个表达式 ——
   * 早先这行写的是把一段字面量丢给 stripComments 再 `includes('cache.clear()')`，
   * 那检的是字符串本身，永远为真，等于什么都没验（注释还声称它证明了"不是恒真"）。
   */
  const legacyBody =
    'for (const el of nodes) el.remove()\n  if (cache.size > METER_CACHE_LIMIT) cache.clear()'
  assert.equal(
    legacyBody.slice(legacyBody.indexOf(nodesMarker)).includes('cache.clear()'),
    true,
    '老写法喂进同一条判据必须被认出来，否则上面那条装配检查是恒真的空跑',
  )
})

test('D-3 渲染口径：编辑目标关掉之后必须回到映射里的值，草稿不许被继承', () => {
  // 正在编辑：显示草稿本身，且**不看** ctrlHeld / 映射（Ctrl 显示锁）
  assert.equal(
    renderDisplayText({
      editing: { mode: 'value', draft: '正在打的草稿' },
      key: KEY,
      value: '映射里的值',
      ctrlHeld: false,
    }),
    '正在打的草稿',
  )
  assert.equal(
    renderDisplayText({
      editing: { mode: 'value', draft: '正在打的草稿' },
      key: KEY,
      value: '映射里的值',
      ctrlHeld: true,
    }),
    '正在打的草稿',
    '编辑期间按 Ctrl 不许改显示模式',
  )
  // 目标已经关掉（activeEdit 被摘掉 → editing 传 null）：回到映射口径
  assert.equal(
    renderDisplayText({
      editing: null,
      key: KEY,
      value: '映射里的值',
      ctrlHeld: false,
    }),
    '映射里的值',
  )
  // 其余条：Ctrl 显示键名、缺译文显示键名
  assert.equal(
    renderDisplayText({ editing: null, key: KEY, value: '值', ctrlHeld: true }),
    KEY,
  )
  assert.equal(
    renderDisplayText({ editing: null, key: KEY, value: null, ctrlHeld: false }),
    KEY,
  )
})

test('D-3 换编辑目标前必须先还原上一个框，且顺序是"先摘 activeEdit、再 render()"', () => {
  /*
   * 这条只能读源码钉顺序：不变量（render 时看不到上一个目标的草稿）的效果只在浏览器里
   * 显现 —— 这里没有能独立于 DOM 抽出来的中间量。而它确实是踩过的坑
   * （编辑期间自动成键搬光标 → handleCaretEnter 落到另一条键名上 → 换目标），
   * 所以退而求其次钉住这一段语句顺序（与 verify-hs-diagnostic-symbols 读源码同一手法）。
   */
  const source = stripComments(read('src/monaco/textEditor.ts'))

  const openAt = source.indexOf('const openEditor = (')
  assert.ok(openAt >= 0, '找不到 openEditor（改名了就把这条断言一起改）')
  const openBody = source.slice(openAt, openAt + 4000)
  assert.ok(
    openBody.includes('restorePreviousEditingBox()'),
    'openEditor 必须先调 restorePreviousEditingBox()：否则上一个框的草稿尺寸会被下一个目标继承',
  )

  const helperAt = source.indexOf('const restorePreviousEditingBox = ')
  assert.ok(helperAt >= 0, '找不到 restorePreviousEditingBox（改名了就把这条断言一起改）')
  const helperEnd = source.indexOf('\n  }\n', helperAt)
  assert.ok(helperEnd > helperAt, '找不到 restorePreviousEditingBox 的函数体结尾')
  const helperBody = source.slice(helperAt, helperEnd)
  const clearAt = helperBody.indexOf('clearEditingBox()')
  const renderAt = helperBody.indexOf('render()')
  assert.ok(
    clearAt >= 0 && renderAt >= 0,
    '还原函数里应同时有 clearEditingBox() 与 render()',
  )
  assert.ok(
    clearAt < renderAt,
    '顺序必须是先 clearEditingBox() 再 render()：render 会读 activeEdit 决定显示什么，' +
      '留着它等于又把上一个目标的草稿渲染了一遍，还原白做',
  )
})

test('显示文本规则可单独调用（渲染路径与实时路径同一口径）', () => {
  assert.equal(liveDisplayText('key', '', KEY), '')
  assert.equal(liveDisplayText('key', 'abcd1234', KEY), 'abcd1234')
  assert.equal(liveDisplayText('value', '', KEY), KEY)
  assert.equal(liveDisplayText('value', '台词', KEY), '台词')
})

console.log(`\n${passed} text-live-geometry checks passed.`)
