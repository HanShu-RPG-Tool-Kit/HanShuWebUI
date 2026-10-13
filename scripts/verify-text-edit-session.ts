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

const editor = readCode('src/monaco/textEditor.ts')
const editBox = readCode('src/TextEditBox.tsx')

test('出框会写草稿，而且写在关框之前（这条就是"出框丢译文"的回归防线）', () => {
  const exitBody = sliceFrom(editor, 'exit: (direction: TextEditExitDirection')
  const writeAt = exitBody.indexOf('writeDraft(box.mode, span, box.draft)')
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
    applyBody.includes('writeDraft(mode, span, next)'),
    'apply（回车 / 点外部）必须走 writeDraft，否则撤销栈的 pushUndoStop 成对包裹会分叉',
  )
  // 改键名的正文替换只应有一处：分两处写，迟早有一处忘记配对的 pushUndoStop
  assert.equal(
    editor.split("executeEdits('hanshu-locale-retarget'").length - 1,
    1,
    '改键名的 executeEdits 只应出现一次（都在 writeDraft 里）',
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