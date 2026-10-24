import { BASE_STUBS, PLAYER_CLASS, buildJavaFiles, type JavaStub, type StubResponse } from './stubs'

export class JavaStubLoader {
  readonly classes = new Map<string, JavaStub>()
  readonly byUri = new Map<string, string>()
  private missing = new Set<string>()
  private runtimeId = ''
  private files: Record<string, string> = { ...BASE_STUBS }
  private queue: Promise<unknown> = Promise.resolve()

  private fetchStubs: (classes: string[]) => Promise<StubResponse>
  private writeFiles: (files: Record<string, string | null>) => Promise<void>

  constructor(fetchStubs: (classes: string[]) => Promise<StubResponse>, writeFiles: (files: Record<string, string | null>) => Promise<void>) {
    this.fetchStubs = fetchStubs
    this.writeFiles = writeFiles
  }

  reconnect() {
    return this.enqueue(async () => {
      const response = await this.fetchStubs([])
      this.checkResponse(response)
      if (response.runtimeId !== this.runtimeId) {
        this.classes.clear()
        this.missing.clear()
        this.runtimeId = response.runtimeId
        await this.publish()
      }
      await this.load([PLAYER_CLASS])
    })
  }

  ensure(names: string[]) {
    return this.enqueue(() => this.load(names))
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(action)
    this.queue = next
    return next
  }

  private async load(names: string[]) {
    const pending = [...new Set(names)].filter(name => !this.classes.has(name) && !this.missing.has(name))
    for (let offset = 0; offset < pending.length; offset += 24) {
      const response = await this.fetchStubs(pending.slice(offset, offset + 24))
      this.checkResponse(response)
      if (this.runtimeId && response.runtimeId !== this.runtimeId) {
        this.classes.clear()
        this.missing.clear()
      }
      this.runtimeId = response.runtimeId
      for (const stub of response.classes) this.classes.set(stub.name, stub)
      for (const name of response.missing) this.missing.add(name)
    }
    if (pending.length) await this.publish()
    return pending.some(name => this.classes.has(name))
  }

  private checkResponse(response: StubResponse) {
    if (response.schemaVersion !== 1 || typeof response.runtimeId !== 'string' || !Array.isArray(response.classes) || !Array.isArray(response.missing)) throw new Error('不兼容的 Python 类型存根协议')
  }

  private async publish() {
    const next = buildJavaFiles(this.classes.values())
    const changed: Record<string, string | null> = {}
    for (const [path, source] of Object.entries(next.files)) if (source !== this.files[path]) changed[path] = source
    for (const path of Object.keys(this.files)) if (!(path in next.files)) changed[path] = null
    await this.writeFiles(changed)
    this.files = next.files
    this.byUri.clear()
    for (const [uri, name] of next.byUri) this.byUri.set(uri, name)
  }

  /** Pyright hover includes inferred return types even when a function has no type-definition URI. */
  typesMentioned(hover: string): string[] {
    const words = new Set(hover.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])
    return [...new Set([...this.byUri.values()])].filter(name => !this.classes.has(name) && words.has(name.split(/[.$]/).at(-1)!))
  }
}
