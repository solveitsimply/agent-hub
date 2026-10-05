import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import worker from '../src/worker.mjs';
import {SqliteD1} from './d1-sqlite.mjs';
const OWNER='synthetic-coordination-capacity-owner-123456789';
function fixture(t,options){
  const DB=new SqliteD1(':memory:',options);t.after(()=>DB.close());const env={DB,OWNER_TOKEN:OWNER};
  return {DB,env,async call(token,path,body,method=body===undefined?'GET':'POST'){
    const response=await worker.fetch(new Request('https://hub.test'+path,{method,headers:{authorization:'Bearer '+token,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)}),env);
    return {status:response.status,body:await response.json(),headers:response.headers};
  }};
}
async function actor(f,name='actor',project='sample'){const r=await f.call(OWNER,'/api/principals',{name,account:name+'@example.test',projects:[project]});assert.equal(r.status,201);return r.body;}
async function session(f,a,externalId=crypto.randomUUID(),status='RUNNING',project='sample'){const r=await f.call(a.token,'/api/sessions',{externalId,machine:'fixture',label:externalId,project,status,task:'Synthetic coordination'});assert.equal(r.status,201);return r.body.session;}
const payload=(x,y,key=crypto.randomUUID(),body='hello')=>({fromSessionId:x.id,toSessionId:y.id,project:'sample',kind:'NOTE',body,idempotencyKey:key});
function legacyDuplicate(f,a,external,status='DONE'){
  const id=crypto.randomUUID();f.DB.database.prepare('INSERT INTO sessions(id,principal_id,external_id,machine,label,project,task,status,created_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,a.principal.id,external,'fixture',external,'sample','Synthetic duplicate',status,'2020-01-01T00:00:00Z','2020-01-01T00:00:00Z');return {id};
}
function seed(f,a,x,b,y,key,date,body='fixture'){
  f.DB.database.prepare('INSERT INTO messages(from_principal_id,to_principal_id,from_session_id,to_session_id,project,kind,body,idempotency_key,payload_hash,created_at,review_state) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(a.principal.id,b.principal.id,x.id,y.id,'sample','NOTE',body,key,'synthetic',date,'PENDING');
}

test('daily fairness is per chat with explicit principal/workspace limits and safe retries',async t=>{
  const f=fixture(t),a=await actor(f),b=await actor(f,'peer'),x=await session(f,a),other=await session(f,a),y=await session(f,b);
  f.env.MESSAGE_LIMITS_JSON=JSON.stringify({sessionDaily:2,principalDaily:3,workspaceDaily:4});
  const original=payload(x,y);assert.equal((await f.call(a.token,'/api/messages',original)).status,201);
  seed(f,a,x,b,y,'pending',new Date().toISOString());
  const limited=await f.call(a.token,'/api/messages',payload(x,y));assert.equal(limited.status,429);assert.equal(limited.body.error.code,'MESSAGE_SESSION_DAILY_LIMIT');assert.ok(Number(limited.headers.get('retry-after'))>0);
  assert.equal((await f.call(a.token,'/api/messages',payload(other,y))).status,201);
  assert.equal((await f.call(a.token,'/api/messages',payload(other,y))).body.error.code,'MESSAGE_PRINCIPAL_DAILY_LIMIT');
  assert.equal((await f.call(b.token,'/api/messages',payload(y,x))).status,201);
  assert.equal((await f.call(b.token,'/api/messages',payload(y,x))).body.error.code,'MESSAGE_WORKSPACE_DAILY_LIMIT');
  assert.equal((await f.call(a.token,'/api/messages',original)).status,201);
  assert.equal((await f.call(a.token,'/api/messages',{...original,body:'changed'})).status,409);
  const limits=await f.call(a.token,'/api/limits?sessionId='+x.id);assert.deepEqual(limits.body.usage,{workspace:4,principal:3,session:2,retainedMessages:4,retainedBodyBytes:22});
  assert.equal((await f.call(b.token,'/api/limits?sessionId='+x.id)).status,403);
});

test('migration backfills retained pending history without reinstating the tiny principal cap',async t=>{
  const f=fixture(t,{throughMigration:'0009'}),a=await actor(f),b=await actor(f,'peer'),x=await session(f,a),y=await session(f,b);
  for(let i=0;i<1100;i++)seed(f,a,x,b,y,'old-'+i,'2026-01-01T00:00:00.000Z');
  const before=f.DB.database.prepare('SELECT id,payload_hash,created_at FROM messages ORDER BY id').all();
  f.DB.database.exec(readFileSync(new URL('../migrations/0010_coordination_capacity.sql',import.meta.url),'utf8'));
  assert.deepEqual(f.DB.database.prepare('SELECT id,payload_hash,created_at FROM messages ORDER BY id').all(),before);
  assert.equal((await f.call(a.token,'/api/messages',payload(x,y))).status,201);
  const limits=await f.call(a.token,'/api/limits?sessionId='+x.id);assert.equal(limits.body.usage.retainedMessages,1101);assert.equal(limits.body.usage.principal,1);
});

test('storage accounting uses UTF-8 bytes, retention frees storage but cannot replenish daily quota',async t=>{
  const f=fixture(t),a=await actor(f),b=await actor(f,'peer'),x=await session(f,a),y=await session(f,b);
  f.env.MESSAGE_LIMITS_JSON=JSON.stringify({retainedBodyBytes:5});
  const sent=await f.call(a.token,'/api/messages',payload(x,y,'unicode','éé'));assert.equal(sent.status,201);
  assert.equal((await f.call(a.token,'/api/messages',payload(x,y,'over','é'))).body.error.code,'MESSAGE_STORAGE_LIMIT');
  f.DB.database.prepare('DELETE FROM messages WHERE id=?').run(sent.body.message.id);
  const limits=await f.call(a.token,'/api/limits?sessionId='+x.id);assert.equal(limits.body.usage.retainedBodyBytes,0);assert.equal(limits.body.usage.principal,1);
  assert.equal((await f.call(a.token,'/api/messages',payload(x,y,'after','éé'))).status,201);
});

test('admission uses indexed counters instead of scanning retained messages; malformed policy fails closed',async t=>{
  const f=fixture(t),a=await actor(f),b=await actor(f,'peer'),x=await session(f,a),y=await session(f,b),prepare=f.DB.prepare.bind(f.DB);let admission;
  f.DB.prepare=sql=>{const statement=prepare(sql),bind=statement.bind;statement.bind=(...values)=>{if(sql.startsWith('INSERT INTO messages'))admission={sql,values};return bind(...values);};return statement;};
  assert.equal((await f.call(a.token,'/api/messages',payload(x,y))).status,201);
  const plan=f.DB.database.prepare('EXPLAIN QUERY PLAN '+admission.sql).all(...admission.values).map(row=>row.detail);
  assert.ok(!plan.some(detail=>/^SCAN messages$/.test(detail)));assert.ok(plan.some(detail=>detail.includes('hub_message_usage')&&detail.includes('SEARCH')));
  f.env.MESSAGE_LIMITS_JSON='{"sessionDaily":0}';assert.equal((await f.call(a.token,'/api/messages',payload(x,y))).body.error.code,'INVALID_MESSAGE_POLICY');
});

test('duplicate merge preserves history and custody, aliases old IDs, and preserves retries/replies',async t=>{
  const f=fixture(t),a=await actor(f),b=await actor(f,'peer'),external=crypto.randomUUID(),source=await session(f,a,external),target=legacyDuplicate(f,a,'codex:'+external),peer=await session(f,b);
  const original=payload(source,peer),sent=await f.call(a.token,'/api/messages',original);
  const incoming=await f.call(b.token,'/api/messages',payload(peer,source));
  await f.call(a.token,'/api/ownership/claim',{sessionId:source.id,resourceKey:'fixture/claim'});
  await f.call(a.token,'/api/sessions/'+source.id,{status:'RUNNING',task:'Current task'},'PATCH');
  const before=f.DB.database.prepare('SELECT * FROM messages ORDER BY id').all();
  const merged=await f.call(a.token,'/api/sessions/'+source.id+'/merge',{targetSessionId:target.id});assert.equal(merged.status,200);assert.equal(merged.body.session.id,target.id);assert.equal(merged.body.session.status,'RUNNING');
  assert.deepEqual(f.DB.database.prepare('SELECT * FROM messages ORDER BY id').all(),before);
  assert.equal(f.DB.database.prepare('SELECT owner_session_id FROM ownership').get().owner_session_id,target.id);
  assert.equal((await f.call(a.token,'/api/sessions/'+source.id+'/heartbeat',{})).body.session.id,target.id);
  assert.equal((await f.call(a.token,'/api/messages',original)).body.message.id,sent.body.message.id);
  for(const id of [source.id,target.id])assert.equal((await f.call(a.token,'/api/messages?sessionId='+id)).body.messages.length,2);
  assert.equal((await f.call(a.token,'/api/messages/'+incoming.body.message.id+'/ack',{sessionId:target.id})).status,200);
  const reply={...payload(target,peer),kind:'ANSWER',replyTo:incoming.body.message.id};assert.equal((await f.call(a.token,'/api/messages',reply)).status,201);
  assert.equal((await f.call(a.token,'/api/sessions/'+source.id+'/merge',{targetSessionId:target.id})).status,200);
  const registered=await f.call(a.token,'/api/sessions',{externalId:external,machine:'fixture',label:external,project:'sample',status:'RUNNING',task:'Synthetic coordination'});assert.equal(registered.status,200);assert.equal(registered.body.session.id,target.id);
  assert.equal((await f.call(a.token,'/api/sessions')).body.sessions.filter(s=>s.principalId===a.principal.id).length,1);
  const history=f.DB.database.prepare('SELECT source_snapshot_json,target_snapshot_json FROM session_aliases').get();assert.equal(JSON.parse(history.target_snapshot_json).status,'DONE');
});

test('merges cannot cross principals, projects or chat identities; merging cannot reset daily quota',async t=>{
  const f=fixture(t),a=await actor(f),b=await actor(f,'peer'),external=crypto.randomUUID(),x=await session(f,a,external),target=legacyDuplicate(f,a,'codex:'+external),foreign=await session(f,b,'codex:'+external),unrelated=await session(f,a,'codex:'+crypto.randomUUID());
  assert.equal((await f.call(a.token,'/api/sessions/'+x.id+'/merge',{targetSessionId:foreign.id})).status,403);
  assert.equal((await f.call(b.token,'/api/sessions/'+x.id+'/merge',{targetSessionId:target.id})).status,403);
  assert.equal((await f.call(a.token,'/api/sessions/'+x.id+'/merge',{targetSessionId:unrelated.id})).status,422);
  f.env.MESSAGE_LIMITS_JSON=JSON.stringify({sessionDaily:1});assert.equal((await f.call(a.token,'/api/messages',payload(x,foreign))).status,201);
  assert.equal((await f.call(a.token,'/api/sessions/'+x.id+'/merge',{targetSessionId:target.id})).status,200);
  assert.equal((await f.call(a.token,'/api/messages',payload(target,foreign))).body.error.code,'MESSAGE_SESSION_DAILY_LIMIT');
  assert.equal((await f.call(a.token,'/api/principals/'+a.principal.id,{name:'Changed'},'PATCH')).status,403);
  assert.equal((await f.call(OWNER,'/api/principals/'+a.principal.id,{name:'Development account'},'PATCH')).status,200);
  assert.equal((await f.call(a.token,'/api/me')).body.principal.name,'Development account');
});

test('namespaced registration reuses the existing chat and arbitrary provider ID case remains distinct',async t=>{
  const f=fixture(t),a=await actor(f),external=crypto.randomUUID(),original=await session(f,a,external);
  const request={externalId:'codex:'+external,machine:'fixture',label:'Same chat',project:'sample',status:'RUNNING',task:'Synthetic coordination'};
  const normalized=await f.call(a.token,'/api/sessions',request);assert.equal(normalized.status,200);assert.equal(normalized.body.session.id,original.id);assert.equal(normalized.body.session.externalId,request.externalId);
  assert.equal((await f.call(a.token,'/api/sessions',{...request,externalId:external})).body.session.id,original.id);
  const upper=await session(f,a,'claude:TaskX'),lower=await session(f,a,'claude:taskx');assert.notEqual(upper.id,lower.id);
  assert.equal((await f.call(a.token,'/api/sessions/'+upper.id+'/merge',{targetSessionId:lower.id})).status,422);
});

test('merged attribution preserves original intervals and predecessor custody',async t=>{
  const f=fixture(t),a=await actor(f),external=crypto.randomUUID(),source=await session(f,a,external),target=legacyDuplicate(f,a,'codex:'+external);
  const append=async(id,key,previousSegmentId)=>{const r=await f.call(a.token,'/api/sessions/'+id+'/attribution',{provider:'Synthetic',client:'Synthetic',model:key,idempotencyKey:key,previousSegmentId});assert.equal(r.status,201);return r.body.segment;};
  const first=await append(source.id,'one',null),other=await append(target.id,'other',null),last=await append(source.id,'two',first.id);
  for(const [id,date] of [[first.id,'2026-01-01T00:00:00Z'],[other.id,'2026-01-02T00:00:00Z'],[last.id,'2026-01-03T00:00:00Z']])f.DB.database.prepare('UPDATE session_attribution_segments SET started_at=? WHERE id=?').run(date,id);
  assert.equal((await f.call(a.token,'/api/sessions/'+source.id+'/merge',{targetSessionId:target.id})).status,200);
  const segments=(await f.call(a.token,'/api/sessions/'+target.id+'/attribution')).body.segments;
  assert.equal(segments.find(s=>s.id===first.id).endedAt,'2026-01-03T00:00:00Z');assert.equal(segments.find(s=>s.id===other.id).endedAt,null);assert.ok(segments.find(s=>s.id===last.id).endedAt);
  const next=await append(target.id,'three',last.id);assert.equal(next.sessionId,target.id);

});


test('normalization and merge recheck revocation, scope and custody at the final write',async t=>{
  for(const operation of ['normalize','merge-revoked','merge-scope','merge-observer','merge-environment','merge-policy']){
    const f=fixture(t),a=await actor(f),external=crypto.randomUUID(),source=await session(f,a,external);
    const target=operation==='normalize'?null:legacyDuplicate(f,a,'codex:'+external);
    const prepare=f.DB.prepare.bind(f.DB);let intercepted=false;
    f.DB.prepare=sql=>{const statement=prepare(sql),run=statement.run;statement.run=async()=>{
      if(!intercepted&&(sql.startsWith('UPDATE sessions SET external_id')||sql.startsWith('INSERT INTO session_aliases'))){
        intercepted=true;
        if(['normalize','merge-revoked'].includes(operation))f.DB.database.prepare('UPDATE principals SET active=0 WHERE id=?').run(a.principal.id);
        if(operation==='merge-scope')f.DB.database.prepare('UPDATE principals SET projects_json=? WHERE id=?').run('[]',a.principal.id);
        if(operation==='merge-observer'){
          f.DB.database.exec("INSERT INTO observers VALUES ('fixture-observer','Synthetic','no-credential',1,'2020-01-01','2099-01-01')");
          for(const id of [source.id])f.DB.database.prepare('INSERT INTO observer_sessions(session_id,observer_id,native_id) VALUES (?,?,?)').run(id,'fixture-observer',id);
        }
        if(operation==='merge-environment')f.DB.database.prepare('UPDATE sessions SET environment=? WHERE id=?').run('prod',target.id);
        if(operation==='merge-policy')for(const [id,limit] of [[source.id,1],[target.id,2]])f.DB.database.prepare('INSERT INTO accountability_policies(session_id,daily_limit,updated_at) VALUES (?,?,?)').run(id,limit,'2020-01-01');
      }return run();
    };return statement;};
    const result=operation==='normalize'?await f.call(a.token,'/api/sessions',{externalId:'codex:'+external,machine:'fixture',label:'Synthetic',project:'sample',status:'RUNNING',task:'Synthetic'}):await f.call(a.token,'/api/sessions/'+source.id+'/merge',{targetSessionId:target.id});
    assert.ok(intercepted);assert.equal(result.status,['normalize','merge-revoked'].includes(operation)?401:409,operation);
    assert.equal(f.DB.database.prepare('SELECT external_id,archived_at FROM sessions WHERE id=?').get(source.id).external_id,external);
    assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM session_aliases').get().n,0);
    assert.equal(f.DB.database.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='session.merged'").get().n,0);
  }
});

test('a duplicate merge copies compatible accountability policy and rejects different policies',async t=>{
  const f=fixture(t),a=await actor(f),external=crypto.randomUUID(),source=await session(f,a,external),target=legacyDuplicate(f,a,'codex:'+external);
  await f.call(OWNER,'/api/sessions/'+source.id+'/accountability-policy',{checkInEnabled:false,dailyLimit:2});
  await f.call(OWNER,'/api/sessions/'+target.id+'/accountability-policy',{checkInEnabled:false,dailyLimit:1});
  assert.equal((await f.call(a.token,'/api/sessions/'+source.id+'/merge',{targetSessionId:target.id})).body.error.code,'MERGE_POLICY_CONFLICT');
  f.DB.database.prepare('DELETE FROM accountability_policies WHERE session_id=?').run(target.id);
  assert.equal((await f.call(a.token,'/api/sessions/'+source.id+'/merge',{targetSessionId:target.id})).status,200);
  assert.equal(f.DB.database.prepare('SELECT daily_limit FROM accountability_policies WHERE session_id=?').get(target.id).daily_limit,2);
});

test('simultaneous bare and namespaced registrations cannot admit a second chat record',async t=>{
  const f=fixture(t),a=await actor(f),external=crypto.randomUUID(),prepare=f.DB.prepare.bind(f.DB);let admitted;
  f.DB.prepare=sql=>{const statement=prepare(sql),run=statement.run;statement.run=async()=>{
    if(!admitted&&sql.startsWith('INSERT INTO sessions'))admitted=legacyDuplicate(f,a,external,'RUNNING');
    return run();
  };return statement;};
  const request={externalId:'codex:'+external,machine:'fixture',label:'Synthetic',project:'sample',status:'RUNNING',task:'Synthetic'};
  const result=await f.call(a.token,'/api/sessions',request);assert.equal(result.status,200);assert.equal(result.body.session.id,admitted.id);assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,1);
  const retry=await f.call(a.token,'/api/sessions',request);assert.equal(retry.body.session.id,admitted.id);assert.equal(retry.body.session.externalId,request.externalId);
});


test('a merge winning after lookup cannot silently discard an update or heartbeat',async t=>{
  for(const operation of ['update','heartbeat']){
    const f=fixture(t),a=await actor(f),external=crypto.randomUUID(),source=await session(f,a,external),target=legacyDuplicate(f,a,'codex:'+external),prepare=f.DB.prepare.bind(f.DB);let intercepted=false;
    f.DB.prepare=sql=>{const statement=prepare(sql),run=statement.run;statement.run=async()=>{
      if(!intercepted&&sql.startsWith(operation==='update'?'UPDATE sessions SET status=':'UPDATE sessions SET last_seen_at=')){
        intercepted=true;
        f.DB.database.prepare('INSERT INTO session_aliases VALUES (?,?,?,?,?,?)').run(source.id,target.id,new Date().toISOString(),a.principal.id,'{}','{}');
        f.DB.database.prepare('UPDATE sessions SET archived_at=? WHERE id=?').run(new Date().toISOString(),source.id);
      }return run();
    };return statement;};
    const path='/api/sessions/'+source.id+(operation==='heartbeat'?'/heartbeat':'');
    const body=operation==='update'?{task:'Expected applied update'}:{};
    const result=await f.call(a.token,path,body,operation==='update'?'PATCH':'POST');assert.ok(intercepted);assert.equal(result.status,409);assert.equal(result.body.error.code,'SESSION_CHANGED');
    const retry=await f.call(a.token,path,body,operation==='update'?'PATCH':'POST');assert.equal(retry.status,200);assert.equal(retry.body.session.id,target.id);
    if(operation==='update')assert.equal(retry.body.session.task,body.task);
  }
});


test('old attribution keys retain original custody while new alias switches use canonical scope',async t=>{
  const f=fixture(t),a=await actor(f),b=await actor(f,'peer'),external=crypto.randomUUID(),source=await session(f,a,external),target=legacyDuplicate(f,a,'codex:'+external);
  const oldBody={provider:'Synthetic',client:'Synthetic old client',previousSegmentId:null,idempotencyKey:'cached-switch'},targetBody={...oldBody,client:'Synthetic target client'};
  const old=await f.call(a.token,'/api/sessions/'+source.id+'/attribution',oldBody),current=await f.call(a.token,'/api/sessions/'+target.id+'/attribution',targetBody);assert.equal(old.status,201);assert.equal(current.status,201);
  assert.equal((await f.call(a.token,'/api/sessions/'+source.id+'/merge',{targetSessionId:target.id})).status,200);
  const retry=await f.call(a.token,'/api/sessions/'+source.id+'/attribution',oldBody);assert.equal(retry.status,201);assert.equal(retry.body.segment.id,old.body.segment.id);assert.equal(retry.body.segment.sessionId,source.id);assert.ok(retry.body.segment.endedAt);
  assert.equal((await f.call(a.token,'/api/sessions/'+target.id+'/attribution',targetBody)).body.segment.id,current.body.segment.id);
  assert.equal((await f.call(a.token,'/api/sessions/'+source.id+'/attribution',{...oldBody,client:'Changed'})).body.error.code,'IDEMPOTENCY_CONFLICT');
  const nextBody={provider:'Synthetic',client:'Synthetic next client',previousSegmentId:current.body.segment.id,idempotencyKey:'next-switch'};
  const next=await f.call(a.token,'/api/sessions/'+source.id+'/attribution',nextBody);assert.equal(next.status,201);assert.equal(next.body.segment.sessionId,target.id);
  assert.equal((await f.call(a.token,'/api/sessions/'+source.id+'/attribution',nextBody)).body.segment.id,next.body.segment.id);
  assert.equal((await f.call(b.token,'/api/sessions/'+source.id+'/attribution',oldBody)).status,403);
  assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM session_attribution_segments').get().n,3);
});


test('merge rejects different environments and preserves every native binding without transfer',async t=>{
  for(const bound of ['source','target']){
    const f=fixture(t),a=await actor(f),external=crypto.randomUUID(),source=await session(f,a,external),target=legacyDuplicate(f,a,'codex:'+external);
    f.DB.database.prepare('UPDATE sessions SET environment=? WHERE id=?').run('prod',target.id);
    assert.equal((await f.call(a.token,'/api/sessions/'+source.id+'/merge',{targetSessionId:target.id})).body.error.code,'SESSION_ENVIRONMENT_CONFLICT');
    f.DB.database.prepare('UPDATE sessions SET environment=NULL WHERE id=?').run(target.id);
    const id=bound==='source'?source.id:target.id;
    const observer=await f.call(OWNER,'/api/observers',{name:'Synthetic observer',sessions:[{sessionId:id,nativeId:'exact-native'}]});assert.equal(observer.status,201);
    const before=f.DB.database.prepare('SELECT * FROM observer_sessions').all();
    assert.equal((await f.call(a.token,'/api/sessions/'+source.id+'/merge',{targetSessionId:target.id})).body.error.code,'MERGE_OBSERVER_CONFLICT');
    assert.deepEqual(f.DB.database.prepare('SELECT * FROM observer_sessions').all(),before);
    assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM session_aliases').get().n,0);
    const observation={sessionId:id,nativeId:'exact-native',sequence:0,state:'idle',observedAt:new Date().toISOString()};
    assert.equal((await f.call(observer.body.token,'/api/observer/observations',observation)).status,200);
    assert.equal((await f.call(observer.body.token,'/api/observer/observations',{...observation,nativeId:'wrong-native',sequence:1})).status,409);
    assert.equal((await f.call(observer.body.token,'/api/observer/observations',{...observation,sessionId:bound==='source'?target.id:source.id,sequence:1})).body.error.code,'OBSERVATION_CHANGED');
  }
});
