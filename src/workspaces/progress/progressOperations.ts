import { parseProgress, stringifyProgress, type ProgressDocument } from './progressDoc'

import type { ProgressSlot, ProgressTarget, ProgressEffect } from '../../collab/generated'
export type { ProgressSlot, ProgressTarget, ProgressEffect, ProgressCommand, ProgressCommandResult } from '../../collab/generated'
export type { ProgressAcknowledgement } from '../../project/serviceClient'

export type ProgressState = { source: string; languages: Record<string, Record<string, string>> }
const fields = ['name', 'description', 'authorNotes', 'tags', 'completion', 'completionGraph', 'visibility', 'acceptance', 'abandonable', 'autoStartWhenAcceptable', 'repeat', 'rewardKits'] as const
const clone = <T,>(value: T): T => structuredClone(value)
export const sameProgressValue = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => sameProgressValue(value, b[i]))
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>
  return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => Object.hasOwn(right, key) && sameProgressValue(left[key], right[key]))
}
const absent = (): ProgressSlot => ({ present: false, value: null })
const slot = (value: unknown): ProgressSlot => value === undefined ? absent() : { present: true, value: clone(value) }
const own = (object: Record<string, unknown> | undefined, key: string) => object && Object.hasOwn(object, key) ? object[key] : undefined
const put = (object: object, key: string, value: unknown) => { Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true }) }
export const progressTargetKey = (target: ProgressTarget) => JSON.stringify(target)
export function progressSlot(state: ProgressState, target: ProgressTarget): ProgressSlot {
  if (target.kind === 'locale') return slot(own(state.languages[target.locale], target.key))
  const doc = JSON.parse(state.source) as Record<string, unknown> & { goals: { id: string; kind: string; config: Record<string, unknown> }[] }
  if (target.kind === 'field') {
    if (target.field === 'authorNotes') return slot(doc.authorNotes ?? '')
    if (target.field === 'repeat' && doc.repeat && typeof doc.repeat === 'object' && (doc.repeat as { kind?: string }).kind !== 'duration') return slot({ kind: (doc.repeat as { kind?: string }).kind })
    return slot(doc[target.field])
  }
  if (target.kind === 'goal-order') return slot(doc.goals.map(goal => goal.id))
  const goal = doc.goals.find(goal => goal.id === target.goalId)
  if (target.kind === 'goal') return slot(goal)
  if (!goal) return absent()
  if (target.kind === 'goal-body') return slot({ kind: goal.kind, config: goal.config })
  return slot(own(goal.config, target.key))
}
/** Diff semantic addresses, never array offsets or complete source snapshots. */
export function progressDocumentEffects(before: string, after: string): ProgressEffect[] {
  const previous = JSON.parse(before), next = JSON.parse(after)
  if (previous.id !== next.id) throw new Error('进度文档 ID 不能在表单中更改')
  const effects: ProgressEffect[] = []
  const add = (target: ProgressTarget, expected: unknown, value: unknown) => {
    if (!sameProgressValue(expected, value)) effects.push({ target, expected: slot(expected), value: slot(value) })
  }
  for (const field of fields) add({ kind: 'field', field }, previous[field], next[field])
  const oldGoals = new Map<string, ProgressDocument['goals'][number]>(previous.goals.map((goal: ProgressDocument['goals'][number]) => [goal.id, goal]))
  const newGoals = new Map<string, ProgressDocument['goals'][number]>(next.goals.map((goal: ProgressDocument['goals'][number]) => [goal.id, goal]))
  for (const [goalId, goal] of oldGoals) {
    const replacement = newGoals.get(goalId)
    if (!replacement) add({ kind: 'goal', goalId }, goal, undefined)
    else if (goal.kind !== replacement.kind) add({ kind: 'goal-body', goalId }, { kind: goal.kind, config: goal.config }, { kind: replacement.kind, config: replacement.config })
    else for (const key of new Set([...Object.keys(goal.config), ...Object.keys(replacement.config)])) add({ kind: 'goal-config', goalId, goalKind: goal.kind, key }, own(goal.config, key), own(replacement.config, key))
  }
  for (const [goalId, goal] of newGoals) if (!oldGoals.has(goalId)) add({ kind: 'goal', goalId }, undefined, goal)
  add({ kind: 'goal-order' }, previous.goals.map((goal: { id: string }) => goal.id), next.goals.map((goal: { id: string }) => goal.id))
  return effects
}
export function applyProgressEffects(state: ProgressState, effects: ProgressEffect[]): ProgressState {
  const next = clone(state), doc = JSON.parse(next.source)
  for (const { target, value } of effects) {
    if (target.kind === 'locale') {
      const language = next.languages[target.locale] ??= {}
      if (value.present) put(language, target.key, String(value.value)); else delete language[target.key]
    } else if (target.kind === 'field') {
      if (value.present) doc[target.field] = clone(value.value); else delete doc[target.field]
    } else if (target.kind === 'goal') {
      const index = doc.goals.findIndex((goal: { id: string }) => goal.id === target.goalId)
      if (value.present) { if (index < 0) doc.goals.push(clone(value.value)); else doc.goals[index] = clone(value.value) }
      else if (index >= 0) doc.goals.splice(index, 1)
    } else if (target.kind !== 'goal-order') {
      const goal = doc.goals.find((goal: { id: string }) => goal.id === target.goalId)
      if (!goal) continue // The original intent remains available for conflict resolution.
      if (target.kind === 'goal-body') Object.assign(goal, clone(value.value))
      else if (value.present) put(goal.config, target.key, clone(value.value))
      else delete goal.config[target.key]
    }
  }
  const order = effects.findLast(effect => effect.target.kind === 'goal-order')
  if (order?.value.present && Array.isArray(order.value.value)) {
    const ids = order.value.value as string[]
    doc.goals.sort((a: { id: string }, b: { id: string }) => {
      const left = ids.indexOf(a.id), right = ids.indexOf(b.id)
      return (left < 0 ? ids.length : left) - (right < 0 ? ids.length : right)
    })
  }
  next.source = JSON.stringify(doc, null, 2) + '\n'
  return next
}
/** Only coalesce drafts that have not entered the durable submission queue. */
export function coalesceProgressEffects(effects: ProgressEffect[]): ProgressEffect[] {
  const result = new Map<string, ProgressEffect>()
  for (const input of effects) {
    const effect = clone(input)
    const target = effect.target
    if ('goalId' in target) {
      const related = [...result.entries()].filter(([, item]) => 'goalId' in item.target && item.target.goalId === target.goalId)
      const whole = related.find(([, item]) => item.target.kind === 'goal')
      const body = related.find(([, item]) => item.target.kind === 'goal-body')
      if (target.kind === 'goal-config' && (whole?.[1].value.present || body)) {
        const aggregate = whole?.[1].value.present ? whole[1] : body![1]
        const value = aggregate.value.value as { config: Record<string, unknown> }
        if (effect.value.present) put(value.config, target.key, effect.value.value); else delete value.config[target.key]
        continue
      }
      if (target.kind === 'goal-body' && whole?.[1].value.present) {
        Object.assign(whole[1].value.value as object, effect.value.value)
        continue
      }
      if (target.kind === 'goal-body' || target.kind === 'goal') {
        const original = effect.expected.value as { kind: string; config: Record<string, unknown> } | null
        for (const [key, previous] of related) {
          if (previous.target.kind === 'goal-config' && original) {
            if (previous.expected.present) put(original.config, previous.target.key, previous.expected.value)
            else delete original.config[previous.target.key]
          } else if (previous.target.kind === 'goal-body' && original) Object.assign(original, previous.expected.value)
          else if (previous.target.kind === 'goal') effect.expected = previous.expected
          result.delete(key)
        }
      }
    }
    const key = progressTargetKey(effect.target), previous = result.get(key)
    result.set(key, { ...effect, expected: previous?.expected ?? effect.expected })
  }
  return [...result.values()].filter(effect => !sameProgressValue(effect.expected, effect.value))
}
export function normalProgressSource(source: string) { return stringifyProgress(parseProgress(source)) }
