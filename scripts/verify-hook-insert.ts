import assert from 'node:assert/strict'
import {
  hookEventSymbol,
  hookEventTypeMatches,
  hookInsertOffset,
  planHookHandler,
} from '../src/monaco/javascript/hookInsert'

assert.equal(hookEventSymbol('mchhui.rpgtoolkit.feature.script.player.PlayerEvent'), 'PlayerEvent')
assert.equal(hookEventSymbol('mchhui.rpgtoolkit.feature.script.player.PlayerEvent$Hurt'), 'Hurt')

const empty = '// sample\n\n'
assert.equal(hookInsertOffset(empty, empty.length), empty.length)
assert.equal(hookInsertOffset('line\n', 2), 'line\n'.length)

const withImport = planHookHandler(
  'import PlayerEvent from "mchhui.rpgtoolkit.feature.script.player.PlayerEvent"\n\n',
  { id: 'tick', cancellable: true, eventClass: 'mchhui.rpgtoolkit.feature.script.player.PlayerEvent' },
  0,
)
assert.equal(withImport.importText, '')
assert.equal(withImport.binding, 'PlayerEvent')
assert.match(withImport.body, /@hook\("tick"\)/)
assert.match(withImport.body, /function on_tick\(event: PlayerEvent, blackboard: Blackboard\): void/)

const nested = planHookHandler(
  '',
  { id: 'hurt', cancellable: true, eventClass: 'mchhui.rpgtoolkit.feature.script.player.PlayerEvent$Hurt' },
  0,
)
assert.match(nested.importText, /import Hurt from "mchhui\.rpgtoolkit\.feature\.script\.player\.PlayerEvent\$Hurt"/)
assert.match(nested.body, /event: Hurt/)
assert.match(nested.preview, /import Hurt/)

const uncancellable = planHookHandler(
  '',
  { id: 'join', cancellable: false, eventClass: 'mchhui.rpgtoolkit.feature.script.player.PlayerEvent' },
  0,
)
assert.match(uncancellable.body, /@hook\("join", \{cancellable:false\}\)/)

const clash = planHookHandler(
  'function on_tick(event: any, blackboard: Blackboard): void {}\n',
  { id: 'tick', cancellable: true },
  0,
)
assert.match(clash.body, /function on_tick_2\(/)
assert.equal(clash.binding, 'any')

const hurt = 'mchhui.rpgtoolkit.feature.script.player.PlayerEvent$Hurt'
assert(hookEventTypeMatches('Hurt', hurt, { Hurt: hurt }))
assert(hookEventTypeMatches('Hurt', hurt))
assert(hookEventTypeMatches(hurt, hurt))
assert(!hookEventTypeMatches('any', hurt))
assert(!hookEventTypeMatches('PlayerEvent', hurt, {
  PlayerEvent: 'mchhui.rpgtoolkit.feature.script.player.PlayerEvent',
}))

console.log('PASS hook-insert: event symbol, reuse import, nested class, cancellable option, name clash, type match')
