import {useEffect, useId, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {downloadLanguageDiagnostics} from './diagnostics'
import './languageDiagnostics.css'

export type LanguageDiagnosticsRequest = {name: string; report: Promise<unknown>; password: string}

export function LanguageDiagnosticsDialog({request, close}: {request: LanguageDiagnosticsRequest; close(): void}) {
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLTextAreaElement>(null), titleId = useId()
  const [description, setDescription] = useState(''), [snapshot, setSnapshot] = useState<{report: unknown} | null>(null), [error, setError] = useState('')
  useEffect(() => {
    const element = dialog.current!
    element.showModal(); input.current?.focus()
    let active = true
    void request.report.then(report => {if (active) setSnapshot({report})}, cause => {if (active) setError(String(cause))})
    return () => {active = false; element.close()}
  }, [request])
  const download = () => {
    if (!snapshot) return
    try {downloadLanguageDiagnostics(snapshot.report, description, request.name, request.password); close()}
    catch (cause) {setError(String(cause))}
  }
  return createPortal(<dialog ref={dialog} className="javascript-diagnostics-dialog" aria-labelledby={titleId} onCancel={event => {event.preventDefault(); close()}} onKeyDown={event => event.stopPropagation()}>
    <header><strong id={titleId}>导出语言服务诊断</strong><button type="button" aria-label="关闭语言服务诊断" onClick={close}>×</button></header>
    <p>包含当前脚本、相关虚拟文档、类型库状态和最近请求记录。只下载到本地，不会自动上传。</p>
    <label>问题现象与复现步骤（可选）<textarea ref={input} value={description} onChange={event => setDescription(event.target.value)} rows={5} placeholder="例如：第 4 行输入 player. 没有补全；预期能看到玩家的方法。也可以写下错误提示与操作步骤。" /></label>
    {error && <p role="alert">{error}</p>}
    <footer><span role="status">{snapshot ? '诊断已就绪，可下载并用于问题反馈。' : '正在收集诊断…'}</span><button type="button" disabled={!snapshot} onClick={download}>下载诊断文件</button></footer>
  </dialog>, document.body)
}
