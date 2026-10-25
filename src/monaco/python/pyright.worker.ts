import pyrightUrl from 'monaco-pyright-lsp/dist/worker.js?worker&url'

// The upstream bundle exposes its ZenFS instance after initServer. Keep Pyright itself
// unmodified; this narrow bridge supplies files that arrive later from the game RPC.
type WorkerScope = {
  postMessage(value: unknown): void
  addEventListener(name: string, callback: (event: MessageEvent) => void): void
  zenfs?: {
    mounts?:Map<string,{metadata:()=>{readonly?:boolean;[key:string]:unknown}}>
    mkdirSync(path: string, options: { recursive: boolean }): void
    writeFileSync(path: string, value: string, options: { encoding: string }): void
    unlinkSync(path: string): void
    existsSync(path: string): boolean
  }
}
const scope = self as unknown as WorkerScope
const boundedFilesystems=new WeakSet<object>()
scope.addEventListener('message', (event) => {
  const message = event.data
  if (message?.type !== 'hanshu/stubs') return
  event.stopImmediatePropagation()
  let currentPath=''
  try {
    if (!scope.zenfs) throw new Error('Pyright filesystem is not ready')
    // ZenFS defaults to a 4GB resizable backing reservation per file. Hundreds of
    // reflected Java stubs exhaust the browser address space despite tiny sources.
    // Use its metadata capability to request ordinary buffers on writable mounts.
    for(const fs of scope.zenfs.mounts?.values()??[]){
      if(boundedFilesystems.has(fs)||fs.metadata().readonly)continue
      const metadata=fs.metadata.bind(fs)
      fs.metadata=()=>({...metadata(),noResizableBuffers:true})
      boundedFilesystems.add(fs)
    }
    for (const [path, source] of Object.entries(message.files as Record<string, string | null>)) {
      if (!( /^(?:[A-Za-z_][A-Za-z0-9_]*\/)*[A-Za-z_][A-Za-z0-9_]*\.pyi$/.test(path) || (path.startsWith('project/')&&path.endsWith('.py')&&!path.split('/').some(p=>!p||p==='.'||p==='..'||/[\\:\x00-\x1f]/.test(p))) )) throw new Error('Invalid stub path')
      currentPath=path
      const absolute = `/typings/${path}`
      if (source === null) {
        if (scope.zenfs.existsSync(absolute)) scope.zenfs.unlinkSync(absolute)
      } else {
        scope.zenfs.mkdirSync(absolute.slice(0, absolute.lastIndexOf('/')), { recursive: true })
        scope.zenfs.writeFileSync(absolute, source, { encoding: 'utf-8' })
      }
    }
    scope.postMessage({ type: 'hanshu/stubsDone', id: message.id })
  } catch (error) {
    scope.postMessage({ type: 'hanshu/stubsDone', id: message.id, error: `Python 文件更新失败 ${currentPath}: ${String(error)}` })
  }
})
// Vite uses module workers in dev and classic bundled workers in production.
// Dynamic import works in both, whereas importScripts is forbidden in module workers.
void import(/* @vite-ignore */ pyrightUrl)
