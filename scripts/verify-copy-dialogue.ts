import assert from 'node:assert/strict'
import {
  extractChoiceParts,
  extractDialogueBlocks,
  formatDialoguePlainText,
  substituteLocaleKeysInSource,
} from '../src/monaco/copyDialogue'

const source = `alice:a1b2c3d4//
bob:
e5f60718
//
-c0ffee01:d00d0001//
`

const map: Record<string, string> = {
  a1b2c3d4: '你好',
  e5f60718: '再见\n朋友',
  c0ffee01: '继续',
  d00d0001: '好的',
}
const lookup = (key: string) => map[key] ?? null

const raw = formatDialoguePlainText(
  extractDialogueBlocks(source),
  extractChoiceParts(source),
)
assert.match(raw, /a1b2c3d4/)
assert.match(raw, /c0ffee01/)

const localized = substituteLocaleKeysInSource(source, lookup)
assert.equal(localized.replaced, 4)
assert.equal(localized.missing.length, 0)
assert.match(localized.content, /^alice:你好\/\//m)
assert.match(localized.content, /^bob:\n再见\n朋友\n\/\//m)
assert.match(localized.content, /^-继续:好的\/\//m)
assert.match(localized.content, /alice:/)
assert.match(localized.content, /bob:/)
assert.equal(localized.content.includes('a1b2c3d4'), false)

const missing = substituteLocaleKeysInSource('npc:deadbeef//\n', lookup)
assert.equal(missing.replaced, 0)
assert.deepEqual(missing.missing, ['deadbeef'])
assert.match(missing.content, /deadbeef/)

console.log('PASS copy dialogue: plain extract + DSL key substitution')
