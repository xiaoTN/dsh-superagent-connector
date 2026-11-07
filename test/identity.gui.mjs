// Real existing-GUI identity verification. No chat sends or worker tasks.
import { readFileSync, mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
const launchUrl = readFileSync(process.env.SUPERAGENT_TEST_AUTH_FILE ?? '.private/browser-launch-url', 'utf8').trim()
const origin = new URL(launchUrl).origin
const browser = await chromium.launch({ executablePath: process.env.SUPERAGENT_TEST_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = [], requests = []
page.on('pageerror', error => errors.push(error.message.replace(/https?:\/\/\S+/g, '<URL>')))
page.on('request', request => { if (request.url().endsWith('/@superagent-board/api/chat') && request.method() === 'POST') requests.push('chat-post') })
await page.addLocatorHandler(page.getByText('预览版说明', { exact: true }), async () => page.getByRole('button', { name: '继续', exact: true }).click())
const endpoint = origin + '/@superagent-board/api/identity'
const getIdentity = async () => {
  const response = await page.request.get(endpoint, { headers: { 'x-superagent-board': '1' } })
  assert.equal(response.status(), 200)
  return response.json()
}
let initial, ownedRevision
const aliases = new Set(['SuperAgent · 名称同步验收', '独立助手 🤖 自动同步验收'])
async function assertUI(name) {
  await page.waitForFunction(expected => document.querySelector('.sab-panel h1')?.textContent === expected, name, { timeout: 25000 })
  const sidebar = await page.locator('[data-dsh-panel-entry="dsh-superagent-board"]').evaluate(node => (node.closest('button') ?? node.parentElement).textContent)
  assert.ok(sidebar.includes(name), 'Real native sidebar label did not follow the identity')
  await page.locator('.sab-message-assistant .sab-message-meta strong').first().waitFor()
  const authors = await page.locator('.sab-message-assistant .sab-message-meta strong').allTextContents()
  assert.ok(authors.length && authors.every(author => author === name), 'Assistant bylines did not follow the identity')
}
async function saveName(name) {
  const details = page.locator('.sab-name-settings')
  if ((await details.getAttribute('open')) === null) await details.locator('summary').click()
  await page.getByRole('textbox', { name: 'Agent 名称', exact: true }).fill(name)
  const pending = page.waitForResponse(r => r.url().endsWith('/@superagent-board/api/identity') && r.request().method() === 'PUT', { timeout: 15000 })
  await page.getByRole('button', { name: '保存名称', exact: true }).click()
  const response = await pending
  assert.equal(response.status(), 200)
  const result = await response.json(); ownedRevision = result.revision
  assert.equal(result.agent.name, name)
  await assertUI(name)
}
try {
  try { await page.goto(launchUrl, { waitUntil: 'domcontentloaded' }) } catch { throw new Error('Could not authenticate the test browser') }
  await page.locator('[data-dsh-panel-entry="dsh-superagent-board"]').click()
  await page.locator('.sab-composer textarea').waitFor()
  initial = await getIdentity()
  await assertUI(initial.agent.name)
  console.log('PASS: actual Source identity drives heading, sidebar and historical assistant bylines')
  await saveName('SuperAgent · 名称同步验收')
  console.log('PASS: explicit native name form writes the authoritative Source and updates real UI')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('[data-dsh-panel-entry="dsh-superagent-board"]').click()
  await assertUI('SuperAgent · 名称同步验收')
  assert.equal((await getIdentity()).agent.name, 'SuperAgent · 名称同步验收')
  console.log('PASS: independent identity survives a fresh client load, not a frontend constant/cache')
  const external = await page.request.put(endpoint, { headers: { 'x-superagent-board': '1' }, data: { name: '独立助手 🤖 自动同步验收', revision: ownedRevision } })
  assert.equal(external.status(), 200); ownedRevision = (await external.json()).revision
  await assertUI('独立助手 🤖 自动同步验收')
  console.log('PASS: another client rename is automatically polled without refresh or chat sends')
  await saveName(initial.agent.name)
  assert.equal(requests.length, 0)
  assert.equal(errors.length, 0, 'Uncaught browser errors')
  console.log('PASS: restored original independent name; zero chat POSTs and no browser errors')
} catch (error) {
  mkdirSync('.private', { recursive: true })
  await page.screenshot({ path: '.private/identity-failure.png' }).catch(() => {})
  console.error(String(error.message).replace(/https?:\/\/\S+/g, '<URL>'))
  if (errors.length) console.error(errors.join('; '))
  process.exitCode = 1
} finally {
  // Never overwrite a concurrent human rename. Only undo the exact temporary revision this test owns.
  if (initial) {
    try {
      const current = await getIdentity()
      if (aliases.has(current.agent.name) && current.revision === ownedRevision) {
        const restored = await page.request.put(endpoint, { headers: { 'x-superagent-board': '1' }, data: { name: initial.agent.name, revision: current.revision } })
        assert.equal(restored.status(), 200)
        console.log('Restored temporary identity using its matching revision.')
      }
    } catch { console.error('Could not verify name cleanup; inspect current identity before continuing.'); process.exitCode = 1 }
  }
  await browser.close()
}
