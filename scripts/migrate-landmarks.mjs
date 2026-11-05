/**
 * 一次性把旧地图数据改成地标协议。不挂进运行时加载器。
 *
 *   npm run migrate:landmarks -- <工程目录>
 *
 * 先扫完全部 .level：同时有 navigation 和 landmarks 就失败，并且不写任何文件。
 * 通过之后才改 .level、把 navigation_points/ 挪成 landmarks/、把带坐标的 .nav 改成 track。
 */
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const POS_TYPES = new Set(['rpgtoolkit:pos', 'position', 'pos', 'rpgtoolkit:position'])
const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'dist', '.gradle'])

export async function migrateLandmarks(root) {
  const abs = path.resolve(root)
  const info = await stat(abs).catch(() => null)
  if (!info?.isDirectory()) return fail(`不是目录：${abs}`)

  const levels = await collect(abs, (name) => name.toLowerCase().endsWith('.level'))
  const planned = []
  for (const file of levels) {
    const text = await readFile(file, 'utf8')
    let json
    try {
      json = JSON.parse(text)
    } catch (error) {
      return fail(`${rel(abs, file)}: 无法解析（${error instanceof Error ? error.message : error}），已中止且未写入`)
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      return fail(`${rel(abs, file)}: 地图模板必须是 JSON 对象，已中止且未写入`)
    }
    const hasNavigation = Object.prototype.hasOwnProperty.call(json, 'navigation')
    const hasLandmarks = Object.prototype.hasOwnProperty.call(json, 'landmarks')
    if (hasNavigation && hasLandmarks) {
      return fail(`${rel(abs, file)}: 同时存在 navigation 与 landmarks，已中止且未写入`)
    }
    if (hasNavigation) planned.push({ file, json })
  }

  const lines = []
  for (const item of planned) {
    const converted = convertNavigationList(item.json.navigation)
    lines.push(...converted.notes.map((note) => `${rel(abs, item.file)}: ${note}`))
    if (!converted.ok) continue
    const next = {}
    let placed = false
    for (const [key, value] of Object.entries(item.json)) {
      if (key === 'navigation') {
        next.landmarks = converted.landmarks
        placed = true
        continue
      }
      next[key] = value
    }
    if (!placed) next.landmarks = converted.landmarks
    await writeJson(item.file, next)
    lines.push(`${rel(abs, item.file)}: navigation → landmarks（${converted.landmarks.length}）`)
  }

  const exported = await collect(abs, (_name, full) => splitPath(full).includes('navigation_points'))
  for (const file of exported) {
    if (!file.toLowerCase().endsWith('.json')) continue
    const dest = relocate(abs, file)
    if (!dest) continue
    const where = rel(abs, file)
    let json
    try {
      json = JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      lines.push(`${where}: 无法解析，已跳过（${error instanceof Error ? error.message : error}）`)
      continue
    }
    const rewritten = rewriteExported(json)
    if (!rewritten.ok) {
      lines.push(`${where}: ${rewritten.reason}，已跳过`)
      continue
    }
    if (await exists(dest)) {
      lines.push(`${where}: 目标已存在 ${rel(abs, dest)}，已跳过`)
      continue
    }
    await mkdir(path.dirname(dest), { recursive: true })
    await writeJson(dest, rewritten.value)
    await unlink(file)
    lines.push(`${where} → ${rel(abs, dest)}`)
  }

  const navs = await collect(abs, (name) => name.toLowerCase().endsWith('.nav'))
  const levelById = new Map()
  for (const file of await collect(abs, (name) => name.toLowerCase().endsWith('.level'))) {
    levelById.set(path.basename(file, path.extname(file)), file)
  }
  for (const file of navs) {
    const where = rel(abs, file)
    let json
    try {
      json = JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      lines.push(`${where}: 无法解析，已跳过（${error instanceof Error ? error.message : error}）`)
      continue
    }
    const outcome = await rewriteNav(abs, file, json, levelById)
    if (outcome.note) lines.push(`${where}: ${outcome.note}`)
  }

  if (!lines.length) lines.push('没有需要迁移的 navigation、navigation_points 或带坐标的 .nav。')
  const reportPath = path.join(abs, 'migration-report.md')
  await writeFile(reportPath, `# 地标迁移\n\n${lines.map((line) => `- ${line}`).join('\n')}\n`, 'utf8')
  return { ok: true, reportPath, lines }
}

export function convertNavigationList(value) {
  if (!Array.isArray(value)) return { ok: false, landmarks: [], notes: ['navigation 不是数组，已跳过且未改写'] }
  const landmarks = []
  const notes = []
  for (const [index, entry] of value.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      notes.push(`navigation[${index}] 不是对象，已跳过`)
      continue
    }
    const type = typeof entry.type === 'string' ? entry.type : typeof entry.kind === 'string' ? entry.kind : ''
    if (type && !POS_TYPES.has(type)) {
      notes.push(`navigation[${index}] 无法映射的 kind：${type}，已跳过`)
      continue
    }
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (!partOk(id)) {
      notes.push(`navigation[${index}] 缺少合法 id，已跳过`)
      continue
    }
    const param = readParam(entry)
    if (!param) {
      notes.push(`navigation[${index}] ${id} 缺少坐标，已跳过`)
      continue
    }
    landmarks.push(landmark(id, param, entry.custom_data))
  }
  return { ok: true, landmarks, notes }
}

function rewriteExported(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: '不是 JSON 对象' }
  const type = typeof raw.type === 'string' ? raw.type : typeof raw.kind === 'string' ? raw.kind : ''
  if (type && !POS_TYPES.has(type)) return { ok: false, reason: `无法映射的 kind：${type}` }
  const param = readParam(raw)
  if (!param) return { ok: false, reason: '缺少坐标' }
  const rest = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'type' || key === 'kind' || key === 'param' || key === 'x' || key === 'y' || key === 'z') continue
    rest[key] = value
  }
  const ordered = {}
  if ('level' in rest) ordered.level = rest.level
  ordered.kind = 'rpgtoolkit:pos'
  ordered.param = param
  for (const [key, value] of Object.entries(rest)) {
    if (key === 'level') continue
    ordered[key] = value
  }
  return { ok: true, value: ordered }
}

async function rewriteNav(root, file, json, levelById) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { note: '不是 JSON 对象，已跳过' }
  const coord = ['type', 'param', 'custom_data', 'x', 'y', 'z'].some((key) => key in json)
  if (!coord) return { note: '' }
  if ('track' in json) return { note: '同时有 track 和坐标，已跳过' }
  const level = typeof json.level === 'string' ? json.level.trim() : ''
  if (!level) return { note: '缺少 level，已跳过' }
  const id = path.basename(file, path.extname(file))
  if (!partOk(id)) return { note: `文件名不能当地标 id：${id}，已跳过` }
  const type = typeof json.type === 'string' ? json.type : ''
  if (type && !POS_TYPES.has(type)) return { note: `无法映射的 kind：${type}，已跳过` }
  const param = readParam(json)
  if (!param) return { note: '缺少坐标，已跳过' }
  const levelFile = levelById.get(level)
  if (!levelFile) return { note: `找不到模板 ${level}.level，已跳过` }
  let levelJson
  try {
    levelJson = JSON.parse(await readFile(levelFile, 'utf8'))
  } catch (error) {
    return { note: `模板无法解析（${error instanceof Error ? error.message : error}），已跳过` }
  }
  if (!levelJson || typeof levelJson !== 'object' || Array.isArray(levelJson)) return { note: '模板不是对象，已跳过' }
  if ('navigation' in levelJson) return { note: '模板仍有 navigation，已跳过' }
  const landmarks = Array.isArray(levelJson.landmarks) ? levelJson.landmarks : []
  const exists = landmarks.some((point) => point && point.id === id)
  if (!exists) {
    levelJson.landmarks = [...landmarks, landmark(id, param, json.custom_data)]
    await writeJson(levelFile, levelJson)
  }
  await writeJson(file, { id, level, track: { type: 'landmark', ref: `${level}$${id}` } })
  return { note: exists ? `已有地标 ${id}，只改 track.ref` : `坐标写入地标 ${level}$${id}，并改成 track` }
}

function landmark(id, param, custom) {
  const point = { id, kind: 'rpgtoolkit:pos', param }
  if (custom && typeof custom === 'object' && !Array.isArray(custom) && Object.keys(custom).length) point.custom_data = custom
  return point
}

function readParam(entry) {
  const param = entry.param
  if (param && typeof param === 'object' && !Array.isArray(param) && isNum(param.x) && isNum(param.y) && isNum(param.z)) {
    return { x: param.x, y: param.y, z: param.z }
  }
  if (isNum(entry.x) && isNum(entry.y) && isNum(entry.z)) return { x: entry.x, y: entry.y, z: entry.z }
  return null
}

function isNum(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function partOk(part) {
  return typeof part === 'string' && part.length > 0 && part.length <= 64 && part !== '.' && part !== '..' && !/[$\\/:*?"<>|\u0000-\u001f]/.test(part)
}

function relocate(root, file) {
  const parts = splitPath(path.relative(root, file))
  const index = parts.indexOf('navigation_points')
  if (index < 0) return null
  parts[index] = 'landmarks'
  return path.join(root, ...parts)
}

function splitPath(file) {
  return file.split(/[\\/]/)
}

async function collect(root, predicate) {
  const out = []
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (predicate(entry.name, full)) out.push(full)
    }
  }
  await walk(root)
  return out
}

async function exists(file) {
  return !!(await stat(file).catch(() => null))
}

function writeJson(file, value) {
  return writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function rel(root, file) {
  return path.relative(root, file).split(path.sep).join('/')
}

function fail(line) {
  return { ok: false, reportPath: null, lines: [line] }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  const dir = process.argv[2]
  if (!dir) {
    console.error('用法: npm run migrate:landmarks -- <工程目录>')
    process.exit(2)
  }
  const result = await migrateLandmarks(dir)
  for (const line of result.lines) console.log(line)
  if (!result.ok) process.exit(1)
}
