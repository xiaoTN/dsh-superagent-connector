import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtempSync,rmSync,readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeInboxHandler,makeSource,submit,OWNER } from '../src/source.js'
import { CONVERSATIONS_PATH,requestTriggerId } from '../src/source-conversations.js'
import { createNativeHost } from '../src/native-host.js'
import { createSourceTransport } from '../src/source-transport.js'
import { handler,PREFIX } from '../src/index.js'
import { isScopedSourceRoute,upstreamBase } from '../src/upstream.js'
import { createAttachmentStore } from '../src/source-attachments.js'
const token='c'.repeat(64)
function context() {
  const kv=new Map(),triggers=new Map()
  return {state:{get:key=>structuredClone(kv.get(key)),set:(key,value)=>kv.set(key,structuredClone(value))},
    atomic(fn){const saved=structuredClone(kv);try{return fn()}catch(error){kv.clear();saved.forEach((v,k)=>kv.set(k,v));throw error}},
    config:()=>({}),configured:()=>true,triggers:{get:id=>triggers.get(id)},
    receive(value){triggers.set(value.id,value);return 'stored'},threads:{describe(){},get:()=>({subscriptions:[]})}}
}
function request(method,url,body) {
  return Object.assign(Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]),{method,url,socket:{remoteAddress:'127.0.0.1'},
    headers:{host:'127.0.0.1:1234',authorization:'Bearer '+token,'content-type':'application/json','x-superagent-board':'1'}})
}
const response=()=>({status:0,writeHead(status){this.status=status},end(body){this.body=JSON.parse(body)}})
const registry={policyPart:()=>({allowed:[{id:OWNER}]})}

test('Source conversation pages isolate threads, preserve actual delivery kind/ticket and keep pending status on empty increments',async()=>{
  const ctx=context()
  submit(ctx,{text:'one request',requestId:'request-0000000001',conversationId:'one'})
  submit(ctx,{text:'another request',requestId:'request-0000000002',conversationId:'two'})
  await makeSource(()=>ctx).channel.send({}, {id:'actual-ack',text:'ack',kind:'acknowledgement',ticketId:'ticket-one',channel:{address:{conversation:'one'}}})
  const route=makeInboxHandler({context:ctx,registry,token})
  let res=response();await route(request('GET',CONVERSATIONS_PATH+'/one/events?afterSeq=0'),res)
  assert.equal(res.status,200);assert.equal(res.body.events.length,2)
  assert.equal(res.body.events[1].kind,'acknowledgement');assert.equal(res.body.events[1].ticketId,'ticket-one')
  assert.equal(res.body.events.some(e=>e.text==='another request'),false)
  res=response();await route(request('GET',CONVERSATIONS_PATH+'/one/events?afterSeq=2'),res)
  assert.equal(res.body.events.length,0);assert.equal(res.body.state,'pending')
  res=response();await route(request('GET',CONVERSATIONS_PATH+'/one/receipt/request-0000000001'),res)
  assert.equal(res.body.accepted,true);assert.equal(res.body.id,requestTriggerId('one','request-0000000001'))
})

test('Source controls are separate non-terminating operations with current-assignment/control CAS and no human text bypass',async()=>{
  const ctx=context(),calls=[]
  ctx.threads.get=()=>({subscriptions:['ticket-one']})
  ctx.execution={version:1,read:async input=>({version:1,ticketId:input.ticketId,assignmentId:'assignment-one',controlSeq:2,state:'paused',interruption:'requested',activity:'running',records:[]}),
    interrupt:async input=>{calls.push(input);return{state:'paused',interruption:'requested',controlSeq:3}}}
  const route=makeInboxHandler({context:ctx,registry,token})
  let res=response();await route(request('POST',CONVERSATIONS_PATH+'/one/executions/ticket-one/interrupt',{expectedAssignmentId:'assignment-one',expectedControlSeq:2}),res)
  assert.equal(res.status,200);assert.equal(calls[0].threadKey,'desktop-inbox:one')
  res=response();await route(request('POST',CONVERSATIONS_PATH+'/one/executions/ticket-one/resume',{expectedAssignmentId:'assignment-one',expectedControlSeq:2,text:'bypass'}),res)
  assert.equal(res.status,400);assert.equal(calls.length,1)
  res=response();await route(request('GET',CONVERSATIONS_PATH+'/one/events?afterSeq=0'),res)
  assert.equal(res.body.state,'pending');assert.equal(res.body.executions[0].actions.resume,false)
  assert.equal(res.body.activeAssignments.length,0)
})

test('native host creates only genuine injected relay and rejects forged DSH access before session creation',async()=>{
  const root=mkdtempSync(join(tmpdir(),'native-host-'));let created=0,disposed=0
  const transport={capabilities:async()=>({version:1,source:'superagent',submit:true})}
  const native=createNativeHost({workspaceRegistry:{list:()=>[{id:'workspace',path:root}]}},{transport,sourceInstanceId:'http://127.0.0.1:3082',outboxRoot:join(root,'outbox'),
    createRelay:async(_ctx,options)=>{created++;assert.equal(options.conversationId,'main');assert.equal(options.cwd,root);return{sessionId:'source-relay-id',refresh:async()=>{},dispose:async()=>{disposed++}}}})
  try{
    const route=handler({base:upstreamBase(),token:()=>token,connection:()=>({requestRejection:()=>undefined}),nativeHost:native})
    let res=response();await route(request('POST',PREFIX+'/native/session',{conversationId:'main'}),res)
    assert.equal(res.status,200);assert.equal(res.body.sessionId,'source-relay-id')
    res=response();await route(request('POST',PREFIX+'/native/session',{conversationId:'main'}),res);assert.equal(created,1)
    const forged=handler({base:upstreamBase(),token:()=>token,connection:()=>({requestRejection:()=> 'denied'}),nativeHost:native})
    res=response();await forged(request('POST',PREFIX+'/native/session',{conversationId:'other'}),res)
    assert.equal(res.status,401);assert.equal(created,1)
  }finally{await native.dispose();rmSync(root,{recursive:true,force:true})}
  assert.equal(disposed,1)
})

test('attachment-only Source intake commits real worker files while its public journal retains no server paths',async()=>{
  const root=mkdtempSync(join(tmpdir(),'source-input-')),ctx=context()
  try {
    const store=createAttachmentStore({root}),requestId='attachment-request-0000001',conversationId='files'
    const attachment=store.upload({owner:OWNER,conversationId,requestId,name:'input.txt',mediaType:'application/octet-stream',bytes:Buffer.from('actual operator file')})
    const input={text:'',requestId,conversationId,attachments:[attachment.receipt]}
    const result=submit(ctx,input,store)
    const file=store.resolve({owner:OWNER,conversationId,requestId,messageId:result.id,receipt:attachment.receipt})
    assert.equal(readFileSync(file.path,'utf8'),'actual operator file')
    assert.ok(ctx.triggers.get(result.id).text.includes(JSON.stringify(file.path)))
    assert.equal(ctx.triggers.get(result.id).human,true)
    assert.equal(submit(ctx,input,store).duplicate,true)
    const route=makeInboxHandler({context:ctx,registry,token,attachmentStore:store}),res=response()
    await route(request('GET',CONVERSATIONS_PATH+'/files/events?afterSeq=0'),res)
    assert.equal(res.status,200);assert.equal(res.body.events[0].text,'')
    assert.equal(res.body.events[0].attachments[0].receipt,attachment.receipt)
    assert.equal(JSON.stringify(res.body).includes(file.path),false)
    assert.equal(res.body.capabilities.attachments,true)
    assert.throws(()=>submit(ctx,{...input,text:'altered request'},store),/already used/)
  }finally{rmSync(root,{recursive:true,force:true})}
})

test('all ticket state summaries are checked before bounding presentation, so historical subscriptions cannot hide live work',async()=>{
  const ctx=context(),ids=Array.from({length:101},(_,index)=>'ticket-'+index),reads=[]
  ctx.threads.get=()=>({subscriptions:ids})
  ctx.execution={version:1,read:async({ticketId})=>{reads.push(ticketId);return{assignmentId:'assignment-'+ticketId,controlSeq:0,state:ticketId==='ticket-100'?'running':'ended',activity:ticketId==='ticket-100'?'running':'idle'}}}
  const route=makeInboxHandler({context:ctx,registry,token}),res=response()
  await route(request('GET',CONVERSATIONS_PATH+'/one/events?afterSeq=0'),res)
  assert.equal(res.status,200);assert.equal(reads.length,101);assert.equal(res.body.state,'running')
  assert.equal(res.body.executions[0].ticketId,'ticket-100');assert.equal(res.body.activeAssignments[0].ticketId,'ticket-100')
  assert.equal(res.body.executionCount,101);assert.equal(res.body.executions.length,100);assert.equal(res.body.executionsTruncated,true)
})

test('fresh Source capability revocation cannot be overwritten by cached native support',async()=>{
  const root=mkdtempSync(join(tmpdir(),'native-revocation-'))
  const trueCaps={version:1,source:'superagent',submit:true,attachments:true,interrupt:true,resume:true}
  const falseCaps={...trueCaps,submit:false,attachments:false,interrupt:false,resume:false}
  const native=createNativeHost({workspaceRegistry:{list:()=>[{id:'workspace',path:root}]}},{sourceInstanceId:'http://127.0.0.1:3082',outboxRoot:join(root,'outbox'),
    transport:{capabilities:async()=>trueCaps,snapshot:async()=>({capabilities:falseCaps})},
    createRelay:async()=>({sessionId:'source-relay-id',capabilities:trueCaps,dispose:async()=>{}})})
  try{
    await native.open({conversationId:'main'})
    const res=response();await native.handle(request('GET',PREFIX+'/native/conversations/main/events'),res,PREFIX+'/native')
    for(const key of ['submit','attachments','interrupt','resume'])assert.equal(res.body.capabilities[key],false)
  }finally{await native.dispose();rmSync(root,{recursive:true,force:true})}
})

test('a rejected reuse of an accepted text-only request never pins unrelated new attachments',()=>{
  const root=mkdtempSync(join(tmpdir(),'source-rejected-files-')),ctx=context();let clock=1
  try{
    const store=createAttachmentStore({root,clock:()=>clock,limits:{maxTotalBytes:8,draftTtlMs:1}}),requestId='reused-request-0000001',conversationId='main'
    const original=submit(ctx,{text:'original',requestId,conversationId},store)
    const attachment=store.upload({owner:OWNER,conversationId,requestId,name:'new.txt',mediaType:'application/octet-stream',bytes:Buffer.from('12345678')})
    assert.throws(()=>submit(ctx,{text:'changed',requestId,conversationId,attachments:[attachment.receipt]},store),error=>error.status===409)
    assert.throws(()=>store.resolvePrepared({owner:OWNER,conversationId,requestId,messageId:original.id,receipt:attachment.receipt}))
    clock=100;assert.equal(store.cleanup().expired,1)
    assert.equal(store.upload({owner:OWNER,conversationId,requestId:'fresh-request-0000001',name:'fresh.txt',mediaType:'application/octet-stream',bytes:Buffer.from('abcdefgh')}).size,8)
  }finally{rmSync(root,{recursive:true,force:true})}
})

test('private transport route allowlist never becomes arbitrary management/session proxy',async()=>{
  for(const path of ['/orchestrator/api/settings','/superagent-desktop-inbox/conversations/one/events?sessionId=main',
    '/superagent-desktop-inbox/conversations/../orchestrator/api/state','/superagent-desktop-inbox/conversations/one/executions/main/cancel'])assert.equal(isScopedSourceRoute(path,'GET'),false)
  assert.equal(isScopedSourceRoute(CONVERSATIONS_PATH+'/one/events?afterSeq=0&limit=200','GET'),true)
  assert.equal(isScopedSourceRoute(CONVERSATIONS_PATH+'/one/executions/ticket-one/interrupt','POST'),true)
  assert.equal(isScopedSourceRoute(CONVERSATIONS_PATH+'/one/executions/ticket-one/interrupt','GET'),false)
  const calls=[]
  const transport=createSourceTransport({base:upstreamBase(),token:()=>token,read:async(_b,path,options)=>{calls.push({path,options});return{accepted:true,id:'trigger',conversationId:'one',requestId:'request-0000000001'}}})
  await transport.submit({conversationId:'one',text:'real Source request',requestId:'request-0000000001'})
  assert.equal(calls[0].path,'/superagent-desktop-inbox/messages')
  assert.deepEqual(calls[0].options.body,{conversationId:'one',text:'real Source request',requestId:'request-0000000001'})
  await assert.rejects(transport.control({conversationId:'one',ticketId:'../main',expectedAssignmentId:'a',expectedControlSeq:0,action:'interrupt'}))
  assert.equal(calls.length,1)
})
