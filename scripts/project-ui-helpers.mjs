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
