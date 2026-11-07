import {readFileSync,mkdirSync,writeFileSync,existsSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
import {chromium} from 'playwright'
const launch=readFileSync(process.env.SUPERAGENT_TEST_AUTH_FILE??'.private/browser-launch-url','utf8').trim()
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true})
const page=await browser.newPage({viewport:{width:1440,height:1000}})
const errors=[],network=[]
page.on('pageerror',e=>errors.push(e.message.replace(/https?:\/\/\S+/g,'<URL>')))
page.on('response',response=>{if(response.url().includes('/@superagent-board/api/'))network.push({path:new URL(response.url()).pathname,status:response.status()})})
await page.addLocatorHandler(page.getByText('预览版说明',{exact:true}),async()=>page.getByRole('button',{name:'继续',exact:true}).click())
try{
  try{await page.goto(launch,{waitUntil:'domcontentloaded'})}catch{throw Error('Could not open the authorized existing GUI')}
  await page.locator('[data-dsh-panel-entry="dsh-superagent-board"]').click()
  await page.locator('.sab-native').waitFor()
  await page.waitForFunction(()=>document.querySelector('.sab-native [contenteditable="true"]')||document.querySelector('.sab-native [role="alert"]'),{timeout:25000})
  let sendResult
  if(process.env.SUPERAGENT_TEST_SEND==='1') {
    const markerFile='.private/native-send-marker'
    const marker=existsSync(markerFile)?readFileSync(markerFile,'utf8').trim():'NATIVE-CHECK-'+randomUUID()
    if(!existsSync(markerFile)) {
      writeFileSync(markerFile,marker)
      const editor=page.locator('.sab-native [contenteditable="true"]').first()
      await editor.fill('界面只读验收：请只回复 '+marker+'。不要创建或修改工单，不改任何文件，不提交或推送。')
      await editor.press('Enter')
    }
    await page.waitForFunction(marker=>[...document.querySelectorAll('[data-superagent-source]')].some(node=>node.textContent.includes(marker)),marker,{timeout:180000})
    sendResult=await page.evaluate(marker=>({sourceReply:[...document.querySelectorAll('[data-superagent-source]')].some(node=>node.textContent.includes(marker)),draftEmpty:!document.querySelector('.sab-native [contenteditable="true"]')?.textContent}),marker)
  }
  const result=await page.evaluate(()=>({
    editable:!!document.querySelector('.sab-native [contenteditable="true"]'),
    textarea:!!document.querySelector('.sab-native textarea'),
    alerts:[...document.querySelectorAll('.sab-native [role="alert"]')].map(e=>e.textContent),
    sourceRows:document.querySelectorAll('[data-superagent-source]').length,
    sourceStyles:[...document.querySelectorAll('[data-superagent-source]')].slice(-1).flatMap(node=>[node,...node.children,...node.querySelectorAll('p')].slice(0,5).map(e=>({tag:e.tagName,class:e.className,font:getComputedStyle(e).fontSize,color:getComputedStyle(e).color,lineHeight:getComputedStyle(e).lineHeight}))),
    sourceMarked:!!document.querySelector('[data-conversation-session^="superagent-source-"]'),
    composerCard:!!document.querySelector('.sab-native [data-composer-card]'),
    visibleLocalHistoryActions:[...document.querySelectorAll('.sab-native button')].filter(e=>['撤回','编辑'].includes(e.getAttribute('aria-label'))&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0).length,
    visibleLocalSettings:[...document.querySelectorAll('.sab-native button')].filter(e=>/访问模式|GPT-6/.test(e.getAttribute('aria-label')??'')&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0).length,
    sourceTransportStates:document.querySelectorAll('[data-superagent-transport]').length,
  }))
  console.log(JSON.stringify({result,sendResult,errors,network},null,2))
  mkdirSync('.private',{recursive:true});await page.screenshot({path:'.private/native-gui.png'})
  if(!result.editable||result.visibleLocalHistoryActions||result.visibleLocalSettings||errors.length)process.exitCode=1
}catch(error){console.error(String(error.message).replace(/https?:\/\/\S+/g,'<URL>'));console.log(JSON.stringify({errors,network}));await page.screenshot({path:'.private/native-failure.png'}).catch(()=>{});process.exitCode=1}
finally{await browser.close()}
