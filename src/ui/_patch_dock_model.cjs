const fs = require("fs")
let model = fs.readFileSync("src/ui/panelDockModel.ts", "utf8")
if (model.charCodeAt(0) === 0xfeff) model = model.slice(1)
if (!model.includes("export function setCellPixels")) {
  const fn = `
export function setCellPixels(
  layout: DockLayout,
  edge: DockEdge,
  laneIndex: number,
  cellIndex: number,
  aPx: number,
  bPx: number,
  cross: number,
  visible: ReadonlySet<string>,
) {
  const lane = layout.lanes[edge][laneIndex]
  if (!lane) return
  const shown = lane.cells
    .map((cell, index) => ({ cell, index }))
    .filter((item) => visible.has(item.cell.id))
  const pairAt = shown.findIndex((item) => item.index === cellIndex)
  const a = shown[pairAt]
  const b = shown[pairAt + 1]
  if (!a || !b) return
  const gaps = Math.max(0, shown.length - 1) * DOCK_SASH
  const inner = Math.max(0, cross - gaps)
  const sizes = share(inner, shown.map((item) => item.cell.weight))
  const pair = (sizes[pairAt] ?? 0) + (sizes[pairAt + 1] ?? 0)
  if (pair <= 0) return
  const nextA = clamp(aPx, Math.min(MIN_CELL, pair), Math.max(0, pair - Math.min(MIN_CELL, pair)))
  sizes[pairAt] = nextA
  sizes[pairAt + 1] = pair - nextA
  shown.forEach((item, index) => {
    item.cell.weight = Math.max(1, sizes[index] ?? 1)
  })
}
`
  model = model.replace("export function resizeCell", fn + "\nexport function resizeCell")
}
fs.writeFileSync("src/ui/panelDockModel.ts", model.replace(/\r?\n/g, "\r\n"))

let dock = fs.readFileSync("src/ui/PanelDock.tsx", "utf8")
if (dock.charCodeAt(0) === 0xfeff) dock = dock.slice(1)
dock = dock.replace("  type DockPanelRecord,\n", "")
dock = dock.replace("function opposite(edge: DockEdge): DockEdge {\n  if (edge === \"left\") return \"right\"\n  if (edge === \"right\") return \"left\"\n  if (edge === \"top\") return \"bottom\"\n  return \"top\"\n}\n", "")
const badFit = `    const others = [...current.lanes.left, ...current.lanes.right].filter((lane, index, list) => {
      const source = (lane === current.lanes[loc.edge][loc.laneIndex])
      return !source && lane.cells.some((cell) => visible.has(cell.id))
    })
    void index
    void list`
const goodFit = `    const agentLane = current.lanes[loc.edge][loc.laneIndex]
    const others = [...current.lanes.left, ...current.lanes.right].filter(
      (lane) => lane !== agentLane && lane.cells.some((cell) => visible.has(cell.id)),
    )`
if (!dock.includes(badFit)) throw new Error("fitAgent block missing")
dock = dock.replace(badFit, goodFit)
const unusedCross = `    const cross = band ? (sash.edge === "left" || sash.edge === "right" ? (rect?.height ?? band.h) : band.w + (shown.length - 1) * 0) : 0\n`
if (!dock.includes(unusedCross)) throw new Error("unused cross missing")
dock = dock.replace(unusedCross, "")
fs.writeFileSync("src/ui/PanelDock.tsx", dock.replace(/\r?\n/g, "\r\n"))
console.log("patched")
