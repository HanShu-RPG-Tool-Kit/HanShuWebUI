import fs from 'node:fs'

const svg = fs.readFileSync('src/brand/hanshu-wordmark.svg', 'utf8')
const viewBox = svg.match(/viewBox="([^"]+)"/)[1]
console.log('viewBox', viewBox)

// Approximate axis-aligned bounds ignoring skew first.
const letters = [
  { x: 0, w: 38 },
  { x: 46, w: 40 },
  { x: 94, w: 40 },
  { x: 142, w: 40 },
  { x: 190, w: 38 },
  { x: 236, w: 40 },
]
const groupX = 6
const contentLeft = groupX + letters[0].x
const contentRight = groupX + letters.at(-1).x + letters.at(-1).w
console.log({ contentLeft, contentRight, rightPad: 286 - contentRight })

// skewX(-5): x' = x + y * tan(-5deg)
const tan = Math.tan((-5 * Math.PI) / 180)
const samples = []
for (const letter of letters) {
  for (const lx of [letter.x, letter.x + letter.w]) {
    for (const y of [0, 48]) {
      samples.push(groupX + lx + y * tan)
    }
  }
}
const minX = Math.min(...samples)
const maxX = Math.max(...samples)
console.log({
  skewedMinX: minX,
  skewedMaxX: maxX,
  suggestedViewBox: `${minX.toFixed(2)} 0 ${(maxX - minX).toFixed(2)} 48`,
})
