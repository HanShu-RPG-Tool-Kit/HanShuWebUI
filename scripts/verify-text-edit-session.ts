/**
 * 「编辑会话」的交互不变量：**出框必须提交** + **成键落位动画只放一次**。
 *
 * 守的是两条真实缺陷 / 易错点：
 * 1. 改完译文用方向键挪出边界（左右在首/末字符、上下在首行/末行），编辑框是关了，
 *    但一个字段都没写 —— 改动静默消失。而且它**看起来和提交成功一模一样**
 *    （框没了、光标也挪走了），属于最难发现的那种丢数据。
 * 2. 成键是静默跳变，所以补了一次落位高亮；但那条动画**必须只放一次** ——
 *    每次 render 都重挂的话，滚动一下、换一下语言就满屏闪。
 *
 * 为什么只能读源码来守：这两条不变量横跨三个文件的三段代码（TextEditBox 的按键判定 →
 * `TextEditRequest.exit` → `migrateNow` / `render`），各自都需要 DOM / Monaco / 输入法事件，
 * node 里跑不起来，而中间没有一个可以独立抽出来的纯函数
 * （宽度那套能抽成 textLiveGeometry，是因为它本来就是纯算术）。
 * 与 `verify-hs-diagnostic-symbols` 读源码同一手法。
 *
 * **每条断言都先确认标记找得到再比顺序** —— `indexOf` 返回 -1 时 `slice(-1)` 会给出
 * 末尾一个字符，`length > 0` 照样成立，整条断言就变成空跑（这类恒真守卫在本仓库
 * 真出现过一次，见 verify-text-live-geometry 里那条装配检查的注释）。
 *
 * 跑：`npx tsx scripts/verify-text-edit-session.ts`
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

/** 取某段函数体：从 `marker` 起，到下一个顶层 `}` + 换行（够用的近似，注释已剥） */
function sliceFrom(source: string, marker: string, limit = 4000): string {
  const at = source.indexOf(marker)
  assert.ok(at >= 0, `找不到 marker「${marker}」—— 改名了就把这条断言一起改`)
  return source.slice(at, at + limit)
}

/**
 * 按**大括号配平**取 `marker` 处那个函数/对象的函数体。
 *
 * 别用定长切片：`sliceFrom(src, 'const render = () => {', 20000)` 这类写法会越界，
 * 把后面十几个无关函数一起圈进断言范围 —— 断言的含义（"render 里没有 X"）
 * 就变成"render 和它后面那一串里都没有 X"，将来别处出现 X 会误报，
 * 而 render 自己长长了又会漏报。
 */
function bodyAt(source: string, marker: string): string {
  const at = source.indexOf(marker)
  assert.ok(at >= 0, `找不到 marker「${marker}」—— 改名了就把这条断言一起改`)
  const open = source.indexOf('{', at)
  assert.ok(open >= 0, `「${marker}」后面找不到 {`)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(at, i + 1)
    }
  }
  assert.fail(`「${marker}」的大括号没有配平`)
}

const editor = readCode('src/monaco/textEditor.ts')
const editBox = readCode('src/TextEditBox.tsx')

test('出框会写草稿，而且写在关框之前（这条就是"出框丢译文"的回归防线）', () => {
  const exitBody = sliceFrom(editor, 'exit: (direction: TextEditExitDirection')
  const writeAt = exitBody.indexOf('writeDraft(box.mode, box.draft)')
  assert.ok(
    writeAt >= 0,
    'exit 必须把草稿写下去（writeDraft）—— 少了它就是缺陷本身：方向键挪出边界不保存',
  )
  const clearAt = exitBody.indexOf('clearEditingBox()')
  assert.ok(clearAt >= 0, 'exit 里应有 clearEditingBox()')
  assert.ok(
    writeAt < clearAt,
    '顺序必须是"先写草稿、再关编辑框"：writeDraft 读的是 activeEdit 上的那两份值' +
      '（draft / initialDraft），clearEditingBox 会把 activeEdit 摘成 null',
  )
})

test('没改过就不写映射：TextMap.set 每次都会 emit + flush，白写一次带一次落盘', () => {
  const exitBody = sliceFrom(editor, 'exit: (direction: TextEditExitDirection')
  assert.ok(
    exitBody.includes('box.draft !== box.initialDraft'),
    'exit 要先判"改没改"（与打开的初始值比），不能无条件写',
  )
})

test('出框与提交共用同一份写入逻辑，不再各写一份', () => {
  const applyBody = sliceFrom(editor, 'apply: (next: string, reason: TextEditCommitReason)')
  assert.ok(
    applyBody.includes('writeDraft(mode, next)'),
    'apply（回车 / 点外部）必须走 writeDraft，否则撤销栈的 pushUndoStop 成对包裹会分叉',
  )
  // 改键名的正文替换只应有一处：分两处写，迟早有一处忘记配对的 pushUndoStop
  assert.equal(
    editor.split("executeEdits('hanshu-locale-retarget'").length - 1,
    1,
    '改键名的 executeEdits 只应出现一次（都在 writeDraft 里）',
  )
})

test('写入偏移一律按 key 现取：编辑期间别处成键会挪动正文，旧偏移会改坏错位的字符', () => {
  /*
   * 编辑框开着的时候，220ms 防抖的自动成键会给**别的**语句换键名（原文 → 8 位键名，
   * 长度变了），被编辑这条的 start / end 会整体位移。拿打开那一刻的旧偏移去
   * `executeEdits`，替换就落在错位的 8 个字符上 —— 静默改坏正文。
   * 所以 writeDraft **不接受**调用方传进来的 span，自己按 key 现取。
   */
  const writeBody = bodyAt(editor, 'const writeDraft = (target: TextEditMode, next: string)')
  assert.ok(writeBody.includes('spanFor(key)'), 'writeDraft 要按 key 现取偏移')
  assert.equal(
    /writeDraft\([^)]*\bspan\b/.test(editor),
    false,
    '不该再有任何调用方把 span 传给 writeDraft —— 那正是"两条入口口径不一致"的来源',
  )
})

test('还原开关按"画出来的东西"算：编辑期间的 render 不许把它抹掉', () => {
  /*
   * `liveDirty` 的含义是「覆盖层显示的不是映射里的值」。`render()` 重建时，
   * "正在编辑的那一条"画的是**草稿**（见 renderDisplayText），所以那一帧建完之后
   * 相对映射**仍然是脏的** —— 编辑结束时还得靠 restoreOverlayAfterEditing() 再画一次。
   *
   * 这里曾经是函数开头一句无条件的 `liveDirty = false`：编辑期间任何一次 render
   * （别处自动成键、配音状态变化、防抖收尾）都会把开关抹掉，之后按 Esc 的还原变成空操作，
   * 框里留着刚被取消掉的草稿 —— 看起来像"取消没生效"。
   *
   * 行为层面这条要 Monaco + DOM 才能真跑，所以这里守的是**结构**：
   * 脏标记必须由"这一帧画出来的是什么"推导，而不是无脑清零。
   */
  const renderBody = bodyAt(editor, 'const render = () => {')
  assert.ok(renderBody.includes('liveDirty = drewDraft'), 'render 收尾要按 drewDraft 重算脏标记')
  assert.ok(
    renderBody.includes('display !== renderDisplayText({ editing: null, key, value, ctrlHeld })'),
    '要拿"正在编辑那条的实际显示"与"按映射渲染"比 —— 两者不同才算脏',
  )
  // 唯一的无脑清零只允许出现在"一条都没画"的早退分支里
  const blindClears = renderBody.match(/liveDirty = false/g) ?? []
  assert.equal(blindClears.length, 1, 'render 里只该有一处 liveDirty = false（无 model/map 的早退）')
  assert.ok(
    renderBody.indexOf('liveDirty = false') > renderBody.indexOf('if (!model || !map)'),
    '那唯一一处清零必须在"没有 model / map、什么都没画"的早退分支里',
  )
})

test('非法键名出不去：先就地标红、留在框里，而不是"按了没反应"', () => {
  const exitKeyBody = sliceFrom(editBox, 'const maybeExit = (')
  const validateAt = exitKeyBody.indexOf('!normalizeLocaleKey(draft)')
  assert.ok(
    validateAt >= 0,
    'TextEditBox 要在出框前用 normalizeLocaleKey 拦一道：编辑器那边只能返回"没出去"，' +
      '用户看到的会是"按方向键没反应"，不知道是键名错了',
  )
  const setInvalidAt = exitKeyBody.indexOf('setInvalid(true)', validateAt)
  assert.ok(setInvalidAt >= 0, '拦住之后要标红（setInvalid(true)），与回车提交被拒同一反馈')
  const callExitAt = exitKeyBody.indexOf('exitRef.current(direction')
  assert.ok(callExitAt >= 0, '找不到 exitRef.current(...) 调用')
  assert.ok(
    validateAt < callExitAt,
    '校验必须在真正出框之前（顺序反了等于没拦）',
  )
})

console.log(`\n${passed} text-edit-session checks passed.`)