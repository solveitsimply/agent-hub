import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import {SqliteD1} from './d1-sqlite.mjs';

const OWNER='synthetic-owner-for-read-efficiency-test-1234567890';

function fixture(t,options){
  const DB=new SqliteD1(':memory:',options);
  t.after(()=>DB.close());
  const env={DB,OWNER_TOKEN:OWNER};
  return {DB,env,async call(token,path,body,method=body===undefined?'GET':'POST'){
    const headers={};if(token)headers.authorization='Bearer '+token;if(body!==undefined)headers['content-type']='application/json';
    const response=await worker.fetch(new Request('https://hub.test'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)}),env);
    return {status:response.status,body:await response.json(),headers:response.headers};
  }};
}

test('schema 0006 discovery aggregates claims once and keeps project custody',async t=>{
  const f=fixture(t,{throughMigration:'0006'}),actor=await invite(f,'old-schema',['alpha']),other=await invite(f,'foreign',['beta']);
  const session=await register(f,actor.token,'alpha','DONE','local');
  const foreign=await register(f,other.token,'beta','RUNNING','remote');
  for(const [id,project] of [[session.id,'alpha'],[foreign.id,'beta']]){
    for(let i=0;i<40;i++)f.DB.database.prepare('INSERT INTO ownership VALUES (?,?,?,?)').run(project,'claim-'+i,id,new Date().toISOString());
  }
  const statements=[],prepare=f.DB.prepare.bind(f.DB);
  f.DB.prepare=sql=>{statements.push(sql);return prepare(sql);};
  const result=await f.call(actor.token,'/api/sessions?view=full&status=DONE');
  assert.equal(result.status,200);
  assert.deepEqual(result.body.sessions.map(row=>row.id),[session.id]);
  assert.equal(result.body.sessions[0].lifecycle.heldClaims,40);
  assert.equal(result.body.summary.DONE,1);
  assert.equal(result.body.summary.RUNNING,0);
  const scans=statements.filter(sql=>sql.startsWith('SELECT s.*'));
  assert.equal(scans.length,1);
  const plan=f.DB.database.prepare('EXPLAIN QUERY PLAN '+scans[0]).all('alpha').map(row=>row.detail);
  assert.equal(plan.filter(detail=>detail==='SCAN ownership').length,1);
  assert.ok(!scans[0].includes('ownership WHERE owner_session_id=s.id'));
});

test('legacy minute trigger performs no database work or automated messaging',async()=>{
  const env={DB:{prepare(){throw new Error('Unexpected scheduled read');},withSession(){throw new Error('Unexpected session scan');}}};
  for(const scheduledTime of [Date.parse('2026-10-04T03:16:00Z'),Date.parse('2026-10-04T04:17:00Z')]){
    await worker.scheduled({cron:'* * * * *',scheduledTime},env);
  }
});

async function invite(f,name,projects){
  const result=await f.call(OWNER,'/api/principals',{name,account:name+'@example.test',projects});
  assert.equal(result.status,201);return result.body;
}

async function register(f,token,project,status,machine){
  const result=await f.call(token,'/api/sessions',{externalId:crypto.randomUUID(),machine,label:machine,project,task:'Synthetic read-path fixture',status});
  assert.equal(result.status,201);return result.body.session;
}

test('incoming inbox excludes sent echoes without skipping unread deliveries or changing custody',async t=>{
  const f=fixture(t,{throughMigration:'0006'}),a=await invite(f,'reader',['alpha']),b=await invite(f,'peer',['alpha']),foreign=await invite(f,'foreign',['beta']);
  const x=await register(f,a.token,'alpha','RUNNING','reader'),y=await register(f,b.token,'alpha','RUNNING','peer'),z=await register(f,foreign.token,'beta','RUNNING','foreign');
  const send=async(token,from,to,body)=>{const r=await f.call(token,'/api/messages',{project:'alpha',fromSessionId:from,toSessionId:to,kind:'NOTE',body,idempotencyKey:crypto.randomUUID()});assert.equal(r.status,201);return r.body.message;};
  const first=await send(b.token,y.id,x.id,'Incoming complete first body');
  const outgoing=await send(a.token,x.id,y.id,'Sent body must not reenter the default inbox');
  const second=await send(b.token,y.id,x.id,'Incoming complete second body');
  const statements=[],prepare=f.DB.prepare.bind(f.DB);f.DB.prepare=sql=>{statements.push(sql);return prepare(sql);};
  const path=`/api/messages?view=compact&direction=incoming&sessionId=${x.id}&limit=1`;
  const page=(await f.call(a.token,path)).body;
  assert.ok(statements.some(sql=>sql.startsWith('SELECT s.id,s.project,s.principal_id,s.archived_at')));
  assert.ok(!statements.some(sql=>sql.startsWith('SELECT s.*')),'inbox custody does not load lifecycle/history');
  assert.deepEqual(page.messages.map(m=>m.id),[first.id]);assert.equal(page.messages[0].body,first.body);assert.equal(page.nextCursor,first.deliveryCursor);assert.equal(page.hasMore,true);
  const next=(await f.call(a.token,path+'&after='+page.nextCursor)).body;
  assert.deepEqual(next.messages.map(m=>m.id),[second.id]);assert.equal(next.nextCursor,second.deliveryCursor);assert.equal(next.hasMore,false);
  const empty=(await f.call(a.token,path+'&after='+next.nextCursor)).body;
  assert.deepEqual(empty.messages,[]);assert.equal(empty.nextCursor,next.nextCursor);
  const all=(await f.call(a.token,`/api/messages?sessionId=${x.id}`)).body;
  assert.deepEqual(all.messages.map(m=>m.id),[first.id,outgoing.id,second.id],'HTTP/dashboard default retains both sides');
  assert.equal((await f.call(a.token,`/api/messages?direction=incoming&sessionId=${z.id}`)).status,403);
  assert.equal((await f.call(a.token,'/api/messages?direction=incoming')).status,422);
  assert.equal((await f.call(a.token,`/api/messages?direction=typo&sessionId=${x.id}`)).status,422);
  assert.equal((await f.call(a.token,`/api/messages/${outgoing.id}/ack`,{sessionId:x.id})).status,403);
  f.DB.database.prepare('UPDATE sessions SET archived_at=? WHERE id=?').run(new Date().toISOString(),x.id);
  assert.deepEqual((await f.call(a.token,path)).body.messages.map(m=>m.id),[first.id],'authorized archived history stays readable');
  assert.equal((await f.call(a.token,'/api/messages',{project:'alpha',fromSessionId:x.id,toSessionId:y.id,kind:'NOTE',body:'Archived sender',idempotencyKey:crypto.randomUUID()})).status,409);
  await f.call(OWNER,`/api/principals/${a.principal.id}`,{},'DELETE');
  assert.equal((await f.call(a.token,path)).status,401,'revocation still applies to every read');
});

test('D1 query plans use indexes for ownership, recipient delivery, check-in and opt-in reads',t=>{
  const {DB}=fixture(t),db=DB.database;
  db.prepare("INSERT INTO principals(id,name,account,role,token_hash,projects_json,created_at) VALUES ('reader','Reader','reader@example.test','agent','reader-hash','[\"alpha\"]','2026-10-04T00:00:00.000Z')").run();
  db.prepare("INSERT INTO sessions(id,principal_id,external_id,machine,label,project,task,status,environment,details_json,created_at,last_seen_at) VALUES ('reader-session','reader','thread-1','machine','Reader','alpha','query plan','RUNNING',NULL,'{}','2026-10-04T00:00:00.000Z','2026-10-04T00:00:00.000Z')").run();
  for(let i=0;i<240;i++){
    db.prepare('INSERT INTO ownership(project,resource_key,owner_session_id,claimed_at) VALUES (?,?,?,?)').run('alpha','resource-'+i,'reader-session','2026-10-04T00:00:00.000Z');
    db.prepare('INSERT INTO messages(from_principal_id,to_principal_id,from_session_id,to_session_id,project,kind,body,idempotency_key,payload_hash,created_at,review_state,delivery_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('owner','reader',null,'reader-session','alpha','NOTE','synthetic','message-'+i,'hash-'+i,'2026-10-04T00:00:00.000Z','APPROVED',i+1);
    db.prepare('INSERT INTO session_check_ins(session_id,revision,message_id,created_at) VALUES (?,?,NULL,?)').run('reader-session',i,'2026-10-03T12:00:00.000Z');
    const id='session-'+i;
    db.prepare("INSERT INTO sessions(id,principal_id,external_id,machine,label,project,task,status,environment,details_json,created_at,last_seen_at) VALUES (?,?,?,'machine','Reader','alpha','query plan','RUNNING',NULL,'{}','2026-10-04T00:00:00.000Z','2026-10-04T00:00:00.000Z')").run(id,'reader','query-plan-thread-'+i);
    db.prepare('INSERT INTO accountability_policies(session_id,check_in_enabled,grace_seconds,daily_limit,escalation_seconds,updated_at) VALUES (?, ?,300,1,900,?)').run(id,i===0?1:0,'2026-10-04T00:00:00.000Z');
  }
  db.exec('ANALYZE');
  const plan=(sql,...params)=>db.prepare('EXPLAIN QUERY PLAN '+sql).all(...params).map(row=>row.detail);
  const expectIndexed=(label,sql,params,table,terms)=>{
    const details=plan(sql,...params);
    assert.ok(details.some(detail=>detail.includes(table)&&/\bSEARCH\b/u.test(detail)&&/\bUSING (?:COVERING )?INDEX\b/u.test(detail)),`${label} should use an index; plan: ${details.join(' | ')}`);
    for(const term of terms)assert.ok(details.some(detail=>detail.includes(term)),`${label} should seek on ${term}; plan: ${details.join(' | ')}`);
    assert.ok(!details.some(detail=>new RegExp(`SCAN ${table}(?:\\s|$)`,'u').test(detail)),`${label} must not scan ${table}; plan: ${details.join(' | ')}`);
  };
  expectIndexed('ownership owner-session lookup','SELECT 1 FROM ownership WHERE owner_session_id=? LIMIT 1',['reader-session'],'ownership',['owner_session_id=?']);
  expectIndexed('recipient delivery cursor','SELECT id FROM messages WHERE to_principal_id=? AND delivery_id>? ORDER BY delivery_id LIMIT 101',['reader',0],'messages',['to_principal_id=?','delivery_id>?']);
  expectIndexed('per-session daily check-in count','SELECT COUNT(*) FROM session_check_ins WHERE session_id=? AND created_at>=?',['reader-session','2026-10-03T00:00:00.000Z'],'session_check_ins',['session_id=?','created_at>?']);
  expectIndexed('enabled accountability-policy enumeration','SELECT session_id FROM accountability_policies WHERE check_in_enabled=1',[],'accountability_policies',['check_in_enabled=?']);
});

test('session views share one baseline for cards, filters and complete summaries',async t=>{
  const f=fixture(t),alpha=await invite(f,'alpha-reader',['alpha']),other=await invite(f,'beta-reader',['alpha','beta']);
  await register(f,alpha.token,'alpha','RUNNING','alpha-live');
  const staleWaiting=await register(f,other.token,'alpha','WAITING_ON_USER','alpha-stale');
  await register(f,other.token,'beta','BLOCKED','beta-private');
  f.DB.database.prepare('UPDATE sessions SET last_seen_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z',staleWaiting.id);

  const original=f.DB.prepare.bind(f.DB),sessionScans=[];
  f.DB.prepare=sql=>{if(/SELECT s\.\*,p\.name AS principal_name/u.test(sql))sessionScans.push(sql);return original(sql);};
  const complete=await f.call(alpha.token,'/api/sessions?view=full');
  assert.equal(complete.status,200);
  assert.equal(complete.body.sessions.length,2);
  assert.deepEqual(new Set(complete.body.sessions.map(row=>row.project)),new Set(['alpha']));
  assert.equal(complete.body.accountability.total,2);
  assert.equal(sessionScans.length,1,'a complete unfiltered (<2000) view reuses its lifecycle rows');

  sessionScans.length=0;
  const byStatus=await f.call(alpha.token,'/api/sessions?view=full&status=RUNNING');
  assert.deepEqual(byStatus.body.sessions.map(row=>row.status),['RUNNING']);
  assert.equal(byStatus.body.summary.RUNNING,1);
  assert.equal(byStatus.body.summary.WAITING_ON_USER,1,'status filtering must not narrow the summary baseline');
  assert.equal(byStatus.body.summary.stale,1);
  assert.equal(byStatus.body.accountability.total,2,'status filtering must not narrow accountability');
  assert.equal(sessionScans.length,1,'status filtering reuses the authorized baseline');

  sessionScans.length=0;
  const stale=await f.call(alpha.token,'/api/sessions?view=full&staleOnly=1');
  assert.deepEqual(stale.body.sessions.map(row=>row.id),[staleWaiting.id]);
  assert.equal(stale.body.summary.RUNNING,1);
  assert.equal(stale.body.summary.WAITING_ON_USER,1);
  assert.equal(stale.body.accountability.total,2);
  assert.equal(sessionScans.length,1);
  assert.equal((await f.call(alpha.token,'/api/sessions?project=beta')).status,403,'an unauthorized project cannot enter the baseline');
});

test('the 2000 active-session ceiling retains complete counts with one scan',async t=>{
  const f=fixture(t),db=f.DB.database;
  db.exec('BEGIN');
  try{
    const insert=db.prepare('INSERT INTO sessions(id,principal_id,external_id,machine,label,project,task,status,environment,details_json,created_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    for(let i=0;i<2000;i++){
      insert.run('cap-session-'+i,'owner','cap-thread-'+i,'cap-machine','Capped session','cap-project','Synthetic cap fixture',i===1999?'BLOCKED':'RUNNING',null,'{}','2026-10-04T00:00:00.000Z','2026-10-04T00:00:00.000Z');
    }
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}

  const original=f.DB.prepare.bind(f.DB),sessionScans=[];
  f.DB.prepare=sql=>{if(/SELECT s\.\*,p\.name AS principal_name/u.test(sql))sessionScans.push(sql);return original(sql);};
  const response=await f.call(OWNER,'/api/sessions?view=full&project=cap-project');
  assert.equal(response.status,200);
  assert.equal(response.body.sessions.length,200,'the response page remains bounded');
  assert.equal(response.body.total,2000);
  assert.equal(response.body.summary.RUNNING,1999);
  assert.equal(response.body.summary.BLOCKED,1);
  assert.equal(response.body.accountability.total,2000,'the full capped population remains in accountability counts');
  assert.equal(response.body.accountability.categories.RECONCILE,2000);
  assert.equal(sessionScans.length,1,'the admission ceiling is still a complete baseline');
});

test('authenticated D1 row-read quota errors are retryable and unexpected storage errors stay masked',async t=>{
  const f=fixture(t),agent=await invite(f,'quota-reader',['alpha']);
  const raw="Your account has exceeded D1's free tier daily row read limit; SELECT * FROM messages; token=synthetic-secret-must-not-leak";
  const installFailure=error=>{
    const original=f.DB.prepare.bind(f.DB),order=[];
    f.DB.prepare=sql=>{
      if(sql.includes('FROM principals WHERE token_hash='))order.push('authenticated principal lookup');
      if(sql.includes('SELECT s.*,p.name AS principal_name')){
        order.push('session read');
        return {bind(){return {all:async()=>{throw error;}};}};
      }
      return original(sql);
    };
    return order;
  };

  const quotaOrder=installFailure(new Error('storage read failed',{cause:new Error(raw)}));
  const start=Date.now(),quota=await f.call(agent.token,'/api/sessions');
  assert.deepEqual(quotaOrder,['authenticated principal lookup','session read']);
  assert.equal(quota.status,503);
  assert.equal(quota.body.error.code,'STORAGE_READ_QUOTA_EXCEEDED');
  assert.match(quota.body.error.message,/resets at 00:00 UTC/u);
  assert.ok(!JSON.stringify(quota.body).includes(raw));
  assert.ok(!JSON.stringify(quota.body).includes(agent.token));
  assert.ok(!JSON.stringify(quota.body).includes('SELECT *'));
  const retry=Number(quota.headers.get('retry-after'));
  const midnight=Math.floor(start/86400000)*86400000+86400000;
  assert.ok(Number.isInteger(retry)&&retry>=1&&retry<=86400);
  assert.ok(Math.abs(retry-Math.ceil((midnight-Date.now())/1000))<=2,'Retry-After should point to the next UTC midnight');

  const generic=fixture(t);
  const other=await invite(generic,'generic-reader',['alpha']);
  const genericOrder=(()=>{
    const original=generic.DB.prepare.bind(generic.DB),order=[];
    generic.DB.prepare=sql=>{
      if(sql.includes('FROM principals WHERE token_hash='))order.push('authenticated principal lookup');
      if(sql.includes('SELECT s.*,p.name AS principal_name'))return {bind(){return {all:async()=>{order.push('session read');throw new Error('synthetic driver failure; SELECT secret_column');}};}};
      return original(sql);
    };return order;
  })();
  const failure=await generic.call(other.token,'/api/sessions');
  assert.deepEqual(genericOrder,['authenticated principal lookup','session read']);
  assert.equal(failure.status,500);
  assert.equal(failure.body.error.code,'INTERNAL_ERROR');
  assert.ok(!JSON.stringify(failure.body).includes('synthetic driver failure'));
  assert.ok(!JSON.stringify(failure.body).includes('secret_column'));
  assert.equal(failure.headers.get('retry-after'),null);
});

test('capability detection survives new request sessions and keeps databases isolated',async t=>{
  const {coordinationDatabaseSession,hasCoordinationSchema,inboxCursorIndexes}=await import('../src/coordination-capacity.mjs');
  const f=fixture(t),old=fixture(t,{throughMigration:'0009'}),statements=[];
  const binding={withSession(){return {prepare(sql){statements.push(sql);return f.DB.prepare(sql);}};}};
  for(let i=0;i<4;i++){
    const db=coordinationDatabaseSession(binding);
    assert.equal(await hasCoordinationSchema(db),true);
    assert.equal(await inboxCursorIndexes(db),true);
  }
  assert.equal(statements.filter(sql=>sql==='SELECT scope FROM hub_message_usage LIMIT 0').length,1);
  assert.equal(statements.filter(sql=>sql.includes("type='index'")).length,1);
  assert.ok(!statements.some(sql=>sql.includes("type='table'")));
  const oldBinding={withSession(){return {prepare:sql=>old.DB.prepare(sql)};}};
  assert.equal(await hasCoordinationSchema(coordinationDatabaseSession(oldBinding)),false);
  old.DB.database.exec((await import('node:fs')).readFileSync(new URL('../migrations/0010_coordination_capacity.sql',import.meta.url),'utf8'));
  assert.equal(await hasCoordinationSchema(coordinationDatabaseSession(oldBinding)),true,'uncached absence sees a live additive migration');
  const broken={withSession(){return {prepare(){throw new Error('D1 quota exhausted');}};}};
  await assert.rejects(()=>hasCoordinationSchema(coordinationDatabaseSession(broken)),/quota exhausted/);
});

test('chat inbox seeks chat and delivery cursor despite unrelated history, preserving self-message deduplication',async t=>{
  const f=fixture(t),a=await invite(f,'efficient',['alpha']),b=await invite(f,'peer-efficient',['alpha']);
  const x=await register(f,a.token,'alpha','RUNNING','reader'),y=await register(f,b.token,'alpha','RUNNING','writer');
  const send=async(token,from,to,key)=>{
    const r=await f.call(token,'/api/messages',{project:'alpha',fromSessionId:from,toSessionId:to,kind:'NOTE',body:key,idempotencyKey:key});
    assert.equal(r.status,201);return r.body.message;
  };
  const first=await send(b.token,y.id,x.id,'first-seek'),self=await send(a.token,x.id,x.id,'self-seek');
  const last=await send(b.token,y.id,x.id,'last-seek');
  const unrelated=f.DB.database.prepare('INSERT INTO messages(from_principal_id,to_principal_id,from_session_id,to_session_id,project,kind,body,idempotency_key,payload_hash,created_at,review_state,delivery_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  for(let i=0;i<2000;i++)unrelated.run(b.principal.id,b.principal.id,y.id,y.id,'alpha','NOTE','unrelated','unrelated-'+i,'hash-'+i,new Date().toISOString(),'APPROVED',10000+i);
  const captured=[],prepare=f.DB.prepare.bind(f.DB);
  f.DB.prepare=sql=>{const statement=prepare(sql),bind=statement.bind;statement.bind=(...params)=>{if(sql.startsWith('SELECT m.*,sender'))captured.push({sql,params});return bind(...params);};return statement;};
  const result=await f.call(a.token,`/api/messages?sessionId=${x.id}&after=${first.deliveryCursor}&view=compact&limit=1`);
  assert.deepEqual(result.body.messages.map(m=>m.id),[self.id]);assert.equal(result.body.hasMore,true);
  const next=await f.call(a.token,`/api/messages?sessionId=${x.id}&after=${result.body.nextCursor}&view=compact&limit=1`);
  assert.deepEqual(next.body.messages.map(m=>m.id),[last.id]);
  const before=await f.call(a.token,`/api/messages?sessionId=${x.id}&before=${last.deliveryCursor}&view=compact&limit=2`);
  assert.deepEqual(before.body.messages.map(m=>m.id),[first.id,self.id]);
  const incoming=await f.call(a.token,`/api/messages?sessionId=${x.id}&direction=incoming&after=${last.deliveryCursor}`);
  assert.deepEqual(incoming.body.messages,[]);assert.equal(incoming.body.nextCursor,last.deliveryCursor);
  const plans=captured.map(({sql,params})=>f.DB.database.prepare('EXPLAIN QUERY PLAN '+sql).all(...params).map(r=>r.detail));
  for(const plan of plans){
    assert.ok(plan.some(d=>/messages_to_session_delivery .*to_session_id=\? AND delivery_id>\?/.test(d)),plan.join('\n'));
    assert.ok(!plan.some(d=>/SEARCH m USING INDEX messages_project_id \(project=\?\)$/.test(d)),plan.join('\n'));
  }
  assert.ok(plans[0].some(d=>d.includes('messages_from_session_delivery')));
  assert.ok(plans[2].some(d=>d.includes('delivery_id>? AND delivery_id<?')));
  assert.equal((await f.call(b.token,`/api/messages?sessionId=${x.id}`)).body.messages.length,2,'project peer sees its own conversation, not another principal self-message');
  assert.ok(captured[0].sql.includes('ORDER BY m.delivery_id ASC LIMIT 2'),'each branch bounds candidates to the requested page plus one');
  for(let i=0;i<200;i++)unrelated.run(b.principal.id,a.principal.id,y.id,x.id,'alpha',i===199?'HANDOFF':'NOTE',i===199?'needle beyond the first page':'ordinary history','related-'+i,'related-hash-'+i,new Date().toISOString(),'APPROVED',20000+i);
  const searched=await f.call(a.token,`/api/messages?sessionId=${x.id}&q=needle&view=compact&limit=1`);
  assert.equal(searched.body.messages.length,1);assert.equal(searched.body.messages[0].body,'needle beyond the first page');assert.equal(searched.body.hasMore,false,'search applies before branch limits');
  const kind=await f.call(a.token,`/api/messages?sessionId=${x.id}&kind=HANDOFF&view=compact&limit=1`);
  assert.deepEqual(kind.body.messages.map(m=>m.id),searched.body.messages.map(m=>m.id),'kind filters apply before branch limits');
  const latest=await f.call(a.token,`/api/messages?sessionId=${x.id}&latest=1&view=compact&limit=1`);
  assert.deepEqual(latest.body.messages.map(m=>m.id),searched.body.messages.map(m=>m.id));assert.equal(latest.body.hasMore,true);
});

test('repeat exact registration avoids admission scans without reopening archived or foreign identities',async t=>{
  const f=fixture(t),a=await invite(f,'register-efficient',['alpha']),other=await invite(f,'foreign-register',['alpha']);
  const request={externalId:'repeat-fixture',machine:'reader',label:'Original',project:'alpha',task:'Original task',status:'RUNNING'};
  const first=await f.call(a.token,'/api/sessions',request);assert.equal(first.status,201);
  f.env.SESSION_LIMITS_JSON=JSON.stringify({activePrincipal:1,activeWorkspace:1,retainedPrincipal:1,retainedWorkspace:1});
  const statements=[],prepare=f.DB.prepare.bind(f.DB);f.DB.prepare=sql=>{statements.push(sql);return prepare(sql);};
  const repeat=await f.call(a.token,'/api/sessions',{...request,label:'Must not overwrite',status:'DONE'});
  assert.equal(repeat.status,200);assert.equal(repeat.body.session.id,first.body.session.id);assert.equal(repeat.body.session.label,'Original');assert.equal(repeat.body.session.status,'RUNNING');
  assert.ok(!statements.some(sql=>sql.startsWith('INSERT INTO sessions')),'no quota scan for an existing registration');
  assert.equal((await f.call(a.token,'/api/sessions',{...request,machine:'different'})).status,409);
  assert.equal((await f.call(other.token,'/api/sessions',request)).status,409,'foreign principal cannot reuse capacity or identity');
  f.DB.database.prepare('UPDATE sessions SET archived_at=? WHERE id=?').run(new Date().toISOString(),first.body.session.id);
  const archived=await f.call(a.token,'/api/sessions',request);assert.equal(archived.status,200);assert.ok(archived.body.session.archivedAt,'read-only retry preserves archived receipt');
});
