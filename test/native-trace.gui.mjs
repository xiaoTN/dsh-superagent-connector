import {chromium} from 'playwright'
import {readFileSync} from 'node:fs'
const state=JSON.parse(readFileSync('.private/stop-validation.json','utf8'))
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true})
const page=await browser.newPage({viewport:{width:1440,height:1080}}),errors=[]
page.on('pageerror',error=>errors.push(error.message.replace(/https?:\/\/\S+/g,'<URL>')))
await page.addLocatorHandler(page.getByText('预览版说明',{exact:true}),async()=>page.getByRole('button',{name:'继续',exact:true}).click())
try{
 await page.goto(readFileSync('.private/browser-launch-url','utf8').trim(),{waitUntil:'domcontentloaded'})
 await page.locator('[data-dsh-panel-entry="dsh-superagent-board"]').click()
 await page.locator('.sab-native [contenteditable="true"]').waitFor()
 await page.getByRole('combobox',{name:'选择 Source 工单执行'}).selectOption(state.ticketId)
 await page.getByRole('button',{name:'读取所选真实记录',exact:true}).click()
 const trace=page.locator('[data-superagent-trace="'+state.ticketId+'"]')
 await trace.locator('ol li').first().waitFor({timeout:20000})
 const result=await trace.evaluate(node=>({records:node.querySelectorAll('ol li').length,hasOriginalSequence:/#\d+ /.test(node.textContent),hasTime:node.querySelectorAll('time').length>0,hasOlder:[...node.querySelectorAll('button')].some(button=>button.textContent==='读取更早记录')}))
 console.log(JSON.stringify({...result,errors},null,2));await page.screenshot({path:'.private/native-trace.png'})
 if(!result.records||result.records>50||!result.hasOriginalSequence||!result.hasTime||errors.length)process.exitCode=1
}catch(error){console.error(String(error.message).replace(/https?:\/\/\S+/g,'<URL>'));console.log(JSON.stringify({errors}));process.exitCode=1}
finally{await browser.close()}
