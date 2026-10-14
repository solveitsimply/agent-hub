import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nativeRelayApi,nativeRelayEnrollment} from '../src/native-relay.mjs';
import worker from '../src/worker.mjs';
import {SqliteD1} from './d1-sqlite.mjs';

const DOMAIN='ai-profiles/native-relay/1',origin='https://hub.test';
const now=()=>Math.floor(Date.now()/1000);
const digest=async value=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))).toString('hex');
const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code});};
async function key(){const pair=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);return {...pair,publicKeyText:Buffer.from(await crypto.subtle.exportKey('raw',pair.publicKey)).toString('base64').replace(/=+$/,'' )};}
async function envelope(kind,value,device,{scope=origin,project='example-project',id=value.intent?.requestId??value.requestId??crypto.randomUUID()}={}){
  const payload=JSON.stringify(value),signature=Buffer.from(await crypto.subtle.sign('Ed25519',device.privateKey,new TextEncoder().encode(JSON.stringify([DOMAIN,kind,id,scope,project,payload])))).toString('base64').replace(/=+$/,'');
  return {version:1,id,origin:scope,project,payload,signature};
}
async function fixture(t){
  const db=new SqliteD1();t.after(()=>db.close());
  for(const id of ['principal-a','principal-b'])db.database.prepare("INSERT INTO principals(id,name,account,role,token_hash,projects_json,active,created_at) VALUES(?,?,?,'agent',?,'[\"example-project\"]',1,'2026-01-01')").run(id,id,id+'@example.test',id+'-hash');
  const env={NATIVE_RELAY_ENABLED:'true',HUB_USAGE_LIMITS_JSON:'{}',HUB_TRAFFIC_GUARD_REQUIRED:'true'};
  async function call(token,path,body,method=body===undefined?'GET':'POST',principal={role:'owner'}){
    const request=new Request(origin+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    const ctx={request,env,db,url:new URL(request.url),path:new URL(request.url).pathname,method,principal,readBody:async()=>body,digest,fail,json:(value,status=200)=>Response.json(value,{status})};
    try{const response=path.startsWith('/api/native-devices')?await nativeRelayEnrollment(ctx):await nativeRelayApi(ctx);return {status:response.status,body:await response.json()};}
    catch(error){if(!error.status)throw error;return {status:error.status,body:{error:{code:error.code,message:error.message}}};}
  }
  const a={...await key(),id:crypto.randomUUID()},b={...await key(),id:crypto.randomUUID()};
  async function enroll(device,other,principalId){
    const result=await call('owner','/api/native-devices',{deviceId:device.id,principalId,project:'example-project',publicKey:device.publicKeyText,peers:[other.id],profiles:[{profileId:'default:codex',app:'codex'}],canSend:true,canReceive:true,expiresInDays:1});
    assert.equal(result.status,201,JSON.stringify(result.body));device.token=result.body.token;
  }
  await enroll(a,b,'principal-a');await enroll(b,a,'principal-b');
  const native=(extra={})=>({intent:{version:1,operation:'deliver',requestId:crypto.randomUUID(),sender:a.id,recipient:b.id,reference:{deviceId:b.id,profileId:'default:codex',app:'codex',conversationId:'disposable-chat'},epoch:crypto.randomUUID(),handle:crypto.randomUUID(),bodyDigest:'a'.repeat(64),issuedAt:now(),expiresAt:now()+120,...extra},body:'Fixture text only',signature:'A'.repeat(86)});
  const requestPath=(request,operation=request.intent.operation)=>'/api/native-relay/request?peerId='+b.id+'&requestId='+request.intent.requestId+'&operation='+operation;
  return {db,env,call,a,b,native,requestPath};
}

test('relay is default-off without database work; normal credentials grant no device authority',async t=>{
  const response=await worker.fetch(new Request(origin+'/api/native-relay/pending',{headers:{authorization:'Bearer ordinary-principal'}}),{DB:{withSession(){return this},prepare(){throw new Error('disabled relay must not touch data')}},OWNER_TOKEN:'synthetic-owner-for-local-test-only-1234567890'});
  assert.equal(response.status,404);
  const f=await fixture(t);
  assert.equal((await f.call('ordinary-principal','/api/native-relay/pending')).status,401);
  f.env.HUB_USAGE_LIMITS_JSON=undefined;
  assert.equal((await f.call(f.a.token,'/api/native-relay/pending')).status,503);
});
test('only owner enrollment issues separate expiring capabilities; tokens are stored as hashes',async t=>{
  const f=await fixture(t);
  for(const role of ['agent','observer','coordinator'])assert.equal((await f.call('ordinary','/api/native-devices',{},'POST',{role})).status,403);
  const row=f.db.database.prepare('SELECT * FROM native_relay_devices WHERE id=?').get(f.a.id);
  assert.notEqual(row.token_hash,f.a.token);assert.match(row.token_hash,/^[a-f0-9]{64}$/);
  assert.equal(row.expires_at-row.created_at,86400);
});
test('signed requests are queued once and exactly one receiving worker may claim them',async t=>{
  const f=await fixture(t),request=f.native(),signed=await envelope('request',request,f.a);
  const queued=await f.call(f.a.token,'/api/native-relay/requests',signed);assert.equal(queued.status,201);assert.equal(queued.body.state,'pending');
  assert.equal((await f.call(f.a.token,'/api/native-relay/requests',signed)).status,200);
  const pending=await f.call(f.b.token,'/api/native-relay/pending');assert.equal(pending.body.pending.length,1);assert.ok(!JSON.stringify(pending.body).includes('Fixture text'));
  const body={requestId:request.intent.requestId,operation:'deliver',peerId:f.a.id,payloadHash:pending.body.pending[0].payloadHash};
  const claims=await Promise.all([f.call(f.b.token,'/api/native-relay/claim',body),f.call(f.b.token,'/api/native-relay/claim',body)]);
  assert.deepEqual(claims.map(result=>result.status).sort(),[200,409]);
  assert.equal(f.db.database.prepare('SELECT payload_json FROM native_relay_requests').get().payload_json,null);
  assert.equal((await f.call(f.b.token,'/api/native-relay/pending')).body.pending.length,0);
  const duplicate=await f.call(f.a.token,'/api/native-relay/requests',signed);assert.equal(duplicate.body.state,'claimed');
  assert.equal((await f.call(f.a.token,f.requestPath(request))).body.envelope,null); // no manufactured acceptance
  assert.equal(f.db.database.prepare('SELECT retained FROM native_relay_capacity').get().retained,1);
});
test('changed content, forged keys, wrong origins, stale intents and schema drift fail closed',async t=>{
  const f=await fixture(t),request=f.native();
  const original=await envelope('request',request,f.a);
  const forged={...original,signature:'A'.repeat(86)};assert.equal((await f.call(f.a.token,'/api/native-relay/requests',forged)).status,403);
  const changed={...original,payload:original.payload.replace('Fixture text','Changed text')};assert.equal((await f.call(f.a.token,'/api/native-relay/requests',changed)).status,403);
  for(const extra of [{version:2},{operation:'approve'},{expiresAt:now()-1},{issuedAt:now()+20},{expiresAt:now()+121},{recipient:f.a.id},{reference:{deviceId:f.b.id,profileId:'other-profile',app:'codex',conversationId:'chat'}},{reference:{deviceId:f.a.id,profileId:'default:codex',app:'codex',conversationId:'chat'}}]){
    assert.notEqual((await f.call(f.a.token,'/api/native-relay/requests',await envelope('request',f.native(extra),f.a))).status,201);
  }
  assert.equal((await f.call(f.a.token,'/api/native-relay/requests',await envelope('request',request,f.a,{scope:'https://other.test'}))).status,422);
  assert.equal((await f.call(f.a.token,'/api/native-relay/requests',await envelope('request',request,f.a,{project:'other-project'}))).status,422);
  assert.equal((await f.call(f.a.token,'/api/native-relay/requests',original)).status,201);
  request.body='Changed text';assert.equal((await f.call(f.a.token,'/api/native-relay/requests',await envelope('request',request,f.a))).status,409);
});
test('receipts require the exact receiving claim and signed request identity',async t=>{
  const f=await fixture(t),request=f.native();await f.call(f.a.token,'/api/native-relay/requests',await envelope('request',request,f.a));
  const pending=(await f.call(f.b.token,'/api/native-relay/pending')).body.pending[0];
  const claim=(await f.call(f.b.token,'/api/native-relay/claim',{requestId:request.intent.requestId,operation:'deliver',peerId:f.a.id,payloadHash:pending.payloadHash})).body;
  const reply={requestId:request.intent.requestId,sender:f.b.id,recipient:f.a.id,result:{state:'unknown'},signature:'A'.repeat(86)};
  const body={requestId:request.intent.requestId,operation:'deliver',peerId:f.a.id,claimId:claim.claimId,envelope:await envelope('reply',reply,f.b)};
  assert.equal((await f.call(f.b.token,'/api/native-relay/reply',{...body,claimId:'wrong'})).status,403);
  assert.equal((await f.call(f.a.token,'/api/native-relay/reply',{...body,peerId:f.b.id})).status,403);
  assert.equal((await f.call(f.b.token,'/api/native-relay/reply',body)).status,200);
  assert.equal((await f.call(f.b.token,'/api/native-relay/reply',body)).status,200);
  assert.deepEqual((await f.call(f.a.token,f.requestPath(request))).body.envelope,body.envelope);
  assert.equal((await f.call(f.b.token,'/api/native-relay/reply',{...body,envelope:await envelope('reply',{...reply,result:{state:'different'}},f.b)})).status,409);
});
test('revocation and project removal block queued work without touching inbox or claims',async t=>{
  const f=await fixture(t),request=f.native();await f.call(f.a.token,'/api/native-relay/requests',await envelope('request',request,f.a));
  f.db.database.prepare("UPDATE principals SET projects_json='[]' WHERE id='principal-a'").run();
  assert.equal((await f.call(f.a.token,'/api/native-relay/pending')).status,401);
  const pending=(await f.call(f.b.token,'/api/native-relay/pending')).body.pending[0];
  assert.equal((await f.call(f.b.token,'/api/native-relay/claim',{requestId:request.intent.requestId,operation:'deliver',peerId:f.a.id,payloadHash:pending.payloadHash})).status,403);
  f.db.database.prepare("UPDATE principals SET projects_json='[\"example-project\"]' WHERE id='principal-a'").run();
  assert.equal((await f.call('owner','/api/native-devices/'+f.b.id,undefined,'DELETE')).status,200);
  assert.equal((await f.call(f.b.token,'/api/native-relay/pending')).status,401);
  assert.equal(f.db.database.prepare('SELECT payload_json,state FROM native_relay_requests').get().state,'expired');
  assert.equal(f.db.database.prepare('SELECT COUNT(*) AS n FROM messages').get().n,0);
  assert.equal(f.db.database.prepare('SELECT COUNT(*) AS n FROM ownership').get().n,0);
});
test('atomic queue insertion refuses a principal revoked after validation',async t=>{
  const f=await fixture(t),request=f.native(),prepare=f.db.prepare.bind(f.db);let revoked=false;
  f.db.prepare=query=>{const statement=prepare(query),run=statement.run;statement.run=async()=>{if(!revoked&&query.startsWith('INSERT INTO native_relay_requests')){revoked=true;f.db.database.prepare("UPDATE principals SET active=0 WHERE id='principal-a'").run();}return run();};return statement;};
  assert.equal((await f.call(f.a.token,'/api/native-relay/requests',await envelope('request',request,f.a))).status,409);
  assert.equal(f.db.database.prepare('SELECT retained FROM native_relay_capacity').get().retained,0);
});
test('pending capacity, daily usage and expired offline work are bounded',async t=>{
  const f=await fixture(t);
  for(let i=0;i<10;i++)assert.equal((await f.call(f.a.token,'/api/native-relay/requests',await envelope('request',f.native(),f.a))).status,201);
  assert.equal((await f.call(f.a.token,'/api/native-relay/requests',await envelope('request',f.native(),f.a))).status,409);
  f.db.database.prepare('UPDATE native_relay_requests SET expires_at=?').run(now()-1);
  assert.equal((await f.call(f.b.token,'/api/native-relay/pending')).body.pending.length,0);
  assert.equal(f.db.database.prepare('SELECT COUNT(*) AS n FROM native_relay_requests WHERE payload_json IS NOT NULL').get().n,0);
  f.db.database.prepare('UPDATE native_relay_daily_usage SET requests=100').run();
  assert.equal((await f.call(f.a.token,'/api/native-relay/requests',await envelope('request',f.native(),f.a))).status,409);
  const plans=f.db.database.prepare("EXPLAIN QUERY PLAN SELECT request_id FROM native_relay_requests WHERE recipient_id=? AND state='pending' AND expires_at>? ORDER BY expires_at LIMIT 10").all(f.b.id,now());
  assert.ok(plans.some(row=>row.detail.includes('native_relay_pending')));assert.ok(plans.every(row=>!row.detail.startsWith('SCAN native_relay_requests')));
});
test('signed peer info is scoped, fresh and cannot be replaced by a request envelope',async t=>{
  const f=await fixture(t),info={deviceId:f.b.id,epoch:crypto.randomUUID(),enabled:true,publicKey:f.b.publicKeyText,issuedAt:now(),expiresAt:now()+900};
  const value=await envelope('info',info,f.b);
  assert.equal((await f.call(f.b.token,'/api/native-relay/info',value,'PUT')).status,200);
  assert.deepEqual((await f.call(f.a.token,'/api/native-relay/info?peerId='+f.b.id)).body.envelope,value);
  assert.equal((await f.call(f.b.token,'/api/native-relay/info',await envelope('request',info,f.b),'PUT')).status,403);
  f.db.database.prepare('UPDATE native_relay_devices SET info_expires_at=? WHERE id=?').run(now()-1,f.b.id);
  assert.equal((await f.call(f.a.token,'/api/native-relay/info?peerId='+f.b.id)).status,409);
});

test('queue identity is separate from the native request so receipt refreshes remain fresh',async t=>{
  const f=await fixture(t),request=f.native({operation:'receipt'});request.body='';
  for(let i=0;i<2;i++){
    const signed=await envelope('request',request,f.a,{id:crypto.randomUUID()});
    assert.equal((await f.call(f.a.token,'/api/native-relay/requests',signed)).status,201);
  }
  const rows=f.db.database.prepare('SELECT request_id,native_request_id FROM native_relay_requests').all();
  assert.equal(rows.length,2);assert.notEqual(rows[0].request_id,rows[1].request_id);
  assert.ok(rows.every(row=>row.native_request_id===request.intent.requestId));
});
test('explicit reenrollment rotates a revoked capability without transferring old project custody',async t=>{
  const f=await fixture(t),before=f.a.token;
  await f.call('owner','/api/native-devices/'+f.a.id,undefined,'DELETE');
  const input={deviceId:f.a.id,principalId:'principal-a',project:'example-project',publicKey:f.a.publicKeyText,peers:[f.b.id],profiles:[{profileId:'default:codex',app:'codex'}],canSend:true,canReceive:true,expiresInDays:1};
  assert.equal((await f.call('owner','/api/native-devices',{...input,principalId:'principal-b'})).status,409);
  const result=await f.call('owner','/api/native-devices',input);assert.equal(result.status,201);assert.notEqual(result.body.token,before);
  assert.equal((await f.call(before,'/api/native-relay/self')).status,401);
  assert.equal((await f.call(result.body.token,'/api/native-relay/self')).body.deviceId,f.a.id);
  const list=await f.call('owner','/api/native-devices');assert.ok(!JSON.stringify(list.body).includes('token_hash'));assert.ok(!JSON.stringify(list.body).includes(result.body.token));
});
test('a concurrent sender revocation prevents claim and never requeues the body',async t=>{
  const f=await fixture(t),request=f.native();await f.call(f.a.token,'/api/native-relay/requests',await envelope('request',request,f.a));
  const pending=(await f.call(f.b.token,'/api/native-relay/pending')).body.pending[0],prepare=f.db.prepare.bind(f.db);let revoked=false;
  f.db.prepare=query=>{const statement=prepare(query),run=statement.run;statement.run=async()=>{if(!revoked&&query.startsWith("UPDATE native_relay_requests SET state='claimed'")){revoked=true;f.db.database.prepare('UPDATE native_relay_devices SET active=0 WHERE id=?').run(f.a.id);}return run();};return statement;};
  const claim=await f.call(f.b.token,'/api/native-relay/claim',{requestId:request.intent.requestId,operation:'deliver',peerId:f.a.id,payloadHash:pending.payloadHash});
  assert.equal(claim.status,409);assert.equal(f.db.database.prepare('SELECT state FROM native_relay_requests').get().state,'pending');
});
