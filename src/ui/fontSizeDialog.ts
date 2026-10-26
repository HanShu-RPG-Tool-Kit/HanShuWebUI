import { chooseDialog } from './dialogs'

const PRESETS = [12, 14, 16, 18, 20, 22, 24, 28, 32]

/** 选择编辑器字号。取消返回 null。范围外的预设会被丢掉。 */
export async function pickFontSize(current: number, min = 12, max = 32): Promise<number | null> {
  const sizes = [...new Set([...PRESETS.filter((size) => size >= min && size <= max), Math.round(current)])].sort(
    (left, right) => left - right,
  )
  const picked = await chooseDialog({
    title: '编辑器字号',
    message: '选择后立即生效。',
    options: sizes.map((size) => ({
      id: String(size),
      label: size + 'px',
      detail: size === Math.round(current) ? '当前' : undefined,
    })),
    filterable: false,
  })
  if (!picked) return null
  const value = Number(picked)
  return value >= min && value <= max ? value : null
}
