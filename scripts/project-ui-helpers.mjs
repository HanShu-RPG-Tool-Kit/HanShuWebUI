import {testAccount} from './test-accounts.mjs'
export async function loginProject(page,base,key,name,navigate=true) {
  await page.addInitScript(value=>sessionStorage.setItem('hanshu.windowName',value),name)
  if(navigate)await page.goto(base)
  const account=testAccount(key)
  if(!account.local) {
    const probe=await page.request.get(base+'/api/share/info')
    const info=probe.ok()?await probe.json():null
    if(info?.authentication==='password') {
      const form=page.getByRole('form',{name:'登录共享工程',exact:true})
      await form.getByLabel('用户名',{exact:true}).fill(account.username);await form.getByLabel('密码',{exact:true}).fill(account.password)
      const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/sessions'&&r.request().method()==='POST')
      await form.getByRole('button',{name:'登录工程',exact:true}).click();const result=await(await response).json();await waitProject(page,'统一工程验收');return result
    }
  }
  if(account.local){
    await projectMenu(page,'打开工程…');await page.getByRole('button',{name:'打开本机工程…',exact:true}).click();await page.getByRole('button',{name:'默认工程',exact:true}).click()
    const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/local/open'&&r.request().method()==='POST')
    await page.getByRole('button',{name:'打开此文件夹',exact:true}).click();const result=await(await response).json();await waitProject(page,'统一工程验收');return result
  }
  const form=page.getByRole('form',{name:'连接其他服务器',exact:true})
  // Refresh restores the connection form automatically; don't click through its backdrop.
  if(!navigate)await form.waitFor({state:'visible',timeout:2500}).catch(()=>{})
  if(!await form.isVisible())await projectMenu(page,'连接其他服务器…')
  await form.getByLabel('服务地址',{exact:true}).fill(base);await form.getByLabel('用户名',{exact:true}).fill(account.username);await form.getByLabel('密码',{exact:true}).fill(account.password)
  const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/sessions'&&r.request().method()==='POST')
  await form.getByRole('button',{name:'连接并打开工程',exact:true}).click();const result=await(await response).json();await waitProject(page,'统一工程验收');return result
}
export async function projectMenu(page, item) {
  await page.getByRole('button', {name:'文件',exact:true}).click()
  await page.getByRole('menuitem', {name:item,exact:true}).click()
}
export async function waitProject(page, name) {
  await page.locator(`.collab-widget[data-project-name=${JSON.stringify(name)}]`).waitFor()
}
export async function collaboration(page, tab = '成员') {
  const panel = page.getByRole('region', {name:'协作面板',exact:true})
  if (!await panel.count()) await page.getByRole('button', {name:'打开协作面板',exact:true}).click()
  await panel.getByRole('button', {name:new RegExp(`^${tab}`)}).click()
  return panel
}
export async function closeCollaboration(page) {
  const close = page.getByRole('button', {name:'收起协作面板',exact:true})
  if (await close.count()) await close.click()
}
export async function submission(page) {
  await collaboration(page, '修改')
  return page.getByRole('region', {name:'工程提交状态',exact:true})
}
