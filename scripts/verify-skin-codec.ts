/**
 * Golden check: TS hskin codec vs Rust/Node fixtures under skin-core/tests/fixtures.
 * Run: npm run test:skin-codec
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  decodeSkinCode,
  encodeSkinCode,
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
  const expectedId = readFileSync(join(root, `${c.name}.skinid`), 'utf8').trim()
  const fixtureCode = readFileSync(
    join(root, `${c.name}.skincode`),
    'utf8',
  ).trim()

  const encoded = await encodeSkinCode(c.model, rgba)
  if (encoded.skinId !== expectedId) {
    console.error(
      `[FAIL] ${c.name} encode skinId\n  got  ${encoded.skinId}\n  want ${expectedId}`,
    )
    failed++
  } else {
    console.log(`[OK]   ${c.name} encode → skinId`)
  }

  const decodedFixture = await decodeSkinCode(fixtureCode)
  if (decodedFixture.skinId !== expectedId) {
    console.error(
      `[FAIL] ${c.name} decode fixture skinId\n  got  ${decodedFixture.skinId}\n  want ${expectedId}`,
    )
    failed++
  } else if (decodedFixture.decoded.model !== c.model) {
    console.error(
      `[FAIL] ${c.name} decode model ${decodedFixture.decoded.model} ≠ ${c.model}`,
    )
    failed++
  } else if (decodedFixture.decoded.rgba.length !== rgba.length) {
    console.error(`[FAIL] ${c.name} rgba length`)
    failed++
  } else {
    let same = true
    for (let i = 0; i < rgba.length; i++) {
      if (rgba[i] !== decodedFixture.decoded.rgba[i]) {
        same = false
        break
      }
    }
    if (!same) {
      console.error(`[FAIL] ${c.name} rgba bytes ≠ fixture .rgba`)
      failed++
    } else {
      console.log(`[OK]   ${c.name} decode fixture skincode`)
    }
  }

  const round = await decodeSkinCode(encoded.skinCode)
  if (round.skinId !== expectedId) {
    console.error(`[FAIL] ${c.name} round-trip skinId`)
    failed++
  } else {
    console.log(`[OK]   ${c.name} TS round-trip`)
  }
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log(`\nAll ${meta.cases.length} fixture cases passed.`)
