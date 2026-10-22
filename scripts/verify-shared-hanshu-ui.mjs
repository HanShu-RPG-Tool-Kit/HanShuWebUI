import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { harness } from './collaboration-harness.mjs'
import { until } from './progress-collaboration-helpers.mjs'
import { testAccount } from './test-accounts.mjs'

const output = resolve('../output/collaboration-ui')
await mkdir(output, { recursive: true })
const h = await harness(true)
let browser
try {
  const owner = await h.login(h.credential, '可视化验收')
  await h.commit(owner.token, [
    { op:'remove', path:'src/hanshu/story.hs' },
    { path: 'src/hanshu/未命名剧本.hs', content: '标题：分享测试\n\nnarrator:a1b2c3d4//\n\n' },
    { path: 'assets/zh_cn/lang_hs/未命名剧本.lang', content: JSON.stringify({ a1b2c3d4: '欢迎来到汉书' }) },
    { path: 'src/hanshu/原文剧本.hs', content: '标题：原文测试\n\nnarrator:共享原文自动本地化//\n\n' },
  ]); await h.release(owner.token)
  await h.api(owner.token, '/api/share/enable', 'POST')
  const share=await h.api(owner.token,'/api/share/status')
  const invitation={url:share.urls[0]}
  const author=await h.api(owner.token,'/api/subjects','POST',{name:'剧本协作者',kind:'account',role:'editor'})
  const authorAccount=testAccount(author.credential)
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []; page.on('pageerror', e => errors.push(e.message))
  await page.goto(invitation.url)
  await page.getByLabel('用户名', { exact: true }).fill(authorAccount.username)
  await page.getByLabel('密码',{exact:true}).fill(authorAccount.password)
  await page.getByRole('button', { name: '登录工程', exact: true }).click()
  await page.locator('.monaco-editor').first().waitFor()
  await until(async()=>await page.locator('.hs-lang-box').count()>0,'Initial .hs did not initialize')
  await page.locator('.app-workspace-pane.active').getByText('未命名剧本.hs', {exact:true}).first().dblclick()
  await page.screenshot({ path: join(output, 'shared-hanshu.png') })
  assert.deepEqual(errors, [])
  await until(async () => await page.getByText('欢迎来到汉书', { exact: true }).count() > 0, 'Shared .hs localization visualization is missing', 4000)
  for(let i=0;i<2;i++) {
    await page.getByRole('tab',{name:'进度流程',exact:true}).click()
    await page.getByRole('tab',{name:'剧本',exact:true}).click()
    await page.locator('.hs-lang-box').first().waitFor()
    assert.ok(await page.locator('.hs-lang-voice').count()>0,'Voice capsule missing after workspace activation')
  }
  await page.waitForTimeout(150)
  const box = await page.locator('.hs-lang-box').first().boundingBox()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  const input = page.locator('.hs-lang-edit-input')
  await input.waitFor({timeout:4000}).catch(async error => { await page.screenshot({path:join(output,'shared-hanshu-edit-failure.png')});console.log('readonly:',await page.locator('.monaco-editor textarea').evaluateAll(nodes=>nodes.map(node=>({readOnly:node.readOnly,aria:node.getAttribute('aria-readonly')}))));throw error })
  await input.fill('在分享页面编辑台词')
  await input.press('Enter')
  await page.keyboard.press('Control+s')
  await until(async () => JSON.parse(await readFile(join(h.root,'assets/zh_cn/lang_hs/未命名剧本.lang'),'utf8')).a1b2c3d4 === '在分享页面编辑台词', 'Inline .hs translation was not saved')
  console.log('通过：真实LAN邀请链接可显示、点击编辑并保存.hs台词')
  const observer=await h.api(owner.token,'/api/subjects','POST',{name:'剧本审阅者',kind:'account',role:'viewer'})
  const observerAccount=testAccount(observer.credential)
  const viewerInvite=invitation
  const viewer = await browser.newPage({viewport:{width:1440,height:1000}})
  await viewer.goto(viewerInvite.url)
  await viewer.getByLabel('用户名',{exact:true}).fill(observerAccount.username)
  await viewer.getByLabel('密码',{exact:true}).fill(observerAccount.password)
  await viewer.getByRole('button',{name:'登录工程',exact:true}).click()
  await viewer.locator('.monaco-editor').first().waitFor()
  await viewer.locator('.app-workspace-pane.active').getByText('未命名剧本.hs', {exact:true}).first().dblclick()
  await viewer.locator('.hs-lang-box').first().waitFor()
  const readonlyBox = await viewer.locator('.hs-lang-box').first().boundingBox()
  await viewer.mouse.click(readonlyBox.x + readonlyBox.width / 2, readonlyBox.y + readonlyBox.height / 2)
  await viewer.waitForTimeout(200)
  assert.equal(await viewer.locator('.hs-lang-edit-input').count(),0,'A read-only guest opened the translation editor')
  console.log('通过：工作区切换保留本地化框与配音胶囊，只读加入者不能打开写入覆盖框')
  await page.locator('.app-workspace-pane.active').getByText('原文剧本.hs', { exact: true }).first().click()
  await until(async () => await page.locator('.hs-lang-box').filter({hasText:'共享原文自动本地化'}).count() > 0, 'Literal .hs did not initialize its visual binding', 5000)
  assert.ok(await page.locator('.hs-lang-voice').count() > 0)
  await page.keyboard.press('Control+s')
  await until(async () => Object.values(JSON.parse(await readFile(join(h.root,'assets/zh_cn/lang_hs/原文剧本.lang'),'utf8').catch(()=>'{}'))).includes('共享原文自动本地化'), 'Literal translation did not save')
  console.log('通过：分享页面切换到原文剧本后正常生成本地化框与配音胶囊，语言与正文一起保存')
} finally { await browser?.close(); await h.stop() }
