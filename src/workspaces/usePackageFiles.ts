/**
 * "在工具工作区里编辑一类包内文件"的公共部分 —— 清单、选中、防抖写回、落定。
 *
 * 抽出来是因为这部分**容易写错且错得不明显**:写入要经 `ScriptWorkspace` 的包内通道
 * (直接写盘的文件会在保存时被清掉),防抖要在切文件/离开工作区/卸载三处都落定。
 * 界面各不相同,这段生命周期只有一个写法。
 *
 * **读**走 `useSyncExternalStore` 订阅 `packageBus` 的快照 —— 工程包是个外部系统,
 * 正文因此是**推导出来的**,不需要"用 effect 把它搬进 state"。
 * **写**仍然走 `ScriptWorkspaceHandle.writePackageText`,不在这里开第二条路。
 *
 * 本地只留一份 `draft`:用户正在敲、还没写回的内容。写回成功后清掉,让推导值接管。
 *
 * **手改正文永远写回,程序化重写才要求能解析。** 用户敲的每个字符都得存下来,
 * 否则他会在"文件暂时不合法"的那一刻丢掉编辑;而"改供应商"这类由我们重写文件的操作,
 * 读不懂就什么都不做 —— 把一份读不懂的内容覆盖成半截是最坏的。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,

} from 'react'
import { usePackageSnapshot, type PackageFile } from './packageBus'
import type { ScriptWorkspaceHandle } from './scriptTypes'

export type PackageFilesHandle = {
  /** 该后缀的文件名，已排序 */
  files: string[]
  selected: string | null
  text: string
  /** 最后一次成功写回工程的时间 */
  savedAt: number | null
  /** 新建失败的原因（名字非法 / 重名），下次成功时清掉 */
  reject: string | null
  /** 改正文并排队写回 */
  update: (next: string) => void
  /** 立刻落定未写完的那一笔 */
  flush: () => void
  select: (name: string) => void
  /** 新建并选中；失败时返回 null，原因在 `reject` 里 */
  create: (fileName: string, content: string) => string | null
}

export function usePackageFiles(options: {
  /** 工作区可见性 —— 切出去时落定未写完的那一笔 */
  active: boolean
  scriptRef: { current: ScriptWorkspaceHandle | null }
  /** 只列这个后缀（含点，小写） */
  extension: string
}): PackageFilesHandle {
  const { active, scriptRef, extension } = options

  const snapshot: readonly PackageFile[] = usePackageSnapshot()

  const files = useMemo(
    () =>
      snapshot
        .map((file) => file.name)
        .filter((name) => name.toLowerCase().endsWith(extension))
        .sort((a, b) => a.localeCompare(b, 'zh-CN')),
    [snapshot, extension],
  )

  const [picked, setPicked] = useState<string | null>(null)
  // 选中的文件被删掉时自动落到第一个 —— 推导，不需要"修正 state"的 effect
  const selected = picked && files.includes(picked) ? picked : (files[0] ?? null)

  const stored = useMemo(
    () => snapshot.find((file) => file.name === selected)?.content ?? '',
    [snapshot, selected],
  )

  /** 正在敲、还没写回的内容。切换文件时必须丢掉 */
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? stored

  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [reject, setReject] = useState<string | null>(null)

  const pendingRef = useRef<{ name: string; text: string } | null>(null)
  const timerRef = useRef<number | null>(null)

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const pending = pendingRef.current
    pendingRef.current = null
    if (!pending) return
    if (scriptRef.current?.writePackageText(pending.name, pending.text)) {
      setSavedAt(Date.now())
      // 写回已经广播了，草稿的使命结束，正文交回推导值
      setDraft(null)
    }
  }, [scriptRef])

  /**
   * 切出去时先落定。
   *
   * 严格说防抖计时器本来也会把它写掉，但那个窗口是 500ms —— 刚敲完就切走、
   * 紧接着关掉应用，这一笔就没了。宁可多一次 flush。
   */
  const wasActiveRef = useRef(active)
  useEffect(() => {
    const was = wasActiveRef.current
    wasActiveRef.current = active
    if (was && !active) flush()
  }, [active, flush])

  // 卸载同理
  useEffect(() => () => flush(), [flush])

  return useMemo(
    () => ({
      files,
      selected,
      text,
      savedAt,
      reject,
      flush,
      update: (next: string) => {
        setDraft(next)
        if (!selected) return
        pendingRef.current = { name: selected, text: next }
        if (timerRef.current !== null) window.clearTimeout(timerRef.current)
        // 每次提交都会把整个工作区序列化进 localStorage，所以不能跟着每个击键走
        timerRef.current = window.setTimeout(flush, 500)
      },
      select: (name: string) => {
        if (name === selected) return
        flush()
        setDraft(null)
        setPicked(name)
        setSavedAt(null)
      },
      create: (fileName: string, content: string) => {
        if (!fileName) return null
        setReject(null)
        flush()
        if (!scriptRef.current?.writePackageText(fileName, content)) {
          setReject(`「${fileName}」写不进工程 —— 名字可能不合法或已被占用`)
          return null
        }
        setDraft(null)
        setPicked(fileName)
        setSavedAt(Date.now())
        return fileName
      },
    }),
    [files, selected, text, savedAt, reject, flush, scriptRef],
  )
}

