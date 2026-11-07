// Optional real DSH integration test; never print the private launch URL.
import { readFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
const launchUrl = readFileSync(process.env.SUPERAGENT_TEST_AUTH_FILE ?? '.private/browser-launch-url', 'utf8').trim()
const origin = new URL(launchUrl).origin
const browser = await chromium.launch({ executablePath: process.env.SUPERAGENT_TEST_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
page.on('pageerror', e => errors.push(e.message.replace(/https?:\/\/\S+/g, '<URL>')))
page.on('console', msg => { if (msg.type() === 'error') console.error('GUI console: ' + msg.text().replace(/https?:\/\/\S+/g, '<URL>').slice(0, 600)) })
await page.addLocatorHandler(page.getByText('预览版说明', { exact: true }), async () => {
  await page.getByRole('button', { name: '继续', exact: true }).click()
})
try {
  try { await page.goto(launchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }) }
  catch { throw new Error('Could not authenticate the test browser') }
  const icon = page.locator('[data-dsh-panel-entry="dsh-superagent-board"]')
  await icon.waitFor({ timeout: 30000 }); await icon.click()
  await page.locator('.sab-composer textarea').waitFor()
  const inbox = await page.waitForResponse(r => r.url().endsWith('/@superagent-board/api/chat') && r.status() === 200, { timeout: 15000 })
  assert.ok(Array.isArray((await inbox.json()).messages))
  assert.equal(await page.locator('.sab-grid').count(), 0, 'There must not be a standalone kanban')
  console.log('PASS: dedicated real Superagent chat; no second kanban')
  const anonymous = await browser.newContext()
  const denied = await anonymous.request.get(origin + '/@superagent-board/api/chat', { headers: { 'x-superagent-board': '1', origin, cookie: 'dsh-auth-forged=invalid' } })
  assert.equal(denied.status(), 401); await anonymous.close()
  console.log('PASS: real host authentication refuses forged cookies')

  await page.getByRole('button', { name: '打开任务看板', exact: true }).click()
  const native = page.locator('[data-dsh-taskboard-view]')
  await native.waitFor({ timeout: 15000 })
  const state = await page.request.get(origin + '/api/task-board/state', { headers: { origin } })
  assert.equal(state.status(), 200)
  const board = await state.json()
  const owned = board.tasks.filter(t => t.integrations?.superagent?.managed)
  assert.ok(owned.length > 0, 'The original ledger must contain real Superagent cards')
  await page.locator('[data-superagent-external="true"]').first().waitFor()
  console.log('PASS: existing task-board UI displays ' + owned.length + ' linked Superagent cards')
  if (process.env.SUPERAGENT_TEST_GUARD === '1') {
    const target = owned.find(t => t.title.includes('客户端入口端到端'))
    assert.ok(target, 'Run-guard test fixture not found')
    const executionCount = target.executions.length
    const runningSessions = board.power.runningSessions
    const result = await page.request.post(origin + '/api/task-board/action', { headers: { origin }, data: { requestId: randomUUID(), action: { kind: 'rerun', taskId: target.id } } })
    assert.equal(result.status(), 400)
    assert.match((await result.json()).error, /禁止在此重复运行/)
    const after = await (await page.request.get(origin + '/api/task-board/state', { headers: { origin } })).json()
    assert.equal(after.tasks.find(t => t.id === target.id).executions.length, executionCount)
    assert.equal(after.power.runningSessions, runningSessions)
    console.log('PASS: native rerun is blocked BEFORE creating any execution or session')
  }
  // The native board folds completed source groups by default; searching intentionally expands them.
  await native.locator('input[type="search"]').fill('客户端入口端到端')
  const fixture = native.locator('[data-dsh-part="card"]').filter({ hasText: '客户端入口端到端' })
  await fixture.click()
  await page.locator('[data-superagent-detail="true"]').waitFor()
  console.log('PASS: native card detail renders Superagent provenance and real ticket id')
  await page.keyboard.press('Escape')
  if (process.env.SUPERAGENT_TEST_DOC_SHOT === '1') {
    mkdirSync('docs/images', { recursive: true })
    await native.locator('input[type="search"]').fill('客户端入口端到端')
    await native.screenshot({ path: 'docs/images/native-board.png' })
  }
  await icon.click()
  await page.getByRole('button', { name: '打开任务看板', exact: true }).waitFor()
  if (process.env.SUPERAGENT_TEST_SEND === '1') {
    const prompt = process.env.SUPERAGENT_TEST_PROMPT ?? '这是客户端独立入口的端到端连通性测试。请只回复“客户端入口已连接”，不要修改项目文件、不要提交或推送代码、不要创建或合并 PR。'
    const marker = process.env.SUPERAGENT_TEST_REPLY ?? '客户端入口已连接'
    const count = await page.locator('.sab-message-assistant').count()
    await page.locator('.sab-composer textarea').fill(prompt)
    const sent = page.waitForResponse(r => r.url().endsWith('/@superagent-board/api/chat') && r.request().method() === 'POST', { timeout: 15000 })
    await page.getByRole('button', { name: '发送', exact: true }).click()
    const receipt = await sent; assert.equal(receipt.status(), 202)
    const duplicate = await page.request.post(origin + '/@superagent-board/api/chat', { headers: { 'x-superagent-board': '1' }, data: receipt.request().postDataJSON() })
    assert.equal(duplicate.status(), 202); assert.equal((await duplicate.json()).duplicate, true)
    await page.waitForFunction(({ count, marker }) => {
      const replies = [...document.querySelectorAll('.sab-message-assistant .sab-message-text')]
      return replies.length > count && replies.at(-1).textContent.includes(marker)
    }, { count, marker }, { timeout: 180000 })
    console.log('PASS: real Source intake, persistent idempotency and real Superagent reply')
  }
  mkdirSync('.private', { recursive: true })
  await page.screenshot({ path: '.private/gui.png', fullPage: true })
  if (process.env.SUPERAGENT_TEST_DOC_SHOT === '1') await page.locator('.sab-panel').screenshot({ path: 'docs/images/chat.png' })
  assert.equal(errors.length, 0, 'Browser errors: ' + errors.join('; '))
  console.log('PASS: no uncaught browser errors')
} catch (error) {
  mkdirSync('.private', { recursive: true })
  await page.screenshot({ path: '.private/gui-failure.png', fullPage: true }).catch(() => {})
  console.error(String(error.message).replace(/https?:\/\/\S+/g, '<URL>'))
  if (errors.length) console.error('Browser errors: ' + errors.join('; '))
  process.exitCode = 1
} finally { await browser.close() }
