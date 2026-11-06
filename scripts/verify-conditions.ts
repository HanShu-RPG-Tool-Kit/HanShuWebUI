import assert from 'node:assert/strict'
import {
  emitConditionExpression,
  parseConditionRules,
  parseHideWhenRepeatUnsatisfied,
  type ProgressConditionRule,
} from '../src/workspaces/gameplay/conditions.ts'

assert.equal(emitConditionExpression([]), '')

const sample: ProgressConditionRule[] = [
  { kind: 'quest', op: 'active', questId: 'village_bread' },
  { kind: 'talk_read', injectId: 'village_intro' },
  { kind: 'level', cmp: '>=', n: 10 },
]
assert.equal(
  emitConditionExpression(sample),
  '(questState(ctx.player, "active", "village_bread")) && (talkRead(ctx.player, "village_intro")) && (ctx.player.experienceLevel >= 10)',
)

assert.equal(
  emitConditionExpression([{ kind: 'progress', op: 'succeeded', questId: 'q1', progressId: 'start' }]),
  '(progressState(ctx.player, "succeeded", "q1", "start"))',
)
assert.equal(emitConditionExpression([{ kind: 'talk_unread', injectId: 'intro' }]), '(!talkRead(ctx.player, "intro"))')
assert.equal(emitConditionExpression([{ kind: 'reputation', cmp: '>', factionId: 'town', n: 0 }]), '(reputationPoints(ctx.player, "town") > 0)')
assert.equal(emitConditionExpression([{ kind: 'day' }]), '(isDay(ctx.player))')
assert.equal(emitConditionExpression([{ kind: 'night' }]), '(!isDay(ctx.player))')
assert.equal(emitConditionExpression([{ kind: 'expr', source: 'ctx.player.experienceLevel >= 10' }]), '(ctx.player.experienceLevel >= 10)')

const migrated = parseConditionRules([
  { kind: 'task', state: 'succeeded', target: 'prologue' },
  { kind: 'dialogue', state: 'before', target: 'intro' },
  { kind: 'expr', state: 'true', target: 'x > 1' },
  { kind: 'repeat', state: 'satisfied', target: '' },
], '可见性', { allowHideRepeat: true })
assert.deepEqual(migrated.rules, [
  { kind: 'quest', op: 'succeeded', questId: 'prologue' },
  { kind: 'talk_unread', injectId: 'intro' },
  { kind: 'expr', source: 'x > 1' },
])
assert.equal(migrated.hideWhenRepeatUnsatisfied, true)
assert.equal(parseHideWhenRepeatUnsatisfied(true, false), true)
assert.throws(() => parseConditionRules([{ kind: 'repeat', state: 'unsatisfied', target: '' }], '可见性', { allowHideRepeat: true }), /不再支持/)
assert.throws(() => parseConditionRules([{ kind: 'repeat', state: 'satisfied', target: '' }], '可承接'), /不能写入重复周期/)

console.log('PASS condition leaf emit + legacy migration')
