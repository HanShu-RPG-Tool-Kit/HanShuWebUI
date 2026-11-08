import assert from 'node:assert/strict'
import {
  extractChoiceParts,
  extractDialogueBlocks,
  formatDialoguePlainText,
  resolveDialogueLocaleText,
} from '../src/monaco/copyDialogue'

const source = `alice:a1b2c3d4//
bob:
e5f60718
//
-c0ffee01:d00d0001//
`

const map: Record<string, string> = {
  a1b2c3d4: '你好',
  e5f60718: '再见',
  c0ffee01: '继续',
  d00d0001: '好的',
}
const lookup = (key: string) => map[key] ?? null

assert.equal(resolveDialogueLocaleText('a1b2c3d4', lookup), '你好')
assert.equal(resolveDialogueLocaleText('plain text', lookup), 'plain text')
assert.equal(resolveDialogueLocaleText('deadbeef', lookup), 'deadbeef')

const raw = formatDialoguePlainText(
  extractDialogueBlocks(source),
  extractChoiceParts(source),
)
assert.match(raw, /a1b2c3d4/)
assert.match(raw, /c0ffee01/)

const localized = formatDialoguePlainText(
  extractDialogueBlocks(source),
  extractChoiceParts(source),
  lookup,
)
assert.equal(localized.includes('a1b2c3d4'), false)
assert.match(localized, /你好/)
assert.match(localized, /再见/)
assert.match(localized, /继续/)
assert.match(localized, /好的/)

console.log('PASS copy dialogue: raw keys vs localized lookup')
