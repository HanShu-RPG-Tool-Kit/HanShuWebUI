import { useEffect, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import { useProjectSession, getProjectSession } from '../../project/projectSession'
import { ResourceSaveStatus } from '../../project/ResourceSaveStatus'
import { controlRequest, isControlConnected } from '../../gameDevServer/controlHub'
import { createEffectResource, effectResourcePaths, validateEffectResource, type EffectParam, type EffectResource, type EffectResourceKind } from './effectResources'
import { readEffectResource, saveEffectResource, type EffectResourceSnapshot } from './effectResourceProject'
import { EffectValue } from './EffectValue'
import { EffectPipeline } from './EffectPipeline'
import './effectResourceEditor.css'

export function EffectResourceEditor({ initial, initialSnapshot, disabled, onClose, onPreview, onResource, onPending, onStop }: {
  initial?: EffectResource; initialSnapshot?: EffectResourceSnapshot; disabled?: boolean; onClose: () => void; onPreview: (resource: EffectResource) => Promise<void>; onResource: (resource: EffectResource) => void; onPending: (dirty: boolean) => void; onStop: () => void
}) {
  const project = useProjectSession(), client = project.binding?.handle.client
  const [ownedClient] = useState(client)
  const [resource, setResource] = useState(() => structuredClone(initial ?? createEffectResource()))
  const [snapshot, setSnapshot] = useState<EffectResourceSnapshot | null>(initialSnapshot ?? null)
  const [collision, setCollision] = useState(false)
  const [baseline, setBaseline] = useState(JSON.stringify(resource)), [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const [tab, setTab] = useState<'code' | 'params' | 'pipeline' | 'manifest'>('params'), [manifestText, setManifestText] = useState<string | null>(null), [confirmClose, setConfirmClose] = useState(false)
  const root = useRef<HTMLElement>(null), callbacks = useRef({ onPending, onClose }); callbacks.current = { onPending, onClose }
  const dirtyOwner = useRef(`effect-resource:${crypto.randomUUID()}`)
  const [canRestore, setCanRestore] = useState(false)
  const lastGood = useRef<EffectResource | null>(null)
  const audition = useRef<EffectResource | null>(null), previewCallback = useRef(onPreview); previewCallback.current = onPreview
  const dirty = !snapshot || JSON.stringify(resource) !== baseline || manifestText !== null
  let problem = ''
  try { validateEffectResource(resource); if (manifestText !== null) validateEffectResource({ ...resource, manifest: JSON.parse(manifestText) }) } catch (error) { problem = (error as Error).message }
  let paths: string[] = []
  try { paths = effectResourcePaths(resource.kind, resource.id) } catch { /* Invalid names stay editable. */ }
  const writable = !disabled && !!client?.writable && client === ownedClient
  useEffect(() => { callbacks.current.onPending(dirty); return () => callbacks.current.onPending(false) }, [dirty])
  useEffect(() => { root.current?.focus() }, [])
  useEffect(() => {
    let inFlight = false
    const timer = setInterval(() => { if (!audition.current || inFlight) return; inFlight = true; void previewCallback.current(audition.current).catch(error => { audition.current = null; setMessage(`预览已暂停：${(error as Error).message}`) }).finally(() => { inFlight = false }) }, 3000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    if (!client) return
    const owner = dirtyOwner.current
    client.transactions.setEditorDirty(owner, dirty ? paths : [])
    return () => client.transactions.setEditorDirty(owner, [])
  }, [client, dirty, paths.join('|')])
  useEffect(() => {
    if (!client || !paths[0]) return
    const focus = client.editing.claimFocus(paths[0], { entryId: null })
    return () => client.editing.releaseFocus(focus)
  }, [client, paths[0]])
  async function load() {
    if (!client) { setMessage('请先打开工程'); return }
    setBusy(true); setMessage('')
    try { const next = await readEffectResource(client, resource); if (getProjectSession().binding?.handle.client !== client) throw Error('工程已切换，输入仍保留'); setResource(next.resource); setSnapshot(next); setCollision(false); setBaseline(JSON.stringify(next.resource)); setManifestText(null); setMessage(next.versions.every(v => v === null) ? '这是新的效果资源；保存时同时创建定义和源码。' : '已读取工程资源及其版本。') } catch (error) { setMessage((error as Error).message) } finally { setBusy(false) }
  }
  async function save() {
    if (!client || !writable || problem || collision) return
    setBusy(true); setMessage('')
    try {
      let captured = snapshot
      if (!captured || captured.resource.id !== resource.id || captured.resource.kind !== resource.kind) {
        captured = await readEffectResource(client, resource)
        if (captured.versions.some(Boolean)) { setCollision(true); setMessage('同名资源已存在。请先读取并审阅，再编辑保存；当前输入保留。'); return }
      }
      if (getProjectSession().binding?.handle.client !== client) throw Error('工程已切换，当前输入保留')
      await saveEffectResource(client, { ...captured, resource }, dirtyOwner.current)
      setBaseline(JSON.stringify(resource)); setManifestText(null)
      const refreshed = await readEffectResource(client, resource); setSnapshot(JSON.stringify(refreshed.resource) === JSON.stringify(resource) ? refreshed : captured)
      try { onResource(resource) } catch (error) { setMessage(`资源已保存，但未应用到区域：${(error as Error).message}`); return }
      setMessage('效果定义与GLSL源码已通过工程事务保存。保存不代表着色器已通过游戏编译。')
    } catch (error) { setMessage((error as Error).message) } finally { setBusy(false) }
  }
  async function preview() {
    if (problem) return
    setBusy(true); setMessage('正在由游戏客户端编译…')
    try { await onPreview(resource); audition.current = structuredClone(resource); lastGood.current = structuredClone(resource); setCanRestore(true); setMessage('编译通过，正在游戏画面中预览；工程文件尚需显式保存。') } catch (error) { setMessage(`编译／预览失败，输入保留，上一次成功预览不变。\n${(error as Error).message}`) } finally { setBusy(false) }
  }
  async function copyGame() {
    setBusy(true)
    try { const result = await controlRequest('level.effects.source', { kind: resource.kind, id: resource.id }) as EffectResource; setCollision(false); setResource({ ...result, id: `project:${resource.id.split(':')[1]}` }); setSnapshot(null); setMessage('已复制到工程命名空间，原游戏资源保持不变。请为副本命名后保存。') } catch (error) { setMessage((error as Error).message) } finally { setBusy(false) }
  }
  function changeParam(name: string, change: Partial<EffectParam>) { setResource(r => ({ ...r, manifest: { ...r.manifest, params: { ...r.manifest.params, [name]: { ...r.manifest.params![name], ...change } } } })) }
  function close() { if (busy) return; if (dirty) setConfirmClose(true); else onClose() }
  return <div className="effect-author-backdrop" onMouseDown={e => e.stopPropagation()}><section className="effect-author" role="dialog" aria-modal="true" aria-label="自定义着色器效果" tabIndex={-1} ref={root} onKeyDown={e => {
    e.stopPropagation()
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save() }
    if (e.key === 'Escape') { e.preventDefault(); close() }
    if (e.key === 'Tab') { const nodes = Array.from(root.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')).filter(n => n.getClientRects().length); const first=nodes[0],last=nodes.at(-1); if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()} }
  }}>
    <header><div><p>制作效果 · 工程资源</p><h2>自定义着色器</h2></div><button type="button" onClick={close} aria-label="关闭着色器编辑器">×</button></header>
    <div className="effect-author-settings"><label>效果类型<select aria-label="着色器效果类型" value={resource.kind} disabled={busy || !writable} onChange={e => { const next=createEffectResource(e.target.value as EffectResourceKind);setResource(next);setSnapshot(null);setCollision(false);setManifestText(null);setTab('params') }}><option value="post">画面滤镜</option><option value="sky">天空图层</option><option value="transition">切换转场</option></select></label><label>资源ID<input aria-label="着色器资源ID" value={resource.id} disabled={busy || !writable} onChange={e => { setResource(r => ({...r,id:e.target.value}));setSnapshot(null);setCollision(false) }} /></label><label>显示名称<input aria-label="着色器显示名称" value={resource.manifest.description ?? ''} disabled={busy || !writable} onChange={e => setResource(r => ({ ...r, manifest: { ...r.manifest, description: e.target.value } }))} /></label></div>
    <div className="effect-author-paths">{paths.map(path => <code key={path}>{path}</code>)}</div>
    <nav role="tablist" aria-label="着色器编辑内容">{[['params','参数与控件'],['code','GLSL 源码'],...(resource.kind==='post'?[['pipeline','渲染步骤']]:[]),['manifest','高级定义']] .map(([value,label]) => <button type="button" role="tab" aria-selected={tab===value} key={value} onClick={() => { setTab(value as typeof tab) }}>{label}</button>)}<button type="button" disabled={busy || !client} onClick={() => { void load() }}>读取工程资源</button><button type="button" disabled={busy || !isControlConnected()} onClick={() => { void copyGame() }}>复制游戏资源</button></nav>
    <main>
      <p className="effect-author-hint">先用颜色和滑块调整效果，点击「编译并预览」在游戏中确认。参数定义、GLSL 和渲染步骤供制作新效果使用。</p>
      {tab==='pipeline' && <EffectPipeline resource={resource} disabled={!writable||busy} onChange={setResource}/>}
      {tab==='code' && <><div className="effect-author-code"><Editor height="100%" language="cpp" theme="vs-dark" value={resource.source} path={`region-effect://${resource.kind}/${resource.id}.glsl`} onChange={value => setResource(r=>({...r,source:value??''}))} options={{ readOnly: !writable || busy, automaticLayout:true,ariaLabel:'GLSL源码',minimap:{enabled:false},fontSize:14,wordWrap:'on',scrollBeyondLastLine:false }} /></div><p className="effect-author-hint">框架提供版本声明、uniform和入口包装。天空写 sky(vec3)，滤镜写 process(vec2)，转场写 transition(vec2)。GLSL变量使用参数名，界面显示你填写的中文标签。</p></>}
      {tab==='params' && <div className="effect-author-params">{Object.entries(resource.manifest.params??{}).map(([name,p])=><section key={name}><details className="effect-author-param-definition"><summary>定义这个控件</summary><div className="effect-author-param-head"><label>参数名<input aria-label={`参数名 ${name}`} defaultValue={name} disabled={!writable||busy} onBlur={e=>{const key=e.target.value;if(key!==name&&resource.manifest.params?.[key]){setMessage('参数名已存在');e.target.value=name;return;}setResource(r=>{const params=Object.fromEntries(Object.entries(r.manifest.params??{}).map(([k,v])=>[k===name?key:k,v]));return {...r,manifest:{...r.manifest,params}}})}} /></label><label>中文标签<input aria-label={`中文标签 ${name}`} value={p.label??''} disabled={!writable||busy} onChange={e=>changeParam(name,{label:e.target.value})}/></label><label>类型<select aria-label={`参数类型 ${name}`} value={p.type} disabled={!writable||busy} onChange={e=>{const type=e.target.value;changeParam(name,{type,default:type==='color'?'#ffffff':type==='bool'?false:type==='texture'?'rpgtoolkit:textures/effect/white.png':type.startsWith('vec')?Array(Number(type.slice(3))).fill(0):0,min:undefined,max:undefined,filter:undefined,wrap:undefined})}}>{['float','bool','color','vec2','vec3','vec4','texture'].map(t=><option key={t} value={t}>{({float:'数字',bool:'开关',color:'颜色',vec2:'二维向量',vec3:'三维向量',vec4:'四维向量',texture:'贴图'} as Record<string,string>)[t]}</option>)}</select></label></div></details><EffectValue field={{ key:name,label:p.label||name,type:p.type==='float'?'number':p.type==='bool'?'boolean':p.type,default:p.default,min:p.min,max:p.max,step:.01 }} value={p.default} disabled={!writable||busy} onChange={value=>changeParam(name,{default:value??p.default})}/>{p.type==='texture' && <div className="effect-author-range"><label>纹理采样<select aria-label={`纹理采样 ${name}`} value={p.filter??'linear'} disabled={!writable||busy} onChange={e=>changeParam(name,{filter:e.target.value})}><option value="linear">平滑过渡</option><option value="nearest">清晰像素</option></select></label><label>边缘处理<select aria-label={`边缘处理 ${name}`} value={p.wrap??'clamp'} disabled={!writable||busy} onChange={e=>changeParam(name,{wrap:e.target.value})}><option value="clamp">延展边缘</option><option value="repeat">平铺重复</option></select></label></div>}{['float','vec2','vec3','vec4'].includes(p.type)&&<div className="effect-author-range">{(['min','max'] as const).map(key=><label key={key}>{key==='min'?'最小值':'最大值'}<input type="number" aria-label={`${name} ${key}`} value={p[key]??''} disabled={!writable||busy} onChange={e=>changeParam(name,{[key]:e.target.value===''?undefined:Number(e.target.value)})}/></label>)}</div>}<button type="button" disabled={!writable||busy} onClick={()=>setResource(r=>{const params={...r.manifest.params};delete params[name];return {...r,manifest:{...r.manifest,params}}})}>移除此参数</button></section>)}<button type="button" disabled={!writable||busy||Object.keys(resource.manifest.params??{}).length>=16} onClick={()=>{let name='parameter';for(let i=2;resource.manifest.params?.[name];i++)name='parameter_'+i;changeParam(name,{type:'float',label:'自定义参数',default:0,min:0,max:1})}}>＋ 添加可视化参数</button></div>}
      {tab==='manifest' && <div className="effect-author-code"><Editor height="100%" language="json" theme="vs-dark" value={manifestText??JSON.stringify(resource.manifest,null,2)} onChange={value=>{setManifestText(value??'');try{const manifest=JSON.parse(value??'');validateEffectResource({...resource,manifest});setResource(r=>({...r,manifest}));setManifestText(null)}catch{/* Keep invalid text. */}}} options={{readOnly:!writable||busy,ariaLabel:'效果高级定义',automaticLayout:true,minimap:{enabled:false},fontSize:14,scrollBeyondLastLine:false}} /></div>}
    </main>
    {(problem||message)&&<pre className={problem||message.includes('失败')?'effect-author-error':'effect-author-status'} role={problem||message.includes('失败')?'alert':'status'}>{problem||message}</pre>}
    {client&&paths.length===2&&<ResourceSaveStatus client={client} path={paths[0]} dirty={dirty} compact/>}
    <footer><span>{dirty?'资源有未保存修改':'工程资源'} · 预览不会发布PAK</span><button type="button" disabled={busy||!!problem||!writable||collision} onClick={()=>{void save()}}>{busy?'处理中…':'保存资源'}</button><button type="button" disabled={busy||!!problem||!writable||!isControlConnected()} onClick={()=>{void preview()}}>编译并预览</button><button type="button" disabled={busy || !canRestore} onClick={() => { if (lastGood.current) { setResource(structuredClone(lastGood.current)); setManifestText(null); setMessage('已恢复上次编译成功的输入，工程文件未更改。') } }}>恢复上次成功版本</button><button type="button" onClick={() => { audition.current = null; onStop(); setMessage('已停止预览并恢复游戏环境') }}>停止预览</button><button type="button" onClick={close}>关闭</button></footer>
    {confirmClose&&<div className="effect-author-confirm" role="alertdialog" aria-label="未保存着色器资源"><p>当前源码或参数尚未保存。</p><button type="button" onClick={()=>setConfirmClose(false)}>继续编辑</button><button type="button" onClick={onClose}>放弃未保存输入并关闭</button></div>}
  </section></div>
}
