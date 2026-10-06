import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  KitExprError,
  buildKitModifierEnv,
  formatKitNumber,
  interpolateKitText,
  kitRound,
  parseKitExpr,
  resolveKitNumber,
  type KitExprModifierDecl,
  type KitExprParamDecl,
} from '../src/workspaces/progress/kitExpr.ts'
import { createKit, createKitModifier, flattenKit, parseKit, resolveKit, stringifyKit } from '../src/workspaces/progress/kit.ts'

let passed = 0
function test(name: string, check: () => void) { check(); passed++; console.log(`[OK] ${name}`) }

const intensity = (value = 1): KitExprParamDecl => ({ id: 'intensity', kind: 'float', default: value })

function evalWith(expr: string, x = 0, params: KitExprParamDecl[] = [intensity()], modifiers: KitExprModifierDecl[] = []) {
  const env = buildKitModifierEnv(params, [...modifiers, { id: '__probe', expr }])
  return env.apply('__probe', x)
}

function errorKind(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof KitExprError) return error.kind
    throw error
  }
  return 'none'
}

test('precedence and unary minus', () => {
  assert.equal(evalWith('1 + 2 * 3'), 7)
  assert.equal(evalWith('(1 + 2) * 3'), 9)
  assert.equal(evalWith('-2 * 3'), -6)
  assert.equal(evalWith('2 * -3'), -6)
  assert.equal(evalWith('10 / 4 / 5'), 0.5)
  assert.equal(evalWith('8 - 3 - 2'), 3)
  assert.equal(evalWith('--x', 4), 4)
})

test('syntax errors carry columns', () => {
  const error = (() => { try { parseKitExpr('1 + * 2') } catch (cause) { return cause as KitExprError } })()
  assert.ok(error instanceof KitExprError)
  assert.equal(error.kind, 'syntax')
  assert.equal(error.column, 5)
  assert.equal(errorKind(() => parseKitExpr('')), 'syntax')
  assert.equal(errorKind(() => parseKitExpr('1 2')), 'syntax')
  assert.equal(errorKind(() => parseKitExpr('a ? 1 : 2')), 'syntax')
  assert.equal(errorKind(() => parseKitExpr('2x')), 'syntax')
  assert.equal(errorKind(() => parseKitExpr('min(1,')), 'syntax')
})

test('builtins', () => {
  assert.equal(evalWith('min(3, 1, 2)'), 1)
  assert.equal(evalWith('max(3, 1, 2)'), 3)
  assert.equal(evalWith('abs(-2.5)'), 2.5)
  assert.equal(evalWith('floor(-1.5)'), -2)
  assert.equal(evalWith('ceil(1.2)'), 2)
  assert.equal(evalWith('round(2.5)'), 3)
  assert.equal(evalWith('round(-2.5)'), -3)
  assert.equal(Object.is(kitRound(-0.4), 0), true)
  assert.equal(evalWith('clamp(5, 3, 1)'), 3)
  assert.equal(evalWith('step(x, 1, 10, 20)', 0.5), 10)
  assert.equal(evalWith('step(x, 1, 10, 20)', 1), 20)
  assert.equal(evalWith('select(x, 1, 10, 2, 20, 30)', 1.5), 20)
  assert.equal(evalWith('select(x, 1, 10, 2, 20, 30)', 9), 30)
  assert.equal(evalWith('lerp(x, 0, 0, 1, 2, 2, 4)', 1.5), 3)
  assert.equal(evalWith('lerp(x, 0, 0, 1, 2)', -5), 0)
  assert.equal(evalWith('lerp(x, 0, 0, 1, 2)', 5), 2)
  assert.equal(evalWith('spline(x, 0, 0, 1, 1, 2, 0.5)', 1), 1)
  assert.equal(evalWith('spline(x, 0, 0, 1, 1)', 0.5), 0.5)
})

test('arity, domain and math errors', () => {
  assert.equal(errorKind(() => evalWith('abs(1, 2)')), 'arity')
  assert.equal(errorKind(() => evalWith('select(x, 1, 2, 3)')), 'none')
  assert.equal(errorKind(() => evalWith('select(x, 1, 2)')), 'arity')
  assert.equal(errorKind(() => evalWith('select(x, 1, 2, 3, 4)')), 'arity')
  assert.equal(errorKind(() => evalWith('lerp(x, 0, 1)')), 'arity')
  assert.equal(errorKind(() => evalWith('lerp(x, 1, 0, 1, 2)')), 'domain')
  assert.equal(errorKind(() => evalWith('select(x, 2, 0, 1, 1, 0)')), 'domain')
  assert.equal(errorKind(() => evalWith('1 / (x - 1)', 1)), 'math')
  assert.equal(errorKind(() => evalWith('nope + 1')), 'name')
  assert.equal(errorKind(() => evalWith('foo(1)')), 'name')
  assert.equal(errorKind(() => evalWith('intensity(1)')), 'name')
  assert.equal(errorKind(() => evalWith('min')), 'name')
})

test('hyperparameters: overrides, bool, string', () => {
  const params: KitExprParamDecl[] = [
    intensity(2),
    { id: 'hard', kind: 'bool', default: true },
    { id: 'tag', kind: 'string', default: 'a' },
    { id: 'n', kind: 'int', default: 3 },
  ]
  const env = buildKitModifierEnv(params, [{ id: 'm', expr: 'x * intensity + hard + n' }], { intensity: 5 })
  assert.equal(env.apply('m', 2), 14)
  const bad = buildKitModifierEnv(params, [{ id: 'm', expr: 'tag + 1' }])
  assert.equal(bad.modifierErrors.get('m')?.kind, 'type')
})

test('modifiers call each other; cycles are reported', () => {
  const env = buildKitModifierEnv([intensity(2)], [
    { id: 'base', expr: 'x * intensity' },
    { id: 'loot', expr: 'round(base(x) * 1.5)' },
    { id: 'a', expr: 'b(x)' },
    { id: 'b', expr: 'a(x) + 1' },
    { id: 'self', expr: 'self(x)' },
    { id: '', expr: 'garbage((' },
  ])
  assert.equal(env.apply('loot', 3), 9)
  assert.equal(env.modifierErrors.get('a')?.kind, 'cycle')
  assert.equal(env.modifierErrors.get('b')?.kind, 'cycle')
  assert.equal(env.modifierErrors.get('self')?.kind, 'cycle')
  assert.ok(env.ready.has('loot'))
  assert.ok(!env.declared.has(''))
  assert.equal(errorKind(() => env.apply('a', 1)), 'cycle')
})

test('declaration errors: reserved, duplicate, bad ids', () => {
  const env = buildKitModifierEnv([intensity()], [
    { id: 'x', expr: '1' },
    { id: 'min', expr: '1' },
    { id: 'intensity', expr: '1' },
    { id: 'ok', expr: '1' },
    { id: 'ok', expr: '2' },
    { id: '9bad', expr: '1' },
  ])
  assert.equal(env.errors.length, 5)
  assert.equal(env.apply('ok', 0), 1)
})

test('field binding applies modifier then round/clamp', () => {
  const env = buildKitModifierEnv([intensity(1.5)], [{ id: 'loot', expr: 'x * intensity' }, { id: 'broken', expr: '1 / 0' }])
  assert.deepEqual(resolveKitNumber(5, '', env, { int: true, min: 0 }), { raw: 5, value: 5, mod: '' })
  assert.equal(resolveKitNumber(5, 'loot', env, { int: true, min: 0 }).value, 8)
  assert.equal(resolveKitNumber(5, 'loot', env, { int: false, min: 0 }).value, 7.5)
  assert.equal(resolveKitNumber(-5, 'loot', env, { int: true, min: 1 }).value, 1)
  const missing = resolveKitNumber(5, 'ghost', env, { int: true, min: 0 })
  assert.equal(missing.value, 5)
  assert.ok(missing.warning)
  const failed = resolveKitNumber(5, 'broken', env, { int: true, min: 0 })
  assert.equal(failed.value, 5)
  assert.ok(failed.error)
})

test('kit stores modifier expr and field mods; resolveKit evaluates', () => {
  const kit = createKit('t')
  kit.modifiers = [{ ...createKitModifier('loot'), expr: 'x * intensity * 2' }]
  kit.items = [{ id: 'minecraft:apple', count: 3, components: {}, mods: { count: 'loot' } }]
  kit.effects = [{ id: 'minecraft:speed', amplifier: 0, duration: 10, particles: true, mods: { duration: 'loot' } }]
  kit.experience = { kind: 'points', amount: 4, mods: { amount: 'loot' } }
  kit.pools = [{ rolls: 1, mods: { rolls: 'loot' }, entries: [{ weight: 2, items: [], mods: { weight: 'loot' } }] }]
  const parsed = parseKit(stringifyKit(kit))
  assert.equal(parsed.modifiers[0]!.expr, 'x * intensity * 2')
  assert.deepEqual(parsed.items[0]!.mods, { count: 'loot' })
  assert.deepEqual(parsed.experience.mods, { amount: 'loot' })
  const resolved = resolveKit(parsed, { intensity: 1.5 })
  assert.equal(resolved.items[0]!.count, 9)
  assert.equal(resolved.effects[0]!.duration, 30)
  assert.equal(resolved.experience.amount, 12)
  assert.equal(resolved.pools[0]!.rolls, 3)
  assert.equal(resolved.pools[0]!.entries[0]!.weight, 6)
  assert.equal(resolved.issues.length, 0)
  const plain = parseKit(stringifyKit(createKit('p')))
  assert.equal(plain.items.length, 0)
  assert.equal(JSON.parse(stringifyKit(createKit('p'))).experience.mods, undefined)
})

test('command interpolation', () => {
  const env = buildKitModifierEnv([intensity(1.5)], [{ id: 'loot', expr: 'x * intensity' }])
  assert.deepEqual(interpolateKitText('give @s apple ${round(loot(5))}', env), { text: 'give @s apple 8', errors: [] })
  assert.equal(interpolateKitText('xp ${loot(1)} ${intensity / 3}', env).text, 'xp 1.5 0.5')
  assert.equal(interpolateKitText('say $${raw}', env).text, 'say ${raw}')
  assert.equal(interpolateKitText('say ${x}', env).errors.length, 1)
  assert.equal(interpolateKitText('say ${1 +', env).errors.length, 1)
  assert.equal(formatKitNumber(1 / 3), '0.333333')
  const kit = createKit('c')
  kit.modifiers = [{ ...createKitModifier('loot'), expr: 'x * 2' }]
  kit.commands = ['give @s apple ${loot(3)}', 'bad ${nope}']
  const resolved = resolveKit(kit)
  assert.deepEqual(resolved.commands, ['give @s apple 6', 'bad ${nope}'])
  assert.equal(resolved.issues.length, 1)
})

test('extends overrides params/modifiers by id; includes union them by id', () => {
  const parent = createKit('parent')
  parent.params = [{ id: 'intensity', kind: 'float', default: 2, hint: '' }]
  parent.modifiers = [{ ...createKitModifier('loot'), expr: 'x * intensity' }]
  const addon = createKit('addon')
  addon.params = [{ id: 'party', kind: 'int', default: 1, hint: '' }, { id: 'intensity', kind: 'float', default: 9, hint: '' }]
  addon.modifiers = [{ ...createKitModifier('per_head'), expr: 'x * party' }]
  addon.items = [{ id: 'minecraft:bread', count: 2, components: {}, mods: { count: 'per_head' } }]
  const child = createKit('child')
  child.params = [{ id: 'bonus', kind: 'float', default: 0, hint: '' }, { id: 'intensity', kind: 'float', default: 5, hint: '' }, { id: '', kind: 'float', default: 1, hint: '' }]
  child.modifiers = [{ ...createKitModifier('extra'), expr: 'x + bonus' }]
  child.extends = 'parent'
  child.includes = ['addon']
  const flat = flattenKit(child, 'child', new Map([['parent', parent], ['addon', addon]]))
  assert.deepEqual(flat.kit.params.map((param) => param.id), ['intensity', 'bonus', 'party'])
  assert.equal(flat.kit.params[0]!.default, 5)
  assert.deepEqual(flat.kit.modifiers.map((modifier) => modifier.id), ['loot', 'extra', 'per_head'])
  const bare = flattenKit({ ...createKit('bare'), params: [] }, 'bare')
  assert.equal(bare.kit.params.length, 0)
  assert.equal(flat.errors.length, 1)
  const resolved = resolveKit(flat.kit, { party: 3 })
  assert.equal(resolved.items[0]!.count, 6)
  assert.equal(resolved.issues.length, 0)
})

test('extends unions tags; includes do not contribute tags', () => {
  const parent = createKit('parent')
  parent.tags = ['daily', 'Event/Summer']
  const addon = createKit('addon')
  addon.tags = ['module/loot', 'should-not-appear']
  addon.items = [{ id: 'minecraft:apple', count: 1, components: {} }]
  const child = createKit('child')
  child.tags = ['event/summer', 'hard']
  child.extends = 'parent'
  child.includes = ['addon']
  const flat = flattenKit(child, 'child', new Map([['parent', parent], ['addon', addon]]))
  assert.deepEqual(flat.kit.tags, ['daily', 'Event/Summer', 'hard'])
  assert.equal(flat.kit.items.length, 1)
  const round = parseKit(stringifyKit(child))
  assert.deepEqual(round.tags, ['event/summer', 'hard'])
})

// 一致性用例与标准文档共用：解析 kit-expr.md 中「一致性用例」表格逐行验证
test('conformance table in Standard V1 document', () => {
  const docPath = fileURLToPath(new URL('../src/help/docs/kit-expr.md', import.meta.url))
  const doc = readFileSync(docPath, 'utf8')
  const section = doc.split(/^## /m).find((part) => part.includes('一致性用例'))
  assert.ok(section, 'kit-expr.md 缺少一致性用例章节')
  const rows = section.split('\n')
    .filter((line) => /^\|\s*`/.test(line))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim().replace(/^`|`$/g, '')))
  assert.ok(rows.length >= 10, '一致性用例过少')
  for (const [expr, envText, expected] of rows) {
    const values: Record<string, number> = {}
    for (const pair of envText!.split(/[,，]\s*/).filter((item) => item && item !== '—')) {
      const [name, value] = pair.split('=').map((item) => item.trim())
      values[name!] = Number(value)
    }
    const { x = 0, ...params } = values
    const decls: KitExprParamDecl[] = Object.entries(params).map(([id, value]) => ({ id, kind: 'float', default: value }))
    const run = () => evalWith(expr!, x, decls)
    if (expected!.startsWith('错误')) {
      const kind = /错误\s*[:：]?\s*(\w+)/.exec(expected!)?.[1]
      assert.equal(errorKind(run), kind, `${expr} 应报 ${kind}`)
    } else {
      const actual = run()
      assert.ok(Math.abs(actual - Number(expected)) < 1e-9, `${expr} @ ${envText}：期望 ${expected}，实际 ${actual}`)
    }
  }
})

console.log(`\n${passed} kit-expr checks passed`)
