import {chromium} from 'playwright'
import {readFileSync,writeFileSync,existsSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true})
const page=await browser.newPage({viewport:{width:1440,height:1080}}),errors=[]
page.on('pageerror',error=>errors.push(error.message.replace(/https?:\/\/\S+/g,'<URL>')))
await page.addLocatorHandler(page.getByText('预览版说明',{exact:true}),async()=>page.getByRole('button',{name:'继续',exact:true}).click())
const api=path=>page.evaluate(async path=>{const response=await fetch('/@superagent-board/api/native'+path,{headers:{'x-superagent-board':'1'}});if(!response.ok)throw Error('Native state unavailable');return response.json()},path)
const worker=async id=>{
 for(const state of ['open','ended']){
  const body=await fetch('http://127.0.0.1:3082/orchestrator/api/tickets?state='+state+'&limit=100',{headers:{'x-orchestrator-request':'1'}}).then(response=>response.json())
  const ticket=body.items.find(ticket=>ticket.id===id);if(ticket)return ticket
 }
}
try{
 await page.goto(readFileSync('.private/browser-launch-url','utf8').trim(),{waitUntil:'domcontentloaded'})
 await page.locator('[data-dsh-panel-entry="dsh-superagent-board"]').click()
 await page.locator('.sab-native [contenteditable="true"]').waitFor()
 const stateFile='.private/stop-validation.json'
 let state=existsSync(stateFile)?JSON.parse(readFileSync(stateFile,'utf8')):undefined
 if(!state){
  const before=await api('/conversations/main/events?afterSeq=0&limit=1')
  state={baselineTickets:before.executions.map(row=>row.ticketId),baselineSeq:before.newestSeq,marker:'STOP-CHECK-'+randomUUID()}
  writeFileSync(stateFile,JSON.stringify(state))
  await page.locator('.sab-native [contenteditable="true"]').fill('这是执行器生命周期验收，不是内容问答。请必须新建一个独立工单并交给执行器，不要直接答复代替执行，也不要复用旧工单。明确授权只读命令：先在实际worker运行 sleep 120 作为可中断执行；我会在等待中中断再继续。继续时跳过再次等待，运行 printf '+state.marker+' 并完成只读工单。不要修改项目文件，不提交、推送或创建PR。请创建工单后保持真实执行，供界面验证Stop和继续。')
  await page.locator('.sab-native [contenteditable="true"]').press('Enter')
 }
 if(!state.ticketId){
  await page.waitForFunction(ids=>[...document.querySelectorAll('select[aria-label="选择 Source 工单执行"] option')].some(option=>option.value&&!ids.includes(option.value)),state.baselineTickets,{timeout:240000,polling:1000})
  const snapshot=await api('/conversations/main/events?afterSeq=0&limit=1'),row=snapshot.executions.find(row=>!state.baselineTickets.includes(row.ticketId))
  if(!row||row.state==='ended')throw Error('Source did not retain an active validation assignment')
  const before=await worker(row.ticketId)
  state={...state,ticketId:row.ticketId,assignmentId:row.assignmentId,controlSeq:row.controlSeq,sessionId:before.sessionId||'worker-'+row.ticketId,sourceStartedBeforeStop:!!before.sessionId,directory:before.directory,phase:'before-stop'}
  writeFileSync(stateFile,JSON.stringify(state))
 }
 if(state.phase==='before-stop'){
  // Reconcile a lost test-process result without issuing a second interruption.
  const previous=(await api('/conversations/main/events?afterSeq=0&limit=1')).executions.find(row=>row.ticketId===state.ticketId)
  if(previous?.state==='paused'&&previous.interruption==='settled'&&previous.controlSeq===state.controlSeq+1&&previous.assignmentId===state.assignmentId){
   const retained=await worker(state.ticketId)
   if(retained.state!=='open'||retained.directory!==state.directory||retained.sessionId!==('worker-'+state.ticketId))throw Error('Paused execution lost its canonical worker/worktree')
   state.sourceStartedBeforeStop=!!state.sessionId;state.sessionId=retained.sessionId;state.phase='paused';writeFileSync(stateFile,JSON.stringify(state))
  }
 }
 if(state.phase==='before-stop'){
  await page.getByRole('button',{name:'刷新执行状态',exact:true}).click()
  await page.getByRole('combobox',{name:'选择 Source 工单执行'}).selectOption(state.ticketId)
  await page.getByRole('button',{name:'中断所选执行',exact:true}).click()
  await page.waitForFunction(id=>[...document.querySelectorAll('select[aria-label="选择 Source 工单执行"] option')].some(option=>option.value===id&&option.textContent.includes('已中断')),state.ticketId,{timeout:90000,polling:1000})
  const paused=(await api('/conversations/main/events?afterSeq=0&limit=1')).executions.find(row=>row.ticketId===state.ticketId),same=await worker(state.ticketId)
  if(paused.assignmentId!==state.assignmentId||paused.controlSeq!==state.controlSeq+1||paused.interruption!=='settled'||same.state!=='open'||same.sessionId!==state.sessionId||same.directory!==state.directory)throw Error('Interruption did not retain the exact live assignment/session/worktree')
  state.phase='paused';writeFileSync(stateFile,JSON.stringify(state))
 }
 if(state.phase==='paused'){
  await page.getByRole('button',{name:'刷新执行状态',exact:true}).click()
  await page.getByRole('combobox',{name:'选择 Source 工单执行'}).selectOption(state.ticketId)
  await page.getByRole('button',{name:'继续所选工单',exact:true}).click()
  state.phase='resumed';writeFileSync(stateFile,JSON.stringify(state))
 }
 await page.waitForFunction(marker=>[...document.querySelectorAll('[data-superagent-source]')].some(node=>node.textContent.includes(marker)),state.marker,{timeout:240000})
 const current=(await api('/conversations/main/events?afterSeq=0&limit=1')).executions.find(row=>row.ticketId===state.ticketId),same=await worker(state.ticketId)
 const result={interruptionSettled:true,ticketNotTerminatedByStop:true,interruptedDuringPreparation:state.sourceStartedBeforeStop===false,sameAssignment:current.assignmentId===state.assignmentId,sameWorkerSession:same.sessionId===state.sessionId,sameWorktree:same.directory===state.directory,controlSeq:current.controlSeq,continued:current.controlSeq===state.controlSeq+2,errors}
 console.log(JSON.stringify(result,null,2));await page.screenshot({path:'.private/native-stop-gui.png'})
 if(!result.sameAssignment||!result.sameWorkerSession||!result.sameWorktree||!result.continued||errors.length)process.exitCode=1
}catch(error){console.error(String(error.message).replace(/https?:\/\/\S+/g,'<URL>'));console.log(JSON.stringify({errors}));await page.screenshot({path:'.private/native-stop-failure.png'}).catch(()=>{});process.exitCode=1}
finally{await browser.close()}
