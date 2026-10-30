import assert from 'node:assert/strict'
import { importedJavaClasses } from '../src/monaco/python/stubs'
import { planJavaImport, javaImportReferenceMatches, type JavaClassEntry } from '../src/monaco/python/javaImportPlan'
import { ActorEnvironmentLoader, readActorEnvironment } from '../src/monaco/python/actorEnvironment'

assert.deepEqual(importedJavaClasses('from custom.mod.api import CustomThing as Thing'), ['custom.mod.api.CustomThing'])

assert.deepEqual(importedJavaClasses('import java as j\nInner = j.type("custom.mod.Outer$Inner")'), ['custom.mod.Outer$Inner'])

assert.deepEqual(importedJavaClasses('from custom.mod.api import (\n    CustomThing as Thing, # hint\n    AnotherThing,\n)'), ['custom.mod.api.CustomThing', 'custom.mod.api.AnotherThing'])

const entry: JavaClassEntry = { name: 'net.minecraft.world.item.ItemStack', symbol: 'ItemStack', packageName: 'net.minecraft.world.item', origin: 'Minecraft' }
const source = '#!/usr/bin/python\n# coding: utf-8\n"""module\ndocstring"""\nfrom __future__ import (\n    annotations,\n)\n\nvalue = 1\n'
const planned = planJavaImport(source, entry)
const inserted = source.slice(0, planned.insertAt) + planned.text + source.slice(planned.insertAt)
assert(inserted.indexOf('from net.minecraft') > inserted.indexOf('annotations,'))
assert(inserted.indexOf('from net.minecraft') < inserted.indexOf('value ='))
assert(inserted.startsWith('#!/usr/bin/python\n# coding: utf-8\n"""module'))
assert.equal(planJavaImport(inserted, entry).reused, true)
assert.equal(planJavaImport('from net.minecraft.world.item import (\n  ItemStack as Stack, # comment\n)\nx = 1', entry).binding, 'Stack')
assert.equal(planJavaImport('ItemStack = 3\nItemStackJava = 4', entry).binding, 'ItemStackJava2')
assert.throws(() => planJavaImport('class Stack: pass', entry, 'Stack'), /占用/)
assert.throws(() => planJavaImport('', entry, 'class'), /标识符/)
assert.equal(planJavaImport('', entry, 'Stack').preview, 'from net.minecraft.world.item import ItemStack as Stack')
assert(planJavaImport('"""doc"""', entry).text.startsWith('\nfrom '))
assert(planJavaImport('# comment\r\nx = 1\r\n', entry).text.endsWith('\r\n'))
const inner = { ...entry, name: 'net.demo.Outer$Inner', symbol: 'Inner', packageName: 'net.demo' }
assert.equal(planJavaImport('', inner).preview, 'import java\nInner = java.type("net.demo.Outer$Inner")')
assert.equal(planJavaImport('import java as j\nx = 1', inner).preview, 'Inner = j.type("net.demo.Outer$Inner")')
assert.equal(planJavaImport('import java as j\nInnerAlias = j.type("net.demo.Outer$Inner")\nx = 1', inner).binding, 'InnerAlias')
assert.throws(() => planJavaImport('', { ...entry, name: '../../bad' }))

const applyPlan = (source: string, candidate: JavaClassEntry = entry) => {
  const plan = planJavaImport(source, candidate)
  return source.slice(0, plan.insertAt) + plan.text + source.slice(plan.replaceEnd)
}
assert.equal(applyPlan('import os\n\n# handler section\n@hook("tick")\ndef tick(event, board):\n    pass\n'), 'import os\nfrom net.minecraft.world.item import ItemStack\n\n# handler section\n@hook("tick")\ndef tick(event, board):\n    pass\n')
assert.equal(applyPlan('def tick():\n    pass\n'), 'from net.minecraft.world.item import ItemStack\n\n\ndef tick():\n    pass\n')
assert.equal(applyPlan('\ufeff#!/usr/bin/python\n# coding: utf-8\n\nvalue = 1\n'), '\ufeff#!/usr/bin/python\n# coding: utf-8\nfrom net.minecraft.world.item import ItemStack\n\nvalue = 1\n')
const firstInner = applyPlan('', inner)
const secondInner = applyPlan(firstInner, { ...inner, name: 'net.demo.Other$Nested', symbol: 'Nested' })
assert(secondInner.indexOf('Inner =') < secondInner.indexOf('Nested ='), 'java.type declarations append in selection order')
assert(!javaImportReferenceMatches('event.player()', 6, 12, entry), 'a caret on an unrelated method must not rewrite it')
assert(!javaImportReferenceMatches('player = event.player()', 0, 6, entry), 'unrelated variables remain intact')
assert(!javaImportReferenceMatches('# ItemStack', 2, 11, entry), 'comments remain intact')
assert(!javaImportReferenceMatches('"ItemStack"', 1, 10, entry), 'strings remain intact')
assert(javaImportReferenceMatches('ItemSt', 0, 6, entry), 'matching class-name prefix can be expanded')

const snapshot = { schemaVersion: 1 as const, runtimeId: 'one', revision: 1, hooks: [{ id: 'registered_dynamically', cancellable: true }] }
assert.deepEqual(readActorEnvironment(snapshot), snapshot)
assert.throws(() => readActorEnvironment({ ...snapshot, hooks: [...snapshot.hooks, ...snapshot.hooks] }))
const published: string[] = []
let current = snapshot
const loader = new ActorEnvironmentLoader(async () => current, async source => { published.push(source) })
await loader.refresh()
assert(published.at(-1)?.includes('Literal["registered_dynamically"]'))
current = { ...snapshot, revision: 0, hooks: [{ id: 'stale', cancellable: false }] }
await loader.refresh()
assert.equal(published.length, 1)
current = { ...current, runtimeId: 'two' }
await loader.refresh()
assert(published.at(-1)?.includes('Literal["stale"]'))
loader.dispose(); await loader.refresh(); assert.equal(published.length, 2)
let resolve!: (value: unknown) => void, started!: () => void
const ready = new Promise<void>(r => { started = r })
const late = new ActorEnvironmentLoader(() => new Promise(r => { resolve = r; started() }), async source => { published.push(source) })
const pending = late.refresh(); await ready; late.dispose(); resolve(snapshot); await pending
assert.equal(published.length, 2, 'late reply cannot install a disposed environment')
const unsupported = new ActorEnvironmentLoader(async () => { throw new Error('unknown_method') }, async source => { published.push(source) })
await assert.rejects(unsupported.refresh())
assert(published.at(-1)?.includes('name: str'), 'old Mods do not cause false unknown-hook errors')
console.log('PASS Python tools: import headers/docstrings/future imports, aliases, collisions, inner classes, CRLF; dynamic hook revisions, runtime isolation, disposal and old-Mod fallback')
