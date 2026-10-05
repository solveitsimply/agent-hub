import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import worker from '../src/worker.mjs';
import {SqliteD1} from './d1-sqlite.mjs';

const OWNER='synthetic-coordinator-test-owner-1234567890';
function fixture(t,options){const DB=new SqliteD1(':memory:',options);t.after(()=>DB.close());return {DB,async call(token,path,body,method=body===undefined?'GET':'POST'){
  const response=await worker.fetch(new Request('https://hub.test'+path,{method,headers:{authorization:'Bearer '+token,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})}),{DB,OWNER_TOKEN:OWNER});return {status:response.status,body:await response.json()};
}};}
async function invite(f,name,profile='agent',projects=['alpha']){const result=await f.call(OWNER,'/api/principals',{name,account:name+'@example.test',projects,profile});assert.equal(result.status,201,JSON.stringify(result.body));return result.body;}
async function session(f,actor,project='alpha'){const result=await f.call(actor.token,'/api/sessions',{externalId:crypto.randomUUID(),machine:'synthetic',label:'Synthetic coordination',project,task:'Coordinate without taking custody',status:'RUNNING'});assert.equal(result.status,201);return result.body.session;}
async function send(f,actor,from,to,kind=to?'NOTE':'QUESTION',project='alpha'){const result=await f.call(actor.token,'/api/messages',{fromSessionId:from.id,...(to?{toSessionId:to.id}:{}),project,kind,body:to?'Peer coordination':'Question requiring a human answer',idempotencyKey:crypto.randomUUID()});assert.equal(result.status,201,JSON.stringify(result.body));return result.body.message;}
async function setup(t){const f=fixture(t),coordinator=await invite(f,'delegate','coordinator'),asker=await invite(f,'asker'),other=await invite(f,'other'),observer=await invite(f,'viewer','observer'),foreign=await invite(f,'foreign','agent',['beta']);
  const own=await session(f,coordinator),asking=await session(f,asker),peer=await session(f,other),viewing=await session(f,observer),outside=await session(f,foreign,'beta');
  const question=await send(f,asker,asking,null);return {f,coordinator,asker,other,observer,foreign,own,asking,peer,viewing,outside,question};}
function relay(x,changes={}){return {fromSessionId:x.own.id,toSessionId:x.asking.id,project:'alpha',kind:'ANSWER',body:'Yes, use the option I selected.\nKeep the original wording.',idempotencyKey:crypto.randomUUID(),replyTo:x.question.id,ownerRelay:{ownerProvided:true,sourceReference:'Human chat synthetic-turn-42'},...changes};}
function custody(f,id){return f.DB.database.prepare('SELECT to_principal_id,to_session_id,acknowledged_at,review_state,delivery_id FROM messages WHERE id=?').get(id);}
function denied(result,label){assert.ok(result.status>=400&&result.status<500,label+': '+JSON.stringify(result));}

test('owner changes a principal profile without replacing its token, identity, sessions or project scopes',async t=>{
  const f=fixture(t),actor=await invite(f,'delegate','observer'),own=await session(f,actor),before=f.DB.database.prepare('SELECT * FROM principals WHERE id=?').get(actor.principal.id);
  for(const profile of ['coordinator','agent','observer','coordinator']){
    const changed=await f.call(OWNER,'/api/principals/'+actor.principal.id,{profile},'PATCH');assert.equal(changed.status,200,JSON.stringify(changed.body));
    const me=await f.call(actor.token,'/api/me');assert.equal(me.status,200);assert.equal(me.body.principal.profile,profile);assert.equal(me.body.principal.id,actor.principal.id);assert.deepEqual(me.body.principal.projects,['alpha']);
    const row=f.DB.database.prepare('SELECT * FROM principals WHERE id=?').get(actor.principal.id);
    for(const key of ['id','name','account','role','token_hash','projects_json','created_at','active'])assert.equal(row[key],before[key],key);
    assert.equal(row.access_profile,profile==='agent'?'agent':'observer');assert.equal(row.coordinator_access,profile==='coordinator'?1:0);
    assert.equal(f.DB.database.prepare('SELECT principal_id FROM sessions WHERE id=?').get(own.id).principal_id,actor.principal.id);
  }
  for(const body of [{profile:'owner'},{profile:'coordinator',projects:['beta']},{profile:'coordinator',name:'Forged'},{profile:'coordinator',active:true}])assert.equal((await f.call(OWNER,'/api/principals/'+actor.principal.id,body,'PATCH')).status,422);
  assert.equal((await f.call(actor.token,'/api/principals/'+actor.principal.id,{profile:'agent'},'PATCH')).status,403);
  denied(await f.call(OWNER,'/api/principals/owner',{profile:'coordinator'},'PATCH'),'owner identity is immutable');
  await f.call(OWNER,'/api/principals/'+actor.principal.id,undefined,'DELETE');
  denied(await f.call(OWNER,'/api/principals/'+actor.principal.id,{profile:'coordinator'},'PATCH'),'profile change cannot reactivate revoked credentials');assert.equal((await f.call(actor.token,'/api/me')).status,401);
});

test('coordinator reads scoped conversations and coordinates under its own session identity',async t=>{
  const x=await setup(t),{f}=x,foreignQuestion=await send(f,x.foreign,x.outside,null,'QUESTION','beta'),before=custody(f,x.question.id);
  assert.equal((await f.call(x.coordinator.token,'/api/me')).body.principal.profile,'coordinator');
  const history=await f.call(x.coordinator.token,'/api/conversations?project=alpha');assert.equal(history.status,200);assert.equal(history.body.messages.find(m=>m.id===x.question.id).body,'Question requiring a human answer');assert.equal(history.body.messages.some(m=>m.id===foreignQuestion.id),false);
  assert.equal((await f.call(x.coordinator.token,'/api/conversations?project=beta')).status,403);
  assert.equal((await f.call(x.coordinator.token,'/api/conversations?sessionId='+x.outside.id)).status,403);
  const note=await send(f,x.coordinator,x.own,x.asking);assert.equal(note.fromPrincipalId,x.coordinator.principal.id);assert.equal(note.fromSessionId,x.own.id);assert.equal(note.toPrincipalId,x.asker.principal.id);
  const incoming=await send(f,x.asker,x.asking,x.own);
  assert.equal((await f.call(x.coordinator.token,'/api/messages/'+incoming.id+'/ack',{sessionId:x.own.id})).status,200);
  assert.equal((await f.call(x.coordinator.token,'/api/messages/'+x.question.id+'/ack',{})).status,403);
  assert.deepEqual(custody(f,x.question.id),before);
});

test('coordinator cannot administer access, claim resources, borrow session identity or acknowledge another inbox',async t=>{
  const x=await setup(t),{f}=x,peerMessage=await send(f,x.asker,x.asking,x.peer);
  for(const [path,body,method] of [
    ['/api/principals',{name:'Elevation',account:'synthetic',projects:['alpha'],profile:'coordinator'},'POST'],
    ['/api/principals/'+x.asker.principal.id,{profile:'observer'},'PATCH'],
    ['/api/principals/'+x.asker.principal.id,undefined,'DELETE'],
    ['/api/connections',undefined,'GET'],
    ['/api/ownership/claim',{sessionId:x.own.id,resourceKey:'synthetic/resource'},'POST'],
    ['/api/ownership/release',{sessionId:x.own.id,resourceKey:'synthetic/resource'},'POST'],
    ['/api/sessions/'+x.asking.id,{status:'DONE'},'PATCH'],
    ['/api/sessions/'+x.asking.id+'/heartbeat',{},'POST'],
    ['/api/sessions/'+x.asking.id+'/archive',{},'POST'],
    ['/api/messages/'+peerMessage.id+'/ack',{sessionId:x.peer.id},'POST'],
    ['/api/messages',{fromSessionId:x.asking.id,toSessionId:x.peer.id,project:'alpha',kind:'NOTE',body:'Impersonation',idempotencyKey:crypto.randomUUID()},'POST'],
  ])assert.equal((await f.call(x.coordinator.token,path,body,method)).status,403,path);
  assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM ownership').get().n,0);
  assert.equal((await f.call(x.coordinator.token,'/api/sessions/'+x.own.id+'/heartbeat',{})).status,200);
});

test('human answer relay preserves verbatim content and provenance without assuming owner identity or custody',async t=>{
  const x=await setup(t),{f}=x,before=custody(f,x.question.id),body=relay(x,{body:'  Yes, use the option I selected.\nKeep the original wording.\n  '}),result=await f.call(x.coordinator.token,'/api/messages',body);assert.equal(result.status,201,JSON.stringify(result.body));
  const answer=result.body.message;assert.equal(answer.kind,'ANSWER');assert.equal(answer.body,body.body);assert.equal(answer.replyTo,x.question.id);assert.equal(answer.fromPrincipalId,x.coordinator.principal.id);assert.equal(answer.fromSessionId,x.own.id);assert.equal(answer.toSessionId,x.asking.id);assert.notEqual(answer.fromPrincipalId,'owner');
  assert.deepEqual(answer.ownerRelay,{source:'delegate-reported',sourceReference:body.ownerRelay.sourceReference});assert.deepEqual(custody(f,x.question.id),before);
  const inbox=await f.call(x.asker.token,'/api/messages?sessionId='+x.asking.id+'&direction=incoming');assert.equal(inbox.status,200);const received=inbox.body.messages.find(m=>m.id===answer.id);assert.equal(received.body,body.body);assert.deepEqual(received.ownerRelay,answer.ownerRelay);
  const ownerHistory=await f.call(OWNER,'/api/conversations');assert.deepEqual(ownerHistory.body.messages.find(m=>m.id===answer.id).ownerRelay,answer.ownerRelay);
  const repeat=await f.call(x.coordinator.token,'/api/messages',body);assert.equal(repeat.status,201);assert.equal(repeat.body.message.id,answer.id);
  assert.equal((await f.call(x.coordinator.token,'/api/messages',{...body,ownerRelay:{...body.ownerRelay,sourceReference:'A different human turn'}})).status,409);
  assert.equal((await f.call(x.coordinator.token,'/api/messages',{...body,body:'Changed human answer'})).status,409);
  assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM messages WHERE from_principal_id=?').get(x.coordinator.principal.id).n,1);
});

test('relay requires a precise human claim and exact owner question, asker session and project',async t=>{
  const x=await setup(t),{f}=x,peerQuestion=await send(f,x.asker,x.asking,x.peer,'QUESTION'),ownerNote=await send(f,x.asker,x.asking,null),foreignQuestion=await send(f,x.foreign,x.outside,null,'QUESTION','beta');
  f.DB.database.prepare("UPDATE messages SET kind='NOTE' WHERE id=?").run(ownerNote.id);
  const cases=[
    {ownerRelay:undefined},{ownerRelay:null},{ownerRelay:{}},{ownerRelay:{ownerProvided:false,sourceReference:'turn'}},{ownerRelay:{ownerProvided:'true',sourceReference:'turn'}},{ownerRelay:{ownerProvided:true,sourceReference:''}},{ownerRelay:{ownerProvided:true,sourceReference:'turn',ownerPrincipalId:'owner'}},
    {kind:'NOTE'},{replyTo:null},{replyTo:peerQuestion.id},{replyTo:ownerNote.id},{replyTo:foreignQuestion.id},{toSessionId:x.peer.id},{toSessionId:null},{project:'beta'},{fromSessionId:x.asking.id},
  ];
  for(const changes of cases)denied(await f.call(x.coordinator.token,'/api/messages',relay(x,changes)),JSON.stringify(changes));
  assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM messages WHERE from_principal_id=?').get(x.coordinator.principal.id).n,0);
});

test('ordinary agents and observers cannot relay owner answers or forge provenance',async t=>{
  const x=await setup(t),{f}=x;
  for(const [actor,from] of [[x.other,x.peer],[x.observer,x.viewing]]){
    denied(await f.call(actor.token,'/api/messages',relay(x,{fromSessionId:from.id})),'owner relay is coordinator-only');
    denied(await f.call(actor.token,'/api/messages',{...relay(x,{fromSessionId:from.id,toSessionId:x.own.id,replyTo:null,kind:'NOTE'}),ownerRelay:{ownerProvided:true,sourceReference:'Pretend human instruction'}}),'metadata does not authorize ordinary messages');
  }
  const ownerAnswer=await f.call(OWNER,'/api/messages',{toSessionId:x.asking.id,project:'alpha',kind:'ANSWER',body:'Owner direct answer',idempotencyKey:crypto.randomUUID(),replyTo:x.question.id});assert.equal(ownerAnswer.status,201);assert.equal(ownerAnswer.body.message.fromPrincipalId,'owner');
});

test('downgrade and revocation cut off coordinator authority while preserving token identity',async t=>{
  const x=await setup(t),{f}=x;
  assert.equal((await f.call(OWNER,'/api/principals/'+x.coordinator.principal.id,{profile:'observer'},'PATCH')).status,200);
  assert.equal((await f.call(x.coordinator.token,'/api/conversations')).status,200);assert.equal((await f.call(x.coordinator.token,'/api/messages',relay(x))).status,403);
  assert.equal((await f.call(OWNER,'/api/principals/'+x.coordinator.principal.id,{profile:'agent'},'PATCH')).status,200);
  assert.equal((await f.call(x.coordinator.token,'/api/conversations')).status,403);denied(await f.call(x.coordinator.token,'/api/messages',relay(x)),'agent cannot relay');
  assert.equal((await f.call(OWNER,'/api/principals/'+x.coordinator.principal.id,{profile:'coordinator'},'PATCH')).status,200);
  await f.call(OWNER,'/api/principals/'+x.coordinator.principal.id,undefined,'DELETE');assert.equal((await f.call(x.coordinator.token,'/api/messages',relay(x))).status,401);
});

for(const change of ['downgrade','revoke'])test('relay insert atomically rejects a concurrent '+change,async t=>{
  const x=await setup(t),{f}=x,before=custody(f,x.question.id),prepare=f.DB.prepare.bind(f.DB);let intercepted=false;
  f.DB.prepare=sql=>{const statement=prepare(sql);if(/^INSERT INTO messages\(/u.test(sql)&&!intercepted){intercepted=true;f.DB.database.prepare(change==='revoke'?'UPDATE principals SET active=0 WHERE id=?':'UPDATE principals SET coordinator_access=0 WHERE id=?').run(x.coordinator.principal.id);}return statement;};
  denied(await f.call(x.coordinator.token,'/api/messages',relay(x)),'authority changed before insert');assert.equal(intercepted,true);
  assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM messages WHERE from_principal_id=?').get(x.coordinator.principal.id).n,0);
  assert.deepEqual(custody(f,x.question.id),before);assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM message_deliveries').get().n,0);
});

test('acknowledgment atomically rejects a coordinator downgrade to read-only observer',async t=>{
  const x=await setup(t),{f}=x,incoming=await send(f,x.asker,x.asking,x.own),prepare=f.DB.prepare.bind(f.DB);let intercepted=false;
  f.DB.prepare=sql=>{const statement=prepare(sql);if(sql.startsWith('UPDATE messages SET acknowledged_at=')&&!intercepted){intercepted=true;f.DB.database.prepare('UPDATE principals SET coordinator_access=0 WHERE id=?').run(x.coordinator.principal.id);}return statement;};
  denied(await f.call(x.coordinator.token,'/api/messages/'+incoming.id+'/ack',{sessionId:x.own.id}),'read-only observers cannot acknowledge');assert.equal(intercepted,true);
  assert.equal(f.DB.database.prepare('SELECT acknowledged_at FROM messages WHERE id=?').get(incoming.id).acknowledged_at,null);
});

test('relay does not deliver after the asking session is archived or the original question is rejected',async t=>{
  for(const change of ['archive','reject']){
    const x=await setup(t),{f}=x,prepare=f.DB.prepare.bind(f.DB);let intercepted=false;
    f.DB.prepare=sql=>{const statement=prepare(sql);if(/^INSERT INTO messages\(/u.test(sql)&&!intercepted){intercepted=true;
      if(change==='archive')f.DB.database.prepare('UPDATE sessions SET archived_at=? WHERE id=?').run(new Date().toISOString(),x.asking.id);
      else f.DB.database.prepare("UPDATE messages SET review_state='REJECTED' WHERE id=?").run(x.question.id);
    }return statement;};
    denied(await f.call(x.coordinator.token,'/api/messages',relay(x)),change+' changes relay destination custody');assert.equal(intercepted,true);
    assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM messages WHERE from_principal_id=?').get(x.coordinator.principal.id).n,0);
    assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM message_deliveries').get().n,0);
  }
});

test('schema 0008 still serves existing agents and observers; migration preserves their rights',async t=>{
  const f=fixture(t,{throughMigration:'0008'}),a=await invite(f,'existing-agent'),o=await invite(f,'existing-viewer','observer'),own=await session(f,a),question=await send(f,a,own,null);
  assert.equal((await f.call(a.token,'/api/me')).body.principal.profile,'agent');assert.equal((await f.call(o.token,'/api/conversations')).body.messages[0].id,question.id);
  const root=new URL('../migrations/',import.meta.url),file=readdirSync(root).find(name=>/^0009.*\.sql$/u.test(name));assert.ok(file,'coordinator migration exists');f.DB.database.exec(readFileSync(new URL(file,root),'utf8'));
  assert.equal((await f.call(a.token,'/api/me')).body.principal.profile,'agent');assert.equal((await f.call(o.token,'/api/me')).body.principal.profile,'observer');
  assert.deepEqual(f.DB.database.prepare('SELECT coordinator_access FROM principals WHERE id IN (?,?) ORDER BY id').all(a.principal.id,o.principal.id).map(row=>row.coordinator_access),[0,0]);
  assert.equal(f.DB.database.prepare('SELECT owner_relay_reference FROM messages WHERE id=?').get(question.id).owner_relay_reference,null);
  assert.throws(()=>f.DB.database.prepare('UPDATE principals SET coordinator_access=2 WHERE id=?').run(a.principal.id));
});
