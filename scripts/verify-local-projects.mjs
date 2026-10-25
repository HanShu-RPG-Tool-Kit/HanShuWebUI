import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, access, rmdir } from 'node:fs/promises'
import { join, resolve, parse, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { harness } from './collaboration-harness.mjs'

const output = resolve('../output/local-project-opening')
await mkdir(output, { recursive: true })
const workspace = await mkdtemp(join(output, 'http-'))
const alpha = join(workspace, '工程甲'), beta = join(workspace, '工程乙'), removed = join(workspace, '将被删除')
for (const directory of [alpha, beta, removed]) await mkdir(directory)
await writeFile(join(alpha, 'project.json'), JSON.stringify({ version: 1, id: 'local-alpha', name: '工程甲' }))
const h = await harness({ root: join(workspace, 'default'), web: true, localProjects: true, origins: ['https://collab.example'] })
let checks = 0
const pass = name => { checks++; console.log(`通过：${name}`) }
async function call(base, token, path, method = 'GET', body, status = 200, headers = {}) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) })
  const value = await response.json().catch(() => null)
  assert.equal(response.status, status, `${method} ${path}: ${value?.message ?? response.status}`)
  return value
}
async function deniedHeaders(headers) {
  const status = await new Promise((resolve, reject) => {
    const request = httpRequest(h.base + '/api/local/bootstrap', { headers }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)) })
    request.on('error', reject); request.end()
  })
  assert.equal(status, 403)
}
try {
  const original = await h.login(h.credential, '原工程协作者')
  const bootstrap = await call(h.base, '', '/api/local/bootstrap')
  assert.equal(bootstrap.service, 'hanshu-local-projects')
  assert.ok(bootstrap.token && !JSON.stringify(bootstrap).includes(h.credential))
  const parent = bootstrap.roots.find(root => root.name === '工程所在目录')
  assert.ok(parent)
  const browse = (id = parent.id) => call(h.base, bootstrap.token, `/api/local/directories?directoryId=${encodeURIComponent(id)}`)
  const listing = await browse()
  for (const name of ['工程甲', '工程乙', '将被删除']) assert.ok(listing.entries.some(entry => entry.name === name))
  await assert.rejects(access(join(beta, '.hanshu')))
  pass('本机入口提供目录选择，浏览与取消不初始化候选工程，也不暴露管理者凭证')

  await call(h.base, '', `/api/local/directories?directoryId=${parent.id}`, 'GET', undefined, 401)
  await call(h.base, 'wrong', '/api/local/open', 'POST', { directoryId: parent.id, clientName: '测试' }, 401)
  await call(h.base, '', '/api/local/bootstrap', 'GET', undefined, 403, { Origin: 'https://collab.example' })
  await deniedHeaders({ Host: 'untrusted.example' })
  await deniedHeaders({ 'Sec-Fetch-Site': 'cross-site' })
  await call(h.base, bootstrap.token, '/api/local/open', 'POST', { path: alpha }, 422)
  await call(h.base, bootstrap.token, '/api/local/open', 'POST', { directoryId: randomUUID(), clientName: '测试' }, 404)
  await call(h.base, bootstrap.token, '/api/local/open', 'POST', { directoryId: parent.id, clientName: '' }, 400)
  await assert.rejects(access(join(beta, '.hanshu')))
  pass('目录能力与工程会话分离，拒绝错误令牌、非本机来源、伪造Host和客户端绝对路径')

  const alphaId = listing.entries.find(entry => entry.name === '工程甲').id
  const open = id => call(h.base, bootstrap.token, '/api/local/open', 'POST', { directoryId: id, clientName: '本机窗口' })
  const [a, again] = await Promise.all([open(alphaId), open(alphaId)])
  assert.equal(a.url, again.url); assert.notEqual(a.token, again.token)
  assert.equal(new URL(a.url).hostname, '127.0.0.1')
  assert.equal('credential' in a, false)
  const ownerKey = await readFile(join(alpha, '.hanshu/service/owner-key'), 'utf8')
  assert.ok(!JSON.stringify(a).includes(ownerKey.trim()))
  const login = { token: a.token }
  const snapshot = await call(a.url, login.token, '/api/project')
  assert.equal(snapshot.role, 'owner')
  assert.notEqual(snapshot.projectId, (await h.api(original.token, '/api/project')).projectId)
  assert.equal(JSON.parse(await readFile(join(alpha, 'project.json'), 'utf8')).id, 'local-alpha')
  await call(a.url, '', '/api/local/bootstrap', 'GET', undefined, 404)
  pass('并发打开同目录共用一个S并自动获得工程会话，工程S不继承宿主管理入口')

  const [lease] = await call(a.url, login.token, '/api/files/leases', 'POST', { paths: ['src/script/common/local.py'] })
  const receipt = await call(a.url, login.token, '/api/files/commit', 'POST', { transactionId: randomUUID(), changes: [{ op: 'write', path: 'src/script/common/local.py', version: null, leaseId: lease.id, content: Buffer.from('print("本机工程")\n').toString('base64'), destination: null, destinationVersion: null }] })
  assert.equal(receipt.status, 'committed')
  assert.equal(await readFile(join(alpha, 'src/script/common/local.py'), 'utf8'), 'print("本机工程")\n')
  await assert.rejects(access(join(h.root, 'src/script/common/local.py')))
  const b = await open(listing.entries.find(entry => entry.name === '工程乙').id)
  assert.notEqual(b.url, a.url)
  assert.equal((await call(a.url, login.token, '/api/project')).projectId, snapshot.projectId)
  assert.equal((await h.api(original.token, '/api/project')).session.clientName, '原工程协作者')
  assert.equal((await open(alphaId)).url, a.url)
  pass('实际写入只落到选中的目录，切换及重新打开不终止原工程的协作者')

  await rmdir(removed)
  await call(h.base, bootstrap.token, '/api/local/open', 'POST', { directoryId: listing.entries.find(entry => entry.name === '将被删除').id, clientName: '测试' }, 404)
  assert.equal((await call(a.url, login.token, '/api/project')).projectId, snapshot.projectId)
  pass('选择失效目录失败时已有工程会话继续可用')

  const webRoot = resolve('dist'), volume = parse(webRoot).root
  const drive = bootstrap.roots.find(root => resolve(root.path).toLowerCase() === volume.toLowerCase())
  assert.ok(drive)
  let directory = drive
  for (const name of relative(volume, webRoot).split(/[\\/]/).filter(Boolean)) {
    const children = await call(h.base, bootstrap.token, `/api/local/directories?directoryId=${directory.id}&filter=${encodeURIComponent(name)}`)
    directory = children.entries.find(child => child.name === name)
    assert.ok(directory, `Directory picker cannot navigate to ${name}`)
  }
  await call(h.base, bootstrap.token, '/api/local/open', 'POST', { directoryId: directory.id, clientName: '测试' }, 400)
  await assert.rejects(access(join(webRoot, '.hanshu')))
  pass('不能在静态网页目录内建立工程，避免工程凭证被静态服务发布')

  const binary = resolve('src-tauri/target/debug', process.platform === 'win32' ? 'project-server.exe' : 'project-server')
  const processResult = await new Promise((resolve, reject) => {
    const child = spawn(binary, ['--project', join(workspace, 'must-not-start'), '--listen', '0.0.0.0:0', '--local-projects', 'true'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk }); child.on('error', reject); child.on('exit', code => resolve({ code, stderr }))
  })
  assert.notEqual(processResult.code, 0)
  assert.match(processResult.stderr, /回环/)
  await assert.rejects(access(join(workspace, 'must-not-start')))
  pass('本机宿主拒绝监听LAN地址，启动失败不创建工程目录')
  await writeFile(join(output, 'http-acceptance.json'), JSON.stringify({ checks, workspace, physicalHosts: 1, passed: true }, null, 2))
  console.log(`本机工程 HTTP 验收 ${checks} 组通过。`)
} finally { await h.stop() }
