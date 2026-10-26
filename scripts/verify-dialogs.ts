import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const bundle = await build({
  stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { DialogHost } from './src/ui/dialogs/DialogHost';
    import * as dialogs from './src/ui/dialogs/dialogStore';
    window.dialogs = dialogs;
    window.results = [];
    createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null, React.createElement(DialogHost)));
  `, resolveDir: process.cwd(), loader: 'tsx' },
  bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' },
})
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) })
try {
  const page = await browser.newPage()
  await page.setContent('<button id="origin">Open</button><div id="root"></div><div id="already-inert" inert></div>')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.locator('#origin').focus()
  await page.evaluate(() => {
    const w = window as any
    w.dialogs.confirmDialog('First').then((value: unknown) => w.results.push(value))
    w.dialogs.promptDialog({ title: 'Second', defaultValue: '中文', validate: (value: string) => value ? null : 'Required' }).then((value: unknown) => w.results.push(value))
  })
  await page.getByRole('dialog', { name: '确认' }).waitFor()
  assert.equal(await page.locator('#origin').evaluate((el: HTMLElement) => el.inert), true)
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), '确认')
  await page.keyboard.press('Tab')
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), '取消')
  await page.keyboard.press('Shift+Tab')
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), '确认')
  await page.keyboard.press('Enter')
  const prompt = page.getByRole('dialog', { name: 'Second' })
  await prompt.waitFor()
  assert.equal(await prompt.locator('input').evaluate(el => el === document.activeElement), true)
  await prompt.locator('input').dispatchEvent('keydown', { key: 'Enter', isComposing: true })
  assert.equal(await prompt.count(), 1, 'IME confirmation must not submit the dialog')
  await prompt.locator('input').fill('')
  await page.keyboard.press('Enter')
  await prompt.getByText('Required').waitFor()
  await page.keyboard.press('Escape')
  await prompt.waitFor({ state: 'detached' })
  assert.deepEqual(await page.evaluate(() => (window as any).results), [true, null])
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'origin')
  assert.equal(await page.locator('#origin').evaluate((el: HTMLElement) => el.inert), false)
  assert.equal(await page.locator('#already-inert').evaluate((el: HTMLElement) => el.inert), true)
  await page.evaluate(() => {
    const w = window as any
    w.dialogs.chooseDialog({ options: [{ id: 'disabled', label: 'Disabled', disabled: true }, { id: 'enabled', label: 'Enabled' }], filterable: false }).then((value: unknown) => w.results.push(value))
  })
  await page.getByRole('dialog').waitFor()
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Enabled')
  await page.keyboard.press('Enter')
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  assert.deepEqual(await page.evaluate(() => (window as any).results), [true, null, 'enabled'])
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'origin')
  console.log('通过：StrictMode 队列、焦点循环/恢复、模态 inert 恢复、输入验证、IME、禁用选择项')
} finally {
  await browser.close()
}
