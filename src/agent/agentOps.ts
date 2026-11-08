/**
 * Agent 工具的纯逻辑：只认用户可见的**逻辑名**（如 `序章.hs`），
 * 不暴露磁盘路径、`src/<kind>/` 结构或 `assets/` 下的资产路径。
 *
 * React 侧（`StageplayWorkspace`）只负责：调用这里 → 提交工作区 → 刷新 TextMap → 记历史。
 */

import { getAssetBlob, deleteAssetBlob, putAssetBlob } from '../assets/idb'
import { HsCompileError, compileHsToHsc, type HsCompileErrorCode } from '../hanshu/compiler'
import { stopParseLineOf } from '../hanshu/directives'
import { escapeHsText, splitHsLines } from '../hanshu/hsSyntaxRules'
import { collectSourceKeys, suspectKeySpans, type SourceKeyEntry } from '../hanshu/sourceKeys'
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
import { inspectOggBytes, isMonoVorbisOgg } from '../i18n/voiceBytes'
import { resolveVoiceBindingFor, voiceAssetDir } from '../i18n/voiceMap'
import {
  analyzeCharDiagnostics,
  type CharDiagnostic,
} from '../monaco/charDiagnostics'
import { parseCharTextSpans } from '../monaco/charTextSpans'
import { analyzeHsDiagnostics, type HsDiagnostic } from '../monaco/hsDiagnostics'
import { parseTextSpans, type TextSpan } from '../monaco/textSpans'
import { keyReplacementFor } from '../monaco/textKeyRules'
import {
  getExtension,
  isCharFile,
  isHanshuFile,
  registerAsset,
  removeAssetFolder,
  removeAssetMeta,
  sourceKindOf,
  sourceRelativePath,
  type Workspace,
} from '../workspace'

function localizedSpans(content: string, sourceName?: string): TextSpan[] {
  if (sourceName && getExtension(sourceName) === '.char') {
    return parseCharTextSpans(content)
  }
  return parseTextSpans(content)
}

/** 工具返回值：一律带 `ok`，失败带 `error`（可选 `hint` 指向正确工具） */
export type AgentOpResult = { ok: boolean; [key: string]: unknown }

/**
 * 源文件类别：`hanshu` / `character` / `script` / `goal` / `progress` / `story` / `navigator` / `gift` / `meta`；旧 *.voice 等留在包根为 `root`。
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
        kind: sourceKindOf(script.name, script.srcKind),
        path: sourceRelativePath(script.name, script.srcKind),
      }
    }
  }
  return null
}

/** 分页读：`offset` 1-based 行号，`limit` 行数；`limitClamped` = 请求超过 2000 行被截断 */
export function paginateSource(
  content: string,
  offset = 1,
  limit = 400,
): {
  content: string
  totalLines: number
  offset: number
  truncated: boolean
  limitClamped: boolean
} {
  const lines = content.split('\n')
  const start = Math.min(Math.max(1, Math.floor(offset) || 1), Math.max(1, lines.length))
  const requested = Math.floor(limit) || 400
  const limitClamped = requested > 2000
  const count = Math.min(Math.max(1, requested), 2000)
  const slice = lines.slice(start - 1, start - 1 + count)
  return {
    content: slice.join('\n'),
    totalLines: lines.length,
    offset: start,
    truncated: start - 1 + slice.length < lines.length,
    limitClamped,
  }
}

/** `read_source` 的 offset 越界判定（宿主兜底；工具层先挡非正整数） */
export function sourceOffsetError(
  totalLines: number,
  offset?: number,
): { ok: false; error: string; totalLines: number } | null {
  const requested = Math.floor(offset ?? 1) || 1
  return requested > totalLines
    ? { ok: false, error: 'offset out of range', totalLines }
    : null
}

/** 语言键的唯一合法形态：8 位小写十六进制（与自动成键生成的一致） */
export const LANG_KEY_PATTERN = /^[0-9a-f]{8}$/

/**
 * 语言键校验（D6）：不再替模型做 trim/小写归一化。
 * - `invalidKeys`：形态不合法（大写、长度不对、带空白等）；
 * - `duplicates`：同一次调用里重复出现的键。
 */
export function validateLangKeys(keys: readonly string[]): {
  invalidKeys: string[]
  duplicates: string[]
} {
  const invalidKeys: string[] = []
  const duplicates: string[] = []
  const seen = new Set<string>()
  for (const key of keys) {
    if (!LANG_KEY_PATTERN.test(key)) {
      invalidKeys.push(key)
      continue
    }
    if (seen.has(key)) duplicates.push(key)
    else seen.add(key)
  }
  return { invalidKeys, duplicates }
}

/** 精确字面替换：命中 0 处或（未开 `replaceAll` 时）多处都失败，逼模型重读 */
export function applyTextEdit(
  content: string,
  oldText: string,
  newText: string,
  replaceAll = false,
): { ok: true; content: string; count: number } | { ok: false; error: string } {
  if (!oldText) return { ok: false, error: 'oldText must not be empty' }
  const first = content.indexOf(oldText)
  if (first < 0) {
    return {
      ok: false,
      error: `oldText not found (${oldText.length} chars); the file may have changed — call read_source again and retry`,
    }
  }
  if (!replaceAll) {
    const second = content.indexOf(oldText, first + oldText.length)
    if (second >= 0) {
      return {
        ok: false,
        error:
          `oldText matched ${content.split(oldText).length - 1} times; provide more context or pass replaceAll: true`,
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

/** agent 侧 lint（D6）：只在 `.hs` 上跑，不参与编辑器波形 */
export type AgentLintDiagnostic = {
  kind: 'agent-lint'
  /** 1-based 行号 */
  line: number
  /** 英文消息，已带行号 */
  message: string
}

const AGENT_SPEAKER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
/** 块内会被当成新结构、从而结束多行对白块的行首 */
const AGENT_BLOCK_BREAK = /^(?:-|\+|@|\?|!|:)/
/** 行首像 `名字:` 的行（名字允许非法字符，交给 lint 判断） */
const AGENT_SPEAKER_LIKE = /^([^:]+?)\s*:/

function isEscapedAt(text: string, index: number): boolean {
  let backslashes = 0
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) backslashes += 1
  return backslashes % 2 === 1
}

function hasUnescapedHyphen(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '-' && !isEscapedAt(text, i)) return true
  }
  return false
}

/**
 * `.hs` 的 agent lint（D6）：非法角色名 / 全角冒号 / 对白文本未转义的 `-` /
 * 对白块内出现选项行。消息全英文并带行号；只做 agent 的 `validate_source`，
 * 不进编辑器诊断（编辑器波形保持原样）。
 */
export function lintHsSource(source: string): AgentLintDiagnostic[] {
  const out: AgentLintDiagnostic[] = []
  const push = (index: number, message: string) => {
    out.push({ kind: 'agent-lint', line: index + 1, message: `line ${index + 1}: ${message}` })
  }
  let inDialogueBlock = false
  const lines = splitHsLines(source)
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.text
    if (!text.trim()) continue
    if (/^\s*#/.test(text)) continue
    if (/^\/\/\s*$/.test(text)) {
      inDialogueBlock = false
      continue
    }

    if (inDialogueBlock) {
      // 新对白 / 选项 / 信号会结束当前块，按正常行继续判定
      if (AGENT_BLOCK_BREAK.test(text) || /^[A-Za-z_][A-Za-z0-9_]*\s*:/.test(text)) {
        inDialogueBlock = false
      } else {
        if (/^\s*\*/.test(text)) {
          push(i, 'choice line inside a dialogue block; move choices outside the block')
          continue
        }
        if (hasUnescapedHyphen(text)) {
          push(i, 'unescaped "-" in dialogue text; escape it as "\\-"')
        }
        continue
      }
    }

    if (text.startsWith('@')) continue
    if (AGENT_BLOCK_BREAK.test(text)) continue
    if (/^\s*\*/.test(text)) continue

    // 全角冒号只判角色行（`旁白：你好`）；正文里的中文标点不受影响
    if (/^[^\s:：]+[：]/.test(text)) {
      push(i, 'full-width colon "：" in speaker line; use ASCII ":"')
      continue
    }

    const speaker = AGENT_SPEAKER_LIKE.exec(text)
    if (!speaker) continue
    const name = speaker[1]!.trim()
    if (!AGENT_SPEAKER_NAME.test(name)) {
      push(
        i,
        `invalid character name "${name}"; use [A-Za-z_][A-Za-z0-9_]*`,
      )
      continue
    }
    const rest = text.slice(speaker[0].length)
    if (rest.trim() === '') inDialogueBlock = true
  }
  return out
}

/** agent 侧编译错误（D5：工具 JSON 英文）。编辑器 UI 仍直接用 `HsCompileError.message` 中文。 */
export type AgentCompileError = {
  /** 英文消息，已带行号 */
  message: string
  /** 机器可读分类（编译器的错误码） */
  code?: HsCompileErrorCode
  /** 1-based 行号 */
  line?: number
}

function englishCompileError(error: HsCompileError): AgentCompileError {
  const prefix = error.line === undefined ? '' : `line ${error.line}: `
  switch (error.code) {
    case 'key-outside-span':
      return {
        message: `${prefix}key must live inside a closed statement (speaker:<key>// or a multi-line block ending with // on its own line)`,
        code: error.code,
        line: error.line,
      }
    case 'multiple-keys-in-block':
      return {
        message: `${prefix}a multi-line dialogue block may contain only one key; split it into separate speaker: statements or remove the # comments inside the block`,
        code: error.code,
        line: error.line,
      }
    default:
      return {
        message: `${prefix}script compilation failed`,
        ...(error.line === undefined ? {} : { line: error.line }),
      }
  }
}

/** `.hs` / `.char` 语法诊断；`.hs` 另跑编译校验（注入点可带跨文件占用表） */
export function validateSourceContent(
  name: string,
  content: string,
  options?: { foreignInjects?: ReadonlyMap<string, string> },
): {
  diagnostics: Array<HsDiagnostic | CharDiagnostic | AgentLintDiagnostic>
  compileError: AgentCompileError | null
} {
  if (isCharFile(name)) {
    return { diagnostics: analyzeCharDiagnostics(content), compileError: null }
  }
  if (!isHanshuFile(name)) return { diagnostics: [], compileError: null }
  let compileError: AgentCompileError | null = null
  try {
    compileHsToHsc(content)
  } catch (error) {
    if (error instanceof HsCompileError) compileError = englishCompileError(error)
    else throw error
  }
  return {
    diagnostics: [
      ...analyzeHsDiagnostics(content, {
        foreignInjects: options?.foreignInjects,
      }),
      ...lintHsSource(content),
      // P10：形似键但格式不对（大写 / 长度不对）→ agent lint，带行号英文消息
      ...suspectKeySpans(content).map((item) => ({
        kind: 'agent-lint' as const,
        line: item.line,
        message: `line ${item.line}: key "${item.text}" is not a valid 8-digit lowercase hex key`,
      })),
      // B6：还没成键的可本地化正文（一条汇总，行号取第一条样本）
      ...(() => {
        const unparsed = countUnparsedTexts(content, name)
        if (unparsed.count === 0) return []
        return [
          {
            kind: 'agent-lint' as const,
            line: unparsed.samples[0]?.line ?? 1,
            message: `${unparsed.count} localizable text segment(s) are not keyed yet; run parse_hs to create keys`,
          },
        ]
      })(),
    ],
    compileError,
  }
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

export type MissingTranslationSummary = {
  locale: string
  /** 该语言缺少译文的键数 */
  missing: number
  /** 该语言对应的正文键总数 */
  total: number
  /** 涉及多少个源文件（只数缺译文的） */
  sources: number
}

/**
 * 导出预检：找出「正文有键、语言文件没文本」的情况。
 *
 * 为什么放在这里而不是导出器里：导出预检与编辑器全红用的是同一份判断
 * （键来自正文、文本来自语言文件），导出器只负责打包。这里只做汇总，
 * 真正读语言文件由调用方注入 —— 必须**草稿优先**（D1：agent / 用户刚写进本地草稿的
 * 译文同样要参与缺译文判断），不能只读工程文件里的旧版本。
 */
export async function collectMissingTranslationWarnings(
  sources: ReadonlyArray<{ name: string; content: string }>,
  locales: readonly string[],
  readLang: (sourceName: string, locale: string) => Promise<Record<string, string>>,
): Promise<{ warnings: string[]; summaries: MissingTranslationSummary[] }> {
  const warnings: string[] = []
  const summaries: MissingTranslationSummary[] = []
  for (const locale of locales) {
    let missing = 0
    let total = 0
    let missingSources = 0
    for (const source of sources) {
      const keys = collectSourceKeys(source.content, source.name)
      if (keys.length === 0) continue
      const map = await readLang(source.name, locale)
      let fileMissing = 0
      for (const key of keys) {
        total += 1
        if (!String(map[key.key] ?? '').trim()) {
          missing += 1
          fileMissing += 1
        }
      }
      if (fileMissing > 0) missingSources += 1
    }
    if (missing > 0) {
      summaries.push({ locale, missing, total, sources: missingSources })
      warnings.push(
        `[${locale}] ${missing} of ${total} keys have no translation across ${missingSources} source file(s); ` +
          'use list_lang_keys to find the gaps and write_lang to fill them',
      )
    }
  }
  return { warnings, summaries }
}

/**
 * 语言映射里的「孤儿键」：map 有、正文已经不再引用（P8 / 面板清理用）。
 * 按 key 排序返回，text 原样带回，便于 UI 展示与批量删除。
 */
export function collectOrphanKeys(
  sourceKeys: readonly string[],
  map: Record<string, string>,
): Array<{ key: string; text: string }> {
  const used = new Set(sourceKeys)
  return Object.entries(map)
    .filter(([key]) => !used.has(key))
    .map(([key, text]) => ({ key, text }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

export type TranslatedExportWarning = {
  group: 'assets' | 'gameplay' | 'other'
  message: string
}

/**
 * 把导出编译器的中文 warning 翻成英文并归类（panel-ui 的 D5 展示用）。
 *
 * 已知模式：
 * - `符号 X 已提供但未被引用（path）` → gameplay；
 * - `path: 找不到已导出的所属源文件，已跳过` → assets；
 * - 其余 → other，message 用英文泛化（**不夹中文**）。
 */
export function translateExportWarning(message: string): TranslatedExportWarning {
  const trimmed = message.trim()
  const symbol = /^符号\s*(.+?)\s*已提供但未被引用（(.+)）$/.exec(trimmed)
  if (symbol) {
    return {
      group: 'gameplay',
      message: `symbol ${symbol[1]} was provided but never referenced (${symbol[2]})`,
    }
  }
  const missingOwner = /^(.+?): 找不到已导出的所属源文件，已跳过$/.exec(trimmed)
  if (missingOwner) {
    return {
      group: 'assets',
      message: `${missingOwner[1]}: owning source file is not part of the export; skipped`,
    }
  }
  return {
    group: 'other',
    message: 'export warning (details are only available in the export log)',
  }
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
 *
 * 与编辑器的自动成键（`textEditor.migrateNow`）**必须完全一致**：两者都走
 * `keyReplacementFor` —— 就地替换、不收缩多行块；空体多行块（`name:` + 空正文 +
 * 独占一行的 `//`）把键名插成独立一行。空文本也照样成键（否则它永远拿不到键）。
 *
 * `skipped` 只统计因 `#stopparse` 指令而未成键的片段。
 */
export function parseSourceText(
  content: string,
  map: TextFile,
  sourceName?: string,
): {
  content: string
  entries: Array<[string, string]>
  skipped: number
  reused: number
} {
  const stopLine = stopParseLineOf(content)
  // P1：只把「正文正在用的键 + 本次已分配键」当作占用；**不再**把 map 的全部历史键塞进来。
  // 否则 unparse → parse（译文还原成正文后再成键）拿不到原来的键，同文本会被分到新键，
  // 该语言之外的其他语言译文就丢了。
  const used = new Set<string>(
    collectSourceKeys(content, sourceName).map((item) => item.key),
  )
  // text → key 反查：同文本复用已有键（只收合法 8 位小写十六进制；第一个同文本键胜出）。
  const existingByText = new Map<string, string>()
  for (const [key, text] of Object.entries(map)) {
    if (!LANG_KEY_PATTERN.test(key)) continue
    if (!existingByText.has(text)) existingByText.set(text, key)
  }

  const edits: Array<{ start: number; end: number; text: string }> = []
  const entries: Array<[string, string]> = []
  let skipped = 0
  let reused = 0

  // 与编辑器同源：行末 offset 供"空体多行块把键名插成独立一行"用
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const lines = splitHsLines(content)
  const lineEndOf = (line: number): number => {
    const l = lines[line - 1]
    return l ? l.start + l.text.length : content.length
  }

  for (const span of localizedSpans(content, sourceName)) {
    if (stopLine != null && span.endLine >= stopLine) {
      skipped += 1
      continue
    }
    if (isLocaleKey(span.value)) continue
    const existing = existingByText.get(span.value)
    let key: string
    if (existing !== undefined) {
      key = existing
      reused += 1
    } else {
      key = createLocaleKeyFromText(span.value, (candidate) => used.has(candidate))
    }
    used.add(key)
    // 同文件同文本的后续出现也复用本次分配的键（不必再走冲突重试）
    if (!existingByText.has(span.value)) existingByText.set(span.value, key)
    entries.push([key, span.value])
    edits.push(keyReplacementFor(span, key, eol, lineEndOf))
  }

  let next = content
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    next = next.slice(0, edit.start) + edit.text + next.slice(edit.end)
  }
  return { content: next, entries, skipped, reused }
}

/**
 * 未成键正文检测（B6）：用 `parseSourceText` 干跑，统计还有多少可本地化文本没拿到键，
 * 并给前 3 条样本（行号 + 文本）。`#stopparse` 之后不计（与成键/键位扫描同口径）。
 */
export function countUnparsedTexts(
  content: string,
  sourceName?: string,
): { count: number; samples: Array<{ line: number; text: string }> } {
  const dryRun = parseSourceText(content, {}, sourceName)
  if (dryRun.entries.length === 0) return { count: 0, samples: [] }
  const stopLine = stopParseLineOf(content)
  const samples: Array<{ line: number; text: string }> = []
  for (const span of localizedSpans(content, sourceName)) {
    if (stopLine != null && span.endLine >= stopLine) continue
    if (isLocaleKey(span.value)) continue
    samples.push({ line: span.line, text: span.value })
    if (samples.length >= 3) break
  }
  return { count: dryRun.entries.length, samples }
}

/**
 * 逆解析：把正文里的键名换回该语言的映射文本（转义后写回）。
 * 多行译文与缺失译文不处理，原样报告给调用方 —— 不静默丢内容。
 * `#stopparse` 只控制**解析成键**，逆解析不受它影响：它要还原的是整个文件，
 * 指令往往就顶格写在第一行（Agent 的"关闭解析 → 逆解析 → 改稿 → 主动解析"流程）。
 */
export function unparseSourceText(
  content: string,
  map: TextFile,
  sourceName?: string,
): { content: string; replaced: number; missing: string[]; multiline: string[] } {
  const edits: Array<{ start: number; end: number; text: string }> = []
  const missing: string[] = []
  const multiline: string[] = []

  for (const span of localizedSpans(content, sourceName)) {
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
/**
 * 配音格式的一行英文说明（P5 / D5）。
 * - 合格（ok / ref）只说 `mono Vorbis Ogg`，不再出现 "mono required" 这种自相矛盾的提示；
 * - invalid（含 not-mono）才给具体原因。
 */
export function voiceFormatNote(
  info: ReturnType<typeof inspectOggBytes>,
  state: VoiceState,
): string {
  if (state === 'ok' || state === 'ref') return 'mono Vorbis Ogg'
  if (!info.ogg) return 'not an ogg container'
  if (info.codec === 'opus') return 'ogg contains Opus; Vorbis is required'
  if (info.codec === 'other') return 'ogg is neither Vorbis nor Opus'
  return `Vorbis with ${info.channels ?? 'unknown'} channel(s); mono is required`
}

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
          format: 'reference could not be resolved',
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
          format: `reference target is not an ogg file: ${targetName}`,
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
          format: 'reference target has no data',
        })
        continue
      }
      const refHead = new Uint8Array(await refBlob.slice(0, 64 * 1024).arrayBuffer())
      const refInfo = inspectOggBytes(refHead)
      const refOk = isMonoVorbisOgg(refHead)
      out.push({
        key,
        state: refOk ? 'ref' : 'invalid',
        fileName,
        refTarget: target,
        format: voiceFormatNote(refInfo, refOk ? 'ref' : 'invalid'),
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
    const ok = isMonoVorbisOgg(head)
    out.push({
      key,
      state: ok ? 'ok' : 'invalid',
      fileName,
      format: voiceFormatNote(info, ok ? 'ok' : 'invalid'),
    })
  }
  return out
}
