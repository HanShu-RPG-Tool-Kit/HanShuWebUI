import assert from 'node:assert/strict'
import {
  atomicRegion,
  boxLineAt,
  clampOffset,
  exitCaretTarget,
  exitLineFor,
  hitCaretBox,
  indexAtX,
  isPressEcho,
  isSameSpot,
  keyReplacementFor,
  lineIndexOfOffset,
  lineStartOffset,
  lineXForOffset,
  offsetAtLineX,
  PRESS_ECHO_TOLERANCE_PX,
  PRESS_ECHO_WINDOW_MS,
  slotAtX,
  snapTarget,
  type LineSlot,
} from '../src/monaco/textKeyRules.ts'
import { parseTextSpans } from '../src/monaco/textSpans.ts'
import { blockCloserLine } from '../src/hanshu/hsSyntaxRules.ts'

let passed = 0
function test(name: string, check: () => void) {
  check()
  passed++
  console.log(`[OK] ${name}`)
}

/** 正文：`test:KEY//`，框覆盖键名 KEY（offset 5..8） */
const TEXT = 'test:KEY//'
const KEY = atomicRegion({ start: 5, end: 8 })
/** 光标落点是否"贴着框"（框内 / 两侧框沿都算），与 textEditor.handleCaretEnter 同源 */
const onBox = (offset: number) => hitCaretBox([KEY], offset)
/** 光标落点是否被"整体跳过框"的兜底规则搬走（只有严格落进框内才搬） */
const snapped = (offset: number, dir: 'left' | 'right') =>
  snapTarget([KEY], offset, dir)

test('框覆盖键名本体，原子范围退化时不越界', () => {
  assert.deepEqual(KEY, { start: 5, end: 8 })
  assert.deepEqual(atomicRegion({ start: 5, end: 5 }), { start: 5, end: 5 })
})

test('框内与两侧框沿都算"贴着框"，框外一步不算', () => {
  for (const offset of [5, 6, 7, 8]) assert.ok(onBox(offset), `${offset} 应贴框`)
  assert.equal(onBox(4), null)
  assert.equal(onBox(9), null)
})

test('贴框落点带出框内比例：左沿 0、右沿 1、中点 0.5', () => {
  assert.equal(onBox(5)?.fraction, 0)
  assert.equal(onBox(8)?.fraction, 1)
  assert.equal(onBox(6)?.fraction, 1 / 3)
  // 退化的空范围不产生 NaN（insertion 位置）
  assert.equal(hitCaretBox([{ start: 5, end: 5 }], 5)?.fraction, 0)
})

test('左右出框多走一步：框外一步，不会停在框沿', () => {
  const left = exitCaretTarget(KEY, 'left', TEXT.length)
  assert.deepEqual(left, { offset: 4, guard: false })
  const right = exitCaretTarget(KEY, 'right', TEXT.length)
  assert.deepEqual(right, { offset: 9, guard: false })
  // 落到框外一步 → 不贴框 → 编辑框保持关闭
  assert.equal(onBox(left.offset), null)
  assert.equal(onBox(right.offset), null)
})

test('框贴着文档头 / 尾时出框退回框沿，并屏蔽回吸', () => {
  const head = exitCaretTarget({ start: 0, end: 3 }, 'left', 12)
  assert.deepEqual(head, { offset: 0, guard: true })
  const tail = exitCaretTarget({ start: 9, end: 12 }, 'right', 12)
  assert.deepEqual(tail, { offset: 12, guard: true })
  // 越界那一格本来就是框沿：屏蔽掉就不会被回吸
  assert.ok(hitCaretBox([{ start: 0, end: 3 }], head.offset))
  assert.equal(exitCaretTarget({ start: 4, end: 8 }, 'left', 12).guard, false)
})

test('左右来回走：光标在框内 / 框外一步之间摆动，不漂移、不吞键', () => {
  // 模拟 textEditor 的连续光标：
  // - 编辑框关着：按方向键 → Monaco 先挪一格，落点贴框就打开编辑框
  // - 编辑框开着：输入框里挪，到框内边缘再往外一步 → 出框到框外一步
  let offset = 4
  let boxIndex: number | null = null
  const press = (dir: 'left' | 'right') => {
    if (boxIndex == null) {
      offset = clampOffset(offset + (dir === 'left' ? -1 : 1), TEXT.length)
      const hit = onBox(offset)
      if (hit) boxIndex = Math.round(hit.fraction * 8)
      return
    }
    const atEdge = dir === 'left' ? boxIndex === 0 : boxIndex === 8
    if (!atEdge) {
      boxIndex += dir === 'left' ? -1 : 1
      return
    }
    const target = exitCaretTarget(KEY, dir, TEXT.length)
    assert.equal(target.guard, false)
    offset = target.offset
    boxIndex = null
  }
  const caretMark = () => TEXT.slice(0, offset) + '|' + TEXT.slice(offset)

  // 从框左边往右：进框 → 一路到框内右沿 → 出框到框外一步
  press('right')
  assert.equal(boxIndex, 0)
  for (let i = 0; i < 8; i++) press('right')
  assert.equal(boxIndex, 8)
  press('right')
  assert.equal(boxIndex, null)
  // 框右沿（offset 8，紧挨着 `//`）本身是进框信号，所以往右出框要跨到 `//` 中间（offset 9）
  assert.equal(offset, 9)
  assert.equal(caretMark(), 'test:KEY/|/')

  // 再往左：又贴着框右沿 → 进框 → 一路到框内左沿 → 出框到框外一步
  press('left')
  assert.equal(boxIndex, 8)
  for (let i = 0; i < 8; i++) press('left')
  assert.equal(boxIndex, 0)
  press('left')
  assert.equal(boxIndex, null)
  assert.equal(offset, 4)
  // 出框落在框外一步（不是框沿），所以下一拍不会被立刻吸回编辑框
  assert.equal(caretMark(), 'test|:KEY//')
  assert.equal(onBox(offset), null)

  // 长时间随机按方向键：每一按都必须有响应（不吞键），编辑框关着时光标绝不落在框上
  // （落在框上就说明这一拍会被吸回编辑框里 —— 那是"挪不出来"的 bug）
  let seed = 20240607
  for (let i = 0; i < 400; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648
    const dir: 'left' | 'right' = seed % 2 === 0 ? 'left' : 'right'
    const before = `${offset}:${boxIndex}`
    press(dir)
    const after = `${offset}:${boxIndex}`
    // 已经贴在文档头 / 尾时那一按本来就无处可去（与编辑器一致），其余每一按都得有响应
    const atEdge =
      (dir === 'left' && offset === 0) || (dir === 'right' && offset === TEXT.length)
    if (!atEdge) assert.notEqual(after, before, `第 ${i} 按没响应（dir=${dir}）`)
    assert.ok(offset >= 0 && offset <= TEXT.length, `off=${offset}`)
    if (boxIndex == null) assert.equal(onBox(offset), null, `第 ${i} 按停在框上`)
  }
})

test('框贴文档头时出框：停框沿 + 屏蔽回吸，第二按不会再弹开编辑框', () => {
  const head = { start: 0, end: 3 }
  const art = 'KEY//'
  let guard: number | null = null
  let opened = false
  // 编辑框里按左键：越界 → 停框沿，且这一格要屏蔽回吸
  const exitLeft = () => {
    const target = exitCaretTarget(head, 'left', art.length)
    guard = target.guard ? target.offset : null
    opened = false
  }
  // 光标事件：贴框就开编辑框，但被屏蔽的那一格不算
  const moveCaret = (offset: number) => {
    if (guard != null && guard === offset) {
      guard = null
      return
    }
    opened = hitCaretBox([head], offset) != null
  }
  exitLeft()
  assert.equal(guard, 0)
  moveCaret(0)
  assert.equal(opened, false)
  assert.equal(guard, null)
  // 屏蔽只吃一拍：之后光标正常挪动，贴框仍照常打开编辑框
  moveCaret(1)
  assert.equal(opened, true)
})

test('光标贴框时的插入点：左沿进首字符、右沿进行尾', () => {
  // 与 textEditor.caretIndexInBox 同式：比例 × 框宽，再取最近的字符边界
  const indexAt = (fraction: number, width: number, text: string) => {
    const target = fraction * width
    const charWidth = width / text.length
    return Math.max(0, Math.min(Math.round(target / charWidth), text.length))
  }
  assert.equal(indexAt(onBox(5)!.fraction, 80, '译文译文'), 0)
  assert.equal(indexAt(onBox(8)!.fraction, 80, '译文译文'), 4)
  assert.equal(indexAt(onBox(6)!.fraction, 80, '译文译文'), 1)
})

test('多行值：上下出框前的行判定', () => {
  const text = '第一行\n第二行\n第三行'
  assert.equal(lineIndexOfOffset(text, 0), 0)
  assert.equal(lineIndexOfOffset(text, 3), 0)
  assert.equal(lineIndexOfOffset(text, 4), 1)
  assert.equal(lineIndexOfOffset(text, text.length), 2)
  // 只有首行向上 / 末行向下才出框（中间行归输入框自己翻行）
  const exitUp = (index: number) => lineIndexOfOffset(text, index) === 0
  const exitDown = (index: number) =>
    lineIndexOfOffset(text, index) === lineIndexOfOffset(text, text.length)
  assert.equal(exitUp(0), true)
  assert.equal(exitUp(4), false)
  assert.equal(exitDown(4), false)
  assert.equal(exitDown(text.length), true)
})

test('上下出框的目标行：外面没行就不出框（编辑框留着）', () => {
  // 单行文档、框在首行：往上没地方去
  assert.equal(exitLineFor({ line: 1, endLine: 1 }, 'up', 1), null)
  assert.equal(exitLineFor({ line: 1, endLine: 1 }, 'down', 1), null)
  // 框在首行：往上没有，往下有
  assert.equal(exitLineFor({ line: 1, endLine: 1 }, 'up', 3), null)
  assert.equal(exitLineFor({ line: 1, endLine: 1 }, 'down', 3), 2)
  // 多行值：从首行往上 / 从末行往下（中间行归输入框自己翻）
  assert.equal(exitLineFor({ line: 2, endLine: 4 }, 'up', 9), 1)
  assert.equal(exitLineFor({ line: 2, endLine: 4 }, 'down', 9), 5)
  // 框在文档末行：往下没有
  assert.equal(exitLineFor({ line: 9, endLine: 9 }, 'down', 9), null)
})

test('行首偏移：多行值按行取子串', () => {
  const text = 'ab\ncde\nf'
  assert.equal(lineStartOffset(text, 0), 0)
  assert.equal(lineStartOffset(text, 1), 3)
  assert.equal(lineStartOffset(text, 2), 7)
  // 越界夹到末行 / 空串
  assert.equal(lineStartOffset(text, 9), 7)
  assert.equal(lineStartOffset('', 3), 0)
})

test('clampOffset 夹住框沿再往外一步的越界', () => {
  assert.equal(clampOffset(-1, 10), 0)
  assert.equal(clampOffset(11, 10), 10)
  assert.equal(clampOffset(5, 10), 5)
})

test('框内光标仍被"整体跳过"兜底覆盖（开不了编辑框时的老行为）', () => {
  assert.equal(snapped(6, 'left'), 5)
  assert.equal(snapped(6, 'right'), 8)
  // 框外一步不归它管：那是位置驱动该打开编辑框的地方
  assert.equal(snapped(4, 'right'), null)
  assert.equal(snapped(9, 'left'), null)
})

// ── 上下出框的落点预判（offsetAtLineX） ───────────────────────────────
// 这些算术以前交给 Monaco 的 getTargetAtClientPoint，结果踩了两个坑：
// 邻行是键名框时它命中覆盖层 → 目标无 position → 永远出不了框；
// 它按「列号 × 字符宽」推算列 → 槽位那一段的落点一路偏。
// 现在横向换算全在这条纯算术里，所以这里要把它钉死。

/** 合成字宽：每字符 10px（正文与槽位宽度都按这个量，方便手算） */
const ch10 = (text: string): number => text.length * 10

test('上下落点：普通行按实测宽度落到最近的字缝', () => {
  const line = 'abcdef'
  const at = (x: number) => offsetAtLineX(100, line, x, [], ch10)
  assert.equal(at(-5), 100) // 落在行首左边（行号 / 装订线那侧）→ 行首
  assert.equal(at(0), 100)
  assert.equal(at(4), 100) // 与 0 / 10 等距：偏左（"先到先得"，与 indexAtX 同源）
  assert.equal(at(6), 101)
  assert.equal(at(35), 103) // 3.5 格：等距仍偏左
  assert.equal(at(41), 104)
  assert.equal(at(1e6), 106) // 行尾之外 → 行尾
})

test('上下落点：键名 / 尾标槽位按真实矩形折算回原文 offset', () => {
  // 文档行 `speaker:ABCD1234//译文`：普通文字 `speaker:` 实测 80px，
  // 键名槽位被渲染成译文那么宽（80..140），尾标 `//` 在 142..162
  const line = 'speaker:ABCD1234//译文'
  const slots: LineSlot[] = [
    { start: 508, end: 516, left: 80, width: 60 },
    { start: 516, end: 518, left: 142, width: 20 },
  ]
  const at = (x: number) => offsetAtLineX(500, line, x, slots, ch10)
  assert.equal(at(0), 500)
  assert.equal(at(75), 507) // `speaker:` 的最后一个字缝（80 与 70 等距偏左）
  assert.equal(at(85), 509) // 槽位内 8 位键名按比例：5/60 → 第 1 格
  assert.equal(at(110), 512) // 槽位正中 → 第 4 格
  assert.equal(at(140), 516) // 框右沿 = 键名末格
  assert.equal(at(141), 516) // 框与尾标之间的 2px 缝 → 尾标起点
  assert.equal(at(152), 517) // 两个 `/` 之间：正是"右出框"该落的那一格
  assert.equal(at(162), 518) // 尾标右侧的正文
  assert.equal(at(170), 519)
  assert.equal(at(1e6), 520) // 行尾之外 → 行尾
})

test('上下落点：邻行整行就是键名框（用户报的"上下出不去"那一种）', () => {
  // `ABCD1234//译文`：框从行首开始，上下挪过来时横向基准正落在框里
  const line = 'ABCD1234//译文'
  const slots: LineSlot[] = [
    { start: 200, end: 208, left: 0, width: 60 },
    { start: 208, end: 210, left: 62, width: 20 },
  ]
  const at = (x: number) => offsetAtLineX(200, line, x, slots, ch10)
  assert.equal(at(0), 200)
  assert.equal(at(30), 204)
  assert.equal(at(59), 208)
  assert.equal(at(61), 208) // 框与尾标之间的缝
  assert.equal(at(72), 209)
  assert.equal(at(82), 210)
  // 落点压在紧后面的键名框上 → 位置驱动会直接把那个框打开（不是"出不去"）
  const nextKey = atomicRegion({ start: 208, end: 210 })
  assert.equal(hitCaretBox([nextKey], at(72))?.fraction, 0.5)
})

test('上下落点：量不到矩形的槽位当零宽，不影响后面的字缝', () => {
  // 元素被重建时 slotOf 会返回 null（槽位整条丢掉），退化成"把原文当普通文字量"
  const raw = offsetAtLineX(0, 'preKEYpost', 30, [], ch10)
  assert.equal(raw, 3)
  // 真的传进来零宽槽位也不能崩：左端就是落点，之后的文字仍从同一处继续量
  const zero: LineSlot[] = [{ start: 3, end: 6, left: 30, width: 0 }]
  assert.equal(offsetAtLineX(0, 'preKEYpost', 30, zero, ch10), 3)
  assert.equal(offsetAtLineX(0, 'preKEYpost', 35, zero, ch10), 6)
})

test('上下落点：横向越往右，落点绝不回退（随机扫描）', () => {
  const line = 'speaker:ABCD1234//译文'
  const slots: LineSlot[] = [
    { start: 508, end: 516, left: 80, width: 60 },
    { start: 516, end: 518, left: 142, width: 20 },
  ]
  let previous = -1
  for (let x = -20; x <= 220; x += 0.5) {
    const offset = offsetAtLineX(500, line, x, slots, ch10)
    assert.ok(offset >= 500 && offset <= 520, `x=${x} → ${offset} 越界`)
    assert.ok(offset >= previous, `x=${x} 落点回退（${previous} → ${offset}）`)
    previous = offset
  }
})

test('上下落点：槽位内像素 ↔ offset 互为逆运算，来回挪不漂', () => {
  // 用户报的"上下挪移的光标位置不太准确"，根子是换算不可逆：
  // 编辑器把 offset 折进框内是 (offset - start) / (end - start) → 框宽（见 caretIndexInBox），
  // 所以这里从像素折回 offset 必须用同一把尺子，否则每挪一次就偏一点。
  const line = 'speaker:ABCD1234//译文'
  const slots: LineSlot[] = [{ start: 508, end: 516, left: 80, width: 60 }]
  const span = 8
  const cell = 60 / span
  let checked = 0
  for (let x = 80; x <= 140; x += 0.5) {
    const offset = offsetAtLineX(500, line, x, slots, ch10)
    assert.ok(offset >= 508 && offset <= 516, `x=${x} → ${offset} 跑到槽位外`)
    const back = 80 + ((offset - 508) / span) * 60
    assert.ok(
      Math.abs(back - x) <= cell / 2 + 1e-9,
      `x=${x} 与折回位置 ${back} 相差超过半格`,
    )
    // 幂等：拿折回去的像素再算一次，落点必须一模一样
    assert.equal(offsetAtLineX(500, line, back, slots, ch10), offset)
    checked++
  }
  assert.equal(checked, 121)
})

test('indexAtX 的纯算术版与编辑器里的字缝取法一致', () => {
  assert.equal(indexAtX('abcdef', 0, ch10), 0)
  assert.equal(indexAtX('abcdef', 6, ch10), 1)
  assert.equal(indexAtX('中文abc', 15, ch10), 1)
  assert.equal(indexAtX('中文abc', 35, ch10), 3)
  assert.equal(indexAtX('', 99, ch10), 0)
})

// ── 上下键"进框"的横向基准（lineXForOffset / slotAtX / boxLineAt） ──────────
// 用户报的"光标上下还是明显有问题 / 长度的计算不对等、不可逆"就出在这一段：
// Monaco 的上下键按**列号**走，从 `jafar:` 的第 3 列按下去，光标落在隐藏键名的第 3 格
// —— 那是**框宽（最宽那行）的 3/8**。老算法拿这个比例去预判译文插入点，1 格原文
// 放大成 75px（约 4 个汉字）；反方向从框里挪出来又走的是"实测像素 → 原文 offset"，
// 两把尺子不同源，同一个位置来回挪回不到原处。
// 现在纵向挪移一律以**像素**为基准：进框 = 当前光标实测 x → 框内同一个 x 反推下标，
// 出框 = 框内光标实测 x → 目标行同一个 x 折回 offset；并且进 / 出的"落哪一行"同规则。

/** 合成字宽：拉丁 10px / 汉字 18px（框宽取最宽那行，与 render 的量法一致） */
const mixed = (text: string): number =>
  [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e80 ? 18 : 10), 0)

/** 用户报的那份文档：第 1 行 `jafar:`，第 2 行是隐藏键名，译文两行（宽 540px 的那行撑起框宽） */
const REPORTED = {
  line1: 'jafar:',
  value:
    '一个愿意给你金子的人。\n城外的山洞里有一盏旧油灯。替我取上来，你母亲的药钱就有了。',
}
/** 键名那行（第 2 行）上的槽位：从行首开始，宽 = 最宽那行（黄底框自己的宽度） */
const reportedSlot: LineSlot = {
  start: 0,
  end: 8,
  left: 0,
  width: mixed('城外的山洞里有一盏旧油灯。替我取上来，你母亲的药钱就有了。'),
}

test('上下进框：横向像素按实测宽度算，槽位里按真实矩形线性折算', () => {
  const line = 'jafar:ABCD1234//'
  const slots: LineSlot[] = [{ start: 6, end: 14, left: 60, width: 600 }]
  assert.equal(lineXForOffset(0, line, 3, slots, mixed), 30) // 槽位之前：实测累加
  assert.equal(lineXForOffset(0, line, 6, slots, mixed), 60) // 键名第一格 = 框左沿
  assert.equal(lineXForOffset(0, line, 10, slots, mixed), 360) // 8 格原文铺满 600px 的正中
  assert.equal(lineXForOffset(0, line, 14, slots, mixed), 660) // 键名末格 = 框右沿
  assert.equal(lineXForOffset(0, line, 16, slots, mixed), 680) // 槽位之后的正文接着量
  assert.equal(lineXForOffset(0, line, 99, slots, mixed), 680) // 越界夹到行尾
  // 与 offsetAtLineX 互为逆运算：同一把尺子，来回挪不漂
  const lineLength = line.length
  for (const offset of [0, 2, 3, 5, 6, 7, 10, 13, 14, 15, 16, lineLength]) {
    const x = lineXForOffset(0, line, offset, slots, mixed)
    assert.equal(
      offsetAtLineX(0, line, x, slots, mixed),
      offset,
      `offset ${offset} → x ${x} 折回漂了`,
    )
  }
})

test('上下进框：槽位在像素上命中含两侧框沿，缝里 / 零宽槽位不算', () => {
  const slots: LineSlot[] = [
    { start: 5, end: 8, left: 50, width: 60 },
    { start: 8, end: 10, left: 112, width: 20 },
  ]
  assert.equal(slotAtX(slots, 49), null)
  assert.equal(slotAtX(slots, 50)?.start, 5) // 左沿算在槽位里（框沿就是"贴上框"）
  assert.equal(slotAtX(slots, 110)?.start, 5)
  assert.equal(slotAtX(slots, 112)?.start, 8) // 两个槽位之间的 2px 缝 → 右边那个
  assert.equal(slotAtX(slots, 132)?.start, 8) // 右沿也算
  assert.equal(slotAtX(slots, 133), null)
  assert.equal(slotAtX([{ start: 5, end: 8, left: 50, width: 0 }], 50)?.start, 5)
})

test('上下进框：用户报的 `jafar:` 第 3 / 4 列，落点不再被放大成 7 / 11', () => {
  // 框宽 540px（最宽那行）、译文首行只有 216px。老算法 = (列 − 键名起点) / 8 × 框宽：
  const legacy = (column: number) =>
    indexAtX(
      REPORTED.value.split('\n')[0]!,
      ((column - 6) / 8) * reportedSlot.width,
      mixed,
    )
  assert.equal(legacy(8), 7) // `ja|far:` → 用户实测的 `一个愿意给你金|子的人。`
  assert.equal(legacy(9), 11) // `jaf|ar:` → 用户实测的行尾 `…的人。|`
  // 新算法：拿当前光标的实测像素 x（拉丁 10px），在目标行同一个 x 上找字缝
  // 文档：第 1 行 `jafar:`，第 2 行是键名（框就在第 2 行），从上面按下来 → 值的首行
  const keySpan = { line: 2, endLine: 2 }
  const landing = (column: number) => {
    const x = lineXForOffset(0, REPORTED.line1, column, [], mixed)
    const hit = slotAtX([reportedSlot], x)
    if (!hit) return null
    const lines = REPORTED.value.split('\n')
    const text = lines[boxLineAt(keySpan, 2, lines.length)]!
    return indexAtX(text, x - hit.left, mixed)
  }
  assert.equal(landing(2), 1) // `ja|far:`（x = 20）→ 第 1 格附近（18px 那格）
  assert.equal(landing(3), 2) // `jaf|ar:`（x = 30）→ 第 2 格（36px 那格）
  // 再右一格：拉丁字格（10px）比汉字格（18px）细，相邻两列可以落在同一个汉字格里，
  // 但绝不会像老算法那样一路放大到行尾（那一列实测是 11）
  assert.equal(landing(4), 2)
  assert.equal(landing(6), 3)
})

test('上下进框：进 / 出同一把尺子，同一个位置来回挪收敛不漂', () => {
  const lines = REPORTED.value.split('\n')
  const keySpan = { line: 2, endLine: 2 }
  /** 进框：文档第 1 行第 column 列 → 编辑框里的字符下标 */
  const enter = (column: number) => {
    const x = lineXForOffset(0, REPORTED.line1, column, [], mixed)
    const hit = slotAtX([reportedSlot], x)!
    return indexAtX(lines[boxLineAt(keySpan, 2, lines.length)]!, x - hit.left, mixed)
  }
  /** 出框：编辑框里的字符下标 → 文档第 1 行该落的那一列（实测像素折回 offset） */
  const leave = (index: number) => {
    const text = lines[0]!
    const x = mixed(text.slice(0, index))
    return offsetAtLineX(0, REPORTED.line1, x, [], mixed) // 第 1 行没有槽位
  }
  for (const column of [2, 3, 4, 5]) {
    const first = enter(column)
    const back = leave(first)
    const again = enter(back)
    assert.equal(again, first, `第 ${column} 列来回挪之后落点变了（${first} → ${again}）`)
    // 横向也只在一个汉字格内摆动（18px），不再整行漂
    assert.ok(
      Math.abs(
        mixed(lines[0]!.slice(0, again)) - mixed(lines[0]!.slice(0, first)),
      ) === 0,
      `第 ${column} 列横向漂了`,
    )
  }
})

test('上下进框：多行值的显示行与出框行互为逆运算', () => {
  // 键名框永远落在文档的一行上（整段原文被换成 8 位键名），译文可能有 3 行
  const oneLine = { line: 2, endLine: 2 }
  assert.equal(boxLineAt(oneLine, 1, 3), 0) // 从上面下来 → 首行
  assert.equal(boxLineAt(oneLine, 2, 3), 0) // 就在框首行上 → 首行
  assert.equal(boxLineAt(oneLine, 3, 3), 2) // 从框下面上来 → 末行
  assert.equal(boxLineAt(oneLine, 3, 3, true), 2) // 显式"从下面上来"同解
  assert.equal(boxLineAt(oneLine, 9, 3), 2)
  assert.equal(boxLineAt(oneLine, 0, 0), 0) // 退化：至少一行
  // 出框行由 exitLineFor 算（框首行的上一行 / 框末行的下一行），进框行是它的逆
  assert.equal(exitLineFor(oneLine, 'up', 10), 1)
  assert.equal(exitLineFor(oneLine, 'down', 10), 3)
  assert.equal(boxLineAt(oneLine, exitLineFor(oneLine, 'up', 10)!, 3), 0)
  // 从下面按上来（目标行 = 框自己那行）必须落末行 —— 这就是"出框再进来要回到原行"
  assert.equal(boxLineAt(oneLine, 2, 3, true), 2)
  assert.equal(boxLineAt(oneLine, exitLineFor(oneLine, 'down', 10)!, 3), 2)
  // 多行原文（理论上被折成键名后不会出现，留着兜底）：框内按行差取
  const multi = { line: 2, endLine: 4 }
  assert.equal(exitLineFor(multi, 'down', 10), 5)
  assert.equal(boxLineAt(multi, exitLineFor(multi, 'down', 10)!, 3), 2)
  assert.equal(boxLineAt(multi, 4, 3), 2)
  assert.equal(boxLineAt(multi, 3, 3), 1)
  assert.equal(boxLineAt(multi, 2, 3), 0)
})

// 编辑框级切换（点另一个键框 → 提交当前这份 → 切过去）跨了"按下 / 抬起"两个事件：
// 按下后同一按还会冒出个 click，要按坐标认出来吃掉（否则点 B 开出 C）；
// 抬起时又要确认没挪窝（真要是"点"才兑现切换）。两处判定都是纯算术，在这里钉住。
test('编辑框级切换：同一按的余波认定（click 吃掉 / 抬起兑现）', () => {
  const press = { x: 320, y: 144, at: 10_000 }
  // 同一坐标、时限内 → 是余波
  assert.ok(isPressEcho(press, 320, 144, 10_000))
  assert.ok(isPressEcho(press, 320, 144, 10_000 + PRESS_ECHO_WINDOW_MS - 1))
  // 手抖一点还在容差里
  assert.ok(isPressEcho(press, 320 + PRESS_ECHO_TOLERANCE_PX - 1, 144, 10_001))
  assert.ok(isPressEcho(press, 320, 144 - (PRESS_ECHO_TOLERANCE_PX - 1), 10_001))
  // 超出容差 / 超出时限 / 没记过 → 不是余波（新的一次按下照常开框）
  assert.equal(isPressEcho(press, 320 + PRESS_ECHO_TOLERANCE_PX, 144, 10_001), false)
  assert.equal(isPressEcho(press, 320, 144 + PRESS_ECHO_TOLERANCE_PX, 10_001), false)
  assert.equal(isPressEcho(press, 320, 144, 10_000 + PRESS_ECHO_WINDOW_MS), false)
  assert.equal(isPressEcho(press, 900, 600, 10_000), false)
  assert.equal(isPressEcho(null, 320, 144, 10_000), false)
  // 容差取"小于"：正好等于容差就算另一次按下（宁可多开一次，也不吃掉真实点击）
  assert.equal(isPressEcho(press, 320 + PRESS_ECHO_TOLERANCE_PX, 144, 10_000), false)
})

test('编辑框级切换：抬起时只认"没挪窝"的同一处', () => {
  const press = { x: 320, y: 144 }
  assert.ok(isSameSpot(press, 320, 144))
  assert.ok(isSameSpot(press, 320 + PRESS_ECHO_TOLERANCE_PX - 1, 144))
  assert.ok(isSameSpot(press, 320, 144 + PRESS_ECHO_TOLERANCE_PX - 1))
  // 按着拖走了 → 不算点，这次切换作废
  assert.equal(isSameSpot(press, 320 + PRESS_ECHO_TOLERANCE_PX, 144), false)
  assert.equal(isSameSpot(press, 320, 144 - PRESS_ECHO_TOLERANCE_PX), false)
  assert.equal(isSameSpot(press, 620, 144), false)
})

test('成键只换正文：多行块成键后仍是多行块，不收缩成单行', () => {
  const source = 'narrator:\n夜色压在城墙上。\n卫兵的脚步由远及近。\n//\n'
  const spans = parseTextSpans(source)
  assert.equal(spans.length, 1)
  const span = spans[0]!
  // 替换范围就是正文那两行；换进去的只有键名，不含 `//`、也不吃上下两行
  const rep = keyReplacementFor(span, '7f3a91c2', '\n', () => -1)
  assert.deepEqual(rep, {
    start: source.indexOf('夜色'),
    end: source.indexOf('卫兵的脚步') + '卫兵的脚步由远及近。'.length,
    text: '7f3a91c2',
  })
  const next = source.slice(0, rep.start) + rep.text + source.slice(rep.end)
  assert.equal(next, 'narrator:\n7f3a91c2\n//\n')
  // 再解析：同一个键、仍然单独占一行、`//` 仍独占一行
  const again = parseTextSpans(next)
  assert.equal(again.length, 1)
  assert.equal(again[0]!.value, '7f3a91c2')
  assert.equal(again[0]!.line, 2)
  assert.equal(again[0]!.endLine, 2)
  assert.equal(again[0]!.terminator, null)
})

test('成键：单行语句的键名照旧落在行末', () => {
  const source = 'narrator:夜色压在城墙上。//\n'
  const span = parseTextSpans(source)[0]!
  const rep = keyReplacementFor(span, '7f3a91c2', '\n', () => -1)
  assert.equal(rep.text, '7f3a91c2')
  const next = source.slice(0, rep.start) + rep.text + source.slice(rep.end)
  assert.equal(next, 'narrator:7f3a91c2//\n')
})

test('成键：空体多行块把键名放到 `speaker:` 的下一行（吃掉行尾空白）', () => {
  const source = 'narrator:  \n//\n'
  const span = parseTextSpans(source)[0]!
  // 空体片段的零点在冒号后，行末由调用方给出
  assert.equal(span.start, span.end)
  assert.equal(span.start, 'narrator:'.length)
  assert.equal(span.terminator, null)
  const rep = keyReplacementFor(span, '7f3a91c2', '\n', (line) => {
    assert.equal(line, 1, '空体片段记的是 `speaker:` 那一行')
    return source.indexOf('\n')
  })
  assert.deepEqual(rep, {
    start: 'narrator:'.length,
    end: source.indexOf('\n'),
    text: '\n7f3a91c2',
  })
  const next = source.slice(0, rep.start) + rep.text + source.slice(rep.end)
  assert.equal(next, 'narrator:\n7f3a91c2\n//\n')
})

test('成键：单行空体 `speaker://` 仍是单行，不走多行分支', () => {
  const source = 'narrator://\n'
  const span = parseTextSpans(source)[0]!
  assert.equal(span.terminator != null, true)
  const rep = keyReplacementFor(span, '7f3a91c2', '\n', () => {
    assert.fail('单行语句不该去问行末')
  })
  assert.equal(rep.text, '7f3a91c2')
  const next = source.slice(0, rep.start) + rep.text + source.slice(rep.end)
  assert.equal(next, 'narrator:7f3a91c2//\n')
})

test('没闭合的空体多行块不产出片段：成键不能制造编译错误', () => {
  // `narrator:` 后面什么都没有 → 解析不出片段，成键无从下手（否则会插进一个
  // 没闭合的块里，编译器报「没闭合」）
  assert.deepEqual(parseTextSpans('narrator:\n'), [])
  assert.deepEqual(parseTextSpans('narrator:'), [])
  assert.deepEqual(parseTextSpans('narrator:  \n\n'), [])
  // 闭合了才有空体片段
  const closed = parseTextSpans('narrator:\n//\n')
  assert.equal(closed.length, 1)
  assert.equal(closed[0]!.value, '')
  assert.equal(closed[0]!.terminator, null)
})

test('多行块收尾符行号：只认独占一行的 `//`，撞上结构行就作罢', () => {
  // 标准形态：`speaker:` / 键名 / `//`
  assert.equal(blockCloserLine(['narrator:', '7f3a91c2', '//'], 2), 3)
  assert.equal(blockCloserLine(['narrator:', '7f3a91c2', '//', 'npc:你好。//'], 2), 3)
  // 块里的空行 / 注释不结束语句，收尾符在更后面
  assert.equal(blockCloserLine(['narrator:', 'KEY', '', '# 场景', '//'], 2), 5)
  // 行尾的 `//`（正文行缀）不是收尾符
  assert.equal(blockCloserLine(['narrator:', 'KEY//', '//'], 2), 3)
  // 撞上下一条语句 → 这个块没有收尾符（提交时光标退回框右沿）
  assert.equal(blockCloserLine(['narrator:', 'KEY', '-a:b//'], 2), null)
  assert.equal(blockCloserLine(['narrator:', 'KEY', 'npc:你好。//'], 2), null)
  assert.equal(blockCloserLine(['narrator:', 'KEY', '@next'], 2), null)
  assert.equal(blockCloserLine([], 1), null)
})

console.log(`\n${passed} text-key-rules checks passed.`)