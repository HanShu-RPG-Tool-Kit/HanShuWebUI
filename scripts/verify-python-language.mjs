import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { readFile, readdir } from 'node:fs/promises'

const server = process.env.PYTHON_TEST_URL ? null : await createServer({ cacheDir: 'node_modules/.cache/python-ui', server: { host: '127.0.0.1', port: 0, hmr: false } })
if (server) { await server.listen(); server.config.server.port = server.httpServer.address().port }
const base = process.env.PYTHON_TEST_URL ?? `http://127.0.0.1:${server.httpServer.address().port}`
const fixturePath = process.env.PYTHON_STUB_FIXTURE ?? '../ModRPGToolKit/build/python-stubs-test.json'
let fixture
try { fixture = JSON.parse(await readFile(fixturePath, 'utf8')) } catch { /* Portable worker tests also run without the adjacent Mod checkout. */ }
const browser = await chromium.launch({ headless: true, args: ['--disable-features=LocalNetworkAccessChecks'], ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
try {
  const page = await browser.newPage()
  page.on('pageerror', error => console.error('browser:', error))
  page.on('console', message => { if (message.type() === 'error') console.error('console:', message.text()) })
  const csp = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8')).app.security.csp
  await page.route('**/python-language-check', route => route.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': csp }, body: '<!doctype html><title>Pyright verification</title>' }))
  await page.goto(`${base}/python-language-check`)
  const result = await page.evaluate(async () => {
    const { PyrightClient } = await import('/src/monaco/python/pyrightClient.ts')
    const { buildJavaFiles, javaModule } = await import('/src/monaco/python/stubs.ts')
    const started = performance.now()
    const {pythonProfile}=await import('/src/monaco/python/profiles.ts');const client = new PyrightClient(undefined,pythonProfile('kit').files)
    await client.ready
    const initMs = Math.round(performance.now() - started)
    const uri = 'file:///test.py'
    const diagnostics = []
    client.onNotification = (method, params) => { if (method === 'textDocument/publishDiagnostics') diagnostics.push(params) }
    let version = 1
    client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'python', version, text: '' } })
    const prefix = ''
    const complete = async (code) => {
      const text = prefix + code
      client.notify('textDocument/didChange', { textDocument: { uri, version: ++version }, contentChanges: [{ text }] })
      const lines = text.split('\n')
      const result = await client.request('textDocument/completion', { textDocument: { uri }, position: { line: lines.length - 1, character: lines.at(-1).length } })
      return (Array.isArray(result) ? result : result?.items ?? []).map(item => item.label)
    }
    const offline = { str: await complete('s = "hello"\ns.'), kit: await complete('kit.'), random: await complete('random().') }
    const player = 'net.minecraft.server.level.ServerPlayer', inventory = 'net.minecraft.world.entity.player.Inventory', item = 'net.minecraft.world.item.ItemStack'
    const stubs = [
      { name: player, module: javaModule(player), symbol: 'ServerPlayer', dependencies: [inventory], source: `import ${javaModule(inventory)} as i\nclass ServerPlayer:\n    def getInventory(self) -> i.Inventory: ...\n    def getScore(self) -> int: ...\n` },
    ]
    await client.writeStubs(buildJavaFiles(stubs,pythonProfile('kit').files).files)
    const playerCompletion = await complete('player.')
    const before = await complete('bag = player.getInventory()\nbag.')
    const definition = await client.request('textDocument/typeDefinition', { textDocument: { uri }, position: { line: 1, character: 1 } })
    stubs.push({ name: inventory, module: javaModule(inventory), symbol: 'Inventory', dependencies: [item], source: `import ${javaModule(item)} as s\nclass Inventory:\n    def getItem(self, slot: int) -> s.ItemStack: ...\n    def getContainerSize(self) -> int: ...\n` })
    stubs.push({ name: item, module: javaModule(item), symbol: 'ItemStack', dependencies: [], source: 'class ItemStack:\n    def getCount(self) -> int: ...\n    def isEmpty(self) -> bool: ...\n' })
    await client.writeStubs(buildJavaFiles(stubs,pythonProfile('kit').files).files)
    const after = await complete('bag = player.getInventory()\nbag.')
    const chain = await complete('player.getInventory().getItem(0).')
    const tuple = await complete('for person in players:\n    person.')
    const javaImport = await complete('from net.minecraft.world.item import ItemStack\nstack = ItemStack()\nstack.')
    const javaType = await complete('import java\nStack = java.type("net.minecraft.world.item.ItemStack")\ns = Stack()\ns.')
    client.dispose()
    return { initMs, offline, playerCompletion, before, definition, after, chain, tuple, javaImport, javaType, diagnostics }
  })
  assert(result.offline.str.includes('upper'), 'standard-library string completion')
  assert(result.offline.kit.includes('param'), 'injected kit facade')
  assert(result.offline.random.includes('is_integer'), 'random() inferred float')
  assert(result.playerCompletion.includes('getInventory'), 'reflected player API')
  assert(!result.before.includes('getItem'), 'placeholder does not invent members')
  assert(JSON.stringify(result.definition).includes('Inventory'), 'inferred Java receiver type identity')
  assert(result.after.includes('getItem'), 'dynamic stub updates invalidate import caches')
  assert(result.chain.includes('getCount'), 'chained return inference')
  assert(result.tuple.includes('getInventory'), 'players tuple element inference')
  assert(result.javaImport.includes('getCount'), 'GraalPy package imports')
  assert(result.javaType.includes('getCount'), 'java.type literal overloads')
  console.log(`Python Worker verification passed (${result.initMs} ms cold initialize): builtins, kit, random, Java imports, dynamic stubs, inferred receivers, chained return types, players tuple, java.type.`)
  const profiles=await page.evaluate(async()=>{
    const {PyrightClient}=await import('/src/monaco/python/pyrightClient.ts'),{pythonProfile}=await import('/src/monaco/python/profiles.ts')
    const common=new PyrightClient(undefined,pythonProfile('common').files),goal=new PyrightClient(undefined,pythonProfile('goal').files),shop=new PyrightClient(undefined,pythonProfile('shop').files)
    async function complete(client,uri,text){await client.ready;client.notify('textDocument/didOpen',{textDocument:{uri,languageId:'python',version:1,text}});const lines=text.split('\n');const result=await client.request('textDocument/completion',{textDocument:{uri},position:{line:lines.length-1,character:lines.at(-1).length}});return (Array.isArray(result)?result:result?.items??[]).map(i=>i.label)}
    const plain=await complete(common,'file:///typings/plain.py','ki')
    const goals=await complete(goal,'file:///typings/goal.py','subscr')
    await common.writeStubs({'project/common/helper.py':'def answer() -> int:\n    return 42\n'})
    const imported=await complete(common,'file:///typings/imports.py','from common.helper import answer\nanswer().')
    const shopMembers=await complete(shop,'file:///typings/shop.py','shop.')
    const entryMembers=await complete(shop,'file:///typings/entry.py','shop.entry("bread").')
    common.dispose();goal.dispose();shop.dispose();return {plain,goals,imported,shopMembers,entryMembers}
  })
  assert(!profiles.plain.includes('kit'),'common profile must not inherit kit globals');assert(profiles.goals.includes('subscribe'),'goal SDK decorators');assert(profiles.imported.includes('bit_length'),'project Python sources participate in real import inference')
  console.log('Python profiles passed: common/goal/kit isolation and virtual project library imports.')
  assert(profiles.shopMembers.includes('condition')&&profiles.shopMembers.includes('entries'),'shop host methods')
  assert(profiles.entryMembers.includes('adjustDelta')&&profiles.entryMembers.includes('maxCapacity'),'shop quota handle inference')
  const actors = await page.evaluate(async () => {
    const { PyrightClient } = await import('/src/monaco/python/pyrightClient.ts')
    const { pythonProfile } = await import('/src/monaco/python/profiles.ts')
    const actor = new PyrightClient(undefined, pythonProfile('actor').files)
    const { ActorEnvironmentLoader } = await import('/src/monaco/python/actorEnvironment.ts')
    let snapshot = { schemaVersion: 1, runtimeId: 'fixture', revision: 1, hooks: ['init','aistep','tick','hurt','join','leave','remove','died','interact','attack','target','kill','dimension','heal','effect','collide','ridden','leash'].map(id => ({ id, cancellable: ['hurt','attack','died','interact','dimension','heal','effect','ridden'].includes(id) })) }
    const environment = new ActorEnvironmentLoader(async () => snapshot, source => actor.writeStubs({ '__actor_context.pyi': source }))
    await environment.refresh()
    await actor.ready
    let version = 0
    const uri = 'file:///typings/actor-check.py'
    actor.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'python', version, text: '' } })
    const diagnostics = []
    actor.onNotification = (method, params) => { if (method === 'textDocument/publishDiagnostics' && params.uri === uri) diagnostics.push(params) }
    const complete = async (text) => {
      actor.notify('textDocument/didChange', { textDocument: { uri, version: ++version }, contentChanges: [{ text }] })
      const lines = text.split('\n')
      const result = await actor.request('textDocument/completion', { textDocument: { uri }, position: { line: lines.length - 1, character: lines.at(-1).length } })
      return (Array.isArray(result) ? result : result?.items ?? []).map(item => item.label.replace(/^['"]|['"]$/g, ''))
    }
    const hooks = await complete('@hook("')
    const prefix = await complete('@hook("ai')
    const globals = await complete('Blackb')
    const annotated = await complete('def names(values: list[str]) -> str:\n    return values[0]\nnames(["guard"]).')
    const optional = await complete('def check(value: str | None) -> None:\n    if value is not None:\n        value.')
    const decorated = await complete('@hook("tick")\ndef on_tick(event, blackboard) -> str:\n    return "ok"\non_tick(None, None).')
    await complete('age: int = "wrong"\n@hook("unknown_hook")\ndef invalid(event, blackboard):\n    pass\n')
    const expectedVersion = version, deadline = Date.now() + 10000
    while (!diagnostics.some(d => d.version === expectedVersion && d.diagnostics.some(e => e.message.includes('int'))) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30))
    const errors = diagnostics.filter(d => d.version === expectedVersion).flatMap(d => d.diagnostics.map(e => e.message))
    snapshot = { ...snapshot, revision: 2, hooks: [{ id: 'new_registered_hook', cancellable: true }] }
    await environment.refresh()
    const refreshed = await complete('@hook("')
    snapshot = { ...snapshot, runtimeId: 'different-game', revision: 0, hooks: [{ id: 'other_game_hook', cancellable: false }] }
    await environment.refresh()
    const replaced = await complete('@hook("')
    environment.dispose(); actor.dispose()
    return { hooks, prefix, globals, annotated, optional, decorated, errors, refreshed, replaced }
  })
  assert.equal(actors.hooks.length, 18, 'all runtime hook literal names')
  assert(actors.refreshed.includes('new_registered_hook') && !actors.refreshed.includes('tick'), 'new registry snapshot replaces hook literals in live Worker')
  assert(actors.replaced.includes('other_game_hook') && !actors.replaced.includes('new_registered_hook'), 'switching runtime resets revision and removes stale names')
  assert(actors.prefix.includes('aistep'), 'partial actor hook name completion')
  assert(actors.globals.includes('Blackboard'), 'actor Blackboard injection')
  assert(actors.annotated.includes('upper') && actors.optional.includes('upper'), 'Python function/generic/union annotations drive inference and narrowing')
  assert(actors.decorated.includes('upper'), 'hook decorator preserves annotated function return type')
  assert(actors.errors.some(e => e.includes('int')) && actors.errors.some(e => e.includes('unknown_hook')), 'annotation mismatch and invalid hook diagnostics')
  console.log('Actor Worker passed: all 18 hook names, partial literals, Blackboard, typed return/generic/union narrowing, decorated return inference and type diagnostics.')
  const productionWorker = (await readdir('dist/assets').catch(() => [])).find(name => name.startsWith('pyright.worker-') && name.endsWith('.js'))
  if (productionWorker) {
    await page.route('**/assets/*.js', async route => {
      const name = new URL(route.request().url()).pathname.split('/').at(-1)
      await route.fulfill({ contentType: 'application/javascript', body: await readFile(`dist/assets/${name}`), headers: { 'Content-Security-Policy': csp } })
    })
    const production = await page.evaluate(async name => {
      const { PyrightClient } = await import('/src/monaco/python/pyrightClient.ts')
      const client = new PyrightClient(new Worker(`/assets/${name}`),(await import('/src/monaco/python/profiles.ts')).pythonProfile('kit').files)
      const start = performance.now()
      await client.ready
      const initMs = Math.round(performance.now() - start)
      const uri = 'file:///typings/prod.py'
      client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'python', version: 1, text: 'from __future__ import annotations\nkit.' } })
      const result = await client.request('textDocument/completion', { textDocument: { uri }, position: { line: 1, character: 4 } })
      client.dispose()
      return { initMs, labels: (Array.isArray(result) ? result : result.items).map(item => item.label) }
    }, productionWorker)
    assert(production.labels.includes('param'), 'production bundled worker under desktop CSP')
    console.log(`Production Worker passed under desktop CSP (${production.initMs} ms initialize).`)
  }
  if (fixture) {
    await page.goto(`${base}/python-language-check`)
    await page.route('http://127.0.0.1:8765/**',route=>route.fulfill({contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:'{"ok":true,"subscribers":1}'}))
    const integration = await page.evaluate(async fixture => {
      await import('/src/monaco/setup.ts')
      const monaco = await import('/node_modules/monaco-editor/esm/vs/editor/editor.api.js')
      const { PythonLanguage, attachPython } = await import('/src/monaco/python/pythonLanguage.ts')
      const { reconnectGameDevControlNow, disconnectGameDevControl } = await import('/src/gameDevServer/controlHub.ts')
      const calls = [], errors = []
      window.WebSocket = class {
        static OPEN = 1; static CONNECTING = 0; readyState = 0
        constructor() { setTimeout(() => { this.readyState = 1; this.onopen?.({}) }, 5) }
        close() { this.readyState = 3; this.onclose?.({ code: 1000 }) }
        send(text) {
          const request = JSON.parse(text)
          calls.push(request.params.classes)
          const requested = new Set(request.params.classes)
          const classes = fixture.classes.filter(stub => requested.has(stub.name))
          const found = new Set(classes.map(stub => stub.name))
          const result = { ...fixture, classes, missing: [...requested].filter(name => !found.has(name)) }
          setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'response', id: request.id, ok: true, result }) }), 5)
        }
      }
      reconnectGameDevControlNow()
      await new Promise(resolve => setTimeout(resolve, 20))
      let completionProvider
      const adapter = { ...monaco, languages: { ...monaco.languages, registerCompletionItemProvider: (language, provider) => { completionProvider = provider; return monaco.languages.registerCompletionItemProvider(language, provider) } } }
      const service = new PythonLanguage(adapter, error => errors.push(String(error)),'kit')
      const model = monaco.editor.createModel('', 'python', monaco.Uri.parse('file:///real-kit.py'))
      const other = monaco.editor.createModel('other_only = "text"', 'python', monaco.Uri.parse('file:///other-kit.py'))
      const detach = service.attach(model), detachOther = service.attach(other)
      await service.client.ready
      await service.stubs.reconnect()
      const complete = async (value, target = model) => {
        target.setValue(value)
        const position = new monaco.Position(target.getLineCount(), target.getLineMaxColumn(target.getLineCount()))
        const result = await completionProvider.provideCompletionItems(target, position, { triggerKind: 0 }, { isCancellationRequested: false, onCancellationRequested() { return { dispose() {} } } })
        return result.suggestions.map(item => typeof item.label === 'string' ? item.label : item.label.label)
      }
      const root = await complete('player.')
      const start = performance.now()
      const chain = await complete('player.getInventory().getItem(0).')
      const coldChainMs = Math.round(performance.now() - start)
      const warmStart = performance.now()
      await complete('player.getInventory().getItem(0).')
      const warmChainMs = Math.round(performance.now() - warmStart)
      const alias = await complete('bag = player.getInventory()\nitem = bag.getItem(0)\nitem.')
      const tuple = await complete('for person in players:\n    person.')
      const declaredPrefix = 'from net.minecraft.server.level import ServerPlayer\nfrom mchhui.rpgtoolkit.feature.actor.hook import ActorInteractEvent\ndef on_interact(event: ActorInteractEvent):\n    player: ServerPlayer = event.player()\n'
      const declaredPlayer = await complete(declaredPrefix + '    player.')
      const multilineWorld = await complete(declaredPrefix + '    (\n        player.level()\n    ).')
      const declaredWorld = await complete(declaredPrefix + '    player.level().')
      const worldAlias = await complete(declaredPrefix + '    world = player.level()\n    world.')
      const indexedWorld = await complete(declaredPrefix + '    worlds = [player.level()]\n    worlds[0].')
      const worldChain = await complete(declaredPrefix + '    player.level().getBlockState(player.blockPosition()).')
      const noCall = await complete(declaredPrefix + '    player.level.')
      const own = await complete('unique_marker = "hello"\nunique_')
      const isolated = await complete('unique_', other)
      const future = await complete('"""Module docstring."""\nfrom __future__ import annotations\nkit.')
      const builtins = await complete('values = list(range(3))\nvalues.')
      model.setValue('bad = (')
      const until = Date.now() + 5000
      while (!monaco.editor.getModelMarkers({ resource: model.uri }).some(marker => marker.message.includes('closed')) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50))
      const markers = monaco.editor.getModelMarkers({ resource: model.uri }).map(marker => ({ line: marker.startLineNumber, message: marker.message }))
      detach(); detachOther(); service.dispose(); model.dispose(); other.dispose(); disconnectGameDevControl()
      const NativeWorker = window.Worker
      let created = 0, terminated = 0
      window.Worker = class extends NativeWorker {
        constructor(...args) { super(...args); this.tracked = String(args[0]).includes('pyright.worker'); if (this.tracked) created++ }
        terminate() { if (this.tracked) terminated++; super.terminate() }
      }
      const wait = async (predicate, message) => {
        const deadline = Date.now() + 15000
        while (!predicate()) { if (Date.now() > deadline) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 25)) }
      }
      const a = monaco.editor.createModel('bad = (', 'python', monaco.Uri.parse('file:///lifecycle-a.py'))
      const b = monaco.editor.createModel('bad = (', 'python', monaco.Uri.parse('file:///lifecycle-b.py'))
      const aa = attachPython(adapter, a, error => errors.push(String(error)),'kit')
      const bb = attachPython(adapter, b, error => errors.push(String(error)),'kit')
      if (created !== 0) throw new Error('offline editors created a Python worker')
      reconnectGameDevControlNow()
      await wait(() => monaco.editor.getModelMarkers({resource:b.uri}).length > 0, 'connected Python analysis did not start')
      if (created !== 1) throw new Error('editors did not share a Python worker')
      disconnectGameDevControl()
      if (terminated !== 1 || monaco.editor.getModelMarkers({resource:a.uri}).length || monaco.editor.getModelMarkers({resource:b.uri}).length) throw new Error('disconnect did not terminate worker and clear diagnostics')
      a.setValue('offline_marker = "draft"\noffline_')
      reconnectGameDevControlNow()
      await wait(() => monaco.editor.getModelMarkers({resource:b.uri}).length > 0, 'reconnected Python analysis did not restart')
      const draft = await complete(a.getValue(), a)
      if (!draft.includes('offline_marker')) throw new Error('reconnect did not analyze the latest offline draft')
      aa.dispose()
      if (terminated !== 1) throw new Error('closing one editor stopped another editor')
      bb.dispose()
      if (created !== 2 || terminated !== 2) throw new Error('last editor did not release worker')
      const pending = attachPython(adapter, a, error => errors.push(String(error)),'kit')
      disconnectGameDevControl()
      pending.dispose()
      if (created !== 3 || terminated !== 3) throw new Error('disconnect during startup leaked a worker')
      a.dispose(); b.dispose(); window.Worker = NativeWorker

      return { root, chain, alias, tuple, declaredPlayer, declaredWorld, worldAlias, multilineWorld, indexedWorld, worldChain, noCall, own, isolated, future, builtins, coldChainMs, warmChainMs, markers, calls, errors, created, terminated }
    }, fixture)
    if(!integration.chain.includes('getCount'))console.log(JSON.stringify({root:integration.root.slice(0,8),chain:integration.chain.slice(0,12),errors:integration.errors,calls:integration.calls},null,2))
    console.log('World-chain reproduction', {direct:integration.declaredWorld.includes('getGameTime'), alias:integration.worldAlias.includes('getGameTime'), multiline:integration.multilineWorld.includes('getGameTime'), indexed:integration.indexedWorld.includes('getGameTime'), chain:integration.worldChain.includes('isAir'), noCall:integration.noCall.includes('getGameTime')})
    assert(integration.declaredPlayer.includes('getInventory'), 'annotated event.player() retains ServerPlayer type')
    assert(integration.declaredWorld.includes('getGameTime'), 'annotated player.level() loads actual ServerLevel members')
    assert(integration.worldAlias.includes('getGameTime'), 'world alias retains returned type')
    assert(integration.multilineWorld.includes('getGameTime'), 'multiline receiver loads returned Java type')
    assert(integration.indexedWorld.includes('getGameTime'), 'indexed receiver loads returned Java type')
    assert(integration.worldChain.includes('isAir'), 'multi-step world/block-state chain')
    assert(!integration.noCall.includes('getGameTime'), 'bound Java method is not its return value until called')
    assert(integration.root.includes('getInventory'), 'actual Minecraft player methods')
    assert(integration.chain.includes('getCount'), 'automatic dependency hydration through actual Minecraft signatures')
    assert(integration.alias.includes('getCount'), 'aliases retain inferred Minecraft types')
    assert(integration.tuple.includes('getInventory'), 'actual players tuple type')
    assert(integration.own.includes('unique_marker') && !integration.isolated.includes('unique_marker'), 'multi-document isolation')
    assert(integration.future.includes('param'), 'future import and module docstring remain intact')
    assert(integration.builtins.includes('append'), 'injected builtins preserve list/range and Python inference')
    assert(integration.markers.some(marker => marker.line === 1), 'diagnostics translate hidden prefix back to visible line 1')
    assert.deepEqual(integration.errors, [])
    assert.equal(integration.created, 3)
    assert.equal(integration.terminated, 3)
    console.log('Connection lifecycle passed: no offline worker, shared online worker, immediate diagnostics cleanup, latest-draft reconnect, last-editor and in-flight startup disposal.')
    console.log(`Actual Java reflection fixture + Monaco integration passed: automatic chain/alias/tuple, document isolation, future imports, builtins, diagnostics. RPC batches: ${integration.calls.length}; chain first/warm: ${integration.coldChainMs}/${integration.warmChainMs} ms.`)
    const liveActor = await page.evaluate(async fixture => {
      const monaco = await import('/node_modules/monaco-editor/esm/vs/editor/editor.api.js')
      const { PythonLanguage } = await import('/src/monaco/python/pythonLanguage.ts')
      const hub = await import('/src/gameDevServer/controlHub.ts')
      let snapshot = { schemaVersion: 1, runtimeId: 'live-actor', revision: 1, hooks: [{ id: 'tick', cancellable: false }] }, socket
      window.WebSocket = class {
        static OPEN = 1; static CONNECTING = 0; readyState = 0
        constructor() { socket = this; setTimeout(() => { this.readyState = 1; this.onopen?.({}) }, 5) }
        close() { this.readyState = 3; this.onclose?.({ code: 1000 }) }
        send(text) {
          const request = JSON.parse(text), wanted = new Set(request.params.classes ?? [])
          const result = request.method === 'python.actorHooks' ? snapshot : { ...fixture, runtimeId: 'live-actor', classes: fixture.classes.filter(c => wanted.has(c.name)), missing: [] }
          setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'response', id: request.id, ok: true, result }) }), 5)
        }
      }
      hub.reconnectGameDevControlNow()
      while (!hub.isControlConnected()) await new Promise(resolve => setTimeout(resolve, 10))
      let provider
      const adapter = { ...monaco, languages: { ...monaco.languages, registerCompletionItemProvider: (language, value) => { provider = value; return monaco.languages.registerCompletionItemProvider(language, value) } } }
      const errors = [], service = new PythonLanguage(adapter, error => errors.push(String(error)), 'actor')
      const model = monaco.editor.createModel('@hook("', 'python', monaco.Uri.parse('file:///live-actor.py'))
      await service.ready
      const detach = service.attach(model)
      const complete = async () => {
        const result = await provider.provideCompletionItems(model, new monaco.Position(1, 8), {}, { isCancellationRequested: false })
        return result.suggestions.map(s => ({ label: String(s.label).replace(/^["']|["']$/g, ''), detail: s.detail }))
      }
      const first = await complete()
      snapshot = { ...snapshot, revision: 2, hooks: [...snapshot.hooks, { id: 'runtime_added', cancellable: true }] }
      socket.onmessage({ data: JSON.stringify({ type: 'notify', method: 'python.actorHooks.changed', params: { runtimeId: snapshot.runtimeId, revision: 2 } }) })
      let updated = [], deadline = Date.now() + 10000
      while (Date.now() < deadline) { updated = await complete(); if (updated.some(s => s.label === 'runtime_added')) break; await new Promise(resolve => setTimeout(resolve, 30)) }
      snapshot = { ...snapshot, runtimeId: 'other-game', revision: 0, hooks: [{ id: 'other_game', cancellable: false }] }
      socket.onmessage({ data: JSON.stringify({ type: 'notify', method: 'python.actorHooks.changed', params: { runtimeId: snapshot.runtimeId, revision: 0 } }) })
      let replaced = []; deadline = Date.now() + 10000
      while (Date.now() < deadline) { replaced = await complete(); if (replaced.some(s => s.label === 'other_game')) break; await new Promise(resolve => setTimeout(resolve, 30)) }
      detach(); service.dispose(); model.dispose(); hub.disconnectGameDevControl()
      return { first, updated, replaced, errors }
    }, fixture)
    assert(liveActor.first.some(s => s.label === 'tick') && !liveActor.first.some(s => s.label === 'runtime_added'))
    assert(liveActor.updated.some(s => s.label === 'runtime_added' && s.detail.includes('可取消')))
    assert(liveActor.replaced.some(s => s.label === 'other_game') && !liveActor.replaced.some(s => s.label === 'runtime_added'))
    assert.deepEqual(liveActor.errors, [])
    console.log('Live actor metadata passed: Control notification refreshes an attached Monaco editor, cancellable details, runtime replacement without stale hook names.')
  } else console.log(`Actual Java reflection integration skipped: run Mod JavaPythonStubsTest to produce ${fixturePath}.`)
} finally { await browser.close(); await server?.close() }





