import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import {SqliteD1} from './d1-sqlite.mjs';
const OWNER='synthetic-observer-test-owner-1234567890';
function fixture(t,options){const DB=new SqliteD1(':memory:',options);t.after(()=>DB.close());return {DB,async call(token,path,body,method=body===undefined?'GET':'POST'){
  const response=await worker.fetch(new Request('https://hub.test'+path,{method,headers:{authorization:'Bearer '+token,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})}),{DB,OWNER_TOKEN:OWNER});return {status:response.status,body:await response.json()};
}};}
async function invite(f,name,projects=['alpha'],profile='agent'){const result=await f.call(OWNER,'/api/principals',{name,account:name+'@example.test',projects,profile});assert.equal(result.status,201);return result.body;}
async function session(f,actor,project='alpha'){const result=await f.call(actor.token,'/api/sessions',{externalId:crypto.randomUUID(),machine:'synthetic',label:'Synthetic task',project,task:'Test visibility',status:'RUNNING'});assert.equal(result.status,201);return result.body.session;}
async function send(f,a,x,y,project='alpha'){const result=await f.call(a.token,'/api/messages',{fromSessionId:x.id,...(y?{toSessionId:y.id}:{}),project,kind:y?'NOTE':'QUESTION',body:y?'Peer coordination':'Private question for the human',idempotencyKey:crypto.randomUUID()});assert.equal(result.status,201);return result.body.message;}

test('project observer reads project conversations and owner questions without changing delivery or receipt',async t=>{
  const f=fixture(t),a=await invite(f,'sender'),b=await invite(f,'recipient'),o=await invite(f,'viewer',['alpha'],'observer'),foreign=await invite(f,'foreign',['beta']);
  const x=await session(f,a),y=await session(f,b),z=await session(f,foreign,'beta');
  const peer=await send(f,a,x,y),question=await send(f,a,x,null),privateOther=await send(f,foreign,z,null,'beta');
  const pending=await send(f,a,x,y),rejected=await send(f,a,x,y);
  f.DB.database.prepare("UPDATE messages SET review_state='PENDING' WHERE id=?").run(pending.id);
  f.DB.database.prepare("UPDATE messages SET review_state='REJECTED' WHERE id=?").run(rejected.id);
  const before=f.DB.database.prepare('SELECT id,to_principal_id,acknowledged_at,review_state,delivery_id FROM messages ORDER BY id').all();
  const read=await f.call(o.token,'/api/conversations?project=alpha');assert.equal(read.status,200);
  assert.deepEqual(read.body.messages.map(m=>m.id),[peer.id,question.id,pending.id,rejected.id]);
  assert.equal(read.body.messages.find(m=>m.id===question.id).body,'Private question for the human');
  assert.equal(read.body.messages.some(m=>m.id===privateOther.id),false);
  assert.equal('payloadHash' in read.body.messages[0],false);
  assert.deepEqual(f.DB.database.prepare('SELECT id,to_principal_id,acknowledged_at,review_state,delivery_id FROM messages ORDER BY id').all(),before);
  assert.deepEqual((await f.call(o.token,'/api/messages')).body.messages,[]);
  assert.equal((await f.call(a.token,'/api/conversations')).status,403);
  assert.equal((await f.call(o.token,'/api/conversations?project=beta')).status,403);
  assert.equal((await f.call(o.token,'/api/conversations?sessionId='+z.id)).status,403);
  assert.equal((await f.call(o.token,'/api/conversations?reviewState=PENDING')).body.messages[0].id,pending.id);
  assert.equal((await f.call(o.token,`/api/messages/${question.id}/ack`,{})).status,403);
  assert.equal((await f.call(OWNER,`/api/messages/${question.id}/ack`,{})).status,200);
});

test('observer pagination scopes before limits and uses a separate message-ID cursor',async t=>{
  const f=fixture(t),a=await invite(f,'sender'),o=await invite(f,'viewer',['alpha'],'observer'),foreign=await invite(f,'foreign',['beta']);
  const x=await session(f,a),z=await session(f,foreign,'beta');
  const one=await send(f,a,x,null);await send(f,foreign,z,null,'beta');const two=await send(f,a,x,null);await send(f,foreign,z,null,'beta');const three=await send(f,a,x,null);
  const first=(await f.call(o.token,'/api/conversations?limit=1')).body;
  assert.equal(first.messages[0].id,one.id);assert.equal(first.nextCursor,one.id);assert.equal(first.hasMore,true);
  const next=(await f.call(o.token,'/api/conversations?limit=1&after='+first.nextCursor)).body;assert.equal(next.messages[0].id,two.id);
  const last=(await f.call(o.token,'/api/conversations?latest=1&limit=1')).body;assert.equal(last.messages[0].id,three.id);assert.equal(last.nextBefore,three.id);
  const older=(await f.call(o.token,'/api/conversations?before='+last.nextBefore+'&limit=1')).body;assert.equal(older.messages[0].id,two.id);
  const empty=(await f.call(o.token,'/api/conversations?after='+three.id)).body;assert.deepEqual(empty.messages,[]);assert.equal(empty.nextCursor,three.id);
  for(const query of ['after=1&latest=1','before=2&latest=1','limit=101','kind=UNKNOWN','reviewState=UNKNOWN'])assert.equal((await f.call(o.token,'/api/conversations?'+query)).status,422);
});

test('observer authority excludes messaging, invitations, claims, owner replies and foreign session writes',async t=>{
  const f=fixture(t),a=await invite(f,'sender'),o=await invite(f,'viewer',['alpha'],'observer'),x=await session(f,a),own=await session(f,o);
  assert.equal((await f.call(o.token,'/api/me')).body.principal.profile,'observer');
  for(const [path,body,method] of [
    ['/api/principals',{name:'Elevated',account:'x',projects:['alpha']},'POST'],
    ['/api/principals/'+a.principal.id,undefined,'DELETE'],
    ['/api/messages',{fromSessionId:own.id,toSessionId:x.id,project:'alpha',kind:'NOTE',body:'Should not send',idempotencyKey:'observer-send'},'POST'],
    ['/api/ownership/claim',{sessionId:own.id,resourceKey:'test/claim'},'POST'],
    ['/api/sessions/'+own.id+'/checkpoint',{expectedRevision:0,checkpoint:{}},'PUT'],
    ['/api/sessions/'+x.id,{status:'DONE'},'PATCH'],
    ['/api/observers',{name:'Elevated observer',sessions:[]},'POST'],
  ])assert.equal((await f.call(o.token,path,body,method)).status,403,path);
  assert.equal((await f.call(o.token,'/api/principals')).status,403);
  assert.equal((await f.call(o.token,'/api/sessions/'+own.id+'/heartbeat',{})).status,200);
  assert.equal((await f.call(o.token,'/api/sessions/'+own.id,{label:'Observer task',status:'DONE'},'PATCH')).status,200);
  assert.equal((await f.call(o.token,'/api/sessions/'+own.id+'/archive',{})).status,200);
  assert.equal((await f.call(a.token,'/api/principals',{name:'Self elevation',account:'x',projects:['alpha'],profile:'observer'})).status,403);
  assert.equal((await f.call(OWNER,'/api/principals',{name:'Unknown',account:'x',projects:['alpha'],profile:'owner'})).status,422);
  await f.call(OWNER,'/api/principals/'+o.principal.id,undefined,'DELETE');
  assert.equal((await f.call(o.token,'/api/conversations')).status,401);
});

test('connection history attributes explicit connects, deduplicates retries and remains owner-only',async t=>{
  const f=fixture(t),o=await invite(f,'viewer',['alpha'],'observer'),id=crypto.randomUUID();
  const one=await f.call(o.token,'/api/connections',{connectionId:id,client:'web'});assert.equal(one.status,201);assert.equal(one.body.connection.principalId,o.principal.id);
  const retry=await f.call(o.token,'/api/connections',{connectionId:id,client:'web'});assert.equal(retry.status,200);assert.equal(retry.body.connection.id,one.body.connection.id);
  assert.equal((await f.call(o.token,'/api/connections',{connectionId:id,client:'api'})).status,409);
  const owner=await f.call(OWNER,'/api/connections',{connectionId:crypto.randomUUID(),client:'web'});assert.equal(owner.status,201);
  const page=(await f.call(OWNER,'/api/connections?limit=1')).body;assert.equal(page.connections[0].principalId,'owner');assert.equal(page.hasMore,true);
  const next=(await f.call(OWNER,'/api/connections?before='+page.nextBefore)).body;assert.equal(next.connections[0].principalName,'viewer');
  assert.equal(JSON.stringify(page).includes('token'),false);
  assert.equal((await f.call(o.token,'/api/connections')).status,403);
  assert.equal((await f.call(o.token,'/api/connections',{connectionId:crypto.randomUUID(),client:'web',principalId:'owner'})).status,422);
  assert.equal((await f.call(o.token,'/api/connections',{connectionId:'bad',client:'web'})).status,422);
  assert.equal((await f.call(o.token,'/api/connections',{connectionId:crypto.randomUUID(),client:'fake'})).status,422);
  await f.call(OWNER,'/api/principals/'+o.principal.id,undefined,'DELETE');
  assert.equal((await f.call(o.token,'/api/connections',{connectionId:crypto.randomUUID(),client:'web'})).status,401);
  assert.equal((await f.call(OWNER,'/api/connections')).body.connections.find(c=>c.principalId===o.principal.id).active,false);
});

test('connection quota is bounded and exact retries survive the cap',async t=>{
  const f=fixture(t),a=await invite(f,'agent'),id=crypto.randomUUID();
  const existing=await f.call(a.token,'/api/connections',{connectionId:id,client:'cli'});assert.equal(existing.status,201);
  const insert=f.DB.database.prepare('INSERT INTO connection_events(principal_id,connection_id,client,connected_at) VALUES (?,?,?,?)');
  for(let i=1;i<100;i++)insert.run(a.principal.id,crypto.randomUUID(),'cli',new Date().toISOString());
  assert.equal((await f.call(a.token,'/api/connections',{connectionId:crypto.randomUUID(),client:'cli'})).status,429);
  assert.equal((await f.call(a.token,'/api/connections',{connectionId:id,client:'cli'})).status,200);
  assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM connection_events').get().n,100);
});

test('connection mutation rechecks revocation at its final insert',async t=>{
  const f=fixture(t),a=await invite(f,'agent'),prepare=f.DB.prepare.bind(f.DB);let intercepted=false;
  f.DB.prepare=sql=>{const statement=prepare(sql);if(sql.startsWith('INSERT INTO connection_events')&&!intercepted){intercepted=true;f.DB.database.prepare('UPDATE principals SET active=0 WHERE id=?').run(a.principal.id);}return statement;};
  assert.equal((await f.call(a.token,'/api/connections',{connectionId:crypto.randomUUID(),client:'api'})).status,401);
  assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM connection_events').get().n,0);
});

test('migration defaults existing invitations to agent and retention removes only old connections',async t=>{
  const f=fixture(t,{throughMigration:'0007'}),a=await invite(f,'existing');
  assert.equal((await f.call(a.token,'/api/me')).body.principal.profile,'agent');
  const {readFileSync}=await import('node:fs');f.DB.database.exec(readFileSync(new URL('../migrations/0008_project_observers.sql',import.meta.url),'utf8'));
  assert.equal((await f.call(a.token,'/api/me')).body.principal.profile,'agent');
  f.DB.database.prepare('INSERT INTO connection_events(principal_id,connection_id,client,connected_at) VALUES (?,?,?,?)').run(a.principal.id,crypto.randomUUID(),'api','2020-01-01T00:00:00.000Z');
  await f.call(a.token,'/api/connections',{connectionId:crypto.randomUUID(),client:'api'});
  await worker.scheduled({cron:'17 3 * * *',scheduledTime:Date.now()},{DB:f.DB});
  assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM connection_events').get().n,1);
});
