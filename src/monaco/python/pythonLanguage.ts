import {pythonProfile} from './profiles'
import {getProjectSession,subscribeProjectSession} from '../../project/projectSession'
import {effectiveBuiltinScripts,scriptType,type ScriptType} from '../../scriptResources'
import type * as Monaco from 'monaco-editor'
import type { CompletionItem, CompletionList, Diagnostic, Hover, Location, LocationLink, Range, SignatureHelp, TextEdit } from 'vscode-languageserver'
import { controlRequest, isControlConnected, subscribeControlHub } from '../../gameDevServer/controlHub'
import { PyrightClient } from './pyrightClient'
import { JavaStubLoader } from './stubLoader'
import { importedJavaClasses, type StubResponse } from './stubs'

type Document = { model: Monaco.editor.ITextModel; uri: string; version: number; timer?: ReturnType<typeof setTimeout>; listener: Monaco.IDisposable; refs: number }
type MonacoModule = typeof Monaco
type SharedService = { service: PythonLanguage; users: Set<symbol> }
const services=new Map<string,SharedService>()
const projectKeys=new WeakMap<object,number>();let projectSequence=0

function hoverText(hover: Hover | null): string {
  if (!hover) return ''
  const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents]
  return contents.map(value => typeof value === 'string' ? value : value.value).join('\n\n')
}

/** One Worker, multiple isolated LSP documents. Dispose registrations with the final editor. */
export function attachPython(monaco: MonacoModule, model: Monaco.editor.ITextModel, reportError: (error: unknown) => void, type:ScriptType='common') {
  const project=getProjectSession().binding?.handle.client
  if(project&&!projectKeys.has(project))projectKeys.set(project,++projectSequence)
  const key=`${project?projectKeys.get(project):'unbound'}:${type}`
  const user = Symbol('python-editor')
  let current: SharedService | undefined
  let detach: (() => void) | undefined
  let disposed = false
  let failed = false
  const release = () => {
    detach?.(); detach = undefined
    if (!model.isDisposed()) monaco.editor.setModelMarkers(model, 'hanshu-pyright', [])
    const previous = current
    current = undefined
    if (!previous) return
    previous.users.delete(user)
    if (!previous.users.size) {
      previous.service.dispose()
      if (services.get(key)===previous)services.delete(key)
    }
  }
  const syncConnection = () => {
    if (disposed) return
    if (!isControlConnected()||getProjectSession().binding?.handle.client!==project) { release(); failed = false; return }
    if (current || failed || model.isDisposed()) return
    let next=services.get(key)
    if(!next){next={service:new PythonLanguage(monaco,reportError,type),users:new Set()};services.set(key,next)}
    current = next
    next.users.add(user)
    void next.service.ready.then(() => {
      if (disposed || current !== next || !isControlConnected() || model.isDisposed()) return
      detach = next.service.attach(model)
    }).catch(() => {
      if (current !== next) return
      failed = true
      release()
    })
  }
  const stopControl = subscribeControlHub(syncConnection)
  const stopProject=subscribeProjectSession(syncConnection)
  syncConnection()
  return { dispose() { disposed = true; stopControl();stopProject(); release() } }
}

export class PythonLanguage {
  readonly client:PyrightClient
  readonly stubs:JavaStubLoader
  private scriptType:ScriptType
  private projectFiles:Record<string,string>={}
  readonly ready: Promise<void>
  readonly documents = new Map<string, Document>()
  private disposables: Monaco.IDisposable[] = []
  private sequence = 0
  private disposed = false
  private warned = false
  private resolvedItems = new WeakMap<Monaco.languages.CompletionItem, CompletionItem>()

  private monaco: MonacoModule
  private reportError: (error: unknown) => void

  constructor(monaco: MonacoModule, reportError: (error: unknown) => void, type:ScriptType='common') {
    this.scriptType=type
    const profile=pythonProfile(type)
    this.client=new PyrightClient(undefined,profile.files)
    this.stubs=new JavaStubLoader(async classes=>controlRequest('python.stubs',{classes}) as Promise<StubResponse>,files=>this.client.writeStubs(files),profile.files,profile.requiredClasses)
    const project=getProjectSession().binding?.handle.client
    const syncProject=async()=>{
      if(this.disposed||getProjectSession().binding?.handle.client!==project)return
      const scripts=getProjectSession().workspace.packages.flatMap(p=>p.scripts).filter(s=>s.name.toLowerCase().endsWith('.py'))
      const files:Record<string,string>={}
      for(const s of effectiveBuiltinScripts(scripts))files[`project/${s.type}/${s.name}`]=s.source
      for(const s of scripts)files[`project/${scriptType(s.srcKind)}/${s.name}`]=s.content
      const changes:Record<string,string|null>={}
      for(const [path,source] of Object.entries(files))if(this.projectFiles[path]!==source)changes[path]=source
      for(const path of Object.keys(this.projectFiles))if(!(path in files))changes[path]=null
      this.projectFiles=files
      await this.client.writeStubs(changes)
    }
    let projectTimer:ReturnType<typeof setTimeout>|undefined
    const unsubscribe=subscribeProjectSession(()=>{clearTimeout(projectTimer);projectTimer=setTimeout(()=>void syncProject().catch(e=>this.warn(e)),300)})
    this.disposables.push({dispose:()=>{unsubscribe();clearTimeout(projectTimer)}})

    this.monaco = monaco
    this.reportError = reportError
    this.client.onNotification = (method, params) => {
      if (this.disposed || method !== 'textDocument/publishDiagnostics') return
      const diagnostics = params as { uri: string; version?: number; diagnostics: Diagnostic[] }
      const document = [...this.documents.values()].find(doc => doc.uri === diagnostics.uri)
      if (!document || document.model.isDisposed() || (diagnostics.version !== undefined && diagnostics.version !== document.version)) return
      monaco.editor.setModelMarkers(document.model, 'hanshu-pyright', diagnostics.diagnostics.map(diag => ({
        ...this.range(diag.range), message: diag.message, source: 'Pyright',
        severity: diag.severity === 1 ? monaco.MarkerSeverity.Error : diag.severity === 2 ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
      })))
    }
    this.disposables.push(monaco.languages.registerCompletionItemProvider('python', {
      triggerCharacters: ['.', '(', '"', "'"],
      provideCompletionItems: async (model, position, _context, token) => {
        const doc = this.documents.get(model.uri.toString())
        if (!doc) return { suggestions: [] }
        try {
          await this.prepare(doc, position)
          if (token.isCancellationRequested) return { suggestions: [] }
          const result = await this.client.request<CompletionList | CompletionItem[] | null>('textDocument/completion', this.at(doc, position))
          const items = Array.isArray(result) ? result : result?.items ?? []
          return { incomplete: !Array.isArray(result) && !!result?.isIncomplete, suggestions: items.filter(item => !/^(?:jvm_|__kit_context|__goal_context|__builtins__)/.test(item.label)).map(item => this.completion(item, model, position)) }
        } catch (error) { this.warn(error); return { suggestions: [] } }
      },
      resolveCompletionItem: async item => {
        const original = this.resolvedItems.get(item)
        if (!original) return item
        try {
          const result = await this.client.request<CompletionItem>('completionItem/resolve', original)
          return { ...item, detail: result.detail ?? item.detail, documentation: this.documentation(result.documentation) }
        } catch { return item }
      },
    }))
    this.disposables.push(monaco.languages.registerHoverProvider('python', {
      provideHover: async (model, position) => {
        const doc = this.documents.get(model.uri.toString())
        if (!doc) return null
        try {
          await this.prepare(doc, position)
          const result = await this.client.request<Hover | null>('textDocument/hover', this.at(doc, position))
          return result ? { contents: [{ value: hoverText(result) }], range: result.range ? this.range(result.range) : undefined } : null
        } catch (error) { this.warn(error); return null }
      },
    }))
    this.disposables.push(monaco.languages.registerSignatureHelpProvider('python', {
      signatureHelpTriggerCharacters: ['(', ','], signatureHelpRetriggerCharacters: [','],
      provideSignatureHelp: async (model, position) => {
        const doc = this.documents.get(model.uri.toString())
        if (!doc) return null
        try {
          await this.prepare(doc, position)
          const result = await this.client.request<SignatureHelp | null>('textDocument/signatureHelp', this.at(doc, position))
          if (!result) return null
          return { dispose() {}, value: { activeSignature: result.activeSignature ?? 0, activeParameter: result.activeParameter ?? 0, signatures: result.signatures.map(signature => ({ label: signature.label, documentation: this.documentation(signature.documentation), parameters: (signature.parameters ?? []).map(parameter => ({ label: parameter.label, documentation: this.documentation(parameter.documentation) })) })) } }
        } catch (error) { this.warn(error); return null }
      },
    }))
    // Do not open documents until actual game stubs are ready: incomplete runtime
    // context must not produce errors in an otherwise valid author script.
    this.ready = this.client.ready.then(async () => {
      await this.stubs.reconnect()
      if(profile.requiredClasses.some(name=>!this.stubs.classes.has(name)))throw new Error('游戏未提供脚本必需的类型，Python 分析已暂停')
      await syncProject()
    })
    void this.ready.catch(error => this.warn(error))
  }

  private documentUri(model:Monaco.editor.ITextModel){
    const source=getProjectSession().workspace.packages.flatMap(p=>p.scripts).find(s=>decodeURIComponent(model.uri.toString()).includes('/'+s.id+'/'))
    return `file:///typings/project/${this.scriptType}/__open_${++this.sequence}_${source?encodeURIComponent(source.name):'scratch.py'}`
  }

  attach(model: Monaco.editor.ITextModel): () => void {
    const key = model.uri.toString()
    const existing = this.documents.get(key)
    if (existing) { existing.refs++; return () => this.detach(key) }
    const doc: Document = { model, uri: this.documentUri(model), version: 1, refs: 1, listener: { dispose() {} } }
    this.documents.set(key, doc)
    void this.ready.then(() => {
      if (this.disposed || this.documents.get(key) !== doc) return
      this.client.notify('textDocument/didOpen', { textDocument: { uri: doc.uri, languageId: 'python', version: doc.version, text: model.getValue() } })
      return this.loadImports(doc)
    }).catch(error => this.warn(error))
    doc.listener = model.onDidChangeContent(() => {
      clearTimeout(doc.timer)
      doc.timer = setTimeout(() => { void this.sync(doc).then(() => this.loadImports(doc)).catch(error => this.warn(error)) }, 300)
    })
    return () => this.detach(key)
  }

  private detach(key: string) {
    const doc = this.documents.get(key)
    if (!doc || --doc.refs) return
    clearTimeout(doc.timer)
    doc.listener.dispose()
    this.documents.delete(key)
    this.client.notify('textDocument/didClose', { textDocument: { uri: doc.uri } })
    if (!doc.model.isDisposed()) this.monaco.editor.setModelMarkers(doc.model, 'hanshu-pyright', [])
  }

  private async sync(doc: Document) {
    await this.ready
    if (this.disposed || doc.model.isDisposed()) return
    clearTimeout(doc.timer)
    doc.version++
    this.client.notify('textDocument/didChange', { textDocument: { uri: doc.uri, version: doc.version }, contentChanges: [{ text: doc.model.getValue() }] })
  }

  private async loadImports(doc: Document) {
    if (isControlConnected() && !doc.model.isDisposed()) await this.stubs.ensure(importedJavaClasses(doc.model.getValue()))
  }

  private async prepare(doc: Document, position: Monaco.Position) {
    await this.sync(doc)
    if (!isControlConnected()) return
    try {
      await this.loadImports(doc)
      // Query Pyright's inferred receiver types, including aliases and function return types.
      // Placeholder classes preserve identity before their public API is loaded.
      const line = doc.model.getLineContent(position.lineNumber).slice(0, position.column - 1)
      const positions = [...line.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].slice(-16).map(match => ({ line: position.lineNumber - 1, character: match.index! }))
      for (let round = 0; round < 6; round++) {
        const names = new Set<string>()
        await Promise.all(positions.map(async point => {
          const params = { textDocument: { uri: doc.uri }, position: point }
          const [definitions, hover] = await Promise.all([
            this.client.request<Location | Location[] | LocationLink[] | null>('textDocument/typeDefinition', params),
            this.client.request<Hover | null>('textDocument/hover', params),
          ])
          for (const definition of definitions ? Array.isArray(definitions) ? definitions : [definitions] : []) {
            const name = this.stubs.byUri.get('targetUri' in definition ? definition.targetUri : definition.uri)
            if (name) names.add(name)
          }
          for (const name of this.stubs.typesMentioned(hoverText(hover))) names.add(name)
        }))
        if (!await this.stubs.ensure([...names])) break
      }
    } catch (error) { this.warn(error) } // An older/offline mod must not disable Python itself.
  }

  private at(doc: Document, position: Monaco.Position) { return { textDocument: { uri: doc.uri }, position: { line: position.lineNumber - 1, character: position.column - 1 } } }
  private range(range: Range): Monaco.IRange { return { startLineNumber: range.start.line + 1, startColumn: range.start.character + 1, endLineNumber: range.end.line + 1, endColumn: range.end.character + 1 } }
  private documentation(value: CompletionItem['documentation']) { return value ? { value: typeof value === 'string' ? value : value.value } : undefined }

  private completion(item: CompletionItem, model: Monaco.editor.ITextModel, position: Monaco.Position): Monaco.languages.CompletionItem {
    const word = model.getWordUntilPosition(position)
    const edit = item.textEdit
    const range = edit ? this.range('range' in edit ? edit.range : edit.replace) : { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn }
    const kindNames: (keyof typeof Monaco.languages.CompletionItemKind)[] = ['Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module', 'Property', 'Unit', 'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder', 'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter']
    const result: Monaco.languages.CompletionItem = {
      label: item.label, kind: this.monaco.languages.CompletionItemKind[kindNames[(item.kind ?? 1) - 1] ?? 'Text'],
      insertText: edit?.newText ?? item.insertText ?? item.label, range,
      detail: item.detail, documentation: this.documentation(item.documentation), sortText: item.sortText, filterText: item.filterText,
      insertTextRules: item.insertTextFormat === 2 ? this.monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
      additionalTextEdits: item.additionalTextEdits?.map((edit: TextEdit) => ({ range: this.range(edit.range), text: edit.newText })),
    }
    this.resolvedItems.set(result, item)
    return result
  }

  private warn(error: unknown) { if (!this.warned && !this.disposed) { this.warned = true; this.reportError(error) } }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const doc of this.documents.values()) {
      clearTimeout(doc.timer)
      doc.listener.dispose()
      if (!doc.model.isDisposed()) this.monaco.editor.setModelMarkers(doc.model, 'hanshu-pyright', [])
    }
    this.documents.clear()
    this.disposables.forEach(disposable => disposable.dispose())
    this.client.dispose()
  }
}
