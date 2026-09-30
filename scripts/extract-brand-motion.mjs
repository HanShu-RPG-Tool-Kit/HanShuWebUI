import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const htmlPath = path.join(
  root,
  'reftemp/HanShu-brand-kit-2026-09-29/HanShu-brand-kit/animation/HanShu-motion.html',
)
const outPath = path.join(root, 'src/brand/hanshu-motion-art.svg')

const html = fs.readFileSync(htmlPath, 'utf8')
const start = html.indexOf('<svg id="art"')
const end = html.indexOf('<div class="stage-bottom"')
if (start < 0 || end < 0) {
  throw new Error('Could not locate motion SVG in brand HTML')
}

let svg = html.slice(start, end).trim()
svg = svg
  .replaceAll('id="motion-circle"', 'id="hanshu-motion-circle"')
  .replaceAll('url(#motion-circle)', 'url(#hanshu-motion-circle)')

fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, `${svg}\n`)
console.log(`wrote ${outPath} (${svg.length} chars)`)
