import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import {SqliteD1} from './d1-sqlite.mjs';
const OWNER='synthetic-search-owner-12345678901234567890';
function fixture(t) {
  const DB=new SqliteD1();t.after(()=>DB.close());
  return {DB, async call(token,path,body) {
    const response=await worker.fetch(new Request('https://hub.test/api'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})}),{DB,OWNER_TOKEN:OWNER});
    return {status:response.status,body:await response.json()};
  }};
}
async function invite(f,name,projects=['alpha'],profile='agent') {
  const result=await f.call(OWNER,'/principals',{name,account:name+'@example.test',projects,profile});assert.equal(result.status,201);return result.body;
}
async function session(f,actor,extra={}) {
  const result=await f.call(actor.token,'/sessions',{externalId:crypto.randomUUID(),machine:'Synthetic machine',label:'Synthetic session',task:'Synthetic task',project:'alpha',status:'RUNNING',...extra});assert.equal(result.status,201);return result.body.session;
}
async function send(f,actor,from,to,body) {
  const result=await f.call(actor.token,'/messages',{fromSessionId:from.id,...(to?{toSessionId:to.id}:{}),project:from.project,kind:to?'NOTE':'QUESTION',body,idempotencyKey:crypto.randomUUID()});assert.equal(result.status,201);return result.body.message;
}

test('session search precedes limits and retains project and status scope',async t=>{
  const f=fixture(t),a=await invite(f,'sender'),foreign=await invite(f,'foreign',['beta']);
  const target=await session(f,a,{label:'Release Needle',workContext:{repository:'github.com/example/hub',branch:'feature/search'},status:'WAITING_ON_USER'});
  await session(f,a);const peer=await invite(f,'peer');await session(f,peer);await session(f,foreign,{project:'beta',label:'Private Needle'});
  const result=await f.call(a.token,'/sessions?q=NEEDLE&limit=1');
  assert.equal(result.status,200);assert.equal(result.body.total,1);assert.equal(result.body.sessions[0].id,target.id);
  assert.equal(result.body.summary.WAITING_ON_USER,1);assert.ok(result.body.filterOptions.branches.some(item=>item?.branch==='feature/search'));
  assert.equal((await f.call(a.token,'/sessions?q=needle&status=RUNNING')).body.total,0);
  assert.equal((await f.call(a.token,'/sessions?q=feature%2Fsearch')).body.sessions[0].id,target.id);
  assert.equal((await f.call(a.token,'/sessions?q='+target.id)).body.sessions[0].id,target.id);
  assert.equal((await f.call(a.token,'/sessions?q=Private')).body.total,0);
  assert.equal((await f.call(a.token,'/sessions?project=beta&q=Needle')).status,403);
  assert.equal((await f.call(OWNER,'/sessions?q='+'x'.repeat(201))).status,422);
  assert.equal((await f.call(a.token,'/sessions?owned=1')).body.sessions.every(item=>item.principalId===a.principal.id),true);
  assert.equal((await f.call(a.token,'/sessions?owned=0')).status,422);
});

test('message search paginates matching history and cannot broaden principal custody',async t=>{
  const f=fixture(t),a=await invite(f,'sender'),b=await invite(f,'recipient'),third=await invite(f,'third'),foreign=await invite(f,'foreign',['beta']);
  const x=await session(f,a),y=await session(f,b),z=await session(f,third),hidden=await session(f,foreign,{project:'beta'});
  const first=await send(f,a,x,y,'Old Needle 100%_ literal');await send(f,a,x,y,'Other message');
  const last=await send(f,a,x,y,'Recent needle');await send(f,third,z,z,'Private needle');await send(f,foreign,hidden,hidden,'Foreign needle');
  const query='/messages?sessionId='+y.id+'&q=NEEDLE&latest=1&limit=1';
  const latest=await f.call(b.token,query);assert.equal(latest.status,200);assert.deepEqual(latest.body.messages.map(m=>m.id),[last.id]);
  const older=await f.call(b.token,'/messages?sessionId='+y.id+'&q=needle&limit=1&before='+latest.body.nextBefore);assert.deepEqual(older.body.messages.map(m=>m.id),[first.id]);
  assert.deepEqual((await f.call(b.token,'/messages?q=100%25_')).body.messages.map(m=>m.id),[first.id]);
  assert.deepEqual((await f.call(b.token,'/messages?q=private')).body.messages,[]);
  assert.equal((await f.call(b.token,'/messages?project=beta&q=needle')).status,403);
  assert.equal((await f.call(b.token,'/messages?sessionId='+hidden.id+'&q=needle')).status,403);
  assert.equal((await f.call(OWNER,'/messages?q='+'x'.repeat(201))).status,422);
});

test('owner inbox distinguishes human questions from delivery, with read-only observer search',async t=>{
  const f=fixture(t),a=await invite(f,'sender'),viewer=await invite(f,'viewer',['alpha'],'observer'),foreign=await invite(f,'foreign',['beta']);
  const x=await session(f,a),hidden=await session(f,foreign,{project:'beta'});
  const question=await send(f,a,x,null,'Needle question');await send(f,a,x,x,'Needle delivery');await send(f,foreign,hidden,null,'Needle foreign question');
  const owner=await f.call(OWNER,'/messages?scope=owner&project=alpha&q=needle');assert.deepEqual(owner.body.messages.map(m=>m.id),[question.id]);
  const observed=await f.call(viewer.token,'/conversations?scope=owner&q=needle');assert.equal(observed.status,200);assert.deepEqual(observed.body.messages.map(m=>m.id),[question.id]);
  assert.equal(observed.body.messages[0].body,'Needle question');assert.equal(observed.body.messages[0].acknowledgedAt,null);
  assert.equal((await f.call(a.token,'/messages?scope=owner&q=needle')).status,403);
  assert.equal((await f.call(viewer.token,'/conversations?scope=owner&project=beta')).status,403);
  assert.equal((await f.call(viewer.token,'/conversations?q='+'x'.repeat(201))).status,422);
  assert.equal((await f.call(OWNER,'/messages?scope=unknown')).status,422);
  assert.equal((await f.call(viewer.token,'/messages/'+question.id+'/ack',{})).status,403);
});


test('owned session discovery pages past 200 while search and custody precede pagination',async t=>{
  const f=fixture(t),a=await invite(f,'sender'),b=await invite(f,'peer');
  const original=await session(f,a,{label:'Oldest sending session'});
  const insert=f.DB.database.prepare("INSERT INTO sessions(id,principal_id,external_id,machine,label,project,task,status,created_at,last_seen_at) VALUES (?,?,?,?,?,?,?,'RUNNING',?,?)");
  for(let i=0;i<205;i++)insert.run(crypto.randomUUID(),a.principal.id,crypto.randomUUID(),'Synthetic machine','Sender '+i,'alpha','Synthetic task','2026-10-05T00:00:00Z','2026-10-05T00:00:00Z');
  await session(f,b,{label:'Foreign sender'});
  f.DB.database.prepare('UPDATE sessions SET last_seen_at=? WHERE id=?').run('2020-01-01T00:00:00Z',original.id);
  const first=await f.call(a.token,'/sessions?owned=1&limit=200');assert.equal(first.body.sessions.length,200);assert.equal(first.body.total,206);assert.equal(first.body.nextOffset,200);
  const last=await f.call(a.token,'/sessions?owned=1&limit=200&offset=200');assert.equal(last.body.sessions.length,6);assert.equal(last.body.nextOffset,null);assert.ok(last.body.sessions.some(item=>item.id===original.id));
  const all=[...first.body.sessions,...last.body.sessions];assert.equal(new Set(all.map(item=>item.id)).size,206);assert.ok(all.every(item=>item.principalId===a.principal.id));assert.ok(all.some(item=>item.id===original.id));
  const search=await f.call(a.token,'/sessions?owned=1&q=Oldest&limit=1');assert.deepEqual(search.body.sessions.map(item=>item.id),[original.id]);assert.equal(search.body.nextOffset,null);
  assert.deepEqual((await f.call(a.token,'/sessions?owned=1&q=Oldest&offset=1')).body.sessions,[]);
  assert.equal((await f.call(a.token,'/sessions?offset=2001')).status,422);
});
