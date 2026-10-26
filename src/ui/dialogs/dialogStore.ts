/** 确认 / 提示 / 输入 / 选择弹窗的队列。界面只挂一次 DialogHost，调用方拿 Promise。 */

export type DialogChoice = {
  id: string
  label: string
  detail?: string
  disabled?: boolean
}

type DialogBase = {
  id: number
  title: string
  message: string
}

export type AlertDialogRequest = DialogBase & {
  kind: 'alert'
  confirmLabel: string
  resolve: (value: void) => void
}

export type ConfirmDialogRequest = DialogBase & {
  kind: 'confirm'
  confirmLabel: string
  cancelLabel: string
  danger: boolean
  resolve: (value: boolean) => void
}

export type PromptDialogRequest = DialogBase & {
  kind: 'prompt'
  defaultValue: string
  placeholder: string
  confirmLabel: string
  cancelLabel: string
  validate?: (value: string) => string | null
  resolve: (value: string | null) => void
}

export type ChooseDialogRequest = DialogBase & {
  kind: 'choose'
  options: readonly DialogChoice[]
  cancelLabel: string
  filterable: boolean
  placeholder: string
  resolve: (value: string | null) => void
}

export type DialogRequest =
  | AlertDialogRequest
  | ConfirmDialogRequest
  | PromptDialogRequest
  | ChooseDialogRequest

type Listener = () => void

let nextId = 1
let queue: DialogRequest[] = []
let snapshot: DialogRequest | null = null
const listeners = new Set<Listener>()

function emit() {
  snapshot = queue[0] ?? null
  for (const listener of listeners) listener()
}

export function subscribeDialogs(listener: Listener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getDialogSnapshot() {
  return snapshot
}

export function finishDialog(id: number) {
  if (queue[0]?.id !== id) queue = queue.filter((item) => item.id !== id)
  else queue = queue.slice(1)
  emit()
}

function push<T>(build: (resolve: (value: T) => void) => DialogRequest): Promise<T> {
  return new Promise((resolve) => {
    queue = [...queue, build(resolve)]
    emit()
  })
}

export type AlertDialogOptions = {
  title?: string
  message: string
  confirmLabel?: string
}

export function alertDialog(message: string): Promise<void>
export function alertDialog(options: AlertDialogOptions): Promise<void>
export function alertDialog(input: string | AlertDialogOptions): Promise<void> {
  const options = typeof input === 'string' ? { message: input } : input
  return push((resolve) => ({
    id: nextId++,
    kind: 'alert',
    title: options.title ?? '提示',
    message: options.message,
    confirmLabel: options.confirmLabel ?? '知道了',
    resolve,
  }))
}

export type ConfirmDialogOptions = {
  title?: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

export function confirmDialog(message: string): Promise<boolean>
export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean>
export function confirmDialog(input: string | ConfirmDialogOptions): Promise<boolean> {
  const options = typeof input === 'string' ? { message: input } : input
  return push((resolve) => ({
    id: nextId++,
    kind: 'confirm',
    title: options.title ?? '确认',
    message: options.message,
    confirmLabel: options.confirmLabel ?? (options.danger ? '删除' : '确认'),
    cancelLabel: options.cancelLabel ?? '取消',
    danger: Boolean(options.danger),
    resolve,
  }))
}

export type PromptDialogOptions = {
  title?: string
  message?: string
  defaultValue?: string
  placeholder?: string
  confirmLabel?: string
  cancelLabel?: string
  validate?: (value: string) => string | null
}

export function promptDialog(options: PromptDialogOptions = {}): Promise<string | null> {
  return push((resolve) => ({
    id: nextId++,
    kind: 'prompt',
    title: options.title ?? '输入',
    message: options.message ?? '',
    defaultValue: options.defaultValue ?? '',
    placeholder: options.placeholder ?? '',
    confirmLabel: options.confirmLabel ?? '确定',
    cancelLabel: options.cancelLabel ?? '取消',
    validate: options.validate,
    resolve,
  }))
}

export type ChooseDialogOptions = {
  title?: string
  message?: string
  options: readonly DialogChoice[]
  cancelLabel?: string
  filterable?: boolean
  placeholder?: string
}

export function chooseDialog(options: ChooseDialogOptions): Promise<string | null> {
  return push((resolve) => ({
    id: nextId++,
    kind: 'choose',
    title: options.title ?? '选择',
    message: options.message ?? '',
    options: options.options,
    cancelLabel: options.cancelLabel ?? '取消',
    filterable: options.filterable ?? options.options.length > 8,
    placeholder: options.placeholder ?? '筛选',
    resolve,
  }))
}
