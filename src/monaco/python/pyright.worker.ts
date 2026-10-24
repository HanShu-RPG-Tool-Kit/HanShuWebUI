import pyrightUrl from 'monaco-pyright-lsp/dist/worker.js?worker&url'

// The upstream bundle exposes its ZenFS instance after initServer. Keep Pyright itself
// unmodified; this narrow bridge supplies files that arrive later from the game RPC.
type WorkerScope = {
  postMessage(value: unknown): void
  addEventListener(name: string, callback: (event: MessageEvent) => void): void
  zenfs?: {
    mkdirSync(path: string, options: { recursive: boolean }): void
    writeFileSync(path: string, value: string, options: { encoding: string }): void
    unlinkSync(path: string): void
    existsSync(path: string): boolean
  }
}
const scope = self as unknown as WorkerScope
scope.addEventListener('message', (event) => {
  const message = event.data
  if (message?.type !== 'hanshu/stubs') return
  event.stopImmediatePropagation()
  try {
    if (!scope.zenfs) throw new Error('Pyright filesystem is not ready')
    for (const [path, source] of Object.entries(message.files as Record<string, string | null>)) {
      if (!/^(?:[A-Za-z_][A-Za-z0-9_]*\/)*[A-Za-z_][A-Za-z0-9_]*\.pyi$/.test(path)) throw new Error('Invalid stub path')
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
    scope.postMessage({ type: 'hanshu/stubsDone', id: message.id, error: String(error) })
  }
})
// Vite uses module workers in dev and classic bundled workers in production.
// Dynamic import works in both, whereas importScripts is forbidden in module workers.
void import(/* @vite-ignore */ pyrightUrl)
