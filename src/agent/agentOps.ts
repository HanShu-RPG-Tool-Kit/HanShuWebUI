/**
 * Agent 工具的纯逻辑：只认用户可见的**逻辑名**（如 `序章.hs`），
 * 不暴露磁盘路径、`src/<kind>/` 结构或 `assets/` 下的资产路径。
 *
 * React 侧（`ScriptWorkspace`）只负责：调用这里 → 提交工作区 → 刷新 TextMap → 记历史。
 */

import { getAssetBlob, deleteAssetBlob, putAssetBlob } from '../assets/idb'
import { HsCompileError, compileHsToHsc } from '../hanshu/compiler'
import { stopParseLineOf } from '../hanshu/directives'
import { escapeHsText } from '../hanshu/hsSyntaxRules'
import { collectSourceKeys, type SourceKeyEntry } from '../hanshu/sourceKeys'
import { sourceExtension, textAssetPath } from '../i18n/localeLayout'
import {
  TEXT_ASSET_MIME,
  createLocaleKeyFromText,
  isLocaleKey,
  normalizeLocaleKey,
  parseTextFile,
  stringifyTextFile,
  type TextFile,
} from '../i18n/textMap'
import { describeVoiceFormat, inspectOggBytes, isMonoVorbisOgg } from '../i18n/voiceBytes'
import { resolveVoiceBindingFor, voiceAssetDir } from '../i18n/voiceMap'
import { analyzeHsDiagnostics, type HsDiagnostic } from '../monaco/hsDiagnostics'
import { parseTextSpans } from '../monaco/textSpans'
import {
  isHanshuFile,
  registerAsset,
  removeAssetFolder,
  removeAssetMeta,
  sourceKindOf,
  sourceRelativePath,
  type Workspace,
} from '../workspace'

/** 工具返回值：一律带 `ok`，失败带 `error`（可选 `hint` 指向正确工具） */
export type AgentOpResult = { ok: boolean; [key: string]: unknown }

/**
 * 源文件类别：`hanshu` / `character` / `scripts` / `meta`（创作资料）；留在包根为 `root`。
 * 与写盘归位同源（`workspace.sourceKindOf`），不在这里另立一套。
 */
export { sourceKindOf }

/** 活动文件的项目相对路径：`序章.hs` → `src/hanshu/序章.hs`（仅供参考，工具仍收逻辑名） */
export function activeFilePathOf(
  workspace: Workspace,
  activeScriptId: string | null,
): { name: string; kind: string; path: string } | null {
  for (const pkg of workspace.packages) {
    for (const script of pkg.scripts) {
      if (script.id !== activeScriptId) continue
      return {
        name: script.name,
        kind: sourceKindOf(script.name),
        path: sourceRelativePath(script.name),
      }
    }
  }
  return null
}

/** 分页读：`offset` 1-based 行号，`limit` 行数 */
export function paginateSource(
  content: string,
  offset = 1,
  limit = 400,
): { content: string; totalLines: number; offset: number; truncated: boolean } {
  const lines = content.split('\n')
  const start = Math.min(Math.max(1, Math.floor(offset) || 1), Math.max(1, lines.length))
  const count = Math.min(Math.max(1, Math.floor(limit) || 400), 2000)
  const slice = lines.slice(start - 1, start - 1 + count)
  return {
    content: slice.join('\n'),
    totalLines: lines.length,
    offset: start,
    truncated: start - 1 + slice.length < lines.length,
  }
}

/** 精确字面替换：命中 0 处或（未开 `replaceAll` 时）多处都失败，逼模型重读 */
export function applyTextEdit(
  content: string,
  oldText: string,
  newText: string,
  replaceAll = false,
): { ok: true; content: string; count: number } | { ok: false; error: string } {
  if (!oldText) return { ok: false, error: 'oldText 不能为空' }
  const first = content.indexOf(oldText)
  if (first < 0) {
    return {
      ok: false,
      error: 'oldText 在文件里找不到；文件可能已被修改，请重新 read_source 后再改',
    }
  }
  if (!replaceAll) {
    const second = content.indexOf(oldText, first + oldText.length)
    if (second >= 0) {
      return {
        ok: false,
        error:
          'oldText 在文件里命中多处；请给出更长的上下文，或显式传 replaceAll: true',
      }
    }
    return {
      ok: true,
      content: content.slice(0, first) + newText + content.slice(first + oldText.length),
      count: 1,
    }
  }
  const count = content.split(oldText).length - 1
  return { ok: true, content: content.split(oldText).join(newText), count }
}

/** `.hs` 走剧本诊断与编译校验；其它后缀没有可校验的语法 */
export function validateSourceContent(
  name: string,
  content: string,
): { diagnostics: HsDiagnostic[]; compileError: { message: string } | null } {
  if (!isHanshuFile(name)) return { diagnostics: [], compileError: null }
  let compileError: { message: string } | null = null
  try {
    compileHsToHsc(content)
  } catch (error) {
    if (error instanceof HsCompileError) compileError = { message: error.message }
    else throw error
  }
  return { diagnostics: analyzeHsDiagnostics(content), compileError }
}

/** 键位扫描的实现在纯语法层（`src/hanshu/sourceKeys.ts`），这里原样转发 */
export { collectSourceKeys, type SourceKeyEntry }

/** 语言文本资产路径（由源文件的逻辑名 + 语言推导，调用方无需拼路径） */
export function langAssetPathFor(source: string, locale: string): string {
  return textAssetPath(locale, source)
}

/** 读语言文本；缺失返回空表（不是错误：该语言还没开始翻译） */
export async function readLangAsset(
  packageId: string,
  path: string,
): Promise<TextFile> {
  const blob = await getAssetBlob(packageId, path)
  if (!blob) return {}
  return parseTextFile(await blob.text())
}

/** 写语言文本：blob → 登记进工作区（父目录 + 元数据），顺序与界面里的资产写入一致 */
export async function writeLangAsset(
  workspace: Workspace,
  packageId: string,
  path: string,
  data: TextFile,
): Promise<Workspace> {
  const blob = new Blob([stringifyTextFile(data)], { type: TEXT_ASSET_MIME })
  await putAssetBlob(packageId, path, blob)
  const result = registerAsset(
    workspace,
    packageId,
    path,
    TEXT_ASSET_MIME,
    blob.size,
  )
  return result?.workspace ?? workspace
}

export type LocaleSummary = { locale: string; langFiles: number; voiceFiles: number }

/** 工程里真实存在过的语言（`assets/<locale>/lang_*` 与 `voice_*`） */
export function listLocalesOf(workspace: Workspace): LocaleSummary[] {
  const map = new Map<string, LocaleSummary>()
  const bump = (locale: string, field: 'langFiles' | 'voiceFiles') => {
    const hit = map.get(locale) ?? { locale, langFiles: 0, voiceFiles: 0 }
    hit[field] += 1
    map.set(locale, hit)
  }
  for (const pkg of workspace.packages) {
    for (const asset of pkg.assets) {
      const parts = asset.path.replace(/\\/g, '/').split('/')
      const locale = parts[1]
      if (parts[0]?.toLowerCase() !== 'assets' || !locale) continue
      if (/^lang_[a-z0-9]+$/i.test(parts[2] ?? '')) bump(locale.toLowerCase(), 'langFiles')
      else if (/^voice_[a-z0-9]+$/i.test(parts[2] ?? '')) {
        bump(locale.toLowerCase(), 'voiceFiles')
      }
    }
  }
  return [...map.values()].sort((a, b) => a.locale.localeCompare(b.locale))
}

/** 某个源文件在**所有语言**下的本地化资产（语言文本 + 配音目录） */
export function sourceAssetPathsOf(
  workspace: Workspace,
  sourceName: string,
): { paths: string[]; voiceDirs: string[] } {
  const ext = sourceExtension(sourceName)
  const paths: string[] = []
  const voiceDirs: string[] = []
  for (const pkg of workspace.packages) {
    const locales = new Set<string>()
    for (const asset of pkg.assets) {
      const parts = asset.path.replace(/\\/g, '/').split('/')
      const locale = parts[1]
      if (parts[0]?.toLowerCase() === 'assets' && locale) {
        locales.add(locale.toLowerCase())
      }
    }
    for (const locale of locales) {
      const textPath = textAssetPath(locale, sourceName)
      if (
        pkg.assets.some(
          (asset) => asset.path.toLowerCase() === textPath.toLowerCase(),
        )
      ) {
        paths.push(textPath)
      }
      const dir = voiceAssetDir(locale, sourceName, ext)
      if (
        pkg.assets.some((asset) =>
          asset.path.toLowerCase().startsWith(`${dir.toLowerCase()}/`),
        )
      ) {
        voiceDirs.push(dir)
      }
    }
  }
  return { paths, voiceDirs }
}

/**
 * 删除某个源文件在所有语言下的本地化资产：blob、元数据，以及清空后的配音目录。
 * 删除剧本时若不清这些，`assets/<locale>/lang_<ext>/xx.lang` 会变成永久孤儿。
 */
export async function deleteSourceAssets(
  workspace: Workspace,
  sourceName: string,
): Promise<{ workspace: Workspace; removed: string[] }> {
  const { paths, voiceDirs } = sourceAssetPathsOf(workspace, sourceName)
  let next = workspace
  const removed: string[] = []
  for (const pkg of workspace.packages) {
    const targets = [
      ...pkg.assets.filter((asset) =>
        paths.some((path) => path.toLowerCase() === asset.path.toLowerCase()),
      ),
      ...pkg.assets.filter((asset) =>
        voiceDirs.some((dir) =>
          asset.path.toLowerCase().startsWith(`${dir.toLowerCase()}/`),
        ),
      ),
    ]
    for (const asset of targets) {
      await deleteAssetBlob(pkg.id, asset.path)
      next = removeAssetMeta(next, asset.id)
      removed.push(asset.path)
    }
    for (const dir of voiceDirs) {
      next = removeAssetFolder(next, pkg.id, dir).workspace
    }
  }
  return { workspace: next, removed }
}

export type VoiceState = 'ok' | 'missing' | 'not-ogg' | 'not-mono' | 'invalid' | 'ref'

/**
 * 解析（自动成键）：把还不是键名的可本地化文本换成**文本哈希键**，
 * 并给出要写进该语言映射的键值对。纯函数 —— 写盘与提交由调用方做。
 */
export function parseSourceText(
  content: string,
  map: TextFile,
): { content: string; entries: Array<[string, string]>; skipped: number } {
  const stopLine = stopParseLineOf(content)
  const used = new Set<string>(Object.keys(map))
  for (const item of collectSourceKeys(content)) used.add(item.key)

  const edits: Array<{ start: number; end: number; text: string }> = []
  const entries: Array<[string, string]> = []
  let skipped = 0

  for (const span of parseTextSpans(content)) {
    if (stopLine != null && span.endLine >= stopLine) continue
    if (isLocaleKey(span.value)) continue
    if (!span.value.trim()) {
      skipped += 1
      continue
    }
    const key = createLocaleKeyFromText(span.value, (candidate) =>
      used.has(candidate),
    )
    used.add(key)
    entries.push([key, span.value])
    edits.push({ start: span.start, end: span.end, text: key })
  }

  let next = content
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    next = next.slice(0, edit.start) + edit.text + next.slice(edit.end)
  }
  return { content: next, entries, skipped }
}

/**
 * 逆解析：把正文里的键名换回该语言的映射文本（转义后写回）。
 * 多行译文与缺失译文不处理，原样报告给调用方 —— 不静默丢内容。
 */
export function unparseSourceText(
  content: string,
  map: TextFile,
): { content: string; replaced: number; missing: string[]; multiline: string[] } {
  const edits: Array<{ start: number; end: number; text: string }> = []
  const missing: string[] = []
  const multiline: string[] = []

  for (const span of parseTextSpans(content)) {
    const key = normalizeLocaleKey(span.value)
    if (!key) continue
    const text = map[key]
    if (text == null) {
      missing.push(key)
      continue
    }
    if (text.includes('\n')) {
      multiline.push(key)
      continue
    }
    edits.push({ start: span.start, end: span.end, text: escapeHsText(text) })
  }

  let next = content
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    next = next.slice(0, edit.start) + edit.text + next.slice(edit.end)
  }
  return { content: next, replaced: edits.length, missing, multiline }
}

export type VoiceStatusEntry = {
  key: string
  state: VoiceState
  fileName?: string
  format?: string
  /** 这一条是引用（`.ref`）时给出它指向的音频路径 —— Agent 该照实说明 */
  refTarget?: string
}

/**
 * 对等配音状态：只读 ogg 头部 64KB 就能判断封装与声道，
 * 因此不必整份解码 —— 判定标准与导入时的一致（单声道 Vorbis ogg）。
 *
 * 「引用资产」（`.ref`）也算配音，但要**分开报**：`ref` 表示这个键指向别处的一份音频，
 * 目标不存在 / 不是 ogg 时照实说 `invalid`，不要混进 `not-ogg` —— 那会把
 * "这个键用引用"说成"这个文件格式不对"，指错方向。
 */
export async function voiceStatusOf(
  packageId: string,
  assets: Array<{ path: string; mime?: string; refTarget?: string | null }>,
  source: string,
  locale: string,
  keys: string[],
): Promise<VoiceStatusEntry[]> {
  const out: VoiceStatusEntry[] = []
  for (const key of keys) {
    const binding = resolveVoiceBindingFor(source, key, locale, assets)
    if (!binding) {
      out.push({ key, state: 'missing' })
      continue
    }
    const fileName = binding.path.slice(binding.path.lastIndexOf('/') + 1)

    if (binding.kind === 'ref') {
      if (!binding.audioPath) {
        out.push({
          key,
          state: 'invalid',
          fileName,
          format: binding.reason ?? '引用解析不出来',
        })
        continue
      }
      const target = binding.audioPath
      const targetName = target.slice(target.lastIndexOf('/') + 1)
      if (!/\.ogg$/i.test(target)) {
        out.push({
          key,
          state: 'invalid',
          fileName,
          refTarget: target,
          format: `引用目标不是 ogg：${targetName}`,
        })
        continue
      }
      const refBlob = await getAssetBlob(packageId, target)
      if (!refBlob) {
        out.push({
          key,
          state: 'invalid',
          fileName,
          refTarget: target,
          format: '引用目标没有数据',
        })
        continue
      }
      const refHead = new Uint8Array(await refBlob.slice(0, 64 * 1024).arrayBuffer())
      out.push({
        key,
        state: isMonoVorbisOgg(refHead) ? 'ref' : 'invalid',
        fileName,
        refTarget: target,
        format: describeVoiceFormat(inspectOggBytes(refHead)),
      })
      continue
    }

    const asset = binding.asset
    if (!/\.ogg$/i.test(asset.path)) {
      out.push({ key, state: 'not-ogg', fileName })
      continue
    }
    const blob = await getAssetBlob(packageId, asset.path)
    if (!blob) {
      out.push({ key, state: 'invalid', fileName })
      continue
    }
    const head = new Uint8Array(await blob.slice(0, 64 * 1024).arrayBuffer())
    const info = inspectOggBytes(head)
    out.push({
      key,
      state: isMonoVorbisOgg(head) ? 'ok' : 'invalid',
      fileName,
      format: describeVoiceFormat(info),
    })
  }
  return out
}
