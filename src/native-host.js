/** Genuine native Session facade over one real Source conversation. No local AgentLoop. */
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { HttpError, json, readJson } from './security.js'
import { validateConversationId } from './conversation-store.js'
import { createOutboxStore } from './outbox-store.js'
import { createSourceRelay, installSourceRelayGuards } from './relay-agent.js'

function effectiveCapabilities(fresh, local) {
  const result={...local,...fresh}
  for(const key of Object.keys(result)) if(typeof fresh?.[key]==='boolean'||typeof local?.[key]==='boolean') result[key]=fresh?.[key]===true&&local?.[key]===true
  return result
}
export function createNativeHost(ctx,{transport,sourceInstanceId,outboxRoot,createRelay=createSourceRelay}) {
  const directory=outboxRoot??join(homedir(),'.dsh','superagent-relay',createHash('sha256').update(sourceInstanceId).digest('hex'))
  const instances=new Map(),creating=new Map()
  const removeGuards=createRelay===createSourceRelay?installSourceRelayGuards(ctx):()=>{}
  let closed=false
  async function open({conversationId='main',workspaceId}={}) {
    validateConversationId(conversationId)
    if(closed) throw new HttpError(503,'The Superagent relay is unloaded')
    if(instances.has(conversationId)) return instances.get(conversationId)
    if(creating.has(conversationId)) return creating.get(conversationId)
    const operation=(async()=>{
      const workspace=workspaceId!==undefined?ctx.workspaceRegistry.get(workspaceId):ctx.workspaceRegistry.list()[0]
      if(!workspace?.path) throw new HttpError(400,'Select an existing workspace before opening the Superagent conversation')
      const capabilities=await transport.capabilities()
      if(capabilities.source!=='superagent') throw new HttpError(502,'The selected backend is not Superagent')
      const relay=await createRelay(ctx,{conversationId,cwd:workspace.path,transport,
        outbox:createOutboxStore({root:directory,conversationId})})
      if(closed){await relay.dispose();throw new HttpError(503,'The Superagent relay was unloaded while opening')}
      const value={relay,workspaceId:workspace.id,conversationId,sessionId:relay.sessionId,
        get capabilities(){return relay.capabilities??capabilities}}
      instances.set(conversationId,value)
      return value
    })().finally(()=>creating.delete(conversationId))
    creating.set(conversationId,operation)
    return operation
  }
  function integer(url,key,max=Number.MAX_SAFE_INTEGER) {
    const raw=url.searchParams.get(key)
    if(raw===null) return undefined
    if(!/^(0|[1-9][0-9]*)$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)>max) throw new HttpError(400,'Invalid history cursor')
    return Number(raw)
  }
  function query(url,allowed) {
    for(const key of url.searchParams.keys()) if(!allowed.includes(key)||url.searchParams.getAll(key).length!==1) throw new HttpError(400,'Unsupported native conversation query')
  }
  return {
    open,
    async dispose(){
      closed=true
      await Promise.allSettled([...creating.values()])
      try{await Promise.allSettled([...instances.values()].map(item=>item.relay.dispose()));instances.clear()}finally{removeGuards()}
    },
    async handle(req,res,prefix) {
      const url=new URL(req.url,'http://localhost'),path=url.pathname.slice(prefix.length)
      if(path==='/session') {
        if(req.method!=='POST') throw new HttpError(405,'Open a native Source session explicitly')
        query(url,[])
        const body=await readJson(req,4096)
        if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['conversationId','workspaceId'].includes(key))
          ||(body.workspaceId!==undefined&&(typeof body.workspaceId!=='string'||body.workspaceId.length>128))) throw new HttpError(400,'Expected a Source conversation and optional registered workspace')
        const value=await open(body)
        return json(res,200,{sessionId:value.sessionId,conversationId:value.conversationId,workspaceId:value.workspaceId,capabilities:value.capabilities})
      }
      if(path==='/conversations'&&req.method==='GET'){query(url,[]);return json(res,200,await transport.list())}
      const parts=path.split('/').filter(Boolean)
      if(parts[0]!=='conversations') throw new HttpError(404,'Unknown native Source operation')
      const conversationId=validateConversationId(parts[1])
      if(parts.length===3&&parts[2]==='events'&&req.method==='GET') {
        query(url,['afterSeq','beforeSeq','limit'])
        const cursor={};for(const key of ['afterSeq','beforeSeq','limit']){const value=integer(url,key,key==='limit'?200:Number.MAX_SAFE_INTEGER);if(value!==undefined)cursor[key]=value}
        const snapshot=await transport.snapshot(conversationId,cursor),live=instances.get(conversationId)
        return json(res,200,{...snapshot,capabilities:live?effectiveCapabilities(snapshot.capabilities,live.capabilities):snapshot.capabilities})
      }
      if(parts.length>=4&&parts[2]==='executions') {
        const ticketId=parts[3]
        if(parts.length===4&&req.method==='GET') {
          query(url,['throughSeq','beforeSeq','limit'])
          const cursor={};for(const key of ['throughSeq','beforeSeq','limit']){const value=integer(url,key,key==='limit'?100:Number.MAX_SAFE_INTEGER);if(value!==undefined)cursor[key]=value}
          return json(res,200,await transport.trace(conversationId,ticketId,cursor))
        }
        if(parts.length===5&&['interrupt','resume'].includes(parts[4])&&req.method==='POST') {
          query(url,[])
          const body=await readJson(req,4096)
          if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['expectedAssignmentId','expectedControlSeq'].includes(key))) throw new HttpError(400,'Expected the displayed assignment and control generation')
          const result=await transport.control({conversationId,ticketId,...body,action:parts[4]})
          const live=instances.get(conversationId)
          if(live) await live.relay.refresh()
          return json(res,200,result)
        }
      }
      throw new HttpError(404,'Unknown native Source operation')
    },
  }
}
