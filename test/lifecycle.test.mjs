import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import {SqliteD1} from './d1-sqlite.mjs';
import {nativeState,collectObservations,connectCodex} from '../scripts/native-observer.mjs';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const OWNER='synthetic-lifecycle-owner-12345678901234567890';
function fixture(t){const DB=new SqliteD1();t.after(()=>DB.close());const env={DB,OWNER_TOKEN:OWNER};return {DB,env,async call(token,path,body,method=body===undefined?'GET':'POST'){
  const response=await worker.fetch(new Request('https://hub.test/api'+path,{method,headers:{authorization:'Bearer '+token,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:response.status,body:await response.json()};
}};}
async function setup(t){const f=fixture(t);const actor=(await f.call(OWNER,'/principals',{name:'Synthetic executor',account:'executor@example.test',projects:['demo']})).body;
const other=(await f.call(OWNER,'/principals',{name:'Other executor',account:'other@example.test',projects:['other']})).body;
const s=(await f.call(actor.token,'/sessions',{externalId:'codex:native-demo',machine:'synthetic-host',label:'Synthetic objective',project:'demo',task:'Complete fixture',status:'RUNNING'})).body.session;
return {...f,actor,other,s};}
const cp=(extra={})=>({outcome:'Ship synthetic fixture',acceptanceCriteria:'Reviewed acceptance evidence',nextAction:'Run the scoped verification',nextCheckAt:new Date(Date.now()-600000).toISOString(),...extra});
async function checkpoint(f,checkpoint=cp()){const current=(await f.call(f.actor.token,`/sessions/${f.s.id}/checkpoint`)).body.lifecycle;return f.call(f.actor.token,`/sessions/${f.s.id}/checkpoint`,{expectedRevision:current.revision,checkpoint},'PUT');}
async function observer(f){const result=await f.call(OWNER,'/observers',{name:'Read-only fixture',sessions:[{sessionId:f.s.id,nativeId:'native-demo'}]});assert.equal(result.status,201);return result.body;}
async function observe(f,o,state,sequence=0,extra={}){return f.call(o.token,'/observer/observations',{sessionId:f.s.id,nativeId:'native-demo',sequence,state,observedAt:new Date().toISOString(),...extra});}

test('checkpoint conditional updates preserve foreign custody and old clients',async t=>{
 const f=await setup(t);assert.equal(f.s.lifecycle.revision,0);assert.equal(f.s.lifecycle.attention,'RECONCILE');
 assert.equal((await checkpoint(f)).status,200);
 assert.equal((await f.call(f.other.token,`/sessions/${f.s.id}/checkpoint`,{expectedRevision:1,checkpoint:cp()},'PUT')).status,403);
 assert.equal((await f.call(OWNER,`/sessions/${f.s.id}/checkpoint`,{expectedRevision:1,checkpoint:cp()},'PUT')).status,403);
 assert.equal((await f.call(f.actor.token,`/sessions/${f.s.id}/checkpoint`,{expectedRevision:0,checkpoint:cp()},'PUT')).status,409);
 assert.equal((await f.call(f.actor.token,`/sessions/${f.s.id}/heartbeat`,{})).body.session.lifecycle.revision,1);
 assert.equal((await f.call(f.actor.token,`/sessions/${f.s.id}`,{task:'User changed the objective'},'PATCH')).body.session.lifecycle.revision,2);
 assert.equal((await f.call(f.actor.token,`/sessions/${f.s.id}/checkpoint`,{expectedRevision:2,checkpoint:cp({lastProgressAt:'2099-01-01T00:00:00Z'})},'PUT')).status,422);
 assert.equal((await checkpoint(f,cp({wait:{kind:'agent',reason:'Dependency',sessionId:f.s.id}}))).status,422);
});

test('registration may capture the first checkpoint without overwriting it on retry',async t=>{
 const f=await setup(t),body={externalId:'synthetic-initial-checkpoint',machine:'synthetic-host',label:'Initial checkpoint',project:'demo',task:'Complete fixture',status:'RUNNING',checkpoint:cp({nextCheckAt:new Date(Date.now()+3600000).toISOString()})};
 const first=await f.call(f.actor.token,'/sessions',body);assert.equal(first.status,201);assert.equal(first.body.session.lifecycle.checkpoint.outcome,body.checkpoint.outcome);assert.equal(first.body.session.lifecycle.revision,0);
 const second=await f.call(f.actor.token,'/sessions',{...body,checkpoint:cp({outcome:'Should not overwrite'})});assert.equal(second.status,200);assert.equal(second.body.session.id,first.body.session.id);assert.equal(second.body.session.lifecycle.checkpoint.outcome,body.checkpoint.outcome);
});

test('enrolled peers may read lifecycle evidence while only its executor can write it',async t=>{
 const f=await setup(t);await checkpoint(f);
 const peer=(await f.call(OWNER,'/principals',{name:'Same-project peer',account:'peer@example.test',projects:['demo']})).body;
 assert.equal((await f.call(peer.token,`/sessions/${f.s.id}/checkpoint`)).status,200);
 assert.equal((await f.call(OWNER,`/sessions/${f.s.id}/checkpoint`)).status,200);
 assert.equal((await f.call(f.other.token,`/sessions/${f.s.id}/checkpoint`)).status,403);
 assert.equal((await f.call(peer.token,`/sessions/${f.s.id}/checkpoint`,{expectedRevision:1,checkpoint:cp()},'PUT')).status,403);
});

test('observer is exact-scope, read-only, time bounded and sequence ordered',async t=>{
 const f=await setup(t),o=await observer(f);await checkpoint(f);
 assert.equal((await f.call(f.actor.token,'/observers',{name:'Forged observer',sessions:[]})).status,403);
 for(const path of ['/me','/sessions','/messages','/ownership','/principals'])assert.equal((await f.call(o.token,path)).status,403,path);
 assert.equal((await f.call(f.actor.token,'/observer')).status,401);
 assert.equal((await observe(f,o,'active')).status,200);
 assert.equal((await observe(f,o,'idle',0)).status,409);
 assert.equal((await observe(f,o,'idle',1,{nativeId:'another-thread'})).status,409);
 assert.equal((await observe(f,o,'idle',1,{observedAt:'2099-01-01T00:00:00Z'})).status,422);
 let life=(await f.call(f.actor.token,`/sessions/${f.s.id}/checkpoint`)).body.lifecycle;
 assert.equal(life.attention,'WORKING');assert.equal(life.overdue,true);assert.equal(life.unaccounted,false);
 const seen=f.DB.database.prepare('SELECT last_seen_at FROM sessions WHERE id=?').get(f.s.id).last_seen_at;
 assert.equal((await observe(f,o,'idle',1)).status,200);
 assert.equal(f.DB.database.prepare('SELECT last_seen_at FROM sessions WHERE id=?').get(f.s.id).last_seen_at,seen);
 life=(await f.call(f.actor.token,`/sessions/${f.s.id}/checkpoint`)).body.lifecycle;assert.equal(life.attention,'READY');
 assert.equal((await observe(f,o,'not_loaded',2)).status,200);assert.equal((await f.call(f.actor.token,`/sessions/${f.s.id}/checkpoint`)).body.lifecycle.attention,'RECONCILE');
 await f.call(OWNER,`/observers/${o.observer.id}`,{},'DELETE');assert.equal((await observe(f,o,'active',3)).status,401);
 assert.equal((await f.call(f.actor.token,`/sessions/${f.s.id}/checkpoint`)).body.lifecycle.coverage,'revoked');
});

test('scheduler overlap sends one exact inbox check-in and checkpoint resolves it',async t=>{
 const f=await setup(t);await checkpoint(f,cp({nextAction:null,wait:{kind:'external',reason:'Synthetic event'}}));
 const policy=await f.call(OWNER,`/sessions/${f.s.id}/accountability-policy`,{checkInEnabled:true});assert.equal(policy.status,200);
 await Promise.all([worker.scheduled({cron:'* * * * *',scheduledTime:Date.now()},f.env),worker.scheduled({cron:'* * * * *',scheduledTime:Date.now()},f.env)]);
 await worker.scheduled({cron:'* * * * *',scheduledTime:Date.now()},f.env);
 assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM messages').get().n,1);
 const inbox=(await f.call(f.actor.token,`/messages?sessionId=${f.s.id}`)).body.messages;
 assert.equal(inbox.length,1);assert.match(inbox[0].body,/Preserve current work/);assert.ok(inbox[0].deliveryCursor);
 assert.equal((await f.call(OWNER,`/sessions/${f.s.id}/check-in`,{expectedRevision:1})).body.reused,true);
 await f.call(f.actor.token,`/messages/${inbox[0].id}/ack`,{sessionId:f.s.id});
 assert.equal((await f.call(f.actor.token,`/sessions/${f.s.id}/checkpoint`)).body.lifecycle.checkIn.state,'acknowledged');
 await checkpoint(f,cp({nextCheckAt:new Date(Date.now()+3600000).toISOString()}));
 assert.ok(f.DB.database.prepare('SELECT resolved_at FROM session_check_ins').get().resolved_at);
 await worker.scheduled({cron:'* * * * *',scheduledTime:Date.now()},f.env);
 assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM messages').get().n,1);
});

test('known user waits, pauses, long active tools, sleep and completed work suppress questioning',async t=>{
 const f=await setup(t),o=await observer(f);await checkpoint(f);await f.call(OWNER,`/sessions/${f.s.id}/accountability-policy`,{checkInEnabled:true});
 for(const [sequence,state,goalState] of [[0,'active',null],[1,'waiting_user',null],[2,'offline',null],[3,'idle','paused'],[4,'idle','budget_limited']]){
  await observe(f,o,state,sequence,{goalState});await worker.scheduled({cron:'* * * * *'},f.env);
  assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM messages').get().n,0,state+' '+goalState);
 }
 await observe(f,o,'idle',5);await checkpoint(f,cp({wait:{kind:'user',reason:'Decision in original chat'}}));await worker.scheduled({cron:'* * * * *'},f.env);
 assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM messages').get().n,0);
 await checkpoint(f,cp({pauseReason:'Owner paused'}));await worker.scheduled({cron:'* * * * *'},f.env);assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM messages').get().n,0);
 await f.call(f.actor.token,`/sessions/${f.s.id}`,{status:'DONE'},'PATCH');await worker.scheduled({cron:'* * * * *'},f.env);
 assert.equal((await f.call(f.actor.token,`/sessions/${f.s.id}/checkpoint`)).body.lifecycle.attention,'CLEANUP');
 assert.equal((await f.call(f.actor.token,'/sessions')).body.summary.stale,0);
});

test('check-in rechecks native activity and invitation custody at its write boundary',async t=>{
 for(const race of ['native','revoked','revision','archive']){
  const f=await setup(t),o=await observer(f);await checkpoint(f,cp({nextAction:null,wait:{kind:'external',reason:'Pending event'}}));await observe(f,o,'idle');
  const prepare=f.DB.prepare.bind(f.DB);let injected=false;
  f.DB.prepare=query=>{const statement=prepare(query),run=statement.run;statement.run=async()=>{
    if(!injected && query.startsWith('INSERT INTO messages')){injected=true;
      if(race==='native')f.DB.database.prepare("UPDATE observer_sessions SET state='active' WHERE session_id=?").run(f.s.id);
      if(race==='revoked')f.DB.database.prepare('UPDATE principals SET active=0 WHERE id=?').run(f.actor.principal.id);
      if(race==='revision')f.DB.database.prepare('UPDATE sessions SET revision=revision+1 WHERE id=?').run(f.s.id);
      if(race==='archive')f.DB.database.prepare('UPDATE sessions SET archived_at=? WHERE id=?').run(new Date().toISOString(),f.s.id);
    }return run();};return statement;};
  assert.equal((await f.call(OWNER,`/sessions/${f.s.id}/check-in`,{expectedRevision:1})).status,409,race);
  assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM messages').get().n,0);
 }
});

test('daily ceiling, retention and revoked owners cannot create repeated episodes',async t=>{
 const f=await setup(t);await checkpoint(f,cp({nextAction:null,wait:{kind:'external',reason:'Event'}}));
 assert.equal((await f.call(OWNER,`/sessions/${f.s.id}/check-in`,{expectedRevision:1})).status,201);
 f.DB.database.prepare('DELETE FROM messages').run();
 assert.equal((await f.call(OWNER,`/sessions/${f.s.id}/check-in`,{expectedRevision:1})).body.reused,true);
 await checkpoint(f,cp({nextAction:null,wait:{kind:'external',reason:'Same event; changed checkpoint'}}));
 assert.equal((await f.call(OWNER,`/sessions/${f.s.id}/check-in`,{expectedRevision:2})).status,409);
 assert.equal((await f.call(f.actor.token,`/sessions/${f.s.id}/accountability-policy`,{checkInEnabled:true})).status,403);
});

test('dependency completion offers continuation but never changes native state or foreign claims',async t=>{
 const f=await setup(t),o=await observer(f);const dependency=(await f.call(f.actor.token,'/sessions',{externalId:'dependency',machine:'synthetic-host',label:'Dependency',project:'demo',task:'Dependency fixture',status:'RUNNING'})).body.session;
 await checkpoint(f,cp({nextCheckAt:new Date(Date.now()+3600000).toISOString(),wait:{kind:'agent',reason:'Wait for fixture',sessionId:dependency.id}}));await observe(f,o,'idle');
 assert.equal((await f.call(f.actor.token,`/sessions/${f.s.id}/checkpoint`)).body.lifecycle.attention,'WAITING');
 await f.call(f.actor.token,`/sessions/${dependency.id}`,{status:'DONE'},'PATCH');
 const life=(await f.call(f.actor.token,`/sessions/${f.s.id}/checkpoint`)).body.lifecycle;assert.equal(life.attention,'READY');assert.equal(life.continuation.enabled,false);
 assert.equal(f.DB.database.prepare('SELECT state FROM observer_sessions').get().state,'idle');
});

test('partial closeout stays visible, requires retained triggers and never deletes work or claims',async t=>{
 const f=await setup(t);await checkpoint(f);await f.call(f.actor.token,'/ownership/claim',{sessionId:f.s.id,resourceKey:'fixture'});await f.call(f.actor.token,`/sessions/${f.s.id}`,{status:'DONE'},'PATCH');
 const body={expectedRevision:2,objective:{state:'verified',evidence:'Synthetic acceptance complete'},workspace:{state:'retained',evidence:'Fixture evidence retained',revisitAt:'After audit'},nativeChat:{state:'retained',evidence:'Owner keeping chat',revisitAt:'Owner archive review'}};
 assert.equal((await f.call(f.actor.token,`/sessions/${f.s.id}/closeout`,body,'PUT')).status,200);
 assert.equal((await f.call(f.actor.token,`/sessions/${f.s.id}/archive`,{})).status,409);
 assert.equal((await f.call(f.actor.token,'/ownership/release',{sessionId:f.s.id,resourceKey:'fixture'})).status,200);
 assert.equal((await f.call(f.actor.token,`/sessions/${f.s.id}/checkpoint`)).body.lifecycle.attention,'COMPLETE');
 assert.equal((await f.call(f.actor.token,`/sessions/${f.s.id}/archive`,{})).status,200);
 assert.equal((await f.call(OWNER,'/observers',{name:'Archived fixture',sessions:[{sessionId:f.s.id,nativeId:'native-demo'}]})).status,409);
});

test('read-only collection separates missing runtime coverage and approval from idle',async()=>{
 assert.equal(nativeState({status:{type:'notLoaded'}}),'not_loaded');assert.equal(nativeState({status:{type:'active',activeFlags:['waitingOnApproval']}}),'waiting_user');assert.equal(nativeState({} ),null);
 const requests=[],client={async request(method,path,{body}={}){requests.push({method,path,body});return path==='/api/observer'?{capabilities:['observe'],sessions:[{sessionId:'synthetic',nativeId:'native',sequence:9}]}:{recorded:true};}};
 await collectObservations(client,async()=>({state:'active',observedAt:new Date().toISOString()}));
 assert.equal(requests[1].body.sequence,10);assert.equal(requests[1].body.state,'active');assert.deepEqual(requests.map(x=>x.path),['/api/observer','/api/observer/observations']);
});

test('connector uses only documented read methods against an existing proxy, never execution or approval',async t=>{
 const root=await mkdtemp(join(tmpdir(),'hub-observer-fixture-'));t.after(()=>rm(root,{recursive:true}));
 const binary=join(root,'synthetic-codex'),log=join(root,'reads.jsonl');
 await writeFile(binary,`#!${process.execPath}\nconst fs=require('node:fs'),readline=require('node:readline');fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({argv:process.argv.slice(2)})+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const x=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},line+'\\n');if(x.id===undefined)return;process.stdout.write(JSON.stringify({id:x.id,result:x.method==='thread/read'?{thread:{id:x.params.threadId,status:{type:'active',activeFlags:['waitingOnApproval']}}}:x.method==='thread/goal/get'?{goal:{status:'paused'}}:{}})+'\\n');});\n`,{mode:0o700});
 const connection=connectCodex({codexBinary:binary,socketPath:join(root,'existing-authority.sock')});t.after(()=>connection.close());
 const value=await connection.read('fixture-thread');assert.equal(value.state,'waiting_user');assert.equal(value.goalState,'paused');
 const calls=(await readFile(log,'utf8')).trim().split('\n').map(x=>JSON.parse(x));
 assert.deepEqual(calls[0].argv,['app-server','proxy','--sock',join(root,'existing-authority.sock')]);
 assert.deepEqual(calls.slice(1).map(x=>x.method),['initialize','initialized','thread/read','thread/goal/get']);assert.equal(calls[3].params.includeTurns,false);
});

test('coverage and attention summaries filter before the card limit, negotiated presence stays separate',async t=>{
 const f=await setup(t);const insert=f.DB.database.prepare('INSERT INTO sessions(id,principal_id,external_id,machine,label,project,task,status,created_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
 for(let i=0;i<205;i++)insert.run('fixture-'+i,f.actor.principal.id,'fixture-'+i,'synthetic-host','Fixture '+i,'demo','Unfinished fixture',i===204?'WAITING_ON_USER':'RUNNING','2020-01-01T00:00:00Z','2020-01-01T00:00:00Z');
 let result=(await f.call(f.actor.token,'/sessions')).body;assert.equal(result.sessions.length,200);assert.equal(result.accountability.total,206);assert.equal(result.accountability.categories.RECONCILE,205);assert.equal(result.accountability.categories.WAITING_USER,1);
 result=(await f.call(f.actor.token,'/sessions?attention=WAITING_USER')).body;assert.equal(result.sessions.length,1);assert.equal(result.total,1);assert.equal(result.accountability.total,206);
 assert.equal((await f.call(f.other.token,'/sessions')).body.accountability.total,0);
 await checkpoint(f,cp({presenceIntervalSeconds:600,nextCheckAt:new Date(Date.now()+3600000).toISOString()}));
 f.DB.database.prepare('UPDATE sessions SET last_seen_at=? WHERE id=?').run(new Date(Date.now()-600000).toISOString(),f.s.id);
 result=(await f.call(f.actor.token,'/sessions?staleOnly=1')).body;assert.equal(result.sessions.some(x=>x.id===f.s.id),false);assert.equal(result.summary.stale,205);
});
