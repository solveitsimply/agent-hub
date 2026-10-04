import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import {SqliteD1} from './d1-sqlite.mjs';

const OWNER='synthetic-owner-for-local-test-only-1234567890';
function fixture(t,extraEnv={}){
  const DB=new SqliteD1();t.after(()=>DB.close());
  return {DB,async call(token,path,body,method=body===undefined?'GET':'POST'){
    const headers={authorization:'Bearer '+token};if(body!==undefined)headers['content-type']='application/json';
    const response=await worker.fetch(new Request('https://hub.test'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)}),{DB,OWNER_TOKEN:OWNER,...extraEnv});
    return {status:response.status,body:await response.json()};
  }};
}
async function invite(f,name,projects=['shared']){
  const result=await f.call(OWNER,'/api/principals',{name,account:name+'@example.test',projects});
  assert.equal(result.status,201);return result.body;
}
async function register(f,actor,overrides={}){
  const result=await f.call(actor.token,'/api/sessions',{externalId:'codex:'+crypto.randomUUID(),machine:'reviewer-workstation.local',label:'Continue reviewed work',project:'shared',task:'Verify source',status:'RUNNING',...overrides});
  assert.equal(result.status,201);return (await f.call(OWNER,'/api/sessions')).body.sessions.find(s=>s.id===result.body.session.id);
}
async function attribute(f,actor,session,client,model,previousSegmentId=null){
  const result=await f.call(actor.token,`/api/sessions/${session.id}/attribution`,{provider:'test-provider',client,model,previousSegmentId,idempotencyKey:crypto.randomUUID()});
  assert.equal(result.status,201);return result.body.segment;
}

test('an in-app rename preserves stable session identity, attribution and ownership',async t=>{
  const f=fixture(t),actor=await invite(f,'title-agent'),session=await register(f,actor);
  const segment=await attribute(f,actor,session,'Codex','GPT-6.1 Sol');
  await f.call(actor.token,'/api/ownership/claim',{sessionId:session.id,resourceKey:'review/source'});
  const renamed=await f.call(actor.token,`/api/sessions/${session.id}`,{label:'Review collection contract bindings'},'PATCH');
  assert.equal(renamed.status,200);
  const humanView=(await f.call(OWNER,'/api/sessions')).body.sessions.find(s=>s.id===session.id);for(const key of ['id','externalId','machine','project','principalId','status','task'])assert.equal(humanView[key],session[key]);assert.equal(humanView.label,'Review collection contract bindings');assert.equal(renamed.body.session.label,'Review collection contract bindings');
  assert.deepEqual(humanView.latestAttribution,{provider:'test-provider',client:'Codex',model:'GPT-6.1 Sol'});assert.deepEqual(renamed.body.session.latestAttribution,humanView.latestAttribution);
  const history=await f.call(actor.token,`/api/sessions/${session.id}/attribution`);
  assert.equal(history.body.segments.length,1);assert.equal(history.body.segments[0].id,segment.id);
  assert.equal(f.DB.database.prepare('SELECT owner_session_id FROM ownership').get().owner_session_id,session.id);
});

test('rename remains owner-only, active-only and refuses credentials or identity changes',async t=>{
  const f=fixture(t),actor=await invite(f,'owned'),foreign=await invite(f,'foreign'),session=await register(f,actor);
  for(const token of [foreign.token,OWNER])assert.equal((await f.call(token,`/api/sessions/${session.id}`,{label:'Impersonation'},'PATCH')).status,403);
  for(const body of [{label:''},{label:'x'.repeat(121)},{label:'sk-'+ 'x'.repeat(24)},{label:'Rename',externalId:'another-session'}])
    assert.equal((await f.call(actor.token,`/api/sessions/${session.id}`,body,'PATCH')).status,422);
  await f.call(actor.token,`/api/sessions/${session.id}`,{status:'DONE'},'PATCH');
  await f.call(actor.token,`/api/sessions/${session.id}/archive`,{});
  assert.equal((await f.call(actor.token,`/api/sessions/${session.id}`,{label:'After archive'},'PATCH')).status,409);
  assert.equal(f.DB.database.prepare('SELECT label FROM sessions WHERE id=?').get(session.id).label,session.label);
});

test('filters use only latest reporting segments and execution machine, with distinct Unknown semantics',async t=>{
  const f=fixture(t),actor=await invite(f,'filters'),privateActor=await invite(f,'private',['private']);
  const switched=await register(f,actor,{label:'Codex old title',environment:'dev'});
  const initial=await attribute(f,actor,switched,'Codex','GPT-6.1 Sol');
  await attribute(f,actor,switched,'Claude','Opus 5.5',initial.id);
  const unknownModel=await register(f,actor,{machine:'Codex Cloud - Default',environment:'production',label:'Gemini misleading title'});
  await attribute(f,actor,unknownModel,'Codex',null);
  const noSegment=await register(f,actor);
  const literalUnknown=await register(f,actor);await attribute(f,actor,literalUnknown,'unknown',null);
  const privateSession=await register(f,privateActor,{project:'private',machine:'private-host'});await attribute(f,privateActor,privateSession,'private-agent','private-model');
  let result=await f.call(OWNER,'/api/sessions?project=shared&agentName=Claude&agentModel=Opus%205.5&machine=reviewer-workstation.local');
  assert.equal(result.status,200);assert.equal(result.body.total,1);assert.equal(result.body.sessions[0].id,switched.id);
  assert.deepEqual(new Set(result.body.filterOptions.agentNames),new Set(['Codex','Claude','unknown',null]));
  assert.equal(result.body.filterOptions.machines.includes('private-host'),false);
  result=await f.call(actor.token,'/api/sessions?agentName=Codex&agentModelUnknown=1&machine=Codex%20Cloud%20-%20Default');
  assert.equal(result.body.total,1);assert.equal(result.body.sessions[0].id,unknownModel.id);
  assert.equal((await f.call(actor.token,'/api/sessions?agentModel=GPT-6.1%20Sol')).body.total,0);
  assert.equal((await f.call(actor.token,'/api/sessions?agentNameUnknown=1')).body.sessions[0].id,noSegment.id);
  assert.equal((await f.call(actor.token,'/api/sessions?agentName=unknown')).body.sessions[0].id,literalUnknown.id);
  assert.equal((await f.call(actor.token,'/api/sessions?agentName=Codex&agentNameUnknown=1')).status,422);
  assert.equal((await f.call(actor.token,'/api/sessions?agentModelUnknown=false')).status,422);
  assert.equal((await f.call(actor.token,'/api/sessions?project=private')).status,403);
});

test('filtering and facet discovery happen before the 200-session display limit',async t=>{
  const f=fixture(t),actors=await Promise.all(['a','b','c'].map(name=>invite(f,name)));
  const target=await register(f,actors[0],{machine:'rare-host'});await attribute(f,actors[0],target,'Gemini','Gemini rare model');
  f.DB.database.prepare('UPDATE sessions SET last_seen_at=? WHERE id=?').run('2026-01-01T00:00:00.000Z',target.id);
  for(let index=0;index<201;index++)await register(f,actors[Math.floor(index/75)]);
  const unfiltered=await f.call(OWNER,'/api/sessions?project=shared');
  assert.equal(unfiltered.body.sessions.length,200);assert.equal(unfiltered.body.total,202);
  assert.equal(unfiltered.body.sessions.some(session=>session.id===target.id),false);
  assert.ok(unfiltered.body.filterOptions.agentNames.includes('Gemini'));
  const filtered=await f.call(actors[0].token,'/api/sessions?agentName=Gemini&agentModel=Gemini%20rare%20model&machine=rare-host');
  assert.equal(filtered.body.sessions.length,1);assert.equal(filtered.body.total,1);assert.equal(filtered.body.sessions[0].id,target.id);
});


test('machine aliases, agent interfaces and qualified Git context preserve identity and isolation',async t=>{
  const f=fixture(t,{MACHINE_ALIASES_JSON:JSON.stringify({'Review desktop':'review-host.local','Review-host':'review-host.local'})});
  const actor=await invite(f,'context-agent'),other=await invite(f,'other-context-agent'),privateActor=await invite(f,'private-context-agent',['private']);
  const context={repository:'github.com/example/app',branch:'dev',commit:'a'.repeat(40)};
  const session=await register(f,actor,{machine:'Review desktop',environment:'staging',workContext:context});
  const foreign=await register(f,other,{workContext:{...context,repository:'github.com/example/another'}});
  assert.equal(session.machine,'review-host.local');assert.equal(session.reportedMachine,'Review desktop');
  assert.equal(session.environment,'staging');assert.deepEqual(session.workContext,context);
  const retry=await f.call(actor.token,'/api/sessions',{externalId:session.externalId,machine:'Review-host',label:session.label,project:'shared',task:'Retry',status:'RUNNING'});
  assert.equal(retry.status,200);assert.equal(retry.body.session.id,session.id);
  assert.equal(f.DB.database.prepare('SELECT machine FROM sessions WHERE id=?').get(session.id).machine,'Review desktop');
  const initial={provider:'Example provider',client:'Codex desktop',previousSegmentId:null,idempotencyKey:'legacy-context-attribution'};
  const first=await f.call(actor.token,`/api/sessions/${session.id}/attribution`,initial);assert.equal(first.status,201);
  assert.equal((await f.call(actor.token,`/api/sessions/${session.id}/attribution`,initial)).status,201,'legacy hash retry');
  const history=await f.call(OWNER,`/api/sessions/${session.id}/attribution`);
  assert.equal(history.body.segments[0].client,'Codex');assert.equal(history.body.segments[0].interface,'desktop');assert.equal(history.body.segments[0].reportedClient,'Codex desktop');
  const filtered=await f.call(OWNER,'/api/sessions?agentName=Codex&machine=review-host.local&environment=staging&repository=github.com%2Fexample%2Fapp&branch=dev');
  assert.deepEqual(filtered.body.sessions.map(s=>s.id),[session.id]);assert.equal(filtered.body.filterOptions.agentNames.includes('Codex desktop'),false);
  assert.equal((await f.call(OWNER,'/api/sessions?agentName=Codex%20desktop')).body.total,1);
  assert.equal((await f.call(OWNER,'/api/sessions?branch=dev')).status,422);
  assert.equal((await f.call(OWNER,'/api/sessions?environment=Review%20desktop')).status,422);
  const patch={details:{nativeBuildStatus:'Pending verification'},environment:'dev'};
  assert.equal((await f.call(actor.token,`/api/sessions/${session.id}`,patch,'PATCH')).status,200);
  assert.deepEqual((await f.call(OWNER,'/api/sessions')).body.sessions.find(s=>s.id===session.id).workContext,context);
  assert.equal((await f.call(other.token,`/api/sessions/${session.id}`,{workContext:null},'PATCH')).status,403);
  assert.equal((await f.call(privateActor.token,'/api/sessions?project=shared&repository=github.com%2Fexample%2Fapp')).status,403);
  const agentView=await f.call(actor.token,'/api/sessions');
  assert.deepEqual(agentView.body.sessions.find(s=>s.id===session.id).workContext,context);assert.equal(agentView.body.sessions.find(s=>s.id===session.id).machine,'review-host.local');
  assert.ok(agentView.body.filterOptions.branches.some(v=>v?.branch==='dev'));assert.ok(agentView.body.filterOptions.environments.includes('dev'));
  for(const branch of ['/invalid','bad..branch','bad.lock','bad@{name','has space'])assert.equal((await f.call(actor.token,`/api/sessions/${session.id}`,{workContext:{...context,branch}},'PATCH')).status,422);
  assert.equal((await f.call(actor.token,`/api/sessions/${session.id}`,{workContext:{...context,repository:'https://user:secret@example.test/app?token=value'}},'PATCH')).status,422);
  assert.equal((await f.call(actor.token,`/api/sessions/${session.id}`,{workContext:null,environment:null},'PATCH')).status,200);
  const cleared=(await f.call(OWNER,'/api/sessions')).body.sessions.find(s=>s.id===session.id);assert.equal(cleared.workContext,null);assert.equal(cleared.environment,null);
  assert.notEqual(foreign.id,session.id);
});

test('status shortcuts find older sessions and full summaries exclude completed presence alerts',async t=>{
  const f=fixture(t),actors=await Promise.all(['summary-a','summary-b','summary-c'].map(name=>invite(f,name)));
  const waiting=await register(f,actors[0],{status:'WAITING_ON_USER'}),done=await register(f,actors[0],{status:'DONE'});
  for(const s of [waiting,done])f.DB.database.prepare('UPDATE sessions SET last_seen_at=? WHERE id=?').run('2026-01-01T00:00:00.000Z',s.id);
  for(let index=0;index<201;index++)await register(f,actors[Math.floor(index/75)]);
  const filtered=await f.call(OWNER,'/api/sessions?status=WAITING_ON_USER');
  assert.equal(filtered.body.total,1);assert.equal(filtered.body.sessions[0].id,waiting.id);assert.equal(filtered.body.summary.RUNNING,201);assert.equal(filtered.body.summary.DONE,1);assert.equal(filtered.body.summary.stale,1);
  const stale=await f.call(OWNER,'/api/sessions?staleOnly=1');assert.equal(stale.body.total,1);assert.equal(stale.body.sessions[0].id,waiting.id);
  assert.equal((await f.call(OWNER,'/api/sessions?staleOnly=false')).status,422);
});

test('compact discovery preserves every filter and custody while omitting dashboard/evidence payloads',async t=>{
  const f=fixture(t),actor=await invite(f,'compact'),privateActor=await invite(f,'private-compact',['private']);
  const workContext={repository:'github.com/example/app',branch:'dev',commit:'b'.repeat(40)};
  const target=await register(f,actor,{environment:'dev',workContext,status:'WAITING_ON_AGENT'});
  await attribute(f,actor,target,'Codex','Example model');
  await register(f,actor,{environment:'staging',machine:'another-host'});
  await register(f,privateActor,{project:'private',label:'Private task'});
  const filters='project=shared&agentName=Codex&agentModel=Example%20model&machine=reviewer-workstation.local&repository=github.com%2Fexample%2Fapp&branch=dev&environment=dev&status=WAITING_ON_AGENT&attention=RECONCILE';
  const full=(await f.call(actor.token,'/api/sessions?'+filters)).body;
  const compact=(await f.call(actor.token,'/api/sessions?'+filters+'&view=compact')).body;
  assert.deepEqual(compact.sessions.map(s=>s.id),full.sessions.map(s=>s.id));
  assert.equal(compact.total,1);assert.equal(compact.limit,20);assert.equal(compact.hasMore,false);
  assert.deepEqual(compact.sessions[0].workContext,workContext);
  assert.equal(compact.sessions[0].lifecycle.revision,full.sessions[0].lifecycle.revision);
  assert.equal('filterOptions' in compact,false);assert.equal('details' in compact.sessions[0],false);
  assert.ok(JSON.stringify(compact).length<JSON.stringify(full).length*0.5,'compact payload saves at least half the JSON characters for this fixture');
  const bounded=(await f.call(actor.token,'/api/sessions?view=compact&limit=1')).body;
  assert.equal(bounded.sessions.length,1);assert.equal(bounded.total,2);assert.equal(bounded.hasMore,true);
  assert.equal((await f.call(actor.token,'/api/sessions?view=compact&project=private')).status,403);
  assert.equal((await f.call(actor.token,'/api/sessions?view=full&limit=1')).body.sessions.length,1);
  for(const query of ['view=bad','view=compact&limit=0','limit=201','limit=2.5','limit=','limit=1e2'])assert.equal((await f.call(actor.token,'/api/sessions?'+query)).status,422);
});

test('compact inbox pages retain complete bodies and delivery cursors without leaking other conversations',async t=>{
  const f=fixture(t),sender=await invite(f,'compact-sender'),recipient=await invite(f,'compact-recipient'),stranger=await invite(f,'compact-stranger');
  const from=await register(f,sender),to=await register(f,recipient),other=await register(f,stranger);
  const ids=[];
  for(let i=0;i<3;i++){
    const result=await f.call(sender.token,'/api/messages',{fromSessionId:from.id,toSessionId:to.id,project:'shared',kind:'NOTE',body:'Complete coordination evidence '+i+' '+ 'x'.repeat(1000),idempotencyKey:'compact-'+i});
    assert.equal(result.status,201);ids.push(result.body.message.id);
  }
  // Unrelated APPROVED and hidden history must not consume a page/cursor.
  await f.call(sender.token,'/api/messages',{fromSessionId:from.id,toSessionId:other.id,project:'shared',kind:'HANDOFF',body:'Unrelated',idempotencyKey:'compact-unrelated'});
  f.DB.database.prepare("UPDATE messages SET review_state='PENDING' WHERE id=?").run(ids[1]);
  const first=(await f.call(recipient.token,`/api/messages?sessionId=${to.id}&view=compact&limit=1`)).body;
  assert.deepEqual(first.messages.map(m=>m.id),[ids[0]]);assert.equal(first.hasMore,true);
  assert.equal(first.messages[0].body.length,1033);assert.equal(first.nextCursor,first.messages[0].deliveryCursor);
  const second=(await f.call(recipient.token,`/api/messages?sessionId=${to.id}&view=compact&limit=1&after=${first.nextCursor}`)).body;
  assert.deepEqual(second.messages.map(m=>m.id),[ids[2]]);assert.equal(second.hasMore,false);
  const empty=(await f.call(recipient.token,`/api/messages?sessionId=${to.id}&view=compact&after=${second.nextCursor}`)).body;
  assert.deepEqual(empty.messages,[]);assert.equal(empty.nextCursor,second.nextCursor);
  assert.deepEqual((await f.call(stranger.token,`/api/messages?sessionId=${to.id}&view=compact`)).body.messages,[]);
  assert.deepEqual((await f.call(recipient.token,`/api/messages?view=compact&kind=HANDOFF`)).body.messages,[]);
  const latest=(await f.call(recipient.token,`/api/messages?sessionId=${to.id}&view=compact&latest=1&limit=1`)).body;
  assert.equal(latest.messages[0].id,ids[2]);assert.ok(latest.nextBefore);
  const previous=(await f.call(recipient.token,`/api/messages?sessionId=${to.id}&view=compact&before=${latest.nextBefore}&limit=1`)).body;
  assert.equal(previous.messages[0].id,ids[0]);assert.equal(previous.nextBefore,null);
  for(const query of ['view=bad','limit=101','limit=0'])assert.equal((await f.call(recipient.token,'/api/messages?'+query)).status,422);
});
