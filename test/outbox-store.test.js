import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOutboxStore } from '../src/outbox-store.js'
const state = status => ({ version:1, conversationId:'main', requests:[{ requestId:'request-000000000001',text:'Do not lose this draft',state:status,message:{id:'local-id',role:'user',content:[{type:'text',text:'Do not lose this draft'}],source:{kind:'human'}} }] })
test('native admission outbox synchronously persists uncertain requests through process-local reload', () => {
  const root = mkdtempSync(join(tmpdir(),'dsh-outbox-'))
  try {
    const first=createOutboxStore({root,conversationId:'main'})
    assert.equal(first.load(),undefined)
    first.save(state('queued')); assert.deepEqual(first.load(),state('queued'))
    first.save(state('unknown'))
    assert.deepEqual(createOutboxStore({root,conversationId:'main'}).load(),state('unknown'))
    assert.equal(readdirSync(root).length,1)
    assert.ok(readFileSync(join(root,readdirSync(root)[0]),'utf8').includes('unknown'))
  } finally { rmSync(root,{recursive:true,force:true}) }
})
test('storage preserves legacy long uncertain records without treating admission limits as corruption',()=>{
  const root=mkdtempSync(join(tmpdir(),'dsh-outbox-'))
  try{
    const record=state('unknown');record.requests[0].text='x'.repeat(12001);record.requests[0].message.content[0].text=record.requests[0].text
    createOutboxStore({root,conversationId:'main'}).save(record)
    assert.deepEqual(createOutboxStore({root,conversationId:'main'}).load(),record)
  }finally{rmSync(root,{recursive:true,force:true})}
})
test('a failed save preserves the previously durable outbox and never changes conversation ownership', () => {
  const root = mkdtempSync(join(tmpdir(),'dsh-outbox-'))
  try {
    const store=createOutboxStore({root,conversationId:'main'}); store.save(state('unknown'))
    assert.throws(()=>store.save({...state('queued'),conversationId:'other'}))
    assert.throws(()=>store.save({...state('queued'),extra:undefined}))
    assert.throws(()=>store.save({...state('queued'),requests:[{...state('queued').requests[0],text:'x'.repeat(10*1024*1024)}]}))
    assert.deepEqual(store.load(),state('unknown'))
    const file=join(root,readdirSync(root)[0]); writeFileSync(file,'{broken')
    assert.throws(()=>store.load(),/refusing to discard/)
  } finally { rmSync(root,{recursive:true,force:true}) }
})
