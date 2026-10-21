import assert from 'node:assert/strict'
import { createHash, randomBytes, randomFillSync } from 'node:crypto'
import { randomId, sha256Fallback, sha256Hex } from '../src/project/crypto'

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const encode = (text: string) => new TextEncoder().encode(text)
const samples = [
  encode(''), encode('abc'), encode('HanShu 进度流程 🌏'),
  encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
  ...[1,2,3,7,31,55,56,57,63,64,65,119,120,127,128,129,255,256,1023,1024,4096,65535,65536]
    .map(length => new Uint8Array(randomBytes(length))),
  encode('a'.repeat(1_000_000)),
]
for (const bytes of samples) {
  assert.equal(sha256Fallback(bytes),digest(bytes),`SHA-256 fallback length=${bytes.length}`)
  assert.equal(await sha256Hex(bytes),digest(bytes),`SHA-256 native length=${bytes.length}`)
}

const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
let randomCalls = 0
try {
  // Ordinary LAN HTTP has getRandomValues but no SubtleCrypto or randomUUID.
  Object.defineProperty(globalThis,'crypto',{configurable:true,value:{
    getRandomValues(bytes: Uint8Array) { randomCalls++; randomFillSync(bytes); return bytes },
  }})
  for (const bytes of samples) assert.equal(await sha256Hex(bytes),digest(bytes),`LAN HTTP hash length=${bytes.length}`)
  const ids = new Set<string>()
  for (let i=0;i<1000;i++) {
    const id = randomId()
    assert.match(id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
    ids.add(id)
  }
  assert.equal(ids.size,1000)
  assert.equal(randomCalls,1000)
} finally {
  if (original) Object.defineProperty(globalThis,'crypto',original)
  else Reflect.deleteProperty(globalThis,'crypto')
}
console.log(`工程加密工具验证完成：${samples.length} 组 SHA-256 标准/边界/随机载荷，原生及 LAN HTTP 回退一致；1,000 个 UUID 使用 getRandomValues。`)
