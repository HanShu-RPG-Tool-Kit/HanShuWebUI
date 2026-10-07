/**
 * PAK 整包加密：AES-256-GCM。
 * 格式：magic(8) + salt(16) + iv(12) + ciphertext+tag
 */

const MAGIC = new TextEncoder().encode('HSPAK1\0\0') // 8 bytes
const SALT_LEN = 16
const IV_LEN = 12
const PBKDF2_ITERS = 120_000

function concat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(n)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** 拷成独立 ArrayBuffer，避开 TS 对 SharedArrayBuffer 的联合类型挑剔 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(ab).set(bytes)
  return ab
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: toArrayBuffer(salt),
      iterations: PBKDF2_ITERS,
      hash: 'SHA-256',
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export type Encryptor = {
  id: string
  encrypt(plain: Uint8Array, passphrase: string): Promise<Uint8Array>
}

export const aesGcmEncryptor: Encryptor = {
  id: 'aes-256-gcm',
  async encrypt(plain, passphrase) {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN))
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN))
    const key = await deriveKey(passphrase, salt)
    const cipher = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: toArrayBuffer(iv) },
        key,
        toArrayBuffer(plain),
      ),
    )
    return concat([MAGIC, salt, iv, cipher])
  },
}

export function isEncryptedPak(bytes: Uint8Array): boolean {
  if (bytes.length < MAGIC.length) return false
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) return false
  }
  return true
}

/** 引擎 / 测试用解密 */
export async function decryptPak(
  sealed: Uint8Array,
  passphrase: string,
): Promise<Uint8Array> {
  if (!isEncryptedPak(sealed)) {
    throw new Error('不是 HSPAK1 加密包')
  }
  let o = MAGIC.length
  const salt = sealed.subarray(o, o + SALT_LEN)
  o += SALT_LEN
  const iv = sealed.subarray(o, o + IV_LEN)
  o += IV_LEN
  const cipher = sealed.subarray(o)
  const key = await deriveKey(passphrase, salt)
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(cipher),
    ),
  )
}
