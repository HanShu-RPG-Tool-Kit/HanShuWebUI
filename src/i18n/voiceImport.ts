import { dropExtension, isVoiceOggPath } from './voiceMap'

/**
 * 「音频导入」固定工作流。
 *
 * 输入：**对等文件路径**（目标，由脚本路径 + 键名推导）+ **源音频文件路径**。
 * 输出：是否成功 + 常量枚举消息（见 VOICE_IMPORT_RESULT）。
 *
 * 三个分支（与需求一一对应）：
 * 1. 源文件就是目标对等文件本身，且已是单通道 ogg
 *    → 失败 `The file was already imported.`
 * 2. 源文件就是目标对等文件本身，但格式非法
 *    → 失败 `The file was imported unexpectedly, but its format is invalid.`
 * 3. 其余情况：把源处理成单通道 ogg（**在内存中**；源本来就是单通道 ogg 时仅读取字节），
 *    再按 `.new` 协议写入对等文件 → 成功 `Successfully imported.`
 *
 * 进度：前 2/3 是处理，后 1/3 是写入；中途被关掉 → 失败
 * `Import workflow interrupted unexpectedly.`
 *
 * 本模块不碰 DOM / IPC / IndexedDB：读、写、重命名、解码探测、转码全部由注入的实现提供，
 * 因此可以在没有浏览器的环境里把协议与分支跑成断言。
 */

/** 工作流结果消息（常量枚举） */
export const VOICE_IMPORT_RESULT = {
  success: 'Successfully imported.',
  alreadyImported: 'The file was already imported.',
  invalidSibling:
    'The file was imported unexpectedly, but its format is invalid.',
  interrupted: 'Import workflow interrupted unexpectedly.',
} as const

export type VoiceImportOutcome = keyof typeof VOICE_IMPORT_RESULT

export type VoiceImportReport = {
  ok: boolean
  outcome: VoiceImportOutcome
  /** 常量枚举消息 */
  message: string
  /** 目标对等文件路径 */
  targetPath: string
  /** 写入的字节数（失败为 0） */
  bytes: number
  /** 技术细节（ffmpeg 报错、读取失败等），只用于界面提示，不替代枚举消息 */
  detail?: string
}

/** 处理（转码）阶段占总进度的比例：前 2/3 */
export const VOICE_IMPORT_PROCESS_SHARE = 2 / 3

/** 源音频的探测结果 */
export type VoiceSourceInfo = {
  /** 是否已经是本工作流产出的格式（单声道 Vorbis ogg） */
  alreadyTarget: boolean
  /** 技术细节（解码/解析失败原因等） */
  detail?: string
}

/** 转码器：把源字节处理成单通道 ogg 字节（内存里） */
export type VoiceImportProcessor = {
  /** 探测源字节（判断「已经是单通道 ogg」与「格式非法」） */
  inspect(bytes: Uint8Array): Promise<VoiceSourceInfo>
  /**
   * 处理为单通道 ogg。实现可以是 ffmpeg（原生 / wasm）或编码器。
   * `onProgress` 报 0..1；`signal.aborted` 为真时应尽快停止并抛错。
   */
  process(
    bytes: Uint8Array,
    onProgress: (ratio: number) => void,
    signal: { aborted: boolean },
  ): Promise<Uint8Array>
}

/** 资产读写（由 ScriptWorkspace 用工作区模型 + IndexedDB + 工程磁盘实现） */
export type VoiceImportIo = {
  /** 读源字节；不存在返回 null */
  read(path: string): Promise<Uint8Array | null>
  /**
   * 把目标替换成这些字节。**原子策略由实现决定**（这是存储相关的）：
   * - IndexedDB：单次原子 `put`，不需要临时文件
   * - 工程磁盘：照 `.lang` 的做法写穿，内部走 `.new` → 删旧 → 改名（同卷改名是原子的）
   * `onProgress` 报 0..1，用于写入段（总进度的后 1/3）。
   */
  write(
    path: string,
    bytes: Uint8Array,
    mime: string,
    onProgress?: (ratio: number) => void,
  ): Promise<void>
}

/** 导入的源：资源管理器里的资产，或拖进来的外部文件（外部文件拿不到路径，只能给字节） */
export type VoiceImportSource =
  | { kind: 'asset'; path: string }
  | { kind: 'file'; name: string; bytes: Uint8Array }

export type VoiceImportRequest = {
  /** 源音频 */
  source: VoiceImportSource
  /** 目标对等文件路径（`assets/<tag>/voice/<脚本目录>/<key>.ogg`） */
  targetPath: string
}

/** 源的展示名（进度条上显示） */
export function voiceImportSourceLabel(source: VoiceImportSource): string {
  return source.kind === 'asset' ? source.path : source.name
}

/**
 * 结果浮窗的内容：就是把要返回的那条消息（`ok` 决定配色：成功=默认，失败=红）。
 * 由工作流**在结果落定之前**同步发出，界面据此先弹一下。
 */
export type VoiceImportNotice = {
  message: string
  ok: boolean
}

export type VoiceImportEvents = {
  /** 阶段切换：process（前 2/3）/ write（后 1/3） */
  onPhase?(phase: 'process' | 'write'): void
  /** 总进度 0..1 */
  onProgress?(ratio: number): void
  /**
   * 结果浮窗。成功与失败都会发，且发生在 `result` 落定**之前** ——
   * 工作流本身不碰界面，弹窗交给调用方。
   */
  onNotice?(notice: VoiceImportNotice): void
}

export type VoiceImportRun = {
  /** 工作流结果 */
  result: Promise<VoiceImportReport>
  /** 用户关掉进度条：请求中断（处理阶段会尽早停止） */
  cancel(): void
}

/** 源与目标是同一个「对等基名」（扩展名无关） */
export function isSameVoiceFile(sourcePath: string, targetPath: string): boolean {
  const norm = (value: string) =>
    dropExtension(value.trim().replace(/\\/g, '/')).toLowerCase()
  return norm(sourcePath) === norm(targetPath)
}

/**
 * 跑一次导入。返回的 `result` 一定会落定为上面四种结果之一。
 */
export function runVoiceImport(
  request: VoiceImportRequest,
  io: VoiceImportIo,
  processor: VoiceImportProcessor,
  events: VoiceImportEvents = {},
): VoiceImportRun {
  const { source, targetPath } = request
  const sourceLabel = voiceImportSourceLabel(source)
  const signal = { aborted: false }
  let cancelled = false

  const report = (ratio: number) => {
    const clamped = Math.max(0, Math.min(1, ratio))
    events.onProgress?.(clamped)
  }

  /** 先发浮窗、再落定报告（四种结果都从这里出去） */
  const notice = (message: string, ok: boolean) => {
    events.onNotice?.({ message, ok })
  }

  const fail = (
    outcome: Exclude<VoiceImportOutcome, 'success'>,
    failedTargetPath: string,
    detail?: string,
  ): VoiceImportReport => {
    const message = VOICE_IMPORT_RESULT[outcome]
    notice(message, false)
    return {
      ok: false,
      outcome,
      message,
      targetPath: failedTargetPath,
      bytes: 0,
      detail,
    }
  }

  const result = (async (): Promise<VoiceImportReport> => {
    // —— 取源字节：资产走 io 读，外部文件直接用拖进来的字节 ——
    let sourceBytes: Uint8Array | null = null
    if (source.kind === 'file') {
      sourceBytes = source.bytes
    } else {
      try {
        sourceBytes = await io.read(source.path)
      } catch (error) {
        return fail(
          'interrupted',
          targetPath,
          error instanceof Error ? error.message : String(error),
        )
      }
    }
    if (!sourceBytes || sourceBytes.byteLength === 0) {
      return fail('interrupted', targetPath, `读不到源音频：${sourceLabel}`)
    }

    // —— 分支 1 / 2：源就是目标对等文件本身（只有资产源才谈得上"就是那个文件"） ——
    if (source.kind === 'asset' && isSameVoiceFile(source.path, targetPath)) {
      let info: VoiceSourceInfo
      try {
        info = await processor.inspect(sourceBytes)
      } catch (error) {
        info = { alreadyTarget: false, detail: String(error) }
      }
      if (info.alreadyTarget) return fail('alreadyImported', targetPath)
      return fail('invalidSibling', targetPath, info.detail)
    }

    if (cancelled) return fail('interrupted', targetPath)

    // —— 处理阶段（前 2/3）：源已是单通道 ogg 时只读取，不转码 ——
    events.onPhase?.('process')
    report(0)
    let processed: Uint8Array
    try {
      const info = await processor.inspect(sourceBytes)
      if (info.alreadyTarget) {
        processed = sourceBytes
        report(VOICE_IMPORT_PROCESS_SHARE)
      } else {
        processed = await processor.process(
          sourceBytes,
          (ratio) => report(ratio * VOICE_IMPORT_PROCESS_SHARE),
          signal,
        )
        report(VOICE_IMPORT_PROCESS_SHARE)
      }
    } catch (error) {
      if (cancelled || signal.aborted) return fail('interrupted', targetPath)
      return fail(
        'interrupted',
        targetPath,
        error instanceof Error ? error.message : String(error),
      )
    }

    if (cancelled || signal.aborted) return fail('interrupted', targetPath)

    // —— 写入阶段（后 1/3）：原子策略在 io 里（IDB 原子 put / 磁盘 .new→删旧→改名） ——
    // 先把进度钉在 2/3（处理阶段的终点），再切到写入阶段
    report(VOICE_IMPORT_PROCESS_SHARE)
    events.onPhase?.('write')
    try {
      await io.write(targetPath, processed, 'audio/ogg', (ratio) =>
        report(
          VOICE_IMPORT_PROCESS_SHARE +
            (1 - VOICE_IMPORT_PROCESS_SHARE) *
              Math.max(0, Math.min(1, ratio)),
        ),
      )
    } catch (error) {
      if (cancelled) return fail('interrupted', targetPath)
      return fail(
        'interrupted',
        targetPath,
        error instanceof Error ? error.message : String(error),
      )
    }

    if (cancelled) return fail('interrupted', targetPath)

    report(1)
    notice(VOICE_IMPORT_RESULT.success, true)
    return {
      ok: true,
      outcome: 'success',
      message: VOICE_IMPORT_RESULT.success,
      targetPath,
      bytes: processed.byteLength,
    }
  })()

  return {
    result,
    cancel() {
      cancelled = true
      signal.aborted = true
    },
  }
}

/** 给界面用：目标必须是 .ogg，源可以在随便哪儿（资源管理器根目录是 assets） */
export function voiceImportTargetProblem(targetPath: string): string | null {
  if (!isVoiceOggPath(targetPath)) return '对等文件必须是 .ogg'
  if (!targetPath.toLowerCase().startsWith('assets/')) {
    return '对等文件必须在 assets/ 下'
  }
  return null
}
