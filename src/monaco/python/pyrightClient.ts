import PyrightWorker from './pyright.worker?worker'
import { BASE_STUBS } from './stubs'

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
type Message = { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string }; type?: string }

/** JSON-RPC transport to the actual Pyright worker; no Python parser or completion engine here. */
export class PyrightClient {
  private worker: Worker
  private pending = new Map<number, Pending>()
  private nextId = 0
  private initialized = false
  private disposed = false
  private cancelInitialization?: () => void
  readonly ready: Promise<void>
  onNotification?: (method: string, params: unknown) => void

  constructor(worker: Worker = new PyrightWorker()) {
    this.worker = worker
    this.ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Python 语言服务启动超时')), 30_000)
      this.cancelInitialization = () => { clearTimeout(timeout); reject(new Error('Python language service disposed')) }
      this.worker.onerror = (event) => { clearTimeout(timeout); reject(new Error(event.message || 'Python Worker 启动失败')); this.fail(new Error(event.message)) }
      this.worker.onmessage = (event: MessageEvent<Message>) => {
        const message = event.data
        if (message.type === 'serverLoaded') {
          this.worker.postMessage({ type: 'initServer', userFiles: BASE_STUBS })
        } else if (message.type === 'serverInitialized') {
          void this.initialize().then(() => { clearTimeout(timeout); resolve() }, (error) => { clearTimeout(timeout); reject(error) })
        } else if (message.type === 'hanshu/stubsDone' || (message.id !== undefined && !message.method)) {
          const pending = this.pending.get(message.id!)
          if (!pending) return
          this.pending.delete(message.id!)
          clearTimeout(pending.timer)
          if (message.error) pending.reject(new Error(typeof message.error === 'string' ? message.error : message.error.message))
          else pending.resolve(message.result)
        } else if (message.method && message.id !== undefined) {
          const params = message.params as { items?: { section?: string }[] }
          const analysis = { typeCheckingMode: 'basic', diagnosticMode: 'openFilesOnly', autoSearchPaths: false, stubPath: '/typings', extraPaths: ['/typings'], useLibraryCodeForTypes: false }
          const result = message.method === 'workspace/configuration' ? params.items?.map(item => item.section === 'python' ? { analysis } : item.section === 'python.analysis' ? analysis : {}) ?? [] : null
          this.worker.postMessage({ jsonrpc: '2.0', id: message.id, result })
        } else if (message.method) this.onNotification?.(message.method, message.params)
      }
    })
  }

  private async initialize() {
    await this.request('initialize', {
      processId: null, rootUri: 'file:///typings', rootPath: '/typings', capabilities: {
        // Upstream's shared-buffer cancellation is used only for server-initiated
        // requests. Push configuration instead, so no COOP/COEP headers are needed.
        workspace: { configuration: false },
        textDocument: { completion: { completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'] } }, hover: { contentFormat: ['markdown', 'plaintext'] }, publishDiagnostics: { versionSupport: true } },
      },
    })
    this.notify('initialized', {})
    this.notify('workspace/didChangeConfiguration', { settings: { python: { analysis: {
      stubPath: '/typings', extraPaths: ['/typings'], typeCheckingMode: 'basic', diagnosticMode: 'openFilesOnly', autoImportCompletions: false,
      // Java modules exist in GraalPy, not as Python source files in this virtual FS.
      diagnosticSeverityOverrides: { reportMissingModuleSource: 'none' },
    } } } })
    this.initialized = true
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('Python language service disposed'))
    const id = ++this.nextId
    const promise = this.wait(id)
    this.worker.postMessage({ jsonrpc: '2.0', id, method, params })
    return promise as Promise<T>
  }

  notify(method: string, params: unknown) { if (!this.disposed) this.worker.postMessage({ jsonrpc: '2.0', method, params }) }

  async writeStubs(files: Record<string, string | null>) {
    await this.ready
    if (!Object.keys(files).length) return
    const id = ++this.nextId
    const promise = this.wait(id)
    this.worker.postMessage({ type: 'hanshu/stubs', id, files })
    await promise
    this.notify('workspace/didChangeWatchedFiles', { changes: Object.entries(files).map(([path, source]) => ({ uri: `file:///typings/${path}`, type: source === null ? 3 : 1 })) })
    // Pyright caches failed import resolutions; invalidate after new packages arrive.
    await this.request('workspace/executeCommand', { command: 'pyright.restartserver', arguments: [] })
  }

  private wait(id: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Python 语言服务请求超时')) }, 20_000)
      this.pending.set(id, { resolve, reject, timer })
    })
  }

  private fail(error: Error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
  }

  dispose() {
    if (this.disposed) return
    if (this.initialized) this.notify('exit', null)
    this.disposed = true
    this.cancelInitialization?.()
    this.worker.terminate()
    this.fail(new Error('Python language service disposed'))
  }
}




