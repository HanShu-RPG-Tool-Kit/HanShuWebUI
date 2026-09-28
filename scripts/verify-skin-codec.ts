/**
 * Golden check: TS codec vs PNG/RGBA fixtures under skin-core/tests/fixtures.
 * Run: npm run test:skin-codec
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  decodeShareCode,
  encodeShareCode,
  type SkinModel,
} from '../src/skin/local/codec.ts'

const root = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src-tauri',
  'crates',
  'skin-core',
  'tests',
  'fixtures',
)

const meta = JSON.parse(readFileSync(join(root, 'fixtures.json'), 'utf8')) as {
  cases: Array<{ name: string; model: SkinModel }>
}

let failed = 0

for (const c of meta.cases) {
  const rgba = new Uint8Array(readFileSync(join(root, `${c.name}.rgba`)))
  const decodedIn = { rgba, width: 64, height: 64, flags: 0 }
  const encoded = await encodeShareCode(c.model, decodedIn)
  const round = await decodeShareCode(encoded.skinCode)
  if (round.skinId !== encoded.skinId) {
    console.error(`[FAIL] ${c.name} skinId mismatch`)
    failed++
  } else if (round.model !== c.model) {
    console.error(`[FAIL] ${c.name} model mismatch`)
    failed++
  } else if (round.decoded.rgba.length !== rgba.length) {
    console.error(`[FAIL] ${c.name} rgba length`)
    failed++
  } else {
    // classic vs slim same id
    const other = c.model === 'classic' ? 'slim' : 'classic'
    const alt = await encodeShareCode(other, decodedIn)
    if (alt.skinId !== encoded.skinId) {
      console.error(`[FAIL] ${c.name} model changed skinId`)
      failed++
    } else {
      console.log(`[OK]   ${c.name}`)
    }
  }
}

if (failed) {
  console.error(`\n${failed} failure(s)`)
  process.exit(1)
}
console.log('\nall ok')
