import assert from 'node:assert/strict'
import {readFileSync, readdirSync} from 'node:fs'
import {resolve} from 'node:path'
import {createContext, runInContext} from 'node:vm'
import {transformDialect} from '../src/monaco/javascript/dialect'

// Execute the actual shipped scripts against small Java API doubles. Runtime/JVM
// interop is checked separately by the Mod suite; these cases protect goal behavior.
const root = resolve('src/scriptResources/builtin/goal')
const files = readdirSync(root).filter(name => name.endsWith('.js')).sort()
assert.equal(files.length, 28)
const sources = new Map(files.map(name => [name.slice(0, -3).replace(/^core_/, 'core:'), readFileSync(resolve(root, name), 'utf8')]))
let assertions = 0
function check(name: string, body: () => void) {body(); assertions++; console.log(`[OK] ${name}`)}

function load(id: string, overrides: Record<string, unknown> = {}) {
  const source = sources.get(id)!
  assert.ok(source, id)
  const transformed = transformDialect(source)
  assert.deepEqual(transformed.diagnostics, [], id)
  assert.equal(transformed.source.split('\n').length, source.split('\n').length)
  const world = {now: 9007199254740993n, realtime: 10000, takeCalls: 0, read: true, match: true}
  class ServerPlayer {
    tickCount = 20
    experienceLevel = 30
    items = 4
    level() {return {getServer: () => ({})}}
    getUUID() {return 'owner'}
  }
  const owner = new ServerPlayer(), stranger = new ServerPlayer()
  const classes: Record<string, any> = {
    ServerPlayer,
    Long: {valueOf: (value: string) => BigInt(value)},
    BuiltInRegistries: {BLOCK: {getKey: (value: unknown) => value}, ENTITY_TYPE: {getKey: (value: unknown) => value}},
    GoalLabels: new Proxy({}, {get: () => (value: string) => value}),
    GoalItems: {
      countMc: (p: ServerPlayer) => p.items, countRpgtk: (p: ServerPlayer) => p.items,
      takeMc: (p: ServerPlayer, _id: string, amount: number) => take(p, amount),
      takeRpgtk: (p: ServerPlayer, _id: string, amount: number) => take(p, amount),
    },
    GoalStacks: {countMc: (s: any, target: string) => s.type === target ? s.count : 0, isMc: (s: any, target: string) => s.type === target},
    GoalLooks: {lookingAtBlock: () => world.match, lookingAtEntity: () => world.match},
    GoalWorld: {inBiome: () => world.match, inDimension: () => world.match, inStructure: () => world.match},
    EntityTemplates: {get: () => ({isFromTemplate: () => world.match})},
    TalkReads: {isRead: () => world.read},
    GoalClocks: {
      secondsToTicks: (seconds: number) => Math.max(0, seconds) * 20,
      ticksToSecondsCeil: (ticks: number) => Math.ceil(ticks / 20),
      deadlineGameTime: (_p: unknown, days: number) => world.now + BigInt(days) * 24000n,
      remainGameDays: (_p: unknown, deadline: bigint) => Number((deadline - world.now + 23999n) / 24000n),
      gameTimeReached: (_p: unknown, deadline: bigint) => world.now >= deadline,
      remainRealtimeMs: (at: string) => {if (at === 'invalid') throw new Error('Invalid timestamp'); return Math.max(0, Number(at) - world.realtime)},
      realtimeReached: (at: string) => world.realtime >= Number(at),
    },
  }
  function take(p: ServerPlayer, amount: number) {world.takeCalls++; if (p.items < amount) return false; p.items -= amount; return true}
  const declaration = transformed.goal!
  assert.ok(declaration, `${id}: file-level goal metadata`)
  assert.equal(declaration.id, id)
  const field = (value: any) => ({name:value.name, type:value.type, required:value.required, ...(value.defaultValue !== null ? {default:value.defaultValue} : {})})
  const definition: any = {config:declaration.config.map(field), state:declaration.state.map(field)}
  let status = 'TRACKING'
  const context = createContext({
    Java: {type: (name: string) => classes[name.split('.').at(-1)!] ?? class Event {}},
    pick_locale: (locale: string, values: Record<string, string>) => values[locale] ?? values.en_us,
    update_satisfied_state: (_: unknown, value: boolean) => {status = value ? 'SATISFIED' : 'TRACKING'},
    complete: () => {status = 'COMPLETED'},
    fail: () => {status = 'FAILED'},
  })
  runInContext(transformed.source, context, {filename: id + '.js', timeout: 1000})
  definition.handlers = declaration.handlers.map(handler => ({...handler, handler:context[handler.function]}))
  for (const name of ['update_state', 'localize', 'deliver']) definition[name] = context[name]
  const cfg = Object.fromEntries(definition.config.map((f: any) => [f.name, f.default ?? 'test:value']))
  Object.assign(cfg, overrides)
  const st = Object.fromEntries(definition.state.map((f: any) => [f.name, f.default]))
  context.cfg = cfg; context.st = st
  const instance = {isOwner: (p: unknown) => p === owner}
  function event(p = owner, values: Record<string, any> = {}) {
    const stack = {type: cfg.target, count: 2}
    const victim = {getType: () => cfg.target, level: () => owner.level()}
    return {
      getEntity: () => id.includes('kill_') ? victim : p, getPlayer: () => p,
      getSource: () => ({getEntity: () => p}), getState: () => ({getBlock: () => cfg.target}),
      isCanceled: () => false, getStack: () => stack, getCrafting: () => stack, getSmelting: () => stack,
      getAmountRemoved: () => 2, getAmount: () => 2, getLevels: () => 2,
      getTo: () => ({identifier: () => cfg.target}), getInject: () => cfg.inject, getToken: () => cfg.token,
      getDrops: () => ({iterator: () => {let next = 0; return {hasNext: () => next < 2, next: () => {next++; return stack}}}}),
      ...values,
    }
  }
  const dispatch = (e = event(), index?: number) => {
    const handlers = index === undefined ? definition.handlers : [definition.handlers[index]]
    for (const handler of handlers) handler.handler.call(definition, instance, e)
  }
  return {definition, cfg, st, owner, stranger, world, instance, event, dispatch,
    update: () => {definition.update_state.call(definition, instance); return status},
    localize: (locale: string) => definition.localize.call(definition, instance, locale),
    deliver: (actor: unknown = owner) => definition.deliver.call(definition, instance, actor === null ? null : {actor: () => actor}),
  }
}

for (const id of sources.keys()) {
  check(`${id}: load, reject another owner, dispatch and localize`, () => {
    const test = load(id, id.endsWith('deadline_realtime') ? {at: '50000'} : {})
    const before = JSON.stringify(test.st)
    test.dispatch(test.event(test.stranger))
    assert.equal(JSON.stringify(test.st), before, 'another player cannot advance the goal')
    test.dispatch()
    test.update()
    assert.equal(typeof test.localize('en_us'), 'string')
    assert.ok(test.localize('zh_cn').length > 0)
    assert.equal(test.world.takeCalls, 0, 'tracking and localization never consume inventory')
  })
}

for (const kind of ['mc', 'rpgtk']) for (const mode of ['hold', 'submit']) {
  check(`${kind}/${mode}: inventory is consumed only once on successful delivery`, () => {
    const t = load(`core:item_${kind}_type_${mode}`, {count: 3})
    assert.equal(typeof t.definition.deliver, 'function')
    t.owner.items = 2; t.dispatch()
    assert.equal(t.update(), 'TRACKING')
    assert.equal(t.deliver(), false)
    assert.equal(t.st.delivered, 0)
    t.owner.items = 4; t.dispatch()
    assert.equal(t.update(), 'SATISFIED')
    assert.equal(t.owner.items, 4)
    assert.equal(t.deliver(null), false)
    assert.equal(t.deliver(), true)
    assert.equal(t.owner.items, 1)
    const calls = t.world.takeCalls
    assert.equal(t.deliver(), true)
    assert.equal(t.world.takeCalls, calls)
    const free = load(`core:item_${kind}_type_${mode}`, {consume: false})
    assert.equal(free.deliver(), true)
    assert.equal(free.world.takeCalls, 0)
  })
}

check('online timer expires at zero and never completes itself', () => {
  const t = load('core:timer_seconds', {seconds: 1})
  t.dispatch(); assert.equal(t.st.remain_ticks, 20); assert.equal(t.update(), 'SATISFIED')
  t.dispatch(t.event(t.stranger)); assert.equal(t.st.remain_ticks, 20)
  for (let tick = 0; tick < 19; tick++) t.dispatch()
  assert.equal(t.st.remain_ticks, 1); assert.equal(t.update(), 'SATISFIED')
  t.dispatch(); assert.equal(t.st.remain_ticks, 0); assert.equal(t.update(), 'FAILED')
  t.dispatch(); assert.equal(t.st.remain_ticks, 0)
})

check('game-day deadline retains exact long values across save and reload', () => {
  const t = load('core:deadline_game_days', {days: 2})
  const deadline = t.world.now + 48000n
  t.dispatch(); assert.equal(t.st.deadline, String(deadline)); assert.equal(t.update(), 'SATISFIED')
  t.world.now = deadline; t.dispatch(); assert.equal(t.update(), 'FAILED')
})

check('realtime deadline and malformed timestamps fail predictably', () => {
  const t = load('core:deadline_realtime', {at: '20000'})
  t.dispatch(); assert.equal(t.st.remain_sec, 10); assert.equal(t.update(), 'SATISFIED')
  t.world.realtime = 20000; t.dispatch(); assert.equal(t.update(), 'FAILED')
  const bad = load('core:deadline_realtime', {at: 'invalid'})
  bad.dispatch(); assert.equal(bad.update(), 'FAILED')
})

check('cancelled block and fishing events never advance counters', () => {
  for (const id of ['core:break_block_mc_type', 'core:fish_item_mc_type']) {
    const t = load(id); t.dispatch(t.event(t.owner, {isCanceled: () => true})); assert.equal(t.st.have, 0)
    t.dispatch(); assert.ok(t.st.have > 0)
  }
})

check('XP gain ignores deductions; reaching a level uses the event delta', () => {
  for (const id of ['core:xp_gain', 'core:xp_level_gain']) {
    const t = load(id); t.dispatch(t.event(t.owner, {getAmount: () => -10, getLevels: () => -10})); assert.equal(t.st.have, 0)
    t.dispatch(); assert.equal(t.st.have, 2)
  }
  const t = load('core:xp_level_reach', {level: 30})
  t.owner.experienceLevel = 29
  t.dispatch(t.event(t.owner, {getLevels: () => 1}), 0)
  assert.equal(t.update(), 'COMPLETED')
})

check('all shipped metadata and schema fields remain available', () => {
  for (const [id, source] of sources) {
    const metadata = JSON.parse(source.match(/^\/\*\s*([\s\S]*?)\*\//)![1])
    assert.equal(metadata.id, id)
    assert.ok(metadata.labels.zh_cn.name)
    const t = load(id)
    for (const field of t.definition.config) assert.ok(metadata.params[field.name], `${id}/${field.name}`)
  }
  assert.ok(load('core:kill_mc_type').localize('zh_cn').includes('击杀'))
})

console.log(`Verified ${files.length} JavaScript builtin goals in ${assertions} behavior cases.`)
