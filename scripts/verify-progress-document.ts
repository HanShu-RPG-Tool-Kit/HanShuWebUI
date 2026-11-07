import assert from 'node:assert/strict'
import { createProgress, createProgressGoal, duplicateProgressGoal, moveProgressGoal, parseProgress, progressIssues, readProgressSource, stringifyProgress } from '../src/workspaces/gameplay/progressDoc.ts'
import { parseGoalDefinitionsFromSource } from '../src/workspaces/gameplay/goalDefinitions.ts'
const defs = parseGoalDefinitionsFromSource(`import Tick from "test.Tick"\n@goal("sample:counter")\n@config(field("target","int",10,{required:true}))\n@state()\n@subscribe(Tick)\nfunction on_tick(instance: GoalInstance,event: Tick): void {}\nfunction update_state(instance: GoalInstance): void {}`, { sourceKey: 'counter-script', sourceName: 'counter.js' })
const doc = createProgress(' 名称输入中的空格 ')
doc.rewardKits = ['travel_supplies', 'completion_bonus']
assert.deepEqual(parseProgress(stringifyProgress(doc)).rewardKits, doc.rewardKits)
assert.throws(() => parseProgress(stringifyProgress({ ...doc, rewardKits: ['same', 'same'] })), /不能重复/)
const first = createProgressGoal('sample:counter', defs)
assert.deepEqual(Object.keys(first).sort(), ['config', 'id', 'kind'])
assert.deepEqual(first.config, {}, 'script defaults are inherited, never copied into instance overrides')
assert.ok(!progressIssues({ ...doc, goals: [first] }, defs).length, 'required fields can inherit a script default')
first.config.target = 10
const second = createProgressGoal('sample:counter', defs)
doc.goals = [first, second]
const moved = moveProgressGoal(doc, first.id, 2)
assert.deepEqual(moved.goals.map(goal => goal.id), [second.id, first.id])
assert.deepEqual(moved.goals[1]!.config, first.config)
assert.deepEqual(doc.goals.map(goal => goal.id), [first.id, second.id], 'sorting must not mutate history')
assert.deepEqual(moveProgressGoal(doc, second.id, 0).goals.map(goal => goal.id), [second.id, first.id])
const copy = duplicateProgressGoal(first)
assert.notEqual(copy.id, first.id); copy.config.target = 99; assert.equal(first.config.target, 10)
assert.equal(parseProgress(stringifyProgress({ ...doc, goals: [first] })).goals[0]!.config.target, 10, 'explicit value equal to default remains explicit')
delete first.config.target
assert.ok(!Object.hasOwn(parseProgress(stringifyProgress({ ...doc, goals: [first] })).goals[0]!.config, 'target'), 'resetting removes the override')
first.config.target = 10
for (const completion of ['all', 'any'] as const) {
  const draft = { ...moved, completion }
  assert.deepEqual(parseProgress(stringifyProgress(draft)), draft)
  assert.ok(!('groups' in JSON.parse(stringifyProgress(draft))))
}
assert.deepEqual(parseProgress(stringifyProgress(moved), []).goals, moved.goals, 'unknown definitions must preserve goals')
assert.deepEqual(parseProgress(stringifyProgress(moved), [{ ...defs[0]!, fields: [{ key: 'newField', type: 'int', required: false, default: 12 }] }]).goals, moved.goals, 'reading never injects schema defaults')
doc.visibility = [
  { kind: 'quest', op: 'succeeded', questId: 'first_task' },
  { kind: 'talk', op: 'read', injectId: 'intro' },
  { kind: 'expr', source: 'ctx.player.experienceLevel >= 10' },
]
doc.acceptance = [{ kind: 'quest', op: 'completed', questId: 'other_task' }]
assert.deepEqual(parseProgress(stringifyProgress(doc)).visibility, doc.visibility)
assert.deepEqual(parseProgress(stringifyProgress(doc)).acceptance, doc.acceptance)
const noAcceptance = parseProgress(stringifyProgress({ ...doc, acceptance: [] }))
assert.deepEqual(noAcceptance.acceptance, [])
assert.deepEqual(noAcceptance.visibility, doc.visibility, 'clearing acceptance never changes visibility')
const serialized = JSON.parse(stringifyProgress(doc))
assert.ok(!('accept' in serialized) && !('visible' in serialized) && !('deliver' in serialized) && !('fail' in serialized))
const legacy = parseProgress(JSON.stringify({
  ...serialized,
  hideWhenRepeatUnsatisfied: true,
  visibility: [
    { kind: 'task', state: 'succeeded', target: 'first_task' },
    { kind: 'dialogue', state: 'after', target: 'intro' },
    { kind: 'talk_unread', injectId: 'old_intro' },
    { kind: 'night' },
    { kind: 'expr', state: 'true', target: 'level >= 10' },
    { kind: 'repeat', state: 'satisfied', target: '' },
  ],
  acceptance: [{ kind: 'task', state: 'ended', target: 'other_task' }],
}))
assert.deepEqual(legacy.visibility, [
  { kind: 'quest', op: 'succeeded', questId: 'first_task' },
  { kind: 'talk', op: 'read', injectId: 'intro' },
  { kind: 'talk', op: 'unread', injectId: 'old_intro' },
  { kind: 'time', op: 'night' },
  { kind: 'expr', source: 'level >= 10' },
])
assert.deepEqual(legacy.acceptance, [{ kind: 'quest', op: 'completed', questId: 'other_task' }])
assert.equal(Object.hasOwn(legacy, 'hideWhenRepeatUnsatisfied'), false)
assert.throws(() => parseProgress(JSON.stringify({ ...serialized, visibility: [{ kind: 'dialogue', state: 'succeeded', target: 'intro' }] })), /对话条件状态无效/)
assert.throws(() => parseProgress(JSON.stringify({ ...serialized, visibility: [{ kind: 'task', state: 'after', target: 'first_task' }] })), /状态无效/)
assert.throws(() => parseProgress(JSON.stringify({ ...serialized, visibility: [{ kind: 'repeat', state: 'unsatisfied', target: '' }] })), /不再支持/)
assert.throws(() => parseProgress(JSON.stringify({ ...serialized, visibility: [{ kind: 'repeat', state: 'satisfied', target: 'self' }] })), /重复周期条件不需要对象/)
assert.throws(() => parseProgress(JSON.stringify({ ...serialized, acceptance: [{ kind: 'repeat', state: 'satisfied', target: '' }] })), /不能写入重复周期/)
assert.ok(progressIssues({ ...doc, visibility: [{ kind: 'quest', op: 'active', questId: '' }] }, defs).some(issue => issue.includes('请填写任务标识符')))
assert.ok(progressIssues({ ...doc, visibility: [{ kind: 'expr', source: '' }] }, defs).some(issue => issue.includes('请填写表达式')))
assert.equal(readProgressSource('{broken').doc, null)
assert.equal(readProgressSource(JSON.stringify({ ...doc, groups: [] })).doc, null)
assert.equal(readProgressSource(JSON.stringify({ ...doc, completion: 'atLeast' })).doc, null)
assert.throws(() => parseProgress(stringifyProgress({ ...doc, goals: [first, first] })), /重复 ID/)
const empty = createProgress('')
assert.deepEqual(empty.visibility, [])
assert.deepEqual(empty.acceptance, [])
assert.equal(Object.hasOwn(empty, 'hideWhenRepeatUnsatisfied'), false)
assert.equal(empty.autoStartWhenAcceptable, false)
assert.equal(parseProgress(stringifyProgress(empty)).autoStartWhenAcceptable, false)
assert.equal(parseProgress(stringifyProgress({ ...empty, autoStartWhenAcceptable: true })).autoStartWhenAcceptable, true)
assert.throws(() => parseProgress(JSON.stringify({ ...JSON.parse(stringifyProgress(empty)), autoStartWhenAcceptable: 'yes' })), /autoStartWhenAcceptable/)
assert.ok(!progressIssues({ ...doc, visibility: [], acceptance: [] }, defs).some(issue => issue.includes('条件')), 'empty conditions are satisfied, not incomplete')
assert.equal(parseProgress(stringifyProgress(empty)).goals.length, 0)
assert.equal(parseProgress(stringifyProgress(empty)).name, 'name')
assert.equal(parseProgress(stringifyProgress(empty)).description, 'description')
assert.ok(progressIssues(empty, defs).some(issue => issue.includes('至少一个目标')))
assert.ok(progressIssues(empty, defs, () => '').some(issue => issue.includes('请填写进度名称')), 'empty locale text counts as missing title')
assert.ok(!progressIssues(empty, defs, (key) => key === 'name' ? '有标题' : '').some(issue => issue.includes('请填写进度名称')))
console.log('PASS: flat goals, all/any rules, stable sorting, script defaults, immutable copies, parse protection')

const missingAutoStart = JSON.parse(stringifyProgress(empty))
delete missingAutoStart.autoStartWhenAcceptable
assert.equal(parseProgress(JSON.stringify(missingAutoStart)).autoStartWhenAcceptable, false, 'missing auto-start is off, not an unreadable document')
