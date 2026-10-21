import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
async function files(dir) { const out=[];for(const e of await readdir(dir,{withFileTypes:true})){const path=join(dir,e.name);if(e.isDirectory())out.push(...await files(path));else if(/\.(ts|tsx)$/.test(path))out.push(path)}return out }
for(const path of await files('src')) {
  const source=await readFile(path,'utf8')
  assert.ok(!/\.createWritable\s*\(|\.removeEntry\s*\(|showDirectoryPicker\s*\(/.test(source),`C acquired direct project filesystem mutation: ${path}`)
  assert.ok(!/invoke[^\n]*['"]skin_(?:save|delete|patch|rename|create|write|import_file)/.test(source),`Project mutation bypasses S through skin IPC: ${path}`)
}
const host=await readFile('src-tauri/src/lib.rs','utf8')
assert.ok(!/skin::commands::skin_(?!net_)/.test(host),'Native skin mutation bypass is registered')
const permissions=await readFile('src-tauri/src/webview_perms.rs','utf8')
assert.ok(!permissions.includes('PERMISSION_STATE_ALLOW'),'WebView still auto-grants project file write permission')
console.log('通过：C 无直接工程文件系统写入入口、无皮肤写入 IPC 旁路、宿主不自动授予文件系统写权限。')
