import { useRef, useState } from 'react'
import { createdRenameOnDismiss } from './newFileTypes'

/** Why the rename input is leaving. blank means a newer create replaced this row. */
export type ImmediateRenameIntent = 'none' | 'submit' | 'escape' | 'blank'

export function isGuardedRenameIntent(intent: ImmediateRenameIntent): boolean {
  return intent === 'submit' || intent === 'escape' || intent === 'blank'
}

/** Bump when a new row replaces the old one, so the old blur cannot close the new row. */
export function nextImmediateEpoch(epoch: number): number {
  return epoch + 1
}

/**
 * Blank click that should finish the current name and create again.
 * Interactive controls and existing rows are not blank space.
 */
export function isImmediateCreateBlankTarget(
  target: EventTarget | null,
  interactiveSelector: string,
  surfaceSelector: string,
): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest(interactiveSelector)) return false
  return Boolean(target.closest(surfaceSelector))
}

export type ImmediateCreateQueue = { current: Promise<void> }

/** Run create/rename tasks one at a time. A rejected task must not stall the queue. */
export function enqueueImmediateCreate(
  queue: ImmediateCreateQueue,
  task: () => Promise<void>,
): Promise<void> {
  const run = queue.current.then(task, task)
  queue.current = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** Shared dismiss rule: empty, invalid, or unchanged names stay as created. */
export function createdNameOnDismiss(
  base: string,
  committedBase: string,
  invalid: boolean,
): 'keep' | 'commit' {
  return createdRenameOnDismiss(base, committedBase, invalid)
}

export type ImmediateCreateWheel<TSession, TSpec> = {
  intentRef: { current: ImmediateRenameIntent }
  epochRef: { current: number }
  sessionRef: { current: TSession | null }
  lastRef: { current: TSpec | null }
  session: TSession | null
  updateSession: (next: TSession | null) => void
  run: (task: () => Promise<void>) => Promise<void>
  /** Mark the current input as replaced, then bump the epoch. */
  beginReplace: () => void
  /** Call when the input mounts. Resets intent so a later blur can dismiss. */
  arm: () => number
  mark: (intent: 'submit' | 'escape') => void
  /**
   * Blur handler. Guarded intents and stale epochs do nothing.
   * finish is queued so it cannot overlap the next create.
   */
  dismiss: (epoch: number, finish: () => Promise<void>) => void
}

/**
 * Session machinery shared by explorers that create first and rename in place.
 * Domain code still decides how a file is created and how a name is saved.
 */
export function useImmediateCreateWheel<TSession, TSpec>(): ImmediateCreateWheel<TSession, TSpec> {
  const intentRef = useRef<ImmediateRenameIntent>('none')
  const epochRef = useRef(0)
  const queueRef = useRef(Promise.resolve())
  const sessionRef = useRef<TSession | null>(null)
  const lastRef = useRef<TSpec | null>(null)
  const [session, setSession] = useState<TSession | null>(null)

  const updateSession = (next: TSession | null) => {
    sessionRef.current = next
    setSession(next)
  }

  const run = (task: () => Promise<void>) => {
    const queue: ImmediateCreateQueue = {
      get current() {
        return queueRef.current
      },
      set current(value: Promise<void>) {
        queueRef.current = value
      },
    }
    return enqueueImmediateCreate(queue, task)
  }

  const beginReplace = () => {
    intentRef.current = 'blank'
    epochRef.current = nextImmediateEpoch(epochRef.current)
  }

  const arm = () => {
    intentRef.current = 'none'
    return epochRef.current
  }

  const mark = (intent: 'submit' | 'escape') => {
    intentRef.current = intent
  }

  const dismiss = (epoch: number, finish: () => Promise<void>) => {
    if (epoch !== epochRef.current) return
    if (isGuardedRenameIntent(intentRef.current)) {
      intentRef.current = 'none'
      return
    }
    void run(finish)
  }

  return {
    intentRef,
    epochRef,
    sessionRef,
    lastRef,
    session,
    updateSession,
    run,
    beginReplace,
    arm,
    mark,
    dismiss,
  }
}
