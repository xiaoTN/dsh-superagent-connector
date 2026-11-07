/** Narrow, owner-scoped Source transport for the native relay. No arbitrary Session proxy. */
import { createHash } from 'node:crypto'
import { HttpError, json, readJson, redact } from './security.js'
import { readAgentIdentity } from './identity.js'
import { withConversation, validateConversationId } from './conversation-store.js'
import { handleSourceAttachment } from './source-attachment-routes.js'
export const CONVERSATIONS_PATH = '/superagent-desktop-inbox/conversations'
const SOURCE = 'desktop-inbox'
const OWNER = 'desktop-owner'
const ticketIdPattern = /^[a-zA-Z0-9_-]{1,128}$/
const requestIdPattern = /^[a-zA-Z0-9_-]{16,100}$/
export const requestTriggerId = (conversationId, requestId) => createHash('sha256')
  .update(SOURCE + ':' + (conversationId === 'main' ? requestId : 'conversation:' + conversationId + ':' + requestId)).digest('hex').slice(0,32)

export function sourceCapabilities(context, attachmentStore) {
  const execution = context.execution?.version === 1
  return { version:1, source:'superagent', submit:context.configured(), conversations:true, history:true,
    interrupt:execution, resume:execution, executionRecords:execution, steer:false, attachments:!!attachmentStore,
    approval:false, modelSelection:false, permissionSelection:false, tokenStream:false }
}
function strictQuery(url, keys) {
  for (const key of url.searchParams.keys()) if (!keys.includes(key) || url.searchParams.getAll(key).length !== 1) throw new HttpError(400, 'Unsupported conversation query')
}
function integerQuery(url, key, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value=url.searchParams.get(key)
  if (value === null) return undefined
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new HttpError(400, 'Invalid '+key)
  const result=Number(value)
  if (!Number.isSafeInteger(result) || result<min || result>max) throw new HttpError(400, 'Invalid '+key)
  return result
}
function ticketCandidates(context, conversationId, events) {
  const key=SOURCE+':'+conversationId
  const thread=context.threads.get?.(key)
  const result=new Set()
  for (const value of thread?.subscriptions ?? []) {
    const id=typeof value==='string'?value:value?.ticketId ?? value?.id
    if (typeof id==='string' && ticketIdPattern.test(id)) result.add(id)
  }
  for (const event of events) if (event.ticketId) result.add(event.ticketId)
  return [...result]
}
export function projectSourceEvent(event, secret) {
  const text=redact(String(event.text ?? '').slice(0,50000),secret)
  return { seq:event.seq,id:event.id,role:event.role,conversationId:event.conversationId,at:event.at,text,kind:event.kind,
    ...(event.status?{status:event.status}:{}),...(event.requestId?{requestId:event.requestId}:{}),...(event.ticketId?{ticketId:event.ticketId}:{}),
    ...(typeof event.textDigest==='string'&&/^[a-f0-9]{64}$/.test(event.textDigest)?{textDigest:event.textDigest}:{}),
    ...(Array.isArray(event.attachments)?{attachments:event.attachments.map(file=>({
      receipt:file.receipt,sha256:file.sha256,attachmentId:file.attachmentId,name:redact(file.name,secret),mediaType:file.mediaType,size:file.size,isImage:file.isImage,
      ...(Number.isSafeInteger(file.width)?{width:file.width}:{}),...(Number.isSafeInteger(file.height)?{height:file.height}:{}),
    }))}:{}),
    ...(event.truncated || event.text?.length>50000?{truncated:true}:{}) }
}
function redactExecution(value, secret, depth = 0) {
  if (depth > 40) return '[nested execution content omitted]'
  if (typeof value === 'string') return redact(value, secret)
  if (Array.isArray(value)) return value.map(item => redactExecution(item, secret, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,redactExecution(item,secret,depth+1)]))
  return value
}
async function executions(context, conversationId, events) {
  if (context.execution?.version !== 1) return []
  const results=[]
  for (const ticketId of ticketCandidates(context,conversationId,events)) {
    try {
      const view=await context.execution.read({threadKey:SOURCE+':'+conversationId,ticketId,limit:0})
      results.push({ticketId,assignmentId:view.assignmentId,controlSeq:view.controlSeq,state:view.state,
        ...(view.activity?{activity:view.activity}:{}),...(view.interruption?{interruption:view.interruption}:{}),
        ...(view.pausedAt?{pausedAt:view.pausedAt}:{}),actions:{interrupt:view.state==='running'&&['running','preparing'].includes(view.activity),
          resume:view.state==='paused'&&view.interruption==='settled'}})
    } catch(error) {
      // A context-only or no-longer-authorized worker is not an implicit permission grant.
      if (![403,404].includes(error.status)) throw error
    }
  }
  return results
}
export async function handleSourceConversation({ context, registry, token, attachmentStore }, req, res) {
  const url=new URL(req.url,'http://localhost')
  const policy=registry.policyPart(SOURCE)
  if (!policy?.allowed?.some(entry=>entry.id===OWNER)) throw new HttpError(403,'Local operator is not on the Superagent allowlist')
  const attachment = await handleSourceAttachment({store:attachmentStore,owner:OWNER},req)
  if(attachment)return json(res,attachment.status,attachment.body)
  const rest=url.pathname.slice(CONVERSATIONS_PATH.length)
  if (!rest && req.method==='GET') {
    strictQuery(url,[])
    return json(res,200,{version:1,conversations:withConversation(context,journal=>journal.list())})
  }
  if (rest==='/capabilities' && req.method==='GET') {
    strictQuery(url,[])
    return json(res,200,sourceCapabilities(context,attachmentStore))
  }
  const parts=rest.split('/').filter(Boolean)
  const conversationId=validateConversationId(parts[0])
  if (parts.length===2 && parts[1]==='events' && req.method==='GET') {
    strictQuery(url,['afterSeq','beforeSeq','limit'])
    const afterSeq=integerQuery(url,'afterSeq'),beforeSeq=integerQuery(url,'beforeSeq'),limit=integerQuery(url,'limit',{min:1,max:200})
    const {page,last}=withConversation(context,journal=>({
      page:journal.page(conversationId,{...(afterSeq!==undefined?{afterSeq}:{}),...(beforeSeq!==undefined?{beforeSeq}:{}),...(limit!==undefined?{limit}:{})}),
      last:journal.page(conversationId,{limit:1}).events.at(-1),
    }))
    const items=await executions(context,conversationId,[...page.events,...(last?[last]:[])])
    const activeAssignments=items.filter(item=>item.actions.interrupt&&item.assignmentId).map(item=>({ticketId:item.ticketId,assignmentId:item.assignmentId,controlSeq:item.controlSeq}))
    let state=activeAssignments.length?'running':items.some(item=>item.state==='paused'&&item.interruption!=='settled')?'pending'
      :items.some(item=>item.state==='paused')?'paused':items.some(item=>['running','pending'].includes(item.state))?'pending':'ended'
    if (state==='ended' && last && (last.role==='user'||['ack','acknowledgement'].includes(last.kind))) state='pending'
    // State-only summaries are cheap and must include every subscribed ticket: ended
    // subscriptions accumulate. Bound presentation AFTER discovering active work.
    const rank=item=>item.actions.interrupt?0:item.actions.resume?1:item.state==='ended'?3:2
    const visible=[...items].sort((a,b)=>rank(a)-rank(b)).slice(0,100)
    return json(res,200,{...page,events:page.events.map(event=>projectSourceEvent(event,token)),agent:readAgentIdentity(context).agent,
      capabilities:sourceCapabilities(context,attachmentStore),executions:visible,activeAssignments:activeAssignments.slice(0,100),
      executionCount:items.length,activeAssignmentCount:activeAssignments.length,executionsTruncated:items.length>visible.length,state})
  }
  if (parts.length===3 && parts[1]==='receipt' && req.method==='GET') {
    strictQuery(url,[])
    const requestId=parts[2]
    if (!requestIdPattern.test(requestId)) throw new HttpError(400,'Invalid request identity')
    const id=requestTriggerId(conversationId,requestId),trigger=context.triggers.get(id)
    if (trigger && trigger.channel?.thread!==conversationId) throw new HttpError(409,'Source receipt belongs to another conversation')
    return json(res,200,{version:1,conversationId,requestId,accepted:!!trigger,...(trigger?{id}:{})})
  }
  if (parts.length>=3 && parts[1]==='executions') {
    const ticketId=parts[2]
    if (!ticketIdPattern.test(ticketId)) throw new HttpError(400,'Invalid ticket identity')
    if (context.execution?.version!==1) throw new HttpError(503,'Install the scoped Superagent execution capability before using execution controls')
    if (parts.length===3 && req.method==='GET') {
      strictQuery(url,['throughSeq','beforeSeq','limit'])
      const throughSeq=integerQuery(url,'throughSeq'),beforeSeq=integerQuery(url,'beforeSeq'),limit=integerQuery(url,'limit',{min:0,max:100})
      if (beforeSeq!==undefined&&throughSeq===undefined) throw new HttpError(400,'A history cut is required before paging')
      const result=await context.execution.read({threadKey:SOURCE+':'+conversationId,ticketId,...(limit!==undefined?{limit}:{}),
        ...(throughSeq!==undefined?{cursor:{throughSeq,...(beforeSeq!==undefined?{beforeSeq}:{})}}:{})})
      return json(res,200,redactExecution(result,token))
    }
    if (parts.length===4 && ['interrupt','resume'].includes(parts[3]) && req.method==='POST') {
      strictQuery(url,[])
      const body=await readJson(req,4096)
      if (!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['expectedAssignmentId','expectedControlSeq'].includes(key))
        ||typeof body.expectedAssignmentId!=='string'||!ticketIdPattern.test(body.expectedAssignmentId)
        ||!Number.isSafeInteger(body.expectedControlSeq)||body.expectedControlSeq<0) throw new HttpError(400,'Expected the displayed assignment and control generation')
      const result=await context.execution[parts[3]]({threadKey:SOURCE+':'+conversationId,ticketId,...body})
      return json(res,200,result)
    }
  }
  throw new HttpError(404,'Unknown conversation operation')
}
