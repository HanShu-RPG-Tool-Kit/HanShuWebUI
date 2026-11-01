import assert from 'node:assert/strict'
import { deflateSync, gzipSync } from 'node:zlib'
import { readFile } from 'node:fs/promises'
import { createBossbar, parseBossbarDocument, stringifyBossbar, upgradeBossbarV1 } from '../src/workspaces/audiovisual/bossbar/parse'
import { decodeBase64, encodeBase64, pngInfo, validatePngPixels } from '../src/workspaces/audiovisual/bossbar/png'
import { BOSSBAR_DEFAULT_TEXTURE, BOSSBAR_LIMITS, longValue, type BossbarDocument, type BossbarProgress } from '../src/workspaces/audiovisual/bossbar/protocol'
import { clampProgress, resolveProgress } from '../src/workspaces/audiovisual/bossbar/rules/range'
import { formatRunValue } from '../src/workspaces/audiovisual/bossbar/rules/formatRun'
import { removeVariable, renameVariable, variableReferences } from '../src/workspaces/audiovisual/bossbar/document'
import { estimateSnapshotBytes } from '../src/workspaces/audiovisual/bossbar/rules/values'

// Tests build PNG containers independently, with Node's zlib and a bitwise CRC.
function chunk(type: string, data: Uint8Array): Buffer {
  const payload = Buffer.concat([Buffer.from(type), data])
  let crc = 0xffffffff
  for (const value of payload) {
    crc ^= value
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  const size = Buffer.alloc(4)
  const checksum = Buffer.alloc(4)
  size.writeUInt32BE(data.length)
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([size, payload, checksum])
}

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const end = chunk('IEND', new Uint8Array())
function header(width = 1, height = 1, depth = 8, color = 6, interlace = 0): Buffer {
  const data = Buffer.alloc(13)
  data.writeUInt32BE(width)
  data.writeUInt32BE(height, 4)
  data[8] = depth
  data[9] = color
  data[12] = interlace
  return chunk('IHDR', data)
}
function png(raw: Uint8Array, options: {
  width?: number; height?: number; depth?: number; color?: number; interlace?: number
  palette?: number; before?: Buffer[]; compressed?: Uint8Array
} = {}): Buffer {
  return Buffer.concat([
    signature,
    header(options.width, options.height, options.depth, options.color, options.interlace),
    ...(options.palette ? [chunk('PLTE', Buffer.alloc(options.palette * 3))] : []),
    ...(options.before ?? []),
    chunk('IDAT', options.compressed ?? deflateSync(raw)),
    end,
  ])
}
function parseTexture(texture: Uint8Array) {
  return parseBossbarDocument(JSON.stringify({ ...createBossbar('png-test'), texture: encodeBase64(texture) }))
}
function rejectsTexture(texture: Uint8Array, label: string): void {
  const result = parseTexture(texture)
  assert.equal(result.ok, false, label)
  if (!result.ok) assert.ok(result.diagnostics.some((issue) => issue.path === 'texture'), label + ' diagnostic')
}

assert.equal(decodeBase64('AAĀ='), null, 'non-ASCII input cannot become zero bytes')
assert.equal(validatePngPixels(decodeBase64(BOSSBAR_DEFAULT_TEXTURE)!), true)
assert.equal(parseTexture(png(Uint8Array.of(0, 255, 0, 0, 255))).ok, true)

// Standard legal bit-depth/color combinations, with and without Adam7.
const modes: [number, number, number][] = [
  [0, 1, 1], [0, 2, 1], [0, 4, 1], [0, 8, 1], [0, 16, 1],
  [2, 8, 3], [2, 16, 3], [3, 1, 1], [3, 2, 1], [3, 4, 1], [3, 8, 1],
  [4, 8, 2], [4, 16, 2], [6, 8, 4], [6, 16, 4],
]
for (const [color, depth, samples] of modes) {
  for (const interlace of [0, 1]) {
    // The seven Adam7 passes for a 9×9 image have fixed dimensions.
    const dimensions = interlace ? [[2, 2], [1, 2], [3, 1], [2, 3], [5, 2], [4, 5], [9, 4]] : [[9, 9]]
    const rows: Buffer[] = []
    for (const [width, height] of dimensions) {
      for (let y = 0; y < height; y += 1) {
        const row = Buffer.alloc(1 + Math.ceil(width * samples * depth / 8))
        // Zero samples remain zero under all five PNG row filters.
        row[0] = y % 5
        rows.push(row)
      }
    }
    assert.equal(parseTexture(png(Buffer.concat(rows), {
      width: 9, height: 9, depth, color, interlace, palette: color === 3 ? 2 : undefined,
    })).ok, true, 'legal PNG color=' + color + ' depth=' + depth + ' interlace=' + interlace)
  }
}
// Empty Adam7 passes are omitted for a 1×1 image.
assert.equal(parseTexture(png(Uint8Array.of(0, 1, 2, 3, 255), { interlace: 1 })).ok, true)
for (const name of ['ember_guard', 'simple_bar']) {
  const source = await readFile(new URL('../demo-projects/bossbar-demo/src/bossbars/' + name + '.bossbar', import.meta.url), 'utf8')
  assert.equal(parseBossbarDocument(source).ok, true, 'demo remains valid: ' + name)
}

rejectsTexture(Buffer.concat([signature, header(), end]), 'missing IDAT')
const badCrc = png(Uint8Array.of(0, 1, 2, 3, 255))
badCrc[badCrc.length - 1] ^= 1
rejectsTexture(badCrc, 'CRC mismatch')
rejectsTexture(png(Uint8Array.of(0, 1, 2, 3, 255), { depth: 4 }), 'illegal RGBA depth')
rejectsTexture(png(Uint8Array.of(0, 1, 2, 3, 255), { before: [header()] }), 'duplicate IHDR')
rejectsTexture(png(Uint8Array.of(0, 1, 2, 3, 255), { before: [chunk('ABCD', new Uint8Array())] }), 'unknown critical chunk')
rejectsTexture(png(Uint8Array.of(0, 1, 2, 3, 255), { interlace: 2 }), 'invalid interlace method')
rejectsTexture(png(Uint8Array.of(5, 1, 2, 3, 255)), 'invalid scanline filter')
rejectsTexture(png(Uint8Array.of(0, 1, 2, 3)), 'truncated pixel stream')
rejectsTexture(png(Uint8Array.of(0, 1, 2, 3, 255, 0)), 'extra pixel stream')
rejectsTexture(png(new Uint8Array(), { compressed: gzipSync(Uint8Array.of(0, 1, 2, 3, 255)) }), 'PNG must use zlib, not gzip')
rejectsTexture(png(new Uint8Array(), { compressed: Uint8Array.of(120, 156, 0) }), 'truncated zlib stream')
const badAdler = deflateSync(Uint8Array.of(0, 1, 2, 3, 255))
badAdler[badAdler.length - 1] ^= 1
rejectsTexture(png(new Uint8Array(), { compressed: badAdler }), 'zlib checksum mismatch with valid chunk CRC')
rejectsTexture(Buffer.concat([png(Uint8Array.of(0, 1, 2, 3, 255)), Buffer.from([0])]), 'trailing bytes after IEND')
rejectsTexture(png(new Uint8Array(), { compressed: Buffer.concat([deflateSync(Uint8Array.of(0, 1, 2, 3, 255)), Buffer.from([0])]) }), 'trailing bytes after zlib stream')
rejectsTexture(png(Uint8Array.of(0, 2), { color: 3, palette: 2 }), 'palette index outside PLTE')
rejectsTexture(png(Uint8Array.of(0, 0), { color: 3 }), 'indexed PNG requires PLTE')
rejectsTexture(png(Uint8Array.of(0, 0), { color: 3, depth: 1, palette: 3 }), 'palette exceeds bit depth')
rejectsTexture(png(Uint8Array.of(0, 1, 2, 3, 255), { before: [chunk('acTL', new Uint8Array(8))] }), 'APNG rejected with valid CRC')
// An oversized expansion is rejected on the first 64KiB output block, without retaining the stream.
rejectsTexture(png(new Uint8Array(), { compressed: deflateSync(Buffer.alloc(8 * 1024 * 1024)) }), 'bounded decompression rejects bomb')
const idat = deflateSync(Uint8Array.of(0, 1, 2, 3, 255))
assert.equal(parseTexture(Buffer.concat([
  signature, header(), chunk('IDAT', idat.subarray(0, 3)), chunk('IDAT', idat.subarray(3)), end,
])).ok, true, 'consecutive split IDAT remains legal')
rejectsTexture(Buffer.concat([
  signature, header(), chunk('IDAT', idat.subarray(0, 3)), chunk('tEXt', Buffer.from('x\0y')),
  chunk('IDAT', idat.subarray(3)), end,
]), 'nonconsecutive IDAT')
assert.equal(pngInfo(png(Uint8Array.of(0, 1, 2, 3, 255)))?.width, 1)
console.log('PASS PNG integrity, legal color/depth/Adam7 and bounded decompression')

const base = createBossbar('simplified-test')
assert.equal(base.priority, 0)
assert.equal(upgradeBossbarV1({ format: 'hanshu.bossbar', version: 1, id: 'legacy' }).priority, 0)
assert.equal(upgradeBossbarV1({ format: 'hanshu.bossbar', version: 1, id: ' Legacy ' }).id, ' Legacy ', 'explicit migration preserves the original ID for diagnosis')
for (const priority of [-2147483648, 0, 2147483647]) {
  const parsed = parseBossbarDocument(JSON.stringify({ ...base, priority }))
  assert.equal(parsed.ok, true)
  if (parsed.ok) assert.equal(parsed.document.priority, priority)
}
for (const priority of [-2147483649, 2147483648, 0.5, null]) {
  const parsed = parseBossbarDocument(JSON.stringify({ ...base, priority }))
  assert.equal(parsed.ok, false)
  if (!parsed.ok) assert.ok(parsed.diagnostics.some((issue) => issue.path === 'priority'))
}
const omittedPriority = { ...base } as Partial<BossbarDocument>
delete omittedPriority.priority
const defaulted = parseBossbarDocument(JSON.stringify(omittedPriority))
assert.equal(defaulted.ok, true)
if (defaulted.ok) assert.equal(defaulted.document.priority, 0)

const withProgress = (progress: BossbarProgress): BossbarDocument => ({
  ...base,
  variables: { hp: { type: 'double', default: 0.25 }, counter: { type: 'long', default: '9007199254740993' } },
  components: [...base.components, {
    id: 'bar', type: 'bar', box: { x: 0, y: 0, width: 100, height: 10 },
    progress, direction: 'left-to-right', smoothMs: 0, visible: true, opacity: 1,
    fill: { kind: 'solid', color: '#FFFFFFFF' },
  }],
})
for (const [input, expected] of [[-Number.MAX_VALUE, 0], [-1, 0], [0, 0], [0.35, 0.35], [1, 1], [Number.MAX_VALUE, 1]]) {
  assert.equal(parseBossbarDocument(JSON.stringify(withProgress(input))).ok, true)
  assert.equal(clampProgress(input), expected)
}
const bound = withProgress({ var: 'hp' })
assert.equal(resolveProgress({ var: 'hp' }, bound.variables, {}), 0.25, 'missing runtime value uses declared default')
assert.equal(resolveProgress({ var: 'hp' }, bound.variables, { hp: { type: 'double', value: 2 } }), 1)
assert.equal(resolveProgress({ var: 'hp' }, bound.variables, { hp: { type: 'long', value: '1' } }), 0.25)
for (const reference of ['counter', 'missing']) {
  const result = parseBossbarDocument(JSON.stringify(withProgress({ var: reference })))
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.diagnostics.some((issue) => issue.path === 'components[1].progress.var'))
}
for (const input of [null, { type: 'double', value: 0.5 }, { var: 'hp', min: 0 }, '0.5']) {
  const result = parseBossbarDocument(JSON.stringify({ ...bound, components: [base.components[0], { ...bound.components[1], progress: input }] }))
  assert.equal(result.ok, false)
}
assert.equal(clampProgress(Infinity), 0)
const infiniteSource = JSON.stringify(withProgress(0.5)).replace('"progress":0.5', '"progress":1e400')
assert.equal(parseBossbarDocument(infiniteSource).ok, false)

const textDocument: BossbarDocument = {
  ...bound,
  variables: { ...bound.variables, label: { type: 'string', default: '服务端：1.2M（35.0%）', maxLength: 64 } },
  components: [...bound.components, {
    id: 'label', type: 'text', box: { x: 0, y: 12, width: 200, height: 20 },
    visible: true, opacity: 1, fontSize: 16, color: '#FFFFFFFF', align: 'left', verticalAlign: 'middle', shadow: false,
    runs: [{ var: 'label' }, { text: ' / ' }, { var: 'counter', color: '#FF0000FF' }],
  }],
}
const textResult = parseBossbarDocument(stringifyBossbar(textDocument))
assert.equal(textResult.ok, true)
if (textResult.ok) assert.deepEqual(textResult.document.variables.counter, { type: 'long', default: '9007199254740993' })
const undeclaredText = { ...textDocument, components: [...bound.components, { ...textDocument.components[2], runs: [{ var: 'toString' }] }] }
assert.equal(parseBossbarDocument(JSON.stringify(undeclaredText)).ok, false, 'prototype properties are not declared variables')
for (const value of ['-9223372036854775808', '9007199254740993', '9223372036854775807']) {
  assert.equal(formatRunValue(longValue(value)), value, 'long text retains every decimal digit')
}
assert.throws(() => longValue(9223372036854775808n))
assert.equal(formatRunValue({ type: 'double', value: 0.35 }), '0.35')
assert.equal(formatRunValue({ type: 'string', value: '1.2M（35.0%）' }), '1.2M（35.0%）')
assert.equal(formatRunValue({ type: 'bool', value: true }), 'true')
assert.equal(formatRunValue(undefined), null)
for (const field of ['format', 'digits', 'ratio']) {
  const legacy = { ...textDocument, components: [...bound.components, { ...textDocument.components[2], runs: [{ text: 'old', [field]: field === 'digits' ? 2 : {} }] }] }
  const result = parseBossbarDocument(JSON.stringify(legacy))
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.diagnostics.some((issue) => issue.code === 'obsolete_field' && issue.path === 'components[2].runs[0].' + field))
}
const legacyRange = { ...bound, components: [base.components[0], { ...bound.components[1], range: { value: 50, min: 0, max: 100 } }] }
const legacyResult = parseBossbarDocument(JSON.stringify(legacyRange))
assert.equal(legacyResult.ok, false)
if (!legacyResult.ok) assert.ok(legacyResult.diagnostics.some((issue) => issue.path === 'components[1].range'))
const legacyKey = { ...bound, variables: { hp: { type: 'double', default: 0, key: 'old_map_key' } } }
assert.equal(parseBossbarDocument(JSON.stringify(legacyKey)).ok, false)

const renamed = renameVariable(textDocument, 'hp', 'health')
assert.equal(renamed.ok, true)
if (renamed.ok) assert.equal(variableReferences(renamed.document, 'health')[0].role, 'progress')
assert.equal(renameVariable(textDocument, 'hp', 'toString').ok, true, 'valid variable names may shadow prototype names')
const removed = removeVariable(textDocument, 'counter', { long: '9007199254740993' })
assert.equal(removed.ok, true)
if (removed.ok) {
  const text = removed.document.components[2]
  assert.equal(text.type, 'text')
  if (text.type === 'text') assert.deepEqual(text.runs[2], { text: '9007199254740993', color: '#FF0000FF' })
}
const removedProgress = removeVariable(bound, 'hp', { double: 0.8 })
assert.equal(removedProgress.ok, true)
if (removedProgress.ok) {
  const bar = removedProgress.document.components[1]
  assert.equal(bar.type, 'bar')
  if (bar.type === 'bar') assert.equal(bar.progress, 0.8)
}
for (const count of [29, 64]) {
  const document = { ...base, variables: Object.fromEntries(
    Array.from({ length: count }, (_, i) => ['v' + i, { type: 'string' as const, default: '', maxLength: 256 }]),
  ) }
  const estimated = estimateSnapshotBytes(document).worstBytes
  const result = parseBossbarDocument(JSON.stringify(document))
  assert.equal(result.ok, estimated <= BOSSBAR_LIMITS.upsertBudgetBytes)
  if (!result.ok) assert.ok(result.diagnostics.some((issue) => issue.path === 'variables' && issue.code === 'budget'))
}
console.log('PASS int32 priority, direct progress, raw text, legacy-field rejection and snapshot budget')
