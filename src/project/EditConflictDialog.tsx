import { useState } from 'react'
import { conflictEdits, inspectConflict, type ConflictChoice, type ConflictInspection } from './editConflicts'
import type { ProjectClient } from './serviceClient'

export function EditConflictDialog({client,initial,onClose}:{client:ProjectClient;initial:ConflictInspection;onClose:()=>void}) {
  const [inspection,setInspection] = useState(initial)
  const [busy,setBusy] = useState(false)
  const [error,setError] = useState('')
  async function run(action:()=>Promise<void>) {
    if (busy) return
    setBusy(true);setError('')
    try { await action() } catch(e) {setError(e instanceof Error?e.message:String(e))} finally {setBusy(false)}
  }
  function choose(group:number,choice:ConflictChoice) {
    setInspection(current=>({...current,rows:current.rows.map(row=>row.group===group?{...row,choice}:row)}))
  }
  const operation = {write:'写入',mkdir:'目录',remove:'删除',move:'移动'}
  return <div className="project-conflict-backdrop">
    <section className="project-conflict-dialog" role="dialog" aria-modal="true" aria-label="处理提交冲突">
      <header><div><h2>处理提交冲突</h2><p>逐项选择处理方式，最后作为一批提交。服务器版本再次变化时会停止提交。</p></div><button disabled={busy} onClick={onClose} aria-label="关闭冲突处理">×</button></header>
      <div className="project-conflict-files">
        {inspection.rows.map((row,index)=><article key={`${index}:${row.edit.path}`} aria-label={`冲突文件 ${row.edit.path}`}>
          <div className="project-conflict-file-heading"><strong>{row.edit.path}</strong><span>{operation[row.edit.op]}{row.edit.destination?` → ${row.edit.destination}`:''}</span></div>
          <div className="project-conflict-choices" role="group" aria-label={`${row.edit.path}处理方式`}>
            <button disabled={busy} aria-pressed={row.choice==='server'} onClick={()=>choose(row.group,'server')}>采用服务器版本</button>
            <button disabled={busy} aria-pressed={row.choice==='local'} onClick={()=>choose(row.group,'local')}>保留本地修改</button>
            {row.edit.op==='write' && row.localText!==undefined && inspection.rows.filter(r=>r.group===row.group).length===1 && <button disabled={busy} aria-pressed={row.choice==='manual'} onClick={()=>choose(row.group,'manual')}>手动合并</button>}
          </div>
          {row.localText!==undefined || row.remote.text!==undefined || row.baseText!==undefined ? <div className="project-conflict-columns">
            <label>原始版本<textarea aria-label={`原始版本 ${row.edit.path}`} readOnly value={row.baseText??''} placeholder={row.edit.version?'未缓存原文，可对照服务器版本':'原来不存在'}/></label>
            <label>服务器版本<textarea aria-label={`服务器版本 ${row.edit.path}`} readOnly value={row.remote.text??''} placeholder={row.remote.kind==='directory'?'目录':row.remote.kind?'二进制文件':'服务器上不存在'}/></label>
            <label>{row.choice==='manual'?'合并结果':'本次提交的内容'}<textarea aria-label={`合并结果 ${row.edit.path}`} readOnly={row.choice!=='manual'||busy} value={row.merged} onChange={e=>setInspection(current=>({...current,rows:current.rows.map((r,i)=>i===index?{...r,merged:e.target.value}:r)}))} placeholder={row.edit.op==='remove'?'本次操作会删除文件':row.edit.op==='move'?'本次操作会移动文件':'无文本内容'}/></label>
          </div> : <p>本地操作：{operation[row.edit.op]}。服务器：{row.remote.kind==='directory'?'目录':row.remote.kind?'二进制文件':'不存在'}{row.remote.data?` · ${row.remote.data.size.toLocaleString()} 字节`:''}。二进制文件保留完整内容，不进行文本合并。</p>}
          {row.destination && <p>目标路径当前状态：{row.destination.kind??'不存在'}。移动和目标写入共用同一处理方式。</p>}
        </article>)}
      </div>
      <footer>{error&&<p role="alert">{error}</p>}<button disabled={busy} onClick={()=>void run(async()=>setInspection(await inspectConflict(client,inspection.id)))}>重新载入服务器版本</button><button disabled={busy} onClick={onClose}>暂不处理</button><button disabled={busy||!client.writable} onClick={()=>void run(async()=>{const edits=conflictEdits(inspection);client.assertEditingIntent(edits);await client.transactions.resolve(inspection.id,edits);onClose()})}>{busy?'正在处理…':'提交处理结果'}</button></footer>
    </section>
  </div>
}
