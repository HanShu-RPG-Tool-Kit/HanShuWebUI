/**
 * `multipart/form-data` 请求体的构造。
 *
 * 克隆要上传音频,ElevenLabs 与 MiniMax 都是 multipart。而传输层只发
 * `string | Uint8Array` —— **这是刻意的**:传输不认识 multipart,才不会为了某一个
 * 端点长出特例。所以在这里把字节拼好,传出去仍然是一个普通的请求体。
 */

import { concatBytes, encodeText } from './transport'

export type MultipartField =
  | { name: string; value: string }
  | { name: string; filename: string; contentType: string; bytes: Uint8Array }

export type MultipartBody = {
  body: Uint8Array
  /** 带 boundary 的完整 content-type，直接塞进请求头 */
  contentType: string
}

/**
 * 分隔串。
 *
 * **不扫描内容找冲突**:128 位随机值撞上文件内容的概率可以忽略,
 * 而为了绝对安全去扫整份音频是 O(样本大小) 的白费功夫。这也是各家客户端库的通行做法。
 * 允许注入 boundary 只为了让测试可复现。
 */
function defaultBoundary(): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '')
      : `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  return `----hanshu${random}`
}

/** 引号与反斜杠会破坏 `Content-Disposition` 头，换成下划线 */
function sanitize(value: string): string {
  return value.replace(/["\\\r\n]/g, '_')
}

export function buildMultipart(
  fields: readonly MultipartField[],
  boundary: string = defaultBoundary(),
): MultipartBody {
  const parts: Uint8Array[] = []

  for (const field of fields) {
    const head =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${sanitize(field.name)}"` +
      ('filename' in field ? `; filename="${sanitize(field.filename)}"\r\n` : '\r\n') +
      ('contentType' in field ? `Content-Type: ${field.contentType}\r\n` : '') +
      '\r\n'
    parts.push(encodeText(head))
    parts.push('value' in field ? encodeText(field.value) : field.bytes)
    parts.push(encodeText('\r\n'))
  }

  parts.push(encodeText(`--${boundary}--\r\n`))

  return {
    body: concatBytes(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

/**
 * 上传时用的文件名：**只用 ASCII**。
 *
 * 样本路径可能是中文(`assets/voice-samples/林晚/ja_jp/01.wav`),而 multipart 头里
 * 放非 ASCII 文件名要额外做 RFC 5987 编码,各家服务端解析得也不一致。
 * 服务端并不关心文件叫什么,所以直接按序号给名下扩展名 —— 省掉一整类编码问题。
 */
export function uploadFileName(path: string, index: number): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path.trim())?.[1]?.toLowerCase() ?? 'wav'
  return `sample-${index + 1}.${ext}`
}
