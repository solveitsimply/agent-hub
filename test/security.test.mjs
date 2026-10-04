import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import worker from '../src/worker.mjs';
import {SqliteD1} from './d1-sqlite.mjs';

const OWNER='synthetic-security-owner-token-for-local-tests-only';
function fixture(t){
  const DB=new SqliteD1();t.after(()=>DB.close());const env={DB,OWNER_TOKEN:OWNER};
  const call=async(token,path,body,method=body===undefined?'GET':'POST')=>{
    const response=await worker.fetch(new Request('https://hub.test'+path,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
    return {status:response.status,body:await response.json()};
  };
  return {DB,env,call};
}
async function actor(f,name){const r=await f.call(OWNER,'/api/principals',{name,account:name+'@example.test',projects:['shared']});assert.equal(r.status,201);return r.body;}
async function session(f,a,extra={}){const r=await f.call(a.token,'/api/sessions',{externalId:crypto.randomUUID(),machine:'synthetic',label:'Synthetic chat',project:'shared',task:'Security fixture',status:'RUNNING',...extra});assert.equal(r.status,201);return r.body.session;}
const payload=(from,to,key,body='Synthetic coordination')=>({fromSessionId:from.id,...(to?{toSessionId:to.id}:{}),project:'shared',kind:to?'NOTE':'QUESTION',body,idempotencyKey:key});
test('enrolled agents exchange immediately; outsiders cannot inject, impersonate, or read other conversations',async t=>{
  const f=fixture(t),a=await actor(f,'a'),b=await actor(f,'b'),c=await actor(f,'c');
  const x=await session(f,a),same=await session(f,a),y=await session(f,b),z=await session(f,c);
  for(const to of [same,y]){
    const data=payload(x,to,crypto.randomUUID(),'Untrusted coordination evidence'),sent=await f.call(a.token,'/api/messages',data);
    assert.equal(sent.status,201);assert.equal(sent.body.message.reviewState,'APPROVED');assert.equal(sent.body.message.reviewedAt,null);
    const token=to===same?a.token:b.token;
    assert.equal((await f.call(token,'/api/messages?sessionId='+to.id)).body.messages.at(-1).body,data.body);
    assert.equal((await f.call(token,`/api/messages/${sent.body.message.id}/ack`,{sessionId:to.id})).status,200);
    assert.equal((await f.call(a.token,'/api/messages',data)).body.message.id,sent.body.message.id);
    assert.equal((await f.call(a.token,'/api/messages',{...data,body:'different'})).status,409);
    assert.equal((await f.call(c.token,`/api/messages/${sent.body.message.id}/ack`,{sessionId:z.id})).status,403);
    assert.equal((await f.call(c.token,'/api/messages?sessionId='+to.id)).body.messages.length,0);
    assert.equal((await f.call(a.token,'/api/messages',{...data,reviewState:'APPROVED'})).status,422);
    assert.equal((await f.call(a.token,`/api/messages/${sent.body.message.id}/review`,{decision:'APPROVED'})).status,404);
  }
  assert.equal((await f.call(c.token,'/api/messages',payload(x,y,'spoof'))).status,403);
  for(const token of [null,'invalid']){
    assert.equal((await f.call(token,'/api/messages',payload(x,y,'outside'))).status,401);
    assert.equal((await f.call(token,'/api/sessions')).status,401);
    assert.equal((await f.call(token,'/api/principals',{name:'outsider',account:'outsider',projects:['shared']})).status,401);
  }
  assert.equal((await f.call(a.token,'/api/principals',{name:'outsider',account:'outsider',projects:['shared']})).status,403);
});

test('automatic delivery preserves monotonic cursors, exact recipient receipts and retry-safe ordering',async t=>{
  const f=fixture(t),a=await actor(f,'a'),b=await actor(f,'b'),x=await session(f,a),y=await session(f,b);
  const first=await f.call(a.token,'/api/messages',payload(x,y,'first'));
  const inbox=(await f.call(b.token,'/api/messages?sessionId='+y.id)).body;
  assert.deepEqual(inbox.messages.map(m=>m.id),[first.body.message.id]);
  const second=await f.call(a.token,'/api/messages',payload(x,y,'second'));
  const next=(await f.call(b.token,'/api/messages?after='+inbox.nextCursor)).body;
  assert.deepEqual(next.messages.map(m=>m.id),[second.body.message.id]);assert.ok(next.nextCursor>inbox.nextCursor);
  const answer=await f.call(b.token,'/api/messages',{...payload(y,x,'reply'),kind:'ANSWER',replyTo:second.body.message.id});
  assert.equal(answer.status,201);
  assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM message_deliveries').get().n,3);
});

test('owner questions remain human-only; only the owner can answer or acknowledge them',async t=>{
  const f=fixture(t),a=await actor(f,'a'),x=await session(f,a);
  const sent=await f.call(a.token,'/api/messages',payload(x,null,'question','Question for the human only'));
  assert.equal(sent.body.message.body,null);assert.equal(sent.body.message.deliveryCursor,null);
  assert.deepEqual((await f.call(a.token,'/api/messages')).body.messages,[]);
  const row=(await f.call(OWNER,'/api/messages')).body.messages[0];assert.equal(row.body,'Question for the human only');
  assert.equal((await f.call(a.token,`/api/messages/${row.id}/ack`,{sessionId:x.id})).status,403);
  assert.equal((await f.call(OWNER,`/api/messages/${row.id}/ack`,{})).status,200);
  const answer=await f.call(OWNER,'/api/messages',{toSessionId:x.id,project:'shared',kind:'ANSWER',body:'Human owner reply',replyTo:row.id,idempotencyKey:'reply'});
  assert.equal(answer.status,201);assert.equal((await f.call(a.token,'/api/messages')).body.messages[0].body,'Human owner reply');
});

test('enrolled project peers can discover coordination context; another project cannot read it',async t=>{
  const f=fixture(t),a=await actor(f,'a'),b=await actor(f,'b');
  const other=(await f.call(OWNER,'/api/principals',{name:'other',account:'other@example.test',projects:['other']})).body;
  const x=await session(f,a,{label:'Peer task',machine:'peer-host',task:'Coordinate change'});
  await f.call(a.token,`/api/sessions/${x.id}/attribution`,{provider:'Example',client:'Codex',model:'Example model',previousSegmentId:null,idempotencyKey:'attribution'});
  await f.call(a.token,'/api/ownership/claim',{sessionId:x.id,resourceKey:'change/123'});
  const peers=(await f.call(b.token,'/api/sessions')).body;assert.equal(peers.sessions[0].label,'Peer task');assert.equal(peers.sessions[0].task,'Coordinate change');assert.deepEqual(peers.filterOptions.machines,['peer-host']);
  assert.equal((await f.call(b.token,`/api/sessions/${x.id}/attribution`)).body.segments[0].client,'Codex');
  assert.equal((await f.call(b.token,'/api/ownership')).body.ownership[0].resourceKey,'change/123');
  assert.deepEqual((await f.call(other.token,'/api/sessions')).body.sessions,[]);
  assert.deepEqual((await f.call(other.token,'/api/ownership')).body.ownership,[]);
  assert.equal((await f.call(other.token,`/api/sessions/${x.id}/attribution`)).status,403);
});

test('a streamed request completing after revocation cannot submit a message',async t=>{
  const f=fixture(t),a=await actor(f,'a'),b=await actor(f,'b'),x=await session(f,a),y=await session(f,b);
  let controller,notifyRead;const reading=new Promise(resolve=>{notifyRead=resolve;});
  const stream=new ReadableStream({start(c){controller=c;},pull(){notifyRead();}},{highWaterMark:0});
  const response=worker.fetch(new Request('https://hub.test/api/messages',{method:'POST',duplex:'half',headers:{authorization:'Bearer '+a.token,'content-type':'application/json'},body:stream}),f.env);
  await reading;assert.equal((await f.call(OWNER,'/api/principals/'+a.principal.id,undefined,'DELETE')).status,200);
  controller.enqueue(new TextEncoder().encode(JSON.stringify(payload(x,y,'stalled'))));controller.close();
  assert.equal((await response).status,401);assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM messages').get().n,0);
});

test('revocation winning at each final agent SQL mutation prevents that effect',async t=>{
  for(const operation of ['register','heartbeat','update','archive','attribution','send','ack','claim','release']){
    const f=fixture(t),a=await actor(f,operation),b=await actor(f,'peer'),x=await session(f,a),y=await session(f,b);
    if(operation==='archive')await f.call(a.token,`/api/sessions/${x.id}`,{status:'DONE'},'PATCH');
    if(operation==='release')await f.call(a.token,'/api/ownership/claim',{sessionId:x.id,resourceKey:'held'});
    const received=operation==='ack'?await f.call(OWNER,'/api/messages',{toSessionId:x.id,project:'shared',kind:'NOTE',body:'Approved receipt',idempotencyKey:'ack'}):null;
    const before={sessions:f.DB.database.prepare('SELECT * FROM sessions ORDER BY id').all(),segments:f.DB.database.prepare('SELECT * FROM session_attribution_segments').all(),messages:f.DB.database.prepare('SELECT * FROM messages').all(),claims:f.DB.database.prepare('SELECT * FROM ownership').all()};
    const original=f.DB.prepare.bind(f.DB);let intercepted=false;
    f.DB.prepare=query=>{const statement=original(query),run=statement.run;statement.run=async()=>{
      if(!intercepted&&/^(INSERT INTO (sessions|session_attribution_segments|messages|ownership)|UPDATE (sessions|messages SET acknowledged_at)|DELETE FROM ownership)/.test(query)){
        intercepted=true;f.DB.database.prepare('UPDATE principals SET active=0 WHERE id=?').run(a.principal.id);
      }return run();
    };return statement;};
    let result;
    if(operation==='register')result=await f.call(a.token,'/api/sessions',{externalId:'new',machine:'synthetic',label:'new',project:'shared',task:'new',status:'RUNNING'});
    if(operation==='heartbeat')result=await f.call(a.token,`/api/sessions/${x.id}/heartbeat`,{});
    if(operation==='update')result=await f.call(a.token,`/api/sessions/${x.id}`,{task:'changed'},'PATCH');
    if(operation==='archive')result=await f.call(a.token,`/api/sessions/${x.id}/archive`,{});
    if(operation==='attribution')result=await f.call(a.token,`/api/sessions/${x.id}/attribution`,{provider:'p',client:'c',previousSegmentId:null,idempotencyKey:'new'});
    if(operation==='send')result=await f.call(a.token,'/api/messages',payload(x,y,'race'));
    if(operation==='ack')result=await f.call(a.token,`/api/messages/${received.body.message.id}/ack`,{sessionId:x.id});
    if(['claim','release'].includes(operation))result=await f.call(a.token,'/api/ownership/'+operation,{sessionId:x.id,resourceKey:operation==='release'?'held':'new'});
    assert.equal(intercepted,true,operation);assert.equal(result.status,401,operation);
    assert.deepEqual(f.DB.database.prepare('SELECT * FROM sessions ORDER BY id').all(),before.sessions,operation);
    assert.deepEqual(f.DB.database.prepare('SELECT * FROM session_attribution_segments').all(),before.segments,operation);
    assert.deepEqual(f.DB.database.prepare('SELECT * FROM messages').all(),before.messages,operation);
    assert.deepEqual(f.DB.database.prepare('SELECT * FROM ownership').all(),before.claims,operation);
  }
});

test('send atomically refuses revoked, archived, reassigned or out-of-scope recipients',async t=>{
  for(const boundary of ['recipient-revoked','sender-archived','recipient-archived','recipient-reassigned','sender-scope','recipient-scope','recipient-project']){
    const f=fixture(t),a=await actor(f,'a'),b=await actor(f,'b'),x=await session(f,a),y=await session(f,b);
    const original=f.DB.prepare.bind(f.DB);let intercepted=false;
    f.DB.prepare=query=>{const statement=original(query),run=statement.run;statement.run=async()=>{
      if(!intercepted&&query.startsWith('INSERT INTO messages(')){
        intercepted=true;
        if(boundary==='recipient-revoked')f.DB.database.prepare('UPDATE principals SET active=0 WHERE id=?').run(b.principal.id);
        else if(boundary.endsWith('archived'))f.DB.database.prepare('UPDATE sessions SET archived_at=? WHERE id=?').run(new Date().toISOString(),boundary.startsWith('sender')?x.id:y.id);
        else if(boundary.endsWith('scope'))f.DB.database.prepare('UPDATE principals SET projects_json=? WHERE id=?').run('["other"]',boundary.startsWith('sender')?a.principal.id:b.principal.id);
        else if(boundary==='recipient-project')f.DB.database.prepare('UPDATE sessions SET project=? WHERE id=?').run('other',y.id);
        else f.DB.database.prepare('UPDATE sessions SET principal_id=? WHERE id=?').run(a.principal.id,y.id);
      }return run();
    };return statement;};
    assert.equal((await f.call(a.token,'/api/messages',payload(x,y,'race'))).status,409,boundary);
    assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM messages').get().n,0);
    assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM message_deliveries').get().n,0);
  }
});

test('message and claim quotas are atomic, include pending records, and preserve exact retries',async t=>{
  const f=fixture(t),a=await actor(f,'a'),b=await actor(f,'b'),x=await session(f,a),y=await session(f,b);
  const data=payload(x,y,'original'),sent=await f.call(a.token,'/api/messages',data);
  const insert=f.DB.database.prepare('INSERT INTO messages(from_principal_id,to_principal_id,from_session_id,to_session_id,project,kind,body,idempotency_key,payload_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  for(let i=0;i<498;i++)insert.run(a.principal.id,b.principal.id,x.id,y.id,'shared','NOTE','Synthetic','seed-'+i,'fixture',new Date().toISOString());
  const race=await Promise.all(['last','over'].map(key=>f.call(a.token,'/api/messages',payload(x,y,key))));
  assert.deepEqual(race.map(r=>r.status).sort(),[201,409]);
  assert.equal((await f.call(a.token,'/api/messages',data)).body.message.id,sent.body.message.id);
  for(let i=0;i<100;i++)f.DB.database.prepare('INSERT INTO ownership VALUES (?,?,?,?)').run('shared','seed-'+i,x.id,new Date().toISOString());
  assert.equal((await f.call(a.token,'/api/ownership/claim',{sessionId:x.id,resourceKey:'over'})).status,409);
  assert.equal((await f.call(a.token,'/api/ownership/claim',{sessionId:x.id,resourceKey:'seed-0'})).status,200);
});

test('archiving cannot replenish retained-session quota; repeated metadata audits stay bounded',async t=>{
  const f=fixture(t),a=await actor(f,'a'),x=await session(f,a);
  const insert=f.DB.database.prepare('INSERT INTO sessions(id,principal_id,external_id,machine,label,project,task,status,created_at,last_seen_at,archived_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  for(let i=0;i<999;i++)insert.run(crypto.randomUUID(),a.principal.id,'old-'+i,'synthetic','fixture','shared','fixture','DONE','2020-01-01','2020-01-01','2020-01-01');
  assert.equal((await f.call(a.token,'/api/sessions',{externalId:'over',machine:'synthetic',label:'over',project:'shared',task:'over',status:'DONE'})).status,409);
  for(let i=0;i<20;i++)assert.equal((await f.call(a.token,`/api/sessions/${x.id}`,{status:'RUNNING'},'PATCH')).status,200);
  assert.equal(f.DB.database.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='session.updated'").get().n,1);
});

test('migration preserves history but hides legacy agent text, including owner questions',async t=>{
  const DB=new SqliteD1(':memory:',{throughMigration:'0002'});t.after(()=>DB.close());
  DB.database.prepare('INSERT INTO principals VALUES (?,?,?,?,?,?,?,?)').run('agent','Fixture','fixture','agent','synthetic-hash','["shared"]',1,'2020-01-01');
  DB.database.prepare('INSERT INTO sessions(id,principal_id,external_id,machine,label,project,task,status,created_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run('session','agent','external','synthetic','fixture','shared','fixture','RUNNING','2020-01-01','2020-01-01');
  const insert=DB.database.prepare('INSERT INTO messages(from_principal_id,to_principal_id,from_session_id,to_session_id,project,kind,body,idempotency_key,payload_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  insert.run('agent','agent','session','session','shared','NOTE','Unreviewed legacy','legacy','hash','2020-01-01');
  insert.run('agent','owner','session',null,'shared','QUESTION','Question legacy','question','hash','2020-01-01');
  insert.run('owner','agent',null,'session','shared','NOTE','Human legacy','owner','hash','2020-01-01');
  insert.run('agent','agent','session','session','shared','NOTE','Newest unreviewed legacy','newest','hash','2020-01-01');
  DB.database.exec(readFileSync(new URL('../migrations/0003_message_review.sql',import.meta.url),'utf8'));
  assert.deepEqual(DB.database.prepare('SELECT review_state,delivery_id FROM messages ORDER BY id').all().map(r=>[r.review_state,r.delivery_id]),[['PENDING',null],['PENDING',null],['APPROVED',3],['PENDING',null]]);
  assert.equal(DB.database.prepare('SELECT COUNT(*) AS n FROM messages').get().n,4);
  assert.equal(DB.database.prepare('SELECT COUNT(*) AS n FROM message_deliveries').get().n,1);
  DB.database.prepare('INSERT INTO message_deliveries(message_id) VALUES (?)').run(1);
  assert.ok(DB.database.prepare('SELECT id FROM message_deliveries WHERE message_id=1').get().id>4,'Late approval exceeds every legacy client cursor');
});

test('hosted HTTP API rejects bearer traffic and HTTPS responses advertise HSTS',async t=>{
  const f=fixture(t);
  const insecure=await worker.fetch(new Request('http://hub.test/api/me',{headers:{authorization:'Bearer '+OWNER}}),f.env);
  assert.equal(insecure.status,403);assert.equal((await insecure.json()).error.code,'HTTPS_REQUIRED');
  const secure=await worker.fetch(new Request('https://hub.test/api/me',{headers:{authorization:'Bearer '+OWNER}}),f.env);
  assert.equal(secure.status,200);assert.equal(secure.headers.get('strict-transport-security'),'max-age=31536000');
  const local=await worker.fetch(new Request('http://127.0.0.1/api/me',{headers:{authorization:'Bearer '+OWNER}}),f.env);
  assert.equal(local.status,200);
});

test('upgrade reserves cursors for legacy messages already removed by retention',async t=>{
  const DB=new SqliteD1(':memory:',{throughMigration:'0002'});t.after(()=>DB.close());
  DB.database.prepare('INSERT INTO sessions(id,principal_id,external_id,machine,label,project,task,status,created_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run('session','owner','external','synthetic','fixture','shared','fixture','RUNNING','2020-01-01','2020-01-01');
  const insert=DB.database.prepare("INSERT INTO messages(from_principal_id,to_principal_id,from_session_id,project,kind,body,idempotency_key,payload_hash,created_at) VALUES (?,?,'session',?,?,?,?,?,?)");
  for(let i=0;i<5;i++)insert.run('owner','owner','shared','QUESTION','Expired synthetic history','expired-'+i,'fixture','2020-01-01');
  const legacyCursor=DB.database.prepare('SELECT MAX(id) AS id FROM messages').get().id;
  DB.database.exec('DELETE FROM messages');
  for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(name=>name>='0003').sort())DB.database.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  insert.run('owner','owner','shared','QUESTION','Future synthetic delivery','future','fixture','2026-10-03');
  const id=DB.database.prepare('SELECT MAX(id) AS id FROM messages').get().id;
  DB.database.prepare('INSERT INTO message_deliveries(message_id) VALUES (?)').run(id);
  assert.ok(DB.database.prepare('SELECT id FROM message_deliveries WHERE message_id=?').get(id).id>legacyCursor);
});

test('enrolled-delivery migration releases valid queued custody above old cursors while preserving rejected and inactive history',async t=>{
  const f=fixture(t),a=await actor(f,'a'),b=await actor(f,'b'),x=await session(f,a),y=await session(f,b);
  const insert=f.DB.database.prepare("INSERT INTO messages(from_principal_id,to_principal_id,from_session_id,to_session_id,project,kind,body,idempotency_key,payload_hash,created_at,review_state) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  const rows=[];
  for(const boundary of ['valid','question','rejected','sender-revoked','recipient-revoked','sender-archived','recipient-archived','sender-scope','recipient-scope','recipient-project','reassigned']){
    const sender=await actor(f,'sender-'+boundary),recipient=await actor(f,'recipient-'+boundary),from=await session(f,sender),to=await session(f,recipient);
    const id=Number(insert.run(sender.principal.id,boundary==='question'?'owner':recipient.principal.id,from.id,boundary==='question'?null:to.id,'shared',boundary==='question'?'QUESTION':'NOTE','Queued evidence',boundary,'fixture',new Date().toISOString(),boundary==='rejected'?'REJECTED':'PENDING').lastInsertRowid);
    rows.push({id,boundary});
    if(boundary.endsWith('revoked'))f.DB.database.prepare('UPDATE principals SET active=0 WHERE id=?').run(boundary.startsWith('sender')?sender.principal.id:recipient.principal.id);
    if(boundary.endsWith('archived'))f.DB.database.prepare('UPDATE sessions SET archived_at=? WHERE id=?').run(new Date().toISOString(),boundary.startsWith('sender')?from.id:to.id);
    if(boundary.endsWith('scope'))f.DB.database.prepare('UPDATE principals SET projects_json=? WHERE id=?').run('["other"]',boundary.startsWith('sender')?sender.principal.id:recipient.principal.id);
    if(boundary==='recipient-project')f.DB.database.prepare('UPDATE sessions SET project=? WHERE id=?').run('other',to.id);
    if(boundary==='reassigned')f.DB.database.prepare('UPDATE sessions SET principal_id=? WHERE id=?').run(sender.principal.id,to.id);
  }
  f.DB.database.prepare("UPDATE sqlite_sequence SET seq=900 WHERE name='message_deliveries'").run();
  const migration=readFileSync(new URL('../migrations/0005_enrolled_delivery.sql',import.meta.url),'utf8');
  f.DB.database.exec(migration);
  for(const {id,boundary} of rows){
    const row=f.DB.database.prepare('SELECT review_state,delivery_id,reviewed_at FROM messages WHERE id=?').get(id);
    assert.equal(row.review_state,['valid','question'].includes(boundary)?'APPROVED':boundary==='rejected'?'REJECTED':'PENDING',boundary);
    assert.equal(row.reviewed_at,null,boundary);
    if(boundary==='valid')assert.ok(row.delivery_id>900);else assert.equal(row.delivery_id,null,boundary);
  }
  assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM message_deliveries').get().n,1);
  f.DB.database.exec(migration);assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM message_deliveries').get().n,1);
  const next=await f.call(a.token,'/api/messages',payload(x,y,'after-upgrade'));
  assert.ok(next.body.message.deliveryCursor>900);
  assert.equal((await f.call(b.token,'/api/messages?after=900')).body.messages[0].id,next.body.message.id);
});
