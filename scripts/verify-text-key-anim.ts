/**
 * 「成键落位动画」的回归：**只放一次**，而且**不碰几何**。
 *
 * 背景：成键（自动成键 / 敲下 `//`）是静默跳变 —— 原文消失、换成键名加黄底框，
 * 除了"文字变了"没有任何反馈。所以给刚成键那一条补了一次落位高亮。
 * 这条动画有两个容易写坏的地方，也正是这个脚本守的两件事：
 *
 * 1. **必须只放一次**。类名是在 `render()` 里挂的，而 `render()` 被滚动、配音状态变化、
 *    换语言等一大堆路径调用 —— 只要把"刚成键的键名"留到下一次重画，动画就会反复重播，
 *    表现为满屏闪。所以：只有增量路径（打字 / 挪光标触发的防抖）能灌入那个集合，
 *    且 `render()` 用完即清。
 * 2. **必须不动几何**。框的宽高是逐键实时改写的（见 `applyLiveBox`），
 *    动画里掺进 width / height / padding / border 就会与同一拍已经重排好的正文错开，
 *    而框里那行字与输入框是逐像素对齐的，差几像素一眼就看得出来。
 *
 * 为什么读源码：这条不变量跨越 `migrateNow` 与 `render()` 两处，且都要 Monaco 的
 * DOM 才能跑；中间没有能独立抽出来的纯函数（集合本身是 `Set<string>`，抽出来断言
 * 等于什么都没测）。与 `verify-hs-diagnostic-symbols` 读源码同一手法。
 *
 * **每条断言都先确认标记找得到再比顺序** —— `indexOf` 返回 -1 时 `slice(-1)` 会给出
 * 末尾一个字符，`length > 0` 照样成立，整条断言就变成空跑。
 *
 * 跑：`npx tsx scripts/verify-text-key-anim.ts`
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let passed = 0
function test(name: string, check: () => void) {
  check()
  passed++
  console.log(`[OK] ${name}`)
}

/** 读源码并剥掉注释：注释里会引用被替换掉的旧写法，不剥会被自己的说明文字绊倒 */
function readCode(path: string): string {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    // 这份工作区是 CRLF 检出：不归一，`\n  }\n` 这类模式永远匹配不上
    .replace(/\r\n/g, '\n')
}

function sliceFrom(source: string, marker: string, limit = 4000): string {
  const at = source.indexOf(marker)
  assert.ok(at >= 0, `找不到 marker「${marker}」—— 改名了就把这条断言一起改`)
  return source.slice(at, at + limit)
}

const editor = readCode('src/monaco/textEditor.ts')

test('动画的触发源只认增量路径：批量成键（打开文件 / 换语言）不进集合', () => {
  const migrateBody = sliceFrom(editor, 'const migrateNow = (options?: { skipEditing?: boolean })')
  const addAt = migrateBody.indexOf('recentlyKeyed.add(key)')
  assert.ok(addAt >= 0, 'migrateNow 要把新成的键记进 recentlyKeyed，否则动画没有触发源')
  // 触发源必须被增量判据包住
  const guardAt = migrateBody.lastIndexOf('if (options?.skipEditing)', addAt)
  assert.ok(
    guardAt >= 0 && guardAt < addAt,
    'recentlyKeyed 只能由增量路径（options?.skipEditing，即打字 / 挪光标触发的防抖）灌入：' +
      '批量成键一次几百条，闪起来像整篇在抽搐，而且那也不是"用户刚做的事"',
  )
})

test('登记必须发生在正文换成键名之后：早一步登记会被 setMany 顺带的那次 render 清空', () => {
  /*
   * 这条是**真的踩过的坑**：原先 `recentlyKeyed.add` 写在 `map.setMany` 之前，
   * 而 setMany → 订阅回调 → refresh() → render() 是**同步**的 —— 那一刻正文里还是原文、
   * 一条框都建不出来，可 render() 收尾照样清空集合。等 executeEdits 真正换成键名时，
   * 集合已经空了，`classList.add(KEYING_IN_CLASS)` 恒不执行，整段动画变成死代码。
   *
   * 只断言"被 skipEditing 包住"是不够的（那是"别灌太多"），
   * 还必须断言"灌的时机在正文改完之后"（这才是"灌了能兑现"）。
   */
  const migrateBody = sliceFrom(editor, 'const migrateNow = (options?: { skipEditing?: boolean })')
  const addAt = migrateBody.indexOf('recentlyKeyed.add(key)')
  assert.ok(addAt >= 0, '找不到 recentlyKeyed.add(key)')
  const setManyAt = migrateBody.indexOf('map.setMany(entries)')
  assert.ok(setManyAt >= 0, '找不到 map.setMany(entries)（改名了就把这条断言一起改）')
  const editsAt = migrateBody.indexOf("executeEdits('hanshu-locale-key'")
  assert.ok(editsAt >= 0, '找不到 executeEdits(\'hanshu-locale-key\')（改名了就把这条断言一起改）')
  assert.ok(
    addAt > editsAt,
    '登记必须在 executeEdits 把正文换成键名**之后**：写映射是同步的，' +
      'setMany 触发的 refresh() → render() 会在正文还是原文时就把集合清空，动画永远不亮',
  )
  assert.ok(setManyAt < editsAt, '正文替换应发生在写映射之后（先写映射再改正文，见 migrateNow 的注释）')
})

test('render 只读不写：集合的作废必须推迟到本帧绘制前', () => {
  /*
   * 这条是**第二次踩**同一个坑之后立的规矩。
   *
   * 一次成键在**同一个同步任务**里会连跑好几次 render：写映射触发的（那会儿正文还是
   * 原文，一条框都建不出来）、`executeEdits` 触发的、`migrateNow` 收尾的、
   * `scheduleMigrate` 收尾的。浏览器只画**任务结束后**的那一版 DOM，
   * 所以只要中间任何一次 render 把集合清了，最后画出来的那版就没有类 —— 动画一次都不亮。
   *
   * 因此不变量是：**render() 只读不写**，集合的生死由生产者（migrateNow）交给
   * `scheduleKeyingClear()` 去作废。清空只影响将来的 render，已经建出来的元素照样带着类。
   *
   * 作废用 `requestAnimationFrame` 而不是 `setTimeout(0)`：两者都排在当前任务之后，
   * 但 rAF 回调是绘制前**最后一个** JS 钩子 —— `setTimeout(0)` 可能落在画面之后，
   * "画完 → 作废"之间若还有一次 render，新建的框会再挂一次类、动画从 0 重播（看得见）。
   */
  const renderBody = sliceFrom(editor, 'const render = () => {', 20000)
  assert.ok(
    renderBody.includes('box.classList.add(KEYING_IN_CLASS)'),
    'render 要给刚成键的那个框挂 KEYING_IN_CLASS',
  )
  assert.ok(renderBody.includes('recentlyKeyed.has(key)'), 'render 按 key 判断该不该挂类')
  assert.equal(
    renderBody.includes('recentlyKeyed.clear()'),
    false,
    'render 里**不许**清空 recentlyKeyed：同任务里它后面还会再跑好几次 render，' +
      '先清空的话最后画出来的那版框没有类，动画一次都不会亮',
  )

  // 清空只能发生在本帧绘制前：即 scheduleKeyingClear 的 rAF 回调里
  assert.ok(editor.includes('recentlyKeyed.clear()'), '找不到 recentlyKeyed.clear()')
  const scheduleBody = sliceFrom(editor, 'const scheduleKeyingClear = () => {', 400)
  assert.ok(
    scheduleBody.includes('window.requestAnimationFrame') &&
      scheduleBody.includes('recentlyKeyed.clear()'),
    'scheduleKeyingClear 要在 requestAnimationFrame 里清空（绘制前最后一个 JS 钩子，' +
      'setTimeout(0) 可能落在画面之后，那个窗口里的一次 render 会让动画可见地重播）',
  )

  // 生产者登记完就排一次作废；漏了这一步集合会一直留着，之后每次重画都重播动画
  const migrateBody = sliceFrom(editor, 'const migrateNow = (options?: { skipEditing?: boolean })')
  const addAt = migrateBody.indexOf('recentlyKeyed.add(key)')
  assert.ok(addAt >= 0, '找不到 recentlyKeyed.add(key)')
  assert.ok(
    migrateBody.indexOf('scheduleKeyingClear()', addAt) >= 0,
    '登记之后必须紧跟一次 scheduleKeyingClear()，否则集合永远不清、动画每次重画都重播',
  )

  // 全仓只有两处清空：定时器回调 + dispose；也只有一处登记
  assert.equal(
    editor.split('recentlyKeyed.clear()').length - 1,
    2,
    'recentlyKeyed.clear() 应恰好两处：推迟作废的定时器回调 + dispose',
  )
  assert.equal(
    editor.split('recentlyKeyed.add(').length - 1,
    1,
    '登记只应有一处（migrateNow 的增量路径）',
  )
})

test('动画不动几何：只改颜色 / 阴影，绝不碰宽高与内边距', () => {
  const css = readCode('src/App.css')
  const ruleAt = css.indexOf('.hs-lang-box.is-keying-in {')
  assert.ok(ruleAt >= 0, '找不到 .hs-lang-box.is-keying-in 规则')
  const keyframesAt = css.indexOf('@keyframes hs-lang-key-ring', ruleAt)
  assert.ok(keyframesAt > ruleAt, '找不到 @keyframes hs-lang-key-ring（改名了就把这条断言一起改）')
  const rule = css.slice(ruleAt, keyframesAt)
  for (const banned of ['width', 'height', 'padding', 'border:', 'margin']) {
    assert.equal(
      rule.includes(banned),
      false,
      `落位动画不许碰 ${banned}：几何是逐键实时改写的，动画只该动颜色 / 阴影`,
    )
  }
  // 关了动效就不放（纯装饰，没有它成键一样成立）
  assert.ok(
    css.includes('prefers-reduced-motion: reduce'),
    '要有一条 prefers-reduced-motion 的降级：动画纯装饰，系统关了就别放',
  )
})

console.log(`\n${passed} text-key-anim checks passed.`)