/** Exact private Source operations; never a generic management or Session gateway. */
import { HttpError, validateMessage } from './security.js'
import { validateConversationId } from './conversation-store.js'
import { requestJson } from './upstream.js'
const ROOT = '/superagent-desktop-inbox/conversations'
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
const nonnegative = value => Number.isSafeInteger(value) && value >= 0
function query(values) {
  const result=new URLSearchParams()
  for(const [key,value] of Object.entries(values)) if(value!==undefined) {
    if(!nonnegative(value)) throw new HttpError(400,'Invalid Source cursor or page limit')
    result.set(key,String(value))
  }
  return result.size?'?'+result.toString():''
}
export function createSourceTransport({base,token,read=requestJson}) {
  const call=(path,options={})=>read(base,path,{token:token(),...options})
  const scoped=conversationId=>ROOT+'/'+validateConversationId(conversationId)
  return {
    async capabilities() {
      const value=await call(ROOT+'/capabilities')
      if(value?.version!==1||value.source!=='superagent'||typeof value.submit!=='boolean') throw new HttpError(502,'Unsupported Superagent capability format')
      return value
    },
    async list() { return call(ROOT) },
    async snapshot(conversationId,cursor={afterSeq:0}) {
      if(!cursor||typeof cursor!=='object'||Object.keys(cursor).some(key=>!['afterSeq','beforeSeq','limit'].includes(key))) throw new HttpError(400,'Unsupported Source conversation cursor')
      const value=await call(scoped(conversationId)+'/events'+query(cursor))
      if(value?.version!==1||value.conversationId!==conversationId||!Array.isArray(value.events)||value.events.some(event=>!nonnegative(event.seq)||event.seq===0||event.conversationId!==conversationId||!['user','assistant'].includes(event.role)||typeof event.text!=='string')) throw new HttpError(502,'Unsupported Source event format')
      return value
    },
    async submit(value) {
      const input=validateMessage(value),conversationId=input.conversationId??'main'
      const result=await call('/superagent-desktop-inbox/messages',{method:'POST',body:input})
      if(result?.accepted!==true||typeof result.id!=='string'||result.conversationId!==conversationId||result.requestId!==input.requestId) throw new HttpError(502,'Source did not confirm the exact request receipt')
      return result
    },
    async upload({conversationId,requestId,name,mediaType,data}) {
      if(typeof requestId!=='string'||!/^[a-zA-Z0-9_-]{16,100}$/.test(requestId)||typeof name!=='string'||name.length>1024
        ||typeof mediaType!=='string'||mediaType.length>200||typeof data!=='string'||data.length>27962028)throw new HttpError(400,'Invalid Source attachment upload')
      return call(scoped(conversationId)+'/attachments',{method:'POST',body:{requestId,name,mediaType,data},timeout:20000,maxBytes:65536})
    },
    async attachment({conversationId,requestId,messageId,receipt}) {
      if(typeof requestId!=='string'||!/^[a-zA-Z0-9_-]{16,100}$/.test(requestId)||!identifier(messageId)
        ||typeof receipt!=='string'||!/^[a-zA-Z0-9_-]{16,128}$/.test(receipt))throw new HttpError(400,'Invalid Source attachment scope')
      return call(scoped(conversationId)+'/attachments/'+receipt+'?'+new URLSearchParams({requestId,messageId}),{timeout:20000,maxBytes:30*1024*1024})
    },
    async receipt(conversationId,requestId) {
      if(typeof requestId!=='string'||!/^[a-zA-Z0-9_-]{16,100}$/.test(requestId)) throw new HttpError(400,'Invalid Source request identity')
      return call(scoped(conversationId)+'/receipt/'+requestId)
    },
    async trace(conversationId,ticketId,cursor={}) {
      if(!identifier(ticketId)||!cursor||Object.keys(cursor).some(key=>!['throughSeq','beforeSeq','limit'].includes(key))) throw new HttpError(400,'Unsupported execution history request')
      return call(scoped(conversationId)+'/executions/'+ticketId+query(cursor),{maxBytes:262144})
    },
    async control({conversationId,ticketId,expectedAssignmentId,expectedControlSeq,action}) {
      if(!identifier(ticketId)||!identifier(expectedAssignmentId)||!nonnegative(expectedControlSeq)||!['interrupt','resume'].includes(action)) throw new HttpError(400,'Expected an explicit execution and its current control generation')
      return call(scoped(conversationId)+'/executions/'+ticketId+'/'+action,{method:'POST',body:{expectedAssignmentId,expectedControlSeq}})
    },
  }
}
