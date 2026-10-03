import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import {SqliteD1} from './d1-sqlite.mjs';
const OWNER='synthetic-owner-for-local-test-only-1234567890';
function fixture(t){const DB=new SqliteD1();t.after(()=>DB.close());const env={DB,OWNER_TOKEN:OWNER};return {
 DB,env,
 async call(token,path,body,method=body===undefined?'GET':'POST',extraHeaders={}){
  const headers={...extraHeaders};if(token)headers.authorization='Bearer '+token;if(body!==undefined)headers['content-type']='application/json';
  const response=await worker.fetch(new Request('https://hub.test'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)}),env);
  return {status:response.status,body:await response.json(),headers:response.headers};
 },
};}
async function invite(f,name,projects=['release-wave']){const result=await f.call(OWNER,'/api/principals',{name,account:name+'@example.test',projects});assert.equal(result.status,201);return result.body;}
async function session(f,token,machine='mac-local',extra={}){const result=await f.call(token,'/api/sessions',{externalId:crypto.randomUUID(),machine,label:machine,project:'release-wave',task:'Coordinate reviewed schema correction',status:'RUNNING',...extra});assert.equal(result.status,201);return result.body.session;}

test('an archive committing after the initial read blocks final writes',async t=>{
 for(const operation of ['heartbeat','update','send','receive','claim']){
  const f=fixture(t),a=await invite(f,'a'),b=await invite(f,'b');
  const x=await session(f,a.token),y=await session(f,b.token,'remote');
  const target=operation==='receive'?y:x;
  const original=f.DB.prepare.bind(f.DB);let intercepted=false;
  f.DB.prepare=query=>{
   const statement=original(query),run=statement.run;
   statement.run=async()=>{
    if(!intercepted && /^(UPDATE sessions SET (last_seen_at|status)|INSERT INTO (messages|ownership))/.test(query)){
     intercepted=true;
     f.DB.database.prepare('UPDATE sessions SET status=\'DONE\',archived_at=? WHERE id=?').run('2026-10-03T00:00:00.000Z',target.id);
    }
    return run();
   };return statement;
  };
  let result;
  if(operation==='heartbeat')result=await f.call(a.token,'/api/sessions/'+x.id+'/heartbeat',{});
  else if(operation==='update')result=await f.call(a.token,'/api/sessions/'+x.id,{status:'RUNNING',task:'Must not apply',label:'Must not rename'},'PATCH');
  else if(operation==='claim')result=await f.call(a.token,'/api/ownership/claim',{sessionId:x.id,resourceKey:'race'});
  else result=await f.call(a.token,'/api/messages',{fromSessionId:x.id,toSessionId:y.id,project:'release-wave',kind:'NOTE',body:'Must not send after archival',idempotencyKey:operation});
  assert.equal(intercepted,true,operation);assert.equal(result.status,409,operation);
  assert.equal(f.DB.database.prepare('SELECT status FROM sessions WHERE id=?').get(target.id).status,'DONE');
  if(operation==='update')assert.equal(f.DB.database.prepare('SELECT label FROM sessions WHERE id=?').get(target.id).label,x.label);
  assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM messages').get().n,0);
  assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM ownership').get().n,0);
 }
});

test('authentication protects private reads, validates origin and keeps hashes private',async t=>{
 const f=fixture(t);assert.equal((await f.call(null,'/api/sessions')).status,401);assert.equal((await f.call('invalid','/api/me')).status,401);
 assert.equal((await f.call(OWNER,'/api/me',undefined,'GET',{origin:'https://attacker.test'})).status,403);
 const a=await invite(f,'release-agent');const me=await f.call(a.token,'/api/me');assert.equal(me.body.principal.role,'agent');assert.equal(me.body.principal.account,'release-agent@example.test');assert.ok(!JSON.stringify(me.body).includes('token_hash'));
 assert.equal((await f.call(a.token,'/api/principals')).status,403);
 const stored=f.DB.database.prepare('SELECT token_hash FROM principals WHERE id=?').get(a.principal.id);assert.match(stored.token_hash,/^[a-f0-9]{64}$/);assert.notEqual(stored.token_hash,a.token);
 assert.equal((await f.call(OWNER,'/api/principals')).body.principals.some(p=>'token_hash' in p),false);
});
test('two invited principals on separate machines exchange and acknowledge a custody handoff',async t=>{
 const f=fixture(t),a=await invite(f,'local-reviewer'),b=await invite(f,'support-correction');const local=await session(f,a.token,'local-workstation'),remote=await session(f,b.token,'support-other-computer');
 const payload={fromSessionId:local.id,toSessionId:remote.id,project:'release-wave',kind:'HANDOFF',body:'Correction ownership stays with support. Release candidate is reviewed; native build stopped before deploy.',idempotencyKey:crypto.randomUUID()};
 const sent=await f.call(a.token,'/api/messages',payload);assert.equal(sent.status,201);assert.equal(sent.body.message.fromPrincipalName,'local-reviewer');
 const inbox=await f.call(b.token,'/api/messages?sessionId='+remote.id+'&after=0');assert.equal(inbox.body.messages[0].id,sent.body.message.id);assert.equal(inbox.body.messages[0].body,payload.body);
 assert.equal((await f.call(a.token,'/api/messages/'+sent.body.message.id+'/ack',{sessionId:remote.id})).status,403);
 const ack=await f.call(b.token,'/api/messages/'+sent.body.message.id+'/ack',{sessionId:remote.id});assert.equal(ack.status,200);assert.ok(ack.body.message.acknowledgedAt);
 const retry=await f.call(a.token,'/api/messages',payload);assert.equal(retry.body.message.id,sent.body.message.id);
 assert.equal((await f.call(a.token,'/api/messages',{...payload,body:'Changed write scope'})).status,409);
 assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM messages').get().n,1);
});
test('session spoofing and cross-project message/read access are denied',async t=>{
 const f=fixture(t),a=await invite(f,'a'),b=await invite(f,'b'),c=await invite(f,'unrelated',['other-work']);const x=await session(f,a.token),y=await session(f,b.token,'remote');
 assert.equal((await f.call(a.token,'/api/sessions/'+y.id,{status:'DONE'},'PATCH')).status,403);
 assert.equal((await f.call(a.token,'/api/messages',{fromSessionId:y.id,toSessionId:x.id,project:'release-wave',kind:'NOTE',body:'Spoofed',idempotencyKey:'spoof'})).status,403);
 assert.equal((await f.call(c.token,'/api/sessions?project=release-wave')).status,403);
 assert.equal((await f.call(c.token,'/api/messages?sessionId='+x.id)).status,403);
 assert.deepEqual((await f.call(c.token,'/api/sessions')).body.sessions,[]);
 const sent=await f.call(a.token,'/api/messages',{fromSessionId:x.id,toSessionId:y.id,project:'release-wave',kind:'NOTE',body:'Private handoff',idempotencyKey:'private'});
 const third=await invite(f,'third');const z=await session(f,third.token,'third');assert.deepEqual((await f.call(third.token,'/api/messages?sessionId='+z.id)).body.messages,[]);
 assert.equal((await f.call(third.token,'/api/messages/'+sent.body.message.id+'/ack',{sessionId:z.id})).status,403);
});
test('WAITING_ON_USER is independent of stale heartbeat and ownership cannot be stolen',async t=>{
 const f=fixture(t),a=await invite(f,'correction-owner'),b=await invite(f,'release');const x=await session(f,a.token,'other-computer',{status:'WAITING_ON_USER'}),y=await session(f,b.token);
 f.DB.database.prepare('UPDATE sessions SET last_seen_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z',x.id);
 const rows=(await f.call(b.token,'/api/sessions')).body.sessions;assert.equal(rows.find(s=>s.id===x.id).status,'WAITING_ON_USER');assert.equal(rows.find(s=>s.id===x.id).stale,true);
 assert.equal((await f.call(a.token,'/api/ownership/claim',{sessionId:x.id,resourceKey:'schema/billed-account-correction'})).status,200);
 assert.equal((await f.call(b.token,'/api/ownership/claim',{sessionId:y.id,resourceKey:'schema/billed-account-correction'})).status,409);
 assert.equal((await f.call(b.token,'/api/ownership/release',{sessionId:y.id,resourceKey:'schema/billed-account-correction'})).status,409);
 const heartbeat=await f.call(a.token,'/api/sessions/'+x.id+'/heartbeat',{});assert.equal(heartbeat.body.session.status,'WAITING_ON_USER');assert.equal(heartbeat.body.session.stale,false);
 assert.equal((await f.call(a.token,'/api/ownership/release',{sessionId:x.id,resourceKey:'schema/billed-account-correction'})).status,200);
 assert.equal((await f.call(b.token,'/api/ownership/claim',{sessionId:y.id,resourceKey:'schema/billed-account-correction'})).status,200);
});
test('owner question/answer records human decision separately from external authority',async t=>{
 const f=fixture(t),a=await invite(f,'agent'),b=await invite(f,'another');const x=await session(f,a.token),y=await session(f,b.token,'remote');
 const question=await f.call(a.token,'/api/messages',{fromSessionId:x.id,project:'release-wave',kind:'QUESTION',body:'Please review the exact correction scope.',idempotencyKey:'question'});assert.equal(question.status,201);
 const answer=await f.call(OWNER,'/api/messages',{toSessionId:x.id,project:'release-wave',kind:'ANSWER',body:'Reviewed; admit through the checked recovery path.',replyTo:question.body.message.id,idempotencyKey:'answer'});assert.equal(answer.status,201);assert.equal(answer.body.message.fromPrincipalId,'owner');assert.ok(!('productionApproval' in answer.body.message));
 assert.equal((await f.call(b.token,'/api/messages',{fromSessionId:y.id,toSessionId:x.id,project:'release-wave',kind:'ANSWER',body:'I approve',replyTo:question.body.message.id,idempotencyKey:'forged-answer'})).status,403);
 assert.equal((await f.call(OWNER,'/api/messages/'+question.body.message.id+'/ack',{})).status,200);
});
test('revocation immediately stops an invited principal without deleting ownership custody',async t=>{
 const f=fixture(t),a=await invite(f,'revoked');const x=await session(f,a.token);await f.call(a.token,'/api/ownership/claim',{sessionId:x.id,resourceKey:'schema/correction'});
 assert.equal((await f.call(OWNER,'/api/principals/'+a.principal.id,undefined,'DELETE')).status,200);
 assert.equal((await f.call(a.token,'/api/me')).status,401);assert.equal((await f.call(a.token,'/api/sessions/'+x.id+'/heartbeat',{})).status,401);
 assert.equal((await f.call(OWNER,'/api/ownership')).body.ownership[0].ownerSessionId,x.id);
});
test('bounded input rejects secrets, malformed details, SQL injection project and body overflow',async t=>{
 const f=fixture(t),a=await invite(f,'input');const x=await session(f,a.token);
 for(const body of ['access_token=do-not-store-secrets-here','verification_code=123456','-----BEGIN PRIVATE KEY----- abc'])assert.equal((await f.call(a.token,'/api/messages',{fromSessionId:x.id,project:'release-wave',kind:'QUESTION',body,idempotencyKey:crypto.randomUUID()})).status,422);
 assert.equal((await f.call(a.token,'/api/messages',{fromSessionId:x.id,project:'release-wave',kind:'QUESTION',body:'x'.repeat(18000),idempotencyKey:'huge'})).status,413);
 assert.equal((await f.call(OWNER,'/api/principals',{name:'injection',account:'label',projects:["x');DROP TABLE sessions;--"]})).status,422);
 assert.equal((await f.call(a.token,'/api/sessions/'+x.id,{details:{selectedCommit:'moving-dev'}},'PATCH')).status,422);
 const unknown=await f.call(a.token,'/api/sessions/'+x.id,{principalId:'owner'},'PATCH');assert.equal(unknown.status,422);
 const count=f.DB.database.prepare('SELECT COUNT(*) AS n FROM sessions').get();assert.equal(count.n,1);
});
test('registration retry preserves machine identity and rejects an attempted move',async t=>{
 const f=fixture(t),a=await invite(f,'agent');const payload={externalId:'external-thread-id',machine:'machine-a',label:'Primary release',project:'release-wave',task:'Checks pending',status:'RUNNING'};
 const x=await f.call(a.token,'/api/sessions',payload),retry=await f.call(a.token,'/api/sessions',payload);assert.equal(x.body.session.id,retry.body.session.id);assert.equal(retry.status,200);
 assert.equal((await f.call(a.token,'/api/sessions',{...payload,machine:'machine-b'})).status,409);
});
test('thirty-day retention preserves newer messages and ninety-day audit policy',async t=>{
 const f=fixture(t),a=await invite(f,'agent');const x=await session(f,a.token);
 const old=await f.call(a.token,'/api/messages',{fromSessionId:x.id,project:'release-wave',kind:'QUESTION',body:'Old question',idempotencyKey:'old'});
 const recent=await f.call(OWNER,'/api/messages',{toSessionId:x.id,project:'release-wave',kind:'ANSWER',body:'Recent answer',idempotencyKey:'recent',replyTo:old.body.message.id});assert.equal(recent.status,201);
 f.DB.database.prepare('UPDATE messages SET created_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z',old.body.message.id);
 await worker.scheduled({},f.env);
 assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM messages').get().n,1);assert.equal(f.DB.database.prepare('SELECT reply_to FROM messages').get().reply_to,null);
});


test('archive releases active capacity while preserving history and cannot bypass custody',async t=>{
 const f=fixture(t),a=await invite(f,'archive-agent');const x=await session(f,a.token);
 assert.equal((await f.call(a.token,'/api/sessions/'+x.id+'/archive',{})).status,409);
 await f.call(a.token,'/api/ownership/claim',{sessionId:x.id,resourceKey:'correction'});
 await f.call(a.token,'/api/sessions/'+x.id,{status:'DONE'},'PATCH');
 assert.equal((await f.call(a.token,'/api/sessions/'+x.id+'/archive',{})).status,409);
 await f.call(a.token,'/api/ownership/release',{sessionId:x.id,resourceKey:'correction'});
 const archived=await f.call(a.token,'/api/sessions/'+x.id+'/archive',{});assert.equal(archived.status,200);assert.ok(archived.body.session.archivedAt);
 assert.deepEqual((await f.call(a.token,'/api/sessions')).body.sessions,[]);
 assert.equal((await f.call(a.token,'/api/sessions/'+x.id+'/archive',{})).status,200);
 assert.equal((await f.call(a.token,'/api/sessions/'+x.id+'/heartbeat',{})).status,409);
 assert.equal((await f.call(a.token,'/api/ownership/claim',{sessionId:x.id,resourceKey:'new'})).status,409);
 assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,1);
});
test('human inbox starts at recent custody and older pages do not hide new arrivals',async t=>{
 const f=fixture(t),a=await invite(f,'pagination');const x=await session(f,a.token);
 for(let i=0;i<105;i++)await f.call(a.token,'/api/messages',{fromSessionId:x.id,project:'release-wave',kind:'QUESTION',body:'Question '+i,idempotencyKey:'pagination-'+i});
 const latest=await f.call(OWNER,'/api/messages?latest=1');assert.equal(latest.body.messages.length,100);assert.equal(latest.body.messages[0].body,'Question 5');assert.equal(latest.body.messages.at(-1).body,'Question 104');
 const older=await f.call(OWNER,'/api/messages?before='+latest.body.nextBefore);assert.equal(older.body.messages.length,5);assert.equal(older.body.messages[0].body,'Question 0');assert.equal(older.body.nextBefore,null);
 const all=await f.call(a.token,'/api/messages?sessionId='+x.id+'&after=0');assert.equal(all.body.messages[0].body,'Question 0');assert.equal(all.body.messages.length,100);
 const newer=await f.call(a.token,'/api/messages?sessionId='+x.id+'&after='+all.body.nextCursor);assert.equal(newer.body.messages.length,5);
});

test('all-session and peer-session inbox views preserve principal and project custody',async t=>{
 const f=fixture(t),a=await invite(f,'a'),b=await invite(f,'b'),c=await invite(f,'c');
 const x=await session(f,a.token),x2=await session(f,a.token,'second'),y=await session(f,b.token),z=await session(f,c.token);
 async function send(actor,from,to,kind='NOTE'){
  const result=await f.call(actor.token,'/api/messages',{fromSessionId:from.id,toSessionId:to.id,project:'release-wave',kind,body:'Synthetic coordination',idempotencyKey:crypto.randomUUID()});
  assert.equal(result.status,201);return result.body.message;
 }
 const outgoing=await send(a,x,y),incoming=await send(b,y,x2,'HANDOFF'),privateMessage=await send(b,y,z);
 const all=await f.call(a.token,'/api/messages?latest=1');
 assert.equal(all.status,200);assert.deepEqual(all.body.messages.map(m=>m.id),[outgoing.id,incoming.id]);
 const peer=await f.call(a.token,'/api/messages?sessionId='+y.id);
 assert.equal(peer.status,200);assert.deepEqual(peer.body.messages.map(m=>m.id),[outgoing.id,incoming.id]);
 assert.deepEqual((await f.call(a.token,'/api/messages?sessionId='+z.id)).body.messages,[]);
 assert.deepEqual((await f.call(a.token,'/api/messages?kind=HANDOFF')).body.messages.map(m=>m.id),[incoming.id]);
 assert.deepEqual((await f.call(OWNER,'/api/messages')).body.messages.map(m=>m.id),[outgoing.id,incoming.id,privateMessage.id]);
 // Filtering a peer inbox never lets the viewing principal acknowledge that peer's receipt.
 assert.equal((await f.call(a.token,'/api/messages/'+outgoing.id+'/ack',{sessionId:y.id})).status,403);
 assert.equal((await f.call(a.token,'/api/messages/'+incoming.id+'/ack',{sessionId:x.id})).status,403);
 assert.equal((await f.call(a.token,'/api/messages/'+incoming.id+'/ack',{sessionId:x2.id})).status,200);
 const outsider=await invite(f,'outsider',['private-work']);
 const hidden=await session(f,outsider.token,'private',{project:'private-work'});
 await f.call(outsider.token,'/api/messages',{fromSessionId:hidden.id,project:'private-work',kind:'QUESTION',body:'Private question',idempotencyKey:'private'});
 assert.equal((await f.call(a.token,'/api/messages?sessionId='+hidden.id+'&kind=QUESTION')).status,403);
 assert.deepEqual((await f.call(a.token,'/api/messages?kind=QUESTION')).body.messages,[]);
});

test('message types filter before pagination and combine with session and arrival cursors',async t=>{
 const f=fixture(t),a=await invite(f,'type-filter'),x=await session(f,a.token),y=await session(f,a.token,'second');
 for(let i=0;i<105;i++){
  await f.call(a.token,'/api/messages',{fromSessionId:x.id,toSessionId:y.id,project:'release-wave',kind:'NOTE',body:'Note '+i,idempotencyKey:'note-'+i});
  await f.call(a.token,'/api/messages',{fromSessionId:x.id,project:'release-wave',kind:'QUESTION',body:'Question '+i,idempotencyKey:'question-'+i});
 }
 const latest=await f.call(OWNER,'/api/messages?latest=1&kind=NOTE&sessionId='+y.id);
 assert.equal(latest.status,200);assert.equal(latest.body.messages.length,100);
 assert.equal(latest.body.messages[0].body,'Note 5');assert.equal(latest.body.messages.at(-1).body,'Note 104');
 assert.ok(latest.body.messages.every(m=>m.kind==='NOTE'&&m.toSessionId===y.id));
 const older=await f.call(a.token,'/api/messages?kind=NOTE&sessionId='+y.id+'&before='+latest.body.nextBefore);
 assert.equal(older.body.messages.length,5);assert.equal(older.body.messages[0].body,'Note 0');assert.equal(older.body.nextBefore,null);
 const next=await f.call(a.token,'/api/messages',{fromSessionId:x.id,toSessionId:y.id,project:'release-wave',kind:'NOTE',body:'New note',idempotencyKey:'next-note'});
 const arrivals=await f.call(a.token,'/api/messages?kind=NOTE&after='+latest.body.nextCursor);
 assert.deepEqual(arrivals.body.messages.map(m=>m.id),[next.body.message.id]);
 assert.deepEqual((await f.call(OWNER,'/api/messages?kind=QUESTION&sessionId='+y.id)).body.messages,[]);
 for(const kind of ['invalid','',"NOTE' OR 1=1 --"]){
  assert.equal((await f.call(OWNER,'/api/messages?kind='+encodeURIComponent(kind))).status,422);
 }
});
