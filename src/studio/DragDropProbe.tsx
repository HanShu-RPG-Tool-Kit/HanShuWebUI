import { useEffect, useState, type ReactNode } from 'react'

/**
 * 拖放探针 —— **只在开发构建里挂载**（见 `App.tsx` 的 `import.meta.env.DEV`）。
 *
 * 为什么要有它：外部文件拖进窗口这件事，在 Windows 上要先过一串**窗口层**的前置条件
 * （WebView2 的 `AllowExternalDrop`、以管理员身份运行带来的跨权限拦截、无边框/透明窗口
 * 的命中测试……）。这些条件一旦不成立，拖拽事件**压根不会进到网页层** —— 应用里写的
 * 任何判定、高亮、`preventDefault` 都无从生效，表现就是"拖上去毫无反应 + 禁止光标 🚫"。
 *
 * 这个探针把"窗口到底收到了什么"直接摊开：
 * - 计数：dragenter / dragover / dragleave / drop 各收到几次；
 * - 最后一次事件的 `dataTransfer.types`、`files.length`、`items.length`、`dropEffect`。
 *
 * 判读方式：
 * - **拖上去计数全是 0** → 事件没到网页层，问题不在应用代码里（先查是否以管理员身份运行）；
 * - **计数在涨，但 types 里没有 'files'** → 事件到了、只是不给文件信息（正好印证
 *   准放判据不能看 `types`，见 `drag/dataTransfer` 的说明）；
 * - **内部拖拽（拖键名）也在涨** → 网页层的 HTML5 拖放本身是通的。
 */

type Reading = {
  enter: number
  over: number
  leave: number
  drop: number
  /** 最后一次事件的样子 */
  last: string
  types: string
  files: string
  items: string
}

const EMPTY: Reading = {
  enter: 0,
  over: 0,
  leave: 0,
  drop: 0,
  last: '（还没有任何拖拽事件）',
  types: '—',
  files: '—',
  items: '—',
}

function describe(event: DragEvent, label: string, current: Reading): Reading {
  const dataTransfer = event.dataTransfer
  return {
    enter: current.enter + (label === 'dragenter' ? 1 : 0),
    over: current.over + (label === 'dragover' ? 1 : 0),
    leave: current.leave + (label === 'dragleave' ? 1 : 0),
    drop: current.drop + (label === 'drop' ? 1 : 0),
    last: label,
    types: `[${Array.from(dataTransfer?.types ?? []).join(', ')}]`,
    files: String(dataTransfer?.files?.length ?? 0),
    items: String(dataTransfer?.items?.length ?? 0),
  }
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="dnd-probe-row">
      <span className="dnd-probe-label">{label}</span>
      <span className="dnd-probe-value">{value}</span>
    </div>
  )
}

export function DragDropProbe() {
  const [reading, setReading] = useState<Reading>(EMPTY)
  const [open, setOpen] = useState(true)

  // 只看**窗口**收到什么，所以挂在 window 上；不动默认行为，免得干扰应用自己的投放点
  useEffect(() => {
    const onEnter = (event: DragEvent) =>
      setReading((current) => describe(event, 'dragenter', current))
    const onOver = (event: DragEvent) =>
      setReading((current) => describe(event, 'dragover', current))
    const onLeave = (event: DragEvent) =>
      setReading((current) => describe(event, 'dragleave', current))
    const onDrop = (event: DragEvent) =>
      setReading((current) => describe(event, 'drop', current))

    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  if (!open) {
    return (
      <button
        type="button"
        className="dnd-probe-open"
        onClick={() => setOpen(true)}
        title="打开拖放探针（开发构建专用）"
      >
        拖放探针
      </button>
    )
  }

  const anyEvent = reading.enter + reading.over + reading.leave + reading.drop > 0

  return (
    <div className="dnd-probe" aria-label="拖放探针">
      <div className="dnd-probe-head">
        <span>拖放探针（仅开发构建）</span>
        <button type="button" className="dnd-probe-reset" onClick={() => setOpen(false)}>
          收起
        </button>
      </div>

      {/* 明确的一格投放目标：拖到这里，看下面计数有没有动 */}
      <div
        className={`dnd-probe-zone${anyEvent ? ' is-live' : ''}`}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => event.preventDefault()}
      >
        把文件拖到这一格里
      </div>

      <Row label="dragenter" value={reading.enter} />
      <Row label="dragover" value={reading.over} />
      <Row label="dragleave" value={reading.leave} />
      <Row label="drop" value={reading.drop} />
      <Row label="最后事件" value={reading.last} />
      <Row label="types" value={<code>{reading.types}</code>} />
      <Row label="files" value={reading.files} />
      <Row label="items" value={reading.items} />

      <div className="dnd-probe-note">
        {anyEvent
          ? '窗口收到了拖拽事件 —— 再看 types 里有没有 files'
          : '窗口一个事件都没收到 —— 拖拽没进到网页层，问题在窗口/系统那层'}
      </div>
    </div>
  )
}
