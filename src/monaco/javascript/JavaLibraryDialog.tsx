import {useEffect,useRef,useState,useSyncExternalStore} from 'react'
import {createPortal} from 'react-dom'
import {getControlHubSnapshot,isControlConnected,subscribeControlHub} from '../../gameDevServer/controlHub'
import {readJavaLibrary,syncJavaLibrary,type JavaLibrary} from './javaLibrary'
import './languageDiagnostics.css'

export function JavaLibraryDialog({close}:{close:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null),abort=useRef<AbortController|null>(null)
 const hub=useSyncExternalStore(subscribeControlHub,getControlHubSnapshot)
 const [library,setLibrary]=useState<JavaLibrary>(),[busy,setBusy]=useState(false),[status,setStatus]=useState(''),[error,setError]=useState('')
 useEffect(()=>{const d=dialog.current!;d.showModal();return ()=>{abort.current?.abort();d.close()}},[])
 useEffect(()=>{let active=true;void readJavaLibrary().then(value=>{if(active)setLibrary(value)},cause=>{if(active)setError(String(cause))});return ()=>{active=false}},[hub.prefs.host,hub.prefs.port])
 const start=async()=>{const controller=new AbortController();abort.current=controller;setBusy(true);setError('');setStatus('正在扫描游戏类型…');try{const result=await syncJavaLibrary(controller.signal,(current,total,count,bytes)=>setStatus(`${current} / ${total} 个候选，已获取 ${count} 个类，${(bytes/1048576).toFixed(1)} MiB`));setLibrary(result);setStatus('同步完成，离线也可使用。')}catch(cause){setError(String(cause))}finally{setBusy(false);abort.current=null}}
 return createPortal(<dialog ref={dialog} className="javascript-diagnostics-dialog" aria-label="同步游戏类型库" onCancel={e=>{e.preventDefault();if(busy)abort.current?.abort();else close()}} onKeyDown={e=>e.stopPropagation()}>
  <header><strong>同步游戏类型库</strong><button onClick={close}>关闭</button></header>
  <p>手动获取当前游戏可读取的公开 Java 类型和 hook 信息，保存在本机。游戏离线、刷新或重启 WebUI 后仍可使用。不会自动同步完整库。</p>
  <p>{library?`上次同步：${new Date(library.capturedAt).toLocaleString()} · Java ${library.javaVersion} · ${library.classes.length} 个类 · ${(library.bytes/1048576).toFixed(1)} MiB · ${library.skipped} 个不可用候选`:'当前游戏地址尚无本地类型库。'}</p>
  {!!library?.mods?.length&&<details><summary>同步时的游戏与模组版本</summary><p>{library.mods.join(' · ')}</p></details>}
  <p>缓存按游戏地址区分；更换游戏或模组版本后，请重新同步。新库完整保存成功后才替换旧库；失败或取消保留旧库。</p>
  {!isControlConnected()&&<p>连接游戏开发服务器后可同步；已有缓存仍可离线使用。</p>}
  <p role="status">{status}</p>{error&&<p role="alert">{error}</p>}
  <footer><span>仅保存本机提示数据，不修改工程。</span>{busy?<button onClick={()=>abort.current?.abort()}>取消同步</button>:<button disabled={!isControlConnected()} onClick={()=>void start()}>开始同步</button>}</footer>
 </dialog>,document.body)
}
