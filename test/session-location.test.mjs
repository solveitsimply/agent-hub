import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import {SqliteD1} from './d1-sqlite.mjs';

const OWNER='synthetic-location-owner-12345678901234567890';
const NATIVE='12345678-1234-4234-8234-123456789abc';
const DEVICE='22345678-1234-4234-8234-123456789abc';
async function fixture(t){
 const DB=new SqliteD1();t.after(()=>DB.close());const env={DB,OWNER_TOKEN:OWNER};
 const call=async(token,path,body,method=body===undefined?'GET':'POST')=>{const response=await worker.fetch(new Request('https://hub.test/api'+path,{method,headers:{authorization:'Bearer '+token,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:response.status,body:await response.json()};};
 const actor=(await call(OWNER,'/principals',{name:'Synthetic executor',account:'executor@example.test',projects:['demo']})).body;
 const other=(await call(OWNER,'/principals',{name:'Other executor',account:'other@example.test',projects:['demo']})).body;
 const s=(await call(actor.token,'/sessions',{externalId:'codex:'+NATIVE,machine:'old-host',label:'Synthetic objective',project:'demo',task:'Keep this task',status:'BLOCKED'})).body.session;
 const payload=()=>({requestId:crypto.randomUUID(),expectedRevision:s.lifecycle.revision,expectedLastSeenAt:s.lastSeenAt,expectedMachine:s.machine,expectedExternalId:s.externalId,expectedPrincipalId:s.principalId,expectedProject:s.project,machine:'new-host',reference:{deviceId:DEVICE,profileId:'default:codex',app:'codex',conversationId:NATIVE},nativeId:NATIVE});
 return {DB,env,call,actor,other,s,payload};
}

test('location reconciliation preserves session history, claims, task, status and report age',async t=>{
 const f=await fixture(t);assert.equal((await f.call(f.actor.token,'/ownership/claim',{sessionId:f.s.id,resourceKey:'synthetic-resource'})).status,200);
 const before=f.DB.database.prepare('SELECT * FROM sessions WHERE id=?').get(f.s.id),body=f.payload();
 const moved=await f.call(f.actor.token,`/sessions/${f.s.id}/location`,body);assert.equal(moved.status,200,JSON.stringify(moved.body));
 const after=f.DB.database.prepare('SELECT * FROM sessions WHERE id=?').get(f.s.id);
 for(const key of ['id','principal_id','external_id','project','status','task','label','created_at','last_seen_at','archived_at','checkpoint_json','checkpoint_at','closeout_json','environment'])assert.equal(after[key],before[key],key);
 assert.equal(after.machine,'new-host');assert.equal(after.revision,before.revision+1);
 assert.equal(f.DB.database.prepare('SELECT owner_session_id FROM ownership').get().owner_session_id,f.s.id);
 assert.equal(moved.body.session.details.nativeLocation.source,'operator_confirmed');
 assert.equal((await f.call(f.actor.token,`/sessions/${f.s.id}/location`,body)).body.reused,true);
 assert.equal((await f.call(f.actor.token,`/sessions/${f.s.id}/location`,{...body,machine:'third-host'})).status,409);
 assert.equal(f.DB.database.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='session.location.confirmed'").get().n,1);
 const patch=await f.call(f.actor.token,`/sessions/${f.s.id}`,{details:{recoveryBoundary:'Synthetic boundary'}},'PATCH');assert.equal(patch.status,200);
 assert.deepEqual(patch.body.session.details.nativeLocation,moved.body.session.details.nativeLocation);
});

test('location cannot adopt a foreign principal, project, identity or observed session',async t=>{
 const f=await fixture(t),route=`/sessions/${f.s.id}/location`,body=f.payload();
 assert.equal((await f.call(f.other.token,route,body)).status,403);
 assert.equal((await f.call(OWNER,route,body)).status,403);
 for(const change of [{expectedRevision:99},{expectedMachine:'other'},{expectedProject:'other'},{expectedPrincipalId:'other'},{nativeId:DEVICE},{reference:{...body.reference,conversationId:DEVICE}}])assert.ok([409,422].includes((await f.call(f.actor.token,route,{...body,...change})).status));
 assert.equal((await f.call(f.actor.token,route,{...body,status:'DONE'})).status,422);
 const observer=await f.call(OWNER,'/observers',{name:'Synthetic native observer',sessions:[{sessionId:f.s.id,nativeId:NATIVE}]});assert.equal(observer.status,201);
 assert.equal((await f.call(f.actor.token,route,body)).status,409);
 assert.equal(f.DB.database.prepare('SELECT machine FROM sessions WHERE id=?').get(f.s.id).machine,'old-host');
});

test('location write rechecks revocation, project scope, revision, archive, observer and details races',async t=>{
 for(const race of ['revoked','project','profile','revision','archive','observer','details']){
  const f=await fixture(t),prepare=f.DB.prepare.bind(f.DB);let injected=false;
  f.DB.prepare=query=>{const statement=prepare(query),run=statement.run;statement.run=async()=>{
   if(!injected&&query.startsWith('UPDATE sessions SET machine=')){injected=true;
    if(race==='revoked')f.DB.database.prepare('UPDATE principals SET active=0 WHERE id=?').run(f.actor.principal.id);
    if(race==='project')f.DB.database.prepare("UPDATE principals SET projects_json='[]' WHERE id=?").run(f.actor.principal.id);
    if(race==='profile')f.DB.database.prepare("UPDATE principals SET access_profile='observer' WHERE id=?").run(f.actor.principal.id);
    if(race==='revision')f.DB.database.prepare('UPDATE sessions SET revision=revision+1 WHERE id=?').run(f.s.id);
    if(race==='archive')f.DB.database.prepare('UPDATE sessions SET archived_at=? WHERE id=?').run(new Date().toISOString(),f.s.id);
    if(race==='details')f.DB.database.prepare("UPDATE sessions SET details_json='{} ' WHERE id=?").run(f.s.id);
    if(race==='observer'){f.DB.database.prepare("INSERT INTO observers VALUES ('observer','Synthetic','hash',1,?,?)").run(new Date().toISOString(),'2099-01-01T00:00:00Z');f.DB.database.prepare("INSERT INTO observer_sessions(session_id,observer_id,native_id) VALUES (?,'observer',?)").run(f.s.id,NATIVE);}
   }return run();};return statement;};
  const result=await f.call(f.actor.token,`/sessions/${f.s.id}/location`,f.payload());assert.ok([401,403,409].includes(result.status),race+':'+result.status);
  assert.equal(f.DB.database.prepare('SELECT machine FROM sessions WHERE id=?').get(f.s.id).machine,'old-host',race);
 }
});
