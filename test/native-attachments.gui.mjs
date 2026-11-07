import {readFileSync,writeFileSync,existsSync} from 'node:fs'
import {resolve} from 'node:path'
import {chromium} from 'playwright'
const headers={'x-superagent-board':'1'}
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true})
const page=await browser.newPage({viewport:{width:1440,height:1080}}),errors=[],requests=[]
page.on('pageerror',e=>errors.push(e.message.replace(/https?:\/\/\S+/g,'<URL>')))
page.on('request',request=>{const path=new URL(request.url()).pathname;if(request.method()==='POST'&&/upload|attachment|superagent/.test(path))requests.push(path)})
await page.addLocatorHandler(page.getByText('预览版说明',{exact:true}),async()=>page.getByRole('button',{name:'继续',exact:true}).click())
const api=async(path,method='GET',body)=>page.evaluate(async({path,method,body,headers})=>{
 const response=await fetch('/@superagent-board/api/native'+path,{method,headers:{...headers,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});if(!response.ok)throw Error('Native operation HTTP '+response.status);return response.json()
},{path,method,body,headers})
try{
 await page.goto(readFileSync('.private/browser-launch-url','utf8').trim(),{waitUntil:'domcontentloaded'})
 await page.locator('[data-dsh-panel-entry="dsh-superagent-board"]').click()
 await page.locator('.sab-native [contenteditable="true"]').waitFor()
 const stateFile='.private/attachment-send.json'
 let saved=existsSync(stateFile)?JSON.parse(readFileSync(stateFile,'utf8')):undefined
 if(!saved||process.env.SUPERAGENT_TEST_RETRY_UNADMITTED==='1'){
  const before=await api('/conversations/main/events?afterSeq=0&limit=1')
  if(saved&&before.newestSeq!==saved.baselineSeq)throw Error('Source changed after previous attempt; refusing blind resend')
  saved={baselineTickets:before.executions.map(row=>row.ticketId),baselineSeq:before.newestSeq,sendAttempted:true}
  writeFileSync(stateFile,JSON.stringify(saved))
  await page.locator('.sab-native [contenteditable="true"]').fill('请创建一个只读接入验证工单：读取所附文本的第一行，并检查所附图片的主颜色。不要修改任何仓库文件，不提交、推送或创建PR。为验证中断和继续，请先运行一个最多90秒的等待命令（例如sleep 90），等待期间我会中断当前执行再继续；继续后不要重新等待，直接实际读取两个附件并报告第一行和主颜色。')
  const uploadResponses=[]
  let uploadsResolve,uploadsReject
  const uploadsDone=new Promise((resolve,reject)=>{uploadsResolve=resolve;uploadsReject=reject})
  page.on('response',response=>{if(new URL(response.url()).pathname==='/api/session/uploadFileBinary'){
    uploadResponses.push((async()=>{await response.finished();if(response.status()!==200)throw Error('Native upload HTTP '+response.status());return true})())
    if(uploadResponses.length===2)Promise.all(uploadResponses).then(uploadsResolve,uploadsReject)
  }})
  const chooserPromise=page.waitForEvent('filechooser')
  await page.getByRole('button',{name:'添加文件或图片',exact:true}).click()
  const chooser=await chooserPromise
  await chooser.setFiles([resolve('.private/native-check.txt'),resolve('.private/native-visual.png')])
  await uploadsDone
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
  const primary=page.locator('.sab-native [data-composer-card] button[aria-busy]').last()
  await primary.waitFor()
  await page.waitForFunction(()=>{const button=document.querySelector('.sab-native [data-composer-card] button[aria-busy]');return button&&!button.disabled},null,{timeout:30000})
  await page.locator('.sab-native [contenteditable="true"]').press('Enter')
 }
 await page.waitForFunction(()=>!document.querySelector('.sab-native [contenteditable="true"]')?.textContent?.trim(),null,{timeout:30000})
 const marker=JSON.parse(readFileSync('.private/attachment-fixture.json','utf8')).textMarker
 await page.waitForFunction(marker=>[...document.querySelectorAll('[data-superagent-source]')].some(node=>node.textContent.includes(marker)),marker,{timeout:240000})
 const events=await api('/conversations/main/events?afterSeq='+saved.baselineSeq)
 const user=events.events.find(event=>event.role==='user'&&event.attachments?.length===2)
 const returned=events.events.filter(event=>event.role==='assistant'&&event.text.includes(marker))
 const result={nativeUploadPaths:requests.filter(path=>/upload/.test(path)),sourceAttachmentTypes:user?.attachments.map(a=>a.mediaType),actualTextRead:returned.length>0,
  actualImageColor:returned.some(event=>/红|red/i.test(event.text)),exactImageDimensions:returned.some(event=>event.text.includes('80')&&event.text.includes('60')),
  actualReplyKind:returned.at(-1)?.kind,errors}
 console.log(JSON.stringify(result,null,2));await page.screenshot({path:'.private/native-attachments-gui.png'})
 if(!result.actualTextRead||!result.actualImageColor||errors.length)process.exitCode=1
}catch(error){console.error(String(error.message).replace(/https?:\/\/\S+/g,'<URL>'));console.log(JSON.stringify({errors,requests}));await page.screenshot({path:'.private/native-attachments-failure.png'}).catch(()=>{});process.exitCode=1}
finally{await browser.close()}
