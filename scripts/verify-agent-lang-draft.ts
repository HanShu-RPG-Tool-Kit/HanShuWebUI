/**
 * 语言文本草稿（阶段 2-A / 草案 D1）验收。
 *
 * 覆盖：
 * ① 草稿优先读取：staged 覆盖已保存内容，并标 draft=true / savedVersion=null；
 * ② stageWrite 后 `assetEpochs` 与缓存 epoch 同步（IndexedDB 镜像提升 epoch 后不再假 dirty）；
 * ③ draft / saved 标记：草稿与已保存版本的返回值不同，文件不存在时是空映射；
 * ④ 未绑定工程 localOnly：只走本机镜像，仍返回成功但明确 draft / saved=false；
 * ⑤ 镜像失败时撤销刚建的草稿，不留下「返回失败但读到半份草稿」。
 *
 * 跑法：node scripts/run-verification.mjs scripts/verify-agent-lang-draft.ts
 */

import assert from 'node:assert/strict'
import {
  discardLangDraft,
  readLangDraft,
  stageLangDraft,
  writeLangDraft,
  type LangDraftClient,
  type LangDraftTransactions,
} from '../src/i18n/langDraft'
import { stringifyTextFile } from '../src/i18n/textMap'

const PATH = 'assets/zh_cn/lang_hs/序章.lang'
const MAP = { 'a1b2c3d4': '第一句', 'e5f6a7b8': '第二句' }
const SAVED_TEXT = 'a1b2c3d4 # 旧的第一句'
const DRAFT_TEXT = stringifyTextFile(MAP)
const SAVED_VERSION = 'sha256:saved'

/* ── ① 草稿优先读取 ── */
{
  const read = await readLangDraft(
    (candidate) => (candidate === PATH ? DRAFT_TEXT : undefined),
    PATH,
    async () => ({ text: SAVED_TEXT, version: SAVED_VERSION }),
  )
  assert.equal(read.draft, true, 'staged 存在时必须标草稿')
  assert.equal(read.hasSaved, true, '有草稿不代表没有已保存文件（B8）')
  assert.equal(read.savedVersion, SAVED_VERSION, '已保存版本照实返回，不能被草稿伪装成 null')
  assert.deepEqual(read.map, MAP, '草稿优先：读到的是 staged 的译文，而不是工程文件里的旧译文')
}

/* ── ③ draft / saved 标记 ── */
{
  const saved = await readLangDraft(
    () => undefined,
    PATH,
    async () => ({ text: DRAFT_TEXT, version: SAVED_VERSION }),
  )
  assert.equal(saved.draft, false, '没有 staged 草稿 → 读已保存内容')
  assert.equal(saved.hasSaved, true)
  assert.equal(saved.savedVersion, SAVED_VERSION)
  assert.deepEqual(saved.map, MAP)

  const missing = await readLangDraft(
    () => undefined,
    PATH,
    async () => ({ text: null, version: null }),
  )
  assert.deepEqual(
    missing,
    { map: {}, savedVersion: null, hasSaved: false, draft: false },
    '文件不存在 → 空映射、未保存',
  )
}

/** 假事务层：stageWrite 立即准备镜像（与 EditTransactions 一致），stagedText 可读 */
function makeTransactions() {
  const staged = new Map<string, string>()
  const transactions: LangDraftTransactions & {
    stagedText(path: string): string | undefined
  } = {
    stageWrite(edit, mirror) {
      staged.set(edit.path, edit.data)
      return Promise.resolve(mirror?.())
    },
    discardDraftPaths(paths) {
      for (const path of paths) staged.delete(path)
    },
    stagedText(path) {
      return staged.get(path)
    },
  }
  return { staged, transactions }
}

/* ── ② stageWrite 后 epoch 同步 + staged 内容 ── */
{
  const { staged, transactions } = makeTransactions()
  /** 假的 IndexedDB 缓存 epoch：镜像写入（putAssetBlob）会提升它 */
  let cacheEpoch = 0
  const assetEpochs = new Map<string, number>()
  const order: string[] = []

  const stage = stageLangDraft(
    transactions,
    PATH,
    MAP,
    async () => {
      order.push('mirror')
      cacheEpoch += 1 // putAssetBlob → touch() → assetCacheEpoch 提升
    },
    () => {
      order.push('epoch')
      assetEpochs.set(PATH, cacheEpoch)
    },
  )
  await stage
  assert.deepEqual(order, ['mirror', 'epoch'], '先写镜像，再同步 assetEpochs')
  assert.equal(assetEpochs.get(PATH), cacheEpoch, 'assetEpochs 必须等于当前缓存 epoch（P0 假 dirty）')
  assert.equal(assetEpochs.get(PATH), 1)
  assert.equal(staged.get(PATH), DRAFT_TEXT, 'stageWrite 里放的是语言映射的文本形态')
}

/* ── ②/④ 绑定工程写入：草稿语义 + epoch 对齐 ── */
{
  const { staged, transactions } = makeTransactions()
  let cacheEpoch = 0
  const assetEpochs = new Map<string, number>()
  const client: LangDraftClient = {
    writable: true,
    online: true,
    resolvePath: (path) => `sub/${path}`,
    transactions,
    assetEpochs: { set: (path, epoch) => assetEpochs.set(path, epoch) },
  }

  const result = await writeLangDraft({
    client,
    path: PATH,
    map: MAP,
    mirror: async () => {
      cacheEpoch += 1
    },
    cacheEpoch: () => cacheEpoch,
  })
  assert.deepEqual(
    result,
    { ok: true, localOnly: false, draft: true, saved: false, version: null },
    '绑定工程写成功 = 草稿已写，绝不宣称 saved',
  )
  assert.equal(staged.get(`sub/${PATH}`), DRAFT_TEXT, 'staged 路径用 handle.resolve 后的工程内路径')
  assert.equal(assetEpochs.get(PATH), 1, 'assetEpochs 用资产包内路径，且等于镜像后的 epoch')

  /* ── ⑤ 镜像失败：撤销草稿并如实报错 ── */
  const failing = makeTransactions()
  const failed = await writeLangDraft({
    client: { ...client, transactions: failing.transactions },
    path: PATH,
    map: MAP,
    mirror: async () => {
      throw new Error('IndexedDB 配额不足')
    },
    cacheEpoch: () => 0,
  })
  assert.equal(failed.ok, false)
  assert.match(failed.ok === false ? failed.error : '', /IndexedDB 配额不足/)
  assert.equal(failing.staged.has(`sub/${PATH}`), false, '镜像失败不能留下半份草稿')
}

/* ── ④ 未绑定工程：localOnly，只写本机镜像 ── */
{
  let mirrored = 0
  const result = await writeLangDraft({
    client: null,
    path: PATH,
    map: MAP,
    mirror: async () => {
      mirrored += 1
    },
    cacheEpoch: () => 0,
  })
  assert.deepEqual(
    result,
    { ok: true, localOnly: true, draft: true, saved: false, version: null },
    '未绑定工程也必须明确 draft / saved=false / localOnly',
  )
  assert.equal(mirrored, 1, '未绑定工程只写本机工作区 / IDB 镜像')
}

/* ── ④ 不可写客户端：明确失败，不静默假装成功 ── */
{
  const { staged, transactions } = makeTransactions()
  const offline = await writeLangDraft({
    client: {
      writable: false,
      online: false,
      resolvePath: (path) => path,
      transactions,
      assetEpochs: { set: () => undefined },
    },
    path: PATH,
    map: MAP,
    mirror: async () => undefined,
    cacheEpoch: () => 0,
  })
  assert.equal(offline.ok, false)
  assert.match(offline.ok === false ? offline.error : '', /service is offline/, '宿主/工具输出已英文化（阶段 7）')
  assert.equal(staged.size, 0, '不可写时不落草稿')
}

/* ── 回滚回放：不可写时也允许改本地草稿（allowUnwritable） ── */
{
  const { staged, transactions } = makeTransactions()
  const restored = await writeLangDraft({
    client: {
      writable: false,
      online: false,
      resolvePath: (path) => path,
      transactions,
      assetEpochs: { set: () => undefined },
    },
    path: PATH,
    map: MAP,
    mirror: async () => undefined,
    cacheEpoch: () => 0,
    allowUnwritable: true,
  })
  assert.equal(restored.ok, true, '回滚回放不因断线 / viewer 失败')
  assert.equal(staged.get(PATH), DRAFT_TEXT)
}

/* ── 回滚 create 条目：撤掉 staged 草稿（原始路径与 resolve 路径都传，幂等） ── */
{
  const { staged, transactions } = makeTransactions()
  transactions.stageWrite({ op: 'write', path: `sub/${PATH}`, data: DRAFT_TEXT }, undefined)
  discardLangDraft(transactions, [PATH, `sub/${PATH}`])
  assert.equal(staged.has(`sub/${PATH}`), false, '撤掉 resolve 后的路径')
  discardLangDraft(transactions, [PATH, PATH])
  assert.equal(staged.size, 0, '重复调用是空操作')
}

console.log(
  '通过：语言文本草稿（草稿优先读取、draft/saved 标记、stageWrite 后 assetEpochs 同步、localOnly、镜像失败回滚）',
)
