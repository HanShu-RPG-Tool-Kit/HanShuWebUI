import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { deflateSync } from 'node:zlib'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BOSSBAR_TEXTURE_CACHE_BYTES,
  clearTextureCache,
  loadBossbarTexture,
  peekTexture,
  releaseBossbarTexture,
} from '../src/workspaces/audiovisual/bossbar/render/texture'
import { pngInfo } from '../src/workspaces/audiovisual/bossbar/png'

class TestBitmap {
  closed = false
  constructor(public width: number, public height: number) {}
  close() { this.closed = true }
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  }
  return (value ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type)
  const size = Buffer.alloc(4)
  const crc = Buffer.alloc(4)
  size.writeUInt32BE(data.length)
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([size, name, data, crc])
}

function png(width: number, height: number, red: number, padding = ''): string {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  const scan = Buffer.alloc((width * 4 + 1) * height, 255)
  for (let row = 0; row < height; row += 1) scan[row * (width * 4 + 1)] = 0
  scan[1] = red
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    ...(padding ? [chunk('tEXt', Buffer.from('padding\0' + padding))] : []),
    chunk('IDAT', deflateSync(scan, { level: width === 128 ? 0 : 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64')
}

function addMetadata(source: string, value: string): string {
  const bytes = Buffer.from(source, 'base64')
  return Buffer.concat([bytes.subarray(0, 33), chunk('tEXt', Buffer.from('label\0' + value)), bytes.subarray(33)]).toString('base64')
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const originalBitmap = globalThis.ImageBitmap
const originalDecode = globalThis.createImageBitmap
const originalImage = globalThis.Image
let decodeCalls = 0
let decoder = async (width: number, height: number): Promise<TestBitmap> => new TestBitmap(width, height)
globalThis.ImageBitmap = TestBitmap as unknown as typeof ImageBitmap
globalThis.createImageBitmap = (async (blob: Blob) => {
  decodeCalls += 1
  const info = pngInfo(new Uint8Array(await blob.arrayBuffer()))
  assert.ok(info)
  return decoder(info.width, info.height)
}) as unknown as typeof createImageBitmap

const bitmap = (entry: Awaited<ReturnType<typeof loadBossbarTexture>>) => {
  assert.ok(entry)
  return entry.image as unknown as TestBitmap
}
const flush = () => new Promise<void>((done) => setImmediate(done))

try {
  // These two real PNGs collided under the previous sampled fingerprint.
  const sourceA = png(128, 128, 1, 'a')
  const sourceB = png(128, 128, 2, 'a')
  const imageA = await loadBossbarTexture(sourceA)
  const imageB = await loadBossbarTexture(sourceB)
  assert.ok(imageA && imageB)
  assert.notEqual(imageA, imageB, 'different complete PNG contents must not share a cache entry')
  assert.equal(imageB.base64, sourceB)
  releaseBossbarTexture(imageA)
  releaseBossbarTexture(imageB)
  clearTextureCache()

  const pending = deferred<TestBitmap>()
  decoder = () => pending.promise
  const small = png(1, 1, 7)
  const before = decodeCalls
  const first = loadBossbarTexture(small)
  const second = loadBossbarTexture(small)
  await flush()
  assert.equal(decodeCalls - before, 1, 'concurrent callers decode the same source once')
  pending.resolve(new TestBitmap(1, 1))
  const [sharedA, sharedB] = await Promise.all([first, second])
  assert.ok(sharedA && sharedB)
  assert.equal(sharedA, sharedB)
  clearTextureCache()
  releaseBossbarTexture(sharedA)
  assert.equal(bitmap(sharedB).closed, false, 'clearing the cache must preserve a second active reference')
  releaseBossbarTexture(sharedB)
  assert.equal(bitmap(sharedB).closed, true, 'the last release disposes an entry cleared while active')

  decoder = async (width, height) => new TestBitmap(width, height)
  const active = []
  for (let index = 0; index < 8; index += 1) {
    const entry = await loadBossbarTexture(png(1, 1, index + 10))
    assert.ok(entry)
    active.push(entry)
  }
  assert.ok(active.every((entry) => !bitmap(entry).closed), 'eight active atlases must all remain usable')
  active.forEach(releaseBossbarTexture)
  clearTextureCache()
  assert.ok(active.every((entry) => bitmap(entry).closed))

  assert.equal(BOSSBAR_TEXTURE_CACHE_BYTES, 128 * 1024 * 1024)
  const large = png(4096, 4096, 30)
  const largeOther = addMetadata(large, 'second')
  const nextSource = png(1, 1, 31)
  const holdLarge = deferred<TestBitmap>()
  decoder = async (width, height) => {
    await holdLarge.promise
    return new TestBitmap(width, height)
  }
  const largeLoadA = loadBossbarTexture(large)
  const largeLoadB = loadBossbarTexture(largeOther)
  await assert.rejects(loadBossbarTexture(nextSource), /128 MiB/, 'in-flight decodes must reserve their memory')
  await flush()
  holdLarge.resolve(new TestBitmap(4096, 4096))
  const [largeA, largeB] = await Promise.all([largeLoadA, largeLoadB])
  assert.ok(largeA && largeB)
  assert.equal(bitmap(largeA).closed, false)
  await assert.rejects(loadBossbarTexture(nextSource), /128 MiB/, 'active atlases cannot be evicted to admit another one')
  releaseBossbarTexture(largeA)
  decoder = async (width, height) => new TestBitmap(width, height)
  const admitted = await loadBossbarTexture(nextSource)
  assert.ok(admitted)
  assert.equal(bitmap(largeA).closed, true, 'idle atlases are evicted when the byte budget requires space')
  assert.equal(bitmap(largeB).closed, false, 'budget eviction preserves another live atlas')
  assert.equal(peekTexture(large), null)
  releaseBossbarTexture(largeB)
  releaseBossbarTexture(admitted)
  clearTextureCache()
  console.log('通过：完整内容身份、并发去重、活跃引用与 128 MiB 解码预算')

  type Effect = { deps: unknown[]; cleanup?: () => void }
  function hooks() {
    const values: unknown[] = []
    const effects = new Map<number, Effect>()
    let cursor = 0
    let mounted = true
    let updatesAfterUnmount = 0
    let pendingEffects: { index: number; body: () => (() => void) | void; deps: unknown[] }[] = []
    return {
      useState(initial: unknown) {
        const index = cursor++
        if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial
        return [values[index], (next: unknown) => {
          if (!mounted) updatesAfterUnmount += 1
          values[index] = typeof next === 'function' ? next(values[index]) : next
        }]
      },
      useRef(initial: unknown) {
        const index = cursor++
        if (!(index in values)) values[index] = { current: initial }
        return values[index]
      },
      useMemo(body: () => unknown) { cursor += 1; return body() },
      useEffect(body: () => (() => void) | void, deps: unknown[]) {
        const index = cursor++
        const previous = effects.get(index)
        if (!previous || deps.some((value, key) => !Object.is(value, previous.deps[key]))) pendingEffects.push({ index, body, deps })
      },
      render<T>(body: () => T): T { cursor = 0; return body() },
      commit() {
        for (const { index, body, deps } of pendingEffects) {
          effects.get(index)?.cleanup?.()
          const cleanup = body()
          effects.set(index, { deps, cleanup: cleanup || undefined })
        }
        pendingEffects = []
      },
      unmount() { mounted = false; for (const effect of effects.values()) effect.cleanup?.(); effects.clear() },
      get updatesAfterUnmount() { return updatesAfterUnmount },
    }
  }
  type Runtime = ReturnType<typeof hooks>
  const globals = globalThis as typeof globalThis & {
    __bossbarHooks: Runtime
    __bossbarTextures: object
    __bossbarAsset: (...args: unknown[]) => unknown
  }
  globals.__bossbarTextures = { loadBossbarTexture, releaseBossbarTexture, textureSizeOf: () => ({ width: 1, height: 1 }) }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const bundled = await build({
    entryPoints: [resolve(root, 'src/workspaces/audiovisual/bossbar/editor/useBossbarImages.ts')],
    bundle: true, platform: 'node', format: 'cjs', write: false,
    plugins: [{ name: 'controlled-hooks', setup(builder) {
      builder.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'test' }))
      builder.onResolve({ filter: /render\/texture$/ }, () => ({ path: 'texture', namespace: 'test' }))
      builder.onResolve({ filter: /assets\/idb$/ }, () => ({ path: 'asset', namespace: 'test' }))
      builder.onLoad({ filter: /.*/, namespace: 'test' }, ({ path }) => ({ loader: 'js', contents:
        path === 'react'
          ? ['useState', 'useRef', 'useMemo', 'useEffect'].map((name) => `export const ${name}=(...args)=>globalThis.__bossbarHooks.${name}(...args);`).join('\n')
          : path === 'texture'
            ? 'export const {loadBossbarTexture,releaseBossbarTexture,textureSizeOf}=globalThis.__bossbarTextures'
            : 'export const getAssetBlob=(...args)=>globalThis.__bossbarAsset(...args)',
      }))
    } }],
  })
  const module = { exports: {} as {
    useBossbarTexture: typeof import('../src/workspaces/audiovisual/bossbar/editor/useBossbarImages').useBossbarTexture
    useReferenceImage: typeof import('../src/workspaces/audiovisual/bossbar/editor/useBossbarImages').useReferenceImage
  } }
  new Function('module', 'exports', bundled.outputFiles[0].text)(module, module.exports)

  const cachedSource = png(1, 1, 80)
  const cached = await loadBossbarTexture(cachedSource)
  assert.ok(cached)
  releaseBossbarTexture(cached)
  const slow = deferred<TestBitmap>()
  decoder = () => slow.promise
  const runtime = hooks()
  globals.__bossbarHooks = runtime
  runtime.render(() => module.exports.useBossbarTexture(png(1, 1, 81), 'project:document'))
  runtime.commit()
  const beforeCachedEffect = runtime.render(() => module.exports.useBossbarTexture(cachedSource, 'project:document'))
  assert.equal(beforeCachedEffect.image, null, 'a changed source must hide the previous frame immediately')
  runtime.commit()
  await flush()
  assert.equal(runtime.render(() => module.exports.useBossbarTexture(cachedSource, 'project:document')).image, cached.image)
  slow.resolve(new TestBitmap(1, 1))
  await flush()
  assert.equal(runtime.render(() => module.exports.useBossbarTexture(cachedSource, 'project:document')).image, cached.image, 'a slow stale decode cannot overwrite a cached selection')
  assert.equal(runtime.render(() => module.exports.useBossbarTexture(cachedSource, 'other-project:document')).image, null, 'switching project/document hides the previous image before effects')
  runtime.commit()
  await flush()
  runtime.unmount()
  clearTextureCache()
  assert.equal(bitmap(cached).closed, true, 'unmount releases the active texture')

  const unmountedDecode = deferred<TestBitmap>()
  decoder = () => unmountedDecode.promise
  const unmounted = hooks()
  globals.__bossbarHooks = unmounted
  unmounted.render(() => module.exports.useBossbarTexture(png(1, 1, 82), 'project:document'))
  unmounted.commit()
  unmounted.unmount()
  unmountedDecode.resolve(new TestBitmap(1, 1))
  await flush()
  assert.equal(unmounted.updatesAfterUnmount, 0)
  clearTextureCache()
  console.log('通过：慢解码后命中缓存、切换工程/文档、卸载与过期引用释放')

  class ReferenceImage {
    src = ''
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
  }
  const referenceImages: ReferenceImage[] = []
  globalThis.Image = class extends ReferenceImage {
    constructor() { super(); referenceImages.push(this) }
  } as unknown as typeof Image
  const assetA = deferred<Blob>()
  const assetB = deferred<Blob>()
  const assets = [assetA, assetB]
  globals.__bossbarAsset = () => assets.shift()!.promise
  const references = hooks()
  globals.__bossbarHooks = references
  references.render(() => module.exports.useReferenceImage('project', 'assets/reference.png', 'doc-a'))
  references.commit()
  references.render(() => module.exports.useReferenceImage('project', 'assets/reference.png', 'doc-b'))
  references.commit()
  assetB.resolve(new Blob(['b']))
  await flush()
  assert.equal(referenceImages.length, 1)
  referenceImages[0].onload?.()
  assert.equal(references.render(() => module.exports.useReferenceImage('project', 'assets/reference.png', 'doc-b')), referenceImages[0])
  assetA.resolve(new Blob(['a']))
  await flush()
  assert.equal(referenceImages.length, 1, 'an old document asset read never starts an image load')
  assert.equal(references.render(() => module.exports.useReferenceImage('other-project', 'assets/reference.png', 'doc-b')), null)
  references.unmount()
  assert.equal(referenceImages[0].src, '')
  assert.equal(referenceImages[0].onload, null)
  delete (globals as Partial<typeof globals>).__bossbarHooks
  delete (globals as Partial<typeof globals>).__bossbarTextures
  delete (globals as Partial<typeof globals>).__bossbarAsset
  console.log('通过：参考底图的过期工程/文档请求失效与卸载清理')
  console.log('PASS verify-bossbar-textures')
} finally {
  clearTextureCache()
  globalThis.ImageBitmap = originalBitmap
  globalThis.createImageBitmap = originalDecode
  globalThis.Image = originalImage
}
