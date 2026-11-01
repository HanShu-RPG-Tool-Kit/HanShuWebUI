/**
 * 生成 BossBar v2 的机器可校验 schema 与跨语言夹具。
 *
 * 只在**有意改变协议语义**时运行；生成的 JSON 必须随提交一起 review。
 * `npm run test:bossbar` 会比较磁盘上的冻结结果。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bossbarFixtureFile, bossbarSchemaFile } from '../src/workspaces/audiovisual/bossbar/spec/generate'

const here = dirname(fileURLToPath(import.meta.url))
const specDir = resolve(here, '../src/workspaces/audiovisual/bossbar/spec')

await mkdir(specDir, { recursive: true })
await writeFile(resolve(specDir, 'hanshu.bossbar.v2.schema.json'), bossbarSchemaFile())
await writeFile(resolve(specDir, 'bossbar-v2.fixtures.json'), bossbarFixtureFile())
console.log('已生成 BossBar v2 schema 与夹具：')
console.log('  src/workspaces/audiovisual/bossbar/spec/hanshu.bossbar.v2.schema.json')
console.log('  src/workspaces/audiovisual/bossbar/spec/bossbar-v2.fixtures.json')
