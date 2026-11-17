/**
 * Agent 锁 → UI 目标映射的纯函数验收（阶段 1-D2/1-C2）。
 *
 * 重点钉死「两个口径必须分开」：
 * - `.lang` 锁只让该语言文件只读，**不能**把源文件编辑器也变成只读；
 * - 自动成键抑制才把派生 `.lang` 锁映射回所属源文件；
 * - 资源树删除目录时，目录内有被锁资产就必须拒绝。
 *
 * 跑法：`node scripts/run-verification.mjs scripts/verify-agent-lock-targets.ts`
 */

import assert from 'node:assert/strict'
import {
  folderHasLockedAsset,
  isLockedAssetPath,
  sourceNameFromLangAssetPath,
  splitAgentLockPaths,
} from '../src/workspaces/stageplay/agentLockTargets'

const SOURCE = '序章.hs'
const SOURCE_CHAR = '角色/主角.char'
const LANG = 'assets/zh_cn/lang_hs/序章.lang'
const LANG_CHAR = 'assets/zh_cn/lang_char/角色/主角.lang'
const VOICE = 'assets/zh_cn/voice_hs/序章/7f3a91c2.ogg'

/* ── `.lang` → 源文件逻辑名 ── */
assert.equal(sourceNameFromLangAssetPath(LANG), SOURCE)
assert.equal(sourceNameFromLangAssetPath(LANG_CHAR), SOURCE_CHAR)
assert.equal(sourceNameFromLangAssetPath('assets\\zh_cn\\lang_hs\\序章.lang'), SOURCE, '反斜杠路径也要认')
assert.equal(sourceNameFromLangAssetPath(VOICE), null, '语音资产没有对应源文件')
assert.equal(sourceNameFromLangAssetPath('assets/zh_cn/lang_hs/序章.txt'), null, '非 .lang 不算语言文本')
assert.equal(sourceNameFromLangAssetPath('src/hanshu/序章.hs'), null, '源路径不是语言资产')
assert.equal(sourceNameFromLangAssetPath(LANG.replace('.lang', '.lang.tmp')), null)

/* ── 拆分视图 lockedPaths：只读集合 vs 自动成键集合 ── */
const mixed = splitAgentLockPaths([SOURCE, LANG, 'assets/zh_cn/lang_hs/角色.lang', VOICE])

assert.deepEqual([...mixed.sourceNames], [SOURCE], '源文件只读集合只认 lock_source')
assert.ok(
  !mixed.sourceNames.has('角色.hs'),
  '`.lang` 锁不能让源文件编辑器只读（这正是要修的 over-blocking）',
)
assert.deepEqual(
  [...mixed.assetPaths].sort(),
  [LANG, 'assets/zh_cn/lang_hs/角色.lang', VOICE].sort(),
  '资产只读集合原样保留工程相对路径（含语音，删除目录时要能识别）',
)
assert.ok(mixed.autoKeyBlockedSources.has(SOURCE), '源文件锁本身当然抑制自动成键')
assert.ok(mixed.autoKeyBlockedSources.has('角色.hs'), '`.lang` 锁要抑制所属源文件的自动成键')
assert.ok(!mixed.autoKeyBlockedSources.has('其他.hs'), '未被锁的文件不受影响')

/* ── 只有语言锁：源文件可编辑、成键抑制；只有语音锁：只读该资产、不抑制成键 ── */
const langOnly = splitAgentLockPaths([LANG_CHAR])
assert.equal(langOnly.sourceNames.size, 0, '语言锁不锁源正文')
assert.ok(langOnly.autoKeyBlockedSources.has(SOURCE_CHAR), '语言锁抑制所属源文件自动成键')

const voiceOnly = splitAgentLockPaths([VOICE])
assert.equal(voiceOnly.autoKeyBlockedSources.size, 0, '语音资产不参与成键抑制')
assert.ok(voiceOnly.assetPaths.has(VOICE))

/* ── 去重 / 空输入 / 空白路径 ── */
const duplicated = splitAgentLockPaths([
  SOURCE,
  SOURCE,
  'assets/zh_cn/lang_hs/角色.lang',
  'assets/zh_cn/lang_hs/角色.lang',
])
assert.equal(duplicated.sourceNames.size, 1)
assert.equal(duplicated.assetPaths.size, 1)
assert.equal(duplicated.autoKeyBlockedSources.size, 2, '源名与派生源名各一条')
assert.deepEqual([...splitAgentLockPaths([]).sourceNames], [])
assert.deepEqual([...splitAgentLockPaths(['  ']).sourceNames], [], '空白路径忽略')

/* ── 路径归一：模型可能传 `src/…`，解析回调负责落到实际脚本名 ── */
const resolved = splitAgentLockPaths(['src/hanshu/序章.hs'], (candidate) =>
  candidate === 'src/hanshu/序章.hs' ? SOURCE : null,
)
assert.deepEqual([...resolved.sourceNames], [SOURCE])
assert.ok(resolved.autoKeyBlockedSources.has(SOURCE))
const thrown = splitAgentLockPaths(['重复名.hs'], () => {
  throw new Error('资源名称不唯一')
})
assert.deepEqual([...thrown.sourceNames], ['重复名.hs'], '解析歧义时退回原样，精确匹配仍会保护')

/* ── 资产路径命中（未规范化的相对路径也要认） ── */
const lockedAssets = new Set([LANG])
assert.ok(isLockedAssetPath(lockedAssets, LANG))
assert.ok(isLockedAssetPath(lockedAssets, 'assets\\zh_cn\\lang_hs\\序章.lang'))
assert.ok(!isLockedAssetPath(lockedAssets, 'assets/zh_cn/lang_hs/角色.lang'))

/* ── 目录删除：目录内（含深层子目录）有被锁资产即拒绝 ── */
assert.ok(folderHasLockedAsset(lockedAssets, 'assets/zh_cn/lang_hs'), '父目录包含被锁语言文件')
assert.ok(folderHasLockedAsset(lockedAssets, 'assets/zh_cn'), '祖先目录同样包含')
assert.ok(folderHasLockedAsset(lockedAssets, 'assets'), 'assets 根')
assert.ok(!folderHasLockedAsset(lockedAssets, 'assets/en_us/lang_hs'), '兄弟语言目录不受影响')
assert.ok(!folderHasLockedAsset(lockedAssets, 'assets/zh_cn/lang_hs/序章'), '前缀相同但不是目录边界不算')
assert.ok(!folderHasLockedAsset(new Set(), 'assets'), '没有锁时删目录不被拦')

console.log(
  '通过：Agent 锁目标映射（源锁/语言锁只读分离、成键抑制、路径归一、目录删除判定）',
)
