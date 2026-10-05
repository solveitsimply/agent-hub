import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import {SqliteD1} from './d1-sqlite.mjs';

const OWNER='synthetic-owner-for-local-test-only-1234567890';
function fixture(t,settings={}){
 const DB=new SqliteD1();t.after(()=>DB.close());const env={DB,OWNER_TOKEN:OWNER,...settings};return {
  DB,env,
  async call(token,path,body,method=body===undefined?'GET':'POST'){
   const headers={};if(token)headers.authorization='Bearer '+token;if(body!==undefined)headers['content-type']='application/json';
   const response=await worker.fetch(new Request('https://hub.test'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)}),env);
   return {status:response.status,body:await response.json()};
  },
 };
}
async function recipient(f){
 const invited=await f.call(OWNER,'/api/principals',{name:'recipient',account:'recipient@example.test',projects:['release-wave']});
 assert.equal(invited.status,201);
 const created=await f.call(invited.body.token,'/api/sessions',{externalId:crypto.randomUUID(),machine:'fixture',label:'fixture',project:'release-wave',task:'Test quota boundary',status:'RUNNING'});
 assert.equal(created.status,201);return {principal:invited.body.principal,session:created.body.session};
}
function seedOwnerMessages(f,session,count,createdAt){
 const insert=f.DB.database.prepare(`INSERT INTO messages(from_principal_id,to_principal_id,from_session_id,to_session_id,project,kind,body,idempotency_key,payload_hash,created_at,review_state,reviewed_at)
  VALUES('owner',?,NULL,?,'release-wave','NOTE','Synthetic capacity fixture',?,?,?,'APPROVED',?)`);
 for(let index=0;index<count;index++)insert.run(session.principalId,session.id,`seed-${index}`,`hash-${index}`,createdAt,createdAt);
}
function seedAgentMessages(f,from,to,count,createdAt){
 const insert=f.DB.database.prepare(`INSERT INTO messages(from_principal_id,to_principal_id,from_session_id,to_session_id,project,kind,body,idempotency_key,payload_hash,created_at,review_state,reviewed_at)
  VALUES(?,?,?,?,'release-wave','NOTE','Synthetic workspace capacity fixture',?,?,?,'APPROVED',?)`);
 for(let index=0;index<count;index++)insert.run(from.principal.id,to.principal.id,from.session.id,to.session.id,`workspace-${index}`,`workspace-hash-${index}`,createdAt,createdAt);
}
function ownerNote(f,session,key,body=`Synthetic owner note ${key}`){
 return f.call(OWNER,'/api/messages',{toSessionId:session.id,project:'release-wave',kind:'NOTE',body,idempotencyKey:key});
}

test('the default retained sender cap stays at 1000 when no environment setting is present',async t=>{
 const f=fixture(t),to=await recipient(f);seedOwnerMessages(f,to.session,1000,'2020-01-01T00:00:00.000Z');
 const result=await ownerNote(f,to.session,'default-boundary');
 assert.equal(result.status,409);assert.equal(result.body.error.code,'MESSAGE_CAPACITY');
 assert.equal(f.DB.database.prepare("SELECT COUNT(*) AS n FROM messages WHERE from_principal_id='owner'").get().n,1000);
});

test('configured principal retained cap is atomic and exact retries remain valid at capacity',async t=>{
 const f=fixture(t,{HUB_MESSAGE_CAP_PER_PRINCIPAL_RETAINED:'2',HUB_MESSAGE_CAP_PER_PRINCIPAL_24H:'10'}),to=await recipient(f);
 const first=await ownerNote(f,to.session,'retained-1'),second=await ownerNote(f,to.session,'retained-2');
 assert.equal(first.status,201);assert.equal(second.status,201);
 assert.equal((await ownerNote(f,to.session,'retained-1')).body.message.id,first.body.message.id);
 const third=await ownerNote(f,to.session,'retained-3');
 assert.equal(third.status,409);assert.equal(third.body.error.code,'MESSAGE_CAPACITY');
 assert.equal(f.DB.database.prepare("SELECT COUNT(*) AS n FROM messages WHERE from_principal_id='owner'").get().n,2);
});

test('configured rolling 24-hour principal cap counts current rows and excludes older rows',async t=>{
 const f=fixture(t,{HUB_MESSAGE_CAP_PER_PRINCIPAL_RETAINED:'5',HUB_MESSAGE_CAP_PER_PRINCIPAL_24H:'2'}),to=await recipient(f);
 seedOwnerMessages(f,to.session,1,'2020-01-01T00:00:00.000Z');
 const first=await ownerNote(f,to.session,'rolling-1'),second=await ownerNote(f,to.session,'rolling-2');
 assert.equal(first.status,201);assert.equal(second.status,201);
 assert.equal((await ownerNote(f,to.session,'rolling-1')).body.message.id,first.body.message.id);
 const third=await ownerNote(f,to.session,'rolling-3');
 assert.equal(third.status,409);assert.equal(third.body.error.code,'MESSAGE_CAPACITY');
 assert.equal(f.DB.database.prepare("SELECT COUNT(*) AS n FROM messages WHERE from_principal_id='owner'").get().n,3);
});

test('invalid message-cap settings fail closed before a message is written',async t=>{
 for(const invalid of ['0','-1','1.5','9007199254740992','not-a-number']){
  const f=fixture(t,{HUB_MESSAGE_CAP_PER_PRINCIPAL_RETAINED:invalid}),to=await recipient(f);
  const result=await ownerNote(f,to.session,`invalid-${invalid}`);
  assert.equal(result.status,503,invalid);assert.equal(result.body.error.code,'NOT_CONFIGURED',invalid);
  assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM messages').get().n,0,invalid);
 }
});

test('workspace retained ceiling stays 10000 even when per-principal setting exceeds it',async t=>{
 const f=fixture(t,{HUB_MESSAGE_CAP_PER_PRINCIPAL_RETAINED:'10001',HUB_MESSAGE_CAP_PER_PRINCIPAL_24H:'5001'}),to=await recipient(f),from=await recipient(f);
 seedAgentMessages(f,from,to,10000,'2020-01-01T00:00:00.000Z');
 const result=await ownerNote(f,to.session,'workspace-retained-boundary');
 assert.equal(result.status,409);assert.equal(result.body.error.code,'MESSAGE_CAPACITY');
 assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM messages').get().n,10000);
});

test('workspace rolling ceiling stays 5000 even when per-principal setting exceeds it',async t=>{
 const f=fixture(t,{HUB_MESSAGE_CAP_PER_PRINCIPAL_RETAINED:'10001',HUB_MESSAGE_CAP_PER_PRINCIPAL_24H:'5001'}),to=await recipient(f),from=await recipient(f);
 seedAgentMessages(f,from,to,5000,new Date().toISOString());
 const result=await ownerNote(f,to.session,'workspace-rolling-boundary');
 assert.equal(result.status,409);assert.equal(result.body.error.code,'MESSAGE_CAPACITY');
 assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM messages').get().n,5000);
});
